const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account, Vendor } = require('../src/models');
const journal = require('../src/services/journalService');

beforeEach(clean);

const token = async (u) => ({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
const caller = (auth, base) => (m, url, body) => request(app)[m](`/api/v1${base}${url}`).set(auth).send(body);

async function setup({ template = true, services = [] } = {}) {
  const company = await makeCompany();
  for (const code of ['ACC_COA', ...services]) {
    await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = await token(admin);
  const accounts = caller(auth, '/accounts');
  const acc = caller(auth, '/accounting');
  const api = caller(auth, '');
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  if (template) expect((await accounts('post', '/apply-template', { templateKey: 'other' })).status).toBe(200);
  const id = async (code) => (await Account.findOne({ where: { companyId: company.id, code } })).id;
  const put = (body) => acc('put', '/opening-balances', body);
  const employee = async (access) => {
    const u = await makeUser({ userType: 'USER', companyId: company.id });
    await UserService.create({ userId: u.id, serviceId: (await Service.findOne({ where: { code: 'ACC_COA' } })).id, access });
    return caller(await token(u), '/accounting');
  };
  return { company, accounts, acc, api, req, id, put, employee };
}

const ok = async (p, status = 200) => {
  const r = await p;
  expect(r.status).toBe(status);
  return r.body;
};
const fails = async (p, status, code) => {
  const r = await p;
  expect(r.status).toBe(status);
  expect(r.body.error.code).toBe(code);
  return r.body.error;
};
const byCode = (tree, code) => {
  for (const n of tree) {
    if (n.code === code) return n;
    const inner = byCode(n.children || [], code);
    if (inner) return inner;
  }
  return null;
};
const tree = async (s) => (await ok(s.accounts('get', '/tree'))).data;

test('nothing yet: an empty answer, and whether income / expense may have an opening balance on that date', async () => {
  const s = await setup();
  expect(await ok(s.acc('get', '/opening-balances'))).toEqual({
    date: null, entryId: null, entryNo: null, fiscalYearStartMonth: 7, plOpeningAllowed: null, locked: false, lockedReason: null, lines: [], totals: { debit: '0.00', credit: '0.00' }, balanced: true,
  });
  expect((await ok(s.acc('get', '/opening-balances?date=2026-07-01'))).plOpeningAllowed).toBe(false); // the first day of the fiscal year
  expect((await ok(s.acc('get', '/opening-balances?date=2026-10-01'))).plOpeningAllowed).toBe(true); // in the middle of the year
  await fails(s.acc('get', '/opening-balances?date=2026-02-30'), 400, 'VALIDATION_FAILED');
});

test('save: ONE opening entry; exact amounts; the balances show on the accounts', async () => {
  const s = await setup();
  const result = await ok(s.put({ date: '2026-07-01', lines: [
    { accountId: await s.id('1102'), amount: '5000.50' }, { accountId: await s.id('1201'), amount: 20000 }, { accountId: await s.id('3001'), amount: '25000.50' },
  ] }));
  expect(result).toMatchObject({ date: '2026-07-01', entryNo: 1, locked: false, balanced: true, totals: { debit: '25000.50', credit: '25000.50' } });
  expect(result.lines.map((l) => [l.code, l.side, l.amount])).toEqual([['1102', 'DEBIT', '5000.50'], ['1201', 'DEBIT', '20000.00'], ['3001', 'CREDIT', '25000.50']]);

  const [[entry]] = await sequelize.query('SELECT "sourceType", status, to_char("entryDate", \'YYYY-MM-DD\') AS d FROM journal_entries WHERE "companyId" = :c', { replacements: { c: s.company.id } });
  expect(entry).toEqual({ sourceType: 'OPENING', status: 'POSTED', d: '2026-07-01' });
  const t = await tree(s);
  expect(byCode(t, '1102')).toMatchObject({ currentBalance: '5000.50', balanceSide: 'DEBIT' });
  expect(byCode(t, '3001')).toMatchObject({ currentBalance: '25000.50', balanceSide: 'CREDIT' });
  expect(byCode(t, '1000')).toMatchObject({ currentBalance: '25000.50', balanceSide: 'DEBIT' });
  // the same thing when asked again
  expect((await ok(s.acc('get', '/opening-balances'))).lines).toHaveLength(3);
});

test('debit must equal credit; a balancing account takes the difference; switched-off accounts count too', async () => {
  const s = await setup();
  const bank = await s.id('1102');
  const error = await fails(s.put({ date: '2026-07-01', lines: [{ accountId: bank, amount: '100.10' }, { accountId: await s.id('3001'), amount: '100.09' }] }), 422, 'UNBALANCED');
  expect(error.details).toEqual({ debit: '100.10', credit: '100.09', difference: '0.01', side: 'CREDIT' });

  // a switched-off account (no balance) may carry an opening amount; it counts in the totals
  const old = await s.id('2103');
  await Account.update({ isActive: false }, { where: { id: old } });
  await ok(s.put({ date: '2026-07-01', balancingAccountId: await s.id('3005'), lines: [{ accountId: bank, amount: '100.10' }, { accountId: old, amount: '30' }, { accountId: await s.id('3001'), amount: '100.09' }] }));
  const now = await ok(s.acc('get', '/opening-balances'));
  expect(now.balanced).toBe(true);
  expect(now.totals.debit).toBe(now.totals.credit);
  expect(now.totals.debit).toBe('130.09');
  const balancing = now.lines.find((l) => l.code === '3005');
  expect(balancing).toMatchObject({ side: 'DEBIT', amount: '29.99' }); // 130.09 credit - 100.10 debit
  // the other way round
  const other = await ok(s.put({ date: '2026-07-01', balancingAccountId: await s.id('3005'), lines: [{ accountId: bank, amount: '500' }] }));
  expect(other.lines.find((l) => l.code === '3005')).toMatchObject({ side: 'CREDIT', amount: '500.00' });
  expect(other.totals).toEqual({ debit: '500.00', credit: '500.00' });
});

test('saving again replaces it: the old entry is reversed (kept), clearing it leaves only the reversal', async () => {
  const s = await setup();
  const lines = async (bank, cap) => [{ accountId: await s.id('1102'), amount: bank }, { accountId: await s.id('3001'), amount: cap }];
  await ok(s.put({ date: '2026-07-01', lines: await lines('100', '100') }));
  const second = await ok(s.put({ date: '2026-07-01', lines: await lines('250.25', '250.25') }));
  expect(second.entryNo).toBe(3); // 1 = first, 2 = its reversal, 3 = the new one
  const rows = (await sequelize.query('SELECT "entryNo", status, "sourceType", "reversalOfId" IS NOT NULL AS reversal FROM journal_entries WHERE "companyId" = :c ORDER BY "entryNo"', { replacements: { c: s.company.id } }))[0];
  expect(rows).toEqual([
    { entryNo: 1, status: 'REVERSED', sourceType: 'OPENING', reversal: false }, { entryNo: 2, status: 'POSTED', sourceType: 'OPENING', reversal: true }, { entryNo: 3, status: 'POSTED', sourceType: 'OPENING', reversal: false },
  ]);
  expect(byCode(await tree(s), '1102')).toMatchObject({ currentBalance: '250.25', balanceSide: 'DEBIT' }); // only the new one counts

  const cleared = await ok(s.put({ date: '2026-07-01', lines: [{ accountId: await s.id('1102'), amount: '0' }] }));
  expect(cleared).toMatchObject({ entryId: null, lines: [], totals: { debit: '0.00', credit: '0.00' } });
  expect(byCode(await tree(s), '1102')).toMatchObject({ currentBalance: '0.00', balanceSide: null });
});

test('income and expense: only when the books start in the middle of a fiscal year', async () => {
  const s = await setup();
  const rent = await s.id('6001');
  const capital = await s.id('3001');
  const body = (date) => ({ date, lines: [{ accountId: rent, amount: '100' }, { accountId: capital, amount: '100' }] });
  await fails(s.put(body('2026-07-01')), 422, 'PL_OPENING_NOT_ALLOWED'); // fiscal year starts in July
  expect((await ok(s.put(body('2026-10-01')))).totals.debit).toBe('100.00'); // mid-year

  expect(await ok(s.acc('get', '/settings'))).toEqual({ fiscalYearStartMonth: 7 });
  expect(await ok(s.acc('put', '/settings', { fiscalYearStartMonth: 10 }))).toEqual({ fiscalYearStartMonth: 10 });
  await fails(s.put(body('2026-10-01')), 422, 'PL_OPENING_NOT_ALLOWED'); // now October is the first month of the year
  expect((await ok(s.put(body('2026-07-01')))).entryNo).toBe(3); // and July is mid-year
  await fails(s.acc('put', '/settings', { fiscalYearStartMonth: 13 }), 400, 'VALIDATION_FAILED');
  const viewer = await s.employee('VIEW');
  expect((await viewer('get', '/settings')).status).toBe(200);
  await fails(viewer('put', '/settings', { fiscalYearStartMonth: 1 }), 403, 'FORBIDDEN');
  await fails(viewer('put', '/opening-balances', { date: '2026-07-01', lines: [] }), 403, 'FORBIDDEN');
});

test('customers and suppliers: with a customer / vendor list each line names who owes, otherwise one total is fine', async () => {
  // no customers or vendors yet: one total each
  const plain = await setup();
  const result = await ok(plain.put({ date: '2026-07-01', lines: [
    { accountId: await plain.id('1103'), amount: '900' }, { accountId: await plain.id('2101'), amount: '400' }, { accountId: await plain.id('3001'), amount: '500' },
  ] }));
  expect(result.lines.map((l) => [l.code, l.partyType])).toEqual([['1103', null], ['2101', null], ['3001', null]]);

  // with customers and vendors
  const s = await setup({ services: ['GREY_STORE'] });
  const customer = (await ok(s.api('post', '/customers', { name: 'AZ TEXTILES' }), 201));
  const vendor = await Vendor.create({ companyId: s.company.id, code: 1, name: 'DYES CO' });
  const ar = await s.id('1103');
  const ap = await s.id('2101');
  const cap = await s.id('3001');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: ar, amount: '900' }, { accountId: cap, amount: '900' }] }), 422, 'CONTROL_USES_SUBLEDGER');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: ap, amount: '400' }, { accountId: await s.id('1102'), amount: '400' }] }), 422, 'CONTROL_USES_SUBLEDGER');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: await s.id('1102'), amount: '10', partyId: customer.id }, { accountId: cap, amount: '10' }] }), 422, 'LINE_BAD_PARTY');
  // a customer of another company is not found
  const stranger = await setup({ services: ['GREY_STORE'] });
  const foreign = (await ok(stranger.api('post', '/customers', { name: 'OTHER' }), 201));
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: ar, amount: '900', partyId: foreign.id }, { accountId: cap, amount: '900' }] }), 404, 'NOT_FOUND');

  const saved = await ok(s.put({ date: '2026-07-01', lines: [
    { accountId: ar, amount: '600', partyId: customer.id }, { accountId: ar, amount: '300', partyId: customer.id },
    { accountId: ap, amount: '400', partyId: vendor.id }, { accountId: cap, amount: '500' },
  ] }));
  expect(saved.lines.map((l) => [l.code, l.side, l.amount, l.partyType])).toEqual([['1103', 'DEBIT', '600.00', 'CUSTOMER'], ['1103', 'DEBIT', '300.00', 'CUSTOMER'], ['2101', 'CREDIT', '400.00', 'VENDOR'], ['3001', 'CREDIT', '500.00', null]]);
  expect(saved.lines[0].partyId).toBe(customer.id);
  expect(byCode(await tree(s), '1103')).toMatchObject({ currentBalance: '900.00', balanceSide: 'DEBIT' });
  // a control account cannot take the difference
  await fails(s.put({ date: '2026-07-01', balancingAccountId: ar, lines: [{ accountId: cap, amount: '5' }] }), 422, 'CONTROL_USES_SUBLEDGER');
});

test('locked once other entries exist in the books', async () => {
  const s = await setup();
  await ok(s.put({ date: '2026-07-01', lines: [{ accountId: await s.id('1102'), amount: '100' }, { accountId: await s.id('3001'), amount: '100' }] }));
  expect(await ok(s.acc('get', '/opening-balances'))).toMatchObject({ locked: false });
  await sequelize.transaction(async (t) => journal.post(s.req, { sourceType: 'TEST', lines: [{ accountId: await s.id('1101'), debit: 5 }, { accountId: await s.id('4001'), credit: 5 }] }, t));
  const state = await ok(s.acc('get', '/opening-balances'));
  expect(state).toMatchObject({ locked: true });
  expect(state.lockedReason).toContain('Entries other than the opening balances');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: await s.id('1102'), amount: '1' }, { accountId: await s.id('3001'), amount: '1' }] }), 422, 'OPENING_LOCKED');
  // the opening entry itself is untouched
  expect((await ok(s.acc('get', '/opening-balances'))).totals.debit).toBe('100.00');
});

test('bad lines: a folder, an unknown account, bad amounts, zero lines are left out, the side can be given', async () => {
  const s = await setup();
  const bank = await s.id('1102');
  const cap = await s.id('3001');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: await s.id('1100'), amount: '1' }, { accountId: cap, amount: '1' }] }), 422, 'NOT_POSTING_ACCOUNT');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: '6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11', amount: '1' }] }), 422, 'ACCOUNT_NOT_FOUND');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: bank, amount: 'abc' }] }), 400, 'VALIDATION_FAILED');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: bank, amount: -5 }] }), 400, 'VALIDATION_FAILED');
  await fails(s.put({ date: '2026-07-01', lines: [{ accountId: bank, amount: '1.234' }] }), 400, 'VALIDATION_FAILED');
  await fails(s.put({ lines: [] }), 400, 'VALIDATION_FAILED');
  await fails(s.put({ date: '2026-02-30', lines: [] }), 400, 'VALIDATION_FAILED');
  const saved = await ok(s.put({ date: '2026-07-01', lines: [{ accountId: bank, amount: '0' }, { accountId: bank, amount: '70', side: 'CREDIT' }, { accountId: cap, amount: '70', side: 'DEBIT' }] }));
  expect(saved.lines.map((l) => [l.code, l.side, l.amount])).toEqual([['1102', 'CREDIT', '70.00'], ['3001', 'DEBIT', '70.00']]);
  // an account no longer carries its own opening balance
  const t = await tree(s);
  await fails(s.accounts('patch', `/${bank}`, { openingBalance: 5 }), 422, 'USE_OPENING_BALANCES');
  expect(byCode(t, '1102')).toMatchObject({ openingBalance: 0 }); // the old field is still readable
});

test('issues: wrong side, switched off with a balance, a name that looks wrong, an empty folder, missing system accounts, and the fix can be sent as it is', async () => {
  const empty = await setup({ template: false });
  expect(await ok(empty.accounts('get', '/issues'))).toMatchObject({ data: [], total: 0, summary: { ERROR: 0, WARNING: 0, INFO: 0 } });

  const s = await setup();
  const clean0 = await ok(s.accounts('get', '/issues'));
  expect(clean0.data).toEqual([]);
  expect(clean0.rules.map((r) => r.key)).toEqual(['OPENING_WRONG_SIDE', 'BALANCE_WRONG_SIDE', 'INACTIVE_WITH_BALANCE', 'NAME_TYPE_MISMATCH', 'SYSTEM_ACCOUNT_MISSING', 'EMPTY_FOLDER']);

  // opening balances on the wrong side; a contra account is left alone
  const bank = await s.id('1102');
  const cap = await s.id('3001');
  const dep = await s.id('1202'); // contra: its natural side is CREDIT
  await ok(s.put({ date: '2026-10-01', lines: [
    { accountId: bank, amount: '100', side: 'CREDIT' }, { accountId: cap, amount: '100', side: 'DEBIT' }, { accountId: dep, amount: '10', side: 'DEBIT' }, { accountId: await s.id('3003'), amount: '10', side: 'CREDIT' },
  ] }));
  let issues = (await ok(s.accounts('get', '/issues')));
  const keys = (rule) => issues.data.filter((i) => i.ruleKey === rule).map((i) => i.accountId).sort();
  expect(keys('OPENING_WRONG_SIDE')).toEqual([bank, cap].sort());
  expect(keys('BALANCE_WRONG_SIDE')).toEqual([bank, cap].sort()); // Retained Earnings with a credit is normal
  expect(issues.data.find((i) => i.accountId === dep)).toBeUndefined();
  expect(issues.summary.WARNING).toBeGreaterThanOrEqual(4);

  // switched off with a balance (the API would refuse: it is set directly) and the fix reaches the account again
  await Account.update({ isActive: false }, { where: { id: bank } });
  issues = await ok(s.accounts('get', '/issues'));
  const off = issues.data.find((i) => i.ruleKey === 'INACTIVE_WITH_BALANCE');
  expect(off).toMatchObject({ accountId: bank, severity: 'ERROR', suggestedFix: { action: 'PATCH_ACCOUNT', accountId: bank, payload: { isActive: true } } });
  expect(issues.data[0].severity).toBe('ERROR'); // the worst come first
  await ok(s.accounts('patch', `/${off.accountId}`, off.suggestedFix.payload));
  expect((await ok(s.accounts('get', `/${bank}`))).isActive).toBe(true);

  // a name that looks wrong: a top account can be re-typed by the fix, an account inside a folder cannot
  const odd = await ok(s.accounts('post', '', { name: 'Office Rent', accountType: 'ASSET' }), 201);
  const inside = await ok(s.accounts('post', '', { name: 'Rent paid', parentId: await s.id('1100') }), 201);
  issues = await ok(s.accounts('get', '/issues'));
  const hint = issues.data.find((i) => i.accountId === odd.id && i.ruleKey === 'NAME_TYPE_MISMATCH');
  expect(hint).toMatchObject({ severity: 'INFO', suggestedFix: { action: 'PATCH_ACCOUNT', payload: { accountType: 'EXPENSE' } } });
  expect(issues.data.find((i) => i.accountId === inside.id && i.ruleKey === 'NAME_TYPE_MISMATCH').suggestedFix).toBeNull();
  expect((await ok(s.accounts('patch', `/${hint.accountId}`, hint.suggestedFix.payload))).accountType).toBe('EXPENSE');

  // an empty folder
  const folder = await ok(s.accounts('post', '', { name: 'Nothing here', parentId: await s.id('1000'), isGroup: true }), 201);
  issues = await ok(s.accounts('get', '/issues'));
  expect(issues.data.find((i) => i.accountId === folder.id)).toMatchObject({ ruleKey: 'EMPTY_FOLDER', severity: 'INFO', suggestedFix: { payload: { isActive: false } } });
});

test('issues: the system accounts the software needs, and the fix applies a template', async () => {
  const s = await setup({ template: false });
  await ok(s.accounts('post', '', { code: '1000', name: 'My assets', accountType: 'ASSET', isGroup: true }), 201);
  await ok(s.accounts('post', '', { name: 'Stock', parentId: (await Account.findOne({ where: { companyId: s.company.id } })).id }), 201);
  const issues = await ok(s.accounts('get', '/issues'));
  const missing = issues.data.filter((i) => i.ruleKey === 'SYSTEM_ACCOUNT_MISSING');
  expect(missing.map((i) => i.systemKey).sort()).toEqual(['AP_CONTROL', 'AR_CONTROL', 'CURRENT_YEAR_EARNINGS', 'CUSTOMER_ADVANCES', 'DEFAULT_PURCHASES', 'DEFAULT_SALES', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'INPUT_TAX', 'OPENING_BALANCE_EQUITY', 'OUTPUT_TAX', 'RETAINED_EARNINGS', 'ROUNDING', 'SUPPLIER_ADVANCES']);
  expect(missing[0]).toMatchObject({ accountId: null, severity: 'WARNING', suggestedFix: { action: 'APPLY_TEMPLATE', payload: { templateKey: 'other' } } });
  await ok(s.accounts('post', '/apply-template', missing[0].suggestedFix.payload));
  expect((await ok(s.accounts('get', '/issues'))).data.filter((i) => i.ruleKey === 'SYSTEM_ACCOUNT_MISSING')).toEqual([]);
});
