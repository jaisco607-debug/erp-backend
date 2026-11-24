const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

const CODES = ['GREY_STORE', 'SO_CARD', 'DYEING', 'REPORT_DEPARTMENTS'];

async function companyWithDyeing() {
  const company = await makeCompany();
  const dyeing = await Service.findOne({ where: { code: 'DYEING' } });
  for (const code of CODES) { const sv = await Service.findOne({ where: { code } }); await CompanyService.create({ companyId: company.id, serviceId: sv.id }); }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const token = (await loginAs(admin)).accessToken;
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${token}` }).send(body);
  return { company, dyeing, api };
}

test('two companies with the same Dyeing department: machines, operators and the department ledger stay apart', async () => {
  const A = await companyWithDyeing();
  const B = await companyWithDyeing();

  // company A: machines on, one job running on a machine with an operator
  await A.api('patch', '/machine-settings/DYEING', { machinesEnabled: true });
  const m1 = (await A.api('post', '/machine-settings/DYEING/machines', { count: 1 })).body.data[0];
  const cu = (await A.api('post', '/customers', { name: 'SECRET PARTY' })).body;
  const ql = (await A.api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await A.api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: ql.id, thaans: [100, 120] })).body;
  await A.api('post', `/grey-lots/${lot.id}/approve`);
  await A.api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] });
  const fd = (await A.api('get', '/jobs/form-data')).body;
  const job = (await A.api('post', '/jobs', { departmentId: A.dyeing.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  await A.api('post', `/departments/DYEING/jobs/${job.id}/receive`);
  await A.api('post', `/departments/DYEING/jobs/${job.id}/accept`);
  const run = await A.api('post', `/departments/DYEING/jobs/${job.id}/machines`, { machineId: m1.id, operatorName: 'Aslam Secret', meters: 100 });
  expect(run.status).toBe(201);

  // company A sees its own things
  expect((await A.api('get', '/departments/DYEING/machine-operators')).body.data).toContain('Aslam Secret');
  const ledA = await A.api('get', '/reports/ledgers/department');
  expect(JSON.stringify(ledA.body)).toContain('SECRET PARTY');

  // company B: sees nothing of A
  expect((await B.api('get', '/departments/DYEING/machine-operators')).body.data).toEqual([]);
  const ledB = await B.api('get', '/reports/ledgers/department');
  expect(ledB.status).toBe(200);
  expect(JSON.stringify(ledB.body)).not.toContain('SECRET PARTY');
  expect(JSON.stringify(ledB.body)).not.toContain(job.jobNo ? `Job# ${job.jobNo}` : 'NO-SUCH');

  // company B can switch its machines on and off although A has a machine running
  await B.api('patch', '/machine-settings/DYEING', { machinesEnabled: true });
  const stB = (await B.api('get', '/machine-settings')).body.data.find((d) => d.code === 'DYEING');
  expect(stB).toMatchObject({ runningCount: 0 });
  const offB = await B.api('patch', '/machine-settings/DYEING', { machinesEnabled: false });
  expect(offB.status).toBe(200);
  // ... while A really cannot
  const offA = await A.api('patch', '/machine-settings/DYEING', { machinesEnabled: false });
  expect([offA.status, offA.body.error.code, offA.body.error.details.running]).toEqual([422, 'MACHINES_RUNNING', 1]);
});
