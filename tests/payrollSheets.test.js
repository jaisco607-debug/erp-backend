const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA', 'ACC_PAYMENTS'];
const tokenOf = async (u) => `Bearer ${(await loginAs(u)).accessToken}`;
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: await tokenOf(u) }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const grant = async (user, code, access) => UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });
const binary = (res, cb) => { res.buffer(true); res.parse((r, done) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => done(null, Buffer.concat(c))); }); return cb ? res.then(cb) : res; };

test('food and maintenance are paid pro-rata on the days worked (P + L + HD + R), a fixed salary gets them in full, a figure typed by HR stays', async () => {
  const w = await setup();
  const slips = (await ok(w.api('get', `/payroll/runs/${w.run.id}/slips`))).data;
  const of = (code) => slips.find((s) => s.employee.code === code);
  // Zaid (10): 14 days present + the 4 Sundays (R) = 18 of 31 days; food 3,100 and maintenance 1,550 -> 1,800 and 900; mobile in full
  expect(of(10).additions).toMatchObject({ foodFull: '3100.00', food: '1800.00', maintenanceFull: '1550.00', maintenance: '900.00', mobile: '1000.00', total: '3700.00' });
  expect(of(10).days).toMatchObject({ P: 14, R: 4, A: 1 });
  // Fatima (12) is a FIXED salary: in full whatever the attendance
  expect(of(12).additions).toMatchObject({ food: '3100.00', maintenance: '1550.00' });
  // typed by HR: kept; "auto" gives it back to the days
  let s = await ok(w.hr('patch', `/payroll/slips/${of(10).id}`, { food: 2500 }));
  expect(s.additions).toMatchObject({ food: '2500.00', maintenance: '900.00' });
  s = await ok(w.hr('post', `/payroll/slips/${of(10).id}/calculate`));
  expect(s.additions.food).toBe('2500.00');
  s = await ok(w.hr('post', `/payroll/slips/${of(10).id}/calculate`, { auto: true }));
  expect(s.additions).toMatchObject({ food: '1800.00', maintenance: '900.00' });
});

test('salary sheet and attendance sheet (data and Excel), payslip PDFs', async () => {
  const w = await setup();
  const slips = (await ok(w.api('get', `/payroll/runs/${w.run.id}/slips`))).data;
  const zaid = slips.find((s) => s.employee.code === 10);
  const dan = slips.find((s) => s.employee.code === 11);
  await ok(w.hr('post', `/payroll/slips/${dan.id}/suspend`, { note: 'on hold' }));
  // approve Zaid
  await ok(w.hr('post', `/payroll/slips/${zaid.id}/review`));
  await ok(w.api('post', `/payroll/slips/${zaid.id}/final-review`));
  await ok(w.api('post', `/payroll/slips/${zaid.id}/approve`));

  const sheet = await ok(w.api('get', `/payroll/runs/${w.run.id}/salary-sheet`));
  expect(sheet.run).toMatchObject({ label: expect.stringMatching(/^Payroll #/), month: '2026-10', monthLabel: 'October 2026', daysInMonth: 31 });
  expect(sheet.data.map((r) => [r.sr, r.employee.code, r.status])).toEqual([[1, 10, 'APPROVED'], [2, 11, 'SUSPENDED'], [3, 12, 'DRAFT']]);
  expect(sheet.data[1].countedInTotals).toBe(false);
  // the totals: the payslips that count (not the suspended one); paid and balance of the approved
  const sum = (k) => sheet.data.filter((r) => r.countedInTotals).reduce((t, r) => t + Number(r[k]), 0);
  for (const k of ['basicSalary', 'gross', 'additions', 'deductions', 'net']) expect(Number(sheet.totals[k])).toBeCloseTo(sum(k), 2);
  expect(sheet.totals).toMatchObject({ employees: 2, balance: sheet.data[0].net, paid: '0.00' });
  expect(sheet.data[0]).toMatchObject({ food: '1800.00', maintenance: '900.00', mobile: '1000.00', additions: '3700.00', days: { P: 14, R: 4 } });
  // the same totals as the Payroll Summary
  const summary = await ok(w.api('get', '/payroll/runs?month=2026-10'));
  expect(sheet.totals.balance).toBe(summary.data[0].totals.balance);

  const xl = await binary(request(app).get(`/api/v1/payroll/runs/${w.run.id}/salary-sheet?format=xlsx`).set({ Authorization: await tokenOf(w.admin) }));
  expect(xl.status).toBe(200);
  expect(xl.headers['content-type']).toMatch(/spreadsheetml/);
  expect(xl.body.subarray(0, 2).toString()).toBe('PK');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xl.body);
  const ws = wb.getWorksheet('Salary Sheet');
  expect(ws.getCell(4, 3).value).toBe('Name');
  expect(ws.getCell(5, 3).value).toBe('ZAID KHAN');
  expect(ws.getRow(5 + sheet.data.length).getCell(3).value).toBe('Total (2 employees)');

  // the attendance sheet
  const att = await ok(w.api('get', `/payroll/runs/${w.run.id}/attendance-sheet`));
  expect(att.dates).toHaveLength(31);
  expect(att.dates[0]).toEqual({ date: '2026-10-01', day: 1, weekday: 'Thu' });
  expect(att.legend.map((l) => l.code)).toEqual(['P', 'L', 'HD', 'A', 'R', 'AL', '-']);
  const z = att.data.find((r) => r.employee.code === 10);
  expect(z.codes).toHaveLength(31);
  expect(z.codes[0]).toBe('P'); // 1 Oct
  expect(z.codes[3]).toBe('R'); // Sunday 4 Oct
  expect(z.codes[8]).toBe('A'); // Friday 9 Oct: Zaid did not come, the others did
  expect(z.counts).toMatchObject({ P: 14, R: 4, A: 1 });
  const ax = await binary(request(app).get(`/api/v1/payroll/runs/${w.run.id}/attendance-sheet?format=xlsx`).set({ Authorization: await tokenOf(w.admin) }));
  expect(ax.status).toBe(200);
  expect(ax.body.subarray(0, 2).toString()).toBe('PK');

  // payslip PDFs
  const one = await binary(request(app).get(`/api/v1/payroll/slips/${zaid.id}/pdf`).set({ Authorization: await tokenOf(w.admin) }));
  expect(one.status).toBe(200);
  expect(one.headers['content-type']).toBe('application/pdf');
  expect(one.body.subarray(0, 5).toString()).toBe('%PDF-');
  const all = await binary(request(app).get(`/api/v1/payroll/runs/${w.run.id}/payslips.pdf`).set({ Authorization: await tokenOf(w.admin) }));
  expect(all.status).toBe(200);
  expect(all.body.subarray(0, 5).toString()).toBe('%PDF-');
  expect(all.body.length).toBeGreaterThan(one.body.length);
  expect(((all.body.toString('latin1')).match(/\/Type \/Page\b/g) || []).length).toBe(2); // the suspended payslip is left out

  // access: a payroll viewer reads; nobody else; another company sees nothing
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(viewer, 'PAYROLL_REPORTS', 'VIEW');
  expect((await asUser(viewer)('get', `/payroll/runs/${w.run.id}/salary-sheet`)).status).toBe(200);
  const nobody = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(nobody, 'ACC_PAYMENTS', 'FULL');
  expect((await asUser(nobody)('get', `/payroll/runs/${w.run.id}/salary-sheet`)).status).toBe(403);
  const other = await setup();
  expect((await other.api('get', `/payroll/runs/${w.run.id}/salary-sheet`)).status).toBe(404);
  expect((await other.api('get', `/payroll/slips/${zaid.id}/pdf`)).status).toBe(404);
  expect((await w.api('get', `/payroll/runs/${w.run.id}/salary-sheet?format=csv`)).status).toBe(400);
});

/** October 2026: Zaid (10, monthly 31,000, food 3,100, maintenance 1,550, mobile 1,000, 15 weekdays present), Dan (11) and Fatima (12, FIXED 45,000 with the same allowances). */
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
  const emp = async (code, name, extra) => {
    const e = await ok(api('post', '/payroll/employees', { code, name, cnic: `4230${String(code).padStart(9, '0')}`, groupId: factory.id, departmentId: dept.id, designationId: worker.id, shiftId: shift.id,
      joiningDate: '2025-01-01', foodAllowance: 3100, maintenanceAllowance: 1550, mobileAllowance: 1000, ...extra }), 201);
    await ok(api('post', `/payroll/employees/${e.id}/confirm`));
    return e;
  };
  await emp(10, 'Zaid Khan', { basicSalary: 31000 });
  await emp(11, 'Dan Ali', { basicSalary: 31000 });
  await emp(12, 'Fatima Noor', { basicSalary: 45000, salaryType: 'FIXED' });
  const days = ['01', '02', '03', '05', '06', '07', '08', '09', '12', '13', '14', '15', '16', '19', '20'];
  const rows = [10, 11].flatMap((code) => days.filter((d) => code === 11 || d !== '09').flatMap((d) => [{ employeeId: code, date: `2026-10-${d}`, time: '08:00' }, { employeeId: code, date: `2026-10-${d}`, time: '16:00' }]));
  await ok(api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const run = await ok(api('post', '/payroll/runs', { month: '2026-10', groupId: factory.id }), 201);
  const hrUser = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hrUser, 'PAYROLL_SALARY', 'FULL');
  return { company, admin, api, hr: asUser(hrUser), run };
}
