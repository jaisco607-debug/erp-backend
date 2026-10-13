const { app, request, sequelize, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, AuditLog } = require('../src/models');

beforeEach(clean);
afterAll(() => sequelize.close());

const bearer = async (user) => ({ Authorization: `Bearer ${(await loginAs(user)).accessToken}` });

/** A company with Grey Store, its client admin, and one customer + quality. */
async function setup() {
  const company = await makeCompany({ name: 'Waqas Textile' });
  const grey = await Service.findOne({ where: { code: 'GREY_STORE' } });
  await CompanyService.create({ companyId: company.id, serviceId: grey.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = await bearer(admin);
  const customer = (await request(app).post('/api/v1/customers').set(auth).send({ code: 130, name: 'AZ Textiles' })).body;
  const quality = (await request(app).post('/api/v1/qualities').set(auth).send({ name: 'CANVAS 10X7/72X30=65.50"' })).body;
  return { company, grey, admin, auth, customer, quality };
}

const lotBody = (s, extra = {}) => ({
  dcNo: '5010', inwardDate: '2026-10-08', customerId: s.customer.id, qualityId: s.quality.id, inwardMeters: 11305, pieces: 62, ...extra,
});

test('each arrival gets the next lot no and type no; a split delivery is three lots', async () => {
  const s = await setup();
  const parts = [2000, 1500, 1500];
  const lots = [];
  for (const [i, m] of parts.entries()) {
    const res = await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s, { inwardMeters: m, pieces: 10, inwardDate: `2026-10-0${i + 1}`, partyRef: 'AZ-PO-77' }));
    expect(res.status).toBe(201);
    lots.push(res.body);
  }
  expect(lots.map((l) => l.lotNo)).toEqual([1, 2, 3]);
  expect(lots.map((l) => l.typeNo)).toEqual(['0001', '0002', '0003']);
  expect(lots[0]).toMatchObject({
    customer: { code: 130, name: 'AZ Textiles' }, quality: { name: 'CANVAS 10X7/72X30=65.50"' },
    inwardMeters: 2000, outwardMeters: 0, balanceMeters: 2000, isApproved: false, isActive: true, isReprocess: false,
  });

  const byRef = await request(app).get('/api/v1/grey-lots?search=AZ-PO-77').set(s.auth);
  expect(byRef.body.total).toBe(3);
  expect(byRef.body.data.map((l) => l.lotNo)).toEqual([3, 2, 1]);
});

test('numbering can continue from the old system but never go back', async () => {
  const s = await setup();
  const set = await request(app).put('/api/v1/grey-lots/numbering').set(s.auth).send({ nextLotNo: 2437, nextTypeNo: 613 });
  expect(set.body).toEqual({ nextLotNo: 2437, nextTypeNo: '0613' });
  const lot = (await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body;
  expect([lot.lotNo, lot.typeNo]).toEqual([2437, '0613']);
  expect((await request(app).get('/api/v1/grey-lots/numbering').set(s.auth)).body).toEqual({ nextLotNo: 2438, nextTypeNo: '0614' });
  const back = await request(app).put('/api/v1/grey-lots/numbering').set(s.auth).send({ nextLotNo: 2000 });
  expect(back.status).toBe(422);
  expect(back.body.error.code).toBe('NUMBER_USED');
});

test('re-process tag, active toggle, approve locks editing, only client admin un-approves', async () => {
  const s = await setup();
  const first = (await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body;
  const back = await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s, { inwardMeters: 500, pieces: 4, reprocessOfLotId: first.id }));
  expect(back.body).toMatchObject({ isReprocess: true, reprocessOf: { lotNo: first.lotNo } });
  expect((await request(app).get('/api/v1/grey-lots?isReprocess=true').set(s.auth)).body.total).toBe(1);

  const off = await request(app).put(`/api/v1/grey-lots/${first.id}/active`).set(s.auth).send({ isActive: false });
  expect(off.body.isActive).toBe(false);
  expect((await request(app).post(`/api/v1/grey-lots/${first.id}/approve`).set(s.auth)).status).toBe(422);
  await request(app).put(`/api/v1/grey-lots/${first.id}/active`).set(s.auth).send({ isActive: true });

  const ok = await request(app).post(`/api/v1/grey-lots/${first.id}/approve`).set(s.auth);
  expect(ok.body.isApproved).toBe(true);
  const edit = await request(app).patch(`/api/v1/grey-lots/${first.id}`).set(s.auth).send({ pieces: 70 });
  expect(edit.status).toBe(422);
  expect(edit.body.error.code).toBe('LOT_APPROVED');

  // a user with FULL Grey Store can approve, but not take it back
  const user = await makeUser({ userType: 'USER', companyId: s.company.id });
  await UserService.create({ userId: user.id, serviceId: s.grey.id, access: 'FULL' });
  const uauth = await bearer(user);
  expect((await request(app).post(`/api/v1/grey-lots/${first.id}/unapprove`).set(uauth)).status).toBe(403);
  const un = await request(app).post(`/api/v1/grey-lots/${first.id}/unapprove`).set(s.auth);
  expect(un.body.isApproved).toBe(false);
  const edited = await request(app).patch(`/api/v1/grey-lots/${first.id}`).set(s.auth).send({ pieces: 70, dcNo: '' });
  expect(edited.body).toMatchObject({ pieces: 70, dcNo: null });

  const actions = (await AuditLog.findAll({ where: { entityId: first.id } })).map((a) => a.action);
  expect(actions).toEqual(expect.arrayContaining(['GREY_LOT_CREATED', 'GREY_LOT_ACTIVE_CHANGED', 'GREY_LOT_APPROVED', 'GREY_LOT_UNAPPROVED', 'GREY_LOT_UPDATED']));
});

test('access: VIEW users only read, users without the service and other companies see nothing', async () => {
  const s = await setup();
  const lot = (await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body;

  const viewer = await makeUser({ userType: 'USER', companyId: s.company.id });
  await UserService.create({ userId: viewer.id, serviceId: s.grey.id, access: 'VIEW' });
  const vauth = await bearer(viewer);
  expect((await request(app).get('/api/v1/grey-lots').set(vauth)).body.total).toBe(1);
  expect((await request(app).post('/api/v1/grey-lots').set(vauth).send(lotBody(s))).status).toBe(403);

  const nobody = await makeUser({ userType: 'USER', companyId: s.company.id });
  expect((await request(app).get('/api/v1/grey-lots').set(await bearer(nobody))).status).toBe(403);

  // another company with Grey Store: cannot see or use this company's lot, customer or quality
  const other = await makeCompany({ name: 'Other' });
  await CompanyService.create({ companyId: other.id, serviceId: s.grey.id });
  const oauth = await bearer(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await request(app).get('/api/v1/grey-lots').set(oauth)).body.total).toBe(0);
  expect((await request(app).get(`/api/v1/grey-lots/${lot.id}`).set(oauth)).status).toBe(404);
  const steal = await request(app).post('/api/v1/grey-lots').set(oauth).send(lotBody(s));
  expect(steal.body.error.code).toBe('UNKNOWN_CUSTOMER');

  // super admins do not see company data
  expect((await request(app).get('/api/v1/grey-lots').set(await bearer(await makeUser()))).status).toBe(403);
});

test('masters: customer codes run on, names are unique per company, bad lot data is refused', async () => {
  const s = await setup();
  const next = await request(app).post('/api/v1/customers').set(s.auth).send({ name: 'Hamid Enterprises' });
  expect(next.body.code).toBe(131);
  expect((await request(app).post('/api/v1/customers').set(s.auth).send({ name: 'az textiles' })).body.error.code).toBe('NAME_TAKEN');
  expect((await request(app).post('/api/v1/customers').set(s.auth).send({ code: 130, name: 'New' })).body.error.code).toBe('CODE_TAKEN');
  expect((await request(app).get('/api/v1/customers?search=130').set(s.auth)).body.data.map((c) => c.name)).toEqual(['AZ Textiles']);

  const bad = await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s, { inwardMeters: -5, pieces: 1.5 }));
  expect(bad.status).toBe(400);
  await request(app).patch(`/api/v1/qualities/${s.quality.id}`).set(s.auth).send({ isActive: false });
  expect((await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body.error.code).toBe('QUALITY_INACTIVE');
});

test('customer delete hides it but keeps it for old lots; its name can be used again', async () => {
  const s = await setup();
  const lot = (await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body;
  expect((await request(app).delete(`/api/v1/customers/${s.customer.id}`).set(s.auth)).status).toBe(204);

  expect((await request(app).get('/api/v1/customers').set(s.auth)).body.total).toBe(0);
  expect((await request(app).get(`/api/v1/customers/${s.customer.id}`).set(s.auth)).status).toBe(404);
  expect((await request(app).get(`/api/v1/grey-lots/${lot.id}`).set(s.auth)).body.customer).toMatchObject({ code: 130, name: 'AZ Textiles' });
  expect((await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body.error.code).toBe('UNKNOWN_CUSTOMER');

  const again = await request(app).post('/api/v1/customers').set(s.auth).send({ name: 'AZ Textiles' });
  expect(again.status).toBe(201);
  expect(again.body.code).toBe(131);
  expect((await AuditLog.findOne({ where: { action: 'CUSTOMER_DELETED' } })).entityId).toBe(s.customer.id);
});

test('quality delete hides it but old lots keep showing it', async () => {
  const s = await setup();
  const lot = (await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body;
  expect((await request(app).delete(`/api/v1/qualities/${s.quality.id}`).set(s.auth)).status).toBe(204);
  expect((await request(app).get('/api/v1/qualities').set(s.auth)).body.total).toBe(0);
  expect((await request(app).get(`/api/v1/grey-lots/${lot.id}`).set(s.auth)).body.quality.name).toBe('CANVAS 10X7/72X30=65.50"');
  expect((await request(app).post('/api/v1/qualities').set(s.auth).send({ name: 'CANVAS 10X7/72X30=65.50"' })).status).toBe(201);
});

test('lot delete hides it, keeps its number used; approved lots cannot be deleted', async () => {
  const s = await setup();
  const a = (await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body;
  const b = (await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body;
  expect((await request(app).delete(`/api/v1/grey-lots/${b.id}`).set(s.auth)).status).toBe(204);
  expect((await request(app).get('/api/v1/grey-lots').set(s.auth)).body.total).toBe(1);
  expect((await request(app).get(`/api/v1/grey-lots/${b.id}`).set(s.auth)).status).toBe(404);
  const c = (await request(app).post('/api/v1/grey-lots').set(s.auth).send(lotBody(s))).body;
  expect(c.lotNo).toBe(3);

  await request(app).post(`/api/v1/grey-lots/${a.id}/approve`).set(s.auth);
  const no = await request(app).delete(`/api/v1/grey-lots/${a.id}`).set(s.auth);
  expect(no.body.error.code).toBe('LOT_APPROVED');
  expect((await AuditLog.findOne({ where: { action: 'GREY_LOT_DELETED' } })).entityId).toBe(b.id);
});
