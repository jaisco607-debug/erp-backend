const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  const svc = await Service.findOne({ where: { code: 'WEAVING_MASTERS' } });
  await CompanyService.create({ companyId: company.id, serviceId: svc.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: svc.id, access: 'VIEW' });
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const supplier = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const sizer = (await api('post', '/weaving/vendors', { name: 'Sizing Co' })).body;
  const sizer2 = (await api('post', '/weaving/vendors', { name: 'Other Sizing' })).body;
  // 5000 lbs of yarn: 50 bags of 100 lbs
  const yarn = (await api('post', '/weaving/yarn-inwards', { itemId: item.id, vendorId: supplier.id, bags: 50, lbsPerBag: 100, ratePerLb: 300, inwardDate: '2026-11-01' })).body;
  const beams = [];
  for (let i = 1; i <= 5; i += 1) beams.push((await api('post', '/weaving/beams', { name: `B${i}`, beamDate: '2026-10-01' })).body);
  // 4 beams and the 5000 lbs go to sizing on one challan
  const challan = (await api('post', '/weaving/yarn-sizing', { vendorId: sizer.id, outwardDate: '2026-11-05', lines: [{ inwardId: yarn.id, bags: 50 }], beamIds: beams.slice(0, 4).map((b) => b.id) })).body;
  return { company, svc, api, viewer: call(viewer), sizer, sizer2, yarn, beams, challan };
}
const stock = async (w) => (await w.api('get', '/weaving/beam-stock')).body.statuses.map((s) => s.count);

test('sizing inward: sized beams come back with meters; lbs used (charged), cut cone (not charged); beams go FULL; received in parts; change and delete', async () => {
  const w = await setup();
  expect(w.challan).toMatchObject({ totalLbs: 5000, totalBeams: 4 });
  expect(await stock(w)).toEqual([1, 0, 0, 4]);

  // the challans waiting for their beams
  const wait = (await w.api('get', '/weaving/sizing-inwards/challans')).body;
  expect(wait.total).toBe(1);
  expect(wait.data[0]).toMatchObject({ id: w.challan.id, challanNo: 1, party: { name: 'Sizing Co' }, sentBags: 50, sentLbs: 5000, usedLbs: 0, remainingLbs: 5000, pendingCount: 4 });
  expect(wait.data[0].pendingBeams.map((b) => b.name)).toEqual(['B1', 'B2', 'B3', 'B4']);
  expect((await w.api('get', `/weaving/sizing-inwards/challans?vendorId=${w.sizer2.id}`)).body.total).toBe(0);
  expect((await w.api('get', '/weaving/sizing-inwards/challans?search=B3')).body.total).toBe(1);

  // first receipt: 2 beams with 5000 m each (a pair), 2400 lbs used at 10 per lb, 50 kg cut cone back
  const r1 = await w.api('post', '/weaving/sizing-inwards', { outwardId: w.challan.id, inwardDate: '2026-11-12', dcNo: 'SZ-77', lbsUsed: 2400, cutConeKg: 50, ratePerLb: 10, description: 'first pair',
    beams: [{ beamId: w.beams[0].id, meters: 5000 }, { beamId: w.beams[1].id, meters: 5000 }] });
  expect(r1.status).toBe(201);
  expect(r1.body).toMatchObject({ inwardNo: 1, inwardLabel: '00001', inwardDate: '2026-11-12', dcNo: 'SZ-77', party: { name: 'Sizing Co' }, challan: { challanNo: 1, challanText: '00001' },
    totalBeams: 2, totalMeters: 10000, lbsUsed: 2400, cutConeKg: 50, cutConeLbs: 110.23, ratePerLb: 10, amount: 24000 });
  expect(r1.body.beams.map((b) => [b.name, b.meters])).toEqual([['B1', 5000], ['B2', 5000]]);
  // the beams are FULL now (with their meters), the other two are still at sizing
  expect(await stock(w)).toEqual([1, 2, 0, 2]);
  const full = (await w.api('get', '/weaving/beam-stock/FULL')).body;
  expect(full.data.map((b) => [b.name, b.meters, b.statusDate])).toEqual([['B1', 5000, '2026-11-12'], ['B2', 5000, '2026-11-12']]);
  expect((await w.api('get', '/weaving/beam-stock/AT_SIZING')).body.data.map((b) => [b.name, b.sizing.challanNo])).toEqual([['B3', 1], ['B4', 1]]);
  expect((await w.api('get', `/weaving/beams/${w.beams[0].id}`)).body).toMatchObject({ status: 'FULL', meters: 5000 });
  // the challan still waits for 2 beams; 2600 lbs are left to use
  expect((await w.api('get', '/weaving/sizing-inwards/challans')).body.data[0]).toMatchObject({ pendingCount: 2, usedLbs: 2400, remainingLbs: 2600 });

  // second receipt: the other pair with 4200 m each; 2400 lbs used (4800 in all), 100 kg cut cone, rate 10
  const r2 = await w.api('post', '/weaving/sizing-inwards', { outwardId: w.challan.id, inwardDate: '2026-11-14', lbsUsed: 2400, cutConeKg: 100, ratePerLb: 10,
    beams: [{ beamId: w.beams[2].id, meters: 4200 }, { beamId: w.beams[3].id, meters: 4200 }] });
  expect(r2.body).toMatchObject({ inwardNo: 2, totalMeters: 8400, lbsUsed: 2400, cutConeKg: 100, cutConeLbs: 220.46, amount: 24000 });
  expect(await stock(w)).toEqual([1, 4, 0, 0]);
  // everything of the challan is back: it is not in the waiting list; 200 lbs were left over (5000 - 4800), given back as cut cone, not charged
  expect((await w.api('get', '/weaving/sizing-inwards/challans')).body.total).toBe(0);

  // rules
  err(await w.api('post', '/weaving/sizing-inwards', { outwardId: w.challan.id, lbsUsed: 1, ratePerLb: 10, beams: [{ beamId: w.beams[0].id, meters: 10 }] }), 422, 'BEAM_NOT_ON_CHALLAN'); // already received
  err(await w.api('post', '/weaving/sizing-inwards', { outwardId: w.challan.id, lbsUsed: 1, ratePerLb: 10, beams: [{ beamId: w.beams[4].id, meters: 10 }] }), 422, 'BEAM_NOT_ON_CHALLAN'); // never sent
  err(await w.api('post', '/weaving/sizing-inwards', { outwardId: '11111111-1111-4111-8111-111111111111', lbsUsed: 1, ratePerLb: 10, beams: [{ beamId: w.beams[0].id, meters: 10 }] }), 422, 'UNKNOWN_CHALLAN');

  // list and one
  const l = (await w.api('get', '/weaving/sizing-inwards')).body;
  expect(l.data.map((x) => x.inwardNo)).toEqual([2, 1]);
  expect(l.totals).toEqual({ entries: 2, beams: 4, meters: 18400, lbsUsed: 4800, cutConeKg: 150, amount: 48000 });
  expect((await w.api('get', '/weaving/sizing-inwards?search=sizing co')).body.total).toBe(2);
  expect((await w.api('get', '/weaving/sizing-inwards?search=SZ-77')).body.data.map((x) => x.inwardNo)).toEqual([1]);
  expect((await w.api('get', `/weaving/sizing-inwards?outwardId=${w.challan.id}&dateFrom=2026-11-13`)).body.data.map((x) => x.inwardNo)).toEqual([2]);
  expect((await w.viewer('get', `/weaving/sizing-inwards/${r1.body.id}`)).body).toMatchObject({ inwardNo: 1, sentLbs: 5000, remainingLbs: 200 });
  expect((await w.viewer('post', '/weaving/sizing-inwards', {})).status).toBe(403);

  // the challan is held by its receipts; the beams are not at sizing any more (a full beam can be moved on the beam form again)
  err(await w.api('delete', `/weaving/yarn-sizing/${w.challan.id}`), 422, 'HAS_SIZING_INWARD');
  err(await w.api('patch', `/weaving/yarn-sizing/${w.challan.id}`, { beamIds: [w.beams[4].id] }), 422, 'HAS_SIZING_INWARD');
  expect((await w.api('patch', `/weaving/yarn-sizing/${w.challan.id}`, { description: 'sizing job' })).status).toBe(200);
  err(await w.api('delete', `/weaving/vendors/${w.sizer.id}`), 422, 'IN_USE');

  // change a receipt: other meters, lbs, rate (the beams are put back and received again)
  const u = await w.api('patch', `/weaving/sizing-inwards/${r1.body.id}`, { lbsUsed: 2500, ratePerLb: 11, beams: [{ beamId: w.beams[0].id, meters: 5100 }, { beamId: w.beams[1].id, meters: 5050 }] });
  expect(u.body).toMatchObject({ totalMeters: 10150, lbsUsed: 2500, amount: 27500 });
  err(await w.api('patch', `/weaving/sizing-inwards/${r1.body.id}`, { lbsUsed: 2700 }), 422, 'MORE_THAN_SENT'); // 2700 + 2400 > 5000
  expect((await w.api('get', '/weaving/beam-stock/FULL')).body.data.map((b) => b.meters).sort((a, c) => a - c)).toEqual([4200, 4200, 5050, 5100]);

  // a full beam that moved on (put on a loom on the beam form) holds its receipt
  await w.api('patch', `/weaving/beams/${w.beams[2].id}`, { status: 'AT_LOOM' });
  err(await w.api('delete', `/weaving/sizing-inwards/${r2.body.id}`), 422, 'BEAM_MOVED_ON');
  await w.api('patch', `/weaving/beams/${w.beams[2].id}`, { status: 'FULL' });

  // delete a receipt: beams back at sizing with the old date, no meters; the lbs go back to the challan
  expect((await w.api('delete', `/weaving/sizing-inwards/${r2.body.id}`)).body.deleted).toBe(true);
  expect(await stock(w)).toEqual([1, 2, 0, 2]);
  expect((await w.api('get', '/weaving/beam-stock/AT_SIZING')).body.data.map((b) => [b.name, b.statusDate])).toEqual([['B3', '2026-11-05'], ['B4', '2026-11-05']]);
  expect((await w.api('get', '/weaving/sizing-inwards/challans')).body.data[0]).toMatchObject({ pendingCount: 2, usedLbs: 2500, remainingLbs: 2500 });
  // the challan can be deleted only after all its receipts are deleted
  err(await w.api('delete', `/weaving/yarn-sizing/${w.challan.id}`), 422, 'HAS_SIZING_INWARD');
  await w.api('delete', `/weaving/sizing-inwards/${r1.body.id}`);
  expect((await w.api('delete', `/weaving/yarn-sizing/${w.challan.id}`)).body.deleted).toBe(true);
  expect(await stock(w)).toEqual([5, 0, 0, 0]);
});

test('sizing inward: dates, lbs more than sent, validation, another company', async () => {
  const w = await setup();
  const b = (i, m = 100) => ({ beamId: w.beams[i].id, meters: m });
  const base = { outwardId: w.challan.id, lbsUsed: 100, ratePerLb: 10 };
  err(await w.api('post', '/weaving/sizing-inwards', { ...base, inwardDate: '2026-11-01', beams: [b(0)] }), 422, 'BEFORE_OUTWARD');
  err(await w.api('post', '/weaving/sizing-inwards', { ...base, lbsUsed: 5000.01, beams: [b(0)] }), 422, 'MORE_THAN_SENT');
  expect((await w.api('post', '/weaving/sizing-inwards', { ...base, beams: [] })).status).toBe(400);
  expect((await w.api('post', '/weaving/sizing-inwards', { ...base, beams: [b(0, 0)] })).status).toBe(400);
  expect((await w.api('post', '/weaving/sizing-inwards', { ...base, beams: [b(0), b(0)] })).status).toBe(400);
  expect((await w.api('post', '/weaving/sizing-inwards', { outwardId: w.challan.id, lbsUsed: 100, beams: [b(0)] })).status).toBe(400); // the rate is needed
  expect((await w.api('post', '/weaving/sizing-inwards', { outwardId: w.challan.id, ratePerLb: 10, beams: [b(0)] })).status).toBe(400); // the lbs used are needed
  expect((await w.api('post', '/weaving/sizing-inwards', { ...base, cutConeKg: -1, beams: [b(0)] })).status).toBe(400);
  expect(await stock(w)).toEqual([1, 0, 0, 4]); // nothing changed
  // the default date is today; no cut cone is fine
  const ok = await w.api('post', '/weaving/sizing-inwards', { ...base, beams: [b(0)] });
  expect(ok.status).toBe(201);
  expect(ok.body).toMatchObject({ cutConeKg: 0, cutConeLbs: 0, amount: 1000 });
  expect(ok.body.inwardDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/sizing-inwards')).body.total).toBe(0);
  expect((await oa('get', '/weaving/sizing-inwards/challans')).body.total).toBe(0);
  err(await oa('get', `/weaving/sizing-inwards/${ok.body.id}`), 404, 'NOT_FOUND');
  err(await oa('post', '/weaving/sizing-inwards', { ...base, beams: [b(1)] }), 422, 'UNKNOWN_CHALLAN');
});
