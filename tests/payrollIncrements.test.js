const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };
const grant = async (user, code, access) => UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });

/**
 * Bin Hur Aslam (564, Admin group): salary 68,000, food 2,000, maintenance 10,000.   Muhammad Raheel (550, Admin): 60,000, mobile 1,000.
 * Salman (551, Factory): 40,000.   Draft Dan (552): not confirmed.   Leaver (553): closed.
 */
async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  await ok(api('post', '/accounts/apply-template', { templateKey: 'other' }));
  const groups = (await ok(api('get', '/payroll/groups'))).data;
  const factory = groups.find((g) => g.name === 'Factory') || groups[0];
  const adminGroup = groups.find((g) => g.name === 'Admin') || groups[groups.length - 1];
  const dept = await ok(api('post', '/payroll/departments', { groupId: adminGroup.id, name: 'Administration', fte: 0 }), 201);
  const dept2 = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Assembly', fte: 0 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const emp = async (code, name, group, department, extra, confirm = true) => {
    const e = await ok(api('post', '/payroll/employees', { code, name, cnic: `4230${String(code).padStart(9, '0')}`, groupId: group.id, departmentId: department.id, designationId: worker.id, shiftId: shift.id,
      joiningDate: '2025-07-01', salaryType: 'FIXED', ...extra }), 201);
    if (confirm) await ok(api('post', `/payroll/employees/${e.id}/confirm`));
    return e;
  };
  const e = {
    564: await emp(564, 'Bin Hur Aslam', adminGroup, dept, { basicSalary: 68000, foodAllowance: 2000, maintenanceAllowance: 10000 }),
    550: await emp(550, 'Muhammad Raheel', adminGroup, dept, { basicSalary: 60000, mobileAllowance: 1000 }),
    551: await emp(551, 'Salman Ali', factory, dept2, { basicSalary: 40000 }),
    552: await emp(552, 'Draft Dan', factory, dept2, { basicSalary: 30000 }, false),
    553: await emp(553, 'Leaver Khan', factory, dept2, { basicSalary: 30000 }),
  };
  await ok(api('post', `/payroll/employees/${e[553].id}/close`, { leavingDate: '2026-09-30' }));
  const hr = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hr, 'PAYROLL_APPLICATIONS', 'FULL');
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(viewer, 'PAYROLL_REPORTS', 'VIEW');
  return { company, admin, api, hr: asUser(hr), viewer: asUser(viewer), factory, adminGroup, e };
}
const draftFor = async (w, code) => (await ok(w.hr('post', '/payroll/increments', { employeeIds: [w.e[code].id] }), 201)).data[0];
const master = async (w, code) => (await ok(w.api('get', `/payroll/employees/${w.e[code].id}`)));

test('the employee list of the "Select" box and the drafts made from it', async () => {
  const w = await setup();
  const all = await ok(w.hr('get', '/payroll/increments/employees'));
  expect(all.total).toBe(3); // not the draft card, not the leaver
  expect(all.data.map((e) => [e.code, e.name, e.salary, e.group.name, e.department, e.payrollAccount, e.hasOpenIncrement])).toEqual([
    [564, 'BIN HUR ASLAM', '68000.00', w.adminGroup.name, 'Administration', false, false], [550, 'MUHAMMAD RAHEEL', '60000.00', w.adminGroup.name, 'Administration', false, false],
    [551, 'SALMAN ALI', '40000.00', w.factory.name, 'Assembly', false, false]].sort((a, b) => a[1].localeCompare(b[1])));
  expect((await ok(w.hr('get', `/payroll/increments/employees?groupId=${w.factory.id}`))).data.map((e) => e.code)).toEqual([551]);
  expect((await ok(w.hr('get', '/payroll/increments/employees?search=4230-0000005-50'))).data.map((e) => e.code)).toEqual([550]);
  expect((await ok(w.hr('get', '/payroll/increments/employees?search=assembly'))).data.map((e) => e.code)).toEqual([551]);

  const made = await ok(w.hr('post', '/payroll/increments', { employeeIds: [w.e[564].id, w.e[550].id, w.e[552].id, w.e[553].id] }), 201);
  expect(made.created).toBe(2);
  expect(made.skipped).toEqual([{ code: 552, name: 'DRAFT DAN', reason: 'NOT_CONFIRMED' }, { code: 553, name: 'LEAVER KHAN', reason: 'EMPLOYEE_CLOSED' }]);
  const d = made.data.find((x) => x.employee.code === 564);
  expect(d).toMatchObject({ status: 'DRAFT', statusCode: 0, statusText: 'Draft', appId: expect.stringMatching(/^\d{5}$/), canEdit: true, canSubmit: true, currentSalary: '68000.00', newSalary: '68000.00', increase: '0.00', monthCode: null });
  expect(d.employee).toMatchObject({ emplId: '0564', name: 'BIN HUR ASLAM', designation: 'Worker', hasPhoto: false });
  expect(d.heads.map((h) => [h.key, h.label, h.current, h.increase, h.final])).toEqual([['salary', 'Salary', '68000.00', '0.00', '68000.00'], ['food', 'Food', '2000.00', '0.00', '2000.00'], ['mobile', 'Mobile', '0.00', '0.00', '0.00'], ['maintenance', 'Maint', '10000.00', '0.00', '10000.00']]);
  expect(d.total).toEqual({ current: '80000.00', increase: '0.00', final: '80000.00' });
  // one open increment per employee
  const again = await ok(w.hr('post', '/payroll/increments', { employeeIds: [w.e[564].id, w.e[551].id] }), 201);
  expect(again.skipped).toEqual([{ code: 564, name: 'BIN HUR ASLAM', reason: 'OPEN_INCREMENT' }]);
  expect(again.created).toBe(1);
  expect((await ok(w.hr('get', '/payroll/increments/employees'))).data.filter((e) => e.hasOpenIncrement).map((e) => e.code).sort()).toEqual([550, 551, 564]);
  await fails(w.hr('post', '/payroll/increments', { employeeIds: ['8f3c1a2e-1111-4222-8333-444455556666'] }), 404, 'NOT_FOUND');
  await fails(w.hr('post', '/payroll/increments', { employeeIds: [] }), 400, 'VALIDATION_FAILED');
});

test('edit (final figures or increases), submit, review, post: the employee master gets the salary AND the allowances; the history and the tabs', async () => {
  const w = await setup();
  const bin = await draftFor(w, 564);
  const raheel = await draftFor(w, 550);
  // Bin Hur: salary +4,000 (68,000 -> 72,000), nothing else: 5.00 % of the total 80,000
  let b = await ok(w.hr('patch', `/payroll/increments/${bin.id}`, { salary: 72000, remarks: 'Annual', applicationDate: '2026-10-01' }));
  expect(b).toMatchObject({ newSalary: '72000.00', increase: '4000.00', percent: 5, remarks: 'Annual', applicationDate: '2026-10-01', total: { current: '80000.00', increase: '4000.00', final: '84000.00' } });
  // Raheel: maintenance +5,000 by the increase (final 5,000); 5,000 of 61,000 = 8.20 %
  const r = await ok(w.hr('patch', `/payroll/increments/${raheel.id}`, { maintenanceIncrease: 5000, applicationDate: '2026-10-31' }));
  expect(r.heads.find((h) => h.key === 'maintenance')).toEqual({ key: 'maintenance', label: 'Maint', name: 'Maintenance', current: '0.00', increase: '5000.00', final: '5000.00' });
  expect(r).toMatchObject({ percent: 8.2, increase: '0.00', total: { current: '61000.00', increase: '5000.00', final: '66000.00' } }); // the salary head did not change: the list shows 0
  await fails(w.hr('patch', `/payroll/increments/${bin.id}`, { salary: 60000 }), 422, 'BELOW_CURRENT');
  await fails(w.hr('patch', `/payroll/increments/${bin.id}`, { salary: 70000, salaryIncrease: 100 }), 422, 'FINAL_OR_INCREASE');
  await fails(w.hr('patch', `/payroll/increments/${bin.id}`, { salary: 'abc' }), 400, 'VALIDATION_FAILED');
  await fails(w.hr('patch', `/payroll/increments/${bin.id}`, {}), 400, 'VALIDATION_FAILED');

  // no increase: cannot be submitted
  const sal = await draftFor(w, 551);
  await fails(w.hr('post', `/payroll/increments/${sal.id}/submit`), 422, 'NO_INCREASE');
  await ok(w.hr('delete', `/payroll/increments/${sal.id}`), 204);
  await fails(w.hr('delete', `/payroll/increments/${sal.id}`), 404, 'NOT_FOUND');

  const sub = await ok(w.hr('post', `/payroll/increments/${bin.id}/submit`));
  expect(sub).toMatchObject({ status: 'REVIEW', statusCode: 1, canEdit: false, canSubmit: false, canWithdraw: true, canApprove: false, banner: { tone: 'warning', title: 'Waiting for approval' } });
  await fails(w.hr('patch', `/payroll/increments/${bin.id}`, { salary: 73000 }), 422, 'INCREMENT_LOCKED');
  await fails(w.hr('delete', `/payroll/increments/${bin.id}`), 422, 'INCREMENT_LOCKED');
  await fails(w.hr('post', `/payroll/increments/${bin.id}/submit`), 422, 'WRONG_STATUS');
  // the people who are not approvers cannot move it on
  expect((await w.hr('post', `/payroll/increments/${bin.id}/approve`)).status).toBe(403);
  expect((await w.viewer('post', `/payroll/increments/${bin.id}/submit`)).status).toBe(403);
  const asAdmin = await ok(w.api('get', `/payroll/increments/${bin.id}`));
  expect(asAdmin).toMatchObject({ canFinalReview: true, canApprove: true, canSendBack: true, canReject: true });
  expect(asAdmin.flow.map((s) => [s.step, s.title, s.done])).toEqual([[1, 'Creator', true], [2, 'Approver', false], [3, 'Posted', false]]);
  // withdraw and submit again
  expect((await ok(w.hr('post', `/payroll/increments/${bin.id}/withdraw`))).status).toBe('DRAFT');
  await ok(w.hr('post', `/payroll/increments/${bin.id}/submit`));
  const fr = await ok(w.api('post', `/payroll/increments/${bin.id}/final-review`));
  expect(fr).toMatchObject({ status: 'FINAL_REVIEW', statusCode: 2, statusText: 'Final Review' });
  await fails(w.api('post', `/payroll/increments/${bin.id}/final-review`), 422, 'WRONG_STATUS');
  await ok(w.hr('post', `/payroll/increments/${raheel.id}/submit`));

  // the master is not touched before the posting
  expect(await master(w, 564)).toMatchObject({ basicSalary: '68000.00' });
  const posted = await ok(w.api('post', `/payroll/increments/${bin.id}/approve`));
  expect(posted).toMatchObject({ status: 'APPROVED', statusCode: 3, statusText: 'Posted', posted: true, banner: { tone: 'success', title: 'Approved' }, canEdit: false, currentSalary: '68000.00', newSalary: '72000.00', increase: '4000.00' });
  expect(posted.flow.map((s) => s.done)).toEqual([true, true, true]);
  expect(posted.approvedBy).toMatchObject({ name: expect.any(String) });
  expect(await master(w, 564)).toMatchObject({ basicSalary: '72000.00', foodAllowance: '2000.00', maintenanceAllowance: '10000.00' });
  await ok(w.api('post', `/payroll/increments/${raheel.id}/approve`)); // straight from Review
  expect(await master(w, 550)).toMatchObject({ basicSalary: '60000.00', mobileAllowance: '1000.00', maintenanceAllowance: '5000.00' }); // an allowance increase only

  // the history of the employee on the screen
  const again = await ok(w.api('get', `/payroll/increments/${bin.id}`));
  expect(again.salaryHistory).toEqual([expect.objectContaining({ date: '2026-10-01', last: '68000.00', increase: '4000.00', new: '72000.00', status: 3, totalIncrease: '4000.00' })]);
  expect(again.donationHistory).toEqual([]);
  expect(again.loanHistory).toEqual([]);

  // the tabs, the counts and the cards: Total Increase is of the salary head
  const next = await draftFor(w, 551);
  const counts = (await ok(w.hr('get', '/payroll/increments'))).counts;
  expect(counts).toEqual({ draft: 1, review: 0, finalReview: 0, posted: 2 });
  const tab = await ok(w.hr('get', '/payroll/increments?status=APPROVED'));
  expect(tab).toMatchObject({ total: 2, cards: { records: 2, totalIncrease: '4000.00', totalIncreaseAll: '9000.00' } });
  expect(tab.data.map((x) => [x.appId === bin.appId, x.employee.emplId, x.employee.group.name === w.adminGroup.name, x.currentSalary, x.newSalary, x.increase])).toEqual([[false, '0550', true, '60000.00', '60000.00', '0.00'], [true, '0564', true, '68000.00', '72000.00', '4000.00']]);
  expect((await ok(w.hr('get', '/payroll/increments?status=DRAFT'))).data.map((x) => x.id)).toEqual([next.id]);
  expect((await ok(w.hr('get', '/payroll/increments?status=APPROVED&search=raheel'))).total).toBe(1);
  expect((await ok(w.hr('get', '/payroll/increments?status=APPROVED&search=administration'))).total).toBe(2);
  expect((await ok(w.hr('get', `/payroll/increments?status=APPROVED&groupId=${w.factory.id}`))).total).toBe(0);
  const text = await w.hr('get', '/payroll/increments/csv?status=APPROVED');
  expect(text.status).toBe(200);
  expect(text.text.split('\n')[0]).toBe('ID,EmployeeID,Name,Department,Class,Month,Current_Salary,New_Salary,Increase,Status');
  expect(text.text).toMatch(/564,BIN HUR ASLAM,Administration,.*68000.00,72000.00,4000.00,Posted/);
  expect((await w.hr('get', '/payroll/increments/sample.csv')).text.split('\n')[0]).toBe('EmployeeID,New_Salary,month_code,Remarks');
});

test('a rejection needs a reason and sends the increment back to draft with it; a changed master is caught', async () => {
  const w = await setup();
  const d = await draftFor(w, 550);
  await ok(w.hr('patch', `/payroll/increments/${d.id}`, { salary: 65000 }));
  await ok(w.hr('post', `/payroll/increments/${d.id}/submit`));
  await fails(w.api('post', `/payroll/increments/${d.id}/reject`, {}), 400, 'VALIDATION_FAILED');
  const rej = await ok(w.api('post', `/payroll/increments/${d.id}/reject`, { reason: 'Too high' }));
  expect(rej).toMatchObject({ status: 'DRAFT', rejectReason: 'Too high', banner: { tone: 'danger', title: 'Sent back' }, canEdit: true });
  expect(rej.banner.text).toMatch(/Too high/);
  await ok(w.hr('patch', `/payroll/increments/${d.id}`, { salary: 62000 }));
  const again = await ok(w.hr('post', `/payroll/increments/${d.id}/submit`));
  expect(again.rejectReason).toBeNull();
  // "send back" without a reason
  const sb = await ok(w.api('post', `/payroll/increments/${d.id}/send-back`));
  expect(sb).toMatchObject({ status: 'DRAFT', rejectReason: null });
  // the master is raised by hand meanwhile: the new figure is not an increase any more
  await ok(w.api('post', `/payroll/employees/${w.e[550].id}/unconfirm`));
  await ok(w.api('patch', `/payroll/employees/${w.e[550].id}`, { basicSalary: 70000 }));
  await ok(w.api('post', `/payroll/employees/${w.e[550].id}/confirm`));
  await fails(w.hr('post', `/payroll/increments/${d.id}/submit`), 422, 'BELOW_CURRENT');
  const live = await ok(w.hr('get', `/payroll/increments/${d.id}`));
  expect(live.currentSalary).toBe('70000.00'); // read live
  await ok(w.hr('patch', `/payroll/increments/${d.id}`, { salaryIncrease: 3000 }));
  expect((await ok(w.hr('post', `/payroll/increments/${d.id}/submit`))).newSalary).toBe('73000.00');
});

test('bulk steps: submit, approve and reject many; each row says what happened', async () => {
  const w = await setup();
  const a = await draftFor(w, 564);
  const b = await draftFor(w, 550);
  await ok(w.hr('patch', `/payroll/increments/${a.id}`, { salaryIncrease: 1000 }));
  await ok(w.hr('patch', `/payroll/increments/${b.id}`, { salaryIncrease: 2000 }));
  const sub = await ok(w.hr('post', '/payroll/increments/bulk/submit', { ids: [a.id, b.id] }));
  expect(sub).toMatchObject({ done: 2, failed: 0 });
  const c = await draftFor(w, 551);
  const mix = await ok(w.api('post', '/payroll/increments/bulk/approve', { ids: [a.id, c.id] })); // c is a draft
  expect(mix).toMatchObject({ done: 1, failed: 1 });
  expect(mix.results.find((x) => x.id === c.id)).toMatchObject({ ok: false, code: 'WRONG_STATUS' });
  const rej = await ok(w.api('post', '/payroll/increments/bulk/reject', { ids: [b.id], reason: 'Wait for the next cycle' }));
  expect(rej.done).toBe(1);
  expect((await ok(w.api('get', `/payroll/increments/${b.id}`))).rejectReason).toBe('Wait for the next cycle');
  await fails(w.api('post', '/payroll/increments/bulk/reject', { ids: [b.id] }), 400, 'VALIDATION_FAILED');
  expect((await w.hr('post', '/payroll/increments/bulk/approve', { ids: [b.id] })).status).toBe(403);
});

test('the CSV upload: EmployeeID, New_Salary, month_code, Remarks; open increments and salaries that are not higher are skipped', async () => {
  const w = await setup();
  await draftFor(w, 551); // Salman already has an open increment
  const rows = [
    { employeeId: 564, newSalary: '75,000', monthCode: '022025', remarks: 'Annual' }, { employeeId: '550', newSalary: 61000, monthCode: '', remarks: '' }, { employeeId: 551, newSalary: 45000 },
    { employeeId: 99, newSalary: 1000 }, { employeeId: 564, newSalary: 80000 }, { employeeId: 553, newSalary: 50000 }, { employeeId: 552, newSalary: 50000 }, {},
    { employeeId: 550, newSalary: 'abc' },
  ];
  const dry = await ok(w.hr('post', '/payroll/increments/import', { rows, dryRun: true }));
  expect(dry).toMatchObject({ dryRun: true, total: 9, created: 2 });
  expect(dry.results.map((r) => r.status)).toEqual(['CREATED', 'CREATED', 'OPEN_INCREMENT', 'NOT_FOUND', 'DUPLICATE_IN_FILE', 'EMPLOYEE_CLOSED', 'NOT_CONFIRMED', 'NO_ID', 'DUPLICATE_IN_FILE']);
  expect((await ok(w.hr('get', '/payroll/increments'))).counts.draft).toBe(1); // nothing saved by the preview
  const real = await ok(w.hr('post', '/payroll/increments/import', { rows }));
  expect(real).toMatchObject({ dryRun: false, created: 2 });
  const list = (await ok(w.hr('get', '/payroll/increments?status=DRAFT'))).data;
  const bin = list.find((x) => x.employee.code === 564);
  expect(bin).toMatchObject({ newSalary: '75000.00', increase: '7000.00', monthCode: '022025', effectiveMonth: '2025-02', monthLabel: 'Feb 2025', remarks: 'Annual', source: 'CSV' });
  expect(list.find((x) => x.employee.code === 550)).toMatchObject({ newSalary: '61000.00', monthCode: null });
  // not higher / bad values
  const bad = await ok(w.hr('post', '/payroll/increments/import', { rows: [{ employeeId: 551, newSalary: 40000 }, { employeeId: 564, newSalary: 1, monthCode: '13' }] }));
  expect(bad.results.map((r) => r.status)).toEqual(['OPEN_INCREMENT', 'INVALID_MONTH']);
  const w2 = await setup();
  const not = await ok(w2.hr('post', '/payroll/increments/import', { rows: [{ employeeId: 564, newSalary: 68000 }, { employeeId: 550, newSalary: 70000, monthCode: '13' }, { employeeId: 551, newSalary: 41000, monthCode: '2026-11' }] }));
  expect(not.results.map((r) => r.status)).toEqual(['NOT_HIGHER', 'INVALID_MONTH', 'CREATED']);
  await fails(w.hr('post', '/payroll/increments/import', { rows: [] }), 400, 'VALIDATION_FAILED');
});

test('an increment that applies from a later month does not change the payroll of an earlier month; access is by company', async () => {
  const w = await setup();
  const d = await draftFor(w, 564);
  await ok(w.hr('patch', `/payroll/increments/${d.id}`, { salary: 72000, effectiveMonth: '2027-01' }));
  await ok(w.hr('post', `/payroll/increments/${d.id}/submit`));
  await ok(w.api('post', `/payroll/increments/${d.id}/approve`));
  expect(await master(w, 564)).toMatchObject({ basicSalary: '72000.00' });
  const run = await ok(w.api('post', '/payroll/runs', { month: '2026-10', groupId: w.adminGroup.id }), 201);
  const slips = (await ok(w.api('get', `/payroll/runs/${run.id}/slips`))).data;
  expect(slips.find((s) => s.employee.code === 564)).toMatchObject({ basicSalary: '68000.00' }); // October still pays the old salary
  expect((await ok(w.api('get', `/payroll/increments/${d.id}`))).effectiveMonth).toBe('2027-01');

  // access: any payroll service reads; changing needs PAYROLL_APPLICATIONS FULL; another company sees nothing
  expect((await w.viewer('get', '/payroll/increments')).status).toBe(200);
  expect((await w.viewer('post', '/payroll/increments', { employeeIds: [w.e[551].id] })).status).toBe(403);
  expect((await w.viewer('post', '/payroll/increments/import', { rows: [{ employeeId: 551, newSalary: 50000 }] })).status).toBe(403);
  const other = await setup();
  await fails(other.api('get', `/payroll/increments/${d.id}`), 404, 'NOT_FOUND');
  await fails(other.api('post', `/payroll/increments/${d.id}/approve`), 404, 'NOT_FOUND');
  expect((await other.api('get', '/payroll/increments')).body.total).toBe(0);
});
