const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, StoreItem } = require('../src/models');

beforeEach(clean);

// owner 2026-10-22: 3 drums of acetic acid bought, 1 drum is bad, the vendor takes it back
test('return to vendor: packs, stock and batch go down, ledgers and audit agree, cancel puts it back', async () => {
  const company = await makeCompany();
  await Service.findOrCreate({ where: { code: 'STORE_REPORTS' }, defaults: { name: 'Store Reports', kind: 'MODULE', tracksColour: false, sortOrder: 99 } });
  for (const code of ['CHEMICAL_STORE', 'STORE_REPORTS']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

  const inw = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-10', vendorName: 'ALI CHEM', dcNo: '77',
    lines: [{ itemName: 'ACETIC ACID', unit: 'KG', packType: 'DRUM', packCount: 3, qtyPerPack: 200, rate: 50 }], approve: true })).body;
  expect(inw.lines[0]).toMatchObject({ qty: 600, packCount: 3, packType: 'DRUM', qtyPerPack: 200, amount: 30000 });
  const acid = await StoreItem.findOne({ where: { companyId: company.id, name: 'ACETIC ACID' } });
  const vendor = inw.vendor;

  const ret = (await api('get', `/stores/chemical/vendor-returns/returnable?vendorId=${vendor.id}`)).body.data;
  expect(ret[0]).toMatchObject({ inStore: 600, bought: 600, packCount: 3, ipNo: inw.ipNo });
  const make = (body) => api('post', '/stores/chemical/vendor-returns', { returnDate: '2026-10-12', vendorId: vendor.id, reason: 'DAMAGED', ...body });
  expect((await make({ lines: [{ inwardLineId: inw.lines[0].id, qty: 700 }] })).body.error.code).toBe('NOT_IN_STORE');
  expect((await make({ returnDate: '2026-10-01', lines: [{ inwardLineId: inw.lines[0].id, qty: 100 }] })).body.error.code).toBe('RETURN_BEFORE_PURCHASE');
  const r1 = (await make({ notes: 'one drum leaking', lines: [{ inwardLineId: inw.lines[0].id, packType: 'DRUM', packCount: 1, qtyPerPack: 200 }] })).body;
  expect(r1).toMatchObject({ returnText: 'VR-00001', status: 'POSTED', totalValue: 10000, reasonText: 'Damaged / bad' });
  expect(r1.lines[0]).toMatchObject({ qty: 200, rate: 50, value: 10000, packCount: 1 });
  expect((await api('get', `/stores/chemical/items/${acid.id}/batches`)).body).toMatchObject({ totalQty: 400, totalValue: 20000 });

  // a department-side use is simulated with a stock adjustment (loss); then only what is left can go back
  await api('post', '/stores/chemical/adjustments', { adjDate: '2026-10-13', reason: 'LOST', lines: [{ itemId: acid.id, mode: 'OUT', qty: 350 }] });
  expect((await make({ lines: [{ inwardLineId: inw.lines[0].id, qty: 100 }] })).body.error.code).toBe('NOT_IN_STORE');
  expect((await api('post', `/stores/chemical/inwards/${inw.id}/correct`, { reason: 'check qty', lines: [{ lineId: inw.lines[0].id, itemId: acid.id, qty: 100, rate: 50 }] })).body.error.code).toBe('QTY_BELOW_ISSUED');

  const rep = (name, qs = '') => api('get', `/stores/chemical/reports/${name}?export=true${qs}`);
  const vl = (await rep('vendor-ledger', `&vendorId=${vendor.id}`)).body.sections[0];
  expect(vl.rows.map((r) => [r.entry, r.amount, r.runningAmount])).toEqual([['Purchase', 30000, 30000], ['Return VR-00001', -10000, 20000]]);
  const pur = (await rep('purchases')).body.sections;
  expect(pur[0].rows[0]).toMatchObject({ amount: 30000, returnedAmount: 10000, netAmount: 20000 });
  expect(pur[1].rows[0]).toMatchObject({ returnedQty: 200, netQty: 400 });
  expect((await rep('vendor-returns')).body.sections[0].rows[0]).toMatchObject({ returnText: 'VR-00001', vendor: 'ALI CHEM', packs: '1 drum', qty: 200, value: 10000, reasonText: 'Damaged / bad' });
  const sum = (await rep('stock-summary', '&dateFrom=2026-10-01&dateTo=2026-10-31')).body.sections[0].rows[0];
  expect(sum).toMatchObject({ purchased: 600, vendorReturned: 200, adjusted: -350, closingQty: 50, vendorReturnedValue: 10000 });
  const on = (d) => rep('stock-on-date', `&date=${d}`).then((x) => x.body.sections[0].rows[0].qty);
  expect([await on('2026-10-11'), await on('2026-10-12'), await on('2026-10-13')]).toEqual([600, 400, 50]);
  expect((await rep('day-book')).body.sections[0].rows.map((x) => x.kindText)).toEqual(['Purchase', 'Returned to vendor', 'Stock adjustment']);
  for (const name of ['stock-ageing', 'monthly-summary', 'adjustments']) expect((await rep(name)).status).toBe(200);
  expect((await rep('adjustments')).body.sections[0].rows[0]).toMatchObject({ stockBefore: 400, qty: -350, stockAfter: 50 });
  expect((await rep('monthly-summary')).body.sections[0].rows[0]).toMatchObject({ month: '2026-10', purchasedValue: 30000, vendorReturnedValue: 10000 });
  const audit = (await rep('stock-audit')).body.sections;
  expect(audit[0].rows.every((c) => c.status === 'OK')).toBe(true);
  expect(audit[1].rows).toHaveLength(0);

  // minimum stock and batch stock
  await api('patch', `/stores/chemical/items/${acid.id}`, { reorderLevel: 100 });
  expect((await rep('low-stock')).body.sections[0].rows[0]).toMatchObject({ item: 'ACETIC ACID', stock: 50, minimum: 100, toBuy: 50, lastVendor: 'ALI CHEM' });
  expect((await api('get', `/stores/chemical/items/${acid.id}`)).body).toMatchObject({ reorderLevel: 100, isLow: true });
  expect((await rep('batch-stock')).body.sections[0].rows[0]).toMatchObject({ vendor: 'ALI CHEM', rate: 50, qtyLeft: 50, qtyIn: 600, value: 2500 });

  // inward detail and list show the return (cancelled ones are not counted)
  const d1 = (await api('get', `/stores/chemical/inwards/${inw.id}`)).body;
  expect(d1).toMatchObject({ returnedValue: 10000, netAmount: 20000, balance: 20000, billed: 30000, hasReturns: true });
  expect(d1.lines[0]).toMatchObject({ returnedQty: 200, netQty: 400, returnedValue: 10000 });
  expect((await api('get', '/stores/chemical/inwards')).body.data[0]).toMatchObject({ returnedValue: 10000 });

  // cancel a wrong return: the stock comes back, only once
  const r2 = (await make({ lines: [{ inwardLineId: inw.lines[0].id, qty: 50 }] })).body;
  expect((await api('post', `/stores/chemical/vendor-returns/${r2.id}/cancel`, { reason: 'entered by mistake' })).body.status).toBe('CANCELLED');
  expect((await api('post', `/stores/chemical/vendor-returns/${r2.id}/cancel`, { reason: 'again' })).body.error.code).toBe('ALREADY_CANCELLED');
  expect((await api('get', `/stores/chemical/items/${acid.id}/batches`)).body.totalQty).toBe(50);
  expect((await api('get', '/stores/chemical/vendor-returns')).body.total).toBe(2);
  const c2 = (await api('get', `/stores/chemical/vendor-returns/${r2.id}`)).body;
  expect(c2).toMatchObject({ status: 'CANCELLED', cancelReason: 'entered by mistake' });
  expect(c2.cancelledAt).toBeTruthy(); expect(c2.cancelledBy).toBeTruthy();
  expect(c2.lines[0]).toMatchObject({ itemName: 'ACETIC ACID', unit: 'KG', qty: 50, rate: 50, value: 2500, ipNo: inw.ipNo, dcNo: '77' });
  expect((await api('get', `/stores/chemical/inwards/${inw.id}`)).body).toMatchObject({ returnedValue: 10000 }); // the cancelled one is not counted
  expect((await rep('vendor-ledger', `&vendorId=${vendor.id}`)).body.sections[0].rows).toHaveLength(2); // its Return row is gone
  expect((await api('get', `/stores/chemical/vendor-returns/${r1.id}`)).body.lines).toHaveLength(1);
  expect((await rep('stock-audit')).body.sections[0].rows.every((c) => c.status === 'OK')).toBe(true);
});
