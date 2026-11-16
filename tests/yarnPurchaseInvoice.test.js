const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, Account } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const SERVICES = ['WEAVING_MASTERS', 'ACC_COA', 'ACC_PURCHASES', 'ACC_PAYMENTS', 'ACC_REPORTS', 'GENERAL_STORE'];

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const v1 = (await api('post', '/weaving/vendors', { name: 'Yarn Mills', creditDays: 15 })).body;
  const v2 = (await api('post', '/weaving/vendors', { name: 'Other Mills' })).body;
  const cu = (await api('post', '/weaving/customers', { name: 'Own Yarn Party' })).body;
  const inward = async (b) => (await api('post', '/weaving/yarn-inwards', { itemId: item.id, ...b })).body;
  const e1 = await inward({ vendorId: v1.id, bags: 10, lbsPerBag: 100, ratePerLb: 300, inwardDate: '2026-11-01', dcNo: 'DC-1' }); // 300,000
  const e2 = await inward({ vendorId: v1.id, bags: 5, lbsPerBag: 50, ratePerLb: 310.5, inwardDate: '2026-11-02' }); // 77,625
  const e3 = await inward({ vendorId: v2.id, bags: 2, lbsPerBag: 100, ratePerLb: 100, inwardDate: '2026-11-02' });
  const o1 = await inward({ customerId: cu.id, bags: 3, lbsPerBag: 100, inwardDate: '2026-11-03' });
  return { company, api, v1, v2, cu, e1, e2, e3, o1 };
}
const journalOf = async (companyId) => (await sequelize.query('SELECT count(*)::int AS entries, COALESCE(SUM(debit),0)::float AS debit, COALESCE(SUM(credit),0)::float AS credit FROM journal_lines WHERE "companyId" = :c', { replacements: { c: companyId }, type: sequelize.QueryTypes.SELECT }))[0];

test('yarn purchase invoice: made in the accounts from the yarn bought from a vendor; approve posts Purchases / Input Tax / Payable; the entries are held by the invoice', async () => {
  const w = await setup();
  // the picker: this vendor's purchase yarn only (not the customers' own yarn, not another vendor's)
  const pick = (await w.api('get', `/purchase-invoices/yarn-inwards?vendorId=${w.v1.id}`)).body;
  expect(pick.data.map((x) => [x.inwardCode, x.bags, x.lbs, x.ratePerLb, x.amount, x.canBill])).toEqual([[2, 5, 250, 310.5, 77625, true], [1, 10, 1000, 300, 300000, true]]);
  expect(pick.data[1]).toMatchObject({ item: '22|s Cotton - Crescent - 24 - 100', dcNo: 'DC-1', inwardDate: '2026-11-01' });

  // rules
  err(await w.api('post', '/purchase-invoices', { vendorId: w.v1.id, yarnInwardIds: [w.e3.id] }), 422, 'INWARD_OTHER_VENDOR');
  err(await w.api('post', '/purchase-invoices', { vendorId: w.v1.id, yarnInwardIds: [w.o1.id] }), 404, 'NOT_FOUND'); // a customer's own yarn is not a purchase
  expect((await w.api('post', '/purchase-invoices', { vendorId: w.v1.id, yarnInwardIds: [w.e1.id], inwardIds: [w.e1.id] })).status).toBe(400);
  expect((await w.api('post', '/purchase-invoices', { vendorId: w.v1.id })).status).toBe(400);
  expect(await Account.count({ where: { companyId: w.company.id, isSystem: true } })).toBe(0);

  // one invoice for both entries of the vendor: gross 377,625; tax 18 % = 67,972.5; net 445,597.5
  const inv = await w.api('post', '/purchase-invoices', { vendorId: w.v1.id, yarnInwardIds: [w.e1.id, w.e2.id], invoiceDate: '2026-11-04', taxRate: 18, billNo: 'B-77' });
  expect(inv.status).toBe(201);
  expect(inv.body).toMatchObject({ kind: 'YARN', kindText: 'Yarn', voucherNo: 1, billNo: 'B-77', status: 'UNAPPROVED', taxRate: 18, gross: 377625, tax: 67972.5, net: 445597.5, inwardCount: 2,
    dueDate: '2026-11-19', vendor: { name: 'Yarn Mills' }, canEdit: true, canApprove: true });
  expect(inv.body.lines.map((l) => [l.inwardCode, l.bags, l.lbs, l.ratePerLb, l.amount, l.salesTax])).toEqual([[1, 10, 1000, 300, 300000, 54000], [2, 5, 250, 310.5, 77625, 13972.5]]);
  expect(await journalOf(w.company.id)).toMatchObject({ entries: 0 });
  expect((await Account.findAll({ where: { companyId: w.company.id, isSystem: true }, raw: true })).map((a) => a.systemKey).sort()).toEqual(['AP_CONTROL', 'DEFAULT_PURCHASES', 'INPUT_TAX']);

  // the entries are on the invoice: not in the picker; they cannot be changed or deleted in weaving (only DC no / remarks)
  expect((await w.api('get', `/purchase-invoices/yarn-inwards?vendorId=${w.v1.id}`)).body.total).toBe(0);
  expect((await w.api('get', `/purchase-invoices/yarn-inwards?vendorId=${w.v1.id}&invoiceId=${inv.body.id}`)).body.total).toBe(2);
  expect((await w.api('get', `/weaving/yarn-inwards/${w.e1.id}`)).body).toMatchObject({ invoiced: true, purchaseInvoice: { id: inv.body.id, voucherNo: 1, status: 'UNAPPROVED' } });
  err(await w.api('patch', `/weaving/yarn-inwards/${w.e1.id}`, { ratePerLb: 1 }), 422, 'ON_PURCHASE_INVOICE');
  err(await w.api('delete', `/weaving/yarn-inwards/${w.e1.id}`), 422, 'ON_PURCHASE_INVOICE');
  expect((await w.api('patch', `/weaving/yarn-inwards/${w.e1.id}`, { remarks: 'ok' })).status).toBe(200);
  expect((await w.api('get', '/weaving/yarn-inwards?type=PURCHASE')).body.data.filter((e) => e.invoiced).length).toBe(2);
  err(await w.api('post', '/purchase-invoices', { vendorId: w.v1.id, yarnInwardIds: [w.e1.id] }), 422, 'INWARD_TAKEN');

  // change: one entry only, no tax; the yarn kind cannot take store purchases
  const only = await w.api('patch', `/purchase-invoices/${inv.body.id}`, { yarnInwardIds: [w.e1.id], taxRate: 0 });
  expect(only.body).toMatchObject({ gross: 300000, tax: 0, net: 300000, inwardCount: 1 });
  err(await w.api('patch', `/purchase-invoices/${inv.body.id}`, { inwardIds: [w.e1.id] }), 422, 'WRONG_INVOICE_KIND');
  expect((await w.api('patch', `/weaving/yarn-inwards/${w.e2.id}`, { bags: 6 })).body).toMatchObject({ bags: 6, totalLbs: 300 }); // free again
  await w.api('patch', `/weaving/yarn-inwards/${w.e2.id}`, { bags: 5 });
  await w.api('patch', `/purchase-invoices/${inv.body.id}`, { yarnInwardIds: [w.e1.id, w.e2.id], taxRate: 18 });

  // approve: Debit Purchases gross / Debit Input Sales Tax / Credit Accounts Payable net (vendor named)
  const done = await w.api('post', `/purchase-invoices/${inv.body.id}/approve`);
  expect(done.body).toMatchObject({ status: 'APPROVED', kind: 'YARN', net: 445597.5, canEdit: false });
  const view = (await w.api('get', `/purchase-invoices/${inv.body.id}/accounts-entry`)).body;
  expect(view.current).toMatchObject({ balanced: true, totals: { debit: 445597.5, credit: 445597.5 }, entryDate: '2026-11-04', sourceType: 'PURCHASE_INVOICE' });
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([['Purchases', 377625, 0, null], ['Input Sales Tax', 67972.5, 0, null], ['Accounts Payable', 0, 445597.5, 'VENDOR']]);
  expect(view.current.lines[2].partyId).toBe(w.v1.id);
  expect(view.current.lines[0].narration).toMatch(/Yarn purchase invoice 00001 - Yarn Mills \(bill B-77\)/);
  err(await w.api('delete', `/purchase-invoices/${inv.body.id}`), 422, 'INVOICE_APPROVED');
  err(await w.api('patch', `/weaving/yarn-inwards/${w.e1.id}`, { remarks: 'x', bags: 11 }), 422, 'ON_PURCHASE_INVOICE');

  // the accounts lists show it (kind filter); the vendor is in the accounts' vendor list (both lists), not in the stores' default list
  const list = (await w.api('get', '/purchase-invoices')).body;
  expect(list.data.map((x) => [x.voucherNo, x.kind, x.status, x.vendor.name])).toEqual([[1, 'YARN', 'APPROVED', 'Yarn Mills']]);
  expect((await w.api('get', '/purchase-invoices?kind=STORE')).body.total).toBe(0);
  expect((await w.api('get', '/purchase-invoices?kind=YARN')).body.total).toBe(1);
  expect((await w.api('get', '/vendors?module=ALL')).body.data.map((v) => [v.name, v.module]).sort()).toEqual([['Other Mills', 'WEAVING'], ['Yarn Mills', 'WEAVING']]);
  expect((await w.api('get', '/vendors')).body.total).toBe(0);
  expect((await w.api('get', '/vendors?module=WEAVING')).body.total).toBe(2);

  // un-approve reverses the entry; delete frees the yarn entries
  const un = await w.api('post', `/purchase-invoices/${inv.body.id}/unapprove`, {});
  expect(un.body.status).toBe('UNAPPROVED');
  expect(await journalOf(w.company.id)).toEqual({ entries: 6, debit: 891195, credit: 891195 });
  expect((await w.api('delete', `/purchase-invoices/${inv.body.id}`)).status).toBe(204);
  expect((await w.api('get', `/purchase-invoices/yarn-inwards?vendorId=${w.v1.id}`)).body.total).toBe(2);
  expect((await w.api('delete', `/weaving/yarn-inwards/${w.e2.id}`)).body.deleted).toBe(true);

  // another company sees nothing
  const o = await makeCompany();
  for (const c of ['WEAVING_MASTERS', 'ACC_PURCHASES']) await CompanyService.create({ companyId: o.id, serviceId: (await Service.findOne({ where: { code: c } })).id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: o.id }));
  expect((await oa('get', `/purchase-invoices/yarn-inwards?vendorId=${w.v1.id}`)).body.total).toBe(0);
  err(await oa('post', '/purchase-invoices', { vendorId: w.v1.id, yarnInwardIds: [w.e1.id] }), 404, 'NOT_FOUND');
});
