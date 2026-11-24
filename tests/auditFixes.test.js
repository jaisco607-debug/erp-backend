// Fixes of the backend audit (23 Nov 2026): B1 client IP, B2 approvers, B4 duplicate rows, B6 delete in use, B7 customer options.
const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');
const { clientIp } = require('../src/middlewares/clientIp');

beforeEach(clean);
const bearer = async (user) => ({ Authorization: `Bearer ${(await loginAs(user)).accessToken}` });

async function setup() {
  const company = await makeCompany({ name: 'Audit Textile' });
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'PAYROLL_EMPLOYEES']) {
    s[code] = await Service.findOne({ where: { code } });
    if (s[code]) await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  return { company, s, admin, auth: await bearer(admin) };
}

test('B1: the real client address comes from CF-Connecting-IP only when it is trusted; each address has its own bucket', () => {
  const req = (h, ip = '172.22.0.4') => ({ headers: h, ip });
  expect(clientIp(req({ 'cf-connecting-ip': '8.8.8.8' }), true)).toBe('8.8.8.8');
  expect(clientIp(req({ 'cf-connecting-ip': '1.1.1.1' }), true)).toBe('1.1.1.1');
  expect(clientIp(req({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }), true)).toBe('9.9.9.9');
  expect(clientIp(req({ 'cf-connecting-ip': 'not-an-ip' }), true)).toBe('172.22.0.4');
  // not trusted: a caller cannot invent an address
  expect(clientIp(req({ 'cf-connecting-ip': '8.8.8.8' }), false)).toBe('172.22.0.4');
});

test('B7: GET /customers/options answers', async () => {
  const t = await setup();
  const r = await request(app).get('/api/v1/customers/options').set(t.auth);
  expect(r.status).toBe(200);
  expect(r.body.provinces).toContain('Sindh');
});

test('B6: a customer with an invoice or voucher cannot be deleted (lots do not stop it, old lots keep the name); a quality can be deleted', async () => {
  const t = await setup();
  const cu = (await request(app).post('/api/v1/customers').set(t.auth).send({ code: 130, name: 'AZ Textiles' })).body;
  const cu2 = (await request(app).post('/api/v1/customers').set(t.auth).send({ code: 131, name: 'Unused' })).body;
  const ql = (await request(app).post('/api/v1/qualities').set(t.auth).send({ name: 'SHEETING' })).body;
  await request(app).post('/api/v1/grey-lots').set(t.auth).send({ inwardDate: '2026-10-10', customerId: cu.id, qualityId: ql.id, inwardMeters: 100, pieces: 1 });
  // lots do not stop the delete: the customer / quality is hidden and the old lot keeps its name
  expect((await request(app).delete(`/api/v1/customers/${cu.id}`).set(t.auth)).status).toBe(204);
  expect((await request(app).delete(`/api/v1/qualities/${ql.id}`).set(t.auth)).status).toBe(204);
  expect((await request(app).delete(`/api/v1/customers/${cu2.id}`).set(t.auth)).status).toBe(204);
});

test('B4: the same row twice in "send to department" is refused', async () => {
  const t = await setup();
  const id = '6f1c2f4e-3b0a-4c9c-9a53-0a4d0b7e9d11';
  const r = await request(app).post('/api/v1/jobs').set(t.auth).send({ departmentId: t.s.DYEING.id, items: [{ soCardLotId: id, meters: 800 }, { soCardLotId: id, meters: 800 }] });
  expect(r.status).toBe(400);
  expect(JSON.stringify(r.body)).toMatch(/twice/);
});

test('B2: only the client admin sets the payroll approvers', async () => {
  const t = await setup();
  const user = await makeUser({ userType: 'USER', companyId: t.company.id });
  const r = await request(app).put('/api/v1/payroll/approvers').set(await bearer(user)).send({ userIds: [user.id] });
  expect(r.status).toBe(403);
  expect((await request(app).put('/api/v1/payroll/approvers').set(t.auth).send({ userIds: [] })).status).not.toBe(403);
});
