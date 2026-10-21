const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

beforeEach(clean);

// Only Dyeing gives the cloth its colour. A Dyeing employee needs only the Dyeing service (not the SO Card service)
// to see the colour list, add a colour and give a colour to a job.
async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'SINGEING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const token = async (u) => ({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
  const adminAuth = await token(admin);
  const call = (auth) => (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const adm = call(adminAuth);
  // an employee with the given services only
  const employee = async (grants, companyId = company.id) => {
    const u = await makeUser({ userType: 'USER', companyId });
    for (const [serviceId, access] of grants) await UserService.create({ userId: u.id, serviceId, access });
    return call(await token(u));
  };
  return { company, s, admin, adm, employee };
}

async function dyeingJob(adm, s) {
  const cu = (await adm('post', '/customers', { name: 'AZ' })).body;
  const q = (await adm('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await adm('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [100, 120] })).body;
  await adm('post', `/grey-lots/${lot.id}/approve`);
  const card = (await adm('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body;
  const fd = (await adm('get', '/jobs/form-data')).body;
  const job = (await adm('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  await adm('post', `/departments/DYEING/jobs/${job.id}/receive`);
  await adm('post', `/departments/DYEING/jobs/${job.id}/accept`);
  return { job, card };
}

test('a Dyeing-only employee can see the colours, add one and give it to a job', async () => {
  const { s, adm, employee } = await setup();
  const { job } = await dyeingJob(adm, s);
  const red = (await adm('post', '/colours', { name: 'RED' })).body;

  const dyer = await employee([[s.DYEING.id, 'FULL']]);
  // the colour picker works with the Dyeing service only
  const list = await dyer('get', '/colours');
  expect(list.status).toBe(200);
  expect(list.body.data.map((c) => c.name)).toEqual(['RED']);
  expect((await dyer('get', `/colours/${red.id}`)).status).toBe(200);
  const navy = await dyer('post', '/colours', { name: 'Navy' });
  expect(navy.status).toBe(201);
  expect(navy.body).toMatchObject({ name: 'Navy' });
  const set = await dyer('put', `/departments/DYEING/jobs/${job.id}/colour`, { colourId: navy.body.id });
  expect(set.status).toBe(200);
  expect(set.body.colour).toMatchObject({ name: 'Navy' });
  // changing or deleting a colour stays with the SO card desk
  expect((await dyer('patch', `/colours/${navy.body.id}`, { name: 'Navy 2' })).status).toBe(403);
  expect((await dyer('delete', `/colours/${navy.body.id}`)).status).toBe(403);
  // and the SO card section itself is still closed to him
  expect((await dyer('get', '/so-cards')).status).toBe(403);
});

test('a colour given by the client admin shows to the Dyeing employee on the job', async () => {
  const { s, adm, employee } = await setup();
  const { job } = await dyeingJob(adm, s);
  const red = (await adm('post', '/colours', { name: 'RED' })).body;
  expect((await adm('put', `/departments/DYEING/jobs/${job.id}/colour`, { colourId: red.id })).status).toBe(200);

  const dyer = await employee([[s.DYEING.id, 'FULL']]);
  const incoming = (await dyer('get', '/departments/DYEING/incoming')).body.data;
  expect(incoming).toHaveLength(1);
  expect(incoming[0]).toMatchObject({ colour: { id: red.id, name: 'RED' }, colours: ['RED'] });
  expect(incoming[0].items[0].colour).toMatchObject({ id: red.id, name: 'RED' });
  const one = (await dyer('get', `/departments/DYEING/jobs/${job.id}`)).body;
  expect(one.colour).toMatchObject({ name: 'RED' });
  // the colour list of the picker has it too, so the name can be looked up
  expect((await dyer('get', '/colours')).body.data.map((c) => c.id)).toContain(red.id);
  // the send form of Dyeing also brings the colours
  expect((await dyer('get', '/departments/DYEING/send-form')).body.colours.map((c) => c.name)).toEqual(['RED']);
});

test('colour access: Dyeing VIEW reads only, SO Card works as before, other departments are refused, client admin always', async () => {
  const { s, adm, employee } = await setup();
  await adm('post', '/colours', { name: 'RED' });

  const viewer = await employee([[s.DYEING.id, 'VIEW']]);
  expect((await viewer('get', '/colours')).status).toBe(200);
  const refused = await viewer('post', '/colours', { name: 'Navy' });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'You can only view this service' });

  const desk = await employee([[s.SO_CARD.id, 'FULL']]);
  expect((await desk('get', '/colours')).status).toBe(200);
  expect((await desk('post', '/colours', { name: 'Green' })).status).toBe(201);
  expect((await desk('patch', '/colours/' + (await desk('get', '/colours')).body.data[0].id, { name: 'RED 2' })).status).toBe(200);

  const deskView = await employee([[s.SO_CARD.id, 'VIEW']]);
  expect((await deskView('get', '/colours')).status).toBe(200);
  expect((await deskView('post', '/colours', { name: 'Blue' })).status).toBe(403);

  // Singeing (like every other department) only shows the colour; it does not give one
  const singer = await employee([[s.SINGEING.id, 'FULL']]);
  const no = await singer('get', '/colours');
  expect(no.status).toBe(403);
  expect(no.body.error.message).toBe('You do not have this service');
  expect((await singer('post', '/colours', { name: 'Pink' })).status).toBe(403);
  // an employee with no service at all
  expect((await (await employee([]))('get', '/colours')).status).toBe(403);

  // the client admin always passes
  expect((await adm('get', '/colours')).status).toBe(200);
  expect((await adm('post', '/colours', { name: 'Yellow' })).status).toBe(201);
});

test('colours stay inside the company', async () => {
  const { s, adm, employee } = await setup();
  await adm('post', '/colours', { name: 'RED of A' });

  const other = await makeCompany();
  const dyeing = await Service.findOne({ where: { code: 'DYEING' } });
  await CompanyService.create({ companyId: other.id, serviceId: dyeing.id });
  // an employee works under an active client admin of the company
  await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id });
  const dyerB = await employee([[dyeing.id, 'FULL']], other.id);
  const list = await dyerB('get', '/colours');
  expect(list.status).toBe(200);
  expect(list.body.data).toEqual([]);
  expect((await dyerB('post', '/colours', { name: 'RED of B' })).status).toBe(201);
  expect((await adm('get', '/colours')).body.data.map((c) => c.name)).toEqual(['RED of A']);
  expect(s.DYEING).toBeTruthy();
});
