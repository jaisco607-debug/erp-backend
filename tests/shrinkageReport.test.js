const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

// owner plan N-B4: wastage and shrinkage: what a department received against what it sent on, the percent, and the expected limit
const CODES = ['GREY_STORE', 'SO_CARD', 'DYEING', 'FINISHING', 'FOLDING', 'REPORT_DEPARTMENTS'];
async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of CODES) { s[code] = await Service.findOne({ where: { code } }); await CompanyService.create({ companyId: company.id, serviceId: s[code].id }); }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: s.DYEING.id, access: 'VIEW' });
  const as = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  return { company, s, api: as(admin), viewerApi: as(viewer) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };

/** One lot of `meters` of a customer / quality goes to Dyeing; Dyeing writes the thaans it made (`made`); with `sendOn` it goes on to Finishing. */
async function dyeing(w, { customer, quality, thaans, made, sendOn = true, reject = false }) {
  const lot = await ok(w.api('post', '/grey-lots', { inwardDate: require('../src/utils/dates').today(), customerId: customer.id, qualityId: quality.id, thaans }), 201);
  await ok(w.api('post', `/grey-lots/${lot.id}/approve`));
  const card = await ok(w.api('post', '/so-cards', { cardDate: require('../src/utils/dates').today(), lots: [{ greyLotId: lot.id, thaanNos: thaans.map((_, i) => i + 1) }] }), 201);
  const fd = await ok(w.api('get', '/jobs/form-data'));
  const job = await ok(w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: fd.rows.find((r) => r.soCard.id === card.id).soCardLotId }] }), 201);
  await ok(w.api('post', `/departments/DYEING/jobs/${job.id}/receive`));
  await ok(w.api('post', `/departments/DYEING/jobs/${job.id}/accept`));
  await ok(w.api('put', `/departments/DYEING/jobs/${job.id}/thaans`, { items: [{ jobItemId: job.items[0].id, thaans: made }] }));
  await ok(w.api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'COMPLETE' }));
  if (sendOn) {
    await ok(w.api('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'Aslam', processDate: require('../src/utils/dates').today() }));
    const form = await ok(w.api('get', `/departments/DYEING/send-form?jobId=${job.id}`));
    await ok(w.api('post', '/departments/DYEING/send', { toDepartmentCode: 'FINISHING', items: [{ jobItemId: form.rows[0].jobItemId }] }), 201);
  }
  void reject;
  return { lot, card, job };
}

test('the shrinkage report: loss and gain per department, quality, customer, month and job; the expected limit marks a row red; only cloth that went on counts', async () => {
  const w = await setup();
  const az = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const bb = await ok(w.api('post', '/customers', { name: 'BB' }), 201);
  const twill = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const cotton = await ok(w.api('post', '/qualities', { name: 'COTTON' }), 201);
  const a = await dyeing(w, { customer: az, quality: twill, thaans: [100, 120], made: [215] }); // 220 in, 215 on: loss 5
  await dyeing(w, { customer: bb, quality: cotton, thaans: [100], made: [95] }); // 100 in, 95 on: loss 5 (5 %)
  await dyeing(w, { customer: az, quality: twill, thaans: [50], made: [48], sendOn: false }); // not sent on yet: not counted
  void a;

  const r = await ok(w.api('get', '/reports/shrinkage'));
  expect(r.groupBy).toBe('department');
  expect(r.sections[0].rows).toHaveLength(1);
  expect(r.sections[0].rows[0]).toMatchObject({ group: 'Dyeing', receivedMeters: 320, sentOnMeters: 310, diffMeters: 10, diffPercent: 3.13, kind: 'Loss', expectedPercent: null, overLimit: false });
  expect(r.sections[0].totals).toMatchObject({ receivedMeters: 320, sentOnMeters: 310, diffMeters: 10, diffPercent: 3.13 });
  expect(r.sections[0].columns.map((c) => c.key)).toEqual(['group', 'lines', 'receivedMeters', 'sentOnMeters', 'diffMeters', 'diffPercent', 'kind', 'expectedPercent', 'status']);

  // the groups
  const byQuality = (await ok(w.api('get', '/reports/shrinkage?groupBy=quality'))).sections[0].rows;
  expect(byQuality.map((x) => [x.group, x.receivedMeters, x.diffMeters, x.diffPercent])).toEqual([['COTTON', 100, 5, 5], ['PC TWILL', 220, 5, 2.27]]);
  const byCustomer = (await ok(w.api('get', '/reports/shrinkage?groupBy=customer'))).sections[0].rows;
  expect(byCustomer.map((x) => [x.group, x.diffMeters]).sort()).toEqual([['AZ', 5], ['BB', 5]]);
  const byMonth = (await ok(w.api('get', '/reports/shrinkage?groupBy=month'))).sections[0].rows;
  expect(byMonth).toHaveLength(1);
  const byJob = (await ok(w.api('get', '/reports/shrinkage?groupBy=job'))).sections[0].rows;
  expect(byJob).toHaveLength(2);
  expect(byJob[0]).toMatchObject({ department: 'Dyeing', diffMeters: 5, keys: { jobId: expect.any(String), departmentId: expect.any(String) } });

  // filters
  expect((await ok(w.api('get', `/reports/shrinkage?customerId=${az.id}`))).sections[0].totals).toMatchObject({ receivedMeters: 220, diffMeters: 5 });
  expect((await ok(w.api('get', `/reports/shrinkage?qualityId=${cotton.id}`))).sections[0].totals).toMatchObject({ receivedMeters: 100, diffPercent: 5 });
  expect((await ok(w.api('get', `/reports/shrinkage?lotNo=${a.lot.lotNo}`))).sections[0].totals).toMatchObject({ receivedMeters: 220 });
  expect((await ok(w.api('get', '/reports/shrinkage?dateFrom=2099-01-01'))).sections[0].rows).toHaveLength(0);
  const exp = await ok(w.api('get', '/reports/shrinkage?groupBy=job&export=true'));
  expect(exp.total).toBe(2);

  // the expected limits: 2.5 % for the twill (2.27 is fine), 4 % for the cotton (5 is over)
  const lim = await ok(w.api('get', '/shrinkage-limits'));
  const dye = lim.departments.find((d) => d.code === 'DYEING');
  expect(lim.departments.map((d) => d.code).sort()).toEqual(['DYEING', 'FINISHING', 'FOLDING']);
  await ok(w.api('put', '/shrinkage-limits', { items: [{ departmentId: dye.id, qualityId: twill.id, limitPercent: 2.5 }, { departmentId: dye.id, qualityId: cotton.id, limitPercent: 4 }] }));
  const lq = (await ok(w.api('get', '/reports/shrinkage?groupBy=quality'))).sections[0].rows;
  expect(lq.find((x) => x.group === 'COTTON')).toMatchObject({ expectedPercent: 4, overLimit: true, status: 'Over the expected limit' });
  expect(lq.find((x) => x.group === 'PC TWILL')).toMatchObject({ expectedPercent: 2.5, overLimit: false, status: 'Within the limit' });
  const ld = (await ok(w.api('get', '/reports/shrinkage'))).sections[0];
  expect(ld.rows[0]).toMatchObject({ expectedPercent: 2.97, overLimit: true });
  expect(ld.totals.overLimitRows).toBe(1);
  // a limit for the whole department is the fallback of a quality without its own
  await ok(w.api('put', '/shrinkage-limits', { items: [{ departmentId: dye.id, qualityId: cotton.id, limitPercent: null }, { departmentId: dye.id, qualityId: null, limitPercent: 6 }] }));
  expect((await ok(w.api('get', '/reports/shrinkage?groupBy=quality'))).sections[0].rows.find((x) => x.group === 'COTTON')).toMatchObject({ expectedPercent: 6, overLimit: false });
});

test('the shrinkage report: a gain, rights, limits are for the client admin, another company sees nothing', async () => {
  const w = await setup();
  const other = await setup();
  const az = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const twill = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  await dyeing(w, { customer: az, quality: twill, thaans: [100], made: [103] }); // the cloth stretched: a gain of 3
  const r = (await ok(w.api('get', '/reports/shrinkage'))).sections[0].rows[0];
  expect(r).toMatchObject({ receivedMeters: 100, sentOnMeters: 103, diffMeters: -3, diffPercent: -3, kind: 'Gain', overLimit: false });

  // a department person (Dyeing, VIEW) reads the report; only the client admin changes the limits
  expect((await w.viewerApi('get', '/reports/shrinkage')).status).toBe(200);
  const dye = (await ok(w.api('get', '/shrinkage-limits'))).departments.find((d) => d.code === 'DYEING');
  expect((await w.viewerApi('put', '/shrinkage-limits', { items: [{ departmentId: dye.id, qualityId: null, limitPercent: 3 }] })).status).toBe(403);
  await fails(w.api('put', '/shrinkage-limits', { items: [{ departmentId: dye.id, qualityId: null, limitPercent: 101 }] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('put', '/shrinkage-limits', { items: [{ departmentId: dye.id, qualityId: null, limitPercent: 3 }, { departmentId: dye.id, qualityId: null, limitPercent: 4 }] }), 422, 'DUPLICATE_LIMIT');
  await fails(other.api('put', '/shrinkage-limits', { items: [{ departmentId: dye.id, qualityId: twill.id, limitPercent: 3 }] }), 404, 'NOT_FOUND');
  // the other company has nothing, and does not see this one's cloth
  expect((await ok(other.api('get', '/reports/shrinkage'))).sections[0].rows).toHaveLength(0);
  expect((await ok(other.api('get', `/reports/shrinkage?customerId=${az.id}`))).sections[0].rows).toHaveLength(0);
  // it is in the reports menu
  expect((await ok(w.api('get', '/reports'))).reports.map((x) => x.key)).toContain('shrinkage');
});

test('the shrinkage report: Folding counts the thaans it fully graded; cloth still waiting there is not a loss', async () => {
  const w = await setup();
  const az = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const twill = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const day = require('../src/utils/dates').today();
  const lot = await ok(w.api('post', '/grey-lots', { inwardDate: day, customerId: az.id, qualityId: twill.id, thaans: [100, 120] }), 201);
  await ok(w.api('post', `/grey-lots/${lot.id}/approve`));
  const card = await ok(w.api('post', '/so-cards', { cardDate: day, lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] }), 201);
  const fd = await ok(w.api('get', '/jobs/form-data'));
  const dye = await ok(w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: fd.rows.find((r) => r.soCard.id === card.id).soCardLotId }] }), 201);
  await ok(w.api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'COMPLETE' }));
  await ok(w.api('put', `/departments/DYEING/jobs/${dye.id}/operator`, { operatorName: 'Aslam', processDate: day }));
  const form = await ok(w.api('get', '/departments/DYEING/send-form'));
  const fold = await ok(w.api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows[0].jobItemId }] }), 201);
  await ok(w.api('post', `/departments/FOLDING/jobs/${fold.id}/accept`));
  const row = await ok(w.api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`));
  const ls = row.lots[0].lines;
  // thaan 1 (100 m) is fully graded with a gain of 2; thaan 2 (120 m) is only partly graded: not counted yet
  await ok(w.api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: [{ greyLotId: lot.id, thaanId: ls[0].thaanId, a: 102 }, { greyLotId: lot.id, thaanId: ls[1].thaanId, a: 50 }] }));
  const r = (await ok(w.api('get', '/reports/shrinkage'))).sections[0].rows;
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ group: 'Folding', receivedMeters: 100, sentOnMeters: 102, diffMeters: -2, kind: 'Gain' });
});

test('the shrinkage limit of Folding: the department limit fills Expected % and the status of the Folding row', async () => {
  const w = await setup();
  const az = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const twill = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const day = require('../src/utils/dates').today();
  const lot = await ok(w.api('post', '/grey-lots', { inwardDate: day, customerId: az.id, qualityId: twill.id, thaans: [1000] }), 201);
  await ok(w.api('post', `/grey-lots/${lot.id}/approve`));
  const card = await ok(w.api('post', '/so-cards', { cardDate: day, lots: [{ greyLotId: lot.id, thaanNos: [1] }] }), 201);
  const fd = await ok(w.api('get', '/jobs/form-data'));
  const dye = await ok(w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: fd.rows.find((r) => r.soCard.id === card.id).soCardLotId }] }), 201);
  await ok(w.api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'COMPLETE' }));
  await ok(w.api('put', `/departments/DYEING/jobs/${dye.id}/operator`, { operatorName: 'Aslam', processDate: day }));
  const form = await ok(w.api('get', '/departments/DYEING/send-form'));
  const fold = await ok(w.api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows[0].jobItemId }] }), 201);
  await ok(w.api('post', `/departments/FOLDING/jobs/${fold.id}/accept`));
  const ls = (await ok(w.api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`))).lots[0].lines;
  // 1,000 m received, 995 m graded and the row closed: a loss of 5 m = 0.5 %
  await ok(w.api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: [{ greyLotId: lot.id, thaanId: ls[0].thaanId, a: 995 }] }));
  await ok(w.api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/close`, { isClosed: true, closeNote: 'shrinkage' }));
  const folding = (await ok(w.api('get', '/shrinkage-limits'))).departments.find((d) => d.code === 'FOLDING');
  let row = (await ok(w.api('get', '/reports/shrinkage'))).sections[0].rows[0];
  expect(row).toMatchObject({ group: 'Folding', receivedMeters: 1000, sentOnMeters: 995, diffMeters: 5, diffPercent: 0.5, expectedPercent: null, overLimit: false });
  await ok(w.api('put', '/shrinkage-limits', { items: [{ departmentId: folding.id, qualityId: null, limitPercent: 0.2 }] }));
  row = (await ok(w.api('get', '/reports/shrinkage'))).sections[0].rows[0];
  expect(row).toMatchObject({ expectedPercent: 0.2, overLimit: true, status: 'Over the expected limit' });
  await ok(w.api('put', '/shrinkage-limits', { items: [{ departmentId: folding.id, qualityId: null, limitPercent: 1 }] }));
  expect((await ok(w.api('get', '/reports/shrinkage'))).sections[0].rows[0]).toMatchObject({ expectedPercent: 1, overLimit: false, status: 'Within the limit' });
  // 0.2 with more than 2 decimals, below 0 and above 100 are refused
  for (const bad of [0.255, -1, 100.5]) await fails(w.api('put', '/shrinkage-limits', { items: [{ departmentId: folding.id, qualityId: null, limitPercent: bad }] }), 400, 'VALIDATION_FAILED');
});
