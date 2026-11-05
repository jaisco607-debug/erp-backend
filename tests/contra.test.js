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

const UUID = '5f1c7d0e-3b1a-4c6e-9d2a-0a1b2c3d4e5f';

const contra = (w, body) => w.api('post', '/contra-vouchers', body);
const pad = (n) => String(n).padStart(5, '0');

test('contra: a customer owes 200,000 and we owe a vendor 200,000: the customer pays the vendor directly', async () => {
  const w = await setup();
  const c = await w.customer('HAMID');
  const v = await w.vendor('JAMAL');
  const inv = await salesInvoice(w, c, { gross: 200000, taxRate: 0, date: '2026-10-10' });
  const bill = await purchaseInvoice(w, v, { gross: 200000, billNo: 'J-1', date: '2026-10-11' });

  // the two pickers of the screen and the tables
  const opt = await ok(w.api('get', '/contra-vouchers/options'), 200);
  expect(opt.customers).toEqual([{ id: c.id, code: c.code, name: 'HAMID', openCount: 1, outstanding: 200000 }]);
  expect(opt.vendors).toEqual([{ id: v.id, code: v.code, name: 'JAMAL', openCount: 1, outstanding: 200000 }]);
  const ti = await ok(w.api('get', `/contra-vouchers/invoices?customerId=${c.id}`), 200);
  expect(ti.data[0]).toMatchObject({ salesInvoiceId: inv.id, invoiceNo: inv.no, net: 200000, received: 0, balance: 200000 });
  const tb2 = await ok(w.api('get', `/contra-vouchers/bills?vendorId=${v.id}`), 200);
  expect(tb2.data[0]).toMatchObject({ purchaseInvoiceId: bill.id, billNo: 'J-1', net: 200000, paid: 0, balance: 200000 });

  // Save: a draft touches nothing
  const d = await ok(contra(w, { customerId: c.id, vendorId: v.id, voucherDate: '2026-10-26', amount: '200000.00', reference: 'CT-1', narration: 'Hamid pays Jamal',
    invoices: [{ salesInvoiceId: inv.id, amount: 200000 }], bills: [{ purchaseInvoiceId: bill.id, amount: '200000' }] }));
  expect(d).toMatchObject({ voucherNo: 1, voucherLabel: '00001', status: 'DRAFT', statusText: 'Draft', amount: 200000, reference: 'CT-1', canEdit: true, canConfirm: true, canUnconfirm: false,
    customer: { name: 'HAMID' }, vendor: { name: 'JAMAL' }, appliedToInvoices: 200000, appliedToBills: 200000 });
  expect(d.invoices).toHaveLength(1);
  expect(d.invoices[0]).toMatchObject({ invoiceNo: inv.no, invoiceNet: 200000, outstanding: 200000, amount: 200000 });
  expect(d.bills[0]).toMatchObject({ billNo: 'J-1', billNet: 200000, outstanding: 200000, amount: 200000 });
  expect((await sql('SELECT "receivedAmount"::float AS r FROM sales_invoices WHERE id = :id', { id: inv.id }))[0].r).toBe(0);
  expect((await sql(`SELECT count(*)::int AS n FROM journal_entries WHERE "sourceType" = 'CONTRA_VOUCHER' AND "companyId" = :c`, { c: w.company.id }))[0].n).toBe(0);

  // Confirm ("Post Contra"): Debit Accounts Payable (the vendor), Credit Accounts Receivable (the customer); no bank or cash line
  const done = await ok(w.api('post', `/contra-vouchers/${d.id}/confirm`), 200);
  expect(done).toMatchObject({ status: 'CONFIRMED', canEdit: false, canDelete: false, canConfirm: false, canUnconfirm: true });
  const e = await ok(w.api('get', `/contra-vouchers/${d.id}/accounts-entry`), 200);
  expect(e.posted).toBe(true);
  expect(e.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([['Accounts Payable', 200000, 0, 'VENDOR'], ['Accounts Receivable', 0, 200000, 'CUSTOMER']]);
  expect(e.current.balanced).toBe(true);
  const si = await ok(w.api('get', `/sales-invoices/${inv.id}`), 200);
  expect([si.received, si.balance, si.paymentStatus]).toEqual([200000, 0, 'PAID']);
  expect(si.payments).toEqual([expect.objectContaining({ voucherType: 'CONTRA', voucherId: d.id, paymentMode: 'CONTRA', billAmount: 200000, voucherLabel: '00001' })]);
  const pi = await ok(w.api('get', `/purchase-invoices/${bill.id}`), 200);
  expect([pi.paid, pi.balance, pi.paymentStatus]).toEqual([200000, 0, 'PAID']);
  expect(pi.payments).toEqual([expect.objectContaining({ voucherType: 'CONTRA', paymentMode: 'CONTRA', amount: 200000 })]);
  // both invoice and bill are no longer on the pickers; nobody owes anybody
  expect((await ok(w.api('get', '/contra-vouchers/options'), 200))).toMatchObject({ customers: [], vendors: [] });
  const bal = await ok(w.api('get', '/accounting/balances?date=2026-10-31'), 200);
  expect([bal.receivables.rows.length, bal.payables.rows.length]).toEqual([0, 0]);
  // the party ledgers show the contra with its voucher number, and the books are fine
  const lc = await ok(w.api('get', `/accounting/party-ledger?partyType=CUSTOMER&partyId=${c.id}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);
  expect(lc.kinds.map((k) => k.code)).toEqual(['CONTRA_VOUCHER', 'SALES_INVOICE']);
  expect(lc.lines[1]).toMatchObject({ sourceType: 'CONTRA_VOUCHER', sourceText: 'Contra', sourceId: d.id, docLabel: '00001', credit: '200000.00', balance: '0.00', balanceSide: null });
  const lv = await ok(w.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${v.id}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);
  expect(lv.lines[1]).toMatchObject({ sourceType: 'CONTRA_VOUCHER', debit: '200000.00', balance: '0.00' });
  const t = await tb(w);
  expect(t.checks.map((x) => [x.key, x.ok]).filter(([, okk]) => !okk)).toEqual([]);
  expect(t.checks.map((x) => x.key)).toContain('CONTRA_VOUCHERS_MATCH_LEDGER');
  expect(t.balanced).toBe(true);
  expect(row(t, 'Bank Account')).toBeUndefined(); // no bank or cash moved
  // an invoice that has been settled by a contra cannot be un-approved
  await fails(w.api('post', `/sales-invoices/${inv.id}/unapprove`, {}), 422, 'HAS_RECEIPTS');
  await fails(w.api('post', `/purchase-invoices/${bill.id}/unapprove`, {}), 422, 'HAS_PAYMENTS');

  // Move to draft: reversal, the amounts come back, the invoice and bill are open again
  const back = await ok(w.api('post', `/contra-vouchers/${d.id}/unconfirm`, { reason: 'wrong party' }), 200);
  expect(back).toMatchObject({ status: 'DRAFT', canConfirm: true });
  expect((await ok(w.api('get', `/sales-invoices/${inv.id}`), 200))).toMatchObject({ received: 0, balance: 200000, paymentStatus: 'UNPAID', payments: [] });
  expect((await ok(w.api('get', `/purchase-invoices/${bill.id}`), 200))).toMatchObject({ paid: 0, balance: 200000, payments: [] });
  const e2 = await ok(w.api('get', `/contra-vouchers/${d.id}/accounts-entry`), 200);
  expect([e2.posted, e2.entries.length, e2.entries[0].status, e2.entries[1].reversalOfId === e2.entries[0].id]).toEqual([false, 2, 'REVERSED', true]);
  expect((await tb(w)).checks.every((x) => x.ok)).toBe(true);
  await fails(w.api('post', `/contra-vouchers/${d.id}/unconfirm`, {}), 422, 'NOT_CONFIRMED');
  // and it can be confirmed again
  await ok(w.api('post', `/contra-vouchers/${d.id}/confirm`), 200);
  await fails(w.api('post', `/contra-vouchers/${d.id}/confirm`), 422, 'ALREADY_CONFIRMED');
});

test('contra: one side owes more than the other: only the contra amount is settled on both sides, the rest stays open', async () => {
  const w = await setup();
  const c = await w.customer('HAMID');
  const v = await w.vendor('JAMAL');
  // the customer owes 300,000 in three invoices; we owe the vendor 200,000 in two bills
  const i1 = await salesInvoice(w, c, { gross: 100000, taxRate: 0, date: '2026-10-01' });
  const i2 = await salesInvoice(w, c, { gross: 120000, taxRate: 0, date: '2026-10-02' });
  const i3 = await salesInvoice(w, c, { gross: 80000, taxRate: 0, date: '2026-10-03' });
  const b1 = await purchaseInvoice(w, v, { gross: 150000, billNo: 'J-1', date: '2026-10-04' });
  const b2 = await purchaseInvoice(w, v, { gross: 50000, billNo: 'J-2', date: '2026-10-05' });
  const c1 = await ok(contra(w, { customerId: c.id, vendorId: v.id, amount: 200000, voucherDate: '2026-10-20',
    invoices: [{ salesInvoiceId: i1.id, amount: 100000 }, { salesInvoiceId: i2.id, amount: 100000 }],
    bills: [{ purchaseInvoiceId: b1.id, amount: 150000 }, { purchaseInvoiceId: b2.id, amount: 50000 }] }));
  await ok(w.api('post', `/contra-vouchers/${c1.id}/confirm`), 200);
  // the customer still owes 100,000 (20,000 of the second invoice and the whole third); the vendor is fully paid
  const bal = await ok(w.api('get', '/accounting/balances?date=2026-10-31'), 200);
  expect(bal.receivables.rows).toEqual([expect.objectContaining({ name: 'HAMID', balance: '100000.00', openCount: 2 })]);
  expect(bal.payables.rows).toEqual([]);
  expect(bal.receivables.total).toBe('100000.00');
  const ti = await ok(w.api('get', `/contra-vouchers/invoices?customerId=${c.id}`), 200);
  expect(ti.data.map((x) => [x.invoiceNo, x.balance])).toEqual([[i2.no, 20000], [i3.no, 80000]]);

  // the other way: we owe the vendor more. A second vendor is owed 500,000, the customer owes only the remaining 100,000
  const v2 = await w.vendor('BIG VENDOR');
  const big = await purchaseInvoice(w, v2, { gross: 500000, billNo: 'BIG-1', date: '2026-10-06' });
  const c2 = await ok(contra(w, { customerId: c.id, vendorId: v2.id, amount: 100000, voucherDate: '2026-10-21',
    invoices: [{ salesInvoiceId: i2.id, amount: 20000 }, { salesInvoiceId: i3.id, amount: 80000 }], bills: [{ purchaseInvoiceId: big.id, amount: 100000 }] }));
  await ok(w.api('post', `/contra-vouchers/${c2.id}/confirm`), 200);
  const bal2 = await ok(w.api('get', '/accounting/balances?date=2026-10-31'), 200);
  expect(bal2.receivables.rows).toEqual([]);
  expect(bal2.payables.rows).toEqual([expect.objectContaining({ name: 'BIG VENDOR', balance: '400000.00', openCount: 1 })]); // 500,000 - 100,000
  const pb = await ok(w.api('get', `/contra-vouchers/bills?vendorId=${v2.id}`), 200);
  expect(pb.data[0]).toMatchObject({ net: 500000, paid: 100000, balance: 400000 });
  expect((await ok(w.api('get', `/purchase-invoices/${big.id}`), 200)).paymentStatus).toBe('PARTIAL');
  // the list and its summary
  const list = await ok(w.api('get', '/contra-vouchers'), 200);
  expect(list.data.map((x) => [x.voucherNo, x.amount, x.status])).toEqual([[2, 100000, 'CONFIRMED'], [1, 200000, 'CONFIRMED']]);
  expect(list.summary).toEqual({ vouchers: 2, totalAmount: 300000 });
  expect((await ok(w.api('get', `/contra-vouchers?vendorId=${v2.id}`), 200)).total).toBe(1);
  expect((await ok(w.api('get', '/contra-vouchers?search=big'), 200)).total).toBe(1);
  expect((await ok(w.api('get', '/contra-vouchers?search=2'), 200)).data[0].voucherNo).toBe(2);
  expect((await ok(w.api('get', '/contra-vouchers?status=DRAFT'), 200)).total).toBe(0);
  // the cut-off report: on the 15th nothing was settled yet; the contras came after it
  const cut = await ok(w.api('get', '/accounting/cutoff?date=2026-10-15'), 200);
  expect(cut.receivable.invoices).toMatchObject({ count: 3, amount: '300000.00', before: '0.00', balance: '300000.00', after: '300000.00', stillPending: '0.00' });
  expect(cut.payable.invoices).toMatchObject({ count: 3, amount: '700000.00', before: '0.00', balance: '700000.00', after: '300000.00', stillPending: '400000.00' });
  const t = await tb(w);
  expect(t.checks.filter((x) => !x.ok).map((x) => x.key)).toEqual([]);
});

test('contra: the rules: both tables equal the amount, only the right party, approved documents, no more than the balance', async () => {
  const w = await setup();
  const c = await w.customer('HAMID');
  const c2 = await w.customer('OTHER CUSTOMER');
  const v = await w.vendor('JAMAL');
  const v2 = await w.vendor('OTHER VENDOR');
  const i1 = await salesInvoice(w, c, { gross: 1000, taxRate: 0 });
  const iOther = await salesInvoice(w, c2, { gross: 1000, taxRate: 0 });
  const iDraft = await salesInvoice(w, c, { gross: 1000, taxRate: 0, status: 'UNAPPROVED' });
  const b1 = await purchaseInvoice(w, v, { gross: 1000, billNo: 'B1' });
  const bOther = await purchaseInvoice(w, v2, { gross: 1000, billNo: 'B2' });
  const bDraft = await purchaseInvoice(w, v, { gross: 1000, billNo: 'B3', status: 'UNAPPROVED' });
  const base = { customerId: c.id, vendorId: v.id, amount: 500, invoices: [{ salesInvoiceId: i1.id, amount: 500 }], bills: [{ purchaseInvoiceId: b1.id, amount: 500 }] };

  const e = await fails(contra(w, { ...base, invoices: [{ salesInvoiceId: i1.id, amount: 400 }] }), 422, 'TABLES_DO_NOT_MATCH');
  expect(e.details).toEqual({ amount: 500, invoicesTotal: 400, billsTotal: 500 });
  await fails(contra(w, { ...base, bills: [{ purchaseInvoiceId: b1.id, amount: 600 }] }), 422, 'TABLES_DO_NOT_MATCH');
  await fails(contra(w, { ...base, amount: 1500, invoices: [{ salesInvoiceId: i1.id, amount: 1500 }], bills: [{ purchaseInvoiceId: b1.id, amount: 1500 }] }), 422, 'MORE_THAN_BALANCE');
  await fails(contra(w, { ...base, invoices: [{ salesInvoiceId: iOther.id, amount: 500 }] }), 422, 'INVOICE_OTHER_CUSTOMER');
  await fails(contra(w, { ...base, bills: [{ purchaseInvoiceId: bOther.id, amount: 500 }] }), 422, 'BILL_OTHER_VENDOR');
  await fails(contra(w, { ...base, invoices: [{ salesInvoiceId: iDraft.id, amount: 500 }] }), 422, 'INVOICE_NOT_APPROVED');
  await fails(contra(w, { ...base, bills: [{ purchaseInvoiceId: bDraft.id, amount: 500 }] }), 422, 'BILL_NOT_APPROVED');
  await fails(contra(w, { ...base, invoices: [{ salesInvoiceId: i1.id, amount: 250 }, { salesInvoiceId: i1.id, amount: 250 }] }), 422, 'DUPLICATE_INVOICE');
  await fails(contra(w, { ...base, bills: [{ purchaseInvoiceId: b1.id, amount: 250 }, { purchaseInvoiceId: b1.id, amount: 250 }] }), 422, 'DUPLICATE_BILL');
  await fails(contra(w, { ...base, amount: 0 }), 422, 'BAD_AMOUNT');
  await fails(contra(w, { ...base, amount: '500.123' }), 400, 'VALIDATION_FAILED');
  await fails(contra(w, { ...base, invoices: [] }), 400, 'VALIDATION_FAILED');
  await fails(contra(w, { ...base, bills: undefined }), 400, 'VALIDATION_FAILED');
  await fails(contra(w, { ...base, customerId: UUID }), 404, 'NOT_FOUND');
  await fails(contra(w, { ...base, vendorId: UUID }), 404, 'NOT_FOUND');
  await fails(contra(w, { ...base, invoices: [{ salesInvoiceId: UUID, amount: 500 }] }), 404, 'NOT_FOUND');
  // nothing was saved by any of the refusals
  expect((await ok(w.api('get', '/contra-vouchers'), 200)).total).toBe(0);

  // edit a draft: new amount, other tables
  const d = await ok(contra(w, base));
  const ch = await ok(w.api('patch', `/contra-vouchers/${d.id}`, { amount: 300, narration: 'smaller', invoices: [{ salesInvoiceId: i1.id, amount: 300 }], bills: [{ purchaseInvoiceId: b1.id, amount: 300 }] }), 200);
  expect(ch).toMatchObject({ amount: 300, narration: 'smaller', appliedToInvoices: 300, appliedToBills: 300 });
  await fails(w.api('patch', `/contra-vouchers/${d.id}`, { amount: 999 }), 422, 'TABLES_DO_NOT_MATCH'); // the saved tables no longer add up
  await fails(w.api('patch', `/contra-vouchers/${d.id}`, { customerId: c2.id }), 422, 'LINES_REQUIRED');
  expect((await ok(w.api('get', `/contra-vouchers/${d.id}`), 200)).amount).toBe(300);
  // two drafts for the same money: the second one is refused when it is confirmed
  const d2 = await ok(contra(w, { ...base, amount: 800, invoices: [{ salesInvoiceId: i1.id, amount: 800 }], bills: [{ purchaseInvoiceId: b1.id, amount: 800 }] }));
  await ok(w.api('post', `/contra-vouchers/${d.id}/confirm`), 200);
  await fails(w.api('post', `/contra-vouchers/${d2.id}/confirm`), 422, 'MORE_THAN_BALANCE'); // only 700 left
  expect((await ok(w.api('get', `/contra-vouchers/${d2.id}`), 200)).status).toBe('DRAFT');
  // a confirmed voucher cannot be changed or deleted
  await fails(w.api('patch', `/contra-vouchers/${d.id}`, { narration: 'x' }), 422, 'VOUCHER_CONFIRMED');
  await fails(w.api('delete', `/contra-vouchers/${d.id}`), 422, 'VOUCHER_CONFIRMED');
  // a draft can be deleted; its number is free again
  expect((await w.api('delete', `/contra-vouchers/${d2.id}`)).status).toBe(204);
  expect((await w.api('get', `/contra-vouchers/${d2.id}`)).status).toBe(404);
});

test('contra: the Trial Balance catches a contra voucher that disagrees with the books, and access', async () => {
  const w = await setup();
  const c = await w.customer('HAMID');
  const v = await w.vendor('JAMAL');
  const i1 = await salesInvoice(w, c, { gross: 1000, taxRate: 0 });
  const b1 = await purchaseInvoice(w, v, { gross: 1000, billNo: 'B1' });
  const d = await ok(contra(w, { customerId: c.id, vendorId: v.id, amount: 400, invoices: [{ salesInvoiceId: i1.id, amount: 400 }], bills: [{ purchaseInvoiceId: b1.id, amount: 400 }] }));
  await ok(w.api('post', `/contra-vouchers/${d.id}/confirm`), 200);
  expect((await tb(w)).checks.find((x) => x.key === 'CONTRA_VOUCHERS_MATCH_LEDGER')).toMatchObject({ ok: true, checked: 1 });
  // a bill line changed behind the program's back: the two tables no longer add up
  await sql(`UPDATE contra_voucher_lines SET amount = 350 WHERE "voucherId" = :id AND side = 'BILL'`, { id: d.id });
  const bad = await tb(w);
  expect(bad.checks.find((x) => x.key === 'CONTRA_VOUCHERS_MATCH_LEDGER').mismatches).toEqual([expect.objectContaining({ voucherNo: 1, reason: 'TABLES_DO_NOT_MATCH' })]);
  expect(bad.checks.find((x) => x.key === 'INVOICE_PAYMENTS_MATCH_VOUCHERS').mismatches).toEqual([expect.objectContaining({ kind: 'PURCHASE' })]); // the bill says 400 paid, the voucher 350
  expect(bad.ok).toBe(false);
  expect(bad.balanced).toBe(true);
  await sql(`UPDATE contra_voucher_lines SET amount = 400 WHERE "voucherId" = :id AND side = 'BILL'`, { id: d.id });

  // access: its own service
  const nobody = caller(await token(await makeUser({ userType: 'USER', companyId: w.company.id })));
  for (const url of ['/contra-vouchers', '/contra-vouchers/options', `/contra-vouchers/${d.id}`, `/contra-vouchers/invoices?customerId=${c.id}`, `/contra-vouchers/bills?vendorId=${v.id}`]) await fails(nobody('get', url), 403, 'FORBIDDEN');
  await fails(nobody('post', '/contra-vouchers', {}), 403, 'FORBIDDEN');
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'ACC_CONTRA' } })).id, access: 'VIEW' });
  const vw = caller(await token(viewer));
  await ok(vw('get', `/contra-vouchers/${d.id}`), 200);
  await fails(vw('post', `/contra-vouchers/${d.id}/unconfirm`, {}), 403, 'FORBIDDEN');
  await fails(vw('delete', `/contra-vouchers/${d.id}`), 403, 'FORBIDDEN');
  // another company
  const other = await setup();
  for (const [m, url, body] of [['get', `/contra-vouchers/${d.id}`], ['patch', `/contra-vouchers/${d.id}`, { narration: 'x' }], ['delete', `/contra-vouchers/${d.id}`], ['post', `/contra-vouchers/${d.id}/confirm`], ['post', `/contra-vouchers/${d.id}/unconfirm`, {}], ['get', `/contra-vouchers/${d.id}/accounts-entry`]]) {
    expect([m, (await other.api(m, url, body)).status]).toEqual([m, 404]);
  }
  await fails(contra(other, { customerId: c.id, vendorId: v.id, amount: 1, invoices: [{ salesInvoiceId: i1.id, amount: 1 }], bills: [{ purchaseInvoiceId: b1.id, amount: 1 }] }), 404, 'NOT_FOUND');
});
