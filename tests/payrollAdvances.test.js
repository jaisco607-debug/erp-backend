const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, Account, sequelize } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA', 'ACC_PAYMENTS', 'ACC_REPORTS'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };
const grant = async (user, code, access) => UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });
const MONTH = '2026-10';

test('advance: HR writes it down (no approval), the accountant pays it with an advance voucher, the payroll takes the whole amount from the salary', async () => {
  const w = await setup();
  // the form: the employee's loan history (a loan of 10,000 over 2 months is running) and his advances
  const info0 = await ok(w.hrApp('get', `/payroll/advances/employee/${w.zaid.id}`));
  expect(info0.employee).toMatchObject({ code: 10, name: 'ZAID KHAN', salary: '30000.00' });
  expect(info0.loans).toHaveLength(1);
  expect(info0.loans[0]).toMatchObject({ approved: '10000.00', paid: '10000.00', deducted: '0.00', balance: '10000.00', months: 2, isFinished: false, statusText: 'Running' });
  expect(info0.loanSummary).toMatchObject({ count: 1, running: 1, balance: '10000.00' });
  expect(info0.advances).toEqual([]);
  expect((await ok(w.hrApp('get', `/payroll/advances/employee/${w.dan.id}`))).loans).toEqual([]);

  // HR: Zaid asks for 5,000. No approval step: it is there at once
  const a = await ok(w.hrApp('post', '/payroll/advances', { employeeId: w.zaid.id, amount: '5000', advanceDate: '2026-10-10', remarks: 'Medical' }), 201);
  expect(a).toMatchObject({ code: 1, appId: '00001', label: 'ADV-00001', amount: '5000.00', status: 'WAITING_VOUCHER', statusText: 'Waiting for voucher', paid: false, recovered: '0.00', toRecover: '0.00', voucher: null,
    canEdit: true, canDelete: true, canPay: true, employee: { code: 10, name: 'ZAID KHAN' } });
  const b = await ok(w.hrApp('post', '/payroll/advances', { employeeId: w.dan.id, amount: 2000, advanceDate: '2026-10-12' }), 201);
  await fails(w.hrApp('post', '/payroll/advances', { employeeId: w.zaid.id, amount: 0 }), 400, 'VALIDATION_FAILED');
  await fails(w.hrApp('post', '/payroll/advances', { employeeId: w.zaid.id, amount: '12.345' }), 400, 'VALIDATION_FAILED');
  await fails(w.hrApp('post', '/payroll/advances', { employeeId: w.zaid.id, amount: 100, advanceDate: '2020-01-01' }), 422, 'BEFORE_JOINING');
  expect((await ok(w.hrApp('get', `/payroll/advances/employee/${w.zaid.id}`))).advanceSummary).toEqual({ pending: '5000.00', count: 1 });
  expect(await ok(w.hrApp('get', '/payroll/advances/summary'))).toMatchObject({ total: 2, waitingVoucher: 2, paid: 0, recovered: 0, amount: '7000.00', toRecover: '0.00' });
  expect((await ok(w.hrApp('get', '/payroll/advances?status=WAITING_VOUCHER'))).total).toBe(2);
  expect((await ok(w.hrApp('get', '/payroll/advances?search=dan'))).data.map((x) => x.code)).toEqual([2]);
  // change an advance nobody has paid
  expect(await ok(w.hrApp('patch', `/payroll/advances/${b.id}`, { amount: 2500 }))).toMatchObject({ amount: '2500.00' });

  // accounting: the voucher picker lists the advances nobody has paid; the accountant makes the advance voucher
  const pick = await ok(w.admin('get', '/employee-advance-vouchers/advances'));
  expect(pick.data.map((x) => [x.label, x.amount, x.toPay])).toEqual([['ADV-00002', 2500, 2500], ['ADV-00001', 5000, 5000]]);
  expect((await ok(w.admin('get', '/employee-advance-vouchers/options'))).payFromAccounts.length).toBeGreaterThan(0);
  const v = await ok(w.admin('post', '/employee-advance-vouchers', { advanceId: a.id, payFromAccountId: w.bank.id, paymentMode: 'ONLINE', voucherDate: '2026-10-10' }), 201);
  expect(v).toMatchObject({ voucherNo: 1, voucherLabel: 'EAV-00001', purpose: 'ADVANCE', status: 'DRAFT', amount: 5000, advance: { label: 'ADV-00001' }, employee: { code: 10 }, canConfirm: true });
  await fails(w.admin('post', '/employee-advance-vouchers', { advanceId: a.id, payFromAccountId: w.bank.id, paymentMode: 'ONLINE' }), 422, 'ADVANCE_ALREADY_PAID');
  await fails(w.admin('post', '/employee-advance-vouchers', { advanceId: b.id, payFromAccountId: w.bank.id, paymentMode: 'ONLINE', amount: 100 }), 422, 'AMOUNT_NOT_ADVANCE');
  await fails(w.admin('post', '/employee-advance-vouchers', { advanceId: b.id, payFromAccountId: w.bank.id, paymentMode: 'ONLINE', voucherDate: '2026-10-01' }), 422, 'VOUCHER_BEFORE_ADVANCE');
  // a draft voucher is not money paid out yet: the advance still waits, and it cannot be changed or deleted any more
  expect((await ok(w.hrApp('get', `/payroll/advances/${a.id}`)))).toMatchObject({ status: 'WAITING_VOUCHER', voucher: { voucherLabel: 'EAV-00001', status: 'DRAFT' }, canEdit: false, canDelete: false, canPay: false });
  await fails(w.hrApp('delete', `/payroll/advances/${a.id}`), 422, 'ADVANCE_HAS_VOUCHER');
  const c = await ok(w.admin('post', `/employee-advance-vouchers/${v.id}/confirm`));
  expect(c).toMatchObject({ status: 'CONFIRMED', canUnconfirm: true });
  const entry = await ok(w.admin('get', `/employee-advance-vouchers/${v.id}/accounts-entry`));
  expect(entry).toMatchObject({ posted: true });
  const lines = await sequelize.query(`SELECT a.name, l.debit::float AS debit, l.credit::float AS credit FROM journal_lines l JOIN accounts a ON a.id = l."accountId" WHERE l."entryId" = :id ORDER BY l."lineNo"`,
    { replacements: { id: entry.current.id }, type: sequelize.QueryTypes.SELECT });
  expect(lines.map((l) => [l.name, l.debit, l.credit])).toEqual([['Employee Advances', 5000, 0], [w.bank.name, 0, 5000]]);
  expect(await ok(w.hrApp('get', `/payroll/advances/${a.id}`))).toMatchObject({ status: 'PAID', paid: true, toRecover: '5000.00', recovered: '0.00' });
  expect((await ok(w.admin('get', '/employee-advance-vouchers/advances'))).data.map((x) => x.label)).toEqual(['ADV-00002']);
  // the new default account role
  expect((await ok(w.admin('get', '/accounts/defaults'))).data.find((x) => x.key === 'EMPLOYEE_ADVANCES')).toMatchObject({ status: 'SET', group: 'PAYROLL', account: { name: 'Employee Advances' } });

  // the payroll: Zaid's advance (paid) is taken in full; Dan's (no voucher) is not
  const run = await ok(w.hr('post', '/payroll/runs', { month: MONTH, groupId: w.factory.id }), 201);
  const slips = (await ok(w.hr('get', `/payroll/runs/${run.id}/slips`))).data;
  const zaid = slips.find((s) => s.employee.code === 10);
  const dan = slips.find((s) => s.employee.code === 11);
  // Zaid: fixed 30,000 + allowances 3,000 - loan instalment 5,000 - advance 5,000
  expect(zaid.deductions).toMatchObject({ loan: '5000.00', advance: '5000.00', total: '10000.00' });
  expect(dan.deductions).toMatchObject({ advance: '0.00' });
  const detail = await ok(w.hr('get', `/payroll/slips/${zaid.id}`));
  expect(detail.advances).toEqual([expect.objectContaining({ label: 'ADV-00001', advanceAmount: '5000.00', due: '5000.00', amount: '5000.00' })]);
  expect(detail.computation.find((x) => x.key === 'deductions').note).toMatch(/advance/);
  expect(Number(detail.net)).toBe(30000 + 3000 - 10000);
  // HR can take less of it on the payslip, never more than is due
  expect((await ok(w.hr('patch', `/payroll/slips/${zaid.id}`, { advances: [{ advanceId: a.id, amount: 3000 }] }))).deductions.advance).toBe('3000.00');
  await fails(w.hr('patch', `/payroll/slips/${zaid.id}`, { advances: [{ advanceId: a.id, amount: 6000 }] }), 422, 'ADVANCE_ADJUST_TOO_HIGH');
  expect((await ok(w.hr('patch', `/payroll/slips/${zaid.id}`, { advances: [{ advanceId: a.id, amount: 5000 }] }))).deductions.advance).toBe('5000.00');
  // the salary sheet has the advance column and total
  const sheet = await ok(w.hr('get', `/payroll/runs/${run.id}/salary-sheet`));
  expect(sheet.data.find((r) => r.employee.code === 10).advance).toBe('5000.00');
  expect(sheet.totals.advance).toBe('5000.00');

  // approve the payslip: the accounting entry credits Employee Advances, the advance is recovered
  for (const step of ['review']) await ok(w.hr('post', `/payroll/slips/${zaid.id}/${step}`));
  await ok(w.admin('post', `/payroll/slips/${zaid.id}/final-review`));
  await ok(w.admin('post', `/payroll/slips/${zaid.id}/approve`));
  const slipLines = await sequelize.query(`SELECT a.name, l.debit::float AS debit, l.credit::float AS credit FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id JOIN accounts a ON a.id = l."accountId"
    WHERE e."sourceId" = :id AND e."reversalOfId" IS NULL ORDER BY l."lineNo"`, { replacements: { id: zaid.id }, type: sequelize.QueryTypes.SELECT });
  expect(slipLines.map((l) => [l.name, l.debit, l.credit])).toEqual([['Salaries', 33000, 0], ['Salaries Payable', 0, 23000], ['Employee Loans', 0, 5000], ['Employee Advances', 0, 5000]]);
  expect(await ok(w.hrApp('get', `/payroll/advances/${a.id}`))).toMatchObject({ status: 'RECOVERED', recovered: '5000.00', toRecover: '0.00', recoveredMonth: MONTH });
  expect(await ok(w.hrApp('get', '/payroll/advances/summary'))).toMatchObject({ recovered: 1, toRecover: '0.00' });
  // a recovered advance is final: its voucher cannot go back to draft
  await fails(w.admin('post', `/employee-advance-vouchers/${v.id}/unconfirm`, {}), 422, 'ADVANCE_ALREADY_RECOVERED');
  await fails(w.hrApp('patch', `/payroll/advances/${a.id}`, { amount: 1 }), 422, 'ADVANCE_HAS_VOUCHER');
  // sending the payslip back to draft gives the advance back (it will be taken again)
  await ok(w.admin('post', `/payroll/slips/${zaid.id}/send-back`));
  expect(await ok(w.hrApp('get', `/payroll/advances/${a.id}`))).toMatchObject({ status: 'PAID', recovered: '0.00', toRecover: '5000.00' });

  // an advance nobody paid can be deleted; the history of the employee shows both
  await ok(w.hrApp('delete', `/payroll/advances/${b.id}`), 204);
  expect((await ok(w.hrApp('get', '/payroll/advances'))).data.map((x) => x.code)).toEqual([1]);
  expect((await ok(w.hrApp('get', `/payroll/advances/employee/${w.zaid.id}`))).advances).toEqual([expect.objectContaining({ label: 'ADV-00001', status: 'PAID' })]);

  // moving the voucher back to draft (before the payroll approves it) reverses the entry; the advance waits again
  const dup = await ok(w.hrApp('post', '/payroll/advances', { employeeId: w.dan.id, amount: 1000, advanceDate: '2026-10-15' }), 201);
  const v2 = await ok(w.admin('post', '/employee-advance-vouchers', { advanceId: dup.id, payFromAccountId: w.bank.id, paymentMode: 'CASH', voucherDate: '2026-10-15' }), 201);
  await ok(w.admin('post', `/employee-advance-vouchers/${v2.id}/confirm`));
  expect(await ok(w.hrApp('get', `/payroll/advances/${dup.id}`))).toMatchObject({ status: 'PAID' });
  expect(await ok(w.admin('post', `/employee-advance-vouchers/${v2.id}/unconfirm`, {}))).toMatchObject({ status: 'DRAFT' });
  expect(await ok(w.hrApp('get', `/payroll/advances/${dup.id}`))).toMatchObject({ status: 'WAITING_VOUCHER' });

  // access: payroll people read; HR (Applications FULL) writes; others cannot
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(viewer, 'PAYROLL_REPORTS', 'VIEW');
  expect((await asUser(viewer)('get', '/payroll/advances')).status).toBe(200);
  expect((await asUser(viewer)('post', '/payroll/advances', { employeeId: w.zaid.id, amount: 100 })).status).toBe(403);
  const other = await setup();
  expect((await other.hrApp('get', `/payroll/advances/${a.id}`)).status).toBe(404);
  expect((await other.admin('get', `/employee-advance-vouchers/${v.id}`)).status).toBe(404);
});

/** Zaid (10, fixed 30,000 + 3,000 allowances, loan of 10,000 over 2 months paid out), Dan (11, fixed 20,000); October 2026. */
async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const adminUser = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const admin = asUser(adminUser);
  await ok(admin('post', '/accounts/apply-template', { templateKey: 'other' }));
  const [factory] = (await ok(admin('get', '/payroll/groups'))).data;
  const dept = await ok(admin('post', '/payroll/departments', { groupId: factory.id, name: 'Assembly', fte: 0 }), 201);
  const worker = await ok(admin('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(admin('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const emp = async (code, name, basic, extra = {}) => {
    const e = await ok(admin('post', '/payroll/employees', { code, name, cnic: `4230${String(code).padStart(9, '0')}`, groupId: factory.id, departmentId: dept.id, designationId: worker.id, shiftId: shift.id,
      joiningDate: '2025-01-01', basicSalary: basic, salaryType: 'FIXED', ...extra }), 201);
    await ok(admin('post', `/payroll/employees/${e.id}/confirm`));
    return e;
  };
  const zaid = await emp(10, 'Zaid Khan', 30000, { foodAllowance: 2000, mobileAllowance: 1000 });
  const dan = await emp(11, 'Dan Ali', 20000);
  const hr = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hr, 'PAYROLL_SALARY', 'FULL');
  await grant(hr, 'PAYROLL_APPLICATIONS', 'FULL');
  const hrApp = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hrApp, 'PAYROLL_APPLICATIONS', 'FULL');
  const bank = await Account.findOne({ where: { companyId: company.id, code: '1102' } });
  // a loan of 10,000 over 2 months from October, paid out
  const loan = await ok(asUser(hrApp)('post', '/payroll/loans', { employeeId: zaid.id, appliedAmount: 10000, months: 2, deductFrom: MONTH, applicationDate: '2026-09-20' }), 201);
  await ok(asUser(hrApp)('post', `/payroll/loans/${loan.id}/submit`));
  await ok(admin('post', `/payroll/loans/${loan.id}/approve`));
  const lv = await ok(admin('post', '/employee-loan-vouchers', { loanId: loan.id, payFromAccountId: bank.id, paymentMode: 'ONLINE', amount: 10000 }), 201);
  await ok(admin('post', `/employee-loan-vouchers/${lv.id}/confirm`));
  return { company, admin, hr: asUser(hr), hrApp: asUser(hrApp), factory, zaid, dan, bank };
}
