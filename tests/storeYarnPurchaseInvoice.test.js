const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

jest.setTimeout(300000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const SERVICES = ['YARN_STORE', 'ACC_COA', 'ACC_PURCHASES', 'ACC_PAYMENTS', 'ACC_REPORTS'];

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = call(admin);
  const vendor = (await api('post', '/vendors', { name: 'Yarn Mills', creditDays: 10 })).body;
  const vendor2 = (await api('post', '/vendors', { name: 'Other Mills' })).body;
  const entry = async (extra = {}, approve = true) => {
    const e = (await api('post', '/store-yarn-inwards', { inwardDate: '2026-11-10', vendorId: vendor.id, yarnName: '22/s Cotton', brand: 'Crescent', bags: 10, lbsPerBag: 50, ratePerLb: 300, dcNo: 'Y-1', ...extra })).body;
    if (approve) await api('post', `/store-yarn-inwards/${e.id}/approve`);
    return e;
  };
  return { company, api, vendor, vendor2, entry };
}

test('store yarn purchase invoice: made in the accounts from the approved yarn inwards of the vendor; approve posts Purchases / Input Tax / Payable; the entries are locked', async () => {
  const w = await setup();
  const a = await w.entry(); // 10 x 50 lbs @ 300 = 150,000
  const b = await w.entry({ yarnName: '30/s Polyester', brand: undefined, bags: 5, lbsPerBag: 100, ratePerLb: 20, dcNo: 'Y-2' }); // 500 lbs @ 20 = 10,000
  const noRate = await w.entry({ ratePerLb: undefined });
  const other = await w.entry({ vendorId: w.vendor2.id });
  const draft = await w.entry({}, false);

  // the picker: approved entries of this vendor; the one without a rate cannot be billed
  const pick = (await w.api('get', `/purchase-invoices/store-yarn-inwards?vendorId=${w.vendor.id}`)).body;
  expect(pick.data.map((x) => [x.inwardNo, x.amount, x.canBill])).toEqual([[3, 0, false], [2, 10000, true], [1, 150000, true]]);
  expect(pick.data[0].blockedReason).toMatch(/rate/);
  expect(pick.data[2]).toMatchObject({ title: '22/s Cotton - Crescent', bags: 10, lbsPerBag: 50, lbs: 500, ratePerLb: 300 });
  expect((await w.api('get', `/purchase-invoices/store-yarn-inwards?vendorId=${w.vendor.id}&search=polyester`)).body.total).toBe(1);
  // rules
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, storeYarnInwardIds: [other.id] }), 422, 'INWARD_OTHER_VENDOR');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, storeYarnInwardIds: [noRate.id] }), 422, 'NO_AMOUNT');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, storeYarnInwardIds: [draft.id] }), 422, 'INWARD_NOT_APPROVED');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, storeYarnInwardIds: ['11111111-1111-4111-8111-111111111111'] }), 404, 'NOT_FOUND');
  expect((await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, storeYarnInwardIds: [a.id], fabricInwardIds: [a.id] })).status).toBe(400);

  // one invoice, two entries: gross 160,000; tax 18 % = 28,800; net 188,800
  const inv = await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, storeYarnInwardIds: [a.id, b.id], invoiceDate: '2026-11-15', taxRate: 18, billNo: 'Y-77' });
  expect(inv.status).toBe(201);
  expect(inv.body).toMatchObject({ kind: 'STORE_YARN', kindText: 'Store Yarn', voucherNo: 1, status: 'UNAPPROVED', taxRate: 18, gross: 160000, tax: 28800, net: 188800, inwardCount: 2, dueDate: '2026-11-25', canEdit: true });
  expect(inv.body.lines.map((l) => [l.inwardNo, l.title, l.bags, l.lbsPerBag, l.lbs, l.ratePerLb, l.amount, l.salesTax])).toEqual([[1, '22/s Cotton - Crescent', 10, 50, 500, 300, 150000, 27000], [2, '30/s Polyester', 5, 100, 500, 20, 10000, 1800]]);
  // the entries are on the invoice: out of the picker, flagged in the store, locked
  expect((await w.api('get', `/purchase-invoices/store-yarn-inwards?vendorId=${w.vendor.id}`)).body.data.map((x) => x.inwardNo)).toEqual([3]);
  expect((await w.api('get', `/purchase-invoices/store-yarn-inwards?vendorId=${w.vendor.id}&invoiceId=${inv.body.id}`)).body.total).toBe(3);
  expect((await w.api('get', `/store-yarn-inwards/${a.id}`)).body).toMatchObject({ invoiced: true, purchaseInvoice: { id: inv.body.id, voucherNo: 1, voucherLabel: '00001', status: 'UNAPPROVED' } });
  expect((await w.api('get', '/store-yarn-inwards?search=Y-')).body.data.filter((x) => x.invoiced).map((x) => x.inwardNo).sort()).toEqual([1, 2]);
  err(await w.api('post', `/store-yarn-inwards/${a.id}/unapprove`), 422, 'ON_PURCHASE_INVOICE');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.vendor.id, storeYarnInwardIds: [a.id] }), 422, 'INWARD_TAKEN');
  // change: one entry, no tax; the other kinds cannot be mixed in
  const only = await w.api('patch', `/purchase-invoices/${inv.body.id}`, { storeYarnInwardIds: [b.id], taxRate: 0 });
  expect(only.body).toMatchObject({ gross: 10000, tax: 0, net: 10000, inwardCount: 1 });
  err(await w.api('patch', `/purchase-invoices/${inv.body.id}`, { fabricInwardIds: [a.id] }), 422, 'WRONG_INVOICE_KIND');
  await w.api('patch', `/purchase-invoices/${inv.body.id}`, { storeYarnInwardIds: [a.id, b.id], taxRate: 18 });

  // approve: Debit Purchases gross / Debit Input Sales Tax / Credit Accounts Payable net (the vendor named)
  const done = await w.api('post', `/purchase-invoices/${inv.body.id}/approve`);
  expect(done.body).toMatchObject({ status: 'APPROVED', kind: 'STORE_YARN', net: 188800, canEdit: false });
  const view = (await w.api('get', `/purchase-invoices/${inv.body.id}/accounts-entry`)).body;
  expect(view.current).toMatchObject({ balanced: true, totals: { debit: 188800, credit: 188800 }, entryDate: '2026-11-15', sourceType: 'PURCHASE_INVOICE' });
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([['Purchases', 160000, 0, null], ['Input Sales Tax', 28800, 0, null], ['Accounts Payable', 0, 188800, 'VENDOR']]);
  expect(view.current.lines[2].partyId).toBe(w.vendor.id);
  expect(view.current.lines[0].narration).toMatch(/Yarn purchase invoice 00001 - Yarn Mills \(bill Y-77\)/);
  err(await w.api('delete', `/purchase-invoices/${inv.body.id}`), 422, 'INVOICE_APPROVED');
  // the accounts show it
  expect((await w.api('get', '/purchase-invoices?kind=STORE_YARN')).body.data.map((x) => [x.voucherNo, x.kind, x.status, x.vendor.name])).toEqual([[1, 'STORE_YARN', 'APPROVED', 'Yarn Mills']]);
  expect((await w.api('get', '/purchase-invoices?kind=STORE')).body.total).toBe(0);
  const tb = (await w.api('get', '/accounting/trial-balance?dateTo=2026-12-31')).body;
  expect(tb.balanced).toBe(true);
  expect(tb.rows.find((r) => r.name === 'Purchases').periodDebit).toBe('160000.00');
  expect(tb.checks.every((c) => c.ok)).toBe(true);
  expect(Number((await w.api('get', `/purchase-invoices/credit/${w.vendor.id}`)).body.balance)).toBe(188800); // we owe the vendor
  err(await w.api('post', `/store-yarn-inwards/${b.id}/unapprove`), 422, 'ON_PURCHASE_INVOICE');

  // un-approve reverses the entry; deleting the invoice frees the entries
  expect((await w.api('post', `/purchase-invoices/${inv.body.id}/unapprove`, {})).body.status).toBe('UNAPPROVED');
  const [j] = await sequelize.query('SELECT count(*)::int AS entries, COALESCE(SUM(debit),0)::float AS debit, COALESCE(SUM(credit),0)::float AS credit FROM journal_lines WHERE "companyId" = :c', { replacements: { c: w.company.id }, type: sequelize.QueryTypes.SELECT });
  expect(j).toEqual({ entries: 6, debit: 377600, credit: 377600 });
  expect((await w.api('delete', `/purchase-invoices/${inv.body.id}`)).status).toBe(204);
  expect((await w.api('get', `/purchase-invoices/store-yarn-inwards?vendorId=${w.vendor.id}`)).body.total).toBe(3);
  expect((await w.api('post', `/store-yarn-inwards/${a.id}/unapprove`)).body.isApproved).toBe(false);

  // another company sees nothing
  const o = await makeCompany();
  for (const c of ['YARN_STORE', 'ACC_PURCHASES']) await CompanyService.create({ companyId: o.id, serviceId: (await Service.findOne({ where: { code: c } })).id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: o.id }));
  expect((await oa('get', `/purchase-invoices/store-yarn-inwards?vendorId=${w.vendor.id}`)).body.total).toBe(0);
  err(await oa('post', '/purchase-invoices', { vendorId: w.vendor.id, storeYarnInwardIds: [a.id] }), 404, 'NOT_FOUND');
});
