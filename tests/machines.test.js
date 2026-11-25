const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');
const { suggestPrefix } = require('../src/services/machineService');

jest.setTimeout(240000);
beforeEach(clean);

const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

test('the prefix of the machine names: the letters of the department, longer when another department has it', () => {
  expect(suggestPrefix('Dyeing', new Set())).toBe('DYE');
  expect(suggestPrefix('Stitching', new Set(['DYE']))).toBe('STI');
  expect(suggestPrefix('Dyeing', new Set(['DYE']))).toBe('DYEI');
  expect(suggestPrefix('Dyeing', new Set(['DYE', 'DYEI', 'DYEIN', 'DYEING']))).toBe('DYE2');
  expect(suggestPrefix('QC', new Set())).toBe('QC');
});

test('Settings > Machines, machines on jobs (operator, meters in / out), the machine report, the thaans of the departments', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FINISHING', 'PRINTING', 'FOLDING', 'PACKING']) { s[code] = await Service.findOne({ where: { code } }); await CompanyService.create({ companyId: company.id, serviceId: s[code].id }); }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const user = await makeUser({ userType: 'USER', companyId: company.id });
  const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  const api = call(admin);

  // ---- Settings > Machines: the process departments only, everything OFF at first ----
  const st = (await api('get', '/machine-settings')).body.data;
  expect(st.map((d) => [d.code, d.machinesEnabled, d.suggestedPrefix]).sort()).toEqual([['DYEING', false, 'DYE'], ['FINISHING', false, 'FIN'], ['PRINTING', false, 'PRI']]);
  expect((await call(user)('get', '/machine-settings')).status).toBe(403);
  err(await api('post', '/machine-settings/DYEING/machines', { count: 1 }), 422, 'MACHINES_OFF');
  const on = (await api('patch', '/machine-settings/DYEING', { machinesEnabled: true })).body.data.find((d) => d.code === 'DYEING');
  expect(on).toMatchObject({ machinesEnabled: true, prefix: 'DYE', machineCount: 0, canChangePrefix: true });
  const added = (await api('post', '/machine-settings/DYEING/machines', { count: 3 })).body;
  expect(added.data.map((m) => m.name)).toEqual(['DYE-01', 'DYE-02', 'DYE-03']);
  expect(added.counts).toEqual({ total: 3, active: 3, free: 3, running: 0, disabled: 0 });
  await api('patch', '/machine-settings/FINISHING', { machinesEnabled: true, prefix: 'fin' });
  expect((await api('post', '/machine-settings/FINISHING/machines', { count: 1 })).body.data[0].name).toBe('FIN-01');
  err(await api('patch', '/machine-settings/PRINTING', { prefix: 'FIN' }), 422, 'PREFIX_TAKEN');
  err(await api('patch', '/machine-settings/PRINTING', { prefix: '9X' }), 422, 'BAD_PREFIX');
  const machines = (await api('get', '/machine-settings/DYEING/machines')).body.data;
  const m1 = machines[0]; const m2 = machines[1]; const m3 = machines[2];
  const off = (await api('patch', `/machine-settings/machines/${m3.id}`, { isActive: false })).body;
  expect(off.counts).toEqual({ total: 3, active: 2, free: 2, running: 0, disabled: 1 });

  // ---- a job in Dyeing ----
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  const ql = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: ql.id, thaans: [100, 120] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const card = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  expect(job).toMatchObject({ thaanCount: 2, machines: [] });
  err(await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m1.id, operatorName: 'Aslam' }), 422, 'JOB_NOT_ACCEPTED');
  err(await api('put', `/departments/DYEING/jobs/${job.id}/thaans`, { items: [{ jobItemId: job.items[0].id, thaans: [215] }] }), 422, 'JOB_NOT_ACCEPTED');
  await api('post', `/departments/DYEING/jobs/${job.id}/receive`);
  await api('post', `/departments/DYEING/jobs/${job.id}/accept`);

  // ---- put it on machines: operator, meters; one job at a time on a machine; the cloth may be split on two machines ----
  let r = await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m1.id, operatorName: 'Aslam', meters: 120 });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ enabled: true, assignedMeters: 120, remainingMeters: 100, canAssign: true, runningRuns: 1, job: { jobNo: job.jobNo, status: 'PROCESSING', totalMeters: 220 } });
  expect(r.body.runs[0]).toMatchObject({ machine: { name: 'DYE-01' }, operatorName: 'Aslam', inMeters: 120, outMeters: null, status: 'RUNNING' });
  const inc = (await api('get', '/departments/DYEING/incoming')).body.data[0];
  expect(inc).toMatchObject({ status: 'PROCESSING', operatorName: 'Aslam' }); // the job keeps the first operator
  expect(inc.machines).toEqual([expect.objectContaining({ machine: expect.objectContaining({ name: 'DYE-01' }), operatorName: 'Aslam', inMeters: 120, status: 'RUNNING' })]);
  err(await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m1.id, operatorName: 'Bilal', meters: 10 }), 422, 'MACHINE_BUSY');
  err(await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m3.id, operatorName: 'Bilal', meters: 10 }), 422, 'MACHINE_OFF');
  err(await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m2.id, operatorName: 'Bilal', meters: 150 }), 422, 'OVER_ASSIGNED');
  err(await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: '6f1c2f4e-3b0a-4c9c-9a53-0a4d0b7e9d11', operatorName: 'Bilal' }), 422, 'UNKNOWN_MACHINE');
  r = await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m2.id, operatorName: 'Bilal' }); // the rest of the cloth
  expect(r.body).toMatchObject({ assignedMeters: 220, remainingMeters: 0, canAssign: false, runningRuns: 2 });
  err(await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m2.id, operatorName: 'Bilal' }), 422, 'MACHINE_BUSY');

  // the board of the department
  const board = (await api('get', '/departments/DYEING/machines')).body;
  expect(board).toMatchObject({ enabled: true, prefix: 'DYE', counts: { total: 3, active: 2, free: 0, running: 2, disabled: 1 }, operatorsWorking: 2 });
  expect(board.machines.map((m) => [m.name, m.state])).toEqual([['DYE-01', 'RUNNING'], ['DYE-02', 'RUNNING'], ['DYE-03', 'DISABLED']]);
  expect(board.machines[0].current).toMatchObject({ operatorName: 'Aslam', inMeters: 120, job: { jobNo: job.jobNo }, soLabels: [String(card.cardNo)] });
  expect(board.working.map((w) => w.operatorName)).toEqual(['Aslam', 'Bilal']);

  // the job cannot be completed while a machine runs it; finish the runs: cloth made
  err(await api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'COMPLETE' }), 422, 'MACHINE_STILL_RUNNING');
  const run1 = (await api('get', `/departments/DYEING/jobs/${job.id}/machines`)).body.runs[0];
  const run2 = (await api('get', `/departments/DYEING/jobs/${job.id}/machines`)).body.runs[1];
  r = await api('post', `/departments/DYEING/machine-runs/${run1.id}/finish`, { outMeters: 115 });
  expect(r.body.runs[0]).toMatchObject({ status: 'DONE', inMeters: 120, outMeters: 115, lossMeters: 5 });
  err(await api('post', `/departments/DYEING/machine-runs/${run1.id}/finish`, { outMeters: 1 }), 422, 'RUN_DONE');
  r = await api('post', `/departments/DYEING/machine-runs/${run2.id}/finish`, { outMeters: 95, notes: 'one stop' });
  expect(r.body).toMatchObject({ runningRuns: 0, madeMeters: 210 });
  expect((await api('get', '/departments/DYEING/machines')).body.counts).toMatchObject({ free: 2, running: 0 });

  // the report: per machine and per operator
  const rep = (await api('get', '/departments/DYEING/machine-report')).body;
  expect(rep.totals).toEqual({ runs: 2, jobs: 1, inMeters: 220, outMeters: 210, lossMeters: 10, running: 0 });
  expect(rep.byOperator.map((o) => [o.name, o.inMeters, o.outMeters, o.machines])).toEqual([['Aslam', 120, 115, ['DYE-01']], ['Bilal', 100, 95, ['DYE-02']]]);
  expect(rep.byMachine.map((m) => [m.name, m.inMeters, m.operators])).toEqual([['DYE-01', 120, ['Aslam']], ['DYE-02', 100, ['Bilal']]]);
  expect((await api('get', `/departments/DYEING/machine-report?operator=aslam`)).body.totals).toMatchObject({ runs: 1, inMeters: 120 });
  expect((await api('get', `/departments/DYEING/machine-report?machineId=${m2.id}`)).body.totals).toMatchObject({ runs: 1, outMeters: 95 });
  expect((await api('get', '/departments/DYEING/machine-report?dateFrom=2030-01-01')).body.totals.runs).toBe(0);
  expect((await api('get', '/departments/DYEING/machine-operators')).body.data.sort()).toEqual(['Aslam', 'Bilal']);
  expect((await api('get', '/departments/DYEING/machines')).body.machines[0].totals).toMatchObject({ runs: 1, inMeters: 120, outMeters: 115, operators: 1 });

  // edit: rename within the prefix, delete (a machine with history too: its runs stay in the report)
  err(await api('patch', `/machine-settings/machines/${m2.id}`, { name: 'ABC-07' }), 422, 'BAD_NAME');
  err(await api('patch', `/machine-settings/machines/${m2.id}`, { name: 'DYE-01' }), 422, 'NAME_TAKEN');
  expect((await api('patch', `/machine-settings/machines/${m2.id}`, { name: 'dye-b7', notes: 'jet' })).body.data.find((m) => m.id === m2.id)).toMatchObject({ name: 'DYE-B7', notes: 'jet', canRename: true });
  expect((await api('get', '/departments/DYEING/machine-report')).body.byMachine.map((m) => m.name).sort()).toEqual(['DYE-01', 'DYE-B7']);
  expect((await api('delete', `/machine-settings/machines/${m3.id}`)).body.counts.total).toBe(2);
  const del = (await api('delete', `/machine-settings/machines/${m1.id}`)).body;
  expect(del.data.map((m) => m.name)).toEqual(['DYE-B7']);
  expect((await api('get', '/departments/DYEING/machine-report')).body.totals).toMatchObject({ runs: 2, inMeters: 220 }); // the history of the deleted machine stays
  // the prefix can be changed any time: the machines are renamed
  const pf = (await api('patch', '/machine-settings/DYEING', { prefix: 'dyg' })).body.data.find((d) => d.code === 'DYEING');
  expect(pf).toMatchObject({ prefix: 'DYG', canChangePrefix: true });
  expect((await api('get', '/machine-settings/DYEING/machines')).body.data.map((m) => m.name)).toEqual(['DYG-B7']);

  // ---- thaans: Dyeing joined the 2 thaans into 1 (215 m); Finishing makes 5 thaans of it; Printing receives those 5 ----
  const itemId = job.items[0].id;
  let th = (await api('get', `/departments/DYEING/jobs/${job.id}/thaans`)).body;
  expect(th.items[0]).toMatchObject({ meters: 220, input: { source: 'SO_CARD', count: 2, meters: 220 }, output: { recorded: false, count: 0 }, canEdit: true });
  err(await api('put', `/departments/DYEING/jobs/${job.id}/thaans`, { items: [{ jobItemId: itemId, thaans: [0] }] }), 400, 'VALIDATION_FAILED');
  th = (await api('put', `/departments/DYEING/jobs/${job.id}/thaans`, { items: [{ jobItemId: itemId, thaans: [215] }] })).body;
  expect(th.items[0]).toMatchObject({ output: { recorded: true, count: 1, meters: 215, thaans: [{ thaanNo: 1, meters: 215 }] }, lossMeters: 5 });
  await api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'COMPLETE' });
  const form = (await api('get', `/departments/DYEING/send-form?jobId=${job.id}`)).body;
  const fin = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FINISHING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  err(await api('put', `/departments/DYEING/jobs/${job.id}/thaans`, { items: [{ jobItemId: itemId, thaans: [214] }] }), 422, 'ALREADY_SENT_ON');
  err(await api('post', `/departments/DYEING/machine-runs/${run1.id}/finish`, { outMeters: 1 }), 422, 'RUN_DONE');
  // Finishing sees the 1 thaan of 215 m that Dyeing made (not the 2 thaans of the SO card)
  // the cloth that went on carries the meters of the thaans Dyeing made (215), not the 220 it received
  expect(fin).toMatchObject({ thaanCount: 1, totalMeters: 215 });
  expect(fin.items[0].meters).toBe(215);
  expect(fin.items[0]).toMatchObject({ inputThaanCount: 1, inputMeters: 215, inputFrom: { jobNo: job.jobNo, department: 'Dyeing' }, thaans: [{ thaanNo: 1, meters: 215 }], thaansRecorded: false });
  await api('post', `/departments/FINISHING/jobs/${fin.id}/receive`);
  await api('post', `/departments/FINISHING/jobs/${fin.id}/accept`);
  const fth = (await api('put', `/departments/FINISHING/jobs/${fin.id}/thaans`, { items: [{ jobItemId: fin.items[0].id, thaans: [43, 43, 43, 43, 43] }] })).body;
  expect(fth.items[0]).toMatchObject({ input: { source: 'DEPARTMENT', from: { department: 'Dyeing' }, count: 1, meters: 215 }, output: { count: 5, meters: 215 }, lossMeters: 0 });
  // a department with machines cannot be switched off while a machine runs
  const frun = (await api('post', `/departments/FINISHING/jobs/${fin.id}/machines`, { machineId: (await api('get', '/machine-settings/FINISHING/machines')).body.data[0].id, operatorName: 'Zahid' })).body;
  expect(frun).toMatchObject({ assignedMeters: 215, runs: [{ machine: { name: 'FIN-01' }, status: 'RUNNING' }] });
  err(await api('patch', '/machine-settings/FINISHING', { machinesEnabled: false }), 422, 'MACHINES_RUNNING');
  await api('post', `/departments/FINISHING/machine-runs/${frun.runs[0].id}/finish`, { outMeters: 215 });
  await api('put', `/departments/FINISHING/jobs/${fin.id}/status`, { status: 'COMPLETE' });
  const form2 = (await api('get', `/departments/FINISHING/send-form?jobId=${fin.id}`)).body;
  const prn = (await api('post', '/departments/FINISHING/send', { toDepartmentCode: 'PRINTING', items: [{ jobItemId: form2.rows[0].jobItemId }] })).body;
  expect(prn).toMatchObject({ thaanCount: 5, totalMeters: 215 });
  expect(prn.items[0]).toMatchObject({ inputThaanCount: 5, inputMeters: 215, inputFrom: { department: 'Finishing' } });
  // the SO wise list shows the same thaans
  await api('post', `/departments/PRINTING/jobs/${prn.id}/receive`);
  expect((await api('get', '/departments/PRINTING/incoming?view=so')).body.data[0]).toMatchObject({ thaanCount: 5, inputThaanCount: 5, thaansRecorded: false });
  // the department ledger: Dyeing received 220, sent on 215, the 5 m are its process loss: balance 0
  const led = (await api('get', `/reports/ledgers/department?departmentId=${s.DYEING.id}`)).body.sections[0].rows;
  expect(led.map((x) => [x.type, x.inMeters, x.outMeters, x.balance])).toEqual([['Received', 220, 0, 220], ['Sent on', 0, 215, 5], ['Process loss (thaans)', 0, 5, 0]]);
  // Folding shows the thaans it received from the departments
  // Folding shows the thaans it received (5 thaans of 43 m); its meters are the 215 m of the thaans
  await api('post', `/departments/PRINTING/jobs/${prn.id}/accept`);
  await api('put', `/departments/PRINTING/jobs/${prn.id}/operator`, { operatorName: 'Kamran', processDate: '2026-11-23' });
  await api('put', `/departments/PRINTING/jobs/${prn.id}/status`, { status: 'COMPLETE' });
  const form3 = (await api('get', `/departments/PRINTING/send-form?jobId=${prn.id}`)).body;
  const fold = (await api('post', '/departments/PRINTING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form3.rows[0].jobItemId }] })).body;
  expect(fold.totalMeters).toBe(215);
  const frow = (await api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`)).body;
  expect(frow.receivedThaans).toEqual([{ jobItemId: fold.items[0].id, lotNo: lot.lotNo, from: expect.objectContaining({ department: 'Finishing' }), thaans: [1, 2, 3, 4, 5].map((n) => ({ thaanNo: n, meters: 43 })), count: 5, meters: 215 }]);
  // ---- Folding grades the 5 thaans the departments made; Packing makes its list per those thaans ----
  await api('post', `/departments/FOLDING/jobs/${fold.id}/receive`);
  await api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);
  const fr = (await api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`)).body;
  expect(fr.lots[0]).toMatchObject({ hasThaans: true, thaanCount: 5, received: 215 });
  expect(fr.lots[0].lines.map((l) => [l.source, l.thaanNo, l.received])).toEqual([1, 2, 3, 4, 5].map((n) => ['DEPARTMENT', n, 43]));
  const dl = fr.lots[0].lines;
  const graded = (await api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: dl.map((l, i) => ({ greyLotId: lot.id, thaanId: l.thaanId, a: i === 0 ? 40 : 43, cp: i === 0 ? 3 : 0 })) })).body;
  expect(graded.totals).toMatchObject({ received: 215, a: 212, cp: 3, folded: 215 });
  expect(graded.lots[0].lines[0]).toMatchObject({ thaanId: dl[0].thaanId, a: 40, cp: 3, isGraded: true });
  // the journey: SO card thaans -> what each department made -> what Folding received -> what Folding graded per category
  expect(graded.lots[0]).toMatchObject({ gradedThaans: 5, byGrade: { a: { thaans: 5, meters: 212 }, b: { thaans: 0, meters: 0 }, cp: { thaans: 1, meters: 3 } } });
  const jr = graded.journey[0];
  expect(jr.original.thaans).toBeGreaterThan(0);
  expect(jr.received).toEqual({ thaans: 5, meters: 215 });
  expect(jr.steps[jr.steps.length - 1]).toMatchObject({ isCurrent: true, department: 'Folding' });
  const finStep = jr.steps.find((s) => s.department === 'Finishing');
  expect(finStep.out).toEqual({ thaans: 5, meters: 215 });
  expect(finStep.converted).toMatch(/^\d+ -> 5$/);
  const trail = (await api('get', `/reports/so-cards/${card.id}`)).body.sections.find((s) => s.key === 'thaanTrail').rows;
  expect(trail[0]).toMatchObject({ stage: 'SO card' });
  expect(trail.find((r) => r.stage === 'Finishing')).toMatchObject({ thaansOut: 5, metersOut: 215 });
  expect(trail.find((r) => r.stage === 'Folding graded')).toMatchObject({ thaansIn: 5, metersIn: 215, thaansOut: 5, metersOut: 215 });
  const sp = (await api('post', `/departments/FOLDING/folding/${fold.id}/${card.id}/send-packing`, {})).body;
  expect(sp.packingJob.totalMeters).toBe(215);
  await api('post', `/departments/PACKING/jobs/${sp.packingJob.id}/receive`);
  await api('post', `/departments/PACKING/jobs/${sp.packingJob.id}/accept`);
  const ppf = (await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  expect(ppf.lots[0]).toMatchObject({ source: 'DEPARTMENT', thaanCount: 5 });
  expect(ppf.lots[0].journey).toMatchObject({ received: { thaans: 5, meters: 215 }, foldingGrades: { a: { thaans: 5, meters: 212 }, cp: { thaans: 1, meters: 3 }, total: { thaans: 5, meters: 215 } } });
  expect(ppf.lots[0].thaans.map((x) => [x.thaanId, x.thaanNo, x.meters, x.foldingTotal])).toEqual(dl.map((l) => [l.thaanId, l.thaanNo, 43, 43]));
  expect(ppf.lots[0].thaans[0].suggestedLines).toEqual([{ grade: 'A', gradeText: 'A', meters: 40 }, { grade: 'CP', gradeText: 'Cut Piece', meters: 3 }]);
  // a grey lot thaan is not a thaan of this lot any more; more than Folding sent is refused
  const greyT = (await api('get', `/grey-lots/${lot.id}`)).body.thaans[0];
  expect((await api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, lines: [{ greyLotId: lot.id, thaanId: greyT.id, grade: 'A', meters: 40 }] })).body.error.code).toBe('UNKNOWN_THAAN');
  expect((await api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, lines: [{ greyLotId: lot.id, thaanId: dl[0].thaanId, grade: 'A', meters: 41 }] })).body.error.code).toBe('MORE_THAN_FOLDING_SENT');
  expect((await api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, lines: [{ greyLotId: lot.id, grade: 'A', meters: 40 }] })).body.error.code).toBe('THAAN_REQUIRED');
  const lines = ppf.lots[0].thaans.flatMap((x) => x.suggestedLines.map((s) => ({ greyLotId: lot.id, thaanId: x.thaanId, grade: s.grade, meters: s.meters })));
  const pl = (await api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, rateA: 100, rateB: 80, rateCP: 50, lines })).body;
  expect(pl.lots[0].thaans.map((x) => [x.thaanId, x.thaanNo, x.grade, x.meters])).toEqual([[dl[0].thaanId, 1, 'A', 40], [dl[0].thaanId, 1, 'CP', 3], ...dl.slice(1).map((l) => [l.thaanId, l.thaanNo, 'A', 43])]);
  expect(pl.summary.total).toMatchObject({ meters: 215, thaans: 6 });
  expect((await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body.lots[0].thaans[0]).toMatchObject({ alreadyPacked: true });
  // a user without the department cannot put cloth on a machine; the department off: nothing to do
  err(await call(user)('post', `/departments/PRINTING/jobs/${prn.id}/machines`, { machineId: m1.id, operatorName: 'X1' }), 403, 'FORBIDDEN');
  err(await api('post', `/departments/PRINTING/jobs/${prn.id}/machines`, { machineId: m1.id, operatorName: 'Xx' }), 422, 'MACHINES_OFF');
  expect((await api('get', '/departments/PRINTING/machines')).body).toMatchObject({ enabled: false, machines: [] });
});

// owner 2026-11-24 (A3.3): two admins together: machines are numbered once each; the same prefix goes to one department, the other gets a clear answer (not a 500)
test('two admins adding machines and taking the same prefix at the same moment', async () => {
  const { raceTwice } = require('./helpers');
  const company = await makeCompany();
  for (const code of ['DYEING', 'FINISHING']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  await api('patch', '/machine-settings/DYEING', { machinesEnabled: true });
  const added = await raceTwice(() => api('post', '/machine-settings/DYEING/machines', { count: 2 }));
  expect(added.map((r) => r.status)).toEqual([201, 201]);
  const names = (await api('get', '/machine-settings/DYEING/machines')).body.data.map((m) => m.name).sort();
  expect(names).toEqual(['DYE-01', 'DYE-02', 'DYE-03', 'DYE-04']);
  const take = await Promise.all([api('patch', '/machine-settings/DYEING', { prefix: 'ZZ' }), api('patch', '/machine-settings/FINISHING', { machinesEnabled: true, prefix: 'ZZ' })]);
  expect(take.map((r) => r.status).sort()).toEqual([200, 422]);
  expect(take.find((r) => r.status === 422).body.error.code).toBe('PREFIX_TAKEN');
});
