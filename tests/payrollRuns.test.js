const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA', 'ACC_PAYMENTS', 'ACC_REPORTS'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };
const sql = (text, replacements) => sequelize.query(text, { replacements, type: sequelize.QueryTypes.SELECT });

const MONTH = '2026-10'; // 31 days; Sundays are the 4th, 11th, 18th and 25th
const SUNDAYS = ['04', '11', '18', '25'];
const days = (pred = () => true) => Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).filter((d) => !SUNDAYS.includes(d) && pred(d));
const punches = (code, list, from = '08:00', to = '16:00') => list.flatMap((d) => [{ employeeId: code, date: `2026-10-${d}`, time: from }, { employeeId: code, date: `2026-10-${d}`, time: to }]);

async function grant(user, code, access) {
  await UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });
}

/**
 * A company with a Factory payroll for October 2026:
 *   Rizwan (70)  monthly 40,500 + food 1,000 + mobile 500, EOBI 1 %, 24 P + 3 late days; a loan of 10,000 over 2 months from October (5,000 due)
 *   Zamin (71)   monthly 30,000, income tax 600 a month, present on 5 days only
 *   Fatima (72)  FIXED 45,000, no punches at all
 *   Daud (73)    DAILY wage 1,200, present on 10 days
 *   Draft Dan (74) not confirmed: not in the payroll
 */
async function setup({ makeRun = true, withLoan = true } = {}) {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  await ok(api('post', '/accounts/apply-template', { templateKey: 'other' }));
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Assembly', fte: 0 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const emp = async (code, name, extra = {}, confirm = true) => {
    const e = await ok(api('post', '/payroll/employees', { code, name, cnic: `4230${String(code).padStart(9, '0')}`, groupId: factory.id, departmentId: dept.id, designationId: worker.id, shiftId: shift.id,
      joiningDate: '2025-01-01', ...extra }), 201);
    if (confirm) await ok(api('post', `/payroll/employees/${e.id}/confirm`));
    return e;
  };
  const rizwan = await emp(70, 'Rizwan Ali Khan', { basicSalary: 40500, foodAllowance: 1000, mobileAllowance: 500 });
  // EOBI comes from the EOBI module: Rizwan is on the October list at 1 % of a 40,500 wage = 405
  await ok(api('put', '/payroll/eobi/rates', { month: '2000-01', wage: 40500, employerPercent: 5, employeePercent: 1 }));
  const eobiProvider = await ok(api('post', '/payroll/eobi/providers', { name: 'Delizia' }), 201);
  const eobiList = await ok(api('post', '/payroll/eobi/lists', { providerId: eobiProvider.id, month: MONTH, mode: 'EMPTY' }), 201);
  await ok(api('post', `/payroll/eobi/lists/${eobiList.list.id}/rows`, { employeeIds: [rizwan.id], locationId: null }), 201);
  const zamin = await emp(71, 'Zamin Ali', { basicSalary: 30000, monthlyIncomeTax: 600 });
  const fatima = await emp(72, 'Fatima Noor', { basicSalary: 45000, salaryType: 'FIXED' });
  const daud = await emp(73, 'Daud Khan', { basicSalary: 1200, salaryType: 'DAILY' });
  await emp(74, 'Draft Dan', { basicSalary: 20000 }, false);
  const rows = [
    ...punches(70, days((d) => !['01', '02', '03'].includes(d))), ...punches(70, ['01', '02', '03'], '08:30'),
    ...punches(71, ['01', '02', '03', '05', '06']), ...punches(73, ['01', '02', '03', '05', '06', '07', '08', '09', '10', '12']),
  ];
  await ok(api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const hr = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hr, 'PAYROLL_SALARY', 'FULL');
  const hrApp = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hrApp, 'PAYROLL_APPLICATIONS', 'FULL');
  const accountant = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(accountant, 'ACC_PAYMENTS', 'FULL');
  const w = { company, admin, api, hr: asUser(hr), hrApp: asUser(hrApp), accountant: asUser(accountant), factory, dept, rizwan, zamin, fatima, daud, bank: await Account.findOne({ where: { companyId: company.id, code: '1102' } }) };
  if (withLoan) {
    const loan = await ok(w.hrApp('post', '/payroll/loans', { employeeId: rizwan.id, appliedAmount: 10000, months: 2, deductFrom: MONTH, applicationDate: '2026-09-20' }), 201);
    await ok(w.hrApp('post', `/payroll/loans/${loan.id}/submit`));
    await ok(api('post', `/payroll/loans/${loan.id}/approve`));
    const v = await ok(w.accountant('post', '/employee-loan-vouchers', { loanId: loan.id, payFromAccountId: w.bank.id, paymentMode: 'ONLINE', amount: 10000 }), 201);
    await ok(w.accountant('post', `/employee-loan-vouchers/${v.id}/confirm`));
    w.loan = loan;
  }
  if (makeRun) {
    w.run = await ok(w.hr('post', '/payroll/runs', { month: MONTH, groupId: factory.id }), 201);
    const list = (await ok(api('get', `/payroll/runs/${w.run.id}/slips`))).data;
    w.slips = Object.fromEntries(list.map((s) => [s.employee.code, s]));
  }
  return w;
}
const slip = (w, code) => ok(w.api('get', `/payroll/slips/${w.slips[code].id}`));
const entry = (id) => sql(`SELECT a.name, l.debit::float AS debit, l.credit::float AS credit, e.status, e."reversalOfId" FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id JOIN accounts a ON a.id = l."accountId"
  WHERE e."sourceId" = :id AND e."reversalOfId" IS NULL ORDER BY l."lineNo"`, { id });

test('create payroll: one per class and month, the policy is copied, only confirmed employees who worked are in; the payslips follow the engine', async () => {
  const w = await setup();
  await fails(w.hr('post', '/payroll/runs', { month: '2100-01', groupId: w.factory.id }), 422, 'MONTH_IN_FUTURE');
  await fails(w.hr('post', '/payroll/runs', { month: MONTH, groupId: w.factory.id }), 422, 'PAYROLL_EXISTS');
  const [, outlet] = (await ok(w.api('get', '/payroll/groups'))).data;
  await fails(w.hr('post', '/payroll/runs', { month: MONTH, groupId: outlet.id }), 422, 'NO_EMPLOYEES');
  await fails(w.hr('post', '/payroll/runs', { month: MONTH }), 400, 'VALIDATION_FAILED');

  expect(w.run).toMatchObject({ code: 1, label: 'Payroll #1', group: { name: 'Factory' }, month: MONTH, monthCode: '102026', monthLabel: 'Oct-26', category: 'CAT-B', daysInMonth: 31, policySource: 'DEFAULT',
    policy: { lateLimitMinutes: 15, halfDayLimitMinutes: 120, latesPerHalfDay: 3, weeklyOffDay: 'SUNDAY', overtimeFactor: 1, leaveEarnedPerMonth: 2, maxLeavePerYear: 24, monthsBeforeLeave: 6 },
    counts: { total: 4, draft: 4, review: 0, finalReview: 0, approved: 0, suspended: 0 }, totals: { employees: 4, basic: '116700.00', gross: '110357.00', net: '105852.00', netApproved: '0.00', paid: '0.00', balance: '0.00' }, canDelete: true });
  expect(w.run.policy.summary).toMatch(/Late 15m, half-day 120m/);
  expect(Object.keys(w.slips).map(Number)).toEqual([70, 71, 72, 73]); // Draft Dan is not confirmed

  const a = await slip(w, 70);
  expect(a).toMatchObject({ payslipId: 1, status: 'DRAFT', statusCode: 0, statusText: 'Draft', employee: { code: 70, label: '00070', name: 'RIZWAN ALI KHAN', department: 'Assembly', designation: 'Worker' }, shift: 'DAY8 (08:00-16:00, 8 hrs)', dutyHours: 8,
    salaryType: 'MONTHLY', basicSalary: '40500.00', days: { P: 24, L: 3, HD: 0, A: 0, R: 4, AL: 0, total: 31 }, lateDeductionDays: 0.5, payableDays: 30.5, netDays: 30.5, overtimeHours: 0,
    additions: { food: '1000.00', maintenance: '0.00', mobile: '500.00', others: '0.00', total: '1500.00' }, deductions: { loan: '5000.00', eobi: '405.00', incomeTax: '0.00', others: '0.00', total: '5405.00' },
    gross: '39847.00', contribution: '653.00', net: '35942.00', paid: '0.00', balance: '35942.00', paymentStatus: 'UNPAID', hasAccount: false, paymentMethod: 'CASH', canEdit: true, canSendReview: true });
  expect(a.computation.map((s) => s.key)).toEqual(['basic', 'rate', 'hourly', 'days', 'late', 'earned', 'overtime', 'gross', 'additions', 'deductions', 'net', 'paid', 'balance']);
  expect(a.computation.find((s) => s.key === 'rate').value).toBe('1306.45161');
  expect(a.computation.find((s) => s.key === 'hourly').value).toBe('163.30645'); // 1306.45 / 8 duty hours
  expect(a.computation.find((s) => s.key === 'earned').value).toBe('39847.00');
  expect(a.attendance).toHaveLength(31);
  expect(a.attendance[0]).toMatchObject({ date: '2026-10-01', day: 'Thu', code: 'L', in: '08:30', out: '16:00', hours: 7.5 });
  expect(a.attendance[3]).toMatchObject({ date: '2026-10-04', day: 'Sun', code: 'R' });
  expect(a.holidays.map((h) => [h.date, h.reason])).toEqual([['2026-10-04', 'Weekly off'], ['2026-10-11', 'Weekly off'], ['2026-10-18', 'Weekly off'], ['2026-10-25', 'Weekly off']]);
  expect(a.loans).toEqual([expect.objectContaining({ amount: '5000.00', due: '5000.00', emi: '5000.00', balanceBefore: '10000.00', balanceAfter: '5000.00' })]);
  expect(a.checks.map((c) => [c.key, c.ok])).toEqual([['ATTENDANCE', true], ['HOLIDAY', true], ['LOAN', true], ['POLICY_LATE', true], ['POLICY_LEAVE', true], ['NET', true]]);

  const z = await slip(w, 71);
  expect(z).toMatchObject({ days: { P: 5, A: 22, R: 4, L: 0, HD: 0, AL: 0 }, payableDays: 9, gross: '8710.00', deductions: { incomeTax: '600.00', loan: '0.00', total: '600.00' }, net: '8110.00', absentDays: 22 });
  const f = await slip(w, 72);
  expect(f).toMatchObject({ salaryType: 'FIXED', payableDays: 31, gross: '45000.00', net: '45000.00' }); // whatever the attendance
  const d = await slip(w, 73);
  expect(d).toMatchObject({ salaryType: 'DAILY', days: { P: 10, R: 4 }, payableDays: 14, gross: '16800.00', net: '16800.00' }); // 1,200 x 14 days

  // the Payroll Summary screen
  const month = await ok(w.api('get', `/payroll/runs?month=${MONTH}`));
  expect(month).toMatchObject({ month: MONTH, monthCode: '102026', totals: { payrolls: 1, employees: 4, basic: '116700.00', netApproved: '0.00', salaryBalance: '0.00' } });
  expect(month.data[0]).toMatchObject({ id: w.run.id, code: 1, group: { name: 'Factory' }, category: 'CAT-B' });
  expect((await ok(w.api('get', `/payroll/runs?month=${MONTH}&search=fact`))).data).toHaveLength(1);
  expect((await ok(w.api('get', '/payroll/runs?month=2026-09'))).data).toHaveLength(0);
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}`))).id).toBe(w.run.id);

  // the sheet: search, department, status
  const sheet = await ok(w.api('get', `/payroll/runs/${w.run.id}/slips?search=zamin`));
  expect(sheet).toMatchObject({ total: 1, run: { code: 1 }, data: [{ employee: { code: 71 }, net: '8110.00' }] });
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}/slips?department=assem`))).total).toBe(4);
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}/slips?search=71`))).total).toBe(1);
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}/slips?status=REVIEW`))).total).toBe(0);
  const grid = await ok(w.api('get', `/payroll/runs/${w.run.id}/attendance`));
  expect(grid.dates).toHaveLength(31);
  expect(grid.data.find((x) => x.employee.code === 70)).toMatchObject({ totals: { P: 24, L: 3, R: 4 }, days: { '2026-10-04': 'R', '2026-10-01': 'L' } });
});

test('changes on the payslip: additions, deductions, overtime, EOBI, the loan instalment, a day; "Get attendance" gives the original days back', async () => {
  const w = await setup();
  const id = w.slips[70].id;
  // additions and the other deductions
  let s = await ok(w.hr('patch', `/payroll/slips/${id}`, { food: 2000, maintenance: 750.5, othersAdd: 100, othersDeduct: '300' }));
  expect(s.additions).toMatchObject({ food: '2000.00', maintenance: '750.50', others: '100.00', total: '3350.50' });
  expect(s.deductions).toMatchObject({ others: '300.00', total: '5705.00' });
  expect(s.net).toBe('37492.50'); // 39,847 + 3,350.50 - 5,705
  // overtime typed by HR: 12 hours on an 8 hour duty = 1.5 days x 1,306.45
  s = await ok(w.hr('patch', `/payroll/slips/${id}`, { overtimeHours: 12 }));
  expect(s).toMatchObject({ overtimeHours: 12, overtimeManualHours: 12 });
  expect(s.computation.find((x) => x.key === 'overtime').value).toBe('1960.00'); // 40,500 / 31 x 1.5 = 1,959.68
  expect(s.gross).toBe('41807.00');
  s = await ok(w.hr('patch', `/payroll/slips/${id}`, { overtimeHours: null }));
  expect(s).toMatchObject({ overtimeManualHours: null, gross: '39847.00' });
  // EOBI typed by HR stays until Calculate gives it back to the EOBI list
  s = await ok(w.hr('patch', `/payroll/slips/${id}`, { eobi: 500 }));
  expect(s.deductions.eobi).toBe('500.00');
  expect(s.overrides).toEqual(['food', 'maintenance', 'eobi']);
  s = await ok(w.hr('patch', `/payroll/slips/${id}`, { basicSalary: 42000 })); // the basic of this payslip only; EOBI stays what HR typed
  expect(s).toMatchObject({ basicSalary: '42000.00', deductions: { eobi: '500.00' } });
  s = await ok(w.hr('post', `/payroll/slips/${id}/calculate`, { auto: true }));
  expect(s.deductions.eobi).toBe('405.00'); // the list's share, whatever the basic of this payslip
  expect(s.overrides).toEqual([]);
  expect((await ok(w.hr('patch', `/payroll/slips/${id}`, { basicSalary: 40500 }))).deductions.eobi).toBe('405.00'); // the list's share
  // the loan instalment of the month can be adjusted, never above what is owed
  const loanId = w.loan.id;
  await fails(w.hr('patch', `/payroll/slips/${id}`, { loans: [{ loanId, amount: 10000.01 }] }), 422, 'LOAN_ADJUST_TOO_HIGH');
  s = await ok(w.hr('patch', `/payroll/slips/${id}`, { loans: [{ loanId, amount: 2000 }] }));
  expect(s.deductions.loan).toBe('2000.00');
  expect(s.loans[0]).toMatchObject({ amount: '2000.00', due: '5000.00', balanceAfter: '8000.00' });
  await fails(w.hr('patch', `/payroll/slips/${id}`, { loans: [{ loanId: '8f3c1a2e-1111-4222-8333-444455556666', amount: 1 }] }), 404, 'NOT_FOUND');
  await fails(w.hr('patch', `/payroll/slips/${id}`, { food: -1 }), 400, 'VALIDATION_FAILED');
  await fails(w.hr('patch', `/payroll/slips/${id}`, {}), 400, 'VALIDATION_FAILED');

  // a day of the payslip: the 5th was present; HR makes it absent, then the original comes back with Get attendance
  const before = await slip(w, 70);
  expect(before.attendance[4]).toMatchObject({ date: '2026-10-05', code: 'P' });
  s = await ok(w.hr('put', `/payroll/slips/${id}/days/2026-10-05`, { code: 'A' }));
  expect(s.attendance[4]).toMatchObject({ code: 'A', originalCode: 'P', edited: true });
  expect(s).toMatchObject({ daysEdited: true, days: { P: 23, A: 1, L: 3 }, payableDays: 29.5 });
  s = await ok(w.hr('put', `/payroll/slips/${id}/days/2026-10-05`, { code: 'P' }));
  expect(s).toMatchObject({ daysEdited: false, payableDays: 30.5 }); // back to what it was: not an edit any more
  await ok(w.hr('put', `/payroll/slips/${id}/days/2026-10-06`, { code: 'AL' }));
  await ok(w.hr('put', `/payroll/slips/${id}/days/2026-10-07`, { code: 'HD' }));
  s = await ok(w.hr('patch', `/payroll/slips/${id}`, { overtimeHours: 3, othersAdd: 50 }));
  expect(s).toMatchObject({ daysEdited: true, days: { P: 22, AL: 1, HD: 1 } });
  s = await ok(w.hr('post', `/payroll/slips/${id}/get-attendance`));
  expect(s).toMatchObject({ daysEdited: false, days: { P: 24, L: 3, R: 4, AL: 0, HD: 0 }, payableDays: 30.5, overtimeManualHours: null });
  expect(s.attendance.every((d) => !d.edited)).toBe(true);
  expect(s.additions.others).toBe('50.00'); // what HR typed in the additions stays
  expect(s.deductions.loan).toBe('5000.00'); // the instalment is asked again
  await fails(w.hr('put', `/payroll/slips/${id}/days/2026-10-05`, { code: 'X' }), 400, 'VALIDATION_FAILED');
  await fails(w.hr('put', `/payroll/slips/${id}/days/2026-11-05`, { code: 'P' }), 422, 'NOT_A_DAY_OF_THE_SLIP');
});

test('the policy of the payroll: changing it judges the days again; the class default can be changed from here', async () => {
  const w = await setup();
  const id = w.slips[70].id;
  await fails(w.hr('patch', `/payroll/runs/${w.run.id}/policy`, { lateLimitMinutes: 130 }), 422, 'HALF_DAY_NOT_MORE_THAN_LATE');
  await fails(w.hr('patch', `/payroll/runs/${w.run.id}/policy`, { lateLimitMinutes: -1 }), 400, 'VALIDATION_FAILED');
  await fails(w.hr('patch', `/payroll/runs/${w.run.id}/policy`, {}), 400, 'VALIDATION_FAILED');
  // the three late days are 30 minutes late: with a 45 minute limit they are on time
  const run = await ok(w.hr('patch', `/payroll/runs/${w.run.id}/policy`, { lateLimitMinutes: 45 }));
  expect(run).toMatchObject({ policySource: 'EDITED', policy: { lateLimitMinutes: 45, halfDayLimitMinutes: 120 } });
  expect(run.totals.net).toBe('106505.00'); // Rizwan no longer loses half a day
  expect(await slip(w, 70)).toMatchObject({ days: { P: 27, L: 0 }, lateDeductionDays: 0, payableDays: 31, gross: '40500.00', contribution: '0.00' });
  // a 20 minute half-day limit: the same days are half days now
  await ok(w.hr('patch', `/payroll/runs/${w.run.id}/policy`, { lateLimitMinutes: 10, halfDayLimitMinutes: 20 }));
  expect(await slip(w, 70)).toMatchObject({ days: { P: 24, L: 0, HD: 3 }, payableDays: 29.5 });
  // lates are not penalised when the policy says 0
  await ok(w.hr('patch', `/payroll/runs/${w.run.id}/policy`, { lateLimitMinutes: 15, halfDayLimitMinutes: 120, latesPerHalfDay: 0, overtimeFactor: 1.5 }));
  expect(await slip(w, 70)).toMatchObject({ days: { P: 24, L: 3 }, lateDeductionDays: 0, payableDays: 31 });
  // the class default: nothing yet, then a version from October is made (and changed the next time)
  expect((await ok(w.api('get', `/payroll/policies/effective?groupId=${w.factory.id}&month=${MONTH}`))).source).toBe('DEFAULT');
  await ok(w.hr('patch', `/payroll/runs/${w.run.id}/policy`, { latesPerHalfDay: 4, makeDefault: true }));
  expect(await ok(w.api('get', `/payroll/policies/effective?groupId=${w.factory.id}&month=${MONTH}`))).toMatchObject({ source: 'POLICY', latesPerHalfDay: 4, overtimeFactor: 1.5 });
  await ok(w.hr('patch', `/payroll/runs/${w.run.id}/policy`, { latesPerHalfDay: 5, makeDefault: true }));
  expect((await ok(w.api('get', `/payroll/policies/effective?groupId=${w.factory.id}&month=${MONTH}`))).latesPerHalfDay).toBe(5);
  expect((await ok(w.api('get', `/payroll/policies?groupId=${w.factory.id}`))).total).toBe(1);
  expect(id).toBeTruthy();
});

test('the flow: Draft -> Review (HR) -> Final review -> Approved (reviewers); approving posts the accounts and takes the loan; sending back reverses both', async () => {
  const w = await setup();
  const rizwan = w.slips[70].id;
  await fails(w.hr('post', `/payroll/slips/${rizwan}/final-review`), 403);
  await fails(w.hr('post', `/payroll/slips/${rizwan}/approve`), 403);
  expect((await w.hrApp('post', `/payroll/slips/${rizwan}/review`)).status).toBe(403);
  let s = await ok(w.hr('post', `/payroll/slips/${rizwan}/review`));
  expect(s).toMatchObject({ status: 'REVIEW', statusCode: 1, statusText: 'Review', canEdit: true, canSendReview: false, canFinalReview: false });
  await fails(w.hr('post', `/payroll/slips/${rizwan}/review`), 422, 'NOT_DRAFT');
  await fails(w.api('post', `/payroll/slips/${rizwan}/approve`), 422, 'NOT_IN_FINAL_REVIEW');
  expect(await ok(w.hr('patch', `/payroll/slips/${rizwan}`, { notes: 'checked with the supervisor' }))).toMatchObject({ notes: 'checked with the supervisor' }); // Review can still be corrected
  s = await ok(w.api('post', `/payroll/slips/${rizwan}/final-review`));
  expect(s).toMatchObject({ status: 'FINAL_REVIEW', statusCode: 2, statusText: 'Final review', canEdit: false, canApprove: true });
  await fails(w.hr('patch', `/payroll/slips/${rizwan}`, { food: 1 }), 422, 'SLIP_LOCKED');
  await fails(w.hr('put', `/payroll/slips/${rizwan}/days/2026-10-05`, { code: 'A' }), 422, 'SLIP_LOCKED');
  await fails(w.hr('post', `/payroll/slips/${rizwan}/get-attendance`), 422, 'SLIP_LOCKED');
  s = await ok(w.api('post', `/payroll/slips/${rizwan}/approve`));
  expect(s).toMatchObject({ status: 'APPROVED', statusCode: 3, statusText: 'Approved', canSendBack: true, canEdit: false, canSuspend: false });
  expect(s.approvedAt).toBeTruthy();

  // the accounts: Debit the salary expense (gross + additions; the chart's own "Salaries" account is adopted as the default); Credit Salaries Payable (net), Employee Loans (the instalment), EOBI Payable
  expect((await entry(rizwan)).map((l) => [l.name, l.debit, l.credit])).toEqual([['Salaries', 41347, 0], ['Salaries Payable', 0, 35942], ['Employee Loans', 0, 5000], ['EOBI Payable', 0, 405]]);
  const entryDate = await sql(`SELECT to_char("entryDate", 'YYYY-MM-DD') AS d FROM journal_entries WHERE "sourceId" = :id`, { id: rizwan });
  expect(entryDate[0].d).toBe('2026-10-31'); // the expense belongs to the month
  const defaults = (await ok(w.api('get', '/accounts/defaults'))).data.filter((x) => x.group === 'PAYROLL').map((x) => [x.key, x.status]);
  expect(defaults).toEqual([['EMPLOYEE_LOANS', 'SET'], ['EMPLOYEE_ADVANCES', 'NOT_SET'], ['SALARY_EXPENSE', 'SET'], ['SALARIES_PAYABLE', 'SET'], ['EOBI_PAYABLE', 'SET'], ['SALARY_TAX_PAYABLE', 'NOT_SET'], ['EMPLOYEE_DEDUCTIONS', 'NOT_SET'], ['EOBI_EMPLOYER_EXPENSE', 'NOT_SET']]);
  // the loan: the instalment is taken, the balance falls
  const loan = await ok(w.api('get', `/payroll/loans/${w.loan.id}`));
  expect(loan).toMatchObject({ paid: '10000.00', deducted: '5000.00', balance: '5000.00' });
  expect(loan.deductions).toEqual([expect.objectContaining({ month: MONTH, amount: '5000.00', source: 'PAYROLL', payrollId: rizwan })]);
  expect(await ok(w.api('get', `/payroll/runs/${w.run.id}`))).toMatchObject({ counts: { approved: 1, draft: 3 }, totals: { netApproved: '35942.00', paid: '0.00', balance: '35942.00' }, canDelete: false });
  await fails(w.hr('delete', `/payroll/runs/${w.run.id}`), 422, 'PAYROLL_HAS_APPROVED');
  await fails(w.hr('post', `/payroll/slips/${rizwan}/suspend`, { note: 'not allowed now' }), 422, 'SLIP_APPROVED');
  await fails(w.hr('delete', `/payroll/slips/${rizwan}`), 422, 'SLIP_NOT_DRAFT');

  // sending it back (nothing paid yet): the entry is reversed, the instalment is given back
  await fails(w.hr('post', `/payroll/slips/${rizwan}/send-back`), 403);
  s = await ok(w.api('post', `/payroll/slips/${rizwan}/send-back`));
  expect(s).toMatchObject({ status: 'DRAFT', canEdit: true });
  const all = await sql(`SELECT e.status, e."reversalOfId" IS NOT NULL AS reversal FROM journal_entries e WHERE e."sourceId" = :id ORDER BY e."entryNo"`, { id: rizwan });
  expect(all).toEqual([{ status: 'REVERSED', reversal: false }, { status: 'POSTED', reversal: true }]);
  expect((await ok(w.api('get', `/payroll/loans/${w.loan.id}`)))).toMatchObject({ deducted: '0.00', balance: '10000.00' });
  // and again to the end
  await ok(w.hr('post', `/payroll/slips/${rizwan}/review`));
  await ok(w.api('post', `/payroll/slips/${rizwan}/final-review`));
  await ok(w.api('post', `/payroll/slips/${rizwan}/approve`));
  expect((await ok(w.api('get', `/payroll/loans/${w.loan.id}`))).deducted).toBe('5000.00');

  // a negative net cannot be sent on
  const zamin = w.slips[71].id;
  await ok(w.hr('patch', `/payroll/slips/${zamin}`, { othersDeduct: 9000 }));
  const neg = await slip(w, 71);
  expect(neg.net).toBe('-890.00');
  expect(neg.checks.find((c) => c.key === 'NET')).toMatchObject({ ok: false });
  await fails(w.hr('post', `/payroll/slips/${zamin}/review`), 422, 'NET_NEGATIVE');
  await ok(w.hr('patch', `/payroll/slips/${zamin}`, { othersDeduct: 0 }));
});

test('suspend: the payslip is left out with a note, the rest go on, and it can be resumed later; bulk moves', async () => {
  const w = await setup();
  const zamin = w.slips[71].id;
  await fails(w.hr('post', `/payroll/slips/${zamin}/suspend`, {}), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', `/payroll/slips/${zamin}/suspend`, { note: 'x' }), 400, 'VALIDATION_FAILED');
  const s = await ok(w.hr('post', `/payroll/slips/${zamin}/suspend`, { note: 'Left without notice, salary on hold' }));
  expect(s).toMatchObject({ status: 'SUSPENDED', statusCode: 9, statusText: 'Suspended', suspendNote: 'Left without notice, salary on hold', canResume: true, canEdit: false, canSuspend: false });
  await fails(w.hr('post', `/payroll/slips/${zamin}/suspend`, { note: 'again please' }), 422, 'ALREADY_SUSPENDED');
  await fails(w.hr('patch', `/payroll/slips/${zamin}`, { food: 5 }), 422, 'SLIP_SUSPENDED');
  await fails(w.hr('post', `/payroll/slips/${zamin}/review`), 422, 'NOT_DRAFT');
  const run = await ok(w.api('get', `/payroll/runs/${w.run.id}`));
  expect(run).toMatchObject({ counts: { total: 4, draft: 3, suspended: 1 }, totals: { employees: 3, basic: '86700.00', net: '97742.00' } }); // Zamin is not counted
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}/slips?status=SUSPENDED`))).data.map((x) => x.employee.code)).toEqual([71]);

  // bulk: every Draft payslip to Review (the suspended one stays out), then the reviewers
  const bulk = await ok(w.hr('post', `/payroll/runs/${w.run.id}/slips/move`, { action: 'review' }));
  expect(bulk).toMatchObject({ action: 'review', moved: 3, failed: [], run: { counts: { review: 3, suspended: 1 } } });
  expect((await w.hr('post', `/payroll/runs/${w.run.id}/slips/move`, { action: 'approve' })).status).toBe(403);
  const fin = await ok(w.api('post', `/payroll/runs/${w.run.id}/slips/move`, { action: 'final-review', slipIds: [w.slips[70].id, w.slips[72].id] }));
  expect(fin).toMatchObject({ moved: 2, run: { counts: { review: 1, finalReview: 2 } } });
  const done = await ok(w.api('post', `/payroll/runs/${w.run.id}/slips/move`, { action: 'approve' }));
  expect(done).toMatchObject({ moved: 2, run: { counts: { approved: 2, review: 1, suspended: 1 }, totals: { netApproved: '80942.00' } } });
  // sending back is the reviewers' step: HR is refused at once; the reviewer sends an approved payslip and one in review back to Draft
  expect((await w.hr('post', `/payroll/runs/${w.run.id}/slips/move`, { action: 'send-back' })).status).toBe(403);
  const back2 = await ok(w.api('post', `/payroll/runs/${w.run.id}/slips/move`, { action: 'send-back', slipIds: [w.slips[73].id, w.slips[72].id] }));
  expect(back2).toMatchObject({ moved: 2, failed: [], run: { counts: { draft: 2, approved: 1, suspended: 1 } } });
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}/slips?status=DRAFT`))).total).toBe(2);

  // resume: it goes back to Draft and is worked out again
  const back = await ok(w.hr('post', `/payroll/slips/${zamin}/resume`));
  expect(back).toMatchObject({ status: 'DRAFT', canEdit: true, net: '8110.00' });
  await fails(w.hr('post', `/payroll/slips/${zamin}/resume`), 422, 'NOT_SUSPENDED');
  // delete a payslip in Draft, then give the employee his payslip back
  await ok(w.hr('delete', `/payroll/slips/${zamin}`), 204);
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}/slips`))).total).toBe(3);
  const again = await ok(w.hr('post', `/payroll/runs/${w.run.id}/add-employees`));
  expect(again.added).toBe(1);
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}/slips`))).total).toBe(4);
  expect((await ok(w.hr('post', `/payroll/runs/${w.run.id}/add-employees`))).added).toBe(0);
});

test('payment: a salary payment voucher pays approved payslips from the bank (Debit Salaries Payable, Credit Bank), in pieces; paid and balance follow', async () => {
  const w = await setup();
  for (const code of [70, 71]) {
    await ok(w.hr('post', `/payroll/slips/${w.slips[code].id}/review`));
    await ok(w.api('post', `/payroll/slips/${w.slips[code].id}/final-review`));
    await ok(w.api('post', `/payroll/slips/${w.slips[code].id}/approve`));
  }
  const pick = await ok(w.accountant('get', '/salary-payment-vouchers/slips'));
  expect(pick.data.map((x) => [x.employee.code, x.net, x.toPay, x.method])).toEqual([[70, 35942, 35942, 'CASH'], [71, 8110, 8110, 'CASH']]);
  expect(pick.totalToPay).toBe(44052);
  expect((await ok(w.accountant('get', '/salary-payment-vouchers/slips?method=BANK'))).total).toBe(0);
  expect((await ok(w.accountant('get', '/salary-payment-vouchers/slips?search=zamin'))).total).toBe(1);
  expect((await ok(w.accountant('get', `/salary-payment-vouchers/slips?runId=${w.run.id}`))).total).toBe(2);

  const make = (body, status = 201) => ok(w.accountant('post', '/salary-payment-vouchers', { payFromAccountId: w.bank.id, paymentMode: 'ONLINE', ...body }), status);
  await fails(w.accountant('post', '/salary-payment-vouchers', { payFromAccountId: w.bank.id, paymentMode: 'ONLINE', lines: [{ slipId: w.slips[72].id }] }), 422, 'SLIP_NOT_APPROVED');
  await fails(w.accountant('post', '/salary-payment-vouchers', { payFromAccountId: w.bank.id, paymentMode: 'ONLINE', lines: [{ slipId: w.slips[70].id, amount: 35942.01 }] }), 422, 'AMOUNT_MORE_THAN_SALARY');
  await fails(w.accountant('post', '/salary-payment-vouchers', { payFromAccountId: w.bank.id, paymentMode: 'ONLINE', lines: [{ slipId: w.slips[70].id }, { slipId: w.slips[70].id }] }), 422, 'DUPLICATE_SLIP');
  await fails(w.accountant('post', '/salary-payment-vouchers', { payFromAccountId: (await Account.findOne({ where: { companyId: w.company.id, code: '1103' } })).id, paymentMode: 'ONLINE', lines: [{ slipId: w.slips[70].id }] }), 422, 'NOT_BANK_OR_CASH');
  await fails(w.accountant('post', '/salary-payment-vouchers', { payFromAccountId: w.bank.id, paymentMode: 'ONLINE', lines: [] }), 400, 'VALIDATION_FAILED');

  const v1 = await make({ lines: [{ slipId: w.slips[70].id }, { slipId: w.slips[71].id, amount: 3000 }], refNo: 'BATCH-1', notes: 'October salaries' });
  expect(v1).toMatchObject({ voucherNo: 1, voucherLabel: 'SPV-00001', status: 'DRAFT', amount: 38942, employees: 2, refNo: 'BATCH-1', canConfirm: true, payFrom: { code: '1102' } });
  expect(v1.lines.map((l) => [l.employee.code, l.net, l.amount, l.monthLabel])).toEqual([[70, 35942, 35942, 'Oct-26'], [71, 8110, 3000, 'Oct-26']]);
  // a draft already holds its money: the picker and a second voucher see the rest only
  expect((await ok(w.accountant('get', '/salary-payment-vouchers/slips'))).data.map((x) => [x.employee.code, x.toPay])).toEqual([[71, 5110]]);
  await fails(w.accountant('post', '/salary-payment-vouchers', { payFromAccountId: w.bank.id, paymentMode: 'ONLINE', lines: [{ slipId: w.slips[71].id, amount: 5110.01 }] }), 422, 'AMOUNT_MORE_THAN_SALARY');
  await fails(w.hr('post', `/payroll/slips/${w.slips[70].id}/send-back`), 403);
  await fails(w.api('post', `/payroll/slips/${w.slips[70].id}/send-back`), 422, 'SLIP_IN_A_VOUCHER');
  expect((await ok(w.accountant('patch', `/salary-payment-vouchers/${v1.id}`, { lines: [{ slipId: w.slips[70].id }, { slipId: w.slips[71].id, amount: 4000 }] }))).amount).toBe(39942);

  const c1 = await ok(w.accountant('post', `/salary-payment-vouchers/${v1.id}/confirm`));
  expect(c1).toMatchObject({ status: 'CONFIRMED', statusText: 'Confirmed', canEdit: false, canUnconfirm: true });
  expect((await entry(v1.id)).map((l) => [l.name, l.debit, l.credit])).toEqual([['Salaries Payable', 39942, 0], ['Bank Account', 0, 39942]]);
  await fails(w.accountant('patch', `/salary-payment-vouchers/${v1.id}`, { notes: 'x' }), 422, 'VOUCHER_CONFIRMED');
  await fails(w.accountant('delete', `/salary-payment-vouchers/${v1.id}`), 422, 'VOUCHER_CONFIRMED');
  await fails(w.accountant('post', `/salary-payment-vouchers/${v1.id}/confirm`), 422, 'ALREADY_CONFIRMED');
  const r = await slip(w, 70);
  expect(r).toMatchObject({ paid: '35942.00', balance: '0.00', paymentStatus: 'PAID', canSendBack: false });
  expect(r.payments).toEqual([expect.objectContaining({ voucherLabel: 'SPV-00001', amount: '35942.00', status: 'CONFIRMED', paidFrom: expect.objectContaining({ code: '1102' }) })]);
  expect(await slip(w, 71)).toMatchObject({ paid: '4000.00', balance: '4110.00', paymentStatus: 'PARTIAL' });
  await fails(w.api('post', `/payroll/slips/${w.slips[70].id}/send-back`), 422, 'SLIP_HAS_PAYMENTS');
  expect(await ok(w.api('get', `/payroll/runs/${w.run.id}`))).toMatchObject({ totals: { netApproved: '44052.00', paid: '39942.00', balance: '4110.00' } });
  expect((await ok(w.api('get', `/payroll/runs?month=${MONTH}`))).totals).toMatchObject({ netApproved: '44052.00', salaryBalance: '4110.00' });
  expect((await ok(w.api('get', `/payroll/runs/${w.run.id}/slips?paid=unpaid`))).data.map((x) => x.employee.code)).toEqual([71]);

  // the rest of Zamin's salary, then move the first voucher back to draft
  const v2 = await make({ lines: [{ slipId: w.slips[71].id }] });
  expect(v2.amount).toBe(4110);
  await ok(w.accountant('post', `/salary-payment-vouchers/${v2.id}/confirm`));
  expect(await slip(w, 71)).toMatchObject({ paid: '8110.00', balance: '0.00', paymentStatus: 'PAID' });
  const un = await ok(w.accountant('post', `/salary-payment-vouchers/${v1.id}/unconfirm`, { reason: 'wrong account' }));
  expect(un).toMatchObject({ status: 'DRAFT', canEdit: true });
  expect(await slip(w, 70)).toMatchObject({ paid: '0.00', balance: '35942.00', paymentStatus: 'UNPAID' });
  expect(await slip(w, 71)).toMatchObject({ paid: '4110.00', balance: '4000.00', paymentStatus: 'PARTIAL' });
  const books = await sql(`SELECT e.status, e."reversalOfId" IS NOT NULL AS reversal FROM journal_entries e WHERE e."sourceId" = :id ORDER BY e."entryNo"`, { id: v1.id });
  expect(books).toEqual([{ status: 'REVERSED', reversal: false }, { status: 'POSTED', reversal: true }]);
  const list = await ok(w.accountant('get', '/salary-payment-vouchers'));
  expect(list).toMatchObject({ total: 2, summary: { vouchers: 2, amount: 44052, confirmed: 4110 } });
  expect((await ok(w.accountant('get', `/salary-payment-vouchers?slipId=${w.slips[70].id}`))).total).toBe(1);
  expect((await ok(w.accountant('get', '/salary-payment-vouchers?search=zamin'))).total).toBe(2);
  expect((await ok(w.accountant('get', `/salary-payment-vouchers/${v1.id}/accounts-entry`)))).toMatchObject({ posted: false, voucherLabel: 'SPV-00001' });
  await ok(w.accountant('delete', `/salary-payment-vouchers/${v1.id}`), 204);
});

test('access: reading needs a payroll service, HR changes the payroll, the accountant pays, another company sees nothing; the books agree', async () => {
  const w = await setup();
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(viewer, 'PAYROLL_REPORTS', 'VIEW');
  const v = asUser(viewer);
  await ok(v('get', `/payroll/runs?month=${MONTH}`));
  await ok(v('get', `/payroll/runs/${w.run.id}/slips`));
  await ok(v('get', `/payroll/slips/${w.slips[70].id}`));
  expect((await v('post', '/payroll/runs', { month: MONTH, groupId: w.factory.id })).status).toBe(403);
  expect((await v('patch', `/payroll/slips/${w.slips[70].id}`, { food: 1 })).status).toBe(403);
  expect((await v('post', `/payroll/runs/${w.run.id}/slips/move`, { action: 'review' })).status).toBe(403);
  expect((await w.accountant('post', '/payroll/runs', { month: MONTH, groupId: w.factory.id })).status).toBe(403);
  expect((await w.hr('get', '/salary-payment-vouchers')).status).toBe(403); // HR does not pay
  const other = await setup({ makeRun: false, withLoan: false });
  await fails(other.api('get', `/payroll/slips/${w.slips[70].id}`), 404, 'NOT_FOUND');
  await fails(other.api('get', `/payroll/runs/${w.run.id}`), 404, 'NOT_FOUND');
  await fails(other.hr('patch', `/payroll/slips/${w.slips[70].id}`, { food: 1 }), 404, 'NOT_FOUND');
  expect((await ok(other.api('get', `/payroll/runs?month=${MONTH}`))).data).toHaveLength(0);
  await fails(w.api('delete', `/payroll/employees/${w.rizwan.id}`), 422, 'EMPLOYEE_CONFIRMED');
  await ok(w.api('post', `/payroll/employees/${w.rizwan.id}/unconfirm`));
  await fails(w.api('delete', `/payroll/employees/${w.rizwan.id}`), 422, 'IN_USE'); // he has payslips and a loan
  await ok(w.api('post', `/payroll/employees/${w.rizwan.id}/confirm`));

  // approve all, pay all: every entry balances and the payable account ends at zero
  for (const code of [70, 71, 72, 73]) {
    await ok(w.hr('post', `/payroll/slips/${w.slips[code].id}/review`));
    await ok(w.api('post', `/payroll/slips/${w.slips[code].id}/final-review`));
    await ok(w.api('post', `/payroll/slips/${w.slips[code].id}/approve`));
  }
  const pay = await ok(w.accountant('post', '/salary-payment-vouchers', { payFromAccountId: w.bank.id, paymentMode: 'ONLINE', lines: (await ok(w.accountant('get', '/salary-payment-vouchers/slips'))).data.map((x) => ({ slipId: x.slipId })) }), 201);
  await ok(w.accountant('post', `/salary-payment-vouchers/${pay.id}/confirm`));
  const bal = await sql(`SELECT a.name, COALESCE(SUM(l.debit), 0)::float AS debit, COALESCE(SUM(l.credit), 0)::float AS credit FROM journal_lines l JOIN accounts a ON a.id = l."accountId"
    WHERE l."companyId" = :c AND a.name IN ('Salaries', 'Salaries Payable', 'EOBI Payable', 'Income Tax Payable - Salaries', 'Employee Loans') GROUP BY a.name ORDER BY a.name`, { c: w.company.id });
  const by = Object.fromEntries(bal.map((b) => [b.name, b]));
  expect(by.Salaries).toMatchObject({ debit: 110357 + 1500, credit: 0 }); // gross + Rizwan's food and mobile
  expect(by['Salaries Payable']).toMatchObject({ debit: 105852, credit: 105852 }); // everything owed was paid
  expect(by['EOBI Payable'].credit).toBe(405);
  expect(by['Income Tax Payable - Salaries'].credit).toBe(600);
  expect(by['Employee Loans']).toMatchObject({ debit: 10000, credit: 5000 }); // lent 10,000, recovered 5,000
  const tb = await ok(w.api('get', '/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2026-11-30'));
  expect(tb.balanced).toBe(true);
  expect(tb.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
});
