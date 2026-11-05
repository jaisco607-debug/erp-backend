const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account, Customer } = require('../src/models');
const journal = require('../src/services/journalService');
const { fiscalYearRange, fiscalYearStart } = require('../src/services/trialBalanceService');

beforeEach(clean);

const token = async (u) => ({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
const caller = (auth, base) => (m, url, body) => request(app)[m](`/api/v1${base}${url}`).set(auth).send(body);

async function setup() {
  const company = await makeCompany();
  for (const code of ['ACC_COA', 'ACC_REPORTS']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = await token(admin);
  const accounts = caller(auth, '/accounts');
  const acc = caller(auth, '/accounting');
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  expect((await accounts('post', '/apply-template', { templateKey: 'other' })).status).toBe(200);
  const id = async (code) => (await Account.findOne({ where: { companyId: company.id, code } })).id;
  const post = (entryDate, lines, sourceType = 'TEST') => sequelize.transaction((t) => journal.post(req, { entryDate, sourceType, lines }, t));
  const employee = async (grant) => {
    const u = await makeUser({ userType: 'USER', companyId: company.id });
    if (grant) await UserService.create({ userId: u.id, serviceId: (await Service.findOne({ where: { code: 'ACC_REPORTS' } })).id, access: 'VIEW' });
    return caller(await token(u), '/accounting');
  };
  return { company, accounts, acc, req, id, post, employee };
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
};

// 10,000 of capital in the bank on 1 July (the opening entry), then rent, sales and rent again
async function books(s) {
  const bank = await s.id('1102');
  const capital = await s.id('3001');
  const rent = await s.id('6001');
  const sales = await s.id('4001');
  await ok(s.acc('put', '/opening-balances', { date: '2026-07-01', lines: [{ accountId: bank, amount: '10000' }, { accountId: capital, amount: '10000' }] }));
  await s.post('2026-07-15', [{ accountId: rent, debit: 500 }, { accountId: bank, credit: 500 }]);
  await s.post('2026-08-10', [{ accountId: bank, debit: 2000 }, { accountId: sales, credit: 2000 }]);
  await s.post('2026-08-20', [{ accountId: rent, debit: 300 }, { accountId: bank, credit: 300 }]);
  await s.post('2026-09-05', [{ accountId: bank, debit: 100 }, { accountId: sales, credit: 100 }]);
  return { bank, capital, rent, sales };
}

test('fiscal years: the range of a year and the start of the year a date is in', () => {
  expect(fiscalYearRange(2026, 7)).toEqual({ from: '2026-07-01', to: '2027-06-30' });
  expect(fiscalYearRange(2026, 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  expect(fiscalYearRange(2023, 3)).toEqual({ from: '2023-03-01', to: '2024-02-29' }); // a leap year
  expect(fiscalYearStart('2026-10-24', 7)).toBe('2026-07-01');
  expect(fiscalYearStart('2026-03-05', 7)).toBe('2025-07-01');
  expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01');
  expect(fiscalYearStart('2026-10-24', 1)).toBe('2026-01-01');
});

test('an empty company: no rows, balanced, and the period defaults to the current fiscal year', async () => {
  const s = await setup();
  const t = await ok(s.acc('get', '/trial-balance'));
  expect(t).toMatchObject({ rows: [], balanced: true, difference: '0.00', ok: true, fiscalYearStartMonth: 7 });
  expect(t.totals).toEqual({ openingDebit: '0.00', openingCredit: '0.00', periodDebit: '0.00', periodCredit: '0.00', closingDebit: '0.00', closingCredit: '0.00' });
  expect(t.dateFrom <= t.dateTo).toBe(true);
  expect(t.dateFrom.slice(5)).toBe('07-01'); // the fiscal year starts on 1 July
  // every posting account, when asked
  const all = await ok(s.acc('get', '/trial-balance?includeZero=true'));
  expect(all.rows.length).toBeGreaterThan(20);
  expect(all.rows.every((r) => r.closingDebit === '0.00' && r.closingCredit === '0.00')).toBe(true);
  expect(all.rows.every((r) => !['Assets', 'Current Assets'].includes(r.name))).toBe(true); // folders are not rows
});

test('opening, movement and closing: what is before the period is opening, what is after it is left out', async () => {
  const s = await setup();
  await books(s);
  const t = await ok(s.acc('get', '/trial-balance?dateFrom=2026-08-01&dateTo=2026-08-31'));
  const row = (name) => t.rows.find((r) => r.name === name);
  // the opening entry is dated 1 July and the rent of 15 July is before the period: both are opening
  expect(row('Bank Account')).toMatchObject({ openingDebit: '9500.00', openingCredit: '0.00', periodDebit: '2000.00', periodCredit: '300.00', closingDebit: '11200.00', closingCredit: '0.00', folder: 'Assets > Current Assets', accountType: 'ASSET' });
  expect(row('Rent')).toMatchObject({ openingDebit: '500.00', periodDebit: '300.00', closingDebit: '800.00' });
  expect(row('Sales')).toMatchObject({ openingCredit: '0.00', periodCredit: '2000.00', closingCredit: '2000.00' });
  expect(row("Owner's Capital")).toMatchObject({ openingCredit: '10000.00', periodDebit: '0.00', periodCredit: '0.00', closingCredit: '10000.00' });
  expect(t.rows.map((r) => r.code)).toEqual(['1102', '3001', '4001', '6001']); // in code order; the September sale is not in
  expect(t.totals).toEqual({ openingDebit: '10000.00', openingCredit: '10000.00', periodDebit: '2300.00', periodCredit: '2300.00', closingDebit: '12000.00', closingCredit: '12000.00' });
  expect(t).toMatchObject({ balanced: true, difference: '0.00', ok: true });
  expect(t.sections.map((x) => x.accountType)).toEqual(['ASSET', 'EQUITY', 'INCOME', 'EXPENSE']);

  // a later period: everything before it is opening, nothing moves
  const oct = await ok(s.acc('get', '/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31'));
  expect(oct.rows.find((r) => r.name === 'Bank Account')).toMatchObject({ openingDebit: '11300.00', periodDebit: '0.00', closingDebit: '11300.00' });
  expect(oct.totals.periodDebit).toBe('0.00');
  // an earlier period: the opening entry is dated 1 July, so a June period has nothing (it is after the period)
  const june = await ok(s.acc('get', '/trial-balance?dateFrom=2026-06-01&dateTo=2026-06-30'));
  expect(june.rows).toEqual([]);
  // the whole year: the opening entry counts as opening; the movements are the entries
  const year = await ok(s.acc('get', '/trial-balance?fiscalYear=2026'));
  expect(year).toMatchObject({ dateFrom: '2026-07-01', dateTo: '2027-06-30' });
  expect(year.rows.find((r) => r.name === 'Bank Account')).toMatchObject({ openingDebit: '10000.00', periodDebit: '2100.00', periodCredit: '800.00', closingDebit: '11300.00' });
  expect(year.totals).toMatchObject({ openingDebit: '10000.00', openingCredit: '10000.00', periodDebit: '2900.00', periodCredit: '2900.00', closingDebit: '12100.00', closingCredit: '12100.00' });
});

test('filters: an account type, and accounts at zero only when asked', async () => {
  const s = await setup();
  await books(s);
  const q = (x) => ok(s.acc('get', `/trial-balance?dateFrom=2026-08-01&dateTo=2026-08-31${x}`));
  expect((await q('&accountType=EXPENSE')).rows.map((r) => r.name)).toEqual(['Rent']);
  expect((await q('&accountType=ASSET')).totals.closingDebit).toBe('11200.00');
  const zero = await q('&includeZero=true');
  expect(zero.rows.length).toBeGreaterThan(4);
  expect(zero.rows.find((r) => r.name === 'Cash in Hand')).toMatchObject({ openingDebit: '0.00', closingDebit: '0.00' });
  expect(zero.totals.closingDebit).toBe('12000.00'); // the same totals
  await fails(s.acc('get', '/trial-balance?dateFrom=2026-09-01&dateTo=2026-08-01'), 422, 'BAD_RANGE');
  await fails(s.acc('get', '/trial-balance?dateFrom=2026-02-30'), 400, 'VALIDATION_FAILED');
  await fails(s.acc('get', '/trial-balance?accountType=NOTHING'), 400, 'VALIDATION_FAILED');
  // the fiscal year start month changes the default period and `fiscalYear`
  await ok(s.acc('put', '/settings', { fiscalYearStartMonth: 1 }));
  expect(await ok(s.acc('get', '/trial-balance?fiscalYear=2026'))).toMatchObject({ dateFrom: '2026-01-01', dateTo: '2026-12-31', fiscalYearStartMonth: 1 });
});

test('the ledger of an account: opening, lines with a running balance, closing', async () => {
  const s = await setup();
  const { bank } = await books(s);
  const led = await ok(s.acc('get', `/ledger?accountId=${bank}&dateFrom=2026-08-01&dateTo=2026-08-31`));
  expect(led.account).toMatchObject({ code: '1102', name: 'Bank Account', accountType: 'ASSET', normalBalance: 'DEBIT' });
  expect(led.opening).toEqual({ balance: '9500.00', balanceSide: 'DEBIT' });
  expect(led.lines.map((l) => [l.entryDate, l.debit, l.credit, l.balance, l.balanceSide])).toEqual([
    ['2026-08-10', '2000.00', '0.00', '11500.00', 'DEBIT'], ['2026-08-20', '0.00', '300.00', '11200.00', 'DEBIT'],
  ]);
  expect(led.totals).toEqual({ debit: '2000.00', credit: '300.00' });
  expect(led.closing).toEqual({ balance: '11200.00', balanceSide: 'DEBIT' });
  expect(led.lines.every((l) => l.sourceType === 'TEST' && l.entryNo > 0)).toBe(true);
  // a longer period shows the opening entry as the opening balance, not as a line
  const year = await ok(s.acc('get', `/ledger?accountId=${bank}&fiscalYear=2026`));
  expect(year.opening).toEqual({ balance: '10000.00', balanceSide: 'DEBIT' });
  expect(year.lines).toHaveLength(4);
  expect(year.closing).toEqual({ balance: '11300.00', balanceSide: 'DEBIT' });
  // a folder has no ledger; an unknown account is not found; another company's account is not found
  await fails(s.acc('get', `/ledger?accountId=${await s.id('1100')}`), 422, 'NOT_POSTING_ACCOUNT');
  await fails(s.acc('get', '/ledger?accountId=6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11'), 404, 'NOT_FOUND');
  const other = await setup();
  await fails(other.acc('get', `/ledger?accountId=${bank}`), 404, 'NOT_FOUND');
  await fails(s.acc('get', '/ledger'), 400, 'VALIDATION_FAILED');
});

test('a control account that has an amount no customer is named on is reported', async () => {
  const s = await setup();
  const ar = await s.id('1103');
  const cap = await s.id('3001');
  const customerId = (await Customer.create({ companyId: s.company.id, code: 1, name: 'AZ TEXTILES' })).id; // the engine refuses a customer that does not exist
  await s.post('2026-10-01', [{ accountId: ar, debit: 100, partyType: 'CUSTOMER', partyId: customerId }, { accountId: cap, credit: 100 }]);
  let t = await ok(s.acc('get', '/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31'));
  expect(t.checks.find((c) => c.key === 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS')).toMatchObject({ ok: true });
  await s.post('2026-10-02', [{ accountId: ar, debit: 50 }, { accountId: cap, credit: 50 }]); // no customer named
  t = await ok(s.acc('get', '/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31'));
  const c = t.checks.find((x) => x.key === 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS');
  expect(c.ok).toBe(false);
  expect(c.accounts.find((a) => a.code === '1103')).toMatchObject({ glBalance: '150.00', subledgerBalance: '100.00', difference: '50.00', ok: false });
  expect(t).toMatchObject({ balanced: true, ok: false }); // the books balance; the subledger does not
});

test('access: a report service; nobody without it, another company sees its own books only', async () => {
  const s = await setup();
  await books(s);
  expect((await (await s.employee(false))('get', '/trial-balance')).status).toBe(403);
  const viewer = await s.employee(true);
  expect((await viewer('get', '/trial-balance')).status).toBe(200);
  expect((await viewer('get', `/ledger?accountId=${await s.id('1102')}`)).status).toBe(200);
  // a report service is read only: the settings and opening balances need ACC_COA
  expect((await viewer('get', '/settings')).status).toBe(403);
  const other = await setup();
  const t = await ok(other.acc('get', '/trial-balance?fiscalYear=2026'));
  expect(t.rows).toEqual([]);
});
