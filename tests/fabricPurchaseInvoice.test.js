const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

jest.setTimeout(300000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const SERVICES = ['FABRIC_STORE', 'GREY_STORE', 'ACC_COA', 'ACC_PURCHASES', 'ACC_PAYMENTS', 'ACC_REPORTS'];

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = call(admin);
  const vendor = (await api('post', '/vendors', { name: 'Cloth Mills', creditDays: 10 })).body;
  const vendor2 = (await api('post', '/vendors', { name: 'Other Mills' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  return { company, api, vendor, vendor2, q };
}
const entry = (w, extra = {}) => ({ inwardDate: '2026-11-10', vendorId: w.vendor.id, qualityId: w.q.id, dcNo: 'DC-9', ...extra });

test('rate per meter or per yard: every thaan gets its own amount, the entry the total', async () => {
  const w = await setup();
  const a = await w.api('post', '/fabric-inwards', entry(w, { thaans: [60, 40.5, 50], rate: 10, rateUnit: 'METER' }));
  expect(a.status).toBe(201);
  expect(a.body).toMatchObject({ rate: 10, rateUnit: 'METER', rateText: 'per meter', hasRate: true, amount: 1500.0 + 5, invoiced: false, purchaseInvoice: null });
  expect(a.body.amount).toBe(1505);
  expect(a.body.thaans.map((t) => t.amount)).toEqual([600, 405, 500]);
  // per yard: the length in yards x the rate
  const b = await w.api('post', '/fabric-inwards', entry(w, { thaans: [60, 40.5, 50], rate: 10, rateUnit: 'YARD' }));
  expect(b.body.thaans.map((t) => t.amount)).toEqual([656.2, 442.9, 546.8]);
  expect([b.body.rateText, b.body.amount]).toEqual(['per yard', 1645.9]);
  // the unit of the rate defaults to the unit of the entry; a yard entry
  const c = await w.api('post', '/fabric-inwards', entry(w, { unit: 'YARD', thaans: [100, 100], rate: 5 }));
  expect([c.body.rateUnit, c.body.amount, c.body.thaans.map((t) => t.amount)]).toEqual(['YARD', 1000, [500, 500]]);
  // a plain total without thaans
  const d = await w.api('post', '/fabric-inwards', entry(w, { inwardMeters: 500, pieces: 4, rate: 2 }));
  expect([d.body.amount, d.body.thaans]).toEqual([1000, []]);
  // no rate: no amounts
  const e = await w.api('post', '/fabric-inwards', entry(w, { thaans: [10] }));
  expect([e.body.rate, e.body.rateUnit, e.body.hasRate, e.body.amount, e.body.thaans[0].amount]).toEqual([null, null, false, null, null]);
  // edit: the rate, the unit of the rate, the lengths; null clears the rate
  const e1 = await w.api('patch', `/fabric-inwards/${e.body.id}`, { rate: 7 });
  expect([e1.body.rate, e1.body.rateUnit, e1.body.amount]).toEqual([7, 'METER', 70]);
  const e2 = await w.api('patch', `/fabric-inwards/${e.body.id}`, { thaans: [10, 20] });
  expect([e2.body.amount, e2.body.thaans.map((t) => t.amount)]).toEqual([210, [70, 140]]);
  const e3 = await w.api('patch', `/fabric-inwards/${e.body.id}`, { rateUnit: 'YARD' });
  expect([e3.body.rateUnit, e3.body.thaans.map((t) => t.amount)]).toEqual(['YARD', [76.58, 153.09]]); // 10 m = 10.94 yd x 7, 20 m = 21.87 yd x 7
  const e4 = await w.api('patch', `/fabric-inwards/${e.body.id}`, { rate: null });
  expect([e4.body.rate, e4.body.amount, e4.body.thaans[0].amount]).toEqual([null, null, null]);
  expect((await w.api('post', '/fabric-inwards', entry(w, { thaans: [10], rate: 0 }))).status).toBe(400);
  expect((await w.api('get', '/fabric-inwards/form-data')).body.rateUnits).toEqual(['METER', 'YARD']);
  // stock value follows the rate
  await w.api('post', `/fabric-inwards/${a.body.id}/approve`);
  const st = (await w.api('get', '/fabric-inwards/stock')).body;
  expect([st.totals.balanceValue, st.data[0].balanceValue, st.data[0].amount]).toEqual([1505, 1505, 1505]);
});

test('fabric purchase invoice: made in the accounts from the approved fabric inwards of a vendor; approve posts Purchases / Input Tax / Payable; the entries are locked', async () => {
  const w = await setup();
  const a = (await w.api('post', '/fabric-inwards', entry(w, { thaans: [60, 40.5, 50], rate: 10, rateUnit: 'METER' }))).body; // 1505
  const b = (await w.api('post', '/fabric-inwards', entry(w, { inwardMeters: 500, pieces: 4, rate: 2 }))).body; // 1000
  const noRate = (await w.api('post', '/fabric-inwards', entry(w, { thaans: [10] }))).body;
  const other = (await w.api('post', '/fabric-inwards', entry(w, { vendorId: w.vendor2.id, thaans: [10], rate: 3 }))).body;
  for (const x of [a, b, noRate, other]) await w.api('post', `/fabric-inwards/${x.id}/approve`);
  const draft = (await w.api('post', '/fabric-inwards', entry(w, { thaans: [10], rate: 3 }))).body; // not approved

  // the picker: approved entries of this vendor; the one without a rate cannot be billed
  const pick = (await w.api('get', `/purchase-invoices/fabric-inwards?vendorId=${w.vendor.id}`)).body;
  expect(pick.data.map((x) => [x.inwardNo, x.amount, x.canBill, x.rateText])).toEqual([[3, 0, false, null], [2, 1000, true, 'per meter'], [1, 1505, true, 'per meter']]);
  expect(pick.data[0].blockedReason).toMatch(/rate/);
  expect((await w.api('get', `/purchase-invoices/fabric-inwards?vendorId=${w.vendor.id}&search=${a.dcNo}`)).body.total).toBe(3);
  // rules
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, fabricInwardIds: [other.id] }), 422, 'INWARD_OTHER_VENDOR');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, fabricInwardIds: [noRate.id] }), 422, 'NO_AMOUNT');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, fabricInwardIds: [draft.id] }), 422, 'INWARD_NOT_APPROVED');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, fabricInwardIds: ['11111111-1111-4111-8111-111111111111'] }), 404, 'NOT_FOUND');
  expect((await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, fabricInwardIds: [a.id], inwardIds: [a.id] })).status).toBe(400);

  // one invoice, two entries: gross 2505, tax 18 % = 450.90, net 2955.90
  const inv = await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, fabricInwardIds: [a.id, b.id], invoiceDate: '2026-11-15', taxRate: 18, billNo: 'FAB-77' });
  expect(inv.status).toBe(201);
  expect(inv.body).toMatchObject({ kind: 'FABRIC', kindText: 'Fabric', voucherNo: 1, status: 'UNAPPROVED', taxRate: 18, gross: 2505, tax: 450.9, net: 2955.9, inwardCount: 2, dueDate: '2026-11-25', canEdit: true });
  expect(inv.body.lines.map((l) => [l.inwardNo, l.quality, l.pieces, l.meters, l.rate, l.rateText, l.amount, l.salesTax])).toEqual([[1, 'PC TWILL', 3, 150.5, 10, 'per meter', 1505, 270.9], [2, 'PC TWILL', 4, 500, 2, 'per meter', 1000, 180]]);
  // the entries are on the invoice: out of the picker, flagged in the store, locked
  expect((await w.api('get', `/purchase-invoices/fabric-inwards?vendorId=${w.vendor.id}`)).body.data.map((x) => x.inwardNo)).toEqual([3]);
  expect((await w.api('get', `/purchase-invoices/fabric-inwards?vendorId=${w.vendor.id}&invoiceId=${inv.body.id}`)).body.total).toBe(3);
  expect((await w.api('get', `/fabric-inwards/${a.id}`)).body).toMatchObject({ invoiced: true, purchaseInvoice: { id: inv.body.id, voucherNo: 1, voucherLabel: '00001', status: 'UNAPPROVED' } });
  expect((await w.api('get', '/fabric-inwards?search=DC-9')).body.data.filter((x) => x.invoiced).map((x) => x.inwardNo).sort()).toEqual([1, 2]);
  err(await w.api('post', `/fabric-inwards/${a.id}/unapprove`), 422, 'ON_PURCHASE_INVOICE');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, fabricInwardIds: [a.id] }), 422, 'INWARD_TAKEN');
  // change: one entry, no tax; other kinds cannot be mixed in
  const only = await w.api('patch', `/purchase-invoices/${inv.body.id}`, { fabricInwardIds: [b.id], taxRate: 0 });
  expect(only.body).toMatchObject({ gross: 1000, tax: 0, net: 1000, inwardCount: 1 });
  err(await w.api('patch', `/purchase-invoices/${inv.body.id}`, { yarnInwardIds: [a.id] }), 422, 'WRONG_INVOICE_KIND');
  await w.api('patch', `/purchase-invoices/${inv.body.id}`, { fabricInwardIds: [a.id, b.id], taxRate: 18 });

  // approve: Debit Purchases gross / Debit Input Sales Tax / Credit Accounts Payable net (the vendor named)
  const done = await w.api('post', `/purchase-invoices/${inv.body.id}/approve`);
  expect(done.body).toMatchObject({ status: 'APPROVED', kind: 'FABRIC', net: 2955.9, canEdit: false });
  const view = (await w.api('get', `/purchase-invoices/${inv.body.id}/accounts-entry`)).body;
  expect(view.current).toMatchObject({ balanced: true, totals: { debit: 2955.9, credit: 2955.9 }, entryDate: '2026-11-15', sourceType: 'PURCHASE_INVOICE' });
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([['Purchases', 2505, 0, null], ['Input Sales Tax', 450.9, 0, null], ['Accounts Payable', 0, 2955.9, 'VENDOR']]);
  expect(view.current.lines[2].partyId).toBe(w.vendor.id);
  expect(view.current.lines[0].narration).toMatch(/Fabric purchase invoice 00001 - Cloth Mills \(bill FAB-77\)/);
  err(await w.api('delete', `/purchase-invoices/${inv.body.id}`), 422, 'INVOICE_APPROVED');
  // the accounts show it
  expect((await w.api('get', '/purchase-invoices?kind=FABRIC')).body.data.map((x) => [x.voucherNo, x.kind, x.status, x.vendor.name])).toEqual([[1, 'FABRIC', 'APPROVED', 'Cloth Mills']]);
  expect((await w.api('get', '/purchase-invoices?kind=STORE')).body.total).toBe(0);
  const tb = (await w.api('get', '/accounting/trial-balance?dateTo=2026-12-31')).body;
  expect(tb.balanced).toBe(true);
  expect(tb.rows.map((r) => r.name)).toEqual(expect.arrayContaining(['Purchases', 'Input Sales Tax', 'Accounts Payable']));
  expect(tb.rows.find((r) => r.name === 'Purchases').periodDebit).toBe('2505.00');
  expect(tb.checks.every((c) => c.ok)).toBe(true);
  expect(Number((await w.api('get', `/purchase-invoices/credit/${w.vendor.id}`)).body.balance)).toBe(2955.9); // we owe the vendor
  // the entry stays locked while the invoice is approved
  err(await w.api('post', `/fabric-inwards/${b.id}/unapprove`), 422, 'ON_PURCHASE_INVOICE');

  // un-approve reverses the entry; deleting the invoice frees the entries
  expect((await w.api('post', `/purchase-invoices/${inv.body.id}/unapprove`, {})).body.status).toBe('UNAPPROVED');
  const [j] = await sequelize.query('SELECT count(*)::int AS entries, COALESCE(SUM(debit),0)::float AS debit, COALESCE(SUM(credit),0)::float AS credit FROM journal_lines WHERE "companyId" = :c', { replacements: { c: w.company.id }, type: sequelize.QueryTypes.SELECT });
  expect(j).toEqual({ entries: 6, debit: 5911.8, credit: 5911.8 });
  expect((await w.api('delete', `/purchase-invoices/${inv.body.id}`)).status).toBe(204);
  expect((await w.api('get', `/purchase-invoices/fabric-inwards?vendorId=${w.vendor.id}`)).body.total).toBe(3);
  expect((await w.api('post', `/fabric-inwards/${a.id}/unapprove`)).body.isApproved).toBe(false);

  // another company sees nothing
  const o = await makeCompany();
  for (const c of ['FABRIC_STORE', 'ACC_PURCHASES']) await CompanyService.create({ companyId: o.id, serviceId: (await Service.findOne({ where: { code: c } })).id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: o.id }));
  expect((await oa('get', `/purchase-invoices/fabric-inwards?vendorId=${w.vendor.id}`)).body.total).toBe(0);
  err(await oa('post', '/purchase-invoices', { vendorId: w.vendor.id, fabricInwardIds: [a.id] }), 404, 'NOT_FOUND');
});
