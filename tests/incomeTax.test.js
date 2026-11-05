const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA', 'ACC_PAYMENTS', 'ACC_REPORTS'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };
const sql = (text, replacements) => sequelize.query(text, { replacements, type: sequelize.QueryTypes.SELECT });
const grant = async (user, code, access) => UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });

/** Three FIXED-salary employees: 10 (100,000, card tax 1,000 a month), 11 (80,000, no tax), 12 (50,000, no tax); a draft card 13. */
async function setup() {
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
      joiningDate: '2025-01-01', salaryType: 'FIXED', ...extra }), 201);
    if (confirm) await ok(api('post', `/payroll/employees/${e.id}/confirm`));
    return e;
  };
  const e = { 10: await emp(10, 'Abdul Ghani', { basicSalary: 100000, monthlyIncomeTax: 1000 }), 11: await emp(11, 'Basit Ali', { basicSalary: 80000 }), 12: await emp(12, 'Chand Khan', { basicSalary: 50000 }) };
  e[13] = await emp(13, 'Draft Dan', { basicSalary: 20000 }, false);
  const hr = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hr, 'PAYROLL_SALARY', 'FULL');
  const accountant = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(accountant, 'ACC_PAYMENTS', 'FULL');
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(viewer, 'PAYROLL_SALARY', 'VIEW');
  return { company, api, hr: asUser(hr), accountant: asUser(accountant), viewer: asUser(viewer), factory, e, bank: await Account.findOne({ where: { companyId: company.id, code: '1102' } }) };
}
const taxList = (w, month, qs = '') => ok(w.api('get', `/payroll/income-tax?month=${month}${qs}`));
const row = (body, code) => body.data.find((r) => r.employee.code === code);
const entry = (id) => sql(`SELECT a.name, l.debit::float AS debit, l.credit::float AS credit FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id JOIN accounts a ON a.id = l."accountId"
  WHERE e."sourceId" = :id AND e."reversalOfId" IS NULL ORDER BY l."lineNo"`, { id });

test('the tax of each employee: the card percent until a history row, then an amount or a percent from a month; by hand and from a sheet', async () => {
  const w = await setup();
  const start = await taxList(w, '2026-10');
  expect(start.total).toBe(3); // the draft card is not here
  expect(row(start, 10)).toMatchObject({ source: 'CARD', percent: null, monthlyAmount: '1000.00', monthlyTax: '1000.00', basicSalary: '100000.00', effectiveFrom: null });
  expect(row(start, 11)).toMatchObject({ source: 'NONE', monthlyTax: '0.00' });
  expect(start.summary).toEqual({ employees: 3, withTax: 1, withoutTax: 2 });

  // by hand: a fixed amount from October for 11; a percent from November for 10
  const h = await ok(w.api('put', `/payroll/income-tax/employees/${w.e[11].id}`, { effectiveFrom: '2026-10', monthlyAmount: 12500 }));
  expect(h.data).toEqual([expect.objectContaining({ month: '2026-10', monthLabel: 'Oct 2026', monthlyAmount: '12500.00', percent: null, monthlyTax: '12500.00', source: 'MANUAL' })]);
  await ok(w.api('put', `/payroll/income-tax/employees/${w.e[10].id}`, { effectiveFrom: '2026-11', percent: 2.5 }));
  expect(row(await taxList(w, '2026-10'), 10)).toMatchObject({ source: 'CARD', monthlyTax: '1000.00' }); // October is unchanged
  expect(row(await taxList(w, '2026-11'), 10)).toMatchObject({ source: 'PERCENT', percent: 2.5, monthlyTax: '2500.00', effectiveFrom: '2026-11' });
  expect(row(await taxList(w, '2026-12'), 11)).toMatchObject({ source: 'AMOUNT', monthlyAmount: '12500.00', effectiveFrom: '2026-10' }); // it holds until the next row
  expect(row(await taxList(w, '2026-09'), 11)).toMatchObject({ source: 'NONE' }); // not before its month
  // the same month again changes it; another amount from a later month adds a row
  await ok(w.api('put', `/payroll/income-tax/employees/${w.e[11].id}`, { effectiveFrom: '2026-10', monthlyAmount: '13000.50' }));
  const h2 = await ok(w.api('put', `/payroll/income-tax/employees/${w.e[11].id}`, { effectiveFrom: '2027-01', monthlyAmount: 15000 }));
  expect(h2.data.map((r) => [r.month, r.monthlyAmount])).toEqual([['2027-01', '15000.00'], ['2026-10', '13000.50']]);
  // a zero amount means "no tax from this month"
  await ok(w.api('put', `/payroll/income-tax/employees/${w.e[12].id}`, { effectiveFrom: '2026-10', monthlyAmount: 0 }));
  expect(row(await taxList(w, '2026-10'), 12)).toMatchObject({ source: 'AMOUNT', monthlyTax: '0.00' });
  await fails(w.api('put', `/payroll/income-tax/employees/${w.e[10].id}`, { monthlyAmount: 100, percent: 1 }), 422, 'AMOUNT_OR_PERCENT');
  await fails(w.api('put', `/payroll/income-tax/employees/${w.e[10].id}`, {}), 400, 'VALIDATION_FAILED');
  await fails(w.api('put', `/payroll/income-tax/employees/${w.e[10].id}`, { percent: 101 }), 400, 'VALIDATION_FAILED');
  await fails(w.api('put', `/payroll/income-tax/employees/${w.e[13].id}`, { percent: 1 }), 422, 'EMPLOYEE_NOT_CONFIRMED');
  await fails(w.api('put', '/payroll/income-tax/employees/8f3c1a2e-1111-4222-8333-444455556666', { percent: 1 }), 404, 'NOT_FOUND');
  // filters
  expect((await taxList(w, '2026-10', '&search=chand')).data.map((r) => r.employee.code)).toEqual([12]);
  expect((await taxList(w, '2026-10', '&search=4230-0000000-11')).data.map((r) => r.employee.code)).toEqual([11]);
  expect((await taxList(w, '2026-10', '&source=CARD')).data.map((r) => r.employee.code)).toEqual([10]);
  // taking a row away: the earlier one (or the card) applies again
  const first = (await ok(w.api('get', `/payroll/income-tax/employees/${w.e[10].id}`))).data[0].id;
  await ok(w.api('delete', `/payroll/income-tax/${first}`), 204);
  expect(row(await taxList(w, '2026-11'), 10)).toMatchObject({ source: 'CARD', monthlyTax: '1000.00' });
  await fails(w.api('delete', `/payroll/income-tax/${first}`), 404, 'NOT_FOUND');

  // the sheet: ID or CNIC, an amount or a percent
  const rows = [
    { employeeId: 10, monthlyAmount: '11,000' }, { cnic: '4230-0000000-11', percent: 3 }, { employeeId: 12, tax: 5000 }, { employeeId: 99, percent: 1 }, { employeeId: 10, percent: 1 },
    { employeeId: 13, percent: 1 }, { employeeId: 12 }, { employeeId: 11, monthlyAmount: 1, percent: 1 }, {}, { employeeId: '', cnic: '4230000000099', percent: 1 },
  ];
  const dry = await ok(w.api('post', '/payroll/income-tax/import', { effectiveFrom: '2027-02', rows, dryRun: true }));
  expect(dry).toMatchObject({ dryRun: true, effectiveFrom: '2027-02', effectiveFromLabel: 'Feb 2027', total: 10, updated: 3, unchanged: 0, notUsed: 7 });
  expect(dry.results.map((r) => r.status)).toEqual(['UPDATED', 'UPDATED', 'UPDATED', 'NOT_FOUND', 'DUPLICATE_IN_FILE', 'EMPLOYEE_NOT_CONFIRMED', 'DUPLICATE_IN_FILE', 'DUPLICATE_IN_FILE', 'NO_ID', 'NOT_FOUND']);
  expect(row(await taxList(w, '2027-02'), 10)).toMatchObject({ source: 'CARD' }); // the preview saved nothing
  const real = await ok(w.api('post', '/payroll/income-tax/import', { effectiveFrom: '2027-02', rows }));
  expect(real).toMatchObject({ dryRun: false, updated: 3 });
  const feb = await taxList(w, '2027-02');
  expect([row(feb, 10), row(feb, 11), row(feb, 12)].map((r) => [r.source, r.monthlyAmount, r.percent, r.monthlyTax])).toEqual([['AMOUNT', '11000.00', null, '11000.00'], ['PERCENT', null, 3, '2400.00'], ['AMOUNT', '5000.00', null, '5000.00']]);
  expect((await ok(w.api('get', `/payroll/income-tax/employees/${w.e[10].id}`))).data[0]).toMatchObject({ month: '2027-02', source: 'EXCEL' });
  // the same sheet again: nothing changes
  const again = await ok(w.api('post', '/payroll/income-tax/import', { effectiveFrom: '2027-02', rows: [rows[0], rows[1], rows[2]] }));
  expect(again).toMatchObject({ updated: 0, unchanged: 3 });
  // invalid values are reported, not saved
  const bad = await ok(w.api('post', '/payroll/income-tax/import', { effectiveFrom: '2027-02', rows: [{ employeeId: 10, monthlyAmount: 'abc' }, { employeeId: 11, percent: 150 }] }));
  expect(bad.results.map((r) => r.status)).toEqual(['INVALID_VALUE', 'INVALID_VALUE']);
  await fails(w.api('post', '/payroll/income-tax/import', { rows: [] }), 400, 'VALIDATION_FAILED');

  // access: reading with any payroll service, changing needs PAYROLL_EMPLOYEES FULL
  await ok(w.viewer('get', '/payroll/income-tax?month=2026-10'));
  expect((await w.viewer('put', `/payroll/income-tax/employees/${w.e[10].id}`, { percent: 1 })).status).toBe(403);
  expect((await w.hr('post', '/payroll/income-tax/import', { rows: [{ employeeId: 10, percent: 1 }] })).status).toBe(403);
  const other = await setup();
  await fails(other.api('get', `/payroll/income-tax/employees/${w.e[10].id}`), 404, 'NOT_FOUND');
});

test('the payslip takes the tax from the history (an amount or a percent) and the card percent otherwise; changes reach it when it is calculated; manual figures stay', async () => {
  const w = await setup();
  await ok(w.api('put', `/payroll/income-tax/employees/${w.e[11].id}`, { effectiveFrom: '2026-10', monthlyAmount: 12500 }));
  const run = await ok(w.api('post', '/payroll/runs', { month: '2026-10', groupId: w.factory.id }), 201);
  const slips = async () => (await ok(w.api('get', `/payroll/runs/${run.id}/slips`))).data;
  const of = async (code) => (await slips()).find((s) => s.employee.code === code);
  expect(await of(10)).toMatchObject({ taxSource: 'AMOUNT', deductions: { incomeTax: '1000.00' } });
  expect(await of(11)).toMatchObject({ taxSource: 'AMOUNT', deductions: { incomeTax: '12500.00' } });
  expect(await of(12)).toMatchObject({ taxSource: 'NONE', deductions: { incomeTax: '0.00' } });
  // the government raises 10's tax: the payslip keeps its figure until it is calculated again
  await ok(w.api('put', `/payroll/income-tax/employees/${w.e[10].id}`, { effectiveFrom: '2026-10', monthlyAmount: 4000 }));
  const s10 = await of(10);
  expect(s10.deductions.incomeTax).toBe('1000.00');
  expect(await ok(w.api('post', `/payroll/slips/${s10.id}/calculate`))).toMatchObject({ taxSource: 'AMOUNT', deductions: { incomeTax: '4000.00' } });
  // a figure typed by HR is kept; "auto" gives it back to the history
  const typed = await ok(w.api('patch', `/payroll/slips/${s10.id}`, { incomeTax: 3500 }));
  expect(typed).toMatchObject({ taxSource: 'MANUAL', deductions: { incomeTax: '3500.00' } });
  expect(await ok(w.api('post', `/payroll/slips/${s10.id}/calculate`, { auto: true }))).toMatchObject({ taxSource: 'AMOUNT', deductions: { incomeTax: '4000.00' } });
  // an earlier month is not touched by a later row
  await ok(w.api('put', `/payroll/income-tax/employees/${w.e[12].id}`, { effectiveFrom: '2026-11', percent: 10 }));
  const s12 = await of(12);
  expect(await ok(w.api('post', `/payroll/slips/${s12.id}/calculate`))).toMatchObject({ taxSource: 'NONE', deductions: { incomeTax: '0.00' } });
});

test('the salary tax voucher: Debit Salary Tax Payable / Credit Bank for the approved payslips; the tax report; locked against sending the payslip back', async () => {
  const w = await setup();
  await ok(w.api('put', `/payroll/income-tax/employees/${w.e[11].id}`, { effectiveFrom: '2026-10', monthlyAmount: 12500 }));
  const run = await ok(w.api('post', '/payroll/runs', { month: '2026-10', groupId: w.factory.id }), 201);
  const slips = (await ok(w.api('get', `/payroll/runs/${run.id}/slips`))).data;
  const id = (code) => slips.find((s) => s.employee.code === code).id;
  const approve = async (code) => {
    await ok(w.hr('post', `/payroll/slips/${id(code)}/review`));
    await ok(w.api('post', `/payroll/slips/${id(code)}/final-review`));
    await ok(w.api('post', `/payroll/slips/${id(code)}/approve`));
  };
  await approve(10);
  await approve(11);
  // 12 has no tax; it stays a draft
  const picker = await ok(w.accountant('get', '/salary-tax-vouchers/slips?month=2026-10'));
  expect(picker).toMatchObject({ month: '2026-10', employees: 2, amount: 13500, onVouchers: 0 });
  expect(picker.data.map((r) => [r.employee.code, r.tax])).toEqual([[10, 1000], [11, 12500]]);
  const make = (body, status = 201) => ok(w.accountant('post', '/salary-tax-vouchers', { month: '2026-10', payFromAccountId: w.bank.id, paymentMode: 'ONLINE', ...body }), status);
  await fails(w.accountant('post', '/salary-tax-vouchers', { month: '2026-09', payFromAccountId: w.bank.id, paymentMode: 'ONLINE' }), 422, 'NOTHING_TO_PAY');
  await fails(w.accountant('post', '/salary-tax-vouchers', { month: '2026-10', payFromAccountId: (await Account.findOne({ where: { companyId: w.company.id, code: '1103' } })).id, paymentMode: 'ONLINE' }), 422, 'NOT_BANK_OR_CASH');
  await fails(w.accountant('post', '/salary-tax-vouchers', { month: '2026-10', payFromAccountId: w.bank.id, paymentMode: 'ONLINE', slipIds: [id(12)] }), 422, 'SLIP_NOT_AVAILABLE');

  // the report before any payment
  const rep0 = await ok(w.api('get', '/payroll/income-tax/report?month=2026-10'));
  expect(rep0.cards).toEqual({ employees: 2, deducted: '13500.00', approved: '13500.00', paidToGovernment: '0.00', onDraftVoucher: '0.00', toPay: '13500.00' });
  expect(rep0.data.map((r) => [r.employee.code, r.tax, r.paymentStatus])).toEqual([[10, '1000.00', 'UNPAID'], [11, '12500.00', 'UNPAID']]);

  // pay Abdul only, then the rest
  const v1 = await make({ slipIds: [id(10)], refNo: 'CPR-1', notes: 'Oct tax Abdul' });
  expect(v1).toMatchObject({ voucherLabel: 'STV-00001', status: 'DRAFT', month: '2026-10', employees: 1, amount: 1000, canConfirm: true });
  expect(v1.lines.map((l) => [l.employee.code, l.tax])).toEqual([[10, 1000]]);
  await fails(w.accountant('post', '/salary-tax-vouchers', { month: '2026-10', payFromAccountId: w.bank.id, paymentMode: 'ONLINE', slipIds: [id(10)] }), 422, 'SLIP_IN_A_VOUCHER');
  expect((await ok(w.accountant('get', '/salary-tax-vouchers/slips?month=2026-10'))).data.map((r) => r.employee.code)).toEqual([11]);
  expect((await ok(w.accountant('patch', `/salary-tax-vouchers/${v1.id}`, { paymentMode: 'CHEQUE', chequeNo: '77', chequeDate: '2026-11-05' }))).paymentMode).toBe('CHEQUE');
  // while it is on a voucher the payslip cannot be sent back
  await fails(w.api('post', `/payroll/slips/${id(10)}/send-back`), 422, 'SLIP_TAX_ON_VOUCHER');
  const c1 = await ok(w.accountant('post', `/salary-tax-vouchers/${v1.id}/confirm`));
  expect(c1).toMatchObject({ status: 'CONFIRMED', amount: 1000, canEdit: false, canUnconfirm: true });
  expect(await entry(v1.id)).toEqual([{ name: 'Income Tax Payable - Salaries', debit: 1000, credit: 0 }, { name: 'Bank Account', debit: 0, credit: 1000 }]);
  await fails(w.accountant('patch', `/salary-tax-vouchers/${v1.id}`, { notes: 'x' }), 422, 'VOUCHER_CONFIRMED');
  await fails(w.accountant('delete', `/salary-tax-vouchers/${v1.id}`), 422, 'VOUCHER_CONFIRMED');
  await fails(w.accountant('post', `/salary-tax-vouchers/${v1.id}/confirm`), 422, 'ALREADY_CONFIRMED');
  expect(await ok(w.accountant('get', `/salary-tax-vouchers/${v1.id}/accounts-entry`))).toMatchObject({ posted: true, voucherLabel: 'STV-00001' });

  const v2 = await make({});
  expect(v2).toMatchObject({ voucherLabel: 'STV-00002', employees: 1, amount: 12500 });
  await ok(w.accountant('post', `/salary-tax-vouchers/${v2.id}/confirm`));
  const rep1 = await ok(w.api('get', '/payroll/income-tax/report?month=2026-10'));
  expect(rep1.cards).toMatchObject({ paidToGovernment: '13500.00', toPay: '0.00' });
  expect(rep1.data.map((r) => [r.employee.code, r.paymentStatus, r.voucher.label])).toEqual([[10, 'PAID', 'STV-00001'], [11, 'PAID', 'STV-00002']]);
  // the Salary Tax Payable account: withheld 13,500 (credit by the payroll), paid 13,500 (debit by the vouchers)
  const [bal] = await sql(`SELECT COALESCE(SUM(l.credit - l.debit), 0)::float AS balance FROM journal_lines l JOIN accounts a ON a.id = l."accountId" JOIN journal_entries e ON e.id = l."entryId"
    WHERE a."companyId" = :c AND a."controlType" = 'SALARY_TAX_PAYABLE' AND e.status IN ('POSTED', 'REVERSED')`, { c: w.company.id });
  expect(bal.balance).toBe(0);

  // moved back to draft: reversed
  const un = await ok(w.accountant('post', `/salary-tax-vouchers/${v2.id}/unconfirm`, { reason: 'wrong bank' }));
  expect(un).toMatchObject({ status: 'DRAFT', canEdit: true });
  expect((await ok(w.api('get', '/payroll/income-tax/report?month=2026-10'))).cards).toMatchObject({ paidToGovernment: '1000.00', onDraftVoucher: '12500.00' });
  await fails(w.accountant('post', `/salary-tax-vouchers/${v2.id}/unconfirm`), 422, 'NOT_CONFIRMED');
  expect((await ok(w.accountant('get', '/salary-tax-vouchers'))).summary).toMatchObject({ vouchers: 2, amount: 13500, confirmed: 1000 });
  expect((await ok(w.accountant('get', '/salary-tax-vouchers?status=DRAFT'))).total).toBe(1);
  await ok(w.accountant('delete', `/salary-tax-vouchers/${v2.id}`), 204);
  expect((await ok(w.accountant('get', '/salary-tax-vouchers/slips?month=2026-10'))).data.map((r) => r.employee.code)).toEqual([11]); // free again
  const defaults = (await ok(w.api('get', '/accounts/defaults'))).data.find((x) => x.key === 'SALARY_TAX_PAYABLE');
  expect(defaults).toMatchObject({ status: 'SET', group: 'PAYROLL' });
  // access: the payroll people cannot pay, the accountant cannot read the payroll
  expect((await w.hr('get', '/salary-tax-vouchers')).status).toBe(403);
  expect((await w.accountant('get', '/payroll/income-tax/report?month=2026-10')).status).toBe(403);
  const other = await setup();
  await fails(other.accountant('get', `/salary-tax-vouchers/${v1.id}`), 404, 'NOT_FOUND');
});
