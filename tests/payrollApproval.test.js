const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

beforeEach(clean);

const PAYROLL = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };

const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(40, 1), Buffer.from('ffd9', 'hex')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

async function grant(user, code, access) {
  await UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });
}
async function setup(fte = 5) {
  const company = await makeCompany();
  for (const code of PAYROLL) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Dishwash', fte }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const senior = await ok(api('post', '/payroll/designations', { name: 'Senior Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: '08A-07P', startTime: '08:00', endTime: '19:00', dutyHours: 11 }), 201);
  const hrUser = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hrUser, 'PAYROLL_APPLICATIONS', 'FULL');
  const hr = asUser(hrUser);
  return { company, admin, api, hrUser, hr, factory, dept, worker, senior, shift, hrToken: (await loginAs(hrUser)).accessToken };
}
const form = (w, extra = {}) => ({ name: 'Ali Raza', groupId: w.factory.id, joiningDate: '2026-11-01', cnic: '42301-1448872-9', departmentId: w.dept.id, designationId: w.worker.id, shiftId: w.shift.id, basicSalary: 30000, ...extra });
const put = (w, id, kind, body, type) => request(app).put(`/api/v1/payroll/applications/${id}/files/${kind}`).set({ Authorization: `Bearer ${w.hrToken}`, 'Content-Type': type }).send(body);
async function inReview(w, extra = {}) {
  const a = await ok(w.hr('post', '/payroll/applications', form(w, extra)), 201);
  for (const [k, b, t] of [['photo', JPG, 'image/jpeg'], ['cnic-front', JPG, 'image/jpeg'], ['cnic-back', PDF, 'application/pdf']]) expect((await put(w, a.id, k, b, t)).status).toBe(200);
  return ok(w.hr('post', `/payroll/applications/${a.id}/submit`));
}

test('approvers: a person with a payroll service can be chosen; one without is refused; only PAYROLL_EMPLOYEES FULL changes the list', async () => {
  const w = await setup();
  expect(await ok(w.api('get', '/payroll/approvers'))).toEqual({ data: [], clientAdminAlways: true });
  const boss = await makeUser({ userType: 'USER', companyId: w.company.id, name: 'Boss' });
  await fails(w.api('put', '/payroll/approvers', { userIds: [boss.id] }), 422, 'NO_PAYROLL_ACCESS');
  await grant(boss, 'PAYROLL_REPORTS', 'VIEW');
  const r = await ok(w.api('put', '/payroll/approvers', { userIds: [boss.id, boss.id] }));
  expect(r.data.map((u) => u.id)).toEqual([boss.id]);
  await fails(w.hr('put', '/payroll/approvers', { userIds: [] }), 403);
  const stranger = await makeUser({ userType: 'USER', companyId: (await makeCompany()).id });
  await fails(w.api('put', '/payroll/approvers', { userIds: [stranger.id] }), 404, 'NOT_FOUND');
  expect((await ok(w.api('put', '/payroll/approvers', { userIds: [] }))).data).toEqual([]);
});

test('approve: HR cannot; the client admin corrects the salary, approves, and a confirmed employee card with the documents appears; the application is then closed', async () => {
  const w = await setup();
  const a = await inReview(w);
  expect(a).toMatchObject({ status: 'IN_REVIEW', canApprove: false, canReviewEdit: false, canWithdraw: true });
  await fails(w.hr('post', `/payroll/applications/${a.id}/approve`), 403);
  await fails(w.hr('patch', `/payroll/applications/${a.id}/review`, { basicSalary: 1 }), 403);
  const seen = await ok(w.api('get', `/payroll/applications/${a.id}`));
  expect(seen).toMatchObject({ canApprove: true, canReject: true, canReviewEdit: true, submittedBy: expect.any(String) });
  // the reviewer fixes the work and salary details; personal fields are not accepted here
  await fails(w.api('patch', `/payroll/applications/${a.id}/review`, { name: 'Other' }), 400, 'VALIDATION_FAILED');
  await fails(w.api('patch', `/payroll/applications/${a.id}/review`, { departmentId: null }), 422, 'APPLICATION_INCOMPLETE');
  const fixed = await ok(w.api('patch', `/payroll/applications/${a.id}/review`, { basicSalary: 35000, foodAllowance: 1500, designationId: w.senior.id, monthlyIncomeTax: '875' }));
  expect(fixed).toMatchObject({ basicSalary: '35000.00', foodAllowance: '1500.00', designation: { name: 'Senior Worker' }, monthlyIncomeTax: '875.00', monthlyDeductions: { incomeTax: '875.00', eobi: '0.00', total: '875.00' } });
  await fails(w.hr('patch', `/payroll/applications/${a.id}`, { basicSalary: 1 }), 422, 'APPLICATION_IN_REVIEW');

  const done = await ok(w.api('post', `/payroll/applications/${a.id}/approve`));
  expect(done).toMatchObject({ status: 'APPROVED', statusText: 'Approved', canApprove: false, canWithdraw: false, canEdit: false, approval: { employeeId: expect.any(String) } });
  const emp = await ok(w.api('get', `/payroll/employees/${done.approval.employeeId}`));
  expect(emp).toMatchObject({ code: 1, name: 'ALI RAZA', cnic: '42301-1448872-9', status: 'CONFIRMED', isClosed: false, basicSalary: '35000.00', foodAllowance: '1500.00', monthlyIncomeTax: '875.00', paymentMethod: 'CASH',
    designation: { name: 'Senior Worker' }, department: { name: 'Dishwash' }, joiningDate: '2026-11-01' });
  expect(emp.files.photo).toMatchObject({ mimeType: 'image/jpeg' });
  expect(emp.files.cnicBack).toMatchObject({ mimeType: 'application/pdf' });
  // the application keeps its own documents
  expect((await ok(w.api('get', `/payroll/applications/${a.id}`))).files.photo).not.toBeNull();
  await fails(w.api('post', `/payroll/applications/${a.id}/approve`), 422, 'NOT_IN_REVIEW');
  await fails(w.hr('patch', `/payroll/applications/${a.id}`, { basicSalary: 1 }), 422, 'APPLICATION_CLOSED');
  await fails(w.hr('delete', `/payroll/applications/${a.id}`), 422, 'APPLICATION_CLOSED');
  await fails(w.hr('post', `/payroll/applications/${a.id}/submit`), 422, 'APPLICATION_CLOSED');
  expect(await ok(w.api('get', '/payroll/applications/summary'))).toMatchObject({ total: 1, approved: 1, inReview: 0, rejected: 0 });
  expect((await ok(w.api('get', '/payroll/employees/summary'))).confirmed).toBe(1);
});

test('reject needs a reason; HR re-opens a rejected application, fixes it and sends it again', async () => {
  const w = await setup();
  const a = await inReview(w);
  await fails(w.api('post', `/payroll/applications/${a.id}/reject`, {}), 400, 'VALIDATION_FAILED');
  const r = await ok(w.api('post', `/payroll/applications/${a.id}/reject`, { reason: 'Salary too high' }));
  expect(r).toMatchObject({ status: 'REJECTED', statusText: 'Rejected', approval: { reason: 'Salary too high' }, canReopen: true, canEdit: false });
  await fails(w.hr('post', `/payroll/applications/${a.id}/withdraw`), 422, 'NOT_IN_REVIEW');
  await fails(w.hr('patch', `/payroll/applications/${a.id}`, { basicSalary: 20000 }), 422, 'APPLICATION_CLOSED');
  const d = await ok(w.hr('post', `/payroll/applications/${a.id}/reopen`));
  expect(d).toMatchObject({ status: 'DRAFT', approval: null, canEdit: true });
  await ok(w.hr('patch', `/payroll/applications/${a.id}`, { basicSalary: 20000 }));
  expect(await ok(w.hr('post', `/payroll/applications/${a.id}/submit`))).toMatchObject({ status: 'IN_REVIEW', basicSalary: '20000.00' });
  await fails(w.hr('post', `/payroll/applications/${a.id}/reopen`), 422, 'NOT_REJECTED');
  expect((await ok(w.api('get', '/payroll/employees'))).total).toBe(0);
});

test('a chosen approver can approve; a seat is taken by the approval (fte 1) and the next application then has no vacancy', async () => {
  const w = await setup(1);
  const boss = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(boss, 'PAYROLL_REPORTS', 'VIEW');
  await ok(w.api('put', '/payroll/approvers', { userIds: [boss.id] }));
  const a = await inReview(w);
  const b = await ok(w.hr('post', '/payroll/applications', form(w, { name: 'Bilal', cnic: '42301-1111111-1' })), 201);
  expect(b.id).toBeTruthy();
  const v = asUser(boss);
  expect((await ok(v('get', `/payroll/applications/${a.id}`)))).toMatchObject({ canApprove: true });
  expect((await ok(v('post', `/payroll/applications/${a.id}/approve`))).status).toBe('APPROVED');
  // the second one: documents, then the submit finds the seat taken by the new employee
  for (const [k, bf, t] of [['photo', JPG, 'image/jpeg'], ['cnic-front', JPG, 'image/jpeg'], ['cnic-back', PDF, 'application/pdf']]) await put(w, b.id, k, bf, t);
  const full = await fails(w.hr('post', `/payroll/applications/${b.id}/submit`), 422, 'NO_VACANCY');
  expect(full.details).toMatchObject({ fte: 1, taken: 1 });
});
