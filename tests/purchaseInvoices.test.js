const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account } = require('../src/models');

beforeEach(clean);

const SERVICES = ['CHEMICAL_STORE', 'GENERAL_STORE', 'ACC_COA', 'ACC_PURCHASES', 'ACC_REPORTS'];
const token = async (u) => ({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
const caller = (auth) => (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  return { company, api: caller(await token(admin)), admin };
}

const ok = async (p, status = 201) => { const r = await p; expect(r.status).toBe(status); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); expect(r.body.error.code).toBe(code); };
const journalOf = (companyId) => sequelize.query('SELECT count(*)::int AS lines, COALESCE(SUM(debit), 0)::float AS debit, COALESCE(SUM(credit), 0)::float AS credit FROM journal_lines WHERE "companyId" = :companyId',
  { replacements: { companyId }, type: sequelize.QueryTypes.SELECT }).then((r) => r[0]);

/**
 * Two vendors and their approved store purchases:
 *   NEXUS CHEMICAL   i1 chemical GST 18 %  100 kg x 50   = 5,000 + tax 900
 *                    i2 chemical (no GST)  10 kg x 20     =   200
 *                    i3 general  (no GST)  50 pcs x 10    =   500   (a general store purchase never carries GST)
 *   DYES CO          i4 chemical (no GST)  1 kg x 1,000   = 1,000
 */
async function purchases(w) {
  const vendor = async (name, ntn) => (await ok(w.api('post', '/vendors', { name, ntn })));
  const a = await vendor('NEXUS CHEMICAL', '1234567-8');
  const b = await vendor('DYES CO', '7654321-0');
  const soda = await ok(w.api('post', '/stores/chemical/items', { name: 'Caustic Soda', unit: 'KG' }));
  const acid = await ok(w.api('post', '/stores/chemical/items', { name: 'Acetic Acid', unit: 'KG' }));
  const bolt = await ok(w.api('post', '/stores/general/items', { name: 'Bolts', unit: 'PCS' }));
  const inward = (store, vendorId, body) => ok(w.api('post', `/stores/${store}/inwards`, { vendorId, approve: true, ...body }));
  const i1 = await inward('chemical', a.id, { inwardDate: '2026-10-10', billType: 'GST', gstPercent: 18, dcNo: 'DC-1', lines: [{ itemId: soda.id, qty: 100, rate: 50 }] });
  const i2 = await inward('chemical', a.id, { inwardDate: '2026-10-12', billType: 'OTHER', lines: [{ itemId: acid.id, qty: 10, rate: 20 }] });
  const i3 = await inward('general', a.id, { inwardDate: '2026-10-15', lines: [{ itemId: bolt.id, qty: 50, rate: 10 }] });
  const i4 = await inward('chemical', b.id, { inwardDate: '2026-10-16', billType: 'OTHER', lines: [{ itemId: soda.id, qty: 1, rate: 1000 }] });
  // the store takes no GST any more (the billType and gstPercent sent above are ignored); i1 is made an older inward that still carries its own 18 % GST
  expect([i1, i2, i3, i4].map((x) => [x.amount, x.salesTax, x.billType])).toEqual([[5000, 0, 'OTHER'], [200, 0, 'OTHER'], [500, 0, 'OTHER'], [1000, 0, 'OTHER']]);
  await sequelize.query(`UPDATE store_inwards SET "billType" = 'GST', "gstPercent" = 18, "salesTax" = 900 WHERE id = :id`, { replacements: { id: i1.id } });
  i1.salesTax = 900; i1.gstPercent = 18; i1.billType = 'GST';
  return { a, b, i1, i2, i3, i4, soda };
}

const tb = (w, q = '') => ok(w.api('get', `/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31${q}`), 200);
const row = (t, name) => t.rows.find((r) => r.name === name);

test('the purchases of a vendor are offered with their amounts; drafts and other vendors are not', async () => {
  const w = await setup();
  const p = await purchases(w);
  // a draft purchase (not approved in the store) is not offered
  await ok(w.api('post', '/stores/chemical/inwards', { vendorId: p.a.id, inwardDate: '2026-10-20', lines: [{ itemId: p.soda.id, qty: 5, rate: 10 }] }));

  const all = await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.a.id}`), 200);
  expect(all.total).toBe(3);
  const one = all.data.find((x) => x.inwardId === p.i1.id);
  expect(one).toMatchObject({ store: 'CHEMICAL', storeText: 'Chemical Store', amount: 5000, salesTax: 900, net: 5900, gstPercent: 18, billType: 'GST', dcNo: 'DC-1', items: 'Caustic Soda', canBill: true, inwardDate: '2026-10-10' });
  expect(all.data.find((x) => x.inwardId === p.i3.id)).toMatchObject({ store: 'GENERAL', storeText: 'General Store', amount: 500, salesTax: 0, net: 500 });
  expect((await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.a.id}&store=GENERAL`), 200)).data.map((x) => x.inwardId)).toEqual([p.i3.id]);
  expect((await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.a.id}&search=acetic`), 200)).data.map((x) => x.inwardId)).toEqual([p.i2.id]);
  expect((await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.b.id}`), 200)).data.map((x) => x.inwardId)).toEqual([p.i4.id]);
  expect((await ok(w.api('get', '/purchase-invoices/options'), 200)).stores.map((s) => s.code)).toEqual(['CHEMICAL', 'GENERAL']);
});

test('a draft invoice: totals follow the purchases, tax is added up, default accounts exist, nothing reaches the books', async () => {
  const w = await setup();
  const p = await purchases(w);
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id, p.i2.id, p.i3.id], invoiceDate: '2026-10-24', dueDate: '2026-11-23', billNo: 'S-123', notes: 'October chemicals' }));
  expect(inv).toMatchObject({
    voucherNo: 1, voucherLabel: '00001', billNo: 'S-123', status: 'UNAPPROVED', statusText: 'Un-approved', invoiceDate: '2026-10-24', dueDate: '2026-11-23',
    gross: 5700, tax: 900, net: 6600, paid: 0, balance: 6600, inwardCount: 3, canEdit: true, canApprove: true, canUnapprove: false, vendor: { name: 'NEXUS CHEMICAL', ntn: '1234567-8' },
  });
  expect(inv.lines.map((l) => [l.storeText, l.amount, l.salesTax, l.net])).toEqual([['Chemical Store', 5000, 900, 5900], ['Chemical Store', 200, 0, 200], ['General Store', 500, 0, 500]]);
  expect((await journalOf(w.company.id)).lines).toBe(0); // a draft never touches the books
  const made = await Account.findAll({ where: { companyId: w.company.id, isSystem: true }, raw: true });
  expect(made.map((a) => a.systemKey).sort()).toEqual(['AP_CONTROL', 'DEFAULT_PURCHASES', 'INPUT_TAX']);
  expect(made.find((a) => a.systemKey === 'DEFAULT_PURCHASES')).toMatchObject({ name: 'Purchases', accountType: 'EXPENSE', controlType: 'PURCHASES' });
  expect(made.find((a) => a.systemKey === 'INPUT_TAX')).toMatchObject({ name: 'Input Sales Tax', accountType: 'ASSET' });
  expect(made.find((a) => a.systemKey === 'AP_CONTROL')).toMatchObject({ name: 'Accounts Payable', accountType: 'LIABILITY' });

  // the purchases are taken now
  expect((await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.a.id}`), 200)).total).toBe(0);
  expect((await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.a.id}&invoiceId=${inv.id}`), 200)).total).toBe(3);

  // change it: only two purchases; the bill number and the dates
  const changed = await ok(w.api('patch', `/purchase-invoices/${inv.id}`, { inwardIds: [p.i1.id, p.i3.id], billNo: 'S-124', notes: 'changed' }), 200);
  expect(changed).toMatchObject({ gross: 5500, tax: 900, net: 6400, billNo: 'S-124', inwardCount: 2, voucherNo: 1 });
  expect((await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.a.id}`), 200)).data.map((x) => x.inwardId)).toEqual([p.i2.id]); // the other one is free again

  // delete a draft: its purchases are free again
  expect((await w.api('delete', `/purchase-invoices/${inv.id}`)).status).toBe(204);
  expect((await w.api('get', `/purchase-invoices/${inv.id}`)).status).toBe(404);
  expect((await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.a.id}`), 200)).total).toBe(3);
});

test('wrong purchases are refused; a vendor bill cannot be entered twice', async () => {
  const w = await setup();
  const p = await purchases(w);
  const draft = await ok(w.api('post', '/stores/chemical/inwards', { vendorId: p.a.id, inwardDate: '2026-10-20', lines: [{ itemId: p.soda.id, qty: 5, rate: 10 }] }));
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id, p.i4.id] }), 422, 'INWARD_OTHER_VENDOR');
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [draft.id] }), 422, 'INWARD_NOT_APPROVED');
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: ['6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11'] }), 404, 'NOT_FOUND');
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/purchase-invoices', { inwardIds: [p.i1.id] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id], invoiceDate: '2026-10-24', dueDate: '2026-10-01' }), 422, 'DUE_BEFORE_DATE');

  const first = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id], billNo: 'INV-77' }));
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id] }), 422, 'INWARD_TAKEN');
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i2.id], billNo: 'inv-77' }), 422, 'BILL_NO_TAKEN'); // not case sensitive
  // the same bill number of ANOTHER vendor is fine
  await ok(w.api('post', '/purchase-invoices', { vendorId: p.b.id, inwardIds: [p.i4.id], billNo: 'INV-77' }));
  const second = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i2.id], billNo: 'INV-78' }));
  await fails(w.api('patch', `/purchase-invoices/${second.id}`, { billNo: 'INV-77' }), 422, 'BILL_NO_TAKEN');
  expect((await ok(w.api('patch', `/purchase-invoices/${second.id}`, { billNo: 'INV-78' }), 200)).billNo).toBe('INV-78'); // its own number again is fine
  // the vendor changed: the purchases of the new vendor are required
  await fails(w.api('patch', `/purchase-invoices/${first.id}`, { vendorId: p.b.id }), 422, 'INWARDS_REQUIRED');
  await fails(w.api('patch', `/purchase-invoices/${first.id}`, { vendorId: p.b.id, inwardIds: [p.i1.id] }), 422, 'INWARD_OTHER_VENDOR');
});

test('a purchase on an invoice cannot be corrected or un-approved in the store until the invoice is un-approved or deleted', async () => {
  const w = await setup();
  const p = await purchases(w);
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id] }));
  const body = { reason: 'wrong rate', lines: [{ itemId: p.soda.id, qty: 100, rate: 60 }] };
  await fails(w.api('post', `/stores/chemical/inwards/${p.i1.id}/correct`, body), 422, 'ENTRY_ON_PURCHASE_INVOICE');
  await fails(w.api('post', `/stores/chemical/inwards/${p.i1.id}/unapprove`), 422, 'ENTRY_ON_PURCHASE_INVOICE');
  // a purchase that is not on an invoice can still be corrected
  const acid = (await ok(w.api('get', `/stores/chemical/inwards/${p.i2.id}`), 200)).lines[0];
  const fixed = await w.api('post', `/stores/chemical/inwards/${p.i2.id}/correct`, { reason: 'wrong rate', lines: [{ lineId: acid.id || acid.lineId, itemId: acid.itemId || acid.item.id, qty: 10, rate: 25 }] });
  expect([fixed.status, fixed.body.error && fixed.body.error.code]).toEqual([200, undefined]);
  // after the invoice is deleted the purchase is free again
  await w.api('delete', `/purchase-invoices/${inv.id}`);
  const undone = await w.api('post', `/stores/chemical/inwards/${p.i1.id}/unapprove`);
  expect([undone.status, undone.body.error && undone.body.error.code]).toEqual([200, undefined]);
});

test('approve posts Debit Purchases / Debit Input Tax / Credit Accounts Payable (the vendor named), and balances', async () => {
  const w = await setup();
  const p = await purchases(w);
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id, p.i2.id, p.i3.id], invoiceDate: '2026-10-24', billNo: 'S-123' }));
  const done = await ok(w.api('post', `/purchase-invoices/${inv.id}/approve`), 200);
  expect(done).toMatchObject({ status: 'APPROVED', statusText: 'Approved', canEdit: false, canApprove: false, canUnapprove: true, net: 6600 });

  const view = await ok(w.api('get', `/purchase-invoices/${inv.id}/accounts-entry`), 200);
  expect(view).toMatchObject({ posted: true, status: 'APPROVED' });
  expect(view.current).toMatchObject({ balanced: true, totals: { debit: 6600, credit: 6600 }, entryDate: '2026-10-24', sourceType: 'PURCHASE_INVOICE', sourceId: inv.id });
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([
    ['Purchases', 5700, 0, null], ['Input Sales Tax', 900, 0, null], ['Accounts Payable', 0, 6600, 'VENDOR'],
  ]);
  expect(view.current.lines[2].partyId).toBe(p.a.id);
  expect(view.current.narration).toContain('bill S-123');
  expect(await journalOf(w.company.id)).toEqual({ lines: 3, debit: 6600, credit: 6600 });

  await fails(w.api('patch', `/purchase-invoices/${inv.id}`, { notes: 'x' }), 422, 'INVOICE_APPROVED');
  await fails(w.api('delete', `/purchase-invoices/${inv.id}`), 422, 'INVOICE_APPROVED');
  await fails(w.api('post', `/purchase-invoices/${inv.id}/approve`), 422, 'ALREADY_APPROVED');
  const purchasesAccount = await Account.findOne({ where: { companyId: w.company.id, systemKey: 'DEFAULT_PURCHASES' } });
  await fails(w.api('delete', `/accounts/${purchasesAccount.id}`), 422, 'SYSTEM_LOCKED');
});

test('an invoice without tax posts two lines; no input tax is booked', async () => {
  const w = await setup();
  const p = await purchases(w);
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.b.id, inwardIds: [p.i4.id] }));
  await ok(w.api('post', `/purchase-invoices/${inv.id}/approve`), 200);
  const view = await ok(w.api('get', `/purchase-invoices/${inv.id}/accounts-entry`), 200);
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Purchases', 1000, 0], ['Accounts Payable', 0, 1000]]);
});

test('un-approve reverses the entry (both stay in the books), the invoice can be changed and approved again', async () => {
  const w = await setup();
  const p = await purchases(w);
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id, p.i2.id, p.i3.id], invoiceDate: '2026-10-24' }));
  await fails(w.api('post', `/purchase-invoices/${inv.id}/unapprove`, {}), 422, 'NOT_APPROVED');
  await ok(w.api('post', `/purchase-invoices/${inv.id}/approve`), 200);
  expect(await ok(w.api('post', `/purchase-invoices/${inv.id}/unapprove`, { reason: 'wrong vendor bill' }), 200)).toMatchObject({ status: 'UNAPPROVED', canEdit: true });

  const view = await ok(w.api('get', `/purchase-invoices/${inv.id}/accounts-entry`), 200);
  expect(view.posted).toBe(false);
  expect(view.entries.map((e) => [e.entryNo, e.status, Boolean(e.reversalOfId)])).toEqual([[1, 'REVERSED', false], [2, 'POSTED', true]]);
  expect(view.entries[1].narration).toContain('wrong vendor bill');
  expect(await journalOf(w.company.id)).toEqual({ lines: 6, debit: 13200, credit: 13200 });
  const net = await sequelize.query(`SELECT a.name, (SUM(l.debit) - SUM(l.credit))::float AS balance FROM journal_lines l JOIN accounts a ON a.id = l."accountId" WHERE l."companyId" = :c GROUP BY a.name`,
    { replacements: { c: w.company.id }, type: sequelize.QueryTypes.SELECT });
  expect(net.every((r) => r.balance === 0)).toBe(true);

  await ok(w.api('patch', `/purchase-invoices/${inv.id}`, { inwardIds: [p.i1.id] }), 200);
  const again = await ok(w.api('post', `/purchase-invoices/${inv.id}/approve`), 200);
  expect(again).toMatchObject({ status: 'APPROVED', gross: 5000, tax: 900, net: 5900 });
  expect((await ok(w.api('get', `/purchase-invoices/${inv.id}/accounts-entry`), 200)).current).toMatchObject({ entryNo: 3, totals: { debit: 5900, credit: 5900 } });
});

test('the purchase summary: totals of the list, filters and search', async () => {
  const w = await setup();
  const p = await purchases(w);
  const i1 = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id], invoiceDate: '2026-10-20', billNo: 'A-1', billDetails: 'CAUSTIC' }));
  await ok(w.api('post', '/purchase-invoices', { vendorId: p.b.id, inwardIds: [p.i4.id], invoiceDate: '2026-10-22', billNo: 'B-9' }));
  await ok(w.api('post', `/purchase-invoices/${i1.id}/approve`), 200);

  const all = await ok(w.api('get', '/purchase-invoices'), 200);
  expect(all.data.map((x) => x.voucherNo)).toEqual([2, 1]);
  expect(all.summary).toEqual({ invoices: 2, amount: 6000, tax: 900, net: 6900, paid: 0, balance: 6900 });
  expect((await ok(w.api('get', '/purchase-invoices?status=APPROVED'), 200)).summary).toMatchObject({ invoices: 1, net: 5900 });
  expect((await ok(w.api('get', `/purchase-invoices?vendorId=${p.b.id}`), 200)).summary).toMatchObject({ invoices: 1, net: 1000 });
  expect((await ok(w.api('get', '/purchase-invoices?dateFrom=2026-10-21&dateTo=2026-10-23'), 200)).data.map((x) => x.voucherNo)).toEqual([2]);
  expect((await ok(w.api('get', '/purchase-invoices?search=caustic'), 200)).data.map((x) => x.voucherNo)).toEqual([1]);
  expect((await ok(w.api('get', '/purchase-invoices?search=dyes'), 200)).data.map((x) => x.voucherNo)).toEqual([2]);
  expect((await ok(w.api('get', '/purchase-invoices?search=B-9'), 200)).data.map((x) => x.voucherNo)).toEqual([2]);
  expect((await ok(w.api('get', '/purchase-invoices?search=00002'), 200)).data.map((x) => x.voucherNo)).toEqual([2]);
  expect((await ok(w.api('get', '/purchase-invoices?limit=1&page=2'), 200)).data.map((x) => x.voucherNo)).toEqual([1]);
});

test('the trial balance follows the purchase invoices, and says when an invoice and the ledger disagree', async () => {
  const w = await setup();
  const p = await purchases(w);
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id, p.i2.id, p.i3.id], invoiceDate: '2026-10-24' }));
  let t = await tb(w);
  expect(t).toMatchObject({ rows: [], balanced: true, ok: true });
  expect(t.checks.map((c) => [c.key, c.ok])).toEqual([['TRIAL_BALANCE_BALANCED', true], ['CONTROL_ACCOUNTS_MATCH_SUBLEDGERS', true], ['SALES_INVOICES_MATCH_LEDGER', true], ['PURCHASE_INVOICES_MATCH_LEDGER', true], ['PAYMENT_VOUCHERS_MATCH_LEDGER', true], ['RECEIPT_VOUCHERS_MATCH_LEDGER', true], ['JOURNAL_VOUCHERS_MATCH_LEDGER', true], ['CONTRA_VOUCHERS_MATCH_LEDGER', true], ['INVOICE_PAYMENTS_MATCH_VOUCHERS', true]]);

  await ok(w.api('post', `/purchase-invoices/${inv.id}/approve`), 200);
  t = await tb(w);
  expect(row(t, 'Purchases')).toMatchObject({ periodDebit: '5700.00', periodCredit: '0.00', closingDebit: '5700.00', accountType: 'EXPENSE' });
  expect(row(t, 'Input Sales Tax')).toMatchObject({ periodDebit: '900.00', closingDebit: '900.00', accountType: 'ASSET' });
  expect(row(t, 'Accounts Payable')).toMatchObject({ periodDebit: '0.00', periodCredit: '6600.00', closingCredit: '6600.00', accountType: 'LIABILITY' });
  expect(t.totals).toEqual({ openingDebit: '0.00', openingCredit: '0.00', periodDebit: '6600.00', periodCredit: '6600.00', closingDebit: '6600.00', closingCredit: '6600.00' });
  expect(t).toMatchObject({ balanced: true, difference: '0.00', ok: true });
  // what we owe the vendor agrees with the vendor's own total
  const control = t.checks.find((c) => c.key === 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS');
  expect(control.accounts).toEqual([expect.objectContaining({ name: 'Accounts Payable', controlType: 'SUPPLIERS', glBalance: '6600.00', glSide: 'CREDIT', subledgerBalance: '6600.00', difference: '0.00', ok: true })]);
  expect(t.checks.find((c) => c.key === 'PURCHASE_INVOICES_MATCH_LEDGER')).toMatchObject({ ok: true, checked: 1, mismatches: [] });

  // the ledger of Accounts Payable: one credit line, with the vendor
  const led = await ok(w.api('get', `/accounting/ledger?accountId=${row(t, 'Accounts Payable').accountId}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);
  expect(led.lines).toEqual([expect.objectContaining({ sourceType: 'PURCHASE_INVOICE', sourceId: inv.id, debit: '0.00', credit: '6600.00', balance: '6600.00', balanceSide: 'CREDIT', partyType: 'VENDOR', partyName: 'NEXUS CHEMICAL' })]);

  // un-approved again: both entries are in the period and every closing is zero
  await ok(w.api('post', `/purchase-invoices/${inv.id}/unapprove`, {}), 200);
  t = await ok(w.api('get', '/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2099-12-31'), 200);
  expect(t.totals).toMatchObject({ periodDebit: '13200.00', periodCredit: '13200.00', closingDebit: '0.00', closingCredit: '0.00' });
  expect(t.ok).toBe(true);

  // the check catches an invoice that is "approved" without an entry
  await sequelize.query(`UPDATE purchase_invoices SET status = 'APPROVED' WHERE id = :id`, { replacements: { id: inv.id } });
  t = await tb(w);
  const check = t.checks.find((c) => c.key === 'PURCHASE_INVOICES_MATCH_LEDGER');
  expect(check.ok).toBe(false);
  expect(check.mismatches).toEqual([expect.objectContaining({ voucherNo: 1, reason: 'APPROVED_WITHOUT_ENTRY' })]);
  expect(t).toMatchObject({ balanced: true, ok: false });
});

test('access: needs the service; VIEW only reads; another company sees nothing', async () => {
  const w = await setup();
  const p = await purchases(w);
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id] }));
  const employee = async (access) => {
    const u = await makeUser({ userType: 'USER', companyId: w.company.id });
    if (access) await UserService.create({ userId: u.id, serviceId: (await Service.findOne({ where: { code: 'ACC_PURCHASES' } })).id, access });
    return caller(await token(u));
  };
  expect((await (await employee(null))('get', '/purchase-invoices')).status).toBe(403);
  const viewer = await employee('VIEW');
  expect((await viewer('get', '/purchase-invoices')).status).toBe(200);
  expect((await viewer('get', `/purchase-invoices/${inv.id}/accounts-entry`)).status).toBe(200);
  await fails(viewer('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i2.id] }), 403, 'FORBIDDEN');
  await fails(viewer('post', `/purchase-invoices/${inv.id}/approve`), 403, 'FORBIDDEN');
  await fails(viewer('delete', `/purchase-invoices/${inv.id}`), 403, 'FORBIDDEN');

  const other = await setup();
  expect((await ok(other.api('get', '/purchase-invoices'), 200)).total).toBe(0);
  expect((await other.api('get', `/purchase-invoices/${inv.id}`)).status).toBe(404);
  expect((await other.api('post', `/purchase-invoices/${inv.id}/approve`)).status).toBe(404);
  expect((await other.api('delete', `/purchase-invoices/${inv.id}`)).status).toBe(404);
  await fails(other.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id] }), 404, 'NOT_FOUND');
});

test('default accounts chosen before the first invoice are used by approve; nothing is made on the way', async () => {
  const w = await setup();
  const folder = (name, accountType) => ok(w.api('post', '/accounts', { name, isGroup: true, accountType }));
  const account = (name, parentId, accountType) => ok(w.api('post', '/accounts', { name, parentId, accountType }));
  const assets = await folder('My Assets', 'ASSET');
  const liabilities = await folder('My Liabilities', 'LIABILITY');
  const costs = await folder('My Costs', 'EXPENSE');
  const creditors = await account('Creditors', liabilities.id, 'LIABILITY');
  const gst = await account('GST Paid', assets.id, 'ASSET');
  const stock = await account('Chemical Purchases', costs.id, 'EXPENSE');
  for (const [key, a] of [['SUPPLIERS', creditors], ['INPUT_TAX', gst], ['PURCHASES', stock]]) await ok(w.api('put', `/accounts/defaults/${key}`, { accountId: a.id }), 200);
  const before = (await ok(w.api('get', '/accounts'), 200)).total;

  const p = await purchases(w);
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id, p.i2.id, p.i3.id], invoiceDate: '2026-10-24', billNo: 'S-123' }));
  await ok(w.api('post', `/purchase-invoices/${inv.id}/approve`), 200);
  const view = await ok(w.api('get', `/purchase-invoices/${inv.id}/accounts-entry`), 200);
  expect(view.current.lines.map((l) => [l.account.id, l.account.name, l.debit, l.credit])).toEqual([
    [stock.id, 'Chemical Purchases', 5700, 0], [gst.id, 'GST Paid', 900, 0], [creditors.id, 'Creditors', 0, 6600],
  ]);
  expect((await ok(w.api('get', '/accounts'), 200)).total).toBe(before);
  const t = await tb(w);
  expect(t.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
});

test('the sales tax is chosen on the purchase invoice: new store purchases carry none, an older one keeps its own GST, nothing is taxed twice', async () => {
  const w = await setup();
  const p = await purchases(w); // i1 = an older inward with its own 18 % GST (5,000 + 900); i2 = 200, i3 = 500 (general store), both without tax
  const opt = await ok(w.api('get', '/purchase-invoices/options'), 200);
  expect(opt).toMatchObject({ taxRates: [0, 5, 10, 15, 17, 18], defaultTaxRate: 0 });

  // a new purchase from the chemical store: the store takes no tax; the tax rate of the invoice works it out
  const soda = p.soda;
  const fresh = await ok(w.api('post', '/stores/chemical/inwards', { vendorId: p.a.id, inwardDate: '2026-10-18', billType: 'GST', gstPercent: 18, salesTax: 999, approve: true, lines: [{ itemId: soda.id, qty: 10, rate: 100 }] }));
  expect(fresh).toMatchObject({ amount: 1000, salesTax: 0, gstPercent: null, billType: 'OTHER', billed: 1000 });
  const picker = await ok(w.api('get', `/purchase-invoices/inwards?vendorId=${p.a.id}`), 200);
  expect(picker.data.find((x) => x.inwardId === fresh.id)).toMatchObject({ amount: 1000, salesTax: 0, net: 1000 });

  // no rate: no tax on the new purchase (the older one keeps 900)
  const none = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id, fresh.id], invoiceDate: '2026-10-24' }));
  expect(none).toMatchObject({ taxRate: 0, gross: 6000, tax: 900, net: 6900 });
  // 17 %: 17 % of the new purchase (170); the older purchase keeps its 900 and is not taxed again
  const t = await ok(w.api('patch', `/purchase-invoices/${none.id}`, { taxRate: 17 }), 200);
  expect(t).toMatchObject({ taxRate: 17, gross: 6000, tax: 1070, net: 7070 });
  expect(t.lines.map((l) => [l.amount, l.salesTax])).toEqual([[5000, 900], [1000, 170]]);
  // more purchases, no tax of their own: the rate applies to each, rounded per purchase
  const two = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i2.id, p.i3.id], invoiceDate: '2026-10-24', taxRate: 18, billNo: 'S-9' }));
  expect(two).toMatchObject({ taxRate: 18, gross: 700, tax: 126, net: 826 });
  expect(two.lines.map((l) => [l.amount, l.salesTax])).toEqual([[200, 36], [500, 90]]);

  // approve posts the tax of the invoice to Input Sales Tax
  const done = await ok(w.api('post', `/purchase-invoices/${two.id}/approve`), 200);
  expect(done).toMatchObject({ status: 'APPROVED', taxRate: 18, tax: 126, net: 826 });
  const entry = await ok(w.api('get', `/purchase-invoices/${two.id}/accounts-entry`), 200);
  expect(entry.current.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Purchases', 700, 0], ['Input Sales Tax', 126, 0], ['Accounts Payable', 0, 826]]);
  await fails(w.api('patch', `/purchase-invoices/${two.id}`, { taxRate: 5 }), 422, 'INVOICE_APPROVED');
  // un-approve, change the rate, approve again
  await ok(w.api('post', `/purchase-invoices/${two.id}/unapprove`, {}), 200);
  expect(await ok(w.api('patch', `/purchase-invoices/${two.id}`, { taxRate: 0 }), 200)).toMatchObject({ tax: 0, net: 700 });
  // a bad rate
  await fails(w.api('patch', `/purchase-invoices/${two.id}`, { taxRate: 101 }), 400, 'VALIDATION_FAILED');
  await fails(w.api('patch', `/purchase-invoices/${two.id}`, { taxRate: -1 }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i2.id], taxRate: '18' }), 400, 'VALIDATION_FAILED');
  expect((await tb(w)).checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
});

test('others: an amount with a note is TAKEN OFF the bill (damaged goods); no tax on it; it cannot be more than the bill; booked as a credit on the purchases account', async () => {
  const w = await setup();
  const p = await purchases(w); // i1 = an older GST inward 5,000 + 900; i2 = 200, i3 = 500
  const plain = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i2.id, p.i3.id], invoiceDate: '2026-10-24' }));
  expect(plain).toMatchObject({ othersAmount: 0, othersNote: null, othersEffect: 'DEDUCT', gross: 700, tax: 0, net: 700 });

  const inv = await ok(w.api('patch', `/purchase-invoices/${plain.id}`, { othersAmount: '100.50', othersNote: 'Damaged bags' }), 200);
  expect(inv).toMatchObject({ othersAmount: 100.5, othersNote: 'Damaged bags', gross: 700, tax: 0, net: 599.5, balance: 599.5 });
  await fails(w.api('patch', `/purchase-invoices/${plain.id}`, { othersAmount: 700.01 }), 422, 'OTHERS_MORE_THAN_BILL');
  await fails(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id], othersAmount: 5900.01 }), 422, 'OTHERS_MORE_THAN_BILL');
  for (const bad of [-1, '-5', 'abc', 1.234, null]) await fails(w.api('patch', `/purchase-invoices/${plain.id}`, { othersAmount: bad }), 400, 'VALIDATION_FAILED');
  expect(await ok(w.api('patch', `/purchase-invoices/${plain.id}`, { othersAmount: 100 }), 200)).toMatchObject({ othersAmount: 100, othersNote: 'Damaged bags', net: 600 });

  await ok(w.api('post', `/purchase-invoices/${plain.id}/approve`), 200);
  const e = await ok(w.api('get', `/purchase-invoices/${plain.id}/accounts-entry`), 200);
  expect(e.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([['Purchases', 700, 0, null], ['Purchases', 0, 100, null], ['Accounts Payable', 0, 600, 'VENDOR']]);
  expect(e.current.lines[1].narration).toContain('others - Damaged bags');
  expect(e.current).toMatchObject({ balanced: true, totals: { debit: 700, credit: 700 } });
  expect(e.current.lines[2].partyId).toBe(p.a.id);

  // with tax (the older inward keeps its own 900): others is not taxed and comes off the bill with the tax
  const withTax = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i1.id], invoiceDate: '2026-10-25', othersAmount: 200, othersNote: 'Short quantity' }));
  expect(withTax).toMatchObject({ gross: 5000, tax: 900, othersAmount: 200, net: 5700 });
  await ok(w.api('post', `/purchase-invoices/${withTax.id}/approve`), 200);
  const e2 = await ok(w.api('get', `/purchase-invoices/${withTax.id}/accounts-entry`), 200);
  expect(e2.current.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Purchases', 5000, 0], ['Purchases', 0, 200], ['Input Sales Tax', 900, 0], ['Accounts Payable', 0, 5700]]);

  // the books agree, the party balance is the net
  const t = await tb(w);
  expect(t.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
  expect(t.balanced).toBe(true);
  const bal = await ok(w.api('get', '/accounting/balances?date=2026-10-31'), 200);
  expect(bal.payables.rows).toEqual([expect.objectContaining({ name: 'NEXUS CHEMICAL', balance: '6300.00' })]); // 600 + 5,700
  await fails(w.api('patch', `/purchase-invoices/${plain.id}`, { othersAmount: 1 }), 422, 'INVOICE_APPROVED');
  // un-approve and remove it: no extra line
  await ok(w.api('post', `/purchase-invoices/${plain.id}/unapprove`, {}), 200);
  expect(await ok(w.api('patch', `/purchase-invoices/${plain.id}`, { othersAmount: 0 }), 200)).toMatchObject({ net: 700 });
  await ok(w.api('post', `/purchase-invoices/${plain.id}/approve`), 200);
  expect((await ok(w.api('get', `/purchase-invoices/${plain.id}/accounts-entry`), 200)).current.lines).toHaveLength(2);
});

test('credit terms: the due date is the invoice date + the vendor\'s credit days unless typed; the vendor credit limit (optional) only WARNS', async () => {
  const w = await setup();
  const p = await purchases(w);
  expect(await ok(w.api('patch', `/vendors/${p.a.id}`, { creditDays: 45, creditLimit: 1000 }), 200)).toMatchObject({ creditDays: 45, creditLimit: 1000 });
  const inv = await ok(w.api('post', '/purchase-invoices', { vendorId: p.a.id, inwardIds: [p.i2.id, p.i3.id], invoiceDate: '2026-10-24' }));
  expect(inv).toMatchObject({ dueDate: '2026-12-08', isOverdue: false, net: 700, creditWarning: null }); // 24 Oct + 45 days; 700 is within the 1,000 limit
  expect(await ok(w.api('patch', `/purchase-invoices/${inv.id}`, { dueDate: '2026-11-30' }), 200)).toMatchObject({ dueDate: '2026-11-30' });
  expect(await ok(w.api('patch', `/purchase-invoices/${inv.id}`, { notes: 'x' }), 200)).toMatchObject({ dueDate: '2026-11-30' });
  expect(await ok(w.api('patch', `/purchase-invoices/${inv.id}`, { dueDate: null }), 200)).toMatchObject({ dueDate: '2026-12-08' });
  expect(await ok(w.api('patch', `/purchase-invoices/${inv.id}`, { invoiceDate: '2026-10-25' }), 200)).toMatchObject({ dueDate: '2026-12-09' });
  // the vendor limit goes down: warning only, approve works
  await ok(w.api('patch', `/vendors/${p.a.id}`, { creditLimit: 500 }), 200);
  expect((await ok(w.api('get', `/purchase-invoices/${inv.id}`), 200)).creditWarning).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED', creditLimit: '500.00', thisInvoice: '700.00', exceededBy: '200.00' });
  const approved = await ok(w.api('post', `/purchase-invoices/${inv.id}/approve`), 200);
  expect(approved.status).toBe('APPROVED');
  expect(approved.creditWarning).toMatchObject({ balance: '700.00', thisInvoice: '0.00', exceededBy: '200.00' });
  expect(await ok(w.api('get', `/purchase-invoices/credit/${p.a.id}`), 200)).toMatchObject({ partyType: 'VENDOR', creditLimit: '500.00', creditDays: 45, balance: '700.00', available: '-200.00', exceeded: true });
  // no limit: no warning (the limit is optional for vendors)
  await ok(w.api('patch', `/vendors/${p.a.id}`, { creditLimit: null }), 200);
  expect((await ok(w.api('get', `/purchase-invoices/${inv.id}`), 200)).creditWarning).toBeNull();
  expect(await ok(w.api('get', `/purchase-invoices/credit/${p.a.id}`), 200)).toMatchObject({ creditLimit: null, available: null, exceeded: false });
});
