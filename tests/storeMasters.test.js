const { request, app, clean, makeUser, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

let api;
beforeEach(async () => {
  await clean();
  const admin = await makeUser({ userType: 'CLIENT_ADMIN' });
  const svc = await Service.findOne({ where: { code: 'CHEMICAL_STORE' } });
  await CompanyService.create({ companyId: admin.companyId, serviceId: svc.id });
  const { accessToken } = await loginAs(admin);
  api = (m, u, b) => request(app)[m](`/api/v1${u}`).set('Authorization', `Bearer ${accessToken}`).send(b);
});

test('vendor form fields, edit, delete, export; chemical in KG/LTR with category, export', async () => {
  const opt = (await api('get', '/vendors/options')).body;
  expect(opt.payments).toContain('CHQ');
  const v = (await api('post', '/vendors', { name: 'ABDUL GHAFOOR COLOUR CO', status: 'INDIVIDUAL', type: 'VENDORS', payment: 'CHQ', city: 'Karachi', province: 'Sindh', ntn: '123', bankName: 'HBL', iban: 'PK00' })).body;
  expect(v).toMatchObject({ code: 1, city: 'Karachi', payment: 'CHQ', ntn: '123', bankName: 'HBL' });
  expect((await api('post', '/vendors', { name: 'X', status: 'BAD' })).status).toBe(400);
  expect((await api('patch', `/vendors/${v.id}`, { legalName: 'AGC PVT', email: 'a@b.com' })).body).toMatchObject({ legalName: 'AGC PVT', email: 'a@b.com' });
  const vx = (await api('get', '/vendors?export=true')).body;
  expect(vx).toMatchObject({ export: true, total: 1, title: 'Vendors list' });
  expect(vx.sections[0].rows[0]).toMatchObject({ name: 'ABDUL GHAFOOR COLOUR CO', city: 'Karachi' });

  const cat = (await api('post', '/stores/chemical/categories', { name: 'DYES' })).body;
  const br = (await api('post', '/stores/chemical/brands', { name: 'HUNTSMAN' })).body;
  expect((await api('post', '/stores/chemical/items', { name: 'RED', unit: 'PCS', categoryId: cat.id })).status).toBe(422);
  const it = (await api('post', '/stores/chemical/items', { name: 'RED', unit: 'LTR', categoryId: cat.id, brandId: br.id })).body;
  expect((await api('get', `/stores/chemical/items?categoryId=${cat.id}`)).body.total).toBe(1);
  const ix = (await api('get', '/stores/chemical/items?export=true')).body;
  expect(ix.sections[0].rows[0]).toMatchObject({ category: 'DYES', name: 'RED', brand: 'HUNTSMAN', unit: 'LTR' });
  // dropdown of the inward screen carries the new vendor and chemical
  const fd = (await api('get', '/stores/chemical/inwards/form-data')).body;
  expect(fd.vendors.map((x) => x.id)).toContain(v.id);
  expect(fd.items.map((x) => x.id)).toContain(it.id);
  expect((await api('delete', `/stores/chemical/items/${it.id}`)).status).toBe(204);
  expect((await api('delete', `/vendors/${v.id}`)).status).toBe(204);
});
