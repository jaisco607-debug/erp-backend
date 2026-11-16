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
  const supplier = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const sizer = (await api('post', '/weaving/vendors', { name: 'Sizing Co', creditDays: 10 })).body;
  const sizer2 = (await api('post', '/weaving/vendors', { name: 'Other Sizing' })).body;
  const yarn = (await api('post', '/weaving/yarn-inwards', { itemId: item.id, vendorId: supplier.id, bags: 50, lbsPerBag: 100, ratePerLb: 300, inwardDate: '2026-11-01' })).body;
  const beams = [];
  for (let i = 1; i <= 4; i += 1) beams.push((await api('post', '/weaving/beams', { name: `B${i}`, beamDate: '2026-10-01' })).body);
  const challan = (await api('post', '/weaving/yarn-sizing', { vendorId: sizer.id, outwardDate: '2026-11-05', lines: [{ inwardId: yarn.id, bags: 50 }], beamIds: beams.map((b) => b.id) })).body;
  // two receipts: 2400 lbs at 10 = 24,000 and 2400 lbs at 10.5 = 25,200
  const r1 = (await api('post', '/weaving/sizing-inwards', { outwardId: challan.id, inwardDate: '2026-11-12', lbsUsed: 2400, cutConeKg: 50, ratePerLb: 10, beams: [{ beamId: beams[0].id, meters: 5000 }, { beamId: beams[1].id, meters: 5000 }] })).body;
  const r2 = (await api('post', '/weaving/sizing-inwards', { outwardId: challan.id, inwardDate: '2026-11-14', lbsUsed: 2400, cutConeKg: 100, ratePerLb: 10.5, beams: [{ beamId: beams[2].id, meters: 4200 }, { beamId: beams[3].id, meters: 4200 }] })).body;
  return { company, api, sizer, sizer2, supplier, challan, r1, r2, beams };
}
const journalOf = async (companyId) => (await sequelize.query('SELECT count(*)::int AS entries, COALESCE(SUM(debit),0)::float AS debit, COALESCE(SUM(credit),0)::float AS credit FROM journal_lines WHERE "companyId" = :c', { replacements: { c: companyId }, type: sequelize.QueryTypes.SELECT }))[0];

test('sizing purchase invoice: made in the accounts from the sizing receipts of the vendor; approve posts Sizing Charges / Input Tax / Payable; default account is made; receipts are locked', async () => {
  const w = await setup();
  expect(w.r1.amount).toBe(24000);
  expect(w.r2.amount).toBe(25200);
  // the picker: this sizing party's receipts
  const pick = (await w.api('get', `/purchase-invoices/sizing-inwards?vendorId=${w.sizer.id}`)).body;
  expect(pick.data.map((x) => [x.inwardNo, x.challanNo, x.beams, x.meters, x.lbsUsed, x.cutConeKg, x.ratePerLb, x.amount, x.canBill])).toEqual([[2, 1, 2, 8400, 2400, 100, 10.5, 25200, true], [1, 1, 2, 10000, 2400, 50, 10, 24000, true]]);
  expect((await w.api('get', `/purchase-invoices/sizing-inwards?vendorId=${w.sizer2.id}`)).body.total).toBe(0);

  // rules
  err(await w.api('post', '/purchase-invoices', { vendorId: w.sizer2.id, sizingInwardIds: [w.r1.id] }), 422, 'INWARD_OTHER_VENDOR');
  expect((await w.api('post', '/purchase-invoices', { vendorId: w.sizer.id, sizingInwardIds: [w.r1.id], yarnInwardIds: [w.r1.id] })).status).toBe(400);
  err(await w.api('post', '/purchase-invoices', { vendorId: w.sizer.id, sizingInwardIds: ['11111111-1111-4111-8111-111111111111'] }), 404, 'NOT_FOUND');
  expect(await Account.count({ where: { companyId: w.company.id, isSystem: true } })).toBe(0);

  // one invoice, both receipts: gross 49,200; tax 18 % = 8,856; net 58,056
  const inv = await w.api('post', '/purchase-invoices', { vendorId: w.sizer.id, sizingInwardIds: [w.r1.id, w.r2.id], invoiceDate: '2026-11-15', taxRate: 18, billNo: 'SZ-BILL-9' });
  expect(inv.status).toBe(201);
  expect(inv.body).toMatchObject({ kind: 'SIZING', kindText: 'Sizing', voucherNo: 1, billNo: 'SZ-BILL-9', status: 'UNAPPROVED', taxRate: 18, gross: 49200, tax: 8856, net: 58056, inwardCount: 2,
    dueDate: '2026-11-25', vendor: { name: 'Sizing Co' }, canEdit: true, canApprove: true });
  expect(inv.body.lines.map((l) => [l.inwardNo, l.challanNo, l.beams, l.meters, l.lbsUsed, l.ratePerLb, l.amount, l.salesTax])).toEqual([[1, 1, 2, 10000, 2400, 10, 24000, 4320], [2, 1, 2, 8400, 2400, 10.5, 25200, 4536]]);
  // a draft posts nothing, but the default accounts are made: Sizing Charges (expense), Input Tax, Accounts Payable
  expect(await journalOf(w.company.id)).toMatchObject({ entries: 0 });
  const made = await Account.findAll({ where: { companyId: w.company.id, isSystem: true }, raw: true });
  expect(made.map((a) => a.systemKey).sort()).toEqual(['AP_CONTROL', 'INPUT_TAX', 'SIZING_CHARGES']);
  expect(made.find((a) => a.systemKey === 'SIZING_CHARGES')).toMatchObject({ name: 'Sizing Charges', accountType: 'EXPENSE', controlType: 'SIZING_CHARGES', isActive: true });

  // the receipts are on the invoice: not in the picker; locked in weaving (only DC no / description)
  expect((await w.api('get', `/purchase-invoices/sizing-inwards?vendorId=${w.sizer.id}`)).body.total).toBe(0);
  expect((await w.api('get', `/purchase-invoices/sizing-inwards?vendorId=${w.sizer.id}&invoiceId=${inv.body.id}`)).body.total).toBe(2);
  expect((await w.api('get', `/weaving/sizing-inwards/${w.r1.id}`)).body).toMatchObject({ invoiced: true, purchaseInvoice: { id: inv.body.id, voucherNo: 1, status: 'UNAPPROVED' } });
  err(await w.api('patch', `/weaving/sizing-inwards/${w.r1.id}`, { ratePerLb: 1 }), 422, 'ON_PURCHASE_INVOICE');
  err(await w.api('delete', `/weaving/sizing-inwards/${w.r1.id}`), 422, 'ON_PURCHASE_INVOICE');
  expect((await w.api('patch', `/weaving/sizing-inwards/${w.r1.id}`, { dcNo: 'NEW-1' })).body).toMatchObject({ dcNo: 'NEW-1', amount: 24000, invoiced: true });
  err(await w.api('post', '/purchase-invoices', { vendorId: w.sizer.id, sizingInwardIds: [w.r1.id] }), 422, 'INWARD_TAKEN');

  // change: one receipt, no tax; the other kinds cannot be mixed in
  const only = await w.api('patch', `/purchase-invoices/${inv.body.id}`, { sizingInwardIds: [w.r2.id], taxRate: 0 });
  expect(only.body).toMatchObject({ gross: 25200, tax: 0, net: 25200, inwardCount: 1 });
  err(await w.api('patch', `/purchase-invoices/${inv.body.id}`, { yarnInwardIds: [w.r1.id] }), 422, 'WRONG_INVOICE_KIND');
  expect((await w.api('patch', `/weaving/sizing-inwards/${w.r1.id}`, { lbsUsed: 2300 })).body.amount).toBe(23000); // free again
  await w.api('patch', `/weaving/sizing-inwards/${w.r1.id}`, { lbsUsed: 2400 });
  await w.api('patch', `/purchase-invoices/${inv.body.id}`, { sizingInwardIds: [w.r1.id, w.r2.id], taxRate: 18 });

  // approve: Debit Sizing Charges gross / Debit Input Sales Tax / Credit Accounts Payable net (the sizing vendor named)
  const done = await w.api('post', `/purchase-invoices/${inv.body.id}/approve`);
  expect(done.body).toMatchObject({ status: 'APPROVED', kind: 'SIZING', net: 58056, canEdit: false });
  const view = (await w.api('get', `/purchase-invoices/${inv.body.id}/accounts-entry`)).body;
  expect(view.current).toMatchObject({ balanced: true, totals: { debit: 58056, credit: 58056 }, entryDate: '2026-11-15', sourceType: 'PURCHASE_INVOICE' });
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([['Sizing Charges', 49200, 0, null], ['Input Sales Tax', 8856, 0, null], ['Accounts Payable', 0, 58056, 'VENDOR']]);
  expect(view.current.lines[2].partyId).toBe(w.sizer.id);
  expect(view.current.lines[0].narration).toMatch(/Sizing purchase invoice 00001 - Sizing Co \(bill SZ-BILL-9\)/);
  err(await w.api('delete', `/purchase-invoices/${inv.body.id}`), 422, 'INVOICE_APPROVED');
  err(await w.api('patch', `/weaving/sizing-inwards/${w.r1.id}`, { beams: [{ beamId: w.beams[0].id, meters: 1 }] }), 422, 'ON_PURCHASE_INVOICE');

  // the accounts show it: invoice lists (kind filter), the vendor ledger / balance, trial balance, the default account in the chart
  expect((await w.api('get', '/purchase-invoices?kind=SIZING')).body.data.map((x) => [x.voucherNo, x.kind, x.status, x.vendor.name])).toEqual([[1, 'SIZING', 'APPROVED', 'Sizing Co']]);
  expect((await w.api('get', '/purchase-invoices?kind=YARN')).body.total).toBe(0);
  const tb = (await w.api('get', '/accounting/trial-balance?dateTo=2026-12-31')).body;
  expect(tb.balanced).toBe(true);
  expect(tb.rows.map((r) => r.name)).toEqual(expect.arrayContaining(['Sizing Charges', 'Input Sales Tax', 'Accounts Payable']));
  expect(tb.rows.find((r) => r.name === 'Sizing Charges').periodDebit).toBe('49200.00');
  expect(tb.checks.every((c) => c.ok)).toBe(true);
  const defaults = (await w.api('get', '/accounts/defaults')).body.data;
  expect(defaults.find((d) => d.key === 'SIZING_CHARGES')).toMatchObject({ status: 'SET', group: 'PURCHASE_INVOICE', account: { name: 'Sizing Charges' } });
  const cr = (await w.api('get', `/purchase-invoices/credit/${w.sizer.id}`)).body;
  expect(Number(cr.balance)).toBe(58056); // we owe the sizing party

  // un-approve reverses the entry; delete frees the receipts
  expect((await w.api('post', `/purchase-invoices/${inv.body.id}/unapprove`, {})).body.status).toBe('UNAPPROVED');
  expect(await journalOf(w.company.id)).toEqual({ entries: 6, debit: 116112, credit: 116112 });
  expect((await w.api('delete', `/purchase-invoices/${inv.body.id}`)).status).toBe(204);
  expect((await w.api('get', `/purchase-invoices/sizing-inwards?vendorId=${w.sizer.id}`)).body.total).toBe(2);
  expect((await w.api('delete', `/weaving/sizing-inwards/${w.r2.id}`)).body.deleted).toBe(true);

  // another company sees nothing
  const o = await makeCompany();
  for (const c of ['WEAVING_MASTERS', 'ACC_PURCHASES']) await CompanyService.create({ companyId: o.id, serviceId: (await Service.findOne({ where: { code: c } })).id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: o.id }));
  expect((await oa('get', `/purchase-invoices/sizing-inwards?vendorId=${w.sizer.id}`)).body.total).toBe(0);
  err(await oa('post', '/purchase-invoices', { vendorId: w.sizer.id, sizingInwardIds: [w.r1.id] }), 404, 'NOT_FOUND');
});
