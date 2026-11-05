const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account, Customer, Vendor } = require('../src/models');
const journal = require('../src/services/journalService');

beforeEach(clean);

const SERVICES = ['ACC_COA', 'ACC_PAYMENTS', 'ACC_RECEIPTS', 'ACC_JOURNAL', 'ACC_CONTRA', 'ACC_REPORTS', 'ACC_SALES', 'ACC_PURCHASES'];
const token = async (u) => ({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
const caller = (auth) => (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

/** A company with the "other" template (bank 1102, cash 1101, receivable 1103, payable 2101, tax and advance accounts ...). */
async function setup({ template = true } = {}) {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = caller(await token(admin));
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  if (template) expect((await api('post', '/accounts/apply-template', { templateKey: 'other' })).status).toBe(200);
  const id = async (code) => (await Account.findOne({ where: { companyId: company.id, code } })).id;
  const post = (entry) => sequelize.transaction((t) => journal.post(req, entry, t));
  let n = 0;
  const customer = (name) => Customer.create({ companyId: company.id, code: (n += 1), name });
  const vendor = (name) => Vendor.create({ companyId: company.id, code: (n += 1), name });
  return { company, admin, api, req, id, post, customer, vendor };
}

const ok = async (p, status = 201) => { const r = await p; expect(r.status).toBe(status); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); expect(r.body.error.code).toBe(code); return r.body.error; };
const tb = (w, q = '') => ok(w.api('get', `/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31${q}`), 200);
const row = (t, name) => t.rows.find((r) => r.name === name);
const sql = (text, replacements) => sequelize.query(text, { replacements, type: sequelize.QueryTypes.SELECT });
const OK_CHECKS = ['TRIAL_BALANCE_BALANCED', 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS', 'SALES_INVOICES_MATCH_LEDGER', 'PURCHASE_INVOICES_MATCH_LEDGER', 'PAYMENT_VOUCHERS_MATCH_LEDGER', 'RECEIPT_VOUCHERS_MATCH_LEDGER', 'JOURNAL_VOUCHERS_MATCH_LEDGER', 'CONTRA_VOUCHERS_MATCH_LEDGER', 'INVOICE_PAYMENTS_MATCH_VOUCHERS'];

let counter = 0;
/** An approved sales invoice with its entry (Debit Receivable net, Credit Sales gross, Credit Output Sales Tax), made directly: the invoice flow itself is tested elsewhere. */
async function salesInvoice(w, customer, { gross, taxRate = 18, date = '2026-10-24', status = 'APPROVED' }) {
  counter += 1;
  const tax = Math.round(gross * taxRate) / 100;
  const net = gross + tax;
  const [[inv]] = await sequelize.query(`INSERT INTO sales_invoices ("companyId", "voucherNo", "invoiceNo", "invoiceDate", "customerId", "taxRate", "grossAmount", "taxAmount", "netAmount", status, "approvedAt")
    VALUES (:c, :n, :n, :date, :customer, :taxRate, :gross, :tax, :net, :status, :approvedAt) RETURNING id`,
  { replacements: { c: w.company.id, n: counter, date, customer: customer.id, taxRate, gross, tax, net, status, approvedAt: status === 'APPROVED' ? new Date() : null } });
  if (status === 'APPROVED') {
    await w.post({ entryDate: date, sourceType: 'SALES_INVOICE', sourceId: inv.id, narration: `Sales invoice ${counter}`, lines: [
      { accountId: await w.id('1103'), debit: net, partyType: 'CUSTOMER', partyId: customer.id }, { accountId: await w.id('4001'), credit: gross }, ...(tax ? [{ accountId: await w.id('2102'), credit: tax }] : []),
    ] });
  }
  return { id: inv.id, net, gross, tax, no: counter };
}

/** An approved purchase invoice with its entry (Debit Purchases gross, Debit Input Sales Tax, Credit Payable net, the vendor named). */
async function purchaseInvoice(w, vendor, { gross, tax = 0, billNo = null, date = '2026-10-20', status = 'APPROVED' }) {
  counter += 1;
  const net = gross + tax;
  const [[inv]] = await sequelize.query(`INSERT INTO purchase_invoices ("companyId", "voucherNo", "invoiceDate", "vendorId", "billNo", "grossAmount", "taxAmount", "netAmount", status, "approvedAt")
    VALUES (:c, :n, :date, :vendor, :billNo, :gross, :tax, :net, :status, :approvedAt) RETURNING id`,
  { replacements: { c: w.company.id, n: counter, date, vendor: vendor.id, billNo, gross, tax, net, status, approvedAt: status === 'APPROVED' ? new Date() : null } });
  if (status === 'APPROVED') {
    await w.post({ entryDate: date, sourceType: 'PURCHASE_INVOICE', sourceId: inv.id, narration: `Purchase invoice ${counter}`, lines: [
      { accountId: await w.id('5001'), debit: gross }, ...(tax ? [{ accountId: await w.id('1104'), debit: tax }] : []), { accountId: await w.id('2101'), credit: net, partyType: 'VENDOR', partyId: vendor.id },
    ] });
  }
  return { id: inv.id, net, gross, tax, no: counter };
}

const payment = (w, body) => w.api('post', '/payment-vouchers', body);
const receipt = (w, body) => w.api('post', '/receipt-vouchers', body);

// ---------------------------------------------------------------------------------------------------------------------------------- payments

test('payment voucher: options and the bills that can be paid', async () => {
  const w = await setup();
  const a = await w.vendor('NEXUS CHEMICAL');
  const b = await w.vendor('DYES CO');
  const i1 = await purchaseInvoice(w, a, { gross: 5000, tax: 900, billNo: 'S-1' });
  const i2 = await purchaseInvoice(w, a, { gross: 1000, billNo: 'S-2' });
  const paid = await purchaseInvoice(w, a, { gross: 100, billNo: 'S-3' });
  await sql('UPDATE purchase_invoices SET "paidAmount" = "netAmount" WHERE id = :id', { id: paid.id });
  await purchaseInvoice(w, a, { gross: 300, billNo: 'S-4', status: 'UNAPPROVED' });
  await purchaseInvoice(w, b, { gross: 700, billNo: 'D-1' });

  const options = await ok(w.api('get', '/payment-vouchers/options'), 200);
  expect(options.modes.map((m) => m.code)).toEqual(['CASH', 'CHEQUE', 'ONLINE', 'PAY_ORDER']);
  expect(options.payFromAccounts.map((x) => [x.code, x.name, x.controlType])).toEqual([['1101', 'Cash in Hand', 'CASH'], ['1102', 'Bank Account', 'BANK']]);
  expect(options.incomeTaxRates).toContain(0.25);

  const bills = await ok(w.api('get', `/payment-vouchers/bills?vendorId=${a.id}`), 200);
  expect(bills.total).toBe(2); // not the paid one, not the draft, not the other vendor's
  expect(bills.data[0]).toMatchObject({ purchaseInvoiceId: i1.id, billNo: 'S-1', net: 5900, paid: 0, balance: 5900 });
  expect(bills.data[0].ageDays).toBeGreaterThan(0);
  expect(bills.data[1]).toMatchObject({ purchaseInvoiceId: i2.id, balance: 1000 });
  expect((await ok(w.api('get', `/payment-vouchers/bills?vendorId=${a.id}&search=S-2`), 200)).data.map((x) => x.billNo)).toEqual(['S-2']);
});

test('payment voucher: a draft works out the withholding and touches nothing', async () => {
  const w = await setup();
  const a = await w.vendor('NEXUS CHEMICAL');
  const i1 = await purchaseInvoice(w, a, { gross: 5000, tax: 900, billNo: 'S-1' });
  const i2 = await purchaseInvoice(w, a, { gross: 1000, billNo: 'S-2' });
  const bank = await w.id('1102');
  const v = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'CHEQUE', chequeNo: '000123', chequeDate: '2026-10-26', voucherDate: '2026-10-26', taxSection: '153(1)(a)', incomeTaxRate: 0.25, notes: 'October',
    lines: [{ purchaseInvoiceId: i1.id, amount: '5900.00' }, { purchaseInvoiceId: i2.id, amount: 500 }, { advance: true, amount: '600', notes: 'for the next order' }] }));
  expect(v).toMatchObject({
    voucherNo: 1, voucherLabel: '00001', status: 'DRAFT', statusText: 'Draft', paymentMode: 'CHEQUE', chequeNo: '000123', incomeTaxRate: 0.25, taxSection: '153(1)(a)',
    billsTotal: 7000, incomeTax: 17.5, net: 6982.5, typeText: 'Bill + Advance', canEdit: true, canConfirm: true, canUnconfirm: false, vendor: { name: 'NEXUS CHEMICAL' }, payFrom: { code: '1102', name: 'Bank Account' },
  });
  expect(v.lines.map((l) => [l.kind, l.billNo, l.amount, l.billBalance])).toEqual([['BILL', 'S-1', 5900, 5900], ['BILL', 'S-2', 500, 1000], ['ADVANCE', null, 600, null]]);
  // nothing happened to the bills or the books
  expect((await sql('SELECT SUM("paidAmount")::float AS paid FROM purchase_invoices WHERE "companyId" = :c', { c: w.company.id }))[0].paid).toBe(0);
  expect((await sql(`SELECT count(*)::int AS n FROM journal_entries WHERE "sourceType" = 'PAYMENT_VOUCHER' AND "companyId" = :c`, { c: w.company.id }))[0].n).toBe(0);

  // change it: no withholding, one bill
  const changed = await ok(w.api('patch', `/payment-vouchers/${v.id}`, { incomeTaxRate: 0, lines: [{ purchaseInvoiceId: i2.id, amount: 1000 }], paymentMode: 'ONLINE' }), 200);
  expect(changed).toMatchObject({ billsTotal: 1000, incomeTax: 0, net: 1000, paymentMode: 'ONLINE', typeText: 'Bill' });
  // delete a draft
  expect((await w.api('delete', `/payment-vouchers/${v.id}`)).status).toBe(204);
  expect((await w.api('get', `/payment-vouchers/${v.id}`)).status).toBe(404);
  // a deleted draft frees its number (numbers are max + 1)
  expect((await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'CASH', lines: [{ advance: true, amount: 10 }] }))).voucherNo).toBe(1);
});

test('payment voucher: wrong lines and accounts are refused', async () => {
  const w = await setup();
  const a = await w.vendor('NEXUS CHEMICAL');
  const b = await w.vendor('DYES CO');
  const i1 = await purchaseInvoice(w, a, { gross: 1000, billNo: 'S-1' });
  const other = await purchaseInvoice(w, b, { gross: 500, billNo: 'D-1' });
  const draftBill = await purchaseInvoice(w, a, { gross: 200, billNo: 'S-9', status: 'UNAPPROVED' });
  const bank = await w.id('1102');
  const base = { vendorId: a.id, payFromAccountId: bank, paymentMode: 'CASH' };
  const error = await fails(payment(w, { ...base, lines: [{ purchaseInvoiceId: i1.id, amount: 1000.01 }] }), 422, 'MORE_THAN_BALANCE');
  expect(error.details).toMatchObject({ balance: 1000, amount: 1000.01, purchaseInvoiceId: i1.id });
  await fails(payment(w, { ...base, lines: [{ purchaseInvoiceId: other.id, amount: 10 }] }), 422, 'BILL_OTHER_VENDOR');
  await fails(payment(w, { ...base, lines: [{ purchaseInvoiceId: draftBill.id, amount: 10 }] }), 422, 'BILL_NOT_APPROVED');
  await fails(payment(w, { ...base, lines: [{ purchaseInvoiceId: i1.id, amount: 10 }, { purchaseInvoiceId: i1.id, amount: 20 }] }), 422, 'DUPLICATE_BILL');
  await fails(payment(w, { ...base, lines: [{ purchaseInvoiceId: '6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11', amount: 10 }] }), 404, 'NOT_FOUND');
  await fails(payment(w, { ...base, payFromAccountId: await w.id('1103'), lines: [{ advance: true, amount: 10 }] }), 422, 'NOT_BANK_OR_CASH');
  await fails(payment(w, { ...base, payFromAccountId: await w.id('1100'), lines: [{ advance: true, amount: 10 }] }), 422, 'NOT_POSTING_ACCOUNT');
  await fails(payment(w, { ...base, payFromAccountId: '6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11', lines: [{ advance: true, amount: 10 }] }), 404, 'NOT_FOUND');
  await fails(payment(w, { ...base, vendorId: '6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11', lines: [{ advance: true, amount: 10 }] }), 404, 'NOT_FOUND');
  await Account.update({ isActive: false }, { where: { id: await w.id('1101') } });
  await fails(payment(w, { ...base, payFromAccountId: await w.id('1101'), lines: [{ advance: true, amount: 10 }] }), 422, 'ACCOUNT_INACTIVE');
  // shape errors
  await fails(payment(w, { ...base, lines: [] }), 400, 'VALIDATION_FAILED');
  await fails(payment(w, base), 400, 'VALIDATION_FAILED');
  await fails(payment(w, { ...base, lines: [{ advance: true, amount: '1.234' }] }), 400, 'VALIDATION_FAILED');
  await fails(payment(w, { ...base, lines: [{ advance: true, amount: 0 }] }), 422, 'BAD_AMOUNT');
  await fails(payment(w, { ...base, lines: [{ advance: true, amount: -5 }] }), 400, 'VALIDATION_FAILED');
  await fails(payment(w, { ...base, incomeTaxRate: 100, lines: [{ advance: true, amount: 10 }] }), 400, 'VALIDATION_FAILED');
  await fails(payment(w, { ...base, paymentMode: 'BARTER', lines: [{ advance: true, amount: 10 }] }), 400, 'VALIDATION_FAILED');
  await fails(payment(w, { ...base, lines: [{ purchaseInvoiceId: i1.id, advance: true, amount: 10 }] }), 400, 'VALIDATION_FAILED'); // a line is a bill OR an advance
});

test('payment voucher: confirm posts the entry and pays the bills; move to draft undoes it; two drafts cannot pay the same money twice', async () => {
  const w = await setup();
  const a = await w.vendor('NEXUS CHEMICAL');
  const i1 = await purchaseInvoice(w, a, { gross: 5000, tax: 900, billNo: 'S-1' });
  const i2 = await purchaseInvoice(w, a, { gross: 1000, billNo: 'S-2' });
  const bank = await w.id('1102');
  const v = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'CHEQUE', chequeNo: '777', voucherDate: '2026-10-26', incomeTaxRate: 0.25,
    lines: [{ purchaseInvoiceId: i1.id, amount: 5900 }, { purchaseInvoiceId: i2.id, amount: 500 }, { advance: true, amount: 600 }] }));

  const done = await ok(w.api('post', `/payment-vouchers/${v.id}/confirm`), 200);
  expect(done).toMatchObject({ status: 'CONFIRMED', statusText: 'Confirmed', canEdit: false, canDelete: false, canConfirm: false, canUnconfirm: true, billsTotal: 7000, incomeTax: 17.5, net: 6982.5 });
  const entry = (await ok(w.api('get', `/payment-vouchers/${v.id}/accounts-entry`), 200));
  expect(entry).toMatchObject({ posted: true, status: 'CONFIRMED' });
  expect(entry.current).toMatchObject({ balanced: true, totals: { debit: 7000, credit: 7000 }, entryDate: '2026-10-26', sourceType: 'PAYMENT_VOUCHER', sourceId: v.id });
  expect(entry.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([
    ['Accounts Payable', 5900, 0, 'VENDOR'], ['Accounts Payable', 500, 0, 'VENDOR'], ['Supplier Advances', 600, 0, 'VENDOR'], ['Income Tax - Vendors', 0, 17.5, null], ['Bank Account', 0, 6982.5, null],
  ]);
  expect(entry.current.narration).toContain('cheque 777');

  // the bills are paid
  const bill1 = await ok(w.api('get', `/purchase-invoices/${i1.id}`), 200);
  const bill2 = await ok(w.api('get', `/purchase-invoices/${i2.id}`), 200);
  expect(bill1).toMatchObject({ paid: 5900, balance: 0, paymentStatus: 'PAID', canUnapprove: false });
  expect(bill2).toMatchObject({ paid: 500, balance: 500, paymentStatus: 'PARTIAL' });
  expect(bill1.payments).toEqual([expect.objectContaining({ voucherNo: 1, voucherLabel: '00001', voucherDate: '2026-10-26', paymentMode: 'CHEQUE', chequeNo: '777', amount: 5900 })]);
  await fails(w.api('post', `/purchase-invoices/${i1.id}/unapprove`, {}), 422, 'HAS_PAYMENTS');
  await fails(w.api('patch', `/payment-vouchers/${v.id}`, { notes: 'x' }), 422, 'VOUCHER_CONFIRMED');
  await fails(w.api('delete', `/payment-vouchers/${v.id}`), 422, 'VOUCHER_CONFIRMED');
  await fails(w.api('post', `/payment-vouchers/${v.id}/confirm`), 422, 'ALREADY_CONFIRMED');
  expect((await ok(w.api('get', `/payment-vouchers/bills?vendorId=${a.id}`), 200)).data.map((x) => [x.billNo, x.balance])).toEqual([['S-2', 500]]);

  // move to draft: reversed, paid back to nothing
  const back = await ok(w.api('post', `/payment-vouchers/${v.id}/unconfirm`, { reason: 'wrong cheque' }), 200);
  expect(back).toMatchObject({ status: 'DRAFT', canEdit: true });
  const after = await ok(w.api('get', `/payment-vouchers/${v.id}/accounts-entry`), 200);
  expect(after.posted).toBe(false);
  expect(after.entries.map((e) => [e.entryNo > 0, e.status, Boolean(e.reversalOfId)])).toEqual([[true, 'REVERSED', false], [true, 'POSTED', true]]);
  expect(after.entries[1].narration).toContain('wrong cheque');
  expect((await ok(w.api('get', `/purchase-invoices/${i1.id}`), 200))).toMatchObject({ paid: 0, paymentStatus: 'UNPAID', payments: [] });
  await fails(w.api('post', `/payment-vouchers/${v.id}/unconfirm`, {}), 422, 'NOT_CONFIRMED');
  // and the bill can be un-approved again, because nothing was paid
  expect((await w.api('post', `/purchase-invoices/${i1.id}/unapprove`, {})).status).toBe(200);

  // two drafts of 800 against a bill with 1,000 left: the second one fails when it is confirmed
  const x = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'ONLINE', lines: [{ purchaseInvoiceId: i2.id, amount: 800 }] }));
  const y = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'ONLINE', lines: [{ purchaseInvoiceId: i2.id, amount: 800 }] }));
  await ok(w.api('post', `/payment-vouchers/${x.id}/confirm`), 200);
  const error = await fails(w.api('post', `/payment-vouchers/${y.id}/confirm`), 422, 'MORE_THAN_BALANCE');
  expect(error.details).toMatchObject({ balance: 200, amount: 800 });
  expect((await ok(w.api('get', `/purchase-invoices/${i2.id}`), 200)).paid).toBe(800);
  expect((await ok(w.api('get', `/payment-vouchers/${y.id}`), 200)).status).toBe('DRAFT');
  // the last 200 of the bill
  const z = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'ONLINE', lines: [{ purchaseInvoiceId: i2.id, amount: 200 }] }));
  await ok(w.api('post', `/payment-vouchers/${z.id}/confirm`), 200);
  expect((await ok(w.api('get', `/purchase-invoices/${i2.id}`), 200))).toMatchObject({ paid: 1000, balance: 0, paymentStatus: 'PAID' });
});

test('payment voucher: the trial balance follows it, and the checks catch a voucher or an invoice that disagrees', async () => {
  const w = await setup();
  const a = await w.vendor('NEXUS CHEMICAL');
  const i1 = await purchaseInvoice(w, a, { gross: 5000, tax: 900, billNo: 'S-1' });
  const i2 = await purchaseInvoice(w, a, { gross: 1000, billNo: 'S-2' });
  const bank = await w.id('1102');
  const v = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'CHEQUE', voucherDate: '2026-10-26', incomeTaxRate: 0.25,
    lines: [{ purchaseInvoiceId: i1.id, amount: 5900 }, { purchaseInvoiceId: i2.id, amount: 500 }, { advance: true, amount: 600 }] }));
  let t = await tb(w);
  expect(t.checks.map((c) => [c.key, c.ok])).toEqual(OK_CHECKS.map((k) => [k, true]));
  const before = row(t, 'Accounts Payable');
  expect(before).toMatchObject({ closingCredit: '6900.00' }); // the two bills, nothing paid yet

  await ok(w.api('post', `/payment-vouchers/${v.id}/confirm`), 200);
  t = await tb(w);
  expect(row(t, 'Accounts Payable')).toMatchObject({ periodDebit: '6400.00', periodCredit: '6900.00', closingCredit: '500.00', closingDebit: '0.00' });
  expect(row(t, 'Supplier Advances')).toMatchObject({ periodDebit: '600.00', closingDebit: '600.00' });
  expect(row(t, 'Income Tax - Vendors')).toMatchObject({ periodCredit: '17.50', closingCredit: '17.50' });
  expect(row(t, 'Bank Account')).toMatchObject({ periodCredit: '6982.50', closingCredit: '6982.50' });
  expect(t).toMatchObject({ balanced: true, ok: true });
  const control = t.checks.find((c) => c.key === 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS');
  // every control account is listed (receivable and customer advances are empty); payable and supplier advances agree with the vendor's own total
  expect(control.accounts.map((x) => [x.name, x.glBalance, x.glSide, x.subledgerBalance, x.ok])).toEqual([
    ['Accounts Receivable', '0.00', null, '0.00', true], ['Supplier Advances', '600.00', 'DEBIT', '600.00', true], ['Accounts Payable', '500.00', 'CREDIT', '500.00', true], ['Customer Advances', '0.00', null, '0.00', true],
  ]);
  const led = await ok(w.api('get', `/accounting/ledger?accountId=${await w.id('2101')}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);
  expect(led.lines.filter((l) => l.sourceType === 'PAYMENT_VOUCHER').map((l) => [l.debit, l.partyName])).toEqual([['5900.00', 'NEXUS CHEMICAL'], ['500.00', 'NEXUS CHEMICAL']]);

  // a confirmed voucher without an entry, and an invoice that says more was paid than the vouchers settled
  await sql(`UPDATE payment_vouchers SET status = 'CONFIRMED' WHERE id = :id`, { id: (await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'CASH', lines: [{ advance: true, amount: 5 }] }))).id });
  await sql('UPDATE purchase_invoices SET "paidAmount" = "paidAmount" + 1 WHERE id = :id', { id: i2.id });
  t = await tb(w);
  expect(t.ok).toBe(false);
  const mismatch = t.checks.find((c) => c.key === 'PAYMENT_VOUCHERS_MATCH_LEDGER');
  expect(mismatch.mismatches).toEqual([expect.objectContaining({ voucherNo: 2, reason: 'CONFIRMED_WITHOUT_ENTRY' })]);
  const settle = t.checks.find((c) => c.key === 'INVOICE_PAYMENTS_MATCH_VOUCHERS');
  expect(settle.ok).toBe(false);
  expect(settle.mismatches).toEqual([expect.objectContaining({ kind: 'PURCHASE', invoiceNo: i2.no, invoiceSays: '501.00', vouchersSettled: '500.00' })]);
  expect(t.balanced).toBe(true);
});

test('payment voucher: the accounts it posts to are made when it is saved', async () => {
  const w = await setup({ template: false });
  await ok(w.api('post', '/accounts', { name: 'Assets', accountType: 'ASSET', isGroup: true }));
  const assets = (await Account.findOne({ where: { companyId: w.company.id, name: 'Assets' } })).id;
  const bank = await ok(w.api('post', '/accounts', { name: 'Meezan Bank', parentId: assets, controlType: 'BANK' }));
  const a = await w.vendor('NEXUS CHEMICAL');
  expect(await Account.count({ where: { companyId: w.company.id, isSystem: true } })).toBe(0);
  const v = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank.id, paymentMode: 'ONLINE', incomeTaxRate: 1, lines: [{ advance: true, amount: 1000 }] }));
  const made = await Account.findAll({ where: { companyId: w.company.id, isSystem: true }, raw: true });
  expect(made.map((x) => x.systemKey).sort()).toEqual(['INCOME_TAX_VENDORS', 'SUPPLIER_ADVANCES']); // no bills: no payable account needed
  expect(made.find((x) => x.systemKey === 'SUPPLIER_ADVANCES')).toMatchObject({ name: 'Supplier Advances', accountType: 'ASSET' });
  expect(made.find((x) => x.systemKey === 'INCOME_TAX_VENDORS')).toMatchObject({ name: 'Income Tax - Vendors', accountType: 'LIABILITY' });
  const done = await ok(w.api('post', `/payment-vouchers/${v.id}/confirm`), 200);
  expect(done).toMatchObject({ billsTotal: 1000, incomeTax: 10, net: 990 });
  const entry = await ok(w.api('get', `/payment-vouchers/${v.id}/accounts-entry`), 200);
  expect(entry.current.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Supplier Advances', 1000, 0], ['Income Tax - Vendors', 0, 10], ['Meezan Bank', 0, 990]]);
});

// ---------------------------------------------------------------------------------------------------------------------------------- receipts

test('receipt voucher: the invoices that can be received, the income tax withheld, a draft touches nothing', async () => {
  const w = await setup();
  const c = await w.customer('AZ TEXTILES');
  const other = await w.customer('HAMID ENTERPRISES');
  const s1 = await salesInvoice(w, c, { gross: 10000 }); // net 11,800
  const s2 = await salesInvoice(w, c, { gross: 1000 }); // net 1,180
  await salesInvoice(w, c, { gross: 500, status: 'UNAPPROVED' });
  await salesInvoice(w, other, { gross: 900 });
  const invoices = await ok(w.api('get', `/receipt-vouchers/invoices?customerId=${c.id}`), 200);
  expect(invoices.data.map((x) => [x.salesInvoiceId, x.net, x.balance])).toEqual([[s1.id, 11800, 11800], [s2.id, 1180, 1180]]);
  expect((await ok(w.api('get', '/receipt-vouchers/options'), 200)).depositAccounts.map((x) => x.code)).toEqual(['1101', '1102']);

  const bank = await w.id('1102');
  const v = await ok(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CHEQUE', chequeNo: '556', voucherDate: '2026-10-26',
    lines: [{ salesInvoiceId: s1.id, chequeAmount: '9800.00', incomeTaxRate: 2 }, { salesInvoiceId: s2.id, chequeAmount: 100, incomeTaxRate: 1.5 }, { advance: true, chequeAmount: 1000 }] }));
  expect(v).toMatchObject({ voucherNo: 1, status: 'DRAFT', typeText: 'Invoice + Advance', grandTotal: 11101.52, incomeTax: 201.52, net: 10900, customer: { name: 'AZ TEXTILES' }, depositInto: { code: '1102' }, canConfirm: true });
  // cheque + income tax = bill amount; income tax = cheque x rate / (100 - rate), half a paisa up
  expect(v.lines.map((l) => [l.kind, l.chequeAmount, l.incomeTaxRate, l.incomeTax, l.billAmount, l.invoiceBalance])).toEqual([
    ['BILL', 9800, 2, 200, 10000, 11800], ['BILL', 100, 1.5, 1.52, 101.52, 1180], ['ADVANCE', 1000, 0, 0, 1000, null],
  ]);
  expect((await sql('SELECT SUM("receivedAmount")::float AS r FROM sales_invoices WHERE "companyId" = :c', { c: w.company.id }))[0].r).toBe(0);
});

test('receipt voucher: wrong lines and accounts are refused', async () => {
  const w = await setup();
  const c = await w.customer('AZ TEXTILES');
  const other = await w.customer('HAMID ENTERPRISES');
  const s1 = await salesInvoice(w, c, { gross: 1000, taxRate: 0 });
  const foreign = await salesInvoice(w, other, { gross: 500, taxRate: 0 });
  const draftInvoice = await salesInvoice(w, c, { gross: 200, taxRate: 0, status: 'UNAPPROVED' });
  const bank = await w.id('1102');
  const base = { customerId: c.id, depositAccountId: bank, paymentMode: 'CASH' };
  // the invoice is settled by the cheque PLUS the tax: 1,000 + 2 % tax is more than the 1,000 left
  const error = await fails(receipt(w, { ...base, lines: [{ salesInvoiceId: s1.id, chequeAmount: 1000, incomeTaxRate: 2 }] }), 422, 'MORE_THAN_BALANCE');
  expect(error.details).toMatchObject({ balance: 1000, amount: 1020.41 });
  await ok(receipt(w, { ...base, lines: [{ salesInvoiceId: s1.id, chequeAmount: 980, incomeTaxRate: 2 }] })); // 980 + 20 = exactly 1,000
  await fails(receipt(w, { ...base, lines: [{ salesInvoiceId: foreign.id, chequeAmount: 10 }] }), 422, 'INVOICE_OTHER_CUSTOMER');
  await fails(receipt(w, { ...base, lines: [{ salesInvoiceId: draftInvoice.id, chequeAmount: 10 }] }), 422, 'INVOICE_NOT_APPROVED');
  await fails(receipt(w, { ...base, lines: [{ salesInvoiceId: s1.id, chequeAmount: 10 }, { salesInvoiceId: s1.id, chequeAmount: 20 }] }), 422, 'DUPLICATE_INVOICE');
  await fails(receipt(w, { ...base, depositAccountId: await w.id('4001'), lines: [{ advance: true, chequeAmount: 10 }] }), 422, 'NOT_BANK_OR_CASH');
  await fails(receipt(w, { ...base, customerId: '6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11', lines: [{ advance: true, chequeAmount: 10 }] }), 404, 'NOT_FOUND');
  await fails(receipt(w, { ...base, lines: [{ advance: true, chequeAmount: 10, incomeTaxRate: 100 }] }), 400, 'VALIDATION_FAILED');
  await fails(receipt(w, { ...base, lines: [{ advance: true, chequeAmount: '1.234' }] }), 400, 'VALIDATION_FAILED');
  await fails(receipt(w, { ...base, lines: [] }), 400, 'VALIDATION_FAILED');
  await fails(receipt(w, { ...base, lines: [{ chequeAmount: 10 }] }), 400, 'VALIDATION_FAILED'); // an invoice or an advance
});

test('receipt voucher: confirm posts the entry and receives the invoices; move to draft undoes it', async () => {
  const w = await setup();
  const c = await w.customer('AZ TEXTILES');
  const s1 = await salesInvoice(w, c, { gross: 10000 }); // net 11,800
  const bank = await w.id('1102');
  const v = await ok(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CHEQUE', chequeNo: '556', voucherDate: '2026-10-26',
    lines: [{ salesInvoiceId: s1.id, chequeAmount: 9800, incomeTaxRate: 2 }, { advance: true, chequeAmount: 1000 }] }));
  const done = await ok(w.api('post', `/receipt-vouchers/${v.id}/confirm`), 200);
  expect(done).toMatchObject({ status: 'CONFIRMED', canUnconfirm: true, grandTotal: 11000, incomeTax: 200, net: 10800 });
  const entry = await ok(w.api('get', `/receipt-vouchers/${v.id}/accounts-entry`), 200);
  expect(entry.current).toMatchObject({ balanced: true, totals: { debit: 11000, credit: 11000 }, sourceType: 'RECEIPT_VOUCHER' });
  expect(entry.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([
    ['Bank Account', 10800, 0, null], ['Income Tax - Customers', 200, 0, null], ['Accounts Receivable', 0, 10000, 'CUSTOMER'], ['Customer Advances', 0, 1000, 'CUSTOMER'],
  ]);
  const inv = await ok(w.api('get', `/sales-invoices/${s1.id}`), 200);
  expect(inv).toMatchObject({ received: 10000, balance: 1800, paymentStatus: 'PARTIAL', canUnapprove: false });
  expect(inv.payments).toEqual([expect.objectContaining({ voucherNo: 1, voucherLabel: '00001', paymentMode: 'CHEQUE', chequeNo: '556', chequeAmount: 9800, incomeTax: 200, billAmount: 10000 })]);
  await fails(w.api('post', `/sales-invoices/${s1.id}/unapprove`, {}), 422, 'HAS_RECEIPTS');
  await fails(w.api('patch', `/receipt-vouchers/${v.id}`, { notes: 'x' }), 422, 'VOUCHER_CONFIRMED');
  await fails(w.api('delete', `/receipt-vouchers/${v.id}`), 422, 'VOUCHER_CONFIRMED');

  // the rest, paid in cash without tax: the invoice is PAID
  const rest = await ok(receipt(w, { customerId: c.id, depositAccountId: await w.id('1101'), paymentMode: 'CASH', lines: [{ salesInvoiceId: s1.id, chequeAmount: 1800 }] }));
  await ok(w.api('post', `/receipt-vouchers/${rest.id}/confirm`), 200);
  expect(await ok(w.api('get', `/sales-invoices/${s1.id}`), 200)).toMatchObject({ received: 11800, balance: 0, paymentStatus: 'PAID' });
  expect((await ok(w.api('get', `/receipt-vouchers/invoices?customerId=${c.id}`), 200)).total).toBe(0);
  await fails(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CASH', lines: [{ salesInvoiceId: s1.id, chequeAmount: 1 }] }), 422, 'MORE_THAN_BALANCE');

  // move the first voucher to draft: reversed, received goes back
  const back = await ok(w.api('post', `/receipt-vouchers/${v.id}/unconfirm`, { reason: 'cheque bounced' }), 200);
  expect(back.status).toBe('DRAFT');
  expect(await ok(w.api('get', `/sales-invoices/${s1.id}`), 200)).toMatchObject({ received: 1800, balance: 10000, paymentStatus: 'PARTIAL' });
  const after = await ok(w.api('get', `/receipt-vouchers/${v.id}/accounts-entry`), 200);
  expect(after.posted).toBe(false);
  expect(after.entries.map((e) => [e.status, Boolean(e.reversalOfId)])).toEqual([['REVERSED', false], ['POSTED', true]]);
});

test('receipt voucher: the trial balance follows it, and the customer total agrees with the control account', async () => {
  const w = await setup();
  const c = await w.customer('AZ TEXTILES');
  const s1 = await salesInvoice(w, c, { gross: 10000 });
  const v = await ok(receipt(w, { customerId: c.id, depositAccountId: await w.id('1102'), paymentMode: 'CHEQUE', voucherDate: '2026-10-26',
    lines: [{ salesInvoiceId: s1.id, chequeAmount: 9800, incomeTaxRate: 2 }, { advance: true, chequeAmount: 1000 }] }));
  await ok(w.api('post', `/receipt-vouchers/${v.id}/confirm`), 200);
  const t = await tb(w);
  expect(row(t, 'Bank Account')).toMatchObject({ periodDebit: '10800.00', closingDebit: '10800.00' });
  expect(row(t, 'Income Tax - Customers')).toMatchObject({ periodDebit: '200.00' });
  expect(row(t, 'Accounts Receivable')).toMatchObject({ periodDebit: '11800.00', periodCredit: '10000.00', closingDebit: '1800.00' });
  expect(row(t, 'Customer Advances')).toMatchObject({ periodCredit: '1000.00', closingCredit: '1000.00' });
  expect(t).toMatchObject({ balanced: true, ok: true });
  expect(t.checks.map((c2) => [c2.key, c2.ok])).toEqual(OK_CHECKS.map((k) => [k, true]));
  const control = t.checks.find((c2) => c2.key === 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS');
  expect(control.accounts.map((x) => [x.name, x.glBalance, x.subledgerBalance, x.ok])).toEqual([
    ['Accounts Receivable', '1800.00', '1800.00', true], ['Supplier Advances', '0.00', '0.00', true], ['Accounts Payable', '0.00', '0.00', true], ['Customer Advances', '1000.00', '1000.00', true],
  ]);

  await sql('UPDATE sales_invoices SET "receivedAmount" = 0 WHERE id = :id', { id: s1.id });
  const bad = await tb(w);
  const settle = bad.checks.find((c2) => c2.key === 'INVOICE_PAYMENTS_MATCH_VOUCHERS');
  expect(settle.ok).toBe(false);
  expect(settle.mismatches).toEqual([expect.objectContaining({ kind: 'SALES', invoiceSays: '0.00', vouchersSettled: '10000.00' })]);
});

// ---------------------------------------------------------------------------------------------------------------------------------- journal vouchers

test('journal voucher: a cash-to-bank transfer, draft then confirmed, and the trial balance', async () => {
  const w = await setup();
  const jv = (body) => w.api('post', '/journal-vouchers', body);
  const cash = await w.id('1101');
  const bank = await w.id('1102');
  expect((await ok(w.api('get', '/journal-vouchers/options'), 200)).partyControlTypes.map((p) => p.controlType).sort()).toEqual(['CUSTOMERS', 'CUSTOMER_ADVANCES', 'SUPPLIERS', 'SUPPLIER_ADVANCES']);

  // money into the cash box first (the capital), then the transfer
  await w.post({ entryDate: '2026-10-01', sourceType: 'TEST', lines: [{ accountId: cash, debit: 8000 }, { accountId: await w.id('3001'), credit: 8000 }] });
  const v = await ok(jv({ voucherDate: '2026-10-26', reference: 'DEP-1', narration: 'Cash deposited in the bank', lines: [{ accountId: bank, debit: 5000, narration: 'deposit' }, { accountId: cash, credit: '5000.00' }] }));
  expect(v).toMatchObject({ voucherNo: 1, voucherLabel: '00001', status: 'DRAFT', reference: 'DEP-1', total: 5000, lineCount: 2, balanced: true, totals: { debit: 5000, credit: 5000 }, canConfirm: true });
  expect(v.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Bank Account', 5000, 0], ['Cash in Hand', 0, 5000]]);
  expect(row(await tb(w), 'Bank Account')).toBeUndefined(); // a draft is not in the books

  const done = await ok(w.api('post', `/journal-vouchers/${v.id}/confirm`), 200);
  expect(done.status).toBe('CONFIRMED');
  const entry = await ok(w.api('get', `/journal-vouchers/${v.id}/accounts-entry`), 200);
  expect(entry.current).toMatchObject({ balanced: true, totals: { debit: 5000, credit: 5000 }, sourceType: 'JOURNAL_VOUCHER', entryDate: '2026-10-26' });
  expect(entry.current.narration).toContain('DEP-1');
  const t = await tb(w);
  expect(row(t, 'Bank Account')).toMatchObject({ periodDebit: '5000.00', closingDebit: '5000.00' }); // a transfer is not income or expense
  expect(row(t, 'Cash in Hand')).toMatchObject({ periodDebit: '8000.00', periodCredit: '5000.00', closingDebit: '3000.00' });
  expect(t.sections.map((s) => s.accountType)).toEqual(['ASSET', 'EQUITY']);
  expect(t).toMatchObject({ balanced: true, ok: true });
  await fails(w.api('patch', `/journal-vouchers/${v.id}`, { narration: 'x' }), 422, 'VOUCHER_CONFIRMED');
  await fails(w.api('delete', `/journal-vouchers/${v.id}`), 422, 'VOUCHER_CONFIRMED');
  await fails(w.api('post', `/journal-vouchers/${v.id}/confirm`), 422, 'ALREADY_CONFIRMED');

  // move to draft, correct it, confirm again
  expect((await ok(w.api('post', `/journal-vouchers/${v.id}/unconfirm`, { reason: 'wrong amount' }), 200)).status).toBe('DRAFT');
  expect((await ok(w.api('get', `/journal-vouchers/${v.id}/accounts-entry`), 200)).entries.map((e) => [e.status, Boolean(e.reversalOfId)])).toEqual([['REVERSED', false], ['POSTED', true]]);
  const fixed = await ok(w.api('patch', `/journal-vouchers/${v.id}`, { lines: [{ accountId: bank, debit: 4000 }, { accountId: cash, credit: 4000 }] }), 200);
  expect(fixed).toMatchObject({ total: 4000, reference: 'DEP-1' });
  await ok(w.api('post', `/journal-vouchers/${v.id}/confirm`), 200);
  expect(row(await tb(w), 'Bank Account')).toMatchObject({ closingDebit: '4000.00' });
});

test('journal voucher: only balanced lines of real accounts; customer and vendor control accounts name the party', async () => {
  const w = await setup();
  const c = await w.customer('AZ TEXTILES');
  const other = await setup();
  const foreign = await other.customer('SOMEBODY');
  const jv = (lines, extra = {}) => w.api('post', '/journal-vouchers', { lines, ...extra });
  const bank = await w.id('1102');
  const cash = await w.id('1101');
  const rent = await w.id('6001');
  const ar = await w.id('1103');
  const error = await fails(jv([{ accountId: rent, debit: 100 }, { accountId: bank, credit: 99.99 }]), 422, 'UNBALANCED');
  expect(error.details).toEqual({ debit: 100, credit: 99.99, difference: 0.01, side: 'CREDIT' });
  await fails(jv([{ accountId: rent, debit: 100 }]), 400, 'VALIDATION_FAILED'); // at least two lines
  await fails(jv([{ accountId: rent, debit: 100, credit: 100 }, { accountId: bank, credit: 0 }]), 422, 'LINE_ONE_SIDE');
  await fails(jv([{ accountId: rent }, { accountId: bank, credit: 1 }]), 422, 'LINE_ONE_SIDE');
  await fails(jv([{ accountId: await w.id('6000'), debit: 1 }, { accountId: bank, credit: 1 }]), 422, 'NOT_POSTING_ACCOUNT');
  await fails(jv([{ accountId: '6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11', debit: 1 }, { accountId: bank, credit: 1 }]), 422, 'ACCOUNT_NOT_FOUND');
  await fails(jv([{ accountId: await other.id('1102'), debit: 1 }, { accountId: bank, credit: 1 }]), 422, 'ACCOUNT_NOT_FOUND');
  await fails(jv([{ accountId: rent, debit: '1.234' }, { accountId: bank, credit: 1 }]), 400, 'VALIDATION_FAILED');
  await Account.update({ isActive: false }, { where: { id: cash } });
  await fails(jv([{ accountId: cash, debit: 1 }, { accountId: bank, credit: 1 }]), 422, 'ACCOUNT_INACTIVE');

  // receivable / payable lines must name the customer / vendor, other lines must not
  await fails(jv([{ accountId: ar, debit: 100 }, { accountId: await w.id('4001'), credit: 100 }]), 422, 'CONTROL_NEEDS_PARTY');
  await fails(jv([{ accountId: rent, debit: 100, partyId: c.id }, { accountId: bank, credit: 100 }]), 422, 'LINE_BAD_PARTY');
  await fails(jv([{ accountId: ar, debit: 100, partyId: foreign.id }, { accountId: await w.id('4001'), credit: 100 }]), 404, 'NOT_FOUND');
  const ok1 = await ok(jv([{ accountId: ar, debit: 100, partyId: c.id, narration: 'old balance' }, { accountId: await w.id('4001'), credit: 100 }], { voucherDate: '2026-10-26' }));
  expect(ok1.lines[0]).toMatchObject({ partyType: 'CUSTOMER', partyId: c.id, partyName: 'AZ TEXTILES' });
  await ok(w.api('post', `/journal-vouchers/${ok1.id}/confirm`), 200);
  const t = await tb(w);
  expect(t.checks.find((x) => x.key === 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS')).toMatchObject({ ok: true });
  expect(t.ok).toBe(true);

  // a switched-off account makes the draft impossible to confirm
  const draft = await ok(jv([{ accountId: rent, debit: 10 }, { accountId: bank, credit: 10 }]));
  await Account.update({ isActive: false }, { where: { id: rent } });
  await fails(w.api('post', `/journal-vouchers/${draft.id}/confirm`), 422, 'ACCOUNT_INACTIVE');
});

test('journal voucher: the list and its summary, and a confirmed voucher without an entry is reported', async () => {
  const w = await setup();
  const bank = await w.id('1102');
  const cash = await w.id('1101');
  const rent = await w.id('6001');
  const make = (extra) => ok(w.api('post', '/journal-vouchers', extra));
  const a = await make({ voucherDate: '2026-10-20', reference: 'RENT-10', narration: 'October rent', lines: [{ accountId: rent, debit: 300 }, { accountId: bank, credit: 300 }] });
  await make({ voucherDate: '2026-10-22', narration: 'Cash to bank', lines: [{ accountId: bank, debit: 1000 }, { accountId: cash, credit: 1000 }] });
  await ok(w.api('post', `/journal-vouchers/${a.id}/confirm`), 200);
  const all = await ok(w.api('get', '/journal-vouchers'), 200);
  expect(all.data.map((v) => v.voucherNo)).toEqual([2, 1]);
  expect(all.summary).toEqual({ vouchers: 2, totalAmount: 1300 });
  expect((await ok(w.api('get', '/journal-vouchers?status=CONFIRMED'), 200)).data.map((v) => v.voucherNo)).toEqual([1]);
  expect((await ok(w.api('get', '/journal-vouchers?dateFrom=2026-10-21&dateTo=2026-10-31'), 200)).data.map((v) => v.voucherNo)).toEqual([2]);
  expect((await ok(w.api('get', '/journal-vouchers?search=rent'), 200)).data.map((v) => v.voucherNo)).toEqual([1]);
  expect((await ok(w.api('get', '/journal-vouchers?search=RENT-10'), 200)).data.map((v) => v.voucherNo)).toEqual([1]);
  expect((await ok(w.api('get', '/journal-vouchers?search=00002'), 200)).data.map((v) => v.voucherNo)).toEqual([2]);
  expect((await ok(w.api('get', '/journal-vouchers?limit=1&page=2'), 200)).data.map((v) => v.voucherNo)).toEqual([1]);

  await sql(`UPDATE journal_vouchers SET status = 'CONFIRMED' WHERE "voucherNo" = 2 AND "companyId" = :c`, { c: w.company.id });
  const t = await tb(w);
  expect(t.checks.find((c) => c.key === 'JOURNAL_VOUCHERS_MATCH_LEDGER').mismatches).toEqual([expect.objectContaining({ voucherNo: 2, reason: 'CONFIRMED_WITHOUT_ENTRY' })]);
  expect(t.ok).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------------------- access

test('access: each voucher has its own service; VIEW only reads; another company sees nothing', async () => {
  const w = await setup();
  const a = await w.vendor('NEXUS CHEMICAL');
  const bank = await w.id('1102');
  const pv = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'CASH', lines: [{ advance: true, amount: 10 }] }));
  const c = await w.customer('AZ');
  const rv = await ok(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CASH', lines: [{ advance: true, chequeAmount: 10 }] }));
  const jv = await ok(w.api('post', '/journal-vouchers', { lines: [{ accountId: bank, debit: 1 }, { accountId: await w.id('1101'), credit: 1 }] }));

  const employee = async (code, access) => {
    const u = await makeUser({ userType: 'USER', companyId: w.company.id });
    if (access) await UserService.create({ userId: u.id, serviceId: (await Service.findOne({ where: { code } })).id, access });
    return caller(await token(u));
  };
  for (const [path, code, doc] of [['payment-vouchers', 'ACC_PAYMENTS', pv], ['receipt-vouchers', 'ACC_RECEIPTS', rv], ['journal-vouchers', 'ACC_JOURNAL', jv]]) {
    expect((await (await employee(code, null))('get', `/${path}`)).status).toBe(403);
    const viewer = await employee(code, 'VIEW');
    expect((await viewer('get', `/${path}`)).status).toBe(200);
    expect((await viewer('get', `/${path}/${doc.id}/accounts-entry`)).status).toBe(200);
    await fails(viewer('post', `/${path}/${doc.id}/confirm`), 403, 'FORBIDDEN');
    await fails(viewer('delete', `/${path}/${doc.id}`), 403, 'FORBIDDEN');
    const wrongService = await employee(code === 'ACC_JOURNAL' ? 'ACC_PAYMENTS' : 'ACC_JOURNAL', 'FULL'); // the service of ANOTHER voucher does not help
    expect((await wrongService('get', `/${path}`)).status).toBe(403);
    const other = await setup();
    expect((await ok(other.api('get', `/${path}`), 200)).total).toBe(0);
    expect((await other.api('get', `/${path}/${doc.id}`)).status).toBe(404);
    expect((await other.api('post', `/${path}/${doc.id}/confirm`)).status).toBe(404);
    expect((await other.api('delete', `/${path}/${doc.id}`)).status).toBe(404);
  }
  // each voucher has its own number series
  expect([pv.voucherNo, rv.voucherNo, jv.voucherNo]).toEqual([1, 1, 1]);
});
