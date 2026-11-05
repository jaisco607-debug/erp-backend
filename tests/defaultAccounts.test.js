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
async function jv(w, date, lines) {
  const v = await ok(w.api('post', '/journal-vouchers', { voucherDate: date, lines }));
  await ok(w.api('post', `/journal-vouchers/${v.id}/confirm`), 200);
  return v;
}

const payment = (w, body) => w.api('post', '/payment-vouchers', body);
const KEYS = ['SALES', 'OUTPUT_TAX', 'CUSTOMERS', 'PURCHASES', 'INPUT_TAX', 'SUPPLIERS', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES', 'EMPLOYEE_LOANS', 'EMPLOYEE_ADVANCES', 'SALARY_EXPENSE', 'SALARIES_PAYABLE', 'EOBI_PAYABLE', 'SALARY_TAX_PAYABLE', 'EMPLOYEE_DEDUCTIONS', 'EOBI_EMPLOYER_EXPENSE'];
const getAcc = (w, id) => ok(w.api('get', `/accounts/${id}`), 200);
/** A new ordinary account under a folder of the standard chart. */
const newAccount = async (w, parentCode, name, accountType) => ok(w.api('post', '/accounts', { name, parentId: await w.id(parentCode), accountType }));

test('default accounts: the tab lists every role with the Chart of Accounts id of its account', async () => {
  const w = await setup();
  const d = await ok(w.api('get', '/accounts/defaults'), 200);
  expect(d.data.map((x) => x.key)).toEqual(KEYS);
  expect(d).toMatchObject({ missing: 8, inactive: 0, groups: [{ code: 'SALES_INVOICE', text: 'Sales invoice' }, { code: 'PURCHASE_INVOICE', text: 'Purchase invoice' }, { code: 'VOUCHERS', text: 'Vouchers' }, { code: 'PAYROLL', text: 'Payroll' }] }); // the standard chart has no Employee Loans account until the first loan voucher (or the Default Accounts tab) makes it
  const sales = d.data.find((x) => x.key === 'SALES');
  expect(sales).toMatchObject({ group: 'SALES_INVOICE', groupText: 'Sales invoice', title: 'Sales', usedBy: ['Sales invoice'], accountType: 'INCOME', status: 'SET', canChange: true, holdsParties: null,
    account: { id: await w.id('4001'), code: '4001', name: 'Sales', isActive: true, hasEntries: false } });
  const ar = d.data.find((x) => x.key === 'CUSTOMERS');
  expect(ar).toMatchObject({ title: 'Accounts Receivable', holdsParties: 'CUSTOMER', usedBy: ['Sales invoice', 'Receipt voucher', 'Contra voucher'], account: { id: await w.id('1103') } });
  expect(d.data.find((x) => x.key === 'SUPPLIERS').account.id).toBe(await w.id('2101'));
  expect(d.data.find((x) => x.key === 'PURCHASES').account.id).toBe(await w.id('5001'));
  expect(d.data.filter((x) => x.group === 'VOUCHERS').map((x) => x.account.code)).toEqual(['1108', '2104', '2105', '1109']);
  // the id is the id of the Chart of Accounts: the same account answers there
  expect((await getAcc(w, sales.account.id))).toMatchObject({ code: '4001', controlType: 'SALES', isSystem: true });
});

test('default accounts: a company without any can make them before its first invoice (one, or all), and nothing is made twice', async () => {
  const w = await setup({ template: false });
  const d = await ok(w.api('get', '/accounts/defaults'), 200);
  expect(d.missing).toBe(18);
  expect(d.data.every((x) => x.status === 'NOT_SET' && x.account === null && x.canChange === true)).toBe(true);
  expect((await ok(w.api('get', '/accounts'), 200)).total).toBe(0);

  const s1 = await ok(w.api('post', '/accounts/defaults/SALES/create'), 200);
  expect(s1).toMatchObject({ key: 'SALES', status: 'SET', account: { name: 'Sales' }, standardName: 'Sales' });
  const again = await ok(w.api('post', '/accounts/defaults/SALES/create'), 200);
  expect(again.account.id).toBe(s1.account.id); // the same account, not a second one
  expect((await ok(w.api('get', '/accounts/defaults'), 200)).missing).toBe(17);

  const all = await ok(w.api('post', '/accounts/defaults/create-all'), 200);
  expect(all.created).toEqual(KEYS.filter((k) => k !== 'SALES'));
  expect(all).toMatchObject({ missing: 0 });
  expect(all.data.find((x) => x.key === 'SALES').account.id).toBe(s1.account.id);
  const ids = all.data.map((x) => x.account.id);
  expect(new Set(ids).size).toBe(18); // eighteen different accounts
  expect((await ok(w.api('post', '/accounts/defaults/create-all'), 200)).created).toEqual([]);
  // they are in the Chart, with their roles
  const system = await sql('SELECT "controlType", "systemKey", "isSystem" FROM accounts WHERE "companyId" = :c AND "isSystem" = true ORDER BY "controlType"', { c: w.company.id });
  expect(system.map((x) => x.controlType).sort()).toEqual([...KEYS].sort());
  await fails(w.api('post', '/accounts/defaults/NOPE/create'), 400, 'VALIDATION_FAILED');
});

test('default accounts: choose an account the company already has; the old default becomes an ordinary account', async () => {
  const w = await setup();
  const mine = await newAccount(w, '4000', 'Fabric Sales', 'INCOME');
  const cand = await ok(w.api('get', '/accounts/defaults/SALES/candidates'), 200);
  expect(cand).toMatchObject({ key: 'SALES', title: 'Sales', currentAccountId: await w.id('4001') });
  // income accounts that are not folders and not contra: Sales (the current one), Other Income, and the new one
  expect(cand.data.map((x) => [x.code, x.current]).sort()).toEqual([['4001', true], ['4003', false], [mine.code, false]].sort());

  const set = await ok(w.api('put', '/accounts/defaults/SALES', { accountId: mine.id }), 200);
  expect(set).toMatchObject({ status: 'SET', account: { id: mine.id, name: 'Fabric Sales' } });
  expect(await getAcc(w, mine.id)).toMatchObject({ controlType: 'SALES', isSystem: true, systemKey: 'DEFAULT_SALES' });
  expect(await getAcc(w, await w.id('4001'))).toMatchObject({ controlType: null, isSystem: false, systemKey: null });
  expect((await ok(w.api('get', '/accounts/defaults'), 200)).data.find((x) => x.key === 'SALES').account.id).toBe(mine.id);
  // choosing the one that is already the default changes nothing
  expect((await ok(w.api('put', '/accounts/defaults/SALES', { accountId: mine.id }), 200)).account.id).toBe(mine.id);
  // the audit log has it
  const log = await sql(`SELECT action FROM audit_logs WHERE "companyId" = :c AND action = 'DEFAULT_ACCOUNT_SET'`, { c: w.company.id });
  expect(log).toHaveLength(1);

  // refused
  const tryPut = (key, accountId) => w.api('put', `/accounts/defaults/${key}`, { accountId });
  await fails(tryPut('SALES', await w.id('4000')), 422, 'NOT_POSTING_ACCOUNT'); // a folder
  await fails(tryPut('SALES', await w.id('1101')), 422, 'DEFAULT_TYPE_MISMATCH'); // an asset
  await fails(tryPut('SALES', await w.id('4002')), 422, 'ACCOUNT_IS_CONTRA'); // sales returns
  await fails(tryPut('INPUT_TAX', await w.id('1102')), 422, 'ACCOUNT_HAS_OTHER_ROLE'); // the bank account
  await fails(tryPut('INPUT_TAX', await w.id('1108')), 422, 'ACCOUNT_HAS_OTHER_ROLE'); // another default
  const off = await newAccount(w, '1100', 'Old Tax Account', 'ASSET');
  await ok(w.api('patch', `/accounts/${off.id}`, { isActive: false }), 200);
  await fails(tryPut('INPUT_TAX', off.id), 422, 'ACCOUNT_INACTIVE');
  await fails(tryPut('SALES', UUID), 404, 'NOT_FOUND');
  await fails(tryPut('NOPE', mine.id), 400, 'VALIDATION_FAILED');
  await fails(w.api('put', '/accounts/defaults/SALES', {}), 400, 'VALIDATION_FAILED');
  await fails(w.api('get', '/accounts/defaults/NOPE/candidates'), 400, 'VALIDATION_FAILED');
});

test('default accounts: the accounts of customers and vendors cannot be swapped once they have entries; the others can', async () => {
  const w = await setup();
  const c = await w.customer('AZ');
  // an entry on Accounts Receivable (with the customer) and one on Equipment (no customer named) and one on Sales
  await jv(w, '2026-10-05', [{ accountId: await w.id('1103'), debit: 100, partyId: c.id }, { accountId: await w.id('4001'), credit: 100 }]);
  await jv(w, '2026-10-06', [{ accountId: await w.id('1201'), debit: 50 }, { accountId: await w.id('3001'), credit: 50 }]);
  const d = await ok(w.api('get', '/accounts/defaults'), 200);
  const item = (k) => d.data.find((x) => x.key === k);
  expect(item('CUSTOMERS')).toMatchObject({ canChange: false, account: { hasEntries: true } });
  expect(item('SALES')).toMatchObject({ canChange: true, account: { hasEntries: true } });
  expect(item('SUPPLIERS').canChange).toBe(true); // no entries yet

  const debtors = await newAccount(w, '1100', 'Debtors', 'ASSET');
  const e = await fails(w.api('put', '/accounts/defaults/CUSTOMERS', { accountId: debtors.id }), 422, 'DEFAULT_IN_USE');
  expect(e.details).toEqual({ currentAccountId: await w.id('1103') });
  // an account with entries that name nobody cannot hold the customers' balances
  await fails(w.api('put', '/accounts/defaults/SUPPLIER_ADVANCES', { accountId: await w.id('1201') }), 422, 'ACCOUNT_HAS_ENTRIES');
  const cand = await ok(w.api('get', '/accounts/defaults/SUPPLIER_ADVANCES/candidates'), 200);
  expect(cand.data.map((x) => x.code)).not.toContain('1201');
  expect(cand.data.map((x) => x.code)).toContain(debtors.code);
  // an account without entries may take the role of an account without entries
  const ok2 = await ok(w.api('put', '/accounts/defaults/SUPPLIER_ADVANCES', { accountId: debtors.id }), 200);
  expect(ok2.account.name).toBe('Debtors');
  // a role without customers or vendors may be moved even if the old account has entries: the history stays where it is
  const fabric = await newAccount(w, '4000', 'Fabric Sales', 'INCOME');
  await ok(w.api('put', '/accounts/defaults/SALES', { accountId: fabric.id }), 200);
  expect((await tb(w)).balanced).toBe(true);
});

test('default accounts: vouchers (and invoices) post to the account chosen before, and the books agree', async () => {
  const w = await setup();
  const mineAdvance = await newAccount(w, '1100', 'Advances to Vendors', 'ASSET');
  const mineTax = await newAccount(w, '2100', 'WHT Payable', 'LIABILITY');
  await ok(w.api('put', '/accounts/defaults/SUPPLIER_ADVANCES', { accountId: mineAdvance.id }), 200);
  await ok(w.api('put', '/accounts/defaults/INCOME_TAX_VENDORS', { accountId: mineTax.id }), 200);
  const accountsBefore = (await ok(w.api('get', '/accounts'), 200)).total;
  const v = await w.vendor('NEXUS');
  const bank = await w.id('1102');
  const p = await ok(payment(w, { vendorId: v.id, payFromAccountId: bank, paymentMode: 'CASH', incomeTaxRate: 1, voucherDate: '2026-10-24', lines: [{ advance: true, amount: 1000 }] })); // dated inside the month the trial balance below reads
  await ok(w.api('post', `/payment-vouchers/${p.id}/confirm`), 200);
  const e = await ok(w.api('get', `/payment-vouchers/${p.id}/accounts-entry`), 200);
  expect(e.current.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Advances to Vendors', 1000, 0], ['WHT Payable', 0, 10], ['Bank Account', 0, 990]]);
  expect((await ok(w.api('get', '/accounts'), 200)).total).toBe(accountsBefore); // nothing was made on the way
  const t = await tb(w);
  expect(row(t, 'Advances to Vendors')).toMatchObject({ closingDebit: '1000.00' });
  expect(row(t, 'Supplier Advances')).toBeUndefined();
  expect(t.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]); // the control check follows the chosen account
});

test('default accounts: access, and another company', async () => {
  const w = await setup();
  const nobody = caller(await token(await makeUser({ userType: 'USER', companyId: w.company.id })));
  for (const [m, url, body] of [['get', '/accounts/defaults'], ['get', '/accounts/defaults/SALES/candidates'], ['put', '/accounts/defaults/SALES', { accountId: UUID }], ['post', '/accounts/defaults/SALES/create'], ['post', '/accounts/defaults/create-all']]) {
    expect([m, url, (await nobody(m, url, body)).status]).toEqual([m, url, 403]);
  }
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'ACC_COA' } })).id, access: 'VIEW' });
  const vw = caller(await token(viewer));
  await ok(vw('get', '/accounts/defaults'), 200);
  await ok(vw('get', '/accounts/defaults/SALES/candidates'), 200);
  await fails(vw('put', '/accounts/defaults/SALES', { accountId: await w.id('4003') }), 403, 'FORBIDDEN');
  await fails(vw('post', '/accounts/defaults/create-all'), 403, 'FORBIDDEN');
  expect((await w.api('get', '/accounts/defaults').then((r) => r.status))).toBe(200);
  // another company: its own defaults only; it cannot use this company's account
  const other = await setup();
  const mine = await other.api('get', '/accounts/defaults').then((r) => r.body);
  expect(mine.data.find((x) => x.key === 'SALES').account.id).not.toBe(await w.id('4001'));
  await fails(other.api('put', '/accounts/defaults/SALES', { accountId: await w.id('4003') }), 404, 'NOT_FOUND');
});
