const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, Account } = require('../src/models');
const journal = require('../src/services/journalService');
const accountService = require('../src/services/accountService');

beforeEach(clean);

async function setup() {
  const company = await makeCompany();
  const coa = await Service.findOne({ where: { code: 'ACC_COA' } });
  await CompanyService.create({ companyId: company.id, serviceId: coa.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1/accounts${url}`).set(auth).send(body);
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  const inTx = (fn) => sequelize.transaction(fn);
  const mk = async (fields) => (await api('post', '', fields)).body;
  const root = await mk({ code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true });
  const rev = await mk({ code: '4000', name: 'Revenue', accountType: 'INCOME', isGroup: true });
  const bank = await mk({ code: '1100', name: 'Bank', parentId: root.id });
  const sales = await mk({ code: '4100', name: 'Sales', parentId: rev.id });
  return { company, api, req, inTx, root, bank, sales };
}

const entryOf = (s, amount = 100, extra = {}) => ({ sourceType: 'TEST', lines: [{ accountId: s.bank.id, debit: amount }, { accountId: s.sales.id, credit: amount }], ...extra });
const rejectsWith = async (p, code) => { await expect(p).rejects.toMatchObject({ code }); };

test('a balanced entry is posted, numbered per company, and rounded to 2 decimals', async () => {
  const s = await setup();
  const e = await s.inTx((t) => journal.post(s.req, entryOf(s, 0.1 + 0.2, { entryDate: '2026-10-24' }), t));
  expect(e).toMatchObject({ entryNo: 1, status: 'POSTED', balanced: true, entryDate: '2026-10-24', totals: { debit: 0.3, credit: 0.3 } });
  expect(e.lines.map((l) => [l.account.code, l.debit, l.credit])).toEqual([['1100', 0.3, 0], ['4100', 0, 0.3]]);
  expect((await s.inTx((t) => journal.post(s.req, entryOf(s), t))).entryNo).toBe(2);
  expect((await journal.get(s.req, e.id)).lines).toHaveLength(2);
});

test('bad entries are refused: unbalanced, one line, both sides, negative, group account, other company, switched off, bad date, party', async () => {
  const s = await setup();
  const post = (entry) => s.inTx((t) => journal.post(s.req, entry, t));
  await rejectsWith(post({ sourceType: 'T', lines: [{ accountId: s.bank.id, debit: 100 }, { accountId: s.sales.id, credit: 99.99 }] }), 'UNBALANCED');
  await rejectsWith(post({ sourceType: 'T', lines: [{ accountId: s.bank.id, debit: 100 }] }), 'TOO_FEW_LINES');
  await rejectsWith(post({ sourceType: 'T', lines: [{ accountId: s.bank.id, debit: 5, credit: 5 }, { accountId: s.sales.id, credit: 0 }] }), 'LINE_ONE_SIDE');
  await rejectsWith(post({ sourceType: 'T', lines: [{ accountId: s.bank.id, debit: -5 }, { accountId: s.sales.id, credit: -5 }] }), 'LINE_ONE_SIDE');
  await rejectsWith(post({ sourceType: 'T', lines: [{ accountId: s.root.id, debit: 1 }, { accountId: s.sales.id, credit: 1 }] }), 'NOT_POSTING_ACCOUNT');
  await rejectsWith(post({ entryDate: '2026-02-30', ...entryOf(s) }), 'BAD_DATE');
  await rejectsWith(post({ sourceType: 'T', lines: [{ accountId: s.bank.id, debit: 1, partyType: 'CUSTOMER' }, { accountId: s.sales.id, credit: 1 }] }), 'LINE_BAD_PARTY');

  const other = await setup();
  await rejectsWith(post({ sourceType: 'T', lines: [{ accountId: other.bank.id, debit: 1 }, { accountId: s.sales.id, credit: 1 }] }), 'ACCOUNT_NOT_FOUND');

  await s.api('patch', `/${s.bank.id}`, { isActive: false });
  await rejectsWith(post(entryOf(s)), 'ACCOUNT_INACTIVE');
  expect((await sequelize.query('SELECT 1 FROM journal_entries WHERE "companyId" = :c', { replacements: { c: s.company.id } }))[0]).toHaveLength(0); // nothing was saved by the failed ones
});

test('the database itself refuses to change posted lines or to save an unbalanced entry', async () => {
  const s = await setup();
  const e = await s.inTx((t) => journal.post(s.req, entryOf(s, 50), t));
  await expect(sequelize.query('UPDATE journal_lines SET debit = 1 WHERE "entryId" = :id', { replacements: { id: e.id } })).rejects.toThrow(/cannot be changed/);
  await expect(sequelize.query('DELETE FROM journal_lines WHERE "entryId" = :id', { replacements: { id: e.id } })).rejects.toThrow(/cannot be changed/);
  await expect(sequelize.query('DELETE FROM journal_entries WHERE id = :id', { replacements: { id: e.id } })).rejects.toThrow(/cannot be deleted/);
  await expect(sequelize.query("UPDATE journal_entries SET narration = 'x' WHERE id = :id", { replacements: { id: e.id } })).rejects.toThrow(/cannot be changed/);
  // code bypassed: a raw entry with a single line fails when the transaction commits
  await expect(sequelize.transaction(async (t) => {
    const [[{ id }]] = await sequelize.query('INSERT INTO journal_entries ("companyId", "entryNo", "entryDate", "sourceType") VALUES (:c, 99, \'2026-10-24\', \'RAW\') RETURNING id', { replacements: { c: s.company.id }, transaction: t });
    await sequelize.query('INSERT INTO journal_lines ("entryId", "companyId", "lineNo", "accountId", debit) VALUES (:id, :c, 1, :a, 50)', { replacements: { id, c: s.company.id, a: s.bank.id }, transaction: t });
  })).rejects.toThrow(/not balanced/);
});

test('reversal: the same lines the other way round, once, and never of a reversal', async () => {
  const s = await setup();
  const e = await s.inTx((t) => journal.post(s.req, entryOf(s, 250, { sourceId: s.company.id }), t));
  const r = await s.inTx((t) => journal.reverse(s.req, e.id, { reason: 'wrong customer' }, t));
  expect(r).toMatchObject({ reversalOfId: e.id, totals: { debit: 250, credit: 250 }, status: 'POSTED' });
  expect(r.lines.map((l) => [l.account.code, l.debit, l.credit])).toEqual([['1100', 0, 250], ['4100', 250, 0]]);
  expect(r.narration).toBe('Reversal of entry 1: wrong customer');
  expect((await journal.get(s.req, e.id)).status).toBe('REVERSED');
  await rejectsWith(s.inTx((t) => journal.reverse(s.req, e.id, {}, t)), 'ALREADY_REVERSED');
  await rejectsWith(s.inTx((t) => journal.reverse(s.req, r.id, {}, t)), 'CANNOT_REVERSE_A_REVERSAL');
  await rejectsWith(s.inTx((t) => journal.reverse(s.req, e.id, { entryDate: '2020-01-01' }, t)), 'ALREADY_REVERSED');
  expect((await journal.entriesOfSource(s.req, 'TEST', s.company.id)).map((x) => [x.entryNo, x.status])).toEqual([[1, 'REVERSED'], [2, 'POSTED']]);

  // an account switched off later does not block the reversal
  const e2 = await s.inTx((t) => journal.post(s.req, entryOf(s, 10), t));
  await Account.update({ isActive: false }, { where: { id: s.bank.id } }); // (the API refuses to switch off an account that has a balance)
  expect((await s.inTx((t) => journal.reverse(s.req, e2.id, {}, t))).reversalOfId).toBe(e2.id);
  // another company cannot reverse it
  const other = await setup();
  await expect(other.inTx((t) => journal.reverse(other.req, e.id, {}, t))).rejects.toMatchObject({ status: 404 });
});

test('an account with entries cannot be deleted, change type, or become a group', async () => {
  const s = await setup();
  await s.inTx((t) => journal.post(s.req, entryOf(s), t));
  expect((await s.api('delete', `/${s.bank.id}`)).body.error.code).toBe('HAS_ENTRIES');
  expect((await s.api('patch', `/${s.bank.id}`, { isGroup: true })).body.error.code).toBe('HAS_ENTRIES');
  const top = (await s.api('post', '', { code: '8000', name: 'Top posting', accountType: 'ASSET' })).body;
  await s.inTx((t) => journal.post(s.req, { sourceType: 'T', lines: [{ accountId: top.id, debit: 1 }, { accountId: s.sales.id, credit: 1 }] }, t));
  expect((await s.api('patch', `/${top.id}`, { accountType: 'EXPENSE' })).body.error.code).toBe('TYPE_LOCKED');
});

test('default accounts: made once with their headers, locked, found again by control type', async () => {
  const company = await makeCompany();
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  const ids = await sequelize.transaction(async (t) => ({
    ar: await accountService.ensureDefault(req, 'CUSTOMERS', t), tax: await accountService.ensureDefault(req, 'OUTPUT_TAX', t), sales: await accountService.ensureDefault(req, 'SALES', t),
  }));
  const again = await sequelize.transaction((t) => accountService.ensureDefault(req, 'CUSTOMERS', t));
  expect(again).toBe(ids.ar);

  const all = await Account.findAll({ where: { companyId: company.id }, raw: true });
  const name = (id) => all.find((a) => a.id === id);
  expect(all).toHaveLength(8);
  expect([name(ids.ar), name(ids.tax), name(ids.sales)].map((a) => [a.name, a.accountType, a.controlType, a.isSystem, a.isGroup])).toEqual([
    ['Accounts Receivable', 'ASSET', 'CUSTOMERS', true, false], ['Output Sales Tax', 'LIABILITY', 'OUTPUT_TAX', true, false], ['Sales', 'INCOME', 'SALES', true, false],
  ]);
  expect(all.map((a) => [a.code, a.name, a.systemKey]).sort()).toEqual([
    ['1000', 'Assets', null], ['1100', 'Current Assets', null], ['1101', 'Accounts Receivable', 'AR_CONTROL'], ['2000', 'Liabilities', null], ['2100', 'Current Liabilities', null],
    ['2101', 'Output Sales Tax', 'OUTPUT_TAX'], ['4000', 'Income', null], ['4001', 'Sales', 'DEFAULT_SALES'],
  ]);

  // locked: not deletable, type / group / control type fixed, cannot be switched off; name and code may change
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code: 'ACC_COA' } })).id });
  const api = (m, url, body) => request(app)[m](`/api/v1/accounts${url}`).set(auth).send(body);
  expect((await api('delete', `/${ids.sales}`)).body.error.code).toBe('SYSTEM_LOCKED');
  expect((await api('patch', `/${ids.sales}`, { isActive: false })).body.error.code).toBe('SYSTEM_LOCKED');
  expect((await api('patch', `/${ids.sales}`, { controlType: null })).body.error.code).toBe('SYSTEM_LOCKED');
  expect((await api('patch', `/${ids.sales}`, { isGroup: true })).body.error.code).toBe('SYSTEM_LOCKED');
  const renamed = await api('patch', `/${ids.sales}`, { name: 'Sales Revenue', code: '4100' });
  expect(renamed.status).toBe(200);
  expect(renamed.body).toMatchObject({ name: 'Sales Revenue', code: '4100', isSystem: true, isLocked: true, systemKey: 'DEFAULT_SALES' });
  expect((await accountService.get(req, ids.sales)).isSystem).toBe(true);
});

test('default accounts: the company\'s own account of the same name is used, an existing header is not doubled, a switched-off one is reported', async () => {
  const s = await setup();
  const cur = (await s.api('post', '', { code: '1500', name: 'Current Assets', parentId: s.root.id, isGroup: true })).body;
  const mine = (await s.api('post', '', { code: '1510', name: 'Accounts Receivable', parentId: cur.id })).body;
  const ar = await s.inTx((t) => accountService.ensureDefault(s.req, 'CUSTOMERS', t));
  expect(ar).toBe(mine.id);
  expect(await Account.count({ where: { companyId: s.company.id, name: ['Asset', 'Assets'] } })).toBe(1);
  expect(await Account.count({ where: { companyId: s.company.id, controlType: 'CUSTOMERS', isSystem: true, systemKey: 'AR_CONTROL' } })).toBe(1);

  await Account.update({ isActive: false }, { where: { id: ar } });
  await rejectsWith(s.inTx((t) => accountService.ensureDefault(s.req, 'CUSTOMERS', t)), 'DEFAULT_ACCOUNT_INACTIVE');
});
