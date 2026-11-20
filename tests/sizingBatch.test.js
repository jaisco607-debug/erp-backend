const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(300000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const SERVICES = ['WEAVING_MASTERS', 'SIZING', 'ACC_COA', 'ACC_PURCHASES', 'ACC_PAYMENTS', 'ACC_REPORTS', 'GENERAL_STORE'];

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'SIZING' } })).id, access: 'VIEW' });
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '60/s CTN' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const supplier = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const sizer = (await api('post', '/weaving/vendors', { name: 'Sizing Co' })).body;
  const sizer2 = (await api('post', '/weaving/vendors', { name: 'Other Sizing' })).body;
  const y1 = (await api('post', '/weaving/yarn-inwards', { itemId: item.id, vendorId: supplier.id, bags: 30, lbsPerBag: 100, ratePerLb: 300, inwardDate: '2026-11-01', dcNo: 'DC-1' })).body; // 3000 lbs
  const y2 = (await api('post', '/weaving/yarn-inwards', { itemId: item.id, vendorId: supplier.id, bags: 12, lbsPerBag: 100, ratePerLb: 300, inwardDate: '2026-11-02', dcNo: 'DC-2' })).body; // 1200 lbs
  const beams = [];
  for (let i = 1; i <= 4; i += 1) beams.push((await api('post', '/weaving/beams', { name: `S${i}`, beamDate: '2026-10-01' })).body);
  // 4110 lbs of yarn (3000 + 1110 of the second) and 4 beams go to the sizing party
  const challan = (await api('post', '/weaving/yarn-sizing', { vendorId: sizer.id, outwardDate: '2026-11-05', lines: [{ inwardId: y1.id, bags: 30 }, { inwardId: y2.id, bags: 12 }], beamIds: beams.map((b) => b.id) })).body;
  return { company, api, viewer: call(viewer), count, item, sizer, sizer2, y1, y2, beams, challan };
}

test('sizing batch: yarn tagged, beams + cut cones received, billing, confirm, invoice; locks and deletes', async () => {
  const w = await setup();
  const fd = (await w.api('get', '/sizing/batches/form-data')).body;
  expect(fd).toMatchObject({ adjustmentLimitLbs: 10, defaultConeType: 'CutCone' });
  expect(fd.vendors.map((v) => v.name)).toContain('Sizing Co');
  expect(fd.yarnCounts.map((c) => c.name)).toEqual(['60/s CTN']);

  // the pickers: yarn sent to the party, beams waiting at the party
  const pool = (await w.api('get', `/sizing/yarn-available?vendorId=${w.sizer.id}`)).body.data;
  expect(pool.map((p) => [p.inwardCode, p.sentLbs, p.availableLbs])).toEqual([[2, 1200, 1200], [1, 3000, 3000]]);
  expect((await w.api('get', `/sizing/yarn-available?vendorId=${w.sizer2.id}`)).body.total).toBe(0);
  expect((await w.api('get', `/sizing/pending-beams?vendorId=${w.sizer.id}`)).body.data.map((b) => b.name)).toEqual(['S1', 'S2', 'S3', 'S4']);

  // a batch (draft): the party, the set, ends per beam, the yarn count
  // the quality comes from the Quality master (Weaving > Masters > Quality): add, rename, duplicate, switch off
  const q1 = await w.api('post', '/weaving/qualities', { name: '60X60/90X82=136"CTN' });
  expect([q1.status, q1.body.code, q1.body.name]).toEqual([201, 1, '60X60/90X82=136"CTN']);
  err(await w.api('post', '/weaving/qualities', { name: '60x60/90x82=136"ctn' }), 422, 'DUPLICATE_ENTRY');
  expect((await w.api('get', '/sizing/batches/form-data')).body.qualities.map((x) => x.name)).toEqual(['60X60/90X82=136"CTN']);
  const q2 = (await w.api('post', '/weaving/qualities', { name: 'Spare' })).body;
  const b = await w.api('post', '/sizing/batches', { vendorId: w.sizer.id, batchDate: '2026-11-10', setNo: '12331', ends: 6054, yarnCountId: w.count.id, qualityId: q1.body.id, notes: '6/s ctn (ends 6054)',
    yarns: [{ inwardId: w.y1.id, lbs: 3000 }] });
  expect(b.status).toBe(201);
  expect(b.body).toMatchObject({ batchNo: 1, batchLabel: '00001', status: 'DRAFT', setNo: '12331', ends: 6054, yarnTaggedLbs: 3000, yarnLots: 1, noYarnTagged: false, party: { name: 'Sizing Co' }, canConfirm: false });
  expect(b.body.readiness).toEqual({ notes: true, yarn: true, beams: false, rate: false, weight: true });
  const id = b.body.id;
  expect(b.body).toMatchObject({ qualityId: q1.body.id, quality: '60X60/90X82=136"CTN', qualityMaster: { code: 1 } });
  err(await w.api('patch', '/sizing/batches/' + id, { qualityId: w.y1.id }), 422, 'UNKNOWN_QUALITY');
  expect((await w.api('patch', '/weaving/qualities/' + q1.body.id, { name: '60X60/90X82=136" CTN' })).body.name).toBe('60X60/90X82=136" CTN');
  expect((await w.api('get', '/sizing/batches/' + id)).body.quality).toBe('60X60/90X82=136" CTN');
  err(await w.api('delete', '/weaving/qualities/' + q1.body.id), 422, 'IN_USE');
  await w.api('patch', '/weaving/qualities/' + q2.id, { isActive: false });
  err(await w.api('patch', '/sizing/batches/' + id, { qualityId: q2.id }), 422, 'QUALITY_INACTIVE');
  expect((await w.api('delete', '/weaving/qualities/' + q2.id)).status).toBeLessThan(300);
  err(await w.api('post', `/sizing/batches/${id}/confirm`), 422, 'NOT_READY');
  // yarn: not more than what was sent / what other batches did not take; not sent to this party
  err(await w.api('post', `/sizing/batches/${id}/yarns`, { inwardId: w.y1.id, lbs: 10 }), 422, 'ALREADY_TAGGED');
  err(await w.api('post', `/sizing/batches/${id}/yarns`, { inwardId: w.y2.id, lbs: 1200.5 }), 422, 'MORE_THAN_AVAILABLE');
  const t2 = await w.api('post', `/sizing/batches/${id}/yarns`, { inwardId: w.y2.id, lbs: 1110 });
  expect(t2.status).toBe(201);
  expect(t2.body).toMatchObject({ yarnTaggedLbs: 4110, yarnLots: 2 });
  expect(t2.body.yarns.map((y) => [y.inwardCode, y.dcNo, y.lbs, y.countMismatch])).toEqual([[1, 'DC-1', 3000, false], [2, 'DC-2', 1110, false]]);
  // a second batch sees what is left
  const pool2 = (await w.api('get', `/sizing/yarn-available?vendorId=${w.sizer.id}`)).body.data;
  expect(pool2.map((p) => [p.inwardCode, p.availableLbs])).toEqual([[2, 90]]);

  // first beam receipt (GRN): 4 beams of 5215 m; weights are given
  const r1 = await w.api('post', `/sizing/batches/${id}/receipts`, { receiptDate: '2026-11-16', refNo: 'R-1', notes: '4xbeam', beams: w.beams.slice(0, 2).map((x) => ({ beamId: x.id, lengthM: 5215, weightKg: 100 })), cutCones: [{ kg: 152, cones: 11, bags: 6 }] });
  expect(r1.status).toBe(201);
  expect(r1.body).toMatchObject({ receiptNo: 1, receiptLabel: '00001', totalBeams: 2, lengthM: 10430, coneKg: 152, coneLbs: 335.1, batch: { batchNo: 1, setNo: '12331' } });
  expect(r1.body.cutCones[0]).toMatchObject({ type: 'CutCone', kg: 152, lbs: 335.1, cones: 11, bags: 6 });
  // the beams are FULL now with their length, the others still at sizing
  const stock = (await w.api('get', '/weaving/beam-stock')).body.statuses.map((s) => s.count);
  expect(stock).toEqual([0, 2, 0, 2]);
  expect((await w.api('get', `/sizing/pending-beams?vendorId=${w.sizer.id}`)).body.data.map((x) => x.name)).toEqual(['S3', 'S4']);
  const r2 = await w.api('post', `/sizing/batches/${id}/receipts`, { receiptDate: '2026-11-18', beams: w.beams.slice(2).map((x) => ({ beamId: x.id, lengthM: 10430 })) });
  expect(r2.body).toMatchObject({ receiptNo: 2, lengthM: 20860 });
  err(await w.api('post', `/sizing/batches/${id}/receipts`, { beams: [{ beamId: w.beams[0].id, lengthM: 1 }] }), 422, 'BEAM_NOT_AT_PARTY'); // already received
  err(await w.api('post', `/sizing/batches/${id}/receipts`, {}), 422, 'NOTHING_RECEIVED');

  // billing: warp wt = yarn - cut cones; adjustment +-10; net; rate; amount; actual count
  let d = (await w.api('get', `/sizing/batches/${id}`)).body;
  expect(d.billing).toMatchObject({ yarnIssuedLbs: 4110, coneKg: 152, coneLbs: 335.1, warpWt: 3774.9, adjustmentLbs: 0, netWarpWt: 3774.9, ratePerLb: null, amount: 0 });
  expect(d).toMatchObject({ warpLengthM: 31290, beamCount: 4, warpWeightLbs: 3774.9, actualCount: 65.3, nominalCount: 60, countWarning: false });
  expect(d.beams.map((x) => [x.name, x.grnNo, x.lengthM, x.statusText])).toEqual([['S1', 1, 5215, 'Full'], ['S2', 1, 5215, 'Full'], ['S3', 2, 10430, 'Full'], ['S4', 2, 10430, 'Full']]);
  expect((await w.api('patch', `/sizing/batches/${id}`, { adjustmentLbs: 11 })).status).toBe(400);
  d = (await w.api('patch', `/sizing/batches/${id}`, { adjustmentLbs: -4.9, ratePerLb: 12.5 })).body;
  expect(d.billing).toMatchObject({ adjustmentLbs: -4.9, netWarpWt: 3770, ratePerLb: 12.5, amount: 47125 });
  expect(d).toMatchObject({ canConfirm: true, readiness: { notes: true, yarn: true, beams: true, rate: true, weight: true } });
  // an invoice cannot be made from a draft
  err(await w.api('post', '/purchase-invoices', { vendorId: w.sizer.id, sizingBatchIds: [id] }), 422, 'BATCH_NOT_CONFIRMED');
  expect((await w.api('get', `/purchase-invoices/sizing-batches?vendorId=${w.sizer.id}`)).body.total).toBe(0);

  // confirm = approve: locked
  const c = await w.api('post', `/sizing/batches/${id}/confirm`);
  expect(c.body).toMatchObject({ status: 'CONFIRMED', statusText: 'Confirmed', canEdit: false, canReopen: true, canInvoice: true });
  err(await w.api('patch', `/sizing/batches/${id}`, { notes: 'x' }), 422, 'BATCH_CONFIRMED');
  err(await w.api('delete', `/sizing/receipts/${r1.body.id}`), 422, 'BATCH_CONFIRMED');
  err(await w.api('post', `/sizing/batches/${id}/yarns`, { inwardId: w.y2.id, lbs: 1 }), 422, 'BATCH_CONFIRMED');
  // the sizing challan cannot be deleted while its yarn / beams are in a batch
  err(await w.api('delete', `/weaving/yarn-sizing/${w.challan.id}`), 422, 'HAS_SIZING_BATCH');

  // accounts: the confirmed batch goes on a purchase invoice
  const pick = (await w.api('get', `/purchase-invoices/sizing-batches?vendorId=${w.sizer.id}`)).body;
  expect(pick.data.map((p) => [p.batchNo, p.setNo, p.netWarpWt, p.amount, p.canBill])).toEqual([[1, '12331', 3770, 47125, true]]);
  const inv = await w.api('post', '/purchase-invoices', { vendorId: w.sizer.id, sizingBatchIds: [id], taxRate: 18, invoiceDate: '2026-11-20' });
  expect(inv.status).toBe(201);
  expect(inv.body).toMatchObject({ kind: 'SIZING_BATCH', kindText: 'Sizing Batch', status: 'UNAPPROVED', gross: 47125, tax: 8482.5, net: 55607.5, inwardCount: 1 });
  expect(inv.body.lines[0]).toMatchObject({ batchNo: 1, setNo: '12331', netWarpWt: 3770, ratePerLb: 12.5, amount: 47125 });
  d = (await w.api('get', `/sizing/batches/${id}`)).body;
  expect(d).toMatchObject({ invoiced: true, billedAmount: 47125, canReopen: false, canInvoice: false, purchaseInvoice: { voucherNo: 1, status: 'UNAPPROVED' } });
  err(await w.api('post', `/sizing/batches/${id}/reopen`), 422, 'ON_PURCHASE_INVOICE');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.sizer.id, sizingBatchIds: [id] }), 422, 'BATCH_TAKEN');
  expect((await w.api('post', `/purchase-invoices/${inv.body.id}/approve`)).body.status).toBe('APPROVED');
  await w.api('post', `/purchase-invoices/${inv.body.id}/unapprove`, {});
  expect((await w.api('delete', `/purchase-invoices/${inv.body.id}`)).status).toBeLessThan(300);

  // reopen -> draft again: a receipt can be changed (beams go back to sizing and come in again) or deleted
  expect((await w.api('post', `/sizing/batches/${id}/reopen`)).body).toMatchObject({ status: 'DRAFT', canEdit: true });
  const e = await w.api('patch', `/sizing/receipts/${r2.body.id}`, { beams: [{ beamId: w.beams[2].id, lengthM: 4000 }] });
  expect([e.status, e.body.totalBeams, e.body.lengthM]).toEqual([200, 1, 4000]);
  expect((await w.api('get', `/sizing/pending-beams?vendorId=${w.sizer.id}`)).body.data.map((x) => x.name)).toEqual(['S4']);
  expect((await w.api('delete', `/sizing/receipts/${r2.body.id}`)).body.deleted).toBe(true);
  expect((await w.api('get', '/weaving/beam-stock')).body.statuses.map((s) => s.count)).toEqual([0, 2, 0, 2]);
  expect((await w.api('get', `/sizing/batches/${id}`)).body).toMatchObject({ warpLengthM: 10430, beamCount: 2 });

  // lists
  const l = (await w.api('get', '/sizing/batches')).body;
  expect(l).toMatchObject({ total: 1, counts: { all: 1, drafts: 1, confirmed: 0, withoutYarn: 0 } });
  const rl = (await w.api('get', '/sizing/receipts')).body;
  expect(rl.data.map((x) => [x.receiptNo, x.batch.setNo, x.beams, x.lengthM, x.coneKg])).toEqual([[1, '12331', 2, 10430, 152]]);
  expect((await w.api('get', '/sizing/batches?search=12331')).body.total).toBe(1);
  expect((await w.api('get', '/sizing/batches?status=CONFIRMED')).body).toMatchObject({ total: 0, counts: { drafts: 1 } });
  expect((await w.api('get', `/sizing/receipts?batchId=${id}`)).body.total).toBe(1);

  // delete: not with receipts; untag yarn; an empty batch goes
  err(await w.api('delete', `/sizing/batches/${id}`), 422, 'HAS_RECEIPTS');
  const b2 = (await w.api('post', '/sizing/batches', { vendorId: w.sizer.id, setNo: '9', ends: 100, yarnCountId: w.count.id })).body;
  expect(b2).toMatchObject({ batchNo: 2, noYarnTagged: true });
  expect((await w.api('get', '/sizing/batches?withoutYarn=true')).body.total).toBe(1);
  expect((await w.api('delete', `/sizing/batches/${b2.id}`)).body.deleted).toBe(true);
  const untag = await w.api('delete', `/sizing/batches/${id}/yarns/${t2.body.yarns[1].id}`);
  expect(untag.body).toMatchObject({ yarnTaggedLbs: 3000, yarnLots: 1 });
  expect((await w.api('get', `/sizing/yarn-available?vendorId=${w.sizer.id}`)).body.data.map((p) => [p.inwardCode, p.availableLbs])).toEqual([[2, 1110 + 90]]);

  // every receipt is an In Pass: its number is on the receipt, on its beams and on its cut cones (also a cut-cones-only receipt)
  const cOnly = await w.api('post', `/sizing/batches/${id}/receipts`, { receiptDate: '2026-11-19', cutCones: [{ kg: 10, cones: 2, bags: 1 }] });
  expect([cOnly.status, cOnly.body.inPassNo, cOnly.body.inPassLabel, cOnly.body.totalBeams]).toEqual([201, 3, '00003', 0]);
  const dd = (await w.api('get', `/sizing/batches/${id}`)).body;
  expect(dd.beams.map((x) => [x.name, x.inPassNo])).toEqual([['S1', 1], ['S2', 1]]);
  expect(dd.cutCones.map((x) => [x.inPassNo, x.kg])).toEqual([[1, 152], [3, 10]]);
  expect((await w.api('get', '/sizing/receipts?search=00003')).body.data.map((x) => x.inPassNo)).toEqual([3]);
  // beam weight is optional on a receipt
  expect((await w.api('post', `/sizing/batches/${id}/receipts`, { beams: [{ beamId: w.beams[2].id, lengthM: 4000 }] })).status).toBe(201);

  // an overhead contract (the customer's) is tagged to the batch; only the customer's yarn is offered then
  const cust = (await w.api('post', '/weaving/customers', { name: 'Al Rahim Textiles' })).body;
  const oc = (await w.api('post', '/weaving/yarn-contracts', { kind: 'OVERHEAD', customerId: cust.id, taxPercent: 0, lines: [{ yarnCountId: w.count.id, lbs: 5000 }] })).body;
  const pickC = (await w.api('get', `/sizing/overhead-contracts?customerId=${cust.id}`)).body;
  expect(pickC.data.map((x) => [x.id, x.codeLabel, x.customer.name, x.goods])).toEqual([[oc.id, '0001', 'Al Rahim Textiles', '60/s CTN']]);
  err(await w.api('patch', `/sizing/batches/${id}`, { contractId: w.y1.id }), 422, 'UNKNOWN_CONTRACT');
  const pc = (await w.api('post', '/weaving/yarn-contracts', { kind: 'PURCHASE', vendorId: w.sizer.id, lines: [{ yarnCountId: w.count.id, lbs: 1, ratePerLb: 1 }] })).body;
  err(await w.api('patch', `/sizing/batches/${id}`, { contractId: pc.id }), 422, 'UNKNOWN_CONTRACT'); // a purchase contract is not an overhead one
  const tagged = (await w.api('patch', `/sizing/batches/${id}`, { contractId: oc.id })).body;
  expect(tagged).toMatchObject({ contractId: oc.id, contract: { codeLabel: '0001', customer: { name: 'Al Rahim Textiles' } }, onAccount: { name: 'Al Rahim Textiles' } });
  expect((await w.api('get', `/sizing/batches?contractId=${oc.id}`)).body.total).toBe(1);
  expect((await w.api('get', `/sizing/batches?customerId=${cust.id}`)).body.total).toBe(1);
  expect((await w.api('get', '/sizing/batches?search=Rahim')).body.total).toBe(1);
  expect((await w.api('get', `/sizing/yarn-available?vendorId=${w.sizer.id}&batchId=${id}&contractId=${oc.id}`)).body.total).toBe(0); // none of the sent yarn is on that contract
  err(await w.api('delete', `/weaving/yarn-contracts/${oc.id}`), 422, 'IN_USE');
  expect((await w.api('patch', `/sizing/batches/${id}`, { contractId: null })).body.contract).toBeNull();

  // the viewer reads, cannot write; no SIZING service = no access
  expect((await w.viewer('get', '/sizing/batches')).body.total).toBe(1);
  expect((await w.viewer('post', '/sizing/batches', { vendorId: w.sizer.id, setNo: '1', ends: 1, yarnCountId: w.count.id })).status).toBe(403);
});
