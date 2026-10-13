const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

beforeEach(clean);

const bearer = async (user) => ({ Authorization: `Bearer ${(await loginAs(user)).accessToken}` });

/** Company with grey, SO card, Dyeing, Printing; card 1 from lots A 2000 + B 1500, card 2 from lot C 3000. */
async function setup() {
  const company = await makeCompany({ name: 'Waqas Textile' });
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'PRINTING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = await bearer(admin);
  const cu = (await request(app).post('/api/v1/customers').set(auth).send({ code: 130, name: 'AZ Textiles' })).body;
  const q = (await request(app).post('/api/v1/qualities').set(auth).send({ name: 'SHEETING 20X20' })).body;
  const lot = async (m) => {
    const l = (await request(app).post('/api/v1/grey-lots').set(auth).send({ inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: m, pieces: 10 })).body;
    await request(app).post(`/api/v1/grey-lots/${l.id}/approve`).set(auth);
    return l;
  };
  const [a, b, cl] = [await lot(2000), await lot(1500), await lot(3000)];
  const card1 = (await request(app).post('/api/v1/so-cards').set(auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: a.id, meters: 2000 }, { greyLotId: b.id, meters: 1500 }] })).body;
  const card2 = (await request(app).post('/api/v1/so-cards').set(auth).send({ cardDate: '2026-10-13', lots: [{ greyLotId: cl.id, meters: 3000 }] })).body;
  const black = (await request(app).post('/api/v1/colours').set(auth).send({ name: 'BLACK' })).body;
  const red = (await request(app).post('/api/v1/colours').set(auth).send({ name: 'RED' })).body;
  return { company, s, admin, auth, card1, card2, black, red };
}

test('two SO cards go to dyeing as one job; the other part goes separately; status dropdown; sent on to printing', async () => {
  const t = await setup();
  const fd = (await request(app).get('/api/v1/jobs/form-data').set(t.auth)).body;
  expect(fd.nextJobNo).toBe(1);
  expect(fd.colours.map((c) => c.name)).toEqual(['BLACK', 'RED']);
  expect(fd.rows).toHaveLength(3);
  const row = (cardNo, meters) => fd.rows.find((r) => r.soCard.cardNo === cardNo && r.meters === meters);

  // card 1's 1500 m + card 2's 3000 m -> BLACK, one job
  const j1 = await request(app).post('/api/v1/jobs').set(t.auth).send({
    departmentId: t.s.DYEING.id, colourId: t.black.id, sentThrough: 'Rickshaw',
    items: [{ soCardLotId: row(1, 1500).soCardLotId }, { soCardLotId: row(2, 3000).soCardLotId }],
  });
  expect(j1.status).toBe(201);
  expect(j1.body).toMatchObject({ jobNo: 1, totalMeters: 4500, status: 'PENDING', statusText: 'Pending', sentText: 'Delivered to Dyeing', soNos: [1, 2], colour: { name: 'BLACK' } });
  // card 1's 2000 m -> RED, its own job
  const j2 = (await request(app).post('/api/v1/jobs').set(t.auth).send({ departmentId: t.s.DYEING.id, colourId: t.red.id, items: [{ soCardLotId: row(1, 2000).soCardLotId }] })).body;
  expect(j2.jobNo).toBe(2);
  expect((await request(app).get('/api/v1/jobs/form-data').set(t.auth)).body.rows).toHaveLength(0);
  // the SO card can no longer change its lots
  expect((await request(app).patch(`/api/v1/so-cards/${t.card1.id}`).set(t.auth).send({ lots: [{ greyLotId: t.card1.lots[0].greyLotId, meters: 10 }] })).body.error.code).toBe('CARD_SENT');

  // dyeing's lists
  const inJobs = (await request(app).get(`/api/v1/jobs?departmentId=${t.s.DYEING.id}&side=in`).set(t.auth)).body;
  expect(inJobs.data.map((j) => j.jobNo)).toEqual([2, 1]);
  const soWise = (await request(app).get(`/api/v1/jobs?departmentId=${t.s.DYEING.id}&side=in&view=so`).set(t.auth)).body;
  expect(soWise.data.map((r) => [r.jobNo, r.soCard.cardNo, r.meters, r.colour.name])).toEqual([[2, 1, 2000, 'RED'], [1, 1, 1500, 'BLACK'], [1, 2, 3000, 'BLACK']]);
  const out = (await request(app).get('/api/v1/jobs?side=out').set(t.auth)).body;
  expect(out.data).toHaveLength(2);

  // cloth straight from an SO card cannot be rejected
  expect(j2.canReject).toBe(false);
  expect((await request(app).put(`/api/v1/jobs/${j2.id}/status`).set(t.auth).send({ status: 'REJECTED' })).body.error.code).toBe('REJECT_NOT_ALLOWED');

  // black job: processing -> complete, then printing
  await request(app).put(`/api/v1/jobs/${j1.body.id}/status`).set(t.auth).send({ status: 'PROCESSING' });
  expect((await request(app).put(`/api/v1/jobs/${j1.body.id}/status`).set(t.auth).send({ status: 'REJECTED' })).body.error.code).toBe('REJECT_NOT_ALLOWED');
  await request(app).put(`/api/v1/jobs/${j1.body.id}/status`).set(t.auth).send({ status: 'COMPLETE' });
  const fromDye = (await request(app).get(`/api/v1/jobs/form-data?fromDepartmentId=${t.s.DYEING.id}`).set(t.auth)).body;
  expect(fromDye.departments.map((d) => d.code)).toEqual(['PRINTING']);
  expect(fromDye.rows).toHaveLength(2);
  const j3 = (await request(app).post('/api/v1/jobs').set(t.auth).send({ fromDepartmentId: t.s.DYEING.id, departmentId: t.s.PRINTING.id, items: fromDye.rows.map((r) => ({ jobItemId: r.jobItemId })) })).body;
  expect(j3).toMatchObject({ jobNo: 3, totalMeters: 4500, fromDepartment: { code: 'DYEING' }, department: { code: 'PRINTING' } });
  expect((await request(app).put(`/api/v1/jobs/${j1.body.id}/status`).set(t.auth).send({ status: 'PROCESSING' })).body.error.code).toBe('ALREADY_SENT_ON');

  // printing never got it: reject -> back in dyeing's "send on" rows, dyeing sees it
  expect(j3.canReject).toBe(true);
  const rej = await request(app).put(`/api/v1/jobs/${j3.id}/status`).set(t.auth).send({ status: 'REJECTED' });
  expect(rej.body.sentText).toBe('Rejected by Printing');
  const notice = (await request(app).get(`/api/v1/jobs?departmentId=${t.s.DYEING.id}&side=out&status=REJECTED`).set(t.auth)).body;
  expect(notice.data.map((j) => j.jobNo)).toEqual([3]);
  expect((await request(app).get(`/api/v1/jobs/form-data?fromDepartmentId=${t.s.DYEING.id}`).set(t.auth)).body.rows).toHaveLength(2);

  const hist = (await request(app).get(`/api/v1/jobs/so-card/${t.card2.id}`).set(t.auth)).body;
  expect(hist.jobs.map((j) => [j.jobNo, j.department.code, j.status])).toEqual([[1, 'DYEING', 'COMPLETE'], [3, 'PRINTING', 'REJECTED']]);
});

test('a user with VIEW on dyeing cannot change status; partial meters from the SO desk', async () => {
  const t = await setup();
  const user = await makeUser({ userType: 'USER', companyId: t.company.id, email: 'dye@x.com' });
  await UserService.create({ userId: user.id, serviceId: t.s.DYEING.id, access: 'VIEW' });
  const uAuth = await bearer(user);
  const fd = (await request(app).get('/api/v1/jobs/form-data').set(t.auth)).body;
  const r = fd.rows[0];
  expect((await request(app).post('/api/v1/jobs').set(t.auth).send({ departmentId: t.s.DYEING.id, items: [{ soCardLotId: r.soCardLotId, meters: r.meters + 1 }] })).body.error.code).toBe('NOT_ENOUGH_METERS');
  const j = (await request(app).post('/api/v1/jobs').set(t.auth).send({ departmentId: t.s.DYEING.id, items: [{ soCardLotId: r.soCardLotId, meters: 100 }] })).body;
  expect(j.totalMeters).toBe(100);
  expect((await request(app).get(`/api/v1/jobs?departmentId=${t.s.DYEING.id}`).set(uAuth)).body.data).toHaveLength(1);
  expect((await request(app).put(`/api/v1/jobs/${j.id}/status`).set(uAuth).send({ status: 'COMPLETE' })).status).toBe(403);
  expect((await request(app).post('/api/v1/jobs').set(uAuth).send({ departmentId: t.s.DYEING.id, items: [{ soCardLotId: r.soCardLotId }] })).status).toBe(403);
});

test('department URLs by code: incoming, send-form, send, sent, rejected', async () => {
  const t = await setup();
  const deps = (await request(app).get('/api/v1/departments').set(t.auth)).body;
  expect(deps.map((d) => d.code)).toEqual(expect.arrayContaining(['DYEING', 'PRINTING']));
  const fd = (await request(app).get('/api/v1/jobs/form-data').set(t.auth)).body;
  await request(app).post('/api/v1/jobs').set(t.auth).send({ departmentId: t.s.DYEING.id, colourId: t.black.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] });
  const inc = (await request(app).get('/api/v1/departments/dyeing/incoming?view=so').set(t.auth)).body;
  expect(inc.data).toHaveLength(1);
  await request(app).put(`/api/v1/jobs/${inc.data[0].jobId}/status`).set(t.auth).send({ status: 'COMPLETE' });
  const form = (await request(app).get('/api/v1/departments/DYEING/send-form').set(t.auth)).body;
  expect(form.rows).toHaveLength(1);
  const sent = await request(app).post('/api/v1/departments/DYEING/send').set(t.auth).send({ toDepartmentCode: 'PRINTING', items: [{ jobItemId: form.rows[0].jobItemId }] });
  expect(sent.status).toBe(201);
  expect((await request(app).get('/api/v1/departments/PRINTING/incoming').set(t.auth)).body.data).toHaveLength(1);
  await request(app).put(`/api/v1/jobs/${sent.body.id}/status`).set(t.auth).send({ status: 'REJECTED' });
  expect((await request(app).get('/api/v1/departments/DYEING/rejected').set(t.auth)).body.data).toHaveLength(1);
  expect((await request(app).get('/api/v1/departments/DYEING/sent').set(t.auth)).body.data[0].sentText).toBe('Rejected by Printing');
  expect((await request(app).get('/api/v1/departments/FINISHING/incoming').set(t.auth)).status).toBe(404);
});
