const { app, request, sequelize, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, AuditLog } = require('../src/models');

beforeEach(clean);
afterAll(() => sequelize.close());

const bearer = async (user) => ({ Authorization: `Bearer ${(await loginAs(user)).accessToken}` });
const svc = async (code) => Service.findOne({ where: { code } });

/** A company with Grey Store, SO Card, Singeing and Dyeing; one party with two approved lots (4000 m, 3000 m). */
async function setup() {
  const company = await makeCompany({ name: 'Waqas Textile' });
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'SINGEING', 'DYEING']) {
    s[code] = await svc(code);
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = await bearer(admin);
  const customer = (await request(app).post('/api/v1/customers').set(auth).send({ code: 130, name: 'AZ Textiles' })).body;
  const quality = (await request(app).post('/api/v1/qualities').set(auth).send({ name: '20X20/60X56=66' })).body;
  const lot = async (meters, extra = {}) => {
    const l = (await request(app).post('/api/v1/grey-lots').set(auth).send({
      inwardDate: '2026-10-10', customerId: extra.customerId || customer.id, qualityId: quality.id, inwardMeters: meters, pieces: 40, ...extra,
    })).body;
    await request(app).post(`/api/v1/grey-lots/${l.id}/approve`).set(auth);
    return l;
  };
  const a = await lot(4000);
  const b = await lot(3000);
  return { company, s, admin, auth, customer, quality, lot, a, b };
}

const balance = async (t, id) => (await request(app).get(`/api/v1/grey-lots/${id}`).set(t.auth)).body.balanceMeters;

test('one card from two lots takes meters out of grey; more than the balance is refused', async () => {
  const t = await setup();
  const res = await request(app).post('/api/v1/so-cards').set(t.auth).send({
    cardDate: '2026-10-13',
    lots: [{ greyLotId: t.a.id, meters: 2000, pieces: 20 }, { greyLotId: t.b.id, meters: 1500, pieces: 15 }],
  });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({
    cardNo: 1, totalMeters: 3500, totalPieces: 35, status: 'NEW', currentDepartment: null, isReprocess: false,
    customer: { code: 130, name: 'AZ Textiles' },
  });
  expect(res.body.lots.map((l) => [l.lotNo, l.meters])).toEqual([[t.a.lotNo, 2000], [t.b.lotNo, 1500]]);
  expect(await balance(t, t.a.id)).toBe(2000);
  expect(await balance(t, t.b.id)).toBe(1500);

  // a single-lot card for what is left of lot A
  const single = await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: t.a.id, meters: 2000 }] });
  expect(single.body.cardNo).toBe(2);
  expect(await balance(t, t.a.id)).toBe(0);

  const over = await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: t.b.id, meters: 1500.01 }] });
  expect(over.status).toBe(422);
  expect(over.body.error).toMatchObject({ code: 'NOT_ENOUGH_METERS', details: { lots: [{ lotNo: t.b.lotNo, balanceMeters: 1500 }] } });

  const avail = await request(app).get('/api/v1/so-cards/available-lots').set(t.auth);
  expect(avail.body.data.map((l) => [l.lotNo, l.balanceMeters])).toEqual([[t.b.lotNo, 1500]]);

  // the used lot cannot be deleted or shrunk below what went out
  await request(app).post(`/api/v1/grey-lots/${t.b.id}/unapprove`).set(t.auth);
  expect((await request(app).delete(`/api/v1/grey-lots/${t.b.id}`).set(t.auth)).body.error.code).toBe('LOT_IN_USE');
  expect((await request(app).patch(`/api/v1/grey-lots/${t.b.id}`).set(t.auth).send({ inwardMeters: 1000 })).body.error.code).toBe('BELOW_OUTWARD');
});

test('rules: same party only, approved lots only, re-process lots mark the card', async () => {
  const t = await setup();
  const other = (await request(app).post('/api/v1/customers').set(t.auth).send({ name: 'Hamid Enterprises' })).body;
  const c = await t.lot(1000, { customerId: other.id });
  const mixed = await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: t.a.id, meters: 10 }, { greyLotId: c.id, meters: 10 }] });
  expect(mixed.body.error.code).toBe('MIXED_CUSTOMERS');

  const raw = (await request(app).post('/api/v1/grey-lots').set(t.auth).send({ inwardDate: '2026-10-10', customerId: t.customer.id, qualityId: t.quality.id, inwardMeters: 500, pieces: 5 })).body;
  expect((await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: raw.id, meters: 10 }] })).body.error.code).toBe('LOT_NOT_APPROVED');

  const re = await t.lot(800, { reprocessOfLotId: t.a.id });
  const card = await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: re.id, meters: 800 }] });
  expect(card.body).toMatchObject({ isReprocess: true, lots: [{ lotNo: re.lotNo, isReprocess: true }] });
});

test('send to a department through someone, the department accepts, status follows', async () => {
  const t = await setup();
  const card = (await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: t.a.id, meters: 2000 }] })).body;

  const depts = (await request(app).get('/api/v1/so-cards/departments').set(t.auth)).body.data.map((d) => d.code);
  expect(depts.sort()).toEqual(['DYEING', 'SINGEING']);

  const printing = await svc('PRINTING');
  expect((await request(app).post(`/api/v1/so-cards/${card.id}/send`).set(t.auth).send({ departmentId: printing.id })).body.error.code).toBe('UNKNOWN_DEPARTMENT');

  const sent = await request(app).post(`/api/v1/so-cards/${card.id}/send`).set(t.auth).send({ departmentId: t.s.SINGEING.id, sentThrough: 'Akram (loader)' });
  expect(sent.body).toMatchObject({
    status: 'SENT', currentDepartment: { code: 'SINGEING' },
    lastMove: { from: null, to: { code: 'SINGEING' }, sentThrough: 'Akram (loader)', acceptedAt: null },
  });
  expect((await request(app).delete(`/api/v1/so-cards/${card.id}`).set(t.auth)).body.error.code).toBe('CARD_SENT');

  // a Dyeing user cannot accept a Singeing card; a Singeing user can
  const dyer = await makeUser({ userType: 'USER', companyId: t.company.id });
  await UserService.create({ userId: dyer.id, serviceId: t.s.DYEING.id, access: 'FULL' });
  expect((await request(app).post(`/api/v1/so-cards/${card.id}/accept`).set(await bearer(dyer))).status).toBe(403);
  const singer = await makeUser({ userType: 'USER', companyId: t.company.id });
  await UserService.create({ userId: singer.id, serviceId: t.s.SINGEING.id, access: 'FULL' });
  const sauth = await bearer(singer);
  expect((await request(app).get(`/api/v1/so-cards/incoming?departmentId=${t.s.SINGEING.id}`).set(sauth)).body.data.map((c) => c.cardNo)).toEqual([card.cardNo]);
  const acc = await request(app).post(`/api/v1/so-cards/${card.id}/accept`).set(sauth);
  expect(acc.body).toMatchObject({ status: 'IN_DEPARTMENT', currentDepartment: { code: 'SINGEING' } });
  expect(acc.body.lastMove.acceptedBy.id).toBe(singer.id);

  // then on to Dyeing
  const next = await request(app).post(`/api/v1/so-cards/${card.id}/send`).set(t.auth).send({ departmentId: t.s.DYEING.id, sentThrough: 'Truck LES-1234' });
  expect(next.body.lastMove).toMatchObject({ from: { code: 'SINGEING' }, to: { code: 'DYEING' } });
  expect(next.body.moves).toHaveLength(2);
  expect((await request(app).get(`/api/v1/so-cards?departmentId=${t.s.DYEING.id}&status=SENT`).set(t.auth)).body.total).toBe(1);

  const actions = (await AuditLog.findAll({ where: { entityId: card.id } })).map((a) => a.action);
  expect(actions).toEqual(expect.arrayContaining(['SO_CARD_CREATED', 'SO_CARD_SENT', 'SO_CARD_ACCEPTED']));
});

test('cancelling an unsent card gives the meters back; search by card or lot no', async () => {
  const t = await setup();
  const card = (await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: t.a.id, meters: 1200 }] })).body;
  expect((await request(app).get(`/api/v1/so-cards?search=${t.a.lotNo}`).set(t.auth)).body.total).toBe(1);
  expect((await request(app).delete(`/api/v1/so-cards/${card.id}`).set(t.auth)).status).toBe(204);
  expect(await balance(t, t.a.id)).toBe(4000);
  expect((await request(app).get('/api/v1/so-cards').set(t.auth)).body.total).toBe(0);
  const again = (await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: t.a.id, meters: 100 }] })).body;
  expect(again.cardNo).toBe(2);
});

test('one screen: form data, create + send together, ID#, quality, Conf. toggle locks the card', async () => {
  const t = await setup();
  const fd = (await request(app).get('/api/v1/so-cards/form-data').set(t.auth)).body;
  expect(fd).toMatchObject({ nextCardNo: 1, nextIdNo: 1 });
  expect(fd.customers).toHaveLength(1);
  expect(fd.customers[0]).toMatchObject({ code: 130, balanceMeters: 7000 });
  expect(fd.customers[0].lots).toHaveLength(2);
  const dyeing = fd.departments.find((d) => d.code === 'DYEING');

  const num = await request(app).put('/api/v1/so-cards/numbering').set(t.auth).send({ nextCardNo: 4870, nextIdNo: 910 });
  expect(num.body).toEqual({ nextCardNo: 4870, nextIdNo: 910 });

  const res = await request(app).post('/api/v1/so-cards').set(t.auth).send({
    cardDate: '2026-10-13', description: 'BLACK SMELL', lots: [{ greyLotId: t.a.id, meters: 1000 }],
    departmentId: dyeing.id, sentThrough: 'Rickshaw',
  });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ cardNo: 4870, idNo: 910, description: 'BLACK SMELL', status: 'SENT', isConfirmed: false, quality: { name: '20X20/60X56=66' } });

  const conf = await request(app).put(`/api/v1/so-cards/${res.body.id}/confirm`).set(t.auth).send({ isConfirmed: true });
  expect(conf.body.isConfirmed).toBe(true);
  expect((await request(app).patch(`/api/v1/so-cards/${res.body.id}`).set(t.auth).send({ remarks: 'x' })).body.error.code).toBe('CARD_CONFIRMED');
  const list = await request(app).get('/api/v1/so-cards?isConfirmed=true').set(t.auth);
  expect(list.body.data.map((c) => c.idNo)).toEqual([910]);
  expect((await request(app).put('/api/v1/so-cards/numbering').set(t.auth).send({ nextIdNo: 900 })).body.error.code).toBe('NUMBER_USED');
});

test('edit meters/lots of a NEW card: old meters go back, new are taken; not after sending', async () => {
  const t = await setup();
  const card = (await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: t.a.id, meters: 1000 }] })).body;
  const ed = await request(app).patch(`/api/v1/so-cards/${card.id}`).set(t.auth).send({ lots: [{ greyLotId: t.a.id, meters: 4000 }, { greyLotId: t.b.id, meters: 500 }] });
  expect(ed.status).toBe(200);
  expect(ed.body.totalMeters).toBe(4500);
  expect(await balance(t, t.a.id)).toBe(0);
  expect(await balance(t, t.b.id)).toBe(2500);
  const over = await request(app).patch(`/api/v1/so-cards/${card.id}`).set(t.auth).send({ lots: [{ greyLotId: t.b.id, meters: 3001 }] });
  expect(over.body.error.code).toBe('NOT_ENOUGH_METERS');
  const down = await request(app).patch(`/api/v1/so-cards/${card.id}`).set(t.auth).send({ lots: [{ greyLotId: t.b.id, meters: 3000 }] });
  expect(down.body.totalMeters).toBe(3000);
  expect(await balance(t, t.a.id)).toBe(4000);
  const dept = (await request(app).get('/api/v1/so-cards/form-data').set(t.auth)).body.departments[0];
  await request(app).post(`/api/v1/so-cards/${card.id}/send`).set(t.auth).send({ departmentId: dept.id });
  expect((await request(app).patch(`/api/v1/so-cards/${card.id}`).set(t.auth).send({ lots: [{ greyLotId: t.b.id, meters: 10 }] })).body.error.code).toBe('CARD_SENT');
});

test('pick the department later from edit; the view says where it went', async () => {
  const t = await setup();
  const card = (await request(app).post('/api/v1/so-cards').set(t.auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: t.a.id, meters: 100 }] })).body;
  expect(card.deliveryText).toBe('Not sent to any department yet');
  const dyeing = (await request(app).get('/api/v1/so-cards/form-data').set(t.auth)).body.departments.find((d) => d.code === 'DYEING');
  const ed = await request(app).patch(`/api/v1/so-cards/${card.id}`).set(t.auth).send({ departmentId: dyeing.id, sentThrough: 'Rickshaw' });
  expect(ed.body).toMatchObject({ status: 'SENT', deliveryText: 'Sent to Dyeing (waiting for accept)' });
  const acc = await request(app).post(`/api/v1/so-cards/${card.id}/accept`).set(t.auth);
  expect(acc.body.deliveryText).toBe('Delivered to Dyeing');
});
