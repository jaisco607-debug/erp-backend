const { app, request, clean, makeUser, makeCompany, loginAs, raceTwice } = require('./helpers');
const { Service, CompanyService, UserService, Quality } = require('../src/models');
const { today } = require('../src/utils/dates');

jest.setTimeout(240000);
beforeEach(clean);

// owner plan N-D1: purchase orders of the store and the goods received against them (optional: a purchase without an order works as before)
const SERVICES = ['CHEMICAL_STORE', 'GENERAL_STORE', 'YARN_STORE', 'FABRIC_STORE', 'ACC_PURCHASES'];
async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of SERVICES) { s[code] = await Service.findOne({ where: { code } }); await CompanyService.create({ companyId: company.id, serviceId: s[code].id }); }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const person = async (grants) => { const u = await makeUser({ userType: 'USER', companyId: company.id }); for (const [code, access] of grants) await UserService.create({ userId: u.id, serviceId: s[code].id, access }); return u; };
  const as = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  return { company, api: as(admin), keeper: as(await person([['CHEMICAL_STORE', 'FULL']])), reader: as(await person([['CHEMICAL_STORE', 'VIEW']])) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 400)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };

async function chemical(w) {
  const vendor = await ok(w.api('post', '/vendors', { name: 'NEXUS' }), 201);
  const other = await ok(w.api('post', '/vendors', { name: 'OTHER VENDOR' }), 201);
  const soda = await ok(w.api('post', '/stores/chemical/items', { name: 'Caustic Soda', unit: 'KG' }), 201);
  const acid = await ok(w.api('post', '/stores/chemical/items', { name: 'Acetic Acid', unit: 'KG' }), 201);
  return { vendor, other, soda, acid };
}
const makePo = async (w, body) => ok(w.api('post', '/purchase-orders', { store: 'CHEMICAL', ...body }), 201);
const approved = async (w, body) => { const po = await makePo(w, body); return ok(w.api('post', `/purchase-orders/${po.id}/approve`)); };
const inward = (w, vendorId, lines, extra = {}) => w.api('post', '/stores/chemical/inwards', { inwardDate: today(), vendorId, lines, ...extra });

test('a purchase without a PO works exactly as before', async () => {
  const w = await setup();
  const c = await chemical(w);
  const e = await ok(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 10, rate: 90 }], { approve: true }), 201);
  expect(e.lines[0]).not.toHaveProperty('poLineId');
  expect(e.lines[0]).not.toHaveProperty('po');
  expect((await ok(w.api('get', `/stores/chemical/items/${c.soda.id}`))).stockQty).toBe(10);
});

test('the order: draft, client admin approves, goods are received in parts within 5 %, the rate comes from the order, another rate needs a note', async () => {
  const w = await setup();
  const c = await chemical(w);
  // the store keeper makes a draft; he cannot approve; the client admin can
  const draft = await ok(w.keeper('post', '/purchase-orders', { store: 'chemical', vendorId: c.vendor.id, expectedDate: today(), lines: [{ itemId: c.soda.id, qty: 500, rate: 100 }] }), 201);
  expect(draft).toMatchObject({ poNo: 1, label: 'PO-00001', status: 'DRAFT', amount: 50000, tolerancePercent: 5, canApprove: true, lines: [{ unit: 'KG', qty: 500, rate: 100, received: 0, waiting: 0, balance: 500, canReceive: 525 }] });
  const lineId = draft.lines[0].id;
  expect((await w.keeper('post', `/purchase-orders/${draft.id}/approve`)).status).toBe(403);
  await fails(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 10, poLineId: lineId }]), 422, 'PO_NOT_OPEN'); // a draft cannot be received
  await ok(w.api('post', `/purchase-orders/${draft.id}/approve`));
  await fails(w.api('post', `/purchase-orders/${draft.id}/approve`), 422, 'PO_NOT_DRAFT');
  await fails(w.api('patch', `/purchase-orders/${draft.id}`, { notes: 'x' }), 422, 'PO_NOT_DRAFT');

  // "Pick from open PO"
  const open = await ok(w.api('get', `/purchase-orders/open-lines?store=chemical&vendorId=${c.vendor.id}`));
  expect(open.data).toHaveLength(1);
  expect(open.data[0]).toMatchObject({ poLineId: lineId, label: 'PO-00001', description: 'Caustic Soda', ordered: 500, balance: 500, canReceive: 525, rate: 100 });

  // the wrong vendor, item or store is refused
  await fails(inward(w, c.other.id, [{ itemId: c.soda.id, qty: 10, poLineId: lineId }]), 422, 'PO_VENDOR_MISMATCH');
  await fails(inward(w, c.vendor.id, [{ itemId: c.acid.id, qty: 10, poLineId: lineId }]), 422, 'PO_ITEM_MISMATCH');
  await fails(w.api('post', '/stores/general/inwards', { inwardDate: today(), vendorId: c.vendor.id, lines: [{ itemName: 'Spanner', qty: 1, poLineId: lineId }] }), 422, 'PO_WRONG_STORE');
  await fails(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 10, poLineId: '11111111-1111-4111-8111-111111111111' }]), 422, 'PO_LINE_NOT_FOUND');

  // first part: 300 kg, no rate typed: the rate of the order
  const one = await ok(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 300, poLineId: lineId }]), 201);
  expect(one.lines[0]).toMatchObject({ rate: 100, amount: 30000, poLineId: lineId, po: { label: 'PO-00001', ordered: 500 } });
  let po = await ok(w.api('get', `/purchase-orders/${draft.id}`));
  expect(po).toMatchObject({ status: 'APPROVED', lines: [{ received: 0, waiting: 300, balance: 200, canReceive: 225 }] }); // waiting for approval
  await ok(w.api('post', `/stores/chemical/inwards/${one.id}/approve`));
  po = await ok(w.api('get', `/purchase-orders/${draft.id}`));
  expect(po).toMatchObject({ status: 'PARTLY_RECEIVED', receivedPercent: 60, canCancel: false, lines: [{ received: 300, waiting: 0, balance: 200 }] });
  expect(po.receipts).toMatchObject([{ type: 'STORE', qty: 300, approved: true, rate: 100 }]);
  expect((await ok(w.api('get', `/stores/chemical/items/${c.soda.id}`))).stockQty).toBe(300); // the stock moves as always

  // more than the order plus 5 % is refused with a clear message
  const over = await fails(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 226, poLineId: lineId }]), 422, 'PO_OVER_RECEIVED');
  expect(over.details).toMatchObject({ ordered: 500, received: 300, canReceive: 225, tolerancePercent: 5 });
  // two lines of the same entry on one order line are added up
  await fails(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 120, poLineId: lineId }, { itemId: c.soda.id, qty: 120, poLineId: lineId }]), 422, 'PO_OVER_RECEIVED');
  // another rate needs a note
  await fails(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 100, rate: 110, poLineId: lineId }]), 422, 'PO_RATE_NOTE_REQUIRED');
  const two = await ok(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 225, rate: 110, poLineId: lineId, poRateNote: 'Vendor raised the price' }], { approve: true }), 201);
  expect(two.lines[0].poRateNote).toBe('Vendor raised the price');
  po = await ok(w.api('get', `/purchase-orders/${draft.id}`));
  expect(po).toMatchObject({ status: 'RECEIVED', receivedPercent: 100, canReceive: false, lines: [{ received: 525, balance: 0, canReceive: 0 }] });
  expect((await ok(w.api('get', '/purchase-orders/open-lines?store=chemical'))).data).toHaveLength(0);
  expect((await ok(w.api('get', '/purchase-orders?status=RECEIVED'))).total).toBe(1);
  await fails(w.api('post', `/purchase-orders/${draft.id}/cancel`, { reason: 'not needed' }), 422, 'PO_HAS_RECEIPTS');

  // the price difference report: 10 more per kg on 225 kg
  const diff = await ok(w.api('get', '/reports/po-price-difference'));
  expect(diff.sections[0].rows).toMatchObject([{ poLabel: 'PO-00001', item: 'Caustic Soda', orderRate: 100, paidRate: 110, difference: 10, differenceAmount: 2250, note: 'Vendor raised the price' }]);
  const all = await ok(w.api('get', '/reports/po-status?tab=all'));
  expect(all.sections[0].rows).toMatchObject([{ ordered: 500, received: 525, balance: 0, statusText: 'Received' }]);
  expect((await ok(w.api('get', '/reports/po-status'))).sections[0].rows).toHaveLength(0); // nothing open
});

test('editing, deleting and correcting a linked purchase keeps the order right', async () => {
  const w = await setup();
  const c = await chemical(w);
  const po = await approved(w, { vendorId: c.vendor.id, lines: [{ itemId: c.soda.id, qty: 100, rate: 50 }] });
  const lineId = po.lines[0].id;
  const e = await ok(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 60, poLineId: lineId }]), 201);
  // saved again without poLineId (an older screen): the link stays; its own quantity is not counted twice
  const edited = await ok(w.api('patch', `/stores/chemical/inwards/${e.id}`, { lines: [{ itemId: c.soda.id, qty: 104, rate: 50 }] }));
  expect(edited.lines[0]).toMatchObject({ qty: 104, poLineId: lineId });
  await fails(w.api('patch', `/stores/chemical/inwards/${e.id}`, { lines: [{ itemId: c.soda.id, qty: 106, rate: 50 }] }), 422, 'PO_OVER_RECEIVED');
  await fails(w.api('patch', `/stores/chemical/inwards/${e.id}`, { vendorId: c.other.id }), 422, 'PO_VENDOR_MISMATCH');
  // taken off the order on purpose (null)
  const off = await ok(w.api('patch', `/stores/chemical/inwards/${e.id}`, { lines: [{ itemId: c.soda.id, qty: 500, rate: 50, poLineId: null }] }));
  expect(off.lines[0]).not.toHaveProperty('poLineId');
  expect((await ok(w.api('get', `/purchase-orders/${po.id}`))).lines[0]).toMatchObject({ waiting: 0, balance: 100 });
  // deleting a linked draft frees the quantity
  const two = await ok(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 100, poLineId: lineId }]), 201);
  await ok(w.api('delete', `/stores/chemical/inwards/${two.id}`), 204);
  expect((await ok(w.api('get', `/purchase-orders/${po.id}`))).lines[0]).toMatchObject({ balance: 100 });
  // correcting an approved purchase follows the same tolerance
  const three = await ok(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 80, poLineId: lineId }], { approve: true }), 201);
  const fix = (qty) => w.api('post', `/stores/chemical/inwards/${three.id}/correct`, { reason: 'weighed again', lines: [{ lineId: three.lines[0].id, itemId: c.soda.id, qty, rate: 50 }] });
  const bad = await fix(106);
  expect([bad.status, bad.body.error.code]).toEqual([422, 'PO_OVER_RECEIVED']);
  const good = await ok(fix(105));
  expect(good.lines[0]).toMatchObject({ qty: 105, poLineId: lineId });
  expect((await ok(w.api('get', `/purchase-orders/${po.id}`))).lines[0]).toMatchObject({ received: 105, balance: 0 });
});

test('two receipts at the same moment cannot both take the last quantity', async () => {
  const w = await setup();
  const c = await chemical(w);
  const po = await approved(w, { vendorId: c.vendor.id, lines: [{ itemId: c.soda.id, qty: 500, rate: 100 }] });
  const answers = await raceTwice(() => inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 300, poLineId: po.lines[0].id }], { approve: true }));
  expect(answers.map((r) => r.status).sort()).toEqual([201, 422]);
  expect(answers.find((r) => r.status === 422).body.error.code).toBe('PO_OVER_RECEIVED');
  expect((await ok(w.api('get', `/purchase-orders/${po.id}`))).lines[0]).toMatchObject({ received: 300, balance: 200 });
});

test('cancel, close, delete, the tolerance setting, checks, rights and the other company', async () => {
  const w = await setup();
  const other = await setup();
  const c = await chemical(w);
  // checks of the order
  await fails(w.api('post', '/purchase-orders', { store: 'CHEMICAL', vendorId: c.vendor.id, lines: [{ itemId: c.soda.id, qty: 5, rate: 1 }, { itemId: c.soda.id, qty: 5, rate: 1 }] }), 422, 'DUPLICATE_LINE');
  await fails(w.api('post', '/purchase-orders', { store: 'CHEMICAL', vendorId: c.vendor.id, lines: [{ itemId: c.soda.id, qty: 5 }] }), 400, 'VALIDATION_FAILED'); // the rate is required
  await fails(w.api('post', '/purchase-orders', { store: 'YARN', vendorId: c.vendor.id, lines: [{ qty: 5, rate: 1 }] }), 422, 'YARN_REQUIRED');
  await fails(w.api('post', '/purchase-orders', { store: 'CHEMICAL', vendorId: c.vendor.id, poDate: today(), expectedDate: '2026-01-01', lines: [{ itemId: c.soda.id, qty: 5, rate: 1 }] }), 422, 'EXPECTED_BEFORE_PO');

  // a draft can be changed and deleted; its number is not used again
  const d = await makePo(w, { vendorId: c.vendor.id, lines: [{ itemId: c.soda.id, qty: 5, rate: 1 }] });
  expect((await ok(w.api('patch', `/purchase-orders/${d.id}`, { lines: [{ itemId: c.acid.id, qty: 7, rate: 2 }] }))).lines[0]).toMatchObject({ description: 'Acetic Acid', qty: 7 });
  await ok(w.api('delete', `/purchase-orders/${d.id}`), 204);
  // cancel while nothing was received; a cancelled one cannot be received
  const x = await approved(w, { vendorId: c.vendor.id, lines: [{ itemId: c.soda.id, qty: 100, rate: 10 }] });
  expect(x.poNo).toBe(2);
  await fails(w.api('post', `/purchase-orders/${x.id}/cancel`, {}), 400, 'VALIDATION_FAILED');
  expect(await ok(w.api('post', `/purchase-orders/${x.id}/cancel`, { reason: 'ordered twice' }))).toMatchObject({ status: 'CANCELLED', cancelled: { reason: 'ordered twice' } });
  await fails(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 1, poLineId: x.lines[0].id }]), 422, 'PO_NOT_OPEN');
  // close by hand: no new goods, but an entry already on it can still be saved with the same or less
  const y = await approved(w, { vendorId: c.vendor.id, lines: [{ itemId: c.soda.id, qty: 100, rate: 10 }] });
  const e = await ok(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 40, poLineId: y.lines[0].id }]), 201);
  expect(await ok(w.api('post', `/purchase-orders/${y.id}/close`, { reason: 'vendor cannot send more' }))).toMatchObject({ status: 'CLOSED' });
  await fails(inward(w, c.vendor.id, [{ itemId: c.soda.id, qty: 1, poLineId: y.lines[0].id }]), 422, 'PO_NOT_OPEN');
  await ok(w.api('patch', `/stores/chemical/inwards/${e.id}`, { notes: 'x', lines: [{ itemId: c.soda.id, qty: 40, rate: 10 }] }));
  await fails(w.api('patch', `/stores/chemical/inwards/${e.id}`, { lines: [{ itemId: c.soda.id, qty: 41, rate: 10 }] }), 422, 'PO_NOT_OPEN');

  // the tolerance: client admin only; 0 means not one gram more
  expect((await w.keeper('put', '/purchase-orders/settings', { tolerancePercent: 50 })).status).toBe(403);
  expect(await ok(w.api('put', '/purchase-orders/settings', { tolerancePercent: 0 }))).toMatchObject({ tolerancePercent: 0, standard: 5 });
  const z = await approved(w, { vendorId: c.vendor.id, lines: [{ itemId: c.acid.id, qty: 10, rate: 5 }] });
  await fails(inward(w, c.vendor.id, [{ itemId: c.acid.id, qty: 10.001, poLineId: z.lines[0].id }]), 422, 'PO_OVER_RECEIVED');
  await ok(inward(w, c.vendor.id, [{ itemId: c.acid.id, qty: 10, poLineId: z.lines[0].id }]), 201);

  // rights: VIEW reads only; a chemical person has no yarn orders
  await ok(w.reader('get', '/purchase-orders'));
  expect((await w.reader('post', '/purchase-orders', { store: 'CHEMICAL', vendorId: c.vendor.id, lines: [{ itemId: c.soda.id, qty: 1, rate: 1 }] })).status).toBe(403);
  expect((await w.keeper('post', '/purchase-orders', { store: 'YARN', vendorId: c.vendor.id, lines: [{ yarnName: '30/1', qty: 1, rate: 1 }] })).status).toBe(403);
  expect((await w.keeper('get', '/purchase-orders/open-lines?store=fabric')).status).toBe(403);
  // another company sees and uses nothing
  expect((await ok(other.api('get', '/purchase-orders'))).total).toBe(0);
  for (const p of [other.api('get', `/purchase-orders/${z.id}`), other.api('post', `/purchase-orders/${z.id}/close`, {}), other.api('post', `/purchase-orders/${z.id}/cancel`, { reason: 'steal' })]) await fails(p, 404, 'NOT_FOUND');
  const oc = await chemical(other);
  await fails(inward(other, oc.vendor.id, [{ itemId: oc.soda.id, qty: 1, poLineId: z.lines[0].id }]), 422, 'PO_LINE_NOT_FOUND');
  await fails(other.api('post', '/purchase-orders', { store: 'CHEMICAL', vendorId: c.vendor.id, lines: [{ itemId: oc.soda.id, qty: 1, rate: 1 }] }), 422, 'UNKNOWN_VENDOR');
  expect((await ok(w.api('get', '/reports'))).reports.map((r) => r.key)).toEqual(expect.arrayContaining(['po-status', 'po-price-difference']));
});

test('yarn and fabric orders: the yarn / quality must match, the rate comes from the order, tolerance and notes apply', async () => {
  const w = await setup();
  const vendor = await ok(w.api('post', '/vendors', { name: 'SPINNERS' }), 201);
  // ---- yarn, ordered in lbs ----
  const yp = await ok(w.api('post', '/purchase-orders', { store: 'YARN', vendorId: vendor.id, lines: [{ yarnName: '30/1 Cotton', brand: 'Crescent', qty: 1000, rate: 250 }] }), 201);
  await ok(w.api('post', `/purchase-orders/${yp.id}/approve`));
  const yl = yp.lines[0].id;
  const yarn = (body) => w.api('post', '/store-yarn-inwards', { inwardDate: today(), vendorId: vendor.id, yarnName: '30/1  cotton', brand: 'Crescent', bags: 6, lbsPerBag: 100, poLineId: yl, ...body });
  await fails(yarn({ yarnName: '40/1 Cotton' }), 422, 'PO_ITEM_MISMATCH');
  await fails(yarn({ ratePerLb: 260 }), 422, 'PO_RATE_NOTE_REQUIRED');
  const y1 = await ok(yarn({}), 201);
  expect(y1).toMatchObject({ ratePerLb: 250, amount: 150000, poLineId: yl, po: { label: 'PO-00001' } });
  await fails(yarn({ bags: 5 }), 422, 'PO_OVER_RECEIVED'); // 600 + 500 > 1050
  await ok(yarn({ bags: 4, ratePerLb: 260, poRateNote: 'new price' }), 201);
  await fails(w.api('patch', `/store-yarn-inwards/${y1.id}`, { bags: 7 }), 422, 'PO_OVER_RECEIVED');
  expect((await ok(w.api('patch', `/store-yarn-inwards/${y1.id}`, { remarks: 'ok' }))).poLineId).toBe(yl);
  await ok(w.api('post', `/store-yarn-inwards/${y1.id}/approve`));
  expect((await ok(w.api('get', `/purchase-orders/${yp.id}`))).lines[0]).toMatchObject({ received: 600, waiting: 400, balance: 0 });
  // a yarn purchase without an order is as before
  const free = await ok(w.api('post', '/store-yarn-inwards', { inwardDate: today(), vendorId: vendor.id, yarnName: 'Any yarn', bags: 1, lbsPerBag: 50 }), 201);
  expect(free).not.toHaveProperty('poLineId');
  expect(free.ratePerLb).toBeNull();

  // ---- fabric, ordered in meters ----
  const quality = await Quality.create({ companyId: w.company.id, name: 'GREY TWILL' });
  const wrong = await Quality.create({ companyId: w.company.id, name: 'OTHER CLOTH' });
  const fp = await ok(w.api('post', '/purchase-orders', { store: 'FABRIC', vendorId: vendor.id, lines: [{ qualityId: quality.id, unit: 'METER', qty: 200, rate: 120 }] }), 201);
  await ok(w.api('post', `/purchase-orders/${fp.id}/approve`));
  const fl = fp.lines[0].id;
  const fabric = (body) => w.api('post', '/fabric-inwards', { inwardDate: today(), vendorId: vendor.id, qualityId: quality.id, thaans: [100, 50], poLineId: fl, ...body });
  await fails(fabric({ qualityId: wrong.id }), 422, 'PO_ITEM_MISMATCH');
  await fails(fabric({ rate: 130 }), 422, 'PO_RATE_NOTE_REQUIRED');
  const f1 = await ok(fabric({}), 201);
  expect(f1).toMatchObject({ rate: 120, rateUnit: 'METER', poLineId: fl, po: { label: 'PO-00002' } });
  await fails(fabric({ thaans: [61] }), 422, 'PO_OVER_RECEIVED'); // 150 + 61 > 210
  await fails(w.api('patch', `/fabric-inwards/${f1.id}`, { thaans: [200, 11] }), 422, 'PO_OVER_RECEIVED');
  await ok(w.api('patch', `/fabric-inwards/${f1.id}`, { thaans: [150, 60] }));
  await ok(w.api('post', `/fabric-inwards/${f1.id}/approve`));
  expect(await ok(w.api('get', `/purchase-orders/${fp.id}`))).toMatchObject({ status: 'RECEIVED' });
  // deleting the order link frees it; a fabric purchase without an order is as before
  const plain = await ok(w.api('post', '/fabric-inwards', { inwardDate: today(), vendorId: vendor.id, qualityId: quality.id, thaans: [10] }), 201);
  expect(plain).not.toHaveProperty('poLineId');
});

test('low stock and purchase orders: what is on the way, how much to order, and "Create PO"', async () => {
  const w = await setup();
  const c = await chemical(w);
  await ok(inward(w, c.vendor.id, [{ itemId: c.acid.id, qty: 40, rate: 200 }], { approve: true }), 201);
  await ok(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: c.acid.id, limit: 50 }, { itemId: c.soda.id, limit: 100, orderQty: 500 }] }));
  const stock = async () => Object.fromEntries((await ok(w.api('get', '/stores/chemical/stock'))).data.map((i) => [i.name, i]));
  let s = await stock();
  // the acid: 40 of a limit of 50 -> up to twice the limit = 60; the soda (0 in stock) has a usual order quantity of 500
  expect(s['Acetic Acid']).toMatchObject({ onOrder: 0, suggestedOrderQty: 60, warning: { suggestedOrderQty: 60, canCreatePo: true, onOrder: 0 } });
  expect(s['Caustic Soda']).toMatchObject({ orderQty: 500, suggestedOrderQty: 500 });
  const sug = await ok(w.api('get', '/stores/chemical/stock-limits/po-suggestion'));
  expect(sug.groups.map((g) => [g.vendor && g.vendor.name, g.lines.map((l) => [l.name, l.qty, l.rate])])).toEqual(expect.arrayContaining([['NEXUS', [['Acetic Acid', 60, 200]]], [null, [['Caustic Soda', 500, null]]]]));
  // only the chosen ones
  expect((await ok(w.api('get', `/stores/chemical/stock-limits/po-suggestion?itemIds=${c.acid.id}`))).groups).toHaveLength(1);
  // the order is made from the suggestion and approved: it is now "on the way" and no second one is offered
  const g = sug.groups.find((x) => x.vendor);
  const po = await makePo(w, { vendorId: g.vendor.id, lines: g.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, rate: l.rate })) });
  expect((await stock())['Acetic Acid']).toMatchObject({ onOrder: 0 }); // a draft is not on the way
  await ok(w.api('post', `/purchase-orders/${po.id}/approve`));
  s = await stock();
  expect(s['Acetic Acid']).toMatchObject({ onOrder: 60, openOrders: ['PO-00001'], suggestedOrderQty: 0, warning: { canCreatePo: false } });
  const after = await ok(w.api('get', '/stores/chemical/stock-limits/po-suggestion'));
  expect(after.covered.map((x) => x.name)).toEqual(['Acetic Acid']);
  // received: the stock goes up, nothing is on the way, the warning goes
  await ok(inward(w, c.vendor.id, [{ itemId: c.acid.id, qty: 60, poLineId: po.lines[0].id }], { approve: true }), 201);
  expect((await stock())['Acetic Acid']).toMatchObject({ stockQty: 100, onOrder: 0, warning: null });
});
