const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, YarnBeam } = require('../src/models');
const { unitsToMeters } = require('../src/utils/loomUnits');

jest.setTimeout(240000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const insertEmployee = (companyId, groupId, departmentId, code, name) => sequelize.query(
  `INSERT INTO payroll_employees (id, "companyId", code, name, "groupId", "departmentId", "joiningDate", status, "confirmedAt") VALUES (gen_random_uuid(), :companyId, :code, :name, :groupId, :departmentId, '2025-01-01', 'CONFIRMED', now())`,
  { replacements: { companyId, code, name, groupId, departmentId } });

async function setup() {
  const company = await makeCompany();
  for (const code of ['WEAVING_MASTERS', 'SIZING', 'WEAVING_PRODUCTION', 'PAYROLL_EMPLOYEES']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'WEAVING_PRODUCTION' } })).id, access: 'VIEW' });
  const api = call(admin);
  const sulzer = (await api('post', '/weaving/departments', { name: 'Sulzer' })).body;
  const airjet = (await api('post', '/weaving/departments', { name: 'Airjet' })).body;
  const looms = {};
  for (const no of ['01', '02', '03']) looms[no] = (await api('post', '/weaving/looms', { loomNo: no, departmentId: sulzer.id })).body;
  const other = (await api('post', '/weaving/looms', { loomNo: '101', departmentId: airjet.id })).body;
  // payroll: weaving employees and one from another department
  const [factory] = (await api('get', '/payroll/groups')).body.data;
  const weaving = (await api('post', '/payroll/departments', { groupId: factory.id, name: 'Weaving', fte: 10 })).body;
  const stitching = (await api('post', '/payroll/departments', { groupId: factory.id, name: 'Stitching', fte: 10 })).body;
  await insertEmployee(company.id, factory.id, weaving.id, 129, 'ALI KHAN');
  await insertEmployee(company.id, factory.id, weaving.id, 261, 'BILAL RABI');
  await insertEmployee(company.id, factory.id, stitching.id, 500, 'ZED STITCHER');
  const emps = (await api('get', '/production/weavers/employees?departmentId=' + sulzer.id + '&date=2026-11-16')).body.data;
  // two full beams of 4,100 m on loom 01: K-ID 1, confirmed, pick 56
  const beams = [];
  for (let i = 1; i <= 2; i += 1) beams.push((await api('post', '/weaving/beams', { name: `S${i}`, beamDate: '2026-10-01' })).body);
  await YarnBeam.update({ status: 'FULL', meters: 4100, statusDate: '2026-11-01' }, { where: { id: beams.map((b) => b.id) } });
  const entry = (await api('post', '/sizing/loom-beams', { loomId: looms['01'].id, beamIds: beams.map((b) => b.id), loomRpm: 400, loomPick: 56, reedSpace: 63, startDate: '2026-11-10' })).body;
  const conf = await api('post', `/sizing/loom-beams/${entry.id}/confirm`);
  if (conf.status !== 200) throw new Error(JSON.stringify([entry, conf.body]));
  // loom 02 runs K-ID 2 too (loom 03 stays empty: no beam, so it is not offered for production)
  const beams2 = [];
  for (let i = 3; i <= 4; i += 1) beams2.push((await api('post', '/weaving/beams', { name: `S${i}`, beamDate: '2026-10-01' })).body);
  await YarnBeam.update({ status: 'FULL', meters: 4100, statusDate: '2026-11-01' }, { where: { id: beams2.map((b) => b.id) } });
  const entry2 = (await api('post', '/sizing/loom-beams', { loomId: looms['02'].id, beamIds: beams2.map((b) => b.id), loomRpm: 400, loomPick: 56, reedSpace: 63, startDate: '2026-11-10' })).body;
  await api('post', `/sizing/loom-beams/${entry2.id}/confirm`);
  return { admin, api, viewer: call(viewer), sulzer, airjet, looms, other, emps, entry, entry2, companyId: company.id };
}

/** a beam entry (a running K-ID) on loom 03, so that it can be given to a weaver */
async function runLoom03(w) {
  const bs = [];
  for (let i = 5; i <= 6; i += 1) bs.push((await w.api('post', '/weaving/beams', { name: `S${i}`, beamDate: '2026-10-01' })).body);
  await YarnBeam.update({ status: 'FULL', meters: 4100, statusDate: '2026-11-01' }, { where: { id: bs.map((b) => b.id) } });
  const e = (await w.api('post', '/sizing/loom-beams', { loomId: w.looms['03'].id, beamIds: bs.map((b) => b.id), loomRpm: 400, loomPick: 56, reedSpace: 63, startDate: '2026-11-10' })).body;
  await w.api('post', `/sizing/loom-beams/${e.id}/confirm`);
}

test('units to metres: 1 unit = 1,000 picks', () => {
  expect(unitsToMeters(1114, 56)).toBe(505.28); // the figure of the K-ID 304 screen: 505 m
  expect(unitsToMeters(1114, null)).toBeNull();
});

test('weavers of the day: only payroll weaving employees, looms per weaver, one weaver per loom and shift, copy', async () => {
  const w = await setup();
  expect(w.emps.map((e) => e.code)).toEqual([129, 261]); // not the stitching employee
  const day = '2026-11-16';
  const ali = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[0].id] })).body;
  expect(ali.added).toBe(1);
  const aliRow = ali.shifts.A.weavers[0];
  err(await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: ['6f1c2f4e-3b0a-4c9c-9a53-0a4d0b7e9d11'] }), 422, 'NOT_A_WEAVER');
  err(await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: '2030-01-01', shift: 'A', employeeIds: [w.emps[0].id] }), 422, 'FUTURE_DATE');
  const set = await w.api('put', `/production/weavers/${aliRow.id}/looms`, { loomIds: [w.looms['01'].id, w.looms['02'].id] });
  expect(set.body).toMatchObject({ loomsText: '01, 02', loomCount: 2, shift: 'A' });
  err(await w.api('put', `/production/weavers/${aliRow.id}/looms`, { loomIds: [w.other.id] }), 422, 'UNKNOWN_LOOM'); // a loom of another department
  err(await w.api('put', `/production/weavers/${aliRow.id}/looms`, { loomIds: [w.looms['03'].id] }), 422, 'LOOM_EMPTY'); // no beam on loom 03
  const bilal = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[1].id] })).body.shifts.A.weavers.find((x) => x.employee.code === 261);
  err(await w.api('put', `/production/weavers/${bilal.id}/looms`, { loomIds: [w.looms['02'].id] }), 422, 'LOOM_TAKEN');
  expect((await w.api('put', `/production/weavers/${bilal.id}/looms`, { loomIds: [w.looms['02'].id], move: true })).body.loomsText).toBe('02');
  const d = (await w.api('get', `/production/weavers?departmentId=${w.sulzer.id}&date=${day}`)).body;
  expect(d).toMatchObject({ totals: { weavers: 2, looms: 2 } });
  expect(d.looms.map((l) => l.loomNo)).toEqual(['01', '02']); // only looms with a running beam
  expect(d.shifts.A.weavers.map((x) => [x.employee.code, x.loomsText])).toEqual([[129, '01'], [261, '02']]);
  // copy to another day: shifts that have no weavers there yet
  const c = (await w.api('post', '/production/weavers/copy', { departmentId: w.sulzer.id, fromDate: day, toDate: '2026-11-17' })).body;
  expect(c.copied).toEqual({ A: 2, B: 0, C: 0 });
  expect((await w.api('post', '/production/weavers/copy', { departmentId: w.sulzer.id, fromDate: day, toDate: '2026-11-17' })).body.skippedShifts).toEqual(['A']);
  // before the K-ID started the looms have no beam: the weavers are copied, the looms are not
  const early = (await w.api('post', '/production/weavers/copy', { departmentId: w.sulzer.id, fromDate: day, toDate: '2026-11-05' })).body;
  expect(early).toMatchObject({ copied: { A: 2, B: 0, C: 0 }, emptyLooms: ['01', '02'], totals: { weavers: 2, looms: 0 } });
  // remove
  expect((await w.api('post', '/production/weavers/remove', { ids: [bilal.id] })).body.removed).toBe(1);
  expect((await w.viewer('get', `/production/weavers?departmentId=${w.sulzer.id}&date=${day}`)).body.totals.weavers).toBe(1);
  expect((await w.viewer('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[0].id] })).status).toBe(403);
});

test('units: day register, K-ID, checks, the cloth made on the K-ID, periods, CSV uploads', async () => {
  const w = await setup();
  const day = '2026-11-16';
  const ali = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[0].id] })).body.shifts.A.weavers[0];
  await w.api('put', `/production/weavers/${ali.id}/looms`, { loomIds: [w.looms['01'].id, w.looms['02'].id] });
  const save = await w.api('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [
    { loomId: w.looms['01'].id, shift: 'A', units: 79 }, { loomId: w.looms['01'].id, shift: 'B', units: 96 }, { loomId: w.looms['01'].id, shift: 'C', units: 107 }, { loomId: w.looms['02'].id, shift: 'A', units: 91 }] });
  expect(save.status).toBe(200);
  const r1 = save.body.rows.find((r) => r.loomNo === '01');
  expect(r1).toMatchObject({ kId: 1, pick: 56, totalUnits: 282 });
  expect(r1.shifts.A).toMatchObject({ units: 79, weaver: { code: 129, name: 'ALI KHAN' } });
  expect(r1.shifts.B.weaver).toBeNull();
  expect(save.body.rows.map((r) => r.loomNo)).toEqual(['01', '02']); // only looms with a beam; empty loom 03 and the other department's loom are not here
  expect(save.body.totals).toEqual({ A: 170, B: 96, C: 107, total: 373 });
  // the checks: units with no weaver (problem), units on a loom with no K-ID (warning)
  const codes = save.body.check.items.map((c) => c.code).sort();
  expect(codes).toEqual(['UNITS_NO_WEAVER', 'UNITS_NO_WEAVER']);
  expect(save.body.check).toMatchObject({ problems: 2, warnings: 0 });
  err(await w.api('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [{ loomId: w.other.id, shift: 'A', units: 5 }] }), 422, 'UNKNOWN_LOOM');
  // a weaver in two shifts is a problem
  const ali2 = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'B', employeeIds: [w.emps[0].id] })).body.shifts.B.weavers[0];
  await w.api('put', `/production/weavers/${ali2.id}/looms`, { loomIds: [w.looms['02'].id] });
  const ck = (await w.api('get', `/production/day/check?departmentId=${w.sulzer.id}&date=${day}`)).body;
  expect(ck.items.map((c) => c.code)).toEqual(expect.arrayContaining(['WEAVER_LOOMS_TWO_SHIFTS', 'WEAVER_TWO_SHIFTS']));

  // the K-ID screen: units, cloth made, balance
  const e = (await w.api('get', `/sizing/loom-beams/${w.entry.id}`)).body;
  const made = unitsToMeters(282, 56);
  expect(e).toMatchObject({ units: 282, producedM: made, balanceM: Math.round((4100 - made) * 100) / 100, daysRun: 1, lastProductionDate: day, netLengthM: 4100 });
  expect(e.donePct).toBeGreaterThan(3);
  // the looms status list: stale (nothing for 3+ days), never updated, quality, totals, quality summary
  expect(e).toMatchObject({ isStale: true, neverUpdated: false, missingSetup: false, lastProductionDate: day });
  const e2 = (await w.api('get', `/sizing/loom-beams/${w.entry2.id}`)).body;
  expect(e2).toMatchObject({ neverUpdated: false, units: 91, isStale: true });
  const st = (await w.api('get', `/sizing/loom-beams?status=ACTIVE&departmentId=${w.sulzer.id}`)).body;
  expect(st.totals).toMatchObject({ loomsRunning: 2, producedM: unitsToMeters(373, 56), notUpdated: 2, missingSetup: 0 });
  expect(st.totals.leftM).toBeCloseTo(8200 - unitsToMeters(282, 56) - unitsToMeters(91, 56), 1);
  const qs = (await w.api('get', `/sizing/loom-beams/quality-summary?departmentId=${w.sulzer.id}`)).body;
  expect(qs.totals).toMatchObject({ looms: 2, producedM: unitsToMeters(373, 56) });
  // the two PDFs (PDF by quality, Quality summary)
  for (const name of ['by-quality', 'quality-summary']) {
    const pdf = await request(app).get(`/api/v1/sizing/loom-beams/${name}.pdf?departmentId=${w.sulzer.id}`).set({ Authorization: `Bearer ${(await loginAs(w.admin)).accessToken}` }).buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect([pdf.status, pdf.headers['content-type'], pdf.body.slice(0, 4).toString()]).toEqual([200, 'application/pdf', '%PDF']);
    expect(pdf.headers['content-disposition']).toContain(`loom-sulzer-${name}-`);
    if (process.env.PDF_OUT) require('fs').writeFileSync(`${process.env.PDF_OUT}/${name}.pdf`, pdf.body);
  }
  const reg = (await w.api('get', `/sizing/loom-beams/${w.entry.id}/production`)).body;
  expect(reg).toMatchObject({ kId: 1, totalUnits: 282, producedM: made });
  expect(reg.data.map((x) => [x.date, x.shift, x.units])).toEqual([[day, 'A', 79], [day, 'B', 96], [day, 'C', 107]]);
  expect(reg.data[0].weaver).toMatchObject({ code: 129 });

  // periods of 15 days
  const ps = (await w.api('get', `/production/periods?departmentId=${w.sulzer.id}`)).body;
  expect(ps.data[0]).toMatchObject({ from: '2026-11-16', to: '2026-11-30', days: 15, daysWithUnits: 1, totalUnits: 373, isCurrent: true });
  const p = (await w.api('get', `/production/period?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(p).toMatchObject({ label: '16-30 Nov-26', dayCount: 15, totalUnits: 373, shiftTotals: { A: 170, B: 96, C: 107 }, daysWithUnits: 1, daysWithoutUnits: 14, averagePerDay: 373, bestDay: { date: day, units: 373 } });
  expect(p.noWeaver.count).toBe(2);
  expect(p.days[0]).toMatchObject({ date: day, weekday: 'Mon', registerLooms: 2, totalUnits: 373 });
  err(await w.api('get', `/production/period?departmentId=${w.sulzer.id}&from=2026-11-17`), 422, 'BAD_PERIOD');

  // CSV upload of units: good rows are saved, bad rows reported with their line
  const csv = 'date,shift,loom_no,units,k_id\n2026-11-17,A,1,50,1\n2026-11-17,B,02,60,\n2026-11-17,Z,01,5,\n2026-11-17,A,09,5,\n2026-11-17,C,01,70,5\n2026-11-17,A,03,9,\n';
  const up = (await w.api('post', '/production/units/import', { departmentId: w.sulzer.id, csv })).body;
  expect(up).toMatchObject({ saved: 2, skipped: 4, dates: ['2026-11-17'] });
  expect(up.errors.map((x) => x.line)).toEqual([4, 5, 6, 7]); // 7 = the empty loom 03
  expect((await w.api('get', `/production/day?departmentId=${w.sulzer.id}&date=2026-11-17`)).body.totals.total).toBe(110);
  err(await w.api('post', '/production/units/import', { departmentId: w.sulzer.id, csv: 'a,b\n1,2\n' }), 422, 'BAD_FILE');
  // the same rows as JSON
  expect((await w.api('post', '/production/units/import', { departmentId: w.sulzer.id, rows: [{ date: '2026-11-18', shift: 'A', loom_no: '01', units: 40 }] })).body.saved).toBe(1);
  // CSV upload of the weavers with their looms
  const wcsv = 'date,shift,employee_id,looms\n2026-11-18,A,129,1 2\n2026-11-18,B,261,"1;2"\n2026-11-18,A,500,2\n2026-11-18,C,129,3\n';
  const wu = (await w.api('post', '/production/weavers/import', { departmentId: w.sulzer.id, csv: wcsv })).body;
  expect(wu).toMatchObject({ saved: 2, withLooms: 2, skipped: 2 }); // the stitching employee, and the empty loom 03
  const d18 = (await w.api('get', `/production/weavers?departmentId=${w.sulzer.id}&date=2026-11-18`)).body;
  expect(d18.shifts.A.weavers[0]).toMatchObject({ loomsText: '01, 02' });
  expect(d18.shifts.B.weavers[0]).toMatchObject({ loomsText: '01, 02' });
  expect((await w.api('get', `/production/day?departmentId=${w.sulzer.id}&date=2026-11-18`)).body.rows[0].shifts.A.weaver.code).toBe(129);
  // samples and the export
  const s = await w.api('get', '/production/units/sample.csv');
  expect([s.status, s.headers['content-type']]).toEqual([200, 'text/csv; charset=utf-8']);
  expect((await w.api('get', '/production/weavers/sample.csv')).text).toContain('employee_id');
  expect((await w.api('get', `/production/day/csv?departmentId=${w.sulzer.id}&date=${day}`)).text).toContain('2026-11-16,A,01,129,ALI KHAN,79,1');
  // delete ticked; the loom cannot be deleted while it is in the register
  expect((await w.api('post', '/production/day/clear', { departmentId: w.sulzer.id, date: day, loomIds: [w.looms['02'].id] })).body.totals.A).toBe(79);
  err(await w.api('delete', `/weaving/looms/${w.looms['02'].id}`), 422, 'IN_USE');
  expect((await w.viewer('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [{ loomId: w.looms['01'].id, shift: 'A', units: 1 }] })).status).toBe(403);
});

test('weaver wise & attendance billing: the weaver sheet, reconciliation, attendance, policy, PDF and Excel', async () => {
  const w = await setup();
  await runLoom03(w);
  const day = '2026-11-16';
  expect((await w.api('patch', `/weaving/looms/${w.looms['01'].id}`, { loomType: 'PU' })).body.loomType).toBe('PU');
  await w.api('patch', `/weaving/looms/${w.looms['02'].id}`, { loomType: 'P7100' });
  await w.api('patch', `/weaving/looms/${w.looms['03'].id}`, { loomType: 'P7100' });
  // loom policy: loom 2 to 3 = 5 looms per weaver, all other looms 6; rates from 2026-08-16
  err(await w.api('put', '/production/policy', { departmentId: w.sulzer.id, ranges: [{ from: 1, to: 5, loomsPerWeaver: 5 }, { from: 5, to: 9, loomsPerWeaver: 4 }] }), 422, 'RANGE_OVERLAP');
  const pol = (await w.api('put', '/production/policy', { departmentId: w.sulzer.id, ranges: [{ from: 2, to: 3, loomsPerWeaver: 5 }], otherLooms: 6, ratePerDay: 1000, rates: { PU: 0.85, P7100: 0.75 }, ratesFrom: '2026-08-16' })).body;
  expect(pol).toMatchObject({ otherLooms: 6, ranges: [{ from: 2, to: 3, loomsPerWeaver: 5 }], groups: [6, 5], stopBelowUnits: 1 });
  expect(pol.rates).toMatchObject({ effectiveFrom: '2026-08-16', ratePerDay: 1000 });
  expect(pol.rates.loomTypes).toEqual([{ loomType: 'P7100', ratePerUnit: 0.75 }, { loomType: 'PU', ratePerUnit: 0.85 }]);
  const ali = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[0].id] })).body.shifts.A.weavers[0];
  await w.api('put', `/production/weavers/${ali.id}/looms`, { loomIds: [w.looms['01'].id, w.looms['02'].id] });
  const bilal = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'B', employeeIds: [w.emps[1].id] })).body.shifts.B.weavers[0];
  await w.api('put', `/production/weavers/${bilal.id}/looms`, { loomIds: [w.looms['01'].id, w.looms['03'].id] });
  await w.api('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [
    { loomId: w.looms['01'].id, shift: 'A', units: 100 }, { loomId: w.looms['02'].id, shift: 'A', units: 50 }, { loomId: w.looms['01'].id, shift: 'B', units: 0 }, { loomId: w.looms['02'].id, shift: 'B', units: 40 }, { loomId: w.looms['03'].id, shift: 'B', units: 30 }] });

  const s = (await w.api('get', `/production/billing/weavers?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(s).toMatchObject({ label: '16-30 Nov-26', weavers: 2, ties: false, tieMessage: 'does not tie with the entries — see right' });
  expect(s.types.map((x) => x.key)).toEqual(['PU', 'P7100']); // the order the looms were made in
  expect(s.rows.map((r) => r.label)).toEqual(['NO WEAVER', 'ALI KHAN (129)', 'BILAL RABI (261)']);
  expect(s.groups).toEqual([{ looms: 6, label: '6-LOOM' }, { looms: 5, label: '5-LOOM' }]);
  expect(s.rows[0]).toMatchObject({ noWeaver: true, totalUnits: 40, loomShifts5: 1, loomShifts6: 0, loomShifts: { 6: 0, 5: 1 }, unitsByType: { P7100: 40, PU: 0 } });
  expect(s.rows[1]).toMatchObject({ shifts: 1, loomShifts6: 1, loomShifts5: 1, extraLooms: 0, totalUnits: 150, unitsByType: { P7100: 50, PU: 100 }, stoppedLooms: 0 });
  // Bilal runs loom 03 (30 units) and loom 01 (a typed 0 = stopped): the stopped loom is paid half the average of his running looms = 15 units x the PU rate 0.85
  expect(s.rows[2]).toMatchObject({ shifts: 1, loomShifts6: 1, loomShifts5: 1, totalUnits: 30, stoppedLooms: 1, stoppageUnits: 15, stoppageAmount: 13 });
  expect(s.totals).toMatchObject({ totalUnits: 220, stoppedLooms: 1, stoppageUnits: 15, stoppageAmount: 13, unitsByType: { P7100: 120, PU: 100 } });
  const rec = Object.fromEntries(s.reconciliation.map((x) => [x.label, x]));
  expect(rec['Total units']).toMatchObject({ entries: 220, billing: 220, diff: 0, ok: true });
  expect(rec['Shift B units']).toMatchObject({ entries: 70, billing: 70, ok: true });
  expect(rec['Loom-shifts with a weaver']).toMatchObject({ entries: 4, billing: 4, ok: true });
  expect(rec['Units with no weaver']).toMatchObject({ billing: 40, ok: false });
  expect(s.noWeaverList).toMatchObject({ count: 1, units: 40 });
  expect(s.noWeaverList.items[0]).toMatchObject({ date: day, loomNo: '02', A: 50, B: 40, C: null, missing: 'B' });

  const at = (await w.api('get', `/production/billing/weavers/${w.emps[0].id}?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(at).toMatchObject({ days: 1, shifts: 1, units: 150, extraLooms: 0 });
  expect(at.rows[0]).toMatchObject({ date: day, looms: 2, A: 150, B: null, units: 150 });
  // a new rate from December: this period keeps the rates it had
  const pol2 = (await w.api('put', '/production/policy', { departmentId: w.sulzer.id, ratePerDay: 1200, rates: { PU: 1, P7100: 0.9 }, ratesFrom: '2026-12-01' })).body;
  expect(pol2.rateHistory.map((x) => [x.effectiveFrom, x.ratePerDay])).toEqual([['2026-08-16', 1000], ['2026-12-01', 1200]]);
  expect((await w.api('get', `/production/billing/weavers?departmentId=${w.sulzer.id}&from=2026-11-16`)).body.totals.stoppageAmount).toBe(13);
  // one extra loom: 2 looms in the 5-group would be fine, 6 looms in loom range 2-3 are not (range of 1 loom per weaver)
  await w.api('put', '/production/policy', { departmentId: w.sulzer.id, ranges: [{ from: 1, to: 3, loomsPerWeaver: 1 }] });
  const ex = (await w.api('get', `/production/billing/weavers/${w.emps[0].id}?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(ex).toMatchObject({ extraLooms: 1 }); // Ali runs 2 looms of a group of 1
  await w.api('put', '/production/policy', { departmentId: w.sulzer.id, ranges: [{ from: 2, to: 3, loomsPerWeaver: 5 }] });
  err(await w.api('get', `/production/billing/weavers?departmentId=${w.sulzer.id}&from=2026-11-17`), 422, 'BAD_PERIOD');
  expect((await w.viewer('put', '/production/policy', { departmentId: w.sulzer.id, otherLooms: 3 })).status).toBe(403);
  expect((await w.viewer('get', `/production/billing/weavers?departmentId=${w.sulzer.id}&from=2026-11-16`)).status).toBe(200);

  for (const [ext, type] of [['pdf', 'application/pdf'], ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]) {
    const file = await request(app).get(`/api/v1/production/billing/weavers.${ext}?departmentId=${w.sulzer.id}&from=2026-11-16`).set({ Authorization: `Bearer ${(await loginAs(w.admin)).accessToken}` })
      .buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect([file.status, file.headers['content-type']]).toEqual([200, type]);
    expect(file.headers['content-disposition']).toContain('sulzer-weaver-16-30Nov-26');
    if (process.env.PDF_OUT) require('fs').writeFileSync(`${process.env.PDF_OUT}/weaver.${ext}`, file.body);
  }
});

test('depart wise & efficiency report: loom blocks, units and efficiency per day, averages, basis, PDF and Excel', async () => {
  const w = await setup();
  const day = '2026-11-16';
  err(await w.api('put', '/production/efficiency/basis', { departmentId: w.sulzer.id, blocks: [{ from: 1, to: 5 }, { from: 4, to: 8 }] }), 422, 'RANGE_OVERLAP');
  const b = (await w.api('put', '/production/efficiency/basis', { departmentId: w.sulzer.id, blocks: [{ from: 1, to: 2 }, { from: 3, to: 3 }], minRunUnits: 1, defaultRpm: 239 })).body;
  expect(b).toMatchObject({ minRunUnits: 1, defaultRpm: 239, blocks: [{ from: 1, to: 2 }, { from: 3, to: 3 }] });
  await w.api('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [
    { loomId: w.looms['01'].id, shift: 'A', units: 60 }, { loomId: w.looms['01'].id, shift: 'B', units: 40 }, { loomId: w.looms['02'].id, shift: 'A', units: 50 }, { loomId: w.looms['03'].id, shift: 'C', units: 100 }] });
  const r = (await w.api('get', `/production/efficiency?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(r).toMatchObject({ label: '16-30 Nov-26', title: 'SULZER UNITS & EFFICIENCY DEPART WISE 16-NOV-26 TO 30-NOV-26', blocksSet: true });
  expect(r.groups.map((g) => [g.key, g.label, g.looms])).toEqual([['1-2', '1 to 2', 2], ['3-3', '3 to 3', 1]]);
  expect(r.days).toHaveLength(15);
  const d = r.days[0];
  expect(d).toMatchObject({ date: day, weekday: 'Mon', hasUnits: true, unitsTotal: 250, units: { '1-2': 150, '3-3': 100 }, efficiencyTotal: 21.04 });
  // 2 running looms at RPM 400 (the beam entry) = 2 x 400 x 1.44 = 1,152 units at 100%; loom 3 has no beam entry: RPM 239
  expect(d.efficiency['1-2']).toMatchObject({ value: 13.02, runningLooms: 2, rpm: 400, capacityUnits: 1152 });
  expect(d.efficiency['3-3']).toMatchObject({ value: 29.06, runningLooms: 1, rpm: 239 });
  expect(r.days[1]).toMatchObject({ hasUnits: false, unitsTotal: 0, efficiency: { '1-2': null, '3-3': null }, efficiencyTotal: null });
  expect(r.grand).toMatchObject({ unitsTotal: 250, units: { '1-2': 150, '3-3': 100 }, efficiency: { '1-2': 13.02, '3-3': 29.06 }, efficiencyTotal: 21.04 });
  // a loom must give at least minRunUnits to count as running
  await w.api('put', '/production/efficiency/basis', { departmentId: w.sulzer.id, minRunUnits: 60 });
  const r2 = (await w.api('get', `/production/efficiency?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(r2.days[0].efficiency['1-2']).toMatchObject({ runningLooms: 1 }); // loom 02 gave 50 < 60
  await w.api('put', '/production/efficiency/basis', { departmentId: w.sulzer.id, minRunUnits: 1 });
  err(await w.api('get', `/production/efficiency?departmentId=${w.sulzer.id}&from=2026-11-17`), 422, 'BAD_PERIOD');
  expect((await w.viewer('put', '/production/efficiency/basis', { departmentId: w.sulzer.id, minRunUnits: 2 })).status).toBe(403);
  expect((await w.viewer('get', `/production/efficiency?departmentId=${w.sulzer.id}&from=2026-11-16`)).status).toBe(200);
  for (const [ext, type] of [['pdf', 'application/pdf'], ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]) {
    const file = await request(app).get(`/api/v1/production/efficiency.${ext}?departmentId=${w.sulzer.id}&from=2026-11-16`).set({ Authorization: `Bearer ${(await loginAs(w.admin)).accessToken}` })
      .buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect([file.status, file.headers['content-type']]).toEqual([200, type]);
    expect(file.headers['content-disposition']).toContain('sulzer-depart-20261116');
    if (process.env.PDF_OUT) require('fs').writeFileSync(`${process.env.PDF_OUT}/depart.${ext}`, file.body);
  }
});

test('production bill / wages: days x rate, extra looms, production amount, stoppage, net, the detail list, PDF and Excel', async () => {
  const w = await setup();
  await runLoom03(w);
  const day = '2026-11-16';
  await w.api('patch', `/weaving/looms/${w.looms['01'].id}`, { loomType: 'PU' });
  await w.api('patch', `/weaving/looms/${w.looms['02'].id}`, { loomType: 'P7100' });
  await w.api('patch', `/weaving/looms/${w.looms['03'].id}`, { loomType: 'PU' });
  // every loom: 2 looms per weaver (all other looms); rate 1,000 a day, PU 0.85, P7100 0.75, from 2026-08-16
  await w.api('put', '/production/policy', { departmentId: w.sulzer.id, ranges: [], otherLooms: 2, ratePerDay: 1000, rates: { PU: 0.85, P7100: 0.75 }, ratesFrom: '2026-08-16' });
  const ali = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[0].id] })).body.shifts.A.weavers[0];
  await w.api('put', `/production/weavers/${ali.id}/looms`, { loomIds: [w.looms['01'].id, w.looms['02'].id, w.looms['03'].id] }); // 3 looms of a group of 2 = 1 extra loom
  await w.api('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [{ loomId: w.looms['01'].id, shift: 'A', units: 100 }, { loomId: w.looms['02'].id, shift: 'A', units: 60 }, { loomId: w.looms['03'].id, shift: 'A', units: 0 }, { loomId: w.looms['01'].id, shift: 'B', units: 40 }] });
  const b = (await w.api('get', `/production/bill?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(b).toMatchObject({ title: 'SULZER PRODUCTION BILL', subtitle: 'FROM 16-11-2026 TO 30-11-2026', weavers: 1, status: 'CHECK', rates: { ratePerDay: 1000, byType: { PU: 0.85, P7100: 0.75 } } });
  expect(b.groups).toEqual([{ looms: 2, label: '2 Loom Group' }]);
  expect(b.types.map((x) => x.key)).toEqual(['PU', 'P7100']);
  const r = b.rows[0];
  // 1 day; 2 loom-shifts + 1 extra loom (rate / 2 = 500); 100 PU units x 0.85 = 85 + 60 P7100 x 0.75 = 45; loom 03 stopped: half the average of 100 and 60 = 40 units x PU 0.85 = 34
  expect(r).toMatchObject({ label: 'ALI KHAN (129)', days: 1, groups: { 2: { loom: 2, extra: 1 } }, ratePerDay: 1000, wagesAmount: 1000, extraLoomWages: 500, totalWages: 1500,
    unitsByType: { PU: 100, P7100: 60 }, totalUnits: 160, amountByType: { PU: 85, P7100: 45 }, productionAmount: 130, stoppedLooms: 1, stoppageUnits: 40, stoppageAmount: 34, net: 1664 });
  expect(b.totals).toMatchObject({ days: 1, totalWages: 1500, productionAmount: 130, stoppageAmount: 34, net: 1664, groups: { 2: { loom: 2, extra: 1 } } });
  expect(b.noWeaver.units).toBe(40); // loom 01 shift B has units but no weaver
  expect(b.noWeaver.message).toContain('40 units have no weaver');
  expect(b.checks.map((c) => [c.key, c.ok])).toEqual([['units', true], ['loomShifts', true], ['wages', true], ['production', true], ['stoppage', true], ['stoppageUnits', true], ['net', true]]);
  expect(b.stoppage).toEqual({ count: 1, units: 40, amount: 34 });
  const d = (await w.api('get', `/production/bill/stoppage?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(d).toMatchObject({ count: 1, units: 40, amount: 34 });
  expect(d.items[0]).toMatchObject({ label: 'ALI KHAN (129)', date: day, shift: 'A', loomNo: '03', type: 'PU', runningLooms: 2, avgUnits: 80, stoppageUnits: 40, rate: 0.85, amount: 34 });
  err(await w.api('get', `/production/bill?departmentId=${w.sulzer.id}&from=2026-11-17`), 422, 'BAD_PERIOD');
  expect((await w.viewer('get', `/production/bill?departmentId=${w.sulzer.id}&from=2026-11-16`)).status).toBe(200);
  const kinds = [['bill.pdf', 'application/pdf', 'sulzer-bill-16-30Nov-26.pdf'], ['bill.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sulzer-bill-16-30Nov-26.xlsx'], ['bill/stoppage.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sulzer-stoppage-16-30Nov-26.xlsx']];
  for (const [path, type, name] of kinds) {
    const file = await request(app).get(`/api/v1/production/${path}?departmentId=${w.sulzer.id}&from=2026-11-16`).set({ Authorization: `Bearer ${(await loginAs(w.admin)).accessToken}` })
      .buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect([file.status, file.headers['content-type']]).toEqual([200, type]);
    expect(file.headers['content-disposition']).toContain(name);
    if (process.env.PDF_OUT) require('fs').writeFileSync(`${process.env.PDF_OUT}/${path.replace('/', '-')}`, file.body);
  }
});
