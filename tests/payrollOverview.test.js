const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA', 'ACC_PAYMENTS'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const grant = async (user, code, access) => UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });

test('the overview: one answer with the same numbers as the Payroll Summary, the Salary Tax Report and the approval lists', async () => {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  await ok(api('post', '/accounts/apply-template', { templateKey: 'other' }));
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Assembly', fte: 0 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const ids = [];
  for (const [code, name, basic, tax] of [[10, 'Abdul', 100000, 1000], [11, 'Basit', 80000, 0]]) {
    const e = await ok(api('post', '/payroll/employees', { code, name, cnic: `4230${String(code).padStart(9, '0')}`, groupId: factory.id, departmentId: dept.id, designationId: worker.id, shiftId: shift.id,
      joiningDate: '2025-01-01', salaryType: 'FIXED', basicSalary: basic, monthlyIncomeTax: tax }), 201);
    await ok(api('post', `/payroll/employees/${e.id}/confirm`));
    ids.push(e.id);
  }
  // an unmapped punch (no such employee) and a mapped one
  await ok(api('post', '/payroll/attendance/punches/import', { rows: [{ employeeId: 10, date: '2026-10-05', time: '08:00' }, { employeeId: 99, date: '2026-10-05', time: '08:05' }, { employeeId: 98, date: '2026-10-06', time: '08:05' }] }), 201);
  const run = await ok(api('post', '/payroll/runs', { month: '2026-10', groupId: factory.id }), 201);
  const slips = (await ok(api('get', `/payroll/runs/${run.id}/slips`))).data;
  const hr = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hr, 'PAYROLL_SALARY', 'FULL');
  const slip = slips.find((s) => s.employee.code === 10).id;
  await ok(asUser(hr)('post', `/payroll/slips/${slip}/review`));
  await ok(api('post', `/payroll/slips/${slip}/final-review`));
  await ok(api('post', `/payroll/slips/${slip}/approve`));

  const r = await request(app).get('/api/v1/payroll/overview?month=2026-10').set({ Authorization: `Bearer ${(await loginAs(admin)).accessToken}` });
  expect(r.status).toBe(200);
  expect(r.headers['cache-control']).toBe('private, max-age=30');
  const o = r.body;
  expect(Object.keys(o)).toEqual(['month', 'monthLabel', 'employees', 'payroll', 'trend', 'breakdown', 'attendance', 'compliance', 'approvals']);
  expect(o).toMatchObject({ month: '2026-10', monthLabel: 'October 2026', employees: { total: 2, closed: 0 } });
  expect(o.employees.groups.find((g) => g.name === factory.name)).toMatchObject({ employees: 2, closed: 0 });

  // the same as /payroll/runs
  const summary = await ok(api('get', '/payroll/runs?month=2026-10'));
  expect(o.payroll.runs).toEqual(summary.data);
  expect(o.payroll.totals).toEqual(summary.totals);
  expect(o.payroll.runs[0].slips).toBeUndefined();
  expect(o.payroll.totals).toMatchObject({ payrolls: 1, employees: 2 });

  // the trend: six months ending at the month
  expect(o.trend.map((t) => t.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  expect(o.trend[0]).toEqual({ month: '2026-05', monthLabel: 'May 2026', payrolls: 0, employees: 0, net: '0.00', paid: '0.00', balance: '0.00' });
  expect(o.trend[5]).toMatchObject({ payrolls: 1, employees: 2, net: summary.totals.netApproved, paid: '0.00', balance: summary.totals.salaryBalance });

  // the breakdown adds up
  const b = o.breakdown;
  expect(Number(b.basic) + Number(b.overtime)).toBeCloseTo(Number(b.gross), 2);
  expect(Number(b.gross) + Number(b.additions) - Number(b.deductions)).toBeCloseTo(Number(b.net), 2);
  expect(Number(b.loan) + Number(b.eobi) + Number(b.incomeTax) + Number(b.otherDeductions)).toBeCloseTo(Number(b.deductions), 2);
  expect(b).toMatchObject({ gross: '180000.00', incomeTax: '1000.00' });

  // attendance
  expect(o.attendance).toEqual({ punchesToday: 0, monthPunches: 3, unmappedIds: 2 });
  // compliance: the same as the Salary Tax Report
  const rep = (await ok(api('get', '/payroll/income-tax/report?month=2026-10'))).cards;
  expect(o.compliance.tax).toEqual({ withheld: rep.deducted, paid: rep.paidToGovernment, toPay: rep.toPay });
  expect(o.compliance.tax).toEqual({ withheld: '1000.00', paid: '0.00', toPay: '1000.00' });
  expect(o.compliance.eobi).toEqual({ listEmployees: 0, workingEmployees: 2 });
  expect(o.approvals).toEqual({ waiting: { joining: 0, leave: 0, resignation: 0, loan: 0, total: 0 } });

  // a month with nothing, and a future month: zeros, not an error
  for (const m of ['2026-03', '2031-01']) {
    const e = await ok(api('get', `/payroll/overview?month=${m}`));
    expect(e.payroll).toEqual({ totals: { payrolls: 0, employees: 0, basic: '0.00', netApproved: '0.00', salaryBalance: '0.00', contribution: '0.00' }, runs: [] });
    expect(e.breakdown.net).toBe('0.00');
    expect(e.attendance.monthPunches).toBe(0);
    expect(e.trend).toHaveLength(6);
  }
  // no month: the current month
  expect((await ok(api('get', '/payroll/overview'))).month).toMatch(/^\d{4}-\d{2}$/);
  // invalid month
  for (const bad of ['2026-13', 'abc', '2026-1']) {
    const x = await api('get', `/payroll/overview?month=${bad}`);
    expect([x.status, x.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
  }
  // access: any payroll service (VIEW) reads; nobody without one; another company sees nothing of this one
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(viewer, 'PAYROLL_REPORTS', 'VIEW');
  expect((await asUser(viewer)('get', '/payroll/overview?month=2026-10')).status).toBe(200);
  const nobody = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(nobody, 'ACC_PAYMENTS', 'FULL');
  expect((await asUser(nobody)('get', '/payroll/overview')).status).toBe(403);
});
