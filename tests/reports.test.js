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


const pad = (n) => String(n).padStart(5, '0');

const payment = (w, body) => w.api('post', '/payment-vouchers', body);
const receipt = (w, body) => w.api('post', '/receipt-vouchers', body);
/** A confirmed journal voucher. */
async function jv(w, date, lines) {
  const v = await ok(w.api('post', '/journal-vouchers', { voucherDate: date, lines }));
  await ok(w.api('post', `/journal-vouchers/${v.id}/confirm`), 200);
  return v;
}
const find = (nodes, code) => {
  for (const n of nodes) {
    if (n.code === code) return n;
    const f = find(n.children, code);
    if (f) return f;
  }
  return null;
};

/**
 * Last year (2026-06-15): cash 3000 against other income (profit of an earlier year).
 * 2026-07-01: bank 50000 against the owner's capital.  10-05: a receivable of 500 for customer C against the capital (not an invoice).
 * 10-10 sales invoice 10000 + 18% tax = 11800.  10-12 purchase bill 4000.  10-15 rent 1000.  10-16 sales return 500.
 * 10-20 receipt: cheque 9800 + 2% tax = 10000 of the invoice.  10-22 payment of 1000 to the vendor.
 */
async function story(w) {
  const c = await w.customer('AZ TEXTILES');
  const v = await w.vendor('NEXUS CHEMICAL');
  const bank = await w.id('1102');
  const cash = await w.id('1101');
  await jv(w, '2026-06-15', [{ accountId: cash, debit: 3000 }, { accountId: await w.id('4003'), credit: 3000 }]);
  await jv(w, '2026-07-01', [{ accountId: bank, debit: 50000 }, { accountId: await w.id('3001'), credit: 50000 }]);
  await jv(w, '2026-10-05', [{ accountId: await w.id('1103'), debit: 500, partyId: c.id }, { accountId: await w.id('3001'), credit: 500 }]);
  const inv = await salesInvoice(w, c, { gross: 10000, date: '2026-10-10' });
  const bill = await purchaseInvoice(w, v, { gross: 4000, billNo: 'S-1', date: '2026-10-12' });
  await jv(w, '2026-10-15', [{ accountId: await w.id('6001'), debit: 1000 }, { accountId: cash, credit: 1000 }]);
  await jv(w, '2026-10-16', [{ accountId: await w.id('4002'), debit: 500 }, { accountId: cash, credit: 500 }]);
  const r = await ok(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CHEQUE', chequeNo: '556', voucherDate: '2026-10-20', lines: [{ salesInvoiceId: inv.id, chequeAmount: 9800, incomeTaxRate: 2 }] }));
  await ok(w.api('post', `/receipt-vouchers/${r.id}/confirm`), 200);
  const p = await ok(payment(w, { vendorId: v.id, payFromAccountId: bank, paymentMode: 'ONLINE', voucherDate: '2026-10-22', lines: [{ purchaseInvoiceId: bill.id, amount: 1000 }] }));
  await ok(w.api('post', `/payment-vouchers/${p.id}/confirm`), 200);
  return { c, v, inv, bill };
}

test('profit and loss: revenue, cost of sales, gross profit, expenses, net profit', async () => {
  const w = await setup();
  await story(w);
  const pl = await ok(w.api('get', '/accounting/profit-loss?dateFrom=2026-07-01&dateTo=2026-10-31'), 200);
  expect(pl).toMatchObject({ dateFrom: '2026-07-01', dateTo: '2026-10-31' });
  // sales 10000, the contra account sales returns -500 inside the same folder; other income of the earlier year is not here
  expect(pl.revenue.total).toBe('9500.00');
  expect(find(pl.revenue.nodes, '4001')).toMatchObject({ name: 'Sales', amount: '10000.00', isGroup: false });
  expect(find(pl.revenue.nodes, '4002')).toMatchObject({ amount: '-500.00', isContra: true });
  expect(find(pl.revenue.nodes, '4003')).toBeNull(); // zero accounts are left out
  expect(find(pl.revenue.nodes, '4000')).toMatchObject({ isGroup: true, amount: '9500.00' });
  expect(pl.costOfSales.total).toBe('4000.00');
  expect(find(pl.costOfSales.nodes, '5001').amount).toBe('4000.00');
  expect(pl.grossProfit).toEqual({ amount: '5500.00', result: 'PROFIT' });
  expect(pl.expenses.total).toBe('1000.00');
  expect(find(pl.expenses.nodes, '6001').amount).toBe('1000.00');
  expect(pl.netProfit).toEqual({ amount: '4500.00', result: 'PROFIT' });

  // zero accounts on request; a shorter period; a loss
  const full = await ok(w.api('get', '/accounting/profit-loss?dateFrom=2026-07-01&dateTo=2026-10-31&includeZero=true'), 200);
  expect(find(full.revenue.nodes, '4003')).toMatchObject({ amount: '0.00' });
  expect(find(full.expenses.nodes, '6002')).toMatchObject({ amount: '0.00' });
  const short = await ok(w.api('get', '/accounting/profit-loss?dateFrom=2026-10-13&dateTo=2026-10-31'), 200);
  expect(short.revenue.total).toBe('-500.00');
  expect(short.grossProfit).toEqual({ amount: '500.00', result: 'LOSS' });
  expect(short.netProfit).toEqual({ amount: '1500.00', result: 'LOSS' });
  // the earlier year
  const last = await ok(w.api('get', '/accounting/profit-loss?fiscalYear=2025'), 200);
  expect(last).toMatchObject({ dateFrom: '2025-07-01', dateTo: '2026-06-30' });
  expect(last.netProfit).toEqual({ amount: '3000.00', result: 'PROFIT' });
  // nothing posted at all
  const empty = await ok(w.api('get', '/accounting/profit-loss?dateFrom=2020-01-01&dateTo=2020-01-31'), 200);
  expect(empty.netProfit).toEqual({ amount: '0.00', result: null });
  await fails(w.api('get', '/accounting/profit-loss?dateFrom=2026-10-31&dateTo=2026-10-01'), 422, 'BAD_RANGE');
  // a draft or a reversed voucher changes nothing
  const other = await setup();
  expect((await ok(other.api('get', '/accounting/profit-loss?dateFrom=2026-07-01&dateTo=2026-10-31'), 200)).netProfit.result).toBeNull();
});

test('balance sheet: assets = liabilities + equity, the profit of earlier years and of this year are computed lines', async () => {
  const w = await setup();
  await story(w);
  const bs = await ok(w.api('get', '/accounting/balance-sheet?date=2026-10-31'), 200);
  expect(bs).toMatchObject({ date: '2026-10-31', fiscalYearStart: '2026-07-01', balanced: true, difference: '0.00' });
  // cash 3000 - 1000 - 500, bank 50000 + 9800 - 1000, receivable 500 + 11800 - 10000, income tax receivable 200
  expect(find(bs.assets.nodes, '1101').amount).toBe('1500.00');
  expect(find(bs.assets.nodes, '1102').amount).toBe('58800.00');
  expect(find(bs.assets.nodes, '1103').amount).toBe('2300.00');
  expect(find(bs.assets.nodes, '1108').amount).toBe('200.00');
  expect(bs.assets.total).toBe('62800.00');
  // payable 4000 - 1000, output tax 1800
  expect(find(bs.liabilities.nodes, '2101').amount).toBe('3000.00');
  expect(find(bs.liabilities.nodes, '2102').amount).toBe('1800.00');
  expect(bs.liabilities.total).toBe('4800.00');
  expect(find(bs.equity.nodes, '3001').amount).toBe('50500.00');
  expect(bs.equity).toMatchObject({ accountsTotal: '50500.00', earlierYears: { amount: '3000.00', result: 'PROFIT' }, thisYear: { amount: '4500.00', result: 'PROFIT' }, total: '58000.00' });
  expect(bs.liabilitiesAndEquity).toBe('62800.00');

  // the day before the fiscal year: the 3000 is the profit of that year, nothing else exists yet
  const old = await ok(w.api('get', '/accounting/balance-sheet?date=2026-06-30'), 200);
  expect(old).toMatchObject({ fiscalYearStart: '2025-07-01', balanced: true });
  expect(old.assets.total).toBe('3000.00');
  expect(old.equity).toMatchObject({ earlierYears: { amount: '0.00', result: null }, thisYear: { amount: '3000.00', result: 'PROFIT' } });
  // it agrees with the trial balance at every date
  for (const d of ['2026-07-01', '2026-10-12', '2026-10-21']) expect((await ok(w.api('get', `/accounting/balance-sheet?date=${d}`), 200)).balanced).toBe(true);
  // zero accounts on request
  const zero = await ok(w.api('get', '/accounting/balance-sheet?date=2026-10-31&includeZero=true'), 200);
  expect(find(zero.assets.nodes, '1201')).toMatchObject({ amount: '0.00' });
});

test('customer / vendor balances: who owes us and whom we owe, with the number of unpaid documents', async () => {
  const w = await setup();
  const { c, v } = await story(w);
  const d = await w.customer('HA ENTERPRISES');
  const adv = await ok(receipt(w, { customerId: d.id, depositAccountId: await w.id('1102'), paymentMode: 'CASH', voucherDate: '2026-10-25', lines: [{ advance: true, chequeAmount: 1000 }] }));
  await ok(w.api('post', `/receipt-vouchers/${adv.id}/confirm`), 200);

  const b = await ok(w.api('get', '/accounting/balances?date=2026-10-31'), 200);
  expect(b.date).toBe('2026-10-31');
  // the customer: 500 (journal) + 11800 - 10000 = 2300; the one document that is still unpaid is the invoice
  expect(b.receivables.rows).toEqual([{ partyId: c.id, code: c.code, name: 'AZ TEXTILES', ntn: null, cnic: null, openCount: 1, balance: '2300.00' }]);
  expect(b.receivables).toMatchObject({ total: '2300.00', partyCount: 1, otherSide: { count: 1, total: '1000.00' } }); // HA ENTERPRISES paid in advance
  expect(b.payables.rows).toEqual([{ partyId: v.id, code: v.code, name: 'NEXUS CHEMICAL', ntn: null, cnic: null, openCount: 1, balance: '3000.00' }]);
  expect(b.payables.total).toBe('3000.00');
  // earlier date and search
  const early = await ok(w.api('get', '/accounting/balances?date=2026-10-15'), 200);
  expect(early.receivables.total).toBe('12300.00');
  expect(early.payables.rows[0].balance).toBe('4000.00');
  expect((await ok(w.api('get', '/accounting/balances?date=2026-10-31&search=nexus'), 200)).payables.rows).toHaveLength(1);
  expect((await ok(w.api('get', '/accounting/balances?date=2026-10-31&search=zzz'), 200)).payables.rows).toHaveLength(0);

  // the "Invoices" button of a row: the unpaid documents of that party on the date
  const items = await ok(w.api('get', `/accounting/balances/open-items?partyType=CUSTOMER&partyId=${c.id}&date=2026-10-31`), 200);
  expect(items.party).toMatchObject({ type: 'CUSTOMER', name: 'AZ TEXTILES' });
  expect(items.totals).toEqual({ amount: '11800.00', balance: '1800.00' });
  expect(items.items[0]).toMatchObject({ kind: 'SALES', date: '2026-10-10', amount: '11800.00', before: '10000.00', balance: '1800.00', after: '0.00', stillPending: '1800.00', flagged: false });
  const bills = await ok(w.api('get', `/accounting/balances/open-items?partyType=VENDOR&partyId=${v.id}&date=2026-10-15`), 200);
  expect(bills.items[0]).toMatchObject({ kind: 'PURCHASE', billNo: 'S-1', amount: '4000.00', before: '0.00', balance: '4000.00', after: '1000.00', stillPending: '3000.00' });
  await fails(w.api('get', `/accounting/balances/open-items?partyType=VENDOR&partyId=${c.id}`), 404, 'NOT_FOUND');
});

test('receivable & payable as on a cut-off date: ledger view, invoice view, what was paid since', async () => {
  const w = await setup();
  const { inv } = await story(w);
  const c = await ok(w.api('get', '/accounting/cutoff?date=2026-10-15&detail=true'), 200);
  expect(c.cutoffDate).toBe('2026-10-15');
  // the ledger: 500 (journal) + 11800; the invoice: 11800 unpaid on the 15th, 10000 received on the 20th
  expect(c.receivable).toMatchObject({ ledgerBalance: '12300.00', ledgerPartyCount: 1, otherPostings: '500.00' });
  expect(c.receivable.invoices).toEqual({ count: 1, amount: '11800.00', before: '0.00', balance: '11800.00', after: '10000.00', stillPending: '1800.00', mismatched: 0 });
  expect(c.receivable.byType).toEqual([{ type: 'WITH_TAX', text: 'With sales tax', count: 1, amount: '11800.00', before: '0.00', balance: '11800.00', after: '10000.00', stillPending: '1800.00' }]);
  expect(c.receivable.parties[0]).toMatchObject({ name: 'AZ TEXTILES', count: 1, amount: '11800.00', balance: '11800.00', after: '10000.00', stillPending: '1800.00', perLedger: '12300.00', perLedgerSide: 'NORMAL', ledgerLessInvoices: '500.00' });
  expect(c.receivable.documents).toHaveLength(1);
  expect(c.receivable.documents[0]).toMatchObject({ kind: 'SALES', id: inv.id, label: pad(inv.no), balance: '11800.00', flagged: false });
  // payables: the bill of 4000, 1000 paid on the 22nd (after the cut-off)
  expect(c.payable).toMatchObject({ ledgerBalance: '4000.00', otherPostings: '0.00' });
  expect(c.payable.invoices).toMatchObject({ count: 1, amount: '4000.00', balance: '4000.00', after: '1000.00', stillPending: '3000.00' });
  expect(c.payable.byType[0]).toMatchObject({ type: null, text: 'Other' }); // a bill made without store lines

  // a later cut-off: the receipt is before it
  const late = await ok(w.api('get', '/accounting/cutoff?date=2026-10-31'), 200);
  expect(late.receivable.invoices).toMatchObject({ balance: '1800.00', before: '10000.00', after: '0.00', stillPending: '1800.00' });
  expect(late.receivable.ledgerBalance).toBe('2300.00');
  expect(late.receivable.documents).toBeUndefined();
  // before the invoice existed, and the date of a paid-in-full invoice: nothing
  const first = await ok(w.api('get', '/accounting/cutoff?date=2026-10-09'), 200);
  expect(first.receivable.invoices.count).toBe(0);
  expect(first.receivable.ledgerBalance).toBe('500.00');
  expect(first.receivable.otherPostings).toBe('500.00');
  // search
  expect((await ok(w.api('get', '/accounting/cutoff?date=2026-10-31&search=nobody'), 200)).receivable.parties).toHaveLength(0);

  // an invoice whose received amount disagrees with its confirmed vouchers is flagged
  await sql('UPDATE sales_invoices SET "receivedAmount" = 5 WHERE id = :id', { id: inv.id });
  const bad = await ok(w.api('get', '/accounting/cutoff?date=2026-10-31&detail=true'), 200);
  expect(bad.receivable.invoices.mismatched).toBe(1);
  expect(bad.receivable.documents[0].flagged).toBe(true);
});

test('access: every report needs the ACC_REPORTS service and only reads', async () => {
  const w = await setup();
  const { c } = await story(w);
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'ACC_REPORTS' } })).id, access: 'VIEW' });
  const v = caller(await token(viewer));
  const nobody = caller(await token(await makeUser({ userType: 'USER', companyId: w.company.id })));
  for (const url of ['/accounting/profit-loss', '/accounting/balance-sheet', '/accounting/balances', '/accounting/cutoff', `/accounting/balances/open-items?partyType=CUSTOMER&partyId=${c.id}`]) {
    await ok(v('get', url), 200);
    await fails(nobody('get', url), 403, 'FORBIDDEN');
  }
  await fails(v('get', '/accounting/balances?date=2026-02-30'), 400, 'VALIDATION_FAILED');
  // another company sees nothing of this one
  const other = await setup();
  const o = await ok(other.api('get', '/accounting/balances'), 200);
  expect([o.receivables.rows.length, o.payables.rows.length]).toEqual([0, 0]);
  await fails(other.api('get', `/accounting/balances/open-items?partyType=CUSTOMER&partyId=${c.id}`), 404, 'NOT_FOUND');
});
