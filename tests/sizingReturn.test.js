const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(300000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  for (const code of ['WEAVING_MASTERS', 'SIZING']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'WEAVING_MASTERS' } })).id, access: 'VIEW' });
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '60/s CTN' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const supplier = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const sizer = (await api('post', '/weaving/vendors', { name: 'Sizing Co' })).body;
  const sizer2 = (await api('post', '/weaving/vendors', { name: 'Other Sizing' })).body;
  // 20 bags of 100 lbs go to sizing with 6 beams
  const y = (await api('post', '/weaving/yarn-inwards', { itemId: item.id, vendorId: supplier.id, bags: 20, lbsPerBag: 100, ratePerLb: 300, inwardDate: '2026-11-01', dcNo: 'DC-1' })).body;
  const beams = [];
  for (let i = 1; i <= 6; i += 1) beams.push((await api('post', '/weaving/beams', { name: `S${i}`, beamDate: '2026-10-01' })).body);
  const challan = (await api('post', '/weaving/yarn-sizing', { vendorId: sizer.id, outwardDate: '2026-11-05', lines: [{ inwardId: y.id, bags: 20 }], beamIds: beams.map((b) => b.id) })).body;
  return { api, viewer: call(viewer), count, item, sizer, sizer2, y, beams, challan, supplier };
}
const stockBags = async (w) => (await w.api('get', '/weaving/yarn-stock')).body.totals.balanceBags;
const beamStock = async (w) => (await w.api('get', '/weaving/beam-stock')).body.statuses.map((s) => s.count);

test('sizing return: some beams / some bags / all / only yarn / only beams; In Pass; stock; locks', async () => {
  const w = await setup();
  expect(await beamStock(w)).toEqual([0, 0, 0, 6]);
  expect(await stockBags(w)).toBe(0);
  const ya = (await w.api('get', `/weaving/sizing-returns/yarn-available?vendorId=${w.sizer.id}`)).body.data;
  expect(ya.map((p) => [p.inwardCode, p.sentLbs, p.availableLbs, p.availableBags])).toEqual([[1, 2000, 2000, 20]]);
  expect((await w.api('get', `/weaving/sizing-returns/yarn-available?vendorId=${w.sizer2.id}`)).body.total).toBe(0);

  // 2 of the 6 beams and 10 of the 20 bags come back: one In Pass
  const r1 = await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, returnDate: '2026-11-12', refNo: 'GP-5', notes: 'not sized', beamIds: [w.beams[0].id, w.beams[1].id], yarns: [{ inwardId: w.y.id, bags: 10 }] });
  expect(r1.status).toBe(201);
  expect(r1.body).toMatchObject({ inPassNo: 1, inPassLabel: '00001', kind: 'BOTH', totalBeams: 2, totalBags: 10, totalLbs: 1000, party: { name: 'Sizing Co' } });
  expect(r1.body.yarns[0]).toMatchObject({ inwardCode: 1, dcNo: 'DC-1', bags: 10, lbsPerBag: 100, lbs: 1000 });
  expect(await beamStock(w)).toEqual([2, 0, 0, 4]); // the 2 beams are empty again
  expect(await stockBags(w)).toBe(10); // the yarn is back in the stock
  expect((await w.api('get', `/weaving/yarn-inwards/${w.y.id}`)).body).toMatchObject({ outwardBags: 10, balanceBags: 10 });
  expect((await w.api('get', `/weaving/sizing-returns/pending-beams?vendorId=${w.sizer.id}`)).body.data.map((b) => b.name)).toEqual(['S3', 'S4', 'S5', 'S6']);
  expect((await w.api('get', `/weaving/sizing-returns/yarn-available?vendorId=${w.sizer.id}`)).body.data[0]).toMatchObject({ returnedLbs: 1000, availableLbs: 1000, availableBags: 10 });

  // too many bags / a beam that is not at the party / nothing
  err(await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, yarns: [{ inwardId: w.y.id, bags: 11 }] }), 422, 'MORE_THAN_AVAILABLE');
  err(await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, beamIds: [w.beams[0].id] }), 422, 'BEAM_NOT_AT_PARTY');
  err(await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer2.id, yarns: [{ inwardId: w.y.id, bags: 1 }] }), 422, 'YARN_NOT_SENT');
  err(await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id }), 422, 'NOTHING_RETURNED');
  err(await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, returnDate: '2026-11-01', beamIds: [w.beams[2].id] }), 422, 'BEFORE_OUTWARD');

  // yarn tagged to a sizing batch cannot come back; the batch's receipts and the returns share the In Pass numbers
  const batch = (await w.api('post', '/sizing/batches', { vendorId: w.sizer.id, setNo: '1', ends: 100, yarnCountId: w.count.id, yarns: [{ inwardId: w.y.id, lbs: 500 }] })).body;
  expect((await w.api('get', `/weaving/sizing-returns/yarn-available?vendorId=${w.sizer.id}`)).body.data[0]).toMatchObject({ taggedLbs: 500, availableLbs: 500, availableBags: 5 });
  err(await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, yarns: [{ inwardId: w.y.id, bags: 6 }] }), 422, 'MORE_THAN_AVAILABLE');
  expect((await w.api('get', `/sizing/yarn-available?vendorId=${w.sizer.id}`)).body.data[0]).toMatchObject({ availableLbs: 500 }); // the batch picker sees the same
  const rc = await w.api('post', `/sizing/batches/${batch.id}/receipts`, { beams: [{ beamId: w.beams[2].id, lengthM: 5000 }] });
  expect(rc.body.inPassNo).toBe(2);
  // only beams
  const r2 = await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, returnDate: '2026-11-14', beamIds: [w.beams[3].id] });
  expect([r2.body.inPassNo, r2.body.kind, r2.body.totalBags]).toEqual([3, 'BEAMS', 0]);
  // only yarn: the 5 bags that are free
  const r3 = await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, yarns: [{ inwardId: w.y.id, bags: 5 }] });
  expect([r3.body.inPassNo, r3.body.kind, r3.body.totalBeams]).toEqual([4, 'YARN', 0]);
  expect(await stockBags(w)).toBe(15);
  expect(await beamStock(w)).toEqual([3, 1, 0, 2]);

  // the sizing challan cannot be deleted while returns / batches use its yarn and beams
  err(await w.api('delete', `/weaving/yarn-sizing/${w.challan.id}`), 422, 'HAS_SIZING_BATCH');
  // the yarn inward cannot be deleted while a return holds its yarn
  err(await w.api('delete', `/weaving/yarn-inwards/${w.y.id}`), 422, 'IN_USE');

  // change a return: 2 beams -> 1 beam, 10 bags -> 8 bags
  const e = await w.api('patch', `/weaving/sizing-returns/${r1.body.id}`, { beamIds: [w.beams[0].id], yarns: [{ inwardId: w.y.id, bags: 8 }] });
  expect([e.status, e.body.totalBeams, e.body.totalBags]).toEqual([200, 1, 8]);
  expect(await stockBags(w)).toBe(13);
  expect((await w.api('get', `/weaving/sizing-returns/pending-beams?vendorId=${w.sizer.id}`)).body.data.map((b) => b.name)).toEqual(['S2', 'S5', 'S6']);

  // yarn that was sent out again after it came back: the return that brought it cannot be deleted
  const weft = await w.api('post', '/weaving/yarn-weft', { outwardDate: '2026-11-20', lines: [{ inwardId: w.y.id, bags: 13 }] });
  expect(weft.status).toBe(201);
  err(await w.api('delete', `/weaving/sizing-returns/${r1.body.id}`), 422, 'YARN_ALREADY_USED');
  await w.api('delete', `/weaving/yarn-weft/${weft.body.id}`);

  // delete: the beams go back to sizing, the yarn leaves the stock again
  expect((await w.api('delete', `/weaving/sizing-returns/${r1.body.id}`)).body.deleted).toBe(true);
  expect(await beamStock(w)).toEqual([1, 1, 0, 4]);
  expect(await stockBags(w)).toBe(5);
  // lists
  const l = (await w.api('get', '/weaving/sizing-returns')).body;
  expect(l.data.map((x) => x.inPassNo)).toEqual([4, 3]);
  expect(l.totals).toMatchObject({ returns: 2, beams: 1, bags: 5, lbs: 500 });
  expect((await w.api('get', '/weaving/sizing-returns?search=00003')).body.total).toBe(1);
  expect((await w.api('get', '/weaving/sizing-returns?search=S4')).body.data.map((x) => x.inPassNo)).toEqual([3]);
  expect((await w.api('get', `/weaving/sizing-returns/${r3.body.id}`)).body.kind).toBe('YARN');

  // the viewer reads, cannot write
  expect((await w.viewer('get', '/weaving/sizing-returns')).body.total).toBe(2);
  expect((await w.viewer('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, beamIds: [w.beams[4].id] })).status).toBe(403);
});

test('record badges: a challan shows what came back (returned), a return shows what went out again (sent again)', async () => {
  const w = await setup();
  const challanA = async () => (await w.api('get', `/weaving/yarn-sizing/${w.challan.id}`)).body;
  const row = async (id) => (await w.api('get', '/weaving/yarn-sizing')).body.data.find((x) => x.id === id);
  const plain = await challanA();
  expect(plain).toMatchObject({ returnedBags: 0, returnedBeams: 0, returnCount: 0, hasReturn: false });
  expect(await row(w.challan.id)).toMatchObject({ hasReturn: false, returnCount: 0 });

  // 2 beams and 10 bags come back (return R)
  const R = (await w.api('post', '/weaving/sizing-returns', { vendorId: w.sizer.id, returnDate: '2026-11-12', beamIds: [w.beams[0].id, w.beams[1].id], yarns: [{ inwardId: w.y.id, bags: 10 }] })).body;
  expect(R).toMatchObject({ sentAgain: false, sentAgainBags: 0, sentAgainBeams: 0, sentAgainChallans: [] });
  const a = await challanA();
  expect(a).toMatchObject({ returnedBags: 10, returnedBeams: 2, returnCount: 1, hasReturn: true });
  expect(a.lines[0].returnedBags).toBe(10);
  expect(a.beams.map((b) => [b.name, b.returned])).toEqual([['S1', true], ['S2', true], ['S3', false], ['S4', false], ['S5', false], ['S6', false]]);
  expect(await row(w.challan.id)).toMatchObject({ returnedBags: 10, returnedBeams: 2, returnCount: 1, hasReturn: true, totalBags: 20, totalBeams: 6 });
  expect((await w.api('get', `/weaving/sizing-returns/${R.id}`)).body.sentAgain).toBe(false);
  expect((await w.api('get', '/weaving/sizing-returns')).body.data[0]).toMatchObject({ sentAgain: false });

  // 1 of those beams and 4 of those bags go out again on a new sizing challan B (any party)
  const B = await w.api('post', '/weaving/yarn-sizing', { vendorId: w.sizer2.id, outwardDate: '2026-11-15', lines: [{ inwardId: w.y.id, bags: 4 }], beamIds: [w.beams[0].id] });
  expect(B.status).toBe(201);
  const r = (await w.api('get', `/weaving/sizing-returns/${R.id}`)).body;
  expect(r).toMatchObject({ sentAgainBeams: 1, sentAgainBags: 4, sentAgain: true });
  expect(r.yarns[0].sentAgainBags).toBe(4);
  expect(r.beams.map((b) => [b.name, b.sentAgain])).toEqual([['S1', true], ['S2', false]]);
  expect(r.sentAgainChallans.map((c) => [c.id, c.challanNo, c.outwardDate])).toEqual([[B.body.id, 2, '2026-11-15']]);
  expect((await w.api('get', '/weaving/sizing-returns')).body.data[0]).toMatchObject({ sentAgainBeams: 1, sentAgainBags: 4, sentAgain: true });
  // challan A still shows its own return only; B shows none
  expect((await challanA())).toMatchObject({ returnedBags: 10, returnedBeams: 2, returnCount: 1 });
  expect(await row(B.body.id)).toMatchObject({ hasReturn: false, returnedBags: 0 });

  // delete B: back to "in stock"; delete R: challan A back to 0
  expect((await w.api('delete', `/weaving/yarn-sizing/${B.body.id}`)).status).toBeLessThan(300);
  expect((await w.api('get', `/weaving/sizing-returns/${R.id}`)).body).toMatchObject({ sentAgain: false, sentAgainBags: 0, sentAgainBeams: 0 });
  expect((await w.api('delete', `/weaving/sizing-returns/${R.id}`)).body.deleted).toBe(true);
  expect(await challanA()).toMatchObject({ returnedBags: 0, returnedBeams: 0, returnCount: 0, hasReturn: false });
});
