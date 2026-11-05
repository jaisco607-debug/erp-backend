const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

beforeEach(clean);

const PAYROLL = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); expect(r.body.error.code).toBe(code); return r.body.error; };

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex')]);
const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(40, 1), Buffer.from('ffd9', 'hex')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

async function setup() {
  const company = await makeCompany();
  for (const code of PAYROLL) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Dishwash', fte: 2 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: '08A-07P', startTime: '08:00', endTime: '19:00', dutyHours: 11 }), 201);
  const bank = await ok(api('post', '/payroll/banks', { name: 'Meezan Bank', shortName: 'MEZN', bankCode: '0110' }), 201);
  return { company, admin, api, factory, dept, worker, shift, bank, token: (await loginAs(admin)).accessToken };
}
const form = (w, extra = {}) => ({ name: 'Ali Raza', groupId: w.factory.id, joiningDate: '2026-11-01', cnic: '42301-1448872-9', departmentId: w.dept.id, designationId: w.worker.id, shiftId: w.shift.id, basicSalary: 30000, ...extra });
const put = (w, id, kind, body, type) => request(app).put(`/api/v1/payroll/applications/${id}/files/${kind}`).set({ Authorization: `Bearer ${w.token}`, 'Content-Type': type }).send(body);
async function documents(w, id) {
  for (const [k, b, t] of [['photo', JPG, 'image/jpeg'], ['cnic-front', PNG, 'image/png'], ['cnic-back', PDF, 'application/pdf']]) expect((await put(w, id, k, b, t)).status).toBe(200);
}

test('create: the employee form, capitals, EOBI and income tax, a number JA-00001; wrong data is refused; nothing reaches the employee master', async () => {
  const w = await setup();
  const a = await ok(w.api('post', '/payroll/applications', form(w, { monthlyIncomeTax: '1500', eobiNo: ' E-123 ', scssiNo: 'S9', iban: 'pk36 scbl 0000 0011 2345 6702', remarks: 'Walk-in' })), 201);
  expect(a).toMatchObject({ code: 1, label: 'JA-00001', status: 'DRAFT', statusText: 'Draft', name: 'ALI RAZA', basicSalary: '30000.00', monthlyIncomeTax: '1500.00', eobiNo: 'E-123', scssiNo: 'S9', iban: 'PK36SCBL0000001123456702', monthlyDeductions: { incomeTax: '1500.00', eobi: '0.00', total: '1500.00' },
    paymentMethod: 'CASH', remarks: 'Walk-in', canEdit: true, canSubmit: true, canWithdraw: false, department: { name: 'Dishwash' }, files: { photo: null, cnicFront: null, cnicBack: null, form: null } });
  await fails(w.api('post', '/payroll/applications', { name: 'B', groupId: w.factory.id, joiningDate: '2026-11-01' }), 400, 'VALIDATION_FAILED');
  // an application never demands a bank: BANK without a bank is simply cash
  expect(await ok(w.api('post', '/payroll/applications', form(w, { name: 'No Bank', cnic: '4230114488799', paymentMethod: 'BANK' })), 201)).toMatchObject({ paymentMethod: 'CASH' });
  const b = await ok(w.api('post', '/payroll/applications', form(w, { name: 'Sara', cnic: '4230114488730', bankId: w.bank.id, accountNo: '0123456789' })), 201);
  expect(b).toMatchObject({ code: 3, paymentMethod: 'BANK', cnic: '42301-1448873-0' }); // an old draft with bank data keeps it
  const p = await ok(w.api('patch', `/payroll/applications/${a.id}`, { basicSalary: 31000, monthlyIncomeTax: '0', eobiNo: null, iban: '' }));
  expect(p).toMatchObject({ basicSalary: '31000.00', monthlyIncomeTax: '0.00', eobiNo: null, scssiNo: 'S9', iban: null, monthlyDeductions: { incomeTax: '0.00', eobi: '0.00', total: '0.00' } });
  expect(await ok(w.api('get', '/payroll/applications/summary'))).toEqual({ total: 3, draft: 3, inReview: 0, approved: 0, rejected: 0 });
  expect((await ok(w.api('get', '/payroll/applications?search=sara'))).total).toBe(1);
  expect((await ok(w.api('get', '/payroll/employees'))).total).toBe(0);
});

test('access: reading needs any payroll service, changing needs PAYROLL_APPLICATIONS with FULL; another company cannot see it', async () => {
  const w = await setup();
  const a = await ok(w.api('post', '/payroll/applications', form(w)), 201);
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  const sv = await Service.findOne({ where: { code: 'PAYROLL_REPORTS' } });
  await UserService.create({ userId: viewer.id, serviceId: sv.id, access: 'VIEW' });
  const v = asUser(viewer);
  await ok(v('get', `/payroll/applications/${a.id}`));
  const denied = await v('post', '/payroll/applications', form(w));
  expect(denied.status).toBe(403);
  const other = await setup();
  await fails(other.api('get', `/payroll/applications/${a.id}`), 404, 'NOT_FOUND');
});

test('documents: photo, CNIC front and back and the scanned form are saved, read back and replaced; wrong files are refused', async () => {
  const w = await setup();
  const a = await ok(w.api('post', '/payroll/applications', form(w)), 201);
  const r = await put(w, a.id, 'photo', JPG, 'image/jpeg');
  expect(r.body.files.photo).toMatchObject({ mimeType: 'image/jpeg', size: JPG.length });
  expect((await put(w, a.id, 'photo', PDF, 'application/pdf')).body.error.code).toBe('FILE_TYPE');
  expect((await put(w, a.id, 'cnic-front', Buffer.from('hello'), 'application/octet-stream')).body.error.code).toBe('FILE_TYPE');
  expect((await put(w, a.id, 'form', PDF, 'application/pdf')).body.files.form.mimeType).toBe('application/pdf');
  const dl = await request(app).get(`/api/v1/payroll/applications/${a.id}/files/photo`).set({ Authorization: `Bearer ${w.token}` }).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  expect(dl.status).toBe(200);
  expect(dl.body.equals(JPG)).toBe(true);
  expect((await request(app).get(`/api/v1/payroll/applications/${a.id}/files/photo`)).status).toBe(401);
  const gone = await ok(w.api('delete', `/payroll/applications/${a.id}/files/photo`));
  expect(gone.files.photo).toBeNull();
  await fails(w.api('delete', `/payroll/applications/${a.id}/files/photo`), 404, 'NOT_FOUND');
});

test('submit: needs the missing details and documents, then it is In review and locked; withdraw gives it back; only a draft is deleted', async () => {
  const w = await setup();
  const a = await ok(w.api('post', '/payroll/applications', { name: 'Ali Raza', groupId: w.factory.id, joiningDate: '2026-11-01' }), 201);
  const e = await fails(w.api('post', `/payroll/applications/${a.id}/submit`), 422, 'APPLICATION_INCOMPLETE');
  expect(e.details.missing).toEqual(expect.arrayContaining(['cnic', 'departmentId', 'designationId', 'shiftId', 'basicSalary', 'file:photo', 'file:cnic-front', 'file:cnic-back']));
  await ok(w.api('patch', `/payroll/applications/${a.id}`, form(w)));
  await documents(w, a.id);
  const s = await ok(w.api('post', `/payroll/applications/${a.id}/submit`));
  expect(s).toMatchObject({ status: 'IN_REVIEW', statusText: 'In review', canEdit: false, canWithdraw: true, canDelete: false });
  expect(s.submittedAt).toBeTruthy();
  await fails(w.api('patch', `/payroll/applications/${a.id}`, { basicSalary: 1 }), 422, 'APPLICATION_IN_REVIEW');
  await fails(w.api('delete', `/payroll/applications/${a.id}`), 422, 'APPLICATION_IN_REVIEW');
  expect((await put(w, a.id, 'form', PDF, 'application/pdf')).body.error.code).toBe('APPLICATION_IN_REVIEW');
  await fails(w.api('post', `/payroll/applications/${a.id}/submit`), 422, 'ALREADY_IN_REVIEW');
  expect(await ok(w.api('get', '/payroll/applications/summary'))).toEqual({ total: 1, draft: 0, inReview: 1, approved: 0, rejected: 0 });
  expect(await ok(w.api('post', `/payroll/applications/${a.id}/withdraw`))).toMatchObject({ status: 'DRAFT', submittedAt: null, canEdit: true });
  await ok(w.api('delete', `/payroll/applications/${a.id}`), 204);
  await fails(w.api('get', `/payroll/applications/${a.id}`), 404, 'NOT_FOUND');
});

test('submit is refused for a CNIC we already have, a CNIC already in review, and a department with no vacancy (fte 2)', async () => {
  const w = await setup();
  await ok(w.api('post', '/payroll/employees', { name: 'Old Hand', groupId: w.factory.id, joiningDate: '2020-01-01', cnic: '42301-1448872-9', departmentId: w.dept.id }), 201);
  const a = await ok(w.api('post', '/payroll/applications', form(w)), 201);
  await documents(w, a.id);
  await fails(w.api('post', `/payroll/applications/${a.id}/submit`), 422, 'CNIC_TAKEN');
  // 1 of 2 seats is taken by the employee: one more application fits, the next one does not
  const b = await ok(w.api('post', '/payroll/applications', form(w, { name: 'Bilal', cnic: '42301-1111111-1' })), 201);
  await documents(w, b.id);
  await ok(w.api('post', `/payroll/applications/${b.id}/submit`));
  await ok(w.api('patch', `/payroll/applications/${a.id}`, { cnic: '42301-2222222-2' }));
  const full = await fails(w.api('post', `/payroll/applications/${a.id}/submit`), 422, 'NO_VACANCY');
  expect(full.details).toMatchObject({ fte: 2, taken: 2 });
  // the same CNIC as the one in review
  const c = await ok(w.api('post', '/payroll/applications', form(w, { name: 'Bilal Two', cnic: '42301-1111111-1' })), 201);
  await documents(w, c.id);
  await fails(w.api('post', `/payroll/applications/${c.id}/submit`), 422, 'CNIC_IN_REVIEW');
});

test('month filter: from / to on the application date (Pakistan time), with the other filters; the summary is not filtered; wrong dates are refused', async () => {
  const { sequelize } = require('../src/models');
  const w = await setup();
  const mk = async (name, cnic) => ok(w.api('post', '/payroll/applications', form(w, { name, cnic })), 201);
  const nov = await mk('Nov Person', '4230114488701');
  const dec1 = await mk('Dec First', '4230114488702');
  const dec2 = await mk('Dec Last', '4230114488703');
  const stamp = (id, ts) => sequelize.query('UPDATE payroll_joining_applications SET "createdAt" = :ts WHERE id = :id', { replacements: { id, ts } });
  await stamp(nov.id, '2026-11-30T18:00:00Z'); // 30 Nov 23:00 in Pakistan
  await stamp(dec1.id, '2026-11-30T19:00:00Z'); // 1 Dec 00:00 in Pakistan: December
  await stamp(dec2.id, '2026-12-31T18:59:00Z'); // 31 Dec 23:59 in Pakistan: still December
  const names = async (q) => (await ok(w.api('get', `/payroll/applications?${q}`))).data.map((a) => a.name).sort();
  const dec = await ok(w.api('get', '/payroll/applications?from=2026-12-01&to=2026-12-31&page=1&limit=15'));
  expect([dec.total, dec.data.map((a) => a.name).sort()]).toEqual([2, ['DEC FIRST', 'DEC LAST']]);
  expect(dec.limit).toBe(15);
  expect(await names('from=2026-12-01')).toEqual(['DEC FIRST', 'DEC LAST']); // only a lower limit
  expect(await names('to=2026-11-30')).toEqual(['NOV PERSON']); // only an upper limit
  expect(await names('from=2026-12-31&to=2026-12-31')).toEqual(['DEC LAST']); // one day
  expect((await ok(w.api('get', '/payroll/applications?limit=10'))).limit).toBe(10);
  expect(await names('from=2026-12-01&to=2026-12-31&search=last')).toEqual(['DEC LAST']);
  expect(await names('from=2026-12-01&to=2026-12-31&status=APPROVED')).toEqual([]);
  expect(await names('from=2026-12-01&to=2026-12-31&status=DRAFT')).toEqual(['DEC FIRST', 'DEC LAST']);
  // the summary counts everything, whatever the month
  expect((await ok(w.api('get', '/payroll/applications/summary'))).draft).toBe(3);
  for (const q of ['from=2026-12-31&to=2026-12-01', 'from=2026-13-01', 'to=abc', 'from=2026-02-30']) {
    const r = await w.api('get', `/payroll/applications?${q}`);
    expect([r.status, r.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
  }
});
