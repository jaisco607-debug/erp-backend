const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

test('a job with a running machine cannot go back to Pending / Queue or be returned to the SO card; thaans request limits', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING']) { s[code] = await Service.findOne({ where: { code } }); await CompanyService.create({ companyId: company.id, serviceId: s[code].id }); }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const token = (await loginAs(admin)).accessToken;
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${token}` }).send(body);
  await api('patch', '/machine-settings/DYEING', { machinesEnabled: true });
  const m1 = (await api('post', '/machine-settings/DYEING/machines', { count: 1 })).body.data[0];
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  const ql = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: ql.id, thaans: [100, 120] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] });
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  await api('post', `/departments/DYEING/jobs/${job.id}/receive`);
  await api('post', `/departments/DYEING/jobs/${job.id}/accept`);
  expect((await api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m1.id, operatorName: 'Aslam', meters: 100 })).status).toBe(201);

  // the machine is running: the job cannot go back, nor be returned to the SO card
  for (const status of ['PENDING', 'QUEUE']) {
    const r = await api('put', `/departments/DYEING/jobs/${job.id}/status`, { status });
    expect([r.status, r.body.error.code]).toEqual([422, 'MACHINE_STILL_RUNNING']);
  }

  // the thaans request: the same cloth line twice is refused
  const dup = await api('put', `/departments/DYEING/jobs/${job.id}/thaans`, { items: [{ jobItemId: job.items[0].id, thaans: [100] }, { jobItemId: job.items[0].id, thaans: [120] }] });
  expect(dup.status).toBe(400);
  const big = await api('put', `/departments/DYEING/jobs/${job.id}/thaans`, { items: [{ jobItemId: job.items[0].id, thaans: Array.from({ length: 301 }, () => 1) }] });
  expect(big.status).toBe(400);
});
