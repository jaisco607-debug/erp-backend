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
  const sizer = (await api('post', '/weaving/vendors', { name: 'Sizing Co' })).body; // the sizing party is a vendor: we pay it for the work
  const sizer2 = (await api('post', '/weaving/vendors', { name: 'Other Sizing' })).body;
  const cust = (await api('post', '/weaving/customers', { name: 'Ali Traders' })).body;
  const inward = async (b) => (await api('post', '/weaving/yarn-inwards', { itemId: item.id, ...b })).body;
  const f1 = await inward({ vendorId: supplier.id, bags: 10, lbsPerBag: 100, ratePerLb: 300, inwardDate: '2026-11-01' }); // came to our factory
  const d1 = await inward({ vendorId: supplier.id, bags: 6, lbsPerBag: 50, ratePerLb: 310, inwardDate: '2026-11-02', directVendorId: sizer.id }); // delivered straight to Sizing Co
  const beam = async (b) => (await api('post', '/weaving/beams', { beamDate: '2026-10-01', ...b })).body;
  const b1 = await beam({ name: 'B1' });
  const b2 = await beam({ name: 'B2' });
  const b3 = await beam({ name: 'B3' });
  const full = await beam({ name: 'Full one', status: 'FULL' });
  const loom = await beam({ name: 'On loom', status: 'AT_LOOM' });
  return { company, svc, api, viewer: call(viewer), item, supplier, sizer, sizer2, cust, f1, d1, b1, b2, b3, full, loom, inward, beam };
}
const stock = async (w) => (await w.api('get', '/weaving/beam-stock')).body.statuses.map((s) => s.count);

test('yarn sizing: yarn bags and empty beams on ONE challan to a sizing vendor; direct yarn is on the challan but not on the gate pass; stocks follow', async () => {
  const w = await setup();
  // direct yarn is marked on the inward and kept out of every other picker
  expect(w.d1).toMatchObject({ sentDirect: true, directVendor: { name: 'Sizing Co' }, directVendorId: w.sizer.id });
  expect(w.f1).toMatchObject({ sentDirect: false, directVendor: null });
  expect((await w.api('get', '/weaving/yarn-weft/stock-entries')).body.data.map((e) => e.code)).toEqual([1]);
  expect((await w.api('get', '/weaving/yarn-returns/stock-entries')).body.data.map((e) => e.code)).toEqual([1]);
  expect((await w.api('get', '/weaving/yarn-sales/stock-entries')).body.data.map((e) => e.code)).toEqual([1]);
  err(await w.api('post', '/weaving/yarn-weft', { lines: [{ inwardId: w.d1.id, bags: 1 }] }), 422, 'DIRECT_YARN_SIZING_ONLY');
  err(await w.api('post', '/weaving/yarn-sales', { customerId: w.cust.id, lines: [{ inwardId: w.d1.id, bags: 1, ratePerLb: 5 }] }), 422, 'DIRECT_YARN_SIZING_ONLY');
  // the sizing picker: the factory yarn and the yarn sent direct to THIS party
  expect((await w.api('get', `/weaving/yarn-sizing/stock-entries?sizingVendorId=${w.sizer.id}`)).body.data.map((e) => e.code)).toEqual([1, 2]);
  expect((await w.api('get', `/weaving/yarn-sizing/stock-entries?sizingVendorId=${w.sizer2.id}`)).body.data.map((e) => e.code)).toEqual([1]);
  // the empty beams that can go
  const eb = (await w.api('get', '/weaving/yarn-sizing/beams')).body;
  expect(eb.data.map((b) => b.name)).toEqual(['B1', 'B2', 'B3']);
  expect(await stock(w)).toEqual([3, 1, 1, 0]);

  // one entry: 4 bags from the factory + 3 bags delivered direct + 2 beams
  const c = await w.api('post', '/weaving/yarn-sizing', { vendorId: w.sizer.id, outwardDate: '2026-11-05', description: 'sizing job',
    lines: [{ inwardId: w.f1.id, bags: 4 }, { inwardId: w.d1.id, bags: 3 }], beamIds: [w.b1.id, w.b2.id] });
  expect(c.status).toBe(201);
  expect(c.body).toMatchObject({ type: 'SIZING', challanNo: 1, challanText: '00001', party: { kind: 'VENDOR', name: 'Sizing Co' }, outwardDate: '2026-11-05', description: 'sizing job',
    totalBags: 7, totalLbs: 550, factoryBags: 4, factoryLbs: 400, directBags: 3, totalBeams: 2 });
  expect(c.body.beams.map((b) => [b.beamNo, b.name])).toEqual([[1, 'B1'], [2, 'B2']]);
  expect(c.body.lines.map((l) => [l.inwardCode, l.bags, l.lbs, l.viaFactory])).toEqual([[1, 4, 400, true], [2, 3, 150, false]]);

  // stocks: yarn (balances) and beams (2 now at sizing, since the challan date)
  expect((await w.api('get', `/weaving/yarn-sizing/stock-entries?sizingVendorId=${w.sizer.id}`)).body.data.map((e) => [e.code, e.balanceBags])).toEqual([[1, 6], [2, 3]]);
  expect((await w.api('get', '/weaving/yarn-stock')).body.totals).toMatchObject({ inwardBags: 16, outwardBags: 7, balanceBags: 9 });
  expect(await stock(w)).toEqual([1, 1, 1, 2]);
  const at = (await w.api('get', '/weaving/beam-stock/AT_SIZING')).body;
  expect(at.data.map((b) => [b.name, b.statusDate, b.sizing.challanNo, b.sizing.partyName])).toEqual([['B1', '2026-11-05', 1, 'Sizing Co'], ['B2', '2026-11-05', 1, 'Sizing Co']]);

  // gate pass: only what leaves our factory: 4 bags (not the 3 direct ones) and 2 beams
  expect((await w.api('get', `/weaving/yarn-sizing/${c.body.id}/gate-pass`)).body).toEqual({ challanId: c.body.id, type: 'SIZING', date: '2026-11-05',
    party: { kind: 'VENDOR', id: w.sizer.id, name: 'Sizing Co' }, partyName: 'Sizing Co', challanNo: 1, challanText: '00001', bags: 4, beams: 2, copies: 3 });
  expect((await w.viewer('get', `/weaving/yarn-sizing/${c.body.id}`)).body.totalBeams).toBe(2);

  // rules
  const base = { vendorId: w.sizer.id, outwardDate: '2026-11-06' };
  err(await w.api('post', '/weaving/yarn-sizing', { ...base, beamIds: [w.full.id] }), 422, 'BEAM_NOT_EMPTY');
  err(await w.api('post', '/weaving/yarn-sizing', { ...base, beamIds: [w.loom.id] }), 422, 'BEAM_NOT_EMPTY');
  err(await w.api('post', '/weaving/yarn-sizing', { ...base, beamIds: [w.b1.id] }), 422, 'BEAM_NOT_EMPTY'); // already at sizing
  err(await w.api('post', '/weaving/yarn-sizing', { ...base, beamIds: ['11111111-1111-4111-8111-111111111111'] }), 422, 'UNKNOWN_BEAM');
  err(await w.api('post', '/weaving/yarn-sizing', { ...base, outwardDate: '2026-09-01', beamIds: [w.b3.id] }), 422, 'BEAM_DATE');
  err(await w.api('post', '/weaving/yarn-sizing', { vendorId: w.sizer2.id, lines: [{ inwardId: w.d1.id, bags: 1 }] }), 422, 'DIRECT_OTHER_PARTY');
  err(await w.api('post', '/weaving/yarn-sizing', { ...base, lines: [{ inwardId: w.f1.id, bags: 7 }] }), 422, 'NOT_ENOUGH_STOCK');
  err(await w.api('post', '/weaving/yarn-sizing', { ...base, outwardDate: '2026-10-30', lines: [{ inwardId: w.f1.id, bags: 1 }] }), 422, 'BEFORE_INWARD');
  err(await w.api('post', '/weaving/yarn-sizing', { ...base }), 422, 'NOTHING_TO_SEND');
  err(await w.api('post', '/weaving/yarn-sizing', { ...base, vendorId: w.cust.id, beamIds: [w.b3.id] }), 422, 'UNKNOWN_VENDOR');
  expect((await w.api('post', '/weaving/yarn-sizing', { ...base, beamIds: [w.b3.id, w.b3.id] })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-sizing', { lines: [{ inwardId: w.f1.id, bags: 1 }] })).status).toBe(400); // the party is needed
  expect((await w.viewer('post', '/weaving/yarn-sizing', { ...base, beamIds: [w.b3.id] })).status).toBe(403);
  expect(await stock(w)).toEqual([1, 1, 1, 2]); // the refused ones changed nothing

  // the beams on a challan are moved only by the challan; a beam on a challan cannot be deleted
  err(await w.api('patch', `/weaving/beams/${w.b1.id}`, { status: 'EMPTY' }), 422, 'BEAM_ON_CHALLAN');
  err(await w.api('delete', `/weaving/beams/${w.b1.id}`), 422, 'BEAM_ON_CHALLAN');
  expect((await w.api('patch', `/weaving/beams/${w.b1.id}`, { name: 'B1 renamed' })).status).toBe(200);
  // the direct yarn and the vendor are held by the challan
  err(await w.api('patch', `/weaving/yarn-inwards/${w.d1.id}`, { directVendorId: null }), 422, 'USED_IN_OUTWARD');
  err(await w.api('delete', `/weaving/yarn-inwards/${w.d1.id}`), 422, 'IN_USE');
  err(await w.api('delete', `/weaving/vendors/${w.sizer.id}`), 422, 'IN_USE');

  // list
  const l = (await w.api('get', '/weaving/yarn-sizing')).body;
  expect(l.data[0]).toMatchObject({ challanNo: 1, partyName: 'Sizing Co', totalBags: 7, factoryBags: 4, directBags: 3, totalBeams: 2 });
  expect(l.totals).toEqual({ entries: 1, bags: 7, lbs: 550, beams: 2 });
  expect((await w.api('get', '/weaving/yarn-sizing?search=sizing co')).body.total).toBe(1);
  expect((await w.api('get', `/weaving/yarn-sizing?vendorId=${w.sizer2.id}`)).body.total).toBe(0);
  expect((await w.api('get', '/weaving/yarn-weft')).body.total).toBe(0); // not in the other outward lists
  err(await w.api('get', `/weaving/yarn-weft/${c.body.id}`), 404, 'NOT_FOUND');

  // change: other beams and bags (the old ones are put back first); beams come back EMPTY where they were
  const u = await w.api('patch', `/weaving/yarn-sizing/${c.body.id}`, { beamIds: [w.b2.id, w.b3.id], lines: [{ inwardId: w.f1.id, bags: 10 }] });
  expect(u.body).toMatchObject({ totalBags: 10, factoryBags: 10, directBags: 0, totalBeams: 2 });
  expect(u.body.beams.map((b) => b.name)).toEqual(['B2', 'B3']);
  expect(await stock(w)).toEqual([1, 1, 1, 2]);
  expect((await w.api('get', '/weaving/beam-stock/EMPTY')).body.data.map((b) => [b.name, b.statusDate])).toEqual([['B1 renamed', '2026-10-01']]);
  // only beams, only direct yarn
  const onlyBeam = await w.api('patch', `/weaving/yarn-sizing/${c.body.id}`, { lines: [] });
  expect(onlyBeam.body).toMatchObject({ totalBags: 0, totalBeams: 2 });
  expect((await w.api('get', `/weaving/yarn-sizing/${c.body.id}/gate-pass`)).body).toMatchObject({ bags: 0, beams: 2 });
  err(await w.api('patch', `/weaving/yarn-sizing/${c.body.id}`, { beamIds: [] }), 422, 'NOTHING_TO_SEND');
  const direct = await w.api('post', '/weaving/yarn-sizing', { vendorId: w.sizer.id, outwardDate: '2026-11-07', lines: [{ inwardId: w.d1.id, bags: 6 }] });
  expect(direct.body).toMatchObject({ challanNo: 2, factoryBags: 0, directBags: 6, totalBeams: 0 });
  // the yarn went straight from the supplier and no beams: the challan exists but nothing leaves our factory: no gate pass
  err(await w.api('get', `/weaving/yarn-sizing/${direct.body.id}/gate-pass`), 422, 'NOTHING_LEAVES');

  // delete: yarn back in the stock, beams back EMPTY with their old date
  expect((await w.api('delete', `/weaving/yarn-sizing/${c.body.id}`)).body.deleted).toBe(true);
  expect(await stock(w)).toEqual([3, 1, 1, 0]);
  expect((await w.api('get', '/weaving/beam-stock/EMPTY')).body.data.map((b) => b.statusDate)).toEqual(['2026-10-01', '2026-10-01', '2026-10-01']);
  expect((await w.api('delete', `/weaving/yarn-sizing/${direct.body.id}`)).body.deleted).toBe(true);
  expect((await w.api('get', `/weaving/yarn-sizing/stock-entries?sizingVendorId=${w.sizer.id}`)).body.data.map((e) => [e.code, e.balanceBags])).toEqual([[1, 10], [2, 6]]);
  expect((await w.api('delete', `/weaving/beams/${w.b1.id}`)).body.deleted).toBe(true);

  // another company sees nothing
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/yarn-sizing')).body.total).toBe(0);
  err(await oa('get', `/weaving/yarn-sizing/${c.body.id}`), 404, 'NOT_FOUND');
  err(await oa('post', '/weaving/yarn-sizing', { vendorId: w.sizer.id, beamIds: [w.b2.id] }), 422, 'UNKNOWN_VENDOR');
});
