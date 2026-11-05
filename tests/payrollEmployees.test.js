const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, AuditLog } = require('../src/models');
const { serviceText } = require('../src/services/payrollEmployeeService');
const { percentCents } = require('../src/utils/payrollDeductions');

beforeEach(clean);

const PAYROLL = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const token = async (u) => (await loginAs(u)).accessToken;
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${await token(u)}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); expect(r.body.error.code).toBe(code); return r.body.error; };

// tiny but real file headers
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex')]);
const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(40, 1), Buffer.from('ffd9', 'hex')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

async function setup(codes = PAYROLL) {
  const company = await makeCompany();
  const s = {};
  for (const code of codes) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const [factory, outlet, head, adminGroup] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Dishwash', fte: 2 }), 201);
  const deptOutlet = await ok(api('post', '/payroll/departments', { groupId: outlet.id, name: 'Boat Basin', fte: 5 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: '08A-07P', startTime: '08:00', endTime: '19:00', dutyHours: 11 }), 201);
  const bank = await ok(api('post', '/payroll/banks', { name: 'Meezan Bank', shortName: 'MEZN', bankCode: '0110' }), 201);
  return { company, s, admin, api, token: await token(admin), factory, outlet, head, adminGroup, dept, deptOutlet, worker, shift, bank };
}
const base = (w, extra = {}) => ({ name: 'Muhammad Bilal', groupId: w.factory.id, joiningDate: '2022-04-26', ...extra });
const full = (w, extra = {}) => base(w, { cnic: '42301-1448872-9', departmentId: w.dept.id, designationId: w.worker.id, shiftId: w.shift.id, basicSalary: 89000, ...extra });

test('service text: whole months between two dates', () => {
  expect(serviceText('2022-04-26', '2026-10-30')).toBe('4y 6m');
  expect(serviceText('2023-12-24', '2026-10-30')).toBe('2y 10m');
  expect(serviceText('2026-10-01', '2026-10-30')).toBe('0m');
  expect(serviceText('2026-09-30', '2026-10-29')).toBe('0m');
  expect(serviceText('2026-05-10', '2026-10-10')).toBe('5m');
});

test('create: capitals, ID numbers, CNIC, amounts, the work links and the payment method; wrong data is refused', async () => {
  const w = await setup();
  const a = await ok(w.api('post', '/payroll/employees', base(w)), 201);
  expect(a).toMatchObject({
    code: 1, label: '00001', name: 'MUHAMMAD BILAL', group: { name: 'Factory' }, department: null, designation: null, shift: null, joiningDate: '2022-04-26', leavingDate: null,
    isClosed: false, state: 'ACTIVE', status: 'DRAFT', statusText: 'Draft', salaryType: 'MONTHLY', basicSalary: '0.00', foodAllowance: '0.00', monthlyIncomeTax: '0.00', eobiNo: null, scssiNo: null, iban: null, monthlyDeductions: { incomeTax: '0.00', eobi: '0.00', total: '0.00' }, paymentMethod: 'CASH', bank: null,
    files: { photo: null, cnicFront: null, cnicBack: null }, canEdit: true, canConfirm: true, canUnconfirm: false, canDelete: true, canClose: true, canReopen: false,
  });
  expect(a.serviceText).toMatch(/^\d+y \d+m$/);
  // the ID: the next free one, or one typed (to keep the numbers of an old system)
  expect((await ok(w.api('post', '/payroll/employees', base(w, { code: 7, name: 'Kamran Khan' })), 201))).toMatchObject({ code: 7, label: '00007' });
  expect((await ok(w.api('post', '/payroll/employees', base(w, { name: 'Next One' })), 201)).code).toBe(8);
  await fails(w.api('post', '/payroll/employees', base(w, { code: 7 })), 422, 'CODE_TAKEN');

  // CNIC and amounts
  const c = await ok(w.api('post', '/payroll/employees', full(w, { name: 'Hassan Jalali', cnic: '4250137916221', basicSalary: '68000.5', foodAllowance: 1000.25, mobileAllowance: '500', monthlyIncomeTax: '5000', eobiNo: 'E-123', scssiNo: 'S9', iban: 'PK36 SCBL 0000 0011 2345 6702' })), 201);
  expect(c).toMatchObject({ cnic: '42501-3791622-1', basicSalary: '68000.50', foodAllowance: '1000.25', mobileAllowance: '500.00', maintenanceAllowance: '0.00', monthlyIncomeTax: '5000.00', eobiNo: 'E-123', scssiNo: 'S9', iban: 'PK36SCBL0000001123456702', monthlyDeductions: { incomeTax: '5000.00', eobi: '0.00', total: '5000.00' } });
  expect(await ok(w.api('patch', `/payroll/employees/${c.id}`, { eobiNo: null, scssiNo: '', monthlyIncomeTax: '0' }))).toMatchObject({ eobiNo: null, scssiNo: null, monthlyIncomeTax: '0.00' });
  await fails(w.api('post', '/payroll/employees', base(w, { cnic: '42501-3791622-1' })), 422, 'CNIC_TAKEN');
  await fails(w.api('post', '/payroll/employees', base(w, { cnic: '425013791622-1' })), 422, 'CNIC_TAKEN'); // the same number written another way
  expect((await ok(w.api('post', '/payroll/employees', base(w, { name: 'No Cnic Two', cnic: '' })), 201)).cnic).toBeNull(); // empty = none, and none is not "the same"
  expect((await ok(w.api('post', '/payroll/employees', base(w, { name: 'No Cnic Three' })), 201)).cnic).toBeNull();
  for (const bad of [{ cnic: '123' }, { cnic: '4230114488729a' }, { basicSalary: -1 }, { basicSalary: '12.345' }, { basicSalary: 1.234 }, { basicSalary: 'abc' }, { phone: 'call me' }, { email: 'nope' },
    { joiningDate: '2026-02-30' }, { gender: 'X' }, { salaryType: 'WEEKLY' }, { name: 'A' }, { code: 0 }, { groupId: 'x' }, { status: 'CONFIRMED' }, { isClosed: true }]) {
    await fails(w.api('post', '/payroll/employees', base(w, bad)), 400, 'VALIDATION_FAILED');
  }
  await fails(w.api('post', '/payroll/employees', { name: 'No Group', joiningDate: '2022-04-26' }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/payroll/employees', { name: 'No Date', groupId: w.factory.id }), 400, 'VALIDATION_FAILED');

  // the links: the department belongs to the group, everything is the company's own and switched on
  await fails(w.api('post', '/payroll/employees', base(w, { departmentId: w.deptOutlet.id })), 422, 'DEPARTMENT_NOT_IN_GROUP');
  const other = await setup();
  await fails(w.api('post', '/payroll/employees', base(w, { designationId: other.worker.id })), 404, 'NOT_FOUND');
  await fails(w.api('post', '/payroll/employees', base(w, { groupId: other.factory.id })), 404, 'NOT_FOUND');
  await ok(w.api('patch', `/payroll/shifts/${w.shift.id}`, { isActive: false }));
  await fails(w.api('post', '/payroll/employees', base(w, { shiftId: w.shift.id })), 422, 'SHIFT_INACTIVE');
  await ok(w.api('patch', `/payroll/shifts/${w.shift.id}`, { isActive: true }));
  await ok(w.api('patch', `/payroll/groups/${w.outlet.id}`, { isActive: false }));
  await fails(w.api('post', '/payroll/employees', base(w, { groupId: w.outlet.id })), 422, 'GROUP_INACTIVE');

  // payment: no bank account = cash automatically; bank + account number = bank; BANK needs the details; CASH can be chosen on purpose
  await fails(w.api('post', '/payroll/employees', base(w, { name: 'Bank A', paymentMethod: 'BANK' })), 422, 'BANK_DETAILS_REQUIRED');
  await fails(w.api('post', '/payroll/employees', base(w, { name: 'Bank B', paymentMethod: 'BANK', bankId: w.bank.id })), 422, 'BANK_DETAILS_REQUIRED');
  const bank = await ok(w.api('post', '/payroll/employees', base(w, { name: 'Bank C', bankId: w.bank.id, accountNo: '0103308659', accountTitle: 'Rizwan Ali Khan' })), 201);
  expect(bank).toMatchObject({ paymentMethod: 'BANK', bank: { name: 'Meezan Bank' }, accountNo: '0103308659', accountTitle: 'Rizwan Ali Khan' });
  const cash = await ok(w.api('post', '/payroll/employees', base(w, { name: 'Bank D', bankId: w.bank.id, accountNo: '1', paymentMethod: 'CASH' })), 201);
  expect(cash.paymentMethod).toBe('CASH');
  expect(await ok(w.api('patch', `/payroll/employees/${bank.id}`, { bankId: null, accountNo: null }))).toMatchObject({ paymentMethod: 'CASH', bank: null, accountNo: null }); // no account: cash
  expect(await ok(w.api('patch', `/payroll/employees/${bank.id}`, { bankId: w.bank.id, accountNo: '55' }))).toMatchObject({ paymentMethod: 'BANK' });
  expect(await ok(w.api('patch', `/payroll/employees/${bank.id}`, { name: 'Bank C Renamed' }))).toMatchObject({ paymentMethod: 'BANK', name: 'BANK C RENAMED' }); // unrelated edit keeps it
  expect(await AuditLog.count({ where: { action: 'PAYROLL_EMPLOYEE_CREATED' } })).toBeGreaterThanOrEqual(5);
});

test('the card: draft, confirm (needs the required details), locked, edit = un-confirm, close with a leaving date, re-open, delete', async () => {
  const w = await setup();
  const e = await ok(w.api('post', '/payroll/employees', base(w)), 201);
  const inc = await fails(w.api('post', `/payroll/employees/${e.id}/confirm`), 422, 'EMPLOYEE_INCOMPLETE');
  expect(inc.details.missing).toEqual(['cnic', 'departmentId', 'designationId', 'shiftId', 'basicSalary']);
  await ok(w.api('patch', `/payroll/employees/${e.id}`, { cnic: '42301-1448872-9', departmentId: w.dept.id, designationId: w.worker.id, shiftId: w.shift.id, basicSalary: 89000, bankId: w.bank.id, accountNo: '123' }));
  expect((await fails(w.api('post', `/payroll/employees/${e.id}/confirm`), 422, 'EMPLOYEE_INCOMPLETE')).details.missing).toEqual(['accountTitle']); // paying by bank needs the account title
  await ok(w.api('patch', `/payroll/employees/${e.id}`, { accountTitle: 'Muhammad Bilal' }));
  const c = await ok(w.api('post', `/payroll/employees/${e.id}/confirm`));
  expect(c).toMatchObject({ status: 'CONFIRMED', statusText: 'Confirmed', canEdit: false, canConfirm: false, canUnconfirm: true, canDelete: false });
  expect(c.confirmedAt).toBeTruthy();
  await fails(w.api('post', `/payroll/employees/${e.id}/confirm`), 422, 'ALREADY_CONFIRMED');
  await fails(w.api('patch', `/payroll/employees/${e.id}`, { basicSalary: 90000 }), 422, 'EMPLOYEE_CONFIRMED');
  await fails(w.api('delete', `/payroll/employees/${e.id}`), 422, 'EMPLOYEE_CONFIRMED');
  // Edit = back to draft
  expect(await ok(w.api('post', `/payroll/employees/${e.id}/unconfirm`))).toMatchObject({ status: 'DRAFT', canEdit: true, confirmedAt: null });
  await fails(w.api('post', `/payroll/employees/${e.id}/unconfirm`), 422, 'NOT_CONFIRMED');
  expect(await ok(w.api('patch', `/payroll/employees/${e.id}`, { basicSalary: 90000 }))).toMatchObject({ basicSalary: '90000.00' });

  // closing: needs a leaving date, not before joining; a closed card is read only
  await fails(w.api('post', `/payroll/employees/${e.id}/close`, {}), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', `/payroll/employees/${e.id}/close`, { leavingDate: '2022-04-25' }), 422, 'LEAVING_BEFORE_JOINING');
  await ok(w.api('post', `/payroll/employees/${e.id}/confirm`));
  const closed = await ok(w.api('post', `/payroll/employees/${e.id}/close`, { leavingDate: '2026-10-15' })); // a confirmed card can be closed
  expect(closed).toMatchObject({ isClosed: true, state: 'CLOSED', leavingDate: '2026-10-15', serviceText: '4y 5m', canEdit: false, canClose: false, canReopen: true });
  await fails(w.api('post', `/payroll/employees/${e.id}/close`, { leavingDate: '2026-10-16' }), 422, 'ALREADY_CLOSED');
  await fails(w.api('patch', `/payroll/employees/${e.id}`, { name: 'Changed' }), 422, 'EMPLOYEE_CLOSED');
  await fails(w.api('post', `/payroll/employees/${e.id}/unconfirm`), 422, 'EMPLOYEE_CLOSED');
  const reopened = await ok(w.api('post', `/payroll/employees/${e.id}/reopen`));
  expect(reopened).toMatchObject({ isClosed: false, state: 'ACTIVE', leavingDate: null, status: 'CONFIRMED' });
  await fails(w.api('post', `/payroll/employees/${e.id}/reopen`), 422, 'NOT_CLOSED');

  // a draft is deleted together with its documents
  const d = await ok(w.api('post', '/payroll/employees', base(w, { name: 'Draft Person' })), 201);
  await ok(request(app).put(`/api/v1/payroll/employees/${d.id}/files/photo`).set({ Authorization: `Bearer ${w.token}`, 'Content-Type': 'image/png' }).send(PNG));
  await ok(w.api('delete', `/payroll/employees/${d.id}`), 204);
  await fails(w.api('get', `/payroll/employees/${d.id}`), 404, 'NOT_FOUND');
  expect(await sequelize.query('SELECT count(*)::int AS n FROM payroll_files WHERE "ownerId" = :id', { replacements: { id: d.id }, type: sequelize.QueryTypes.SELECT })).toEqual([{ n: 0 }]);
  expect(await AuditLog.count({ where: { entityType: 'PayrollEmployee', entityId: e.id } })).toBeGreaterThanOrEqual(8);
});

test('list, filters and the tab numbers; head-count and vacancy; a group, department, designation, shift or bank with employees is never deleted', async () => {
  const w = await setup();
  const mk = (extra) => ok(w.api('post', '/payroll/employees', full(w, extra)), 201);
  const a = await mk({ name: 'Ali Raza', cnic: '42201-8312845-1', phone: '0313-2317609' });
  const b = await mk({ name: 'Bilal Ahmed', cnic: '42301-1448872-9', phone: '92 315 8652242' });
  const c = await ok(w.api('post', '/payroll/employees', base(w, { name: 'Kamran Outlet', groupId: w.outlet.id, departmentId: w.deptOutlet.id, cnic: '41901-0396720-1' })), 201);
  const gone = await mk({ name: 'Old Hand', cnic: '53204-1081876-9' });
  await ok(w.api('post', `/payroll/employees/${b.id}/confirm`));
  await ok(w.api('post', `/payroll/employees/${gone.id}/close`, { leavingDate: '2025-12-31' }));

  const names = async (q) => (await ok(w.api('get', `/payroll/employees${q}`))).data.map((x) => x.name);
  expect(await names('')).toEqual(['ALI RAZA', 'BILAL AHMED', 'KAMRAN OUTLET']); // the working employees, by ID
  expect(await names('?closed=true')).toEqual(['OLD HAND']);
  expect(await names('?closed=all')).toHaveLength(4);
  expect(await names(`?groupId=${w.outlet.id}`)).toEqual(['KAMRAN OUTLET']);
  expect(await names(`?departmentId=${w.dept.id}`)).toEqual(['ALI RAZA', 'BILAL AHMED']);
  expect(await names('?status=CONFIRMED')).toEqual(['BILAL AHMED']);
  expect(await names(`?designationId=${w.worker.id}&shiftId=${w.shift.id}`)).toEqual(['ALI RAZA', 'BILAL AHMED']);
  expect(await names('?search=raza')).toEqual(['ALI RAZA']);
  expect(await names('?search=00002')).toEqual(['BILAL AHMED']); // by the ID as printed
  expect(await names('?search=dishwash')).toEqual(['ALI RAZA', 'BILAL AHMED']); // by department
  expect(await names('?name=kam')).toEqual(['KAMRAN OUTLET']);
  expect(await names('?code=2')).toEqual(['BILAL AHMED']);
  expect(await names('?cnicOrCell=1448872')).toEqual(['BILAL AHMED']);
  expect(await names('?cnicOrCell=0313')).toEqual(['ALI RAZA']);
  expect(await names('?limit=2&page=2')).toEqual(['KAMRAN OUTLET']);
  expect((await ok(w.api('get', '/payroll/employees?limit=1'))).total).toBe(3);
  await fails(w.api('get', '/payroll/employees?closed=maybe'), 400, 'VALIDATION_FAILED');
  await fails(w.api('get', '/payroll/employees?limit=1001'), 400, 'VALIDATION_FAILED');

  const sum = await ok(w.api('get', '/payroll/employees/summary'));
  expect(sum).toMatchObject({ total: 3, closed: 1, draft: 2, confirmed: 1 });
  expect(sum.groups.map((g) => [g.name, g.employees, g.closed])).toEqual([['Factory', 2, 1], ['Outlet', 1, 0], ['Head Office', 0, 0], ['Admin', 0, 0]]);

  // department head-count: 2 approved, 2 working (the closed one does not count) = no vacancy; Outlet has 5 approved and 1 working
  const depts = (await ok(w.api('get', '/payroll/departments'))).data;
  expect(depts.find((d) => d.name === 'Dishwash')).toMatchObject({ fte: 2, employees: 2, vacancy: 0, canDelete: false });
  expect(depts.find((d) => d.name === 'Boat Basin')).toMatchObject({ fte: 5, employees: 1, vacancy: 4, canDelete: false });
  await ok(w.api('post', `/payroll/employees/${a.id}/close`, { leavingDate: '2026-10-01' }));
  expect((await ok(w.api('get', `/payroll/departments/${w.dept.id}`)))).toMatchObject({ employees: 1, vacancy: 1 });
  await ok(w.api('patch', `/payroll/departments/${w.dept.id}`, { fte: 0 }));
  expect((await ok(w.api('get', `/payroll/departments/${w.dept.id}`)))).toMatchObject({ fte: 0, vacancy: 0 }); // never negative

  // masters in use are never deleted (closed employees count too)
  expect((await fails(w.api('delete', `/payroll/departments/${w.dept.id}`), 422, 'IN_USE')).details).toEqual({ employees: 3 });
  expect((await fails(w.api('delete', `/payroll/designations/${w.worker.id}`), 422, 'IN_USE')).details).toEqual({ employees: 3 });
  expect((await fails(w.api('delete', `/payroll/shifts/${w.shift.id}`), 422, 'IN_USE')).details).toEqual({ employees: 3 });
  await fails(w.api('delete', `/payroll/groups/${w.outlet.id}`), 422, 'DEFAULT_GROUP'); // a default group is never deleted, with or without employees
  const own = await ok(w.api('post', '/payroll/groups', { name: 'Warehouse' }), 201);
  const ownDept = await ok(w.api('post', '/payroll/departments', { groupId: own.id, name: 'Loading' }), 201);
  await ok(w.api('post', '/payroll/employees', base(w, { name: 'Loader One', groupId: own.id, departmentId: ownDept.id })), 201);
  expect((await fails(w.api('delete', `/payroll/groups/${own.id}`), 422, 'IN_USE')).details).toEqual({ departments: 1, holidays: 0, employees: 1 });
  expect((await ok(w.api('get', `/payroll/groups/${own.id}`)))).toMatchObject({ employees: 1, canDelete: false });
  expect((await ok(w.api('get', `/payroll/designations/${w.worker.id}`)))).toMatchObject({ employees: 3, canDelete: false });
  await ok(w.api('patch', `/payroll/employees/${c.id}`, { bankId: w.bank.id, accountNo: '9' }));
  expect((await fails(w.api('delete', `/payroll/banks/${w.bank.id}`), 422, 'IN_USE')).details).toEqual({ employees: 1 });
  // a department with employees cannot move to another group
  await fails(w.api('patch', `/payroll/departments/${w.deptOutlet.id}`, { groupId: w.head.id }), 422, 'DEPARTMENT_HAS_EMPLOYEES');
  // moving an employee to another group needs a department of that group
  await fails(w.api('patch', `/payroll/employees/${a.id}`, { groupId: w.head.id }), 422, 'EMPLOYEE_CLOSED');
  await fails(w.api('patch', `/payroll/employees/${c.id}`, { groupId: w.head.id }), 422, 'DEPARTMENT_NOT_IN_GROUP');
  expect(await ok(w.api('patch', `/payroll/employees/${c.id}`, { groupId: w.head.id, departmentId: null }))).toMatchObject({ group: { name: 'Head Office' }, department: null });
});

test('documents: photo and CNIC front / back are saved in the database; real type from the first bytes, 2 MB limit, download with the login', async () => {
  const w = await setup();
  const e = await ok(w.api('post', '/payroll/employees', full(w)), 201);
  const put = (kind, body, type, extra = {}) => request(app).put(`/api/v1/payroll/employees/${e.id}/files/${kind}`).set({ Authorization: `Bearer ${w.token}`, 'Content-Type': type, ...extra }).send(body);
  const get = (kind, t = w.token) => request(app).get(`/api/v1/payroll/employees/${e.id}/files/${kind}`).set({ Authorization: `Bearer ${t}` }).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

  const saved = await ok(put('photo', PNG, 'image/png', { 'X-File-Name': encodeURIComponent('Bilal photo.png') }));
  expect(saved.files.photo).toMatchObject({ fileName: 'Bilal photo.png', mimeType: 'image/png', size: PNG.length });
  expect(saved.files.cnicFront).toBeNull();
  const dl = await get('photo');
  expect(dl.status).toBe(200);
  expect(dl.headers['content-type']).toMatch(/^image\/png/);
  expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''Bilal%20photo.png");
  expect(dl.headers['cache-control']).toContain('private');
  expect(Buffer.compare(dl.body, PNG)).toBe(0); // the same bytes come back

  // CNIC front a PDF, back a JPEG; the type is read from the bytes, not from what the browser says
  await ok(put('cnic-front', PDF, 'application/pdf'));
  const back = await ok(put('cnic-back', JPG, 'application/octet-stream', { 'X-File-Name': '../../etc/passwd' }));
  expect(back.files.cnicBack).toMatchObject({ mimeType: 'image/jpeg', fileName: 'passwd' }); // a path is cut off the name
  const spoof = await ok(put('cnic-back', PNG, 'image/jpeg'));
  expect(spoof.files.cnicBack.mimeType).toBe('image/png');
  expect((await get('cnic-back')).headers['content-type']).toMatch(/^image\/png/);
  expect((await ok(w.api('get', `/payroll/employees/${e.id}`))).files).toMatchObject({ photo: { mimeType: 'image/png' }, cnicFront: { mimeType: 'application/pdf' }, cnicBack: { mimeType: 'image/png' } });
  // the list shows which documents exist but never carries the bytes
  const row = (await ok(w.api('get', '/payroll/employees'))).data[0];
  expect(row.files.photo).toMatchObject({ size: PNG.length });
  expect(JSON.stringify(row)).not.toContain('data');

  // refused
  await fails(put('photo', PDF, 'application/pdf'), 422, 'FILE_TYPE'); // the photo is JPG or PNG
  await fails(put('photo', Buffer.from('just some text, not a picture'), 'image/png'), 422, 'FILE_TYPE');
  await fails(put('photo', Buffer.from('<svg onload=alert(1)></svg>'), 'image/png'), 422, 'FILE_TYPE');
  await fails(put('photo', Buffer.alloc(0), 'image/png'), 422, 'NO_FILE');
  await fails(put('photo', Buffer.from('{"a":1}'), 'application/json'), 422, 'NO_FILE');
  const big = Buffer.concat([JPG, Buffer.alloc(2 * 1024 * 1024)]);
  await fails(put('photo', big, 'image/jpeg'), 413, 'TOO_LARGE');
  await fails(put('passport', PNG, 'image/png'), 400, 'VALIDATION_FAILED');
  // the old photo is still there after the refused ones
  expect(Buffer.compare((await get('photo')).body, PNG)).toBe(0);
  // exactly 2 MB is fine
  await ok(put('photo', Buffer.concat([JPG, Buffer.alloc(2 * 1024 * 1024 - JPG.length)]), 'image/jpeg'));
  expect((await ok(w.api('get', `/payroll/employees/${e.id}`))).files.photo).toMatchObject({ mimeType: 'image/jpeg', size: 2 * 1024 * 1024 });

  // a confirmed card still takes documents (the CNIC may arrive later); delete a document
  await ok(w.api('post', `/payroll/employees/${e.id}/confirm`));
  await ok(put('cnic-front', JPG, 'image/jpeg'));
  expect((await ok(w.api('delete', `/payroll/employees/${e.id}/files/cnic-back`))).files.cnicBack).toBeNull();
  expect((await get('cnic-back')).status).toBe(404);
  await fails(w.api('delete', `/payroll/employees/${e.id}/files/cnic-back`), 404, 'NOT_FOUND');
  expect(await AuditLog.count({ where: { action: 'PAYROLL_FILE_SAVED', entityId: e.id } })).toBeGreaterThanOrEqual(5);
  // the audit log never holds the bytes
  expect(JSON.stringify((await AuditLog.findAll({ where: { action: 'PAYROLL_FILE_SAVED' } })).map((a) => a.after))).not.toContain('PNG');
});

test('access: a payroll VIEW reads (and downloads), only Payroll Employees FULL changes; another company sees nothing; CNIC is unique per company only', async () => {
  const w = await setup();
  const e = await ok(w.api('post', '/payroll/employees', full(w)), 201);
  await ok(request(app).put(`/api/v1/payroll/employees/${e.id}/files/photo`).set({ Authorization: `Bearer ${w.token}`, 'Content-Type': 'image/png' }).send(PNG));

  const person = async (grants) => {
    const u = await makeUser({ userType: 'USER', companyId: w.company.id });
    for (const [code, access] of grants) await UserService.create({ userId: u.id, serviceId: w.s[code].id, access });
    return { call: asUser(u), tok: await token(u) };
  };
  const nobody = await person([]);
  const salaryView = await person([['PAYROLL_SALARY', 'VIEW']]);
  const employeesView = await person([['PAYROLL_EMPLOYEES', 'VIEW']]);
  const employeesFull = await person([['PAYROLL_EMPLOYEES', 'FULL']]);
  await fails(nobody.call('get', '/payroll/employees'), 403, 'FORBIDDEN');
  for (const p of [salaryView, employeesView, employeesFull]) {
    expect((await ok(p.call('get', '/payroll/employees'))).total).toBe(1);
    expect((await ok(p.call('get', `/payroll/employees/${e.id}`))).name).toBe('MUHAMMAD BILAL');
    await ok(p.call('get', '/payroll/employees/summary'));
    expect((await request(app).get(`/api/v1/payroll/employees/${e.id}/files/photo`).set({ Authorization: `Bearer ${p.tok}` })).status).toBe(200);
  }
  for (const p of [salaryView, employeesView]) {
    await fails(p.call('post', '/payroll/employees', base(w, { name: 'X Person' })), 403, 'FORBIDDEN');
    await fails(p.call('patch', `/payroll/employees/${e.id}`, { name: 'Yes' }), 403, 'FORBIDDEN');
    await fails(p.call('post', `/payroll/employees/${e.id}/confirm`), 403, 'FORBIDDEN');
    await fails(p.call('post', `/payroll/employees/${e.id}/close`, { leavingDate: '2026-10-01' }), 403, 'FORBIDDEN');
    await fails(p.call('delete', `/payroll/employees/${e.id}`), 403, 'FORBIDDEN');
    expect((await request(app).put(`/api/v1/payroll/employees/${e.id}/files/photo`).set({ Authorization: `Bearer ${p.tok}`, 'Content-Type': 'image/png' }).send(PNG)).status).toBe(403);
    await fails(p.call('delete', `/payroll/employees/${e.id}/files/photo`), 403, 'FORBIDDEN');
  }
  await ok(employeesFull.call('patch', `/payroll/employees/${e.id}`, { name: 'Muhammad Bilal Khan' }));
  expect((await request(app).get(`/api/v1/payroll/employees/${e.id}`)).status).toBe(401);
  expect((await request(app).get(`/api/v1/payroll/employees/${e.id}/files/photo`)).status).toBe(401);
  expect((await request(app).put(`/api/v1/payroll/employees/${e.id}/files/photo`).set('Content-Type', 'image/png').send(PNG)).status).toBe(401);

  // another company: its own card with the same CNIC is fine, and it cannot see or touch ours
  const other = await setup();
  expect((await ok(other.api('post', '/payroll/employees', full(other)), 201)).code).toBe(1); // the same CNIC and the same ID number
  await fails(other.api('get', `/payroll/employees/${e.id}`), 404, 'NOT_FOUND');
  await fails(other.api('patch', `/payroll/employees/${e.id}`, { name: 'Zed' }), 404, 'NOT_FOUND');
  await fails(other.api('post', `/payroll/employees/${e.id}/confirm`), 404, 'NOT_FOUND');
  await fails(other.api('delete', `/payroll/employees/${e.id}`), 404, 'NOT_FOUND');
  expect((await request(app).get(`/api/v1/payroll/employees/${e.id}/files/photo`).set({ Authorization: `Bearer ${other.token}` })).status).toBe(404);
  expect((await request(app).put(`/api/v1/payroll/employees/${e.id}/files/photo`).set({ Authorization: `Bearer ${other.token}`, 'Content-Type': 'image/png' }).send(PNG)).status).toBe(404);
  await fails(other.api('post', '/payroll/employees', base(other, { departmentId: w.dept.id })), 404, 'NOT_FOUND'); // our department
  expect((await ok(other.api('get', '/payroll/employees'))).total).toBe(1);
});

test('IBAN is PK + 22 characters kept apart from the account number; the tax and EOBI percents are 0 to 100; deductions are exact', async () => {
  const w = await setup();
  const bad = (extra) => fails(w.api('post', '/payroll/employees', base(w, extra)), 400, 'VALIDATION_FAILED');
  for (const iban of ['PK36SCBL000000112345670', 'PK36SCBL00000011234567022', 'AE36SCBL0000001123456702', 'PK3XSCBL0000001123456702', 'PK3600BL0000001123456702']) await bad({ iban });
  for (const p of [-1, '-1', 12.345, '1.234', 'abc']) await bad({ monthlyIncomeTax: p });
  await bad({ eobiNo: 'x'.repeat(31) });
  await bad({ monthlyEobiPercent: 1 }); // the percents are gone
  const e = await ok(w.api('post', '/payroll/employees', base(w, { basicSalary: 33333, accountNo: '0123', iban: ' pk36scbl0000001123456702 ', monthlyIncomeTax: '5000' })), 201);
  expect(e).toMatchObject({ accountNo: '0123', iban: 'PK36SCBL0000001123456702', monthlyDeductions: { incomeTax: '5000.00', eobi: '0.00', total: '5000.00' } });
  expect(await ok(w.api('patch', `/payroll/employees/${e.id}`, { iban: '' }))).toMatchObject({ iban: null, accountNo: '0123' });
  expect(percentCents('1000.00', 0.5)).toBe(500n);
  expect(percentCents('0.50', 50)).toBe(25n);
  expect(percentCents('0.01', 50)).toBe(1n); // half a cent rounds up
  expect(percentCents('100', null)).toBe(0n);
});
