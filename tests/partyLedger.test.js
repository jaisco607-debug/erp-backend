const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account, Customer, Vendor } = require('../src/models');
const journal = require('../src/services/journalService');

beforeEach(clean);

const SERVICES = ['ACC_COA', 'ACC_PAYMENTS', 'ACC_RECEIPTS', 'ACC_JOURNAL', 'ACC_REPORTS', 'ACC_SALES', 'ACC_PURCHASES', 'ACC_BANK'];
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

/** Vendor A: bills 5900 (10-20) and 1000 (10-22); a confirmed payment of 5900 + an advance of 600 by cheque 000123 on 10-26. */
async function vendorStory(w) {
  const a = await w.vendor('NEXUS CHEMICAL');
  const b = await w.vendor('DYES CO');
  const i1 = await purchaseInvoice(w, a, { gross: 5000, tax: 900, billNo: 'S-1', date: '2026-10-20' });
  await purchaseInvoice(w, a, { gross: 1000, billNo: 'S-2', date: '2026-10-22' });
  const bank = await w.id('1102');
  const v = await ok(payment(w, { vendorId: a.id, payFromAccountId: bank, paymentMode: 'CHEQUE', chequeNo: '000123', chequeDate: '2026-10-26', voucherDate: '2026-10-26',
    lines: [{ purchaseInvoiceId: i1.id, amount: 5900 }, { advance: true, amount: 600 }] }));
  await ok(w.api('post', `/payment-vouchers/${v.id}/confirm`), 200);
  return { a, b, v, bank };
}

test('party ledger of a vendor: running balance, tabs, search, opening balance, other company', async () => {
  const w = await setup();
  const { a, v } = await vendorStory(w);
  const led = await ok(w.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${a.id}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);
  expect(led.party).toMatchObject({ type: 'VENDOR', name: 'NEXUS CHEMICAL' });
  expect(led.opening).toEqual({ balance: '0.00', balanceSide: null });
  expect(led.lines.map((l) => [l.date, l.sourceType, l.debit, l.credit, l.balance, l.balanceSide])).toEqual([
    ['2026-10-20', 'PURCHASE_INVOICE', '0.00', '5900.00', '5900.00', 'CREDIT'],
    ['2026-10-22', 'PURCHASE_INVOICE', '0.00', '1000.00', '6900.00', 'CREDIT'],
    ['2026-10-26', 'PAYMENT_VOUCHER', '5900.00', '0.00', '1000.00', 'CREDIT'],
    ['2026-10-26', 'PAYMENT_VOUCHER', '600.00', '0.00', '400.00', 'CREDIT'],
  ]);
  expect(led.totals).toEqual({ debit: '6500.00', credit: '6900.00' });
  expect(led.closing).toEqual({ balance: '400.00', balanceSide: 'CREDIT' });
  expect(led.kinds).toEqual([{ code: 'PAYMENT_VOUCHER', text: 'Vendor payment', count: 2 }, { code: 'PURCHASE_INVOICE', text: 'Purchase invoice', count: 2 }]);
  // the row knows its document: link target, number, cheque and bill number
  expect(led.lines[0]).toMatchObject({ sourceText: 'Purchase invoice', ref: 'S-1', account: { name: 'Accounts Payable' } });
  expect(led.lines[2]).toMatchObject({ sourceId: v.id, docNo: 1, docLabel: '00001', ref: '000123', chequeNo: '000123', chequeDate: '2026-10-26', account: { name: 'Accounts Payable' } });
  expect(led.lines[3].account.name).toBe('Supplier Advances');

  // tab and search: the running balance stays the real one
  const tab = await ok(w.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${a.id}&dateFrom=2026-10-01&dateTo=2026-10-31&kind=PAYMENT_VOUCHER`), 200);
  expect(tab.shown).toBe(2);
  expect(tab.total).toBe(4);
  expect(tab.lines.map((l) => l.balance)).toEqual(['1000.00', '400.00']);
  const found = await ok(w.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${a.id}&dateFrom=2026-10-01&dateTo=2026-10-31&search=000123`), 200);
  expect(found.shown).toBe(2);

  // a later start: what came before is the opening balance
  const later = await ok(w.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${a.id}&dateFrom=2026-10-23&dateTo=2026-10-31`), 200);
  expect(later.opening).toEqual({ balance: '6900.00', balanceSide: 'CREDIT' });
  expect(later.lines).toHaveLength(2);
  expect(later.closing).toEqual({ balance: '400.00', balanceSide: 'CREDIT' });

  // moving the voucher to draft shows the reversal lines and the same closing balance as before the payment
  await ok(w.api('post', `/payment-vouchers/${v.id}/unconfirm`, {}), 200);
  const back = await ok(w.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${a.id}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);
  expect(back.closing).toEqual({ balance: '6900.00', balanceSide: 'CREDIT' });
  expect(back.lines.filter((l) => l.isReversal)).toHaveLength(2);

  // errors
  await fails(w.api('get', `/accounting/party-ledger?partyType=CUSTOMER&partyId=${a.id}`), 404, 'NOT_FOUND');
  await fails(w.api('get', '/accounting/party-ledger?partyType=VENDOR'), 400, 'VALIDATION_FAILED');
  const other = await setup();
  await fails(other.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${a.id}`), 404, 'NOT_FOUND');
});

test('accounts payables and receivables: one row per party, totals, search, paging, zero balances', async () => {
  const w = await setup();
  const { a, b } = await vendorStory(w);
  const c = await w.customer('AZ TEXTILES');
  const inv = await salesInvoice(w, c, { gross: 10000, date: '2026-10-24' });
  const bank = await w.id('1102');
  const r = await ok(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CASH', voucherDate: '2026-10-26', lines: [{ salesInvoiceId: inv.id, chequeAmount: 9800, incomeTaxRate: 2 }] }));
  await ok(w.api('post', `/receipt-vouchers/${r.id}/confirm`), 200);

  const pay = await ok(w.api('get', '/accounting/payables?date=2026-10-31'), 200);
  expect(pay).toMatchObject({ partyType: 'VENDOR', date: '2026-10-31', page: 1, limit: 20, total: 1 });
  expect(pay.data).toEqual([{ id: a.id, code: a.code, name: 'NEXUS CHEMICAL', ntn: null, cnic: null, debit: '6500.00', credit: '6900.00', balance: '400.00', balanceSide: 'CREDIT' }]);
  expect(pay.totals).toEqual({ debit: '6500.00', credit: '6900.00', balance: '400.00', balanceSide: 'CREDIT' });
  // the date matters: before the payment only the bills exist
  const early = await ok(w.api('get', '/accounting/payables?date=2026-10-21'), 200);
  expect(early.data[0]).toMatchObject({ debit: '0.00', credit: '5900.00', balance: '5900.00', balanceSide: 'CREDIT' });
  // zero balances only when asked, search by name
  const withZero = await ok(w.api('get', '/accounting/payables?date=2026-10-31&includeZero=true'), 200);
  expect(withZero.data.map((x) => x.name)).toEqual(['DYES CO', 'NEXUS CHEMICAL']);
  expect(withZero.data[0]).toMatchObject({ id: b.id, balance: '0.00', balanceSide: null });
  expect((await ok(w.api('get', '/accounting/payables?date=2026-10-31&includeZero=true&search=dyes'), 200)).total).toBe(1);
  expect((await ok(w.api('get', '/accounting/payables?date=2026-10-31&includeZero=true&limit=1&page=2'), 200)).data.map((x) => x.name)).toEqual(['NEXUS CHEMICAL']);

  const rec = await ok(w.api('get', '/accounting/receivables?date=2026-10-31'), 200);
  expect(rec.partyType).toBe('CUSTOMER');
  expect(rec.data).toHaveLength(1);
  // invoice 11800 settled by cheque 9800 + tax 200 on a bill amount of 10000: 1800 left
  expect(rec.data[0]).toMatchObject({ name: 'AZ TEXTILES', debit: '11800.00', credit: '10000.00', balance: '1800.00', balanceSide: 'DEBIT' });
  const view = await ok(w.api('get', `/accounting/party-ledger?partyType=CUSTOMER&partyId=${c.id}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);
  expect(view.closing).toEqual({ balance: '1800.00', balanceSide: 'DEBIT' });
  expect(view.kinds.map((k) => k.code)).toEqual(['RECEIPT_VOUCHER', 'SALES_INVOICE']);
  // the report agrees with the control accounts
  const t = await tb(w);
  expect(t.checks.find((x) => x.key === 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS').ok).toBe(true);
});

test('bank summary: lines with a running balance, clearing dates, uncleared lines, agreeing with the bank', async () => {
  const w = await setup();
  const { v, bank } = await vendorStory(w);
  // 20,000 put into the bank from the cash box on 10-25
  const dep = await ok(w.api('post', '/journal-vouchers', { voucherDate: '2026-10-25', reference: 'DEP', lines: [{ accountId: bank, debit: 20000 }, { accountId: await w.id('1101'), credit: 20000 }] }));
  await ok(w.api('post', `/journal-vouchers/${dep.id}/confirm`), 200);

  expect((await ok(w.api('get', '/accounting/bank-accounts'), 200)).data.map((x) => x.code)).toEqual(['1102']);
  const q = `/accounting/bank-summary?accountId=${bank}&dateFrom=2026-10-01&dateTo=2026-10-31`;
  const s = await ok(w.api('get', q), 200);
  expect(s.account).toMatchObject({ code: '1102' });
  expect(s.lines.map((l) => [l.date, l.sourceType, l.debit, l.credit, l.balance, l.balanceSide, l.cleared, l.canClear])).toEqual([
    ['2026-10-25', 'JOURNAL_VOUCHER', '20000.00', '0.00', '20000.00', 'DEBIT', false, true],
    ['2026-10-26', 'PAYMENT_VOUCHER', '0.00', '6500.00', '13500.00', 'DEBIT', false, true],
  ]);
  expect(s.lines[1]).toMatchObject({ chequeNo: '000123', chequeDate: '2026-10-26', docLabel: '00001' });
  expect(s.closing).toEqual({ balance: '13500.00', balanceSide: 'DEBIT' });
  expect(s.uncleared.count).toBe(2);
  expect(s.reconciliation).toMatchObject({ booksBalance: '13500.00', booksSide: 'DEBIT', unclearedDeposits: '20000.00', unclearedPayments: '6500.00', bankBalance: '0.00', bankSide: null });

  // the cheque clears on 10-28
  const chequeLine = s.lines[1].lineId;
  expect(await ok(w.api('put', '/accounting/bank-clearing', { journalLineId: chequeLine, clearedDate: '2026-10-28' }), 200)).toEqual({ journalLineId: chequeLine, clearedDate: '2026-10-28' });
  const cleared = await ok(w.api('get', q), 200);
  expect(cleared.lines[1]).toMatchObject({ cleared: true, clearedDate: '2026-10-28' });
  expect(cleared.uncleared.lines.map((l) => l.sourceType)).toEqual(['JOURNAL_VOUCHER']);
  expect(cleared.reconciliation).toMatchObject({ unclearedDeposits: '20000.00', unclearedPayments: '0.00', bankBalance: '6500.00', bankSide: 'CREDIT' });
  // cleared after the end of the period still counts as not cleared in that period
  const early = await ok(w.api('get', `/accounting/bank-summary?accountId=${bank}&dateFrom=2026-10-01&dateTo=2026-10-27`), 200);
  expect(early.uncleared.count).toBe(2);
  // status filter, change the date, remove it
  expect((await ok(w.api('get', `${q}&status=CLEARED`), 200)).lines).toHaveLength(1);
  expect((await ok(w.api('get', `${q}&status=UNCLEARED`), 200)).lines).toHaveLength(1);
  await ok(w.api('put', '/accounting/bank-clearing', { journalLineId: chequeLine, clearedDate: '2026-10-29' }), 200);
  expect((await ok(w.api('get', q), 200)).lines[1].clearedDate).toBe('2026-10-29');
  expect((await w.api('delete', `/accounting/bank-clearing/${chequeLine}`)).status).toBe(204);
  expect((await ok(w.api('get', q), 200)).lines[1].cleared).toBe(false);
  await fails(w.api('delete', `/accounting/bank-clearing/${chequeLine}`), 404, 'NOT_FOUND');

  // refused: before the line's own date, a cash line, an unknown line
  await fails(w.api('put', '/accounting/bank-clearing', { journalLineId: chequeLine, clearedDate: '2026-10-20' }), 422, 'CLEARED_BEFORE_ENTRY');
  const [cashLine] = await sql('SELECT l.id FROM journal_lines l WHERE l."accountId" = :a', { a: await w.id('1101') });
  await fails(w.api('put', '/accounting/bank-clearing', { journalLineId: cashLine.id, clearedDate: '2026-10-28' }), 422, 'NOT_BANK_ACCOUNT');
  await fails(w.api('get', `/accounting/bank-summary?accountId=${await w.id('1101')}`), 422, 'NOT_BANK_ACCOUNT');
  await fails(w.api('put', '/accounting/bank-clearing', { journalLineId: '5f1c7d0e-3b1a-4c6e-9d2a-0a1b2c3d4e5f', clearedDate: '2026-10-28' }), 404, 'NOT_FOUND');

  // a voucher moved to draft: its bank lines are reversed and cannot be cleared; they leave the uncleared list
  await ok(w.api('post', `/payment-vouchers/${v.id}/unconfirm`, {}), 200);
  const after = await ok(w.api('get', q), 200);
  expect(after.lines.filter((l) => !l.canClear).length).toBe(2);
  expect(after.uncleared.lines.map((l) => l.sourceType)).toEqual(['JOURNAL_VOUCHER']);
  await fails(w.api('put', '/accounting/bank-clearing', { journalLineId: chequeLine, clearedDate: '2026-10-28' }), 422, 'NOT_CLEARABLE');
});

test('access: the reports need ACC_REPORTS, the bank summary ACC_BANK (VIEW reads, FULL changes)', async () => {
  const w = await setup();
  const { a, bank } = await vendorStory(w);
  // a user of the same company with only VIEW on the bank service
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  for (const [code, access] of [['ACC_BANK', 'VIEW'], ['ACC_REPORTS', 'VIEW']]) await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code } })).id, access });
  const v = caller(await token(viewer));
  await ok(v('get', `/accounting/bank-summary?accountId=${bank}`), 200);
  await ok(v('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${a.id}`), 200);
  await fails(v('put', '/accounting/bank-clearing', { journalLineId: '5f1c7d0e-3b1a-4c6e-9d2a-0a1b2c3d4e5f', clearedDate: '2026-10-28' }), 403, 'FORBIDDEN');
  // nothing at all
  const nobody = await makeUser({ userType: 'USER', companyId: w.company.id });
  const n = caller(await token(nobody));
  for (const url of ['/accounting/payables', '/accounting/receivables', '/accounting/bank-accounts', `/accounting/bank-summary?accountId=${bank}`]) await fails(n('get', url), 403, 'FORBIDDEN');
});

test('party ledger: reversed and reversal lines are paired by entry id, a reversal is dated like its entry, and the lines carry the invoice / voucher details', async () => {
  const w = await setup();
  const { a, v } = await vendorStory(w);
  await sql('UPDATE payment_vouchers SET notes = :notes WHERE id = :id', { notes: 'Cheque to Nexus', id: v.id });
  await sql(`UPDATE purchase_invoices SET "billDetails" = 'Caustic soda 100 kg' WHERE "companyId" = :c AND "billNo" = 'S-1'`, { c: w.company.id });
  await ok(w.api('post', `/payment-vouchers/${v.id}/unconfirm`, { reason: 'wrong cheque' }), 200);
  await ok(w.api('post', `/payment-vouchers/${v.id}/confirm`), 200);
  const led = await ok(w.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${a.id}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);

  // original, its reversal and the new entry all sit on the voucher's date, in order, so the running balance never jumps
  const pay = led.lines.filter((l) => l.sourceType === 'PAYMENT_VOUCHER');
  expect(pay.map((l) => [l.date, l.debit, l.credit, l.balance, l.balanceSide])).toEqual([
    ['2026-10-26', '5900.00', '0.00', '1000.00', 'CREDIT'], ['2026-10-26', '600.00', '0.00', '400.00', 'CREDIT'],
    ['2026-10-26', '0.00', '5900.00', '6300.00', 'CREDIT'], ['2026-10-26', '0.00', '600.00', '6900.00', 'CREDIT'],
    ['2026-10-26', '5900.00', '0.00', '1000.00', 'CREDIT'], ['2026-10-26', '600.00', '0.00', '400.00', 'CREDIT'],
  ]);
  expect(led.closing).toEqual({ balance: '400.00', balanceSide: 'CREDIT' });
  // exact pairing: the original names its reversal, the reversal names the original, the new entry names none
  const [orig, , rev, , fresh] = pay;
  expect(orig).toMatchObject({ reversed: true, isReversal: false, reversedByEntryId: rev.entryId, reversedByEntryNo: rev.entryNo, reversesEntryId: null });
  expect(rev).toMatchObject({ reversed: false, isReversal: true, reversesEntryId: orig.entryId, reversesEntryNo: orig.entryNo, reversedByEntryId: null });
  expect(fresh).toMatchObject({ reversed: false, isReversal: false, reversesEntryId: null, reversedByEntryId: null });
  expect(pay.map((l) => l.reversedByEntryId || l.reversesEntryId)).toEqual([rev.entryId, rev.entryId, orig.entryId, orig.entryId, null, null]);
  // no reversal is dated today
  expect(await sql(`SELECT count(*)::int AS n FROM journal_entries WHERE "companyId" = :c AND "reversalOfId" IS NOT NULL AND "entryDate" <> '2026-10-26'`, { c: w.company.id })).toEqual([{ n: 0 }]);

  // the details of the document come with the line
  const inv = led.lines.find((l) => l.sourceType === 'PURCHASE_INVOICE' && l.ref === 'S-1');
  expect(inv).toMatchObject({ gross: '5000.00', tax: '900.00', othersAmount: '0.00', othersNote: null, notes: null, details: 'Caustic soda 100 kg', voucherNarration: null });
  expect(inv.taxRate).toEqual(expect.any(Number));
  expect(inv.entryNarration).toContain('Purchase invoice');
  expect(pay[0]).toMatchObject({ gross: null, tax: null, taxRate: null, othersAmount: null, details: null, notes: 'Cheque to Nexus' });
});
