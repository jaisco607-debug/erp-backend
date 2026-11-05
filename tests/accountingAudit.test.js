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
const UUID = '5f1c7d0e-3b1a-4c6e-9d2a-0a1b2c3d4e5f';

// ---------------------------------------------------------------------------------------------------------------------------- 1. who may call what

test('AUDIT access: no token = 401, no service = 403, view-only user cannot write, on every accounting endpoint', async () => {
  const w = await setup();
  const none = caller({}); // no token
  const nobody = caller(await token(await makeUser({ userType: 'USER', companyId: w.company.id })));
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  for (const code of SERVICES) await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code } })).id, access: code === 'ACC_REPORTS' ? 'VIEW' : 'VIEW' });
  const view = caller(await token(viewer));

  const reads = ['/accounts', '/accounts/tree', '/accounts/options', '/accounts/issues', '/sales-invoices', '/sales-invoices/options', '/purchase-invoices', '/purchase-invoices/options',
    '/payment-vouchers', '/payment-vouchers/options', '/receipt-vouchers', '/receipt-vouchers/options', '/journal-vouchers', '/journal-vouchers/options',
    '/accounting/trial-balance', '/accounting/profit-loss', '/accounting/balance-sheet', '/accounting/balances', '/accounting/cutoff', '/accounting/payables', '/accounting/receivables',
    '/accounting/opening-balances', '/accounting/settings', '/accounting/bank-accounts'];
  for (const url of reads) {
    expect([url, (await none('get', url)).status]).toEqual([url, 401]);
    expect([url, (await nobody('get', url)).status]).toEqual([url, 403]);
    const r = await view('get', url);
    expect([url, r.status < 500, r.status === 403 || r.status === 200]).toEqual([url, true, true]);
  }
  // a user with VIEW only cannot change anything (403), and a user with no service cannot either
  const writes = [['post', '/accounts', { name: 'X' }], ['post', '/accounts/apply-template', { templateKey: 'other' }], ['put', '/accounting/opening-balances', { date: '2026-07-01', lines: [] }], ['put', '/accounting/settings', { fiscalYearStartMonth: 1 }],
    ['post', '/sales-invoices', {}], ['post', '/purchase-invoices', {}], ['post', '/payment-vouchers', {}], ['post', '/receipt-vouchers', {}], ['post', '/journal-vouchers', {}],
    ['post', `/sales-invoices/${UUID}/approve`], ['post', `/purchase-invoices/${UUID}/approve`], ['post', `/payment-vouchers/${UUID}/confirm`], ['post', `/receipt-vouchers/${UUID}/confirm`], ['post', `/journal-vouchers/${UUID}/confirm`],
    ['post', `/payment-vouchers/${UUID}/unconfirm`, {}], ['delete', `/payment-vouchers/${UUID}`], ['delete', `/journal-vouchers/${UUID}`], ['patch', `/receipt-vouchers/${UUID}`, {}],
    ['put', '/accounting/bank-clearing', { journalLineId: UUID, clearedDate: '2026-10-01' }]];
  for (const [m, url, body] of writes) {
    expect([m, url, (await none(m, url, body)).status]).toEqual([m, url, 401]);
    expect([m, url, (await nobody(m, url, body)).status]).toEqual([m, url, 403]);
    expect([m, url, (await view(m, url, body)).status]).toEqual([m, url, 403]);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------- 2. company A cannot touch company B

test('AUDIT tenant isolation: another company can neither read, change nor use the records of this one', async () => {
  const a = await setup();
  const story = await (async () => {
    const vendor = await a.vendor('NEXUS CHEMICAL');
    const customer = await a.customer('AZ TEXTILES');
    const bill = await purchaseInvoice(a, vendor, { gross: 1000 });
    const inv = await salesInvoice(a, customer, { gross: 1000 });
    const bank = await a.id('1102');
    const pv = await ok(payment(a, { vendorId: vendor.id, payFromAccountId: bank, paymentMode: 'CASH', lines: [{ purchaseInvoiceId: bill.id, amount: 100 }] }));
    const pvDone = await ok(payment(a, { vendorId: vendor.id, payFromAccountId: bank, paymentMode: 'CASH', lines: [{ advance: true, amount: 50 }] }));
    await ok(a.api('post', `/payment-vouchers/${pvDone.id}/confirm`), 200);
    const rv = await ok(receipt(a, { customerId: customer.id, depositAccountId: bank, paymentMode: 'CASH', lines: [{ salesInvoiceId: inv.id, chequeAmount: 100 }] }));
    const jvv = await ok(a.api('post', '/journal-vouchers', { lines: [{ accountId: bank, debit: 5 }, { accountId: await a.id('1101'), credit: 5 }] }));
    return { vendor, customer, bill, inv, bank, pv, pvDone, rv, jvv, account: await a.id('6001') };
  })();
  const b = await setup();
  const bBank = await b.id('1102');

  const gone = [
    ['get', `/payment-vouchers/${story.pv.id}`], ['patch', `/payment-vouchers/${story.pv.id}`, { notes: 'x' }], ['delete', `/payment-vouchers/${story.pv.id}`], ['post', `/payment-vouchers/${story.pv.id}/confirm`],
    ['post', `/payment-vouchers/${story.pvDone.id}/unconfirm`, {}], ['get', `/payment-vouchers/${story.pvDone.id}/accounts-entry`],
    ['get', `/receipt-vouchers/${story.rv.id}`], ['patch', `/receipt-vouchers/${story.rv.id}`, { notes: 'x' }], ['delete', `/receipt-vouchers/${story.rv.id}`], ['post', `/receipt-vouchers/${story.rv.id}/confirm`],
    ['get', `/journal-vouchers/${story.jvv.id}`], ['patch', `/journal-vouchers/${story.jvv.id}`, { narration: 'x' }], ['delete', `/journal-vouchers/${story.jvv.id}`], ['post', `/journal-vouchers/${story.jvv.id}/confirm`],
    ['get', `/sales-invoices/${story.inv.id}`], ['post', `/sales-invoices/${story.inv.id}/approve`], ['post', `/sales-invoices/${story.inv.id}/unapprove`, {}], ['delete', `/sales-invoices/${story.inv.id}`],
    ['get', `/purchase-invoices/${story.bill.id}`], ['post', `/purchase-invoices/${story.bill.id}/approve`], ['delete', `/purchase-invoices/${story.bill.id}`],
    ['get', `/accounts/${story.account}`], ['patch', `/accounts/${story.account}`, { name: 'Hacked' }], ['delete', `/accounts/${story.account}`],
    ['get', `/accounting/ledger?accountId=${story.bank}`], ['get', `/accounting/bank-summary?accountId=${story.bank}`],
    ['get', `/accounting/party-ledger?partyType=VENDOR&partyId=${story.vendor.id}`], ['get', `/accounting/balances/open-items?partyType=CUSTOMER&partyId=${story.customer.id}`],
  ];
  for (const [m, url, body] of gone) {
    const r = await b.api(m, url, body);
    expect([m, url, r.status]).toEqual([m, url, 404]);
  }
  // using the other company's records inside a new voucher of my own
  const bad = [];
  const mineV = await b.vendor('MINE');
  const mineV2 = await b.vendor('MINE 2');
  const mineC = await b.customer('MINE');
  const bAr = await b.id('1103');
  bad.push(await payment(b, { vendorId: story.vendor.id, payFromAccountId: bBank, paymentMode: 'CASH', lines: [{ advance: true, amount: 10 }] }));
  bad.push(await payment(b, { vendorId: mineV.id, payFromAccountId: story.bank, paymentMode: 'CASH', lines: [{ advance: true, amount: 10 }] }));
  bad.push(await payment(b, { vendorId: mineV2.id, payFromAccountId: bBank, paymentMode: 'CASH', lines: [{ purchaseInvoiceId: story.bill.id, amount: 10 }] }));
  bad.push(await receipt(b, { customerId: story.customer.id, depositAccountId: bBank, paymentMode: 'CASH', lines: [{ advance: true, chequeAmount: 10 }] }));
  bad.push(await receipt(b, { customerId: mineC.id, depositAccountId: bBank, paymentMode: 'CASH', lines: [{ salesInvoiceId: story.inv.id, chequeAmount: 10 }] }));
  bad.push(await b.api('post', '/journal-vouchers', { lines: [{ accountId: story.bank, debit: 5 }, { accountId: bBank, credit: 5 }] }));
  bad.push(await b.api('post', '/journal-vouchers', { lines: [{ accountId: bAr, debit: 5, partyId: story.customer.id }, { accountId: bBank, credit: 5 }] }));
  for (const r of bad) expect([404, 422]).toContain(r.status);
  // nothing of company A leaked into B's books
  const t = await tb(b);
  expect(t.rows).toHaveLength(0);
  expect(t.balanced).toBe(true);
  // and A's books are untouched by all of that
  const ta = await tb(a);
  expect(ta.checks.every((c) => c.ok)).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------------- 3. bad input never reaches the books and never crashes

test('AUDIT bad input: wrong amounts, ids, dates and hostile text are refused cleanly (never a 500)', async () => {
  const w = await setup();
  const v = await w.vendor('NEXUS');
  const c = await w.customer('AZ');
  const bill = await purchaseInvoice(w, v, { gross: 1000 });
  const inv = await salesInvoice(w, c, { gross: 1000 });
  const bank = await w.id('1102');
  const cash = await w.id('1101');
  const badAmounts = [0, -5, '-5', 'abc', '', '1e3', 1.234, '1.234', 1e20, '99999999999999', null, {}, [], true, '12,5', NaN];
  for (const amount of badAmounts) {
    for (const r of [
      await payment(w, { vendorId: v.id, payFromAccountId: bank, paymentMode: 'CASH', lines: [{ advance: true, amount }] }),
      await receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CASH', lines: [{ advance: true, chequeAmount: amount }] }),
      await w.api('post', '/journal-vouchers', { lines: [{ accountId: bank, debit: amount }, { accountId: cash, credit: amount }] }),
    ]) expect([String(amount), r.status >= 400 && r.status < 500]).toEqual([String(amount), true]);
  }
  // more than the bill / invoice
  await fails(payment(w, { vendorId: v.id, payFromAccountId: bank, paymentMode: 'CASH', lines: [{ purchaseInvoiceId: bill.id, amount: 1000.01 }] }), 422, 'MORE_THAN_BALANCE');
  await fails(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CASH', lines: [{ salesInvoiceId: inv.id, chequeAmount: 1180.01 }] }), 422, 'MORE_THAN_BALANCE');
  // rates
  for (const rate of [-1, 100, 150, 'x', 99.999]) {
    const r = await receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CASH', lines: [{ salesInvoiceId: inv.id, chequeAmount: 10, incomeTaxRate: rate }] });
    expect([String(rate), r.status >= 400 && r.status < 500]).toEqual([String(rate), true]);
    const p = await payment(w, { vendorId: v.id, payFromAccountId: bank, paymentMode: 'CASH', incomeTaxRate: rate, lines: [{ advance: true, amount: 10 }] });
    expect([String(rate), p.status >= 400 && p.status < 500]).toEqual([String(rate), true]);
  }
  // ids, dates, paging, hostile text: always a clean 4xx or a normal answer
  const hostile = ["'; DROP TABLE journal_lines; --", '" OR 1=1 --', '%', '\\', '<script>alert(1)</script>', 'a'.repeat(5000), '\u0000', '😀'];
  const urls = ['/payment-vouchers/not-a-uuid', '/receipt-vouchers/123', '/journal-vouchers/%00', '/accounts/xyz', '/sales-invoices/1', '/purchase-invoices/1',
    '/payment-vouchers?page=0', '/payment-vouchers?limit=100000', '/payment-vouchers?limit=-1', '/payment-vouchers?status=HACKED', '/payment-vouchers?dateFrom=2026-02-30', '/receipt-vouchers?dateTo=31-12-2026',
    '/accounting/trial-balance?dateFrom=2026-13-01', '/accounting/trial-balance?fiscalYear=abc', '/accounting/profit-loss?dateTo=nope', '/accounting/balance-sheet?date=2026-00-10', '/accounting/cutoff?date=1', '/accounting/payables?page=-3',
    `/accounting/party-ledger?partyType=BAD&partyId=${UUID}`, `/accounting/party-ledger?partyType=VENDOR&partyId=${UUID}`, '/accounting/bank-summary?accountId=zzz'];
  for (const url of urls) {
    const r = await w.api('get', url);
    expect([url, r.status >= 400 && r.status < 500]).toEqual([url, true]);
  }
  for (const text of hostile) {
    for (const url of [`/payment-vouchers?search=${encodeURIComponent(text)}`, `/receipt-vouchers?search=${encodeURIComponent(text)}`, `/journal-vouchers?search=${encodeURIComponent(text)}`,
      `/accounts?search=${encodeURIComponent(text)}`, `/accounting/balances?search=${encodeURIComponent(text)}`, `/accounting/payables?search=${encodeURIComponent(text)}`,
      `/accounting/cutoff?search=${encodeURIComponent(text)}&detail=true`]) {
      const r = await w.api('get', url);
      expect([url.slice(0, 40), r.status < 500]).toEqual([url.slice(0, 40), true]);
    }
    const r = await payment(w, { vendorId: v.id, payFromAccountId: bank, paymentMode: 'CASH', notes: text, chequeNo: text, lines: [{ advance: true, amount: 1, notes: text }] });
    expect(r.status < 500).toBe(true);
    const j = await w.api('post', '/journal-vouchers', { reference: text, narration: text, lines: [{ accountId: bank, debit: 1, narration: text }, { accountId: cash, credit: 1 }] });
    expect(j.status < 500).toBe(true);
  }
  // the tables are all still there and the books are intact
  const t = await tb(w);
  expect(t.balanced).toBe(true);
  expect(t.checks.every((x) => x.ok)).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------------- 4. the arithmetic of the withholding tax, penny by penny

const cents = (n) => BigInt(Math.round(Number(n) * 100));
/** half-up integer division of non-negative BigInts */
const divHalfUp = (a, b) => (a * 2n + b) / (2n * b);

test('AUDIT arithmetic: income tax on payments and receipts equals an independent exact (BigInt) calculation for many amounts and rates', async () => {
  const w = await setup();
  const c = await w.customer('AZ');
  const v = await w.vendor('NEXUS');
  const inv = await salesInvoice(w, c, { gross: 1000000, taxRate: 0 });
  const bill = await purchaseInvoice(w, v, { gross: 1000000 });
  const bank = await w.id('1102');
  const amounts = ['0.01', '0.99', '1.00', '3.33', '9.99', '100.01', '101.52', '333.33', '1234.56', '4999.99', '12345.67', '99999.99'];
  const rates = [0.25, 0.5, 1, 1.5, 2, 3.5, 4.5, 7.5, 10, 12.5, 15, 33.33];
  let n = 0;
  for (const amount of amounts) {
    const rate = rates[n % rates.length];
    n += 1;
    const bp = BigInt(Math.round(rate * 100));
    // receipt: cheque (cash that arrives); tax = cheque x rate / (100 - rate); bill = cheque + tax
    const rc = cents(amount);
    const tax = divHalfUp(rc * bp, 10000n - bp);
    const r = await ok(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CASH', lines: [{ salesInvoiceId: inv.id, chequeAmount: amount, incomeTaxRate: rate }] }));
    expect([amount, rate, cents(r.lines[0].incomeTax), cents(r.lines[0].billAmount)]).toEqual([amount, rate, tax, rc + tax]);
    expect([cents(r.grandTotal), cents(r.incomeTax), cents(r.net)]).toEqual([rc + tax, tax, rc]);
    // payment: tax = bills x rate / 100; net = bills - tax
    const pc = cents(amount);
    const ptax = divHalfUp(pc * bp, 10000n);
    const p = await ok(payment(w, { vendorId: v.id, payFromAccountId: bank, paymentMode: 'CASH', incomeTaxRate: rate, lines: [{ purchaseInvoiceId: bill.id, amount }] }));
    expect([amount, rate, cents(p.incomeTax), cents(p.net)]).toEqual([amount, rate, ptax, pc - ptax]);
    expect(cents(p.billsTotal)).toBe(pc);
  }
  // a confirmed one: the journal entry is exactly balanced and equals the figures
  const r = await ok(receipt(w, { customerId: c.id, depositAccountId: bank, paymentMode: 'CHEQUE', chequeNo: '1', lines: [{ salesInvoiceId: inv.id, chequeAmount: '12345.67', incomeTaxRate: 4.5 }] }));
  await ok(w.api('post', `/receipt-vouchers/${r.id}/confirm`), 200);
  const e = await ok(w.api('get', `/receipt-vouchers/${r.id}/accounts-entry`), 200);
  expect(e.current.balanced).toBe(true);
  expect(e.current.totals.debit).toBe(e.current.totals.credit);
});

// ---------------------------------------------------------------------------------------------------------------------------- 5. random life of the books: whatever happens, the books must still balance

/** a small deterministic random generator, so a failure can be repeated */
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

test('AUDIT random operations: 70 random vouchers, confirms, move-to-drafts, deletes and journal vouchers; every check stays green', async () => {
  const w = await setup();
  const rand = rng(20261027);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const vendors = [await w.vendor('V1'), await w.vendor('V2'), await w.vendor('V3')];
  const customers = [await w.customer('C1'), await w.customer('C2'), await w.customer('C3')];
  const bills = [];
  const invoices = [];
  for (let i = 0; i < 3; i += 1) {
    bills.push({ ...(await purchaseInvoice(w, vendors[i], { gross: 5000 + i * 1000, tax: 100 * i, billNo: `B-${i}`, date: `2026-10-0${i + 1}` })), vendor: vendors[i] });
    invoices.push({ ...(await salesInvoice(w, customers[i], { gross: 8000 + i * 500, date: `2026-10-0${i + 1}` })), customer: customers[i] });
  }
  const bank = await w.id('1102');
  const cash = await w.id('1101');
  const equity = await w.id('3001');
  const draftsP = [];
  const draftsR = [];
  const draftsJ = [];
  const doneP = [];
  const doneR = [];
  const doneJ = [];
  const log = [];
  const ran = async (label, p) => { const r = await p; log.push([label, r.status]); expect([label, r.status < 500]).toEqual([label, true]); return r; };
  const money = () => (Math.floor(rand() * 200000) / 100 + 0.01).toFixed(2);
  const remove = (list, x) => { const i = list.indexOf(x); if (i >= 0) list.splice(i, 1); };

  for (let step = 1; step <= 70; step += 1) {
    const op = pick(['payDraft', 'payDraft', 'recDraft', 'recDraft', 'jvDraft', 'confirmP', 'confirmP', 'confirmR', 'confirmR', 'confirmJ', 'unP', 'unR', 'unJ', 'delP', 'delR', 'delJ']);
    if (op === 'payDraft') {
      const b = pick(bills);
      const lines = rand() < 0.3 ? [{ advance: true, amount: money() }] : [{ purchaseInvoiceId: b.id, amount: money() }];
      const r = await ran(op, payment(w, { vendorId: b.vendor.id, payFromAccountId: pick([bank, cash]), paymentMode: pick(['CASH', 'CHEQUE', 'ONLINE']), incomeTaxRate: pick([0, 0.25, 1, 4.5]), voucherDate: '2026-10-2' + Math.floor(rand() * 6), lines }));
      if (r.status === 201) draftsP.push(r.body.id);
    } else if (op === 'recDraft') {
      const i = pick(invoices);
      const lines = rand() < 0.3 ? [{ advance: true, chequeAmount: money() }] : [{ salesInvoiceId: i.id, chequeAmount: money(), incomeTaxRate: pick([0, 1, 2, 5]) }];
      const r = await ran(op, receipt(w, { customerId: i.customer.id, depositAccountId: pick([bank, cash]), paymentMode: pick(['CASH', 'CHEQUE']), voucherDate: '2026-10-2' + Math.floor(rand() * 6), lines }));
      if (r.status === 201) draftsR.push(r.body.id);
    } else if (op === 'jvDraft') {
      const amount = money();
      const useParty = rand() < 0.5;
      const c = pick(customers);
      const lines = useParty
        ? [{ accountId: await w.id('1103'), debit: amount, partyId: c.id }, { accountId: equity, credit: amount }]
        : [{ accountId: pick([bank, cash]), debit: amount }, { accountId: equity, credit: amount }];
      const r = await ran(op, w.api('post', '/journal-vouchers', { voucherDate: '2026-10-1' + Math.floor(rand() * 9), lines }));
      if (r.status === 201) draftsJ.push(r.body.id);
    } else if (op === 'confirmP' && draftsP.length) {
      const id = pick(draftsP);
      const r = await ran(op, w.api('post', `/payment-vouchers/${id}/confirm`));
      if (r.status === 200) { remove(draftsP, id); doneP.push(id); }
    } else if (op === 'confirmR' && draftsR.length) {
      const id = pick(draftsR);
      const r = await ran(op, w.api('post', `/receipt-vouchers/${id}/confirm`));
      if (r.status === 200) { remove(draftsR, id); doneR.push(id); }
    } else if (op === 'confirmJ' && draftsJ.length) {
      const id = pick(draftsJ);
      const r = await ran(op, w.api('post', `/journal-vouchers/${id}/confirm`));
      if (r.status === 200) { remove(draftsJ, id); doneJ.push(id); }
    } else if (op === 'unP' && doneP.length) {
      const id = pick(doneP);
      const r = await ran(op, w.api('post', `/payment-vouchers/${id}/unconfirm`, {}));
      if (r.status === 200) { remove(doneP, id); draftsP.push(id); }
    } else if (op === 'unR' && doneR.length) {
      const id = pick(doneR);
      const r = await ran(op, w.api('post', `/receipt-vouchers/${id}/unconfirm`, {}));
      if (r.status === 200) { remove(doneR, id); draftsR.push(id); }
    } else if (op === 'unJ' && doneJ.length) {
      const id = pick(doneJ);
      const r = await ran(op, w.api('post', `/journal-vouchers/${id}/unconfirm`, {}));
      if (r.status === 200) { remove(doneJ, id); draftsJ.push(id); }
    } else if (op === 'delP' && draftsP.length) {
      const id = pick(draftsP);
      if ((await ran(op, w.api('delete', `/payment-vouchers/${id}`))).status === 204) remove(draftsP, id);
    } else if (op === 'delR' && draftsR.length) {
      const id = pick(draftsR);
      if ((await ran(op, w.api('delete', `/receipt-vouchers/${id}`))).status === 204) remove(draftsR, id);
    } else if (op === 'delJ' && draftsJ.length) {
      const id = pick(draftsJ);
      if ((await ran(op, w.api('delete', `/journal-vouchers/${id}`))).status === 204) remove(draftsJ, id);
    }
    if (step % 23 === 0) {
      const t = await tb(w);
      expect([step, t.balanced, t.checks.filter((c) => !c.ok).map((c) => c.key)]).toEqual([step, true, []]);
    }
  }

  // the end: every check green, the balance sheet balances, the lists agree with each other, the paid amounts agree with the confirmed vouchers
  const t = await tb(w);
  expect(t.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
  expect(t.balanced).toBe(true);
  const bs = await ok(w.api('get', '/accounting/balance-sheet?date=2026-10-31'), 200);
  expect([bs.balanced, bs.difference]).toEqual([true, '0.00']);
  const bal = await ok(w.api('get', '/accounting/balances?date=2026-10-31'), 200);
  const pay = await ok(w.api('get', '/accounting/payables?date=2026-10-31&limit=500'), 200);
  const rec = await ok(w.api('get', '/accounting/receivables?date=2026-10-31&limit=500'), 200);
  const cut = await ok(w.api('get', '/accounting/cutoff?date=2026-10-31'), 200);
  // the receivable list: customers on the debit side; payable: vendors on the credit side. The three screens must give the same ledger totals
  const debits = rec.data.filter((r) => r.balanceSide === 'DEBIT').reduce((s, r) => s + cents(r.balance), 0n);
  expect(cents(bal.receivables.total)).toBe(debits);
  const credits = pay.data.filter((r) => r.balanceSide === 'CREDIT').reduce((s, r) => s + cents(r.balance), 0n);
  expect(cents(bal.payables.total)).toBe(credits);
  // cut-off ledger totals = the signed total of all customers / vendors
  const signedCustomers = rec.data.reduce((s, r) => s + (r.balanceSide === 'DEBIT' ? cents(r.balance) : r.balanceSide === 'CREDIT' ? -cents(r.balance) : 0n), 0n);
  expect(cents(cut.receivable.ledgerBalance)).toBe(signedCustomers);
  const signedVendors = pay.data.reduce((s, r) => s + (r.balanceSide === 'CREDIT' ? cents(r.balance) : r.balanceSide === 'DEBIT' ? -cents(r.balance) : 0n), 0n);
  expect(cents(cut.payable.ledgerBalance)).toBe(signedVendors);
  // every invoice: received / paid never above the invoice and equal to the confirmed vouchers (the check INVOICE_PAYMENTS_MATCH_VOUCHERS is in t.checks)
  const rows = await sql('SELECT "netAmount"::float AS n, "receivedAmount"::float AS r FROM sales_invoices WHERE "companyId" = :c', { c: w.company.id });
  for (const r of rows) expect(r.r <= r.n + 1e-9 && r.r >= 0).toBe(true);
  const prow = await sql('SELECT "netAmount"::float AS n, "paidAmount"::float AS r FROM purchase_invoices WHERE "companyId" = :c', { c: w.company.id });
  for (const r of prow) expect(r.r <= r.n + 1e-9 && r.r >= 0).toBe(true);
  // how many operations really happened (a test that only gets refusals would prove nothing)
  const done = log.filter(([, s]) => s === 200 || s === 201 || s === 204).length;
  expect(done).toBeGreaterThan(30);
  expect(log.filter(([l, s]) => l.startsWith('confirm') && s === 200).length).toBeGreaterThan(5);
});

test('AUDIT engine: the journal itself refuses a customer / vendor of another company, and keeps refusing unbalanced or one-sided lines', async () => {
  const a = await setup();
  const b = await setup();
  const foreign = await b.customer('NOT MINE');
  const foreignV = await b.vendor('NOT MINE EITHER');
  const ar = await a.id('1103');
  const ap = await a.id('2101');
  const cash = await a.id('1101');
  await expect(a.post({ sourceType: 'JOURNAL_VOUCHER', lines: [{ accountId: ar, debit: 10, partyType: 'CUSTOMER', partyId: foreign.id }, { accountId: cash, credit: 10 }] })).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
  await expect(a.post({ sourceType: 'JOURNAL_VOUCHER', lines: [{ accountId: cash, debit: 10 }, { accountId: ap, credit: 10, partyType: 'VENDOR', partyId: foreignV.id }] })).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
  await expect(a.post({ sourceType: 'JOURNAL_VOUCHER', lines: [{ accountId: cash, debit: 10 }, { accountId: ap, credit: 9.99 }] })).rejects.toMatchObject({ code: 'UNBALANCED' });
  await expect(a.post({ sourceType: 'JOURNAL_VOUCHER', lines: [{ accountId: cash, debit: 10, credit: 10 }, { accountId: ap, credit: 0 }] })).rejects.toMatchObject({ code: 'LINE_ONE_SIDE' });
  await expect(a.post({ sourceType: 'JOURNAL_VOUCHER', lines: [{ accountId: cash, debit: 10 }] })).rejects.toMatchObject({ code: 'TOO_FEW_LINES' });
  // nothing was saved by any of the refusals
  const [{ n }] = await sql('SELECT count(*)::int AS n FROM journal_entries WHERE "companyId" = :c', { c: a.company.id });
  expect(n).toBe(0);
  // a real party of this company still works
  const mine = await a.customer('MINE');
  const e = await a.post({ sourceType: 'JOURNAL_VOUCHER', lines: [{ accountId: ar, debit: 10, partyType: 'CUSTOMER', partyId: mine.id }, { accountId: cash, credit: 10 }] });
  expect(e.balanced).toBe(true);
});
