const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

beforeEach(clean);

const STATUSES = ['IN_WAY', 'QUEUE', 'PENDING', 'PROCESSING', 'COMPLETE'];
const ZERO = { IN_WAY: 0, QUEUE: 0, PENDING: 0, PROCESSING: 0, COMPLETE: 0, REJECTED: 0, rejectedHere: 0 };

test('process overview: the jobs per status of every department in one call, the same numbers as the incoming / rejected lists, only the departments the person may see', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FINISHING', 'PRINTING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  const api = asUser(admin);
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  for (let i = 1; i <= 3; i += 1) {
    const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [100, 120] })).body;
    await api('post', `/grey-lots/${lot.id}/approve`);
    await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] });
  }
  const rows = (await api('get', '/jobs/form-data')).body.rows;
  expect(rows).toHaveLength(3);
  const send = async (row) => (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: row.soCardLotId }] })).body;
  const a = await send(rows[0]);
  const b = await send(rows[1]);
  const c = await send(rows[2]);
  const dept = (code, path, body, m = 'post') => api(m, `/departments/${code}${path}`, body);
  await dept('DYEING', `/jobs/${b.id}/receive`);
  await dept('DYEING', `/jobs/${b.id}/accept`);
  await dept('DYEING', `/jobs/${b.id}/status`, { status: 'PROCESSING' }, 'put');
  await dept('DYEING', `/jobs/${c.id}/receive`);
  await dept('DYEING', `/jobs/${c.id}/accept`);
  await dept('DYEING', `/jobs/${c.id}/status`, { status: 'COMPLETE' }, 'put');

  const overview = async (call = api) => { const r = await call('get', '/departments/overview'); expect(r.status).toBe(200); return r.body; };
  const by = (list, code) => list.find((d) => d.code === code);
  let o = await overview();
  expect(o.map((d) => d.code).sort()).toEqual(['DYEING', 'FINISHING', 'PRINTING']);
  expect(by(o, 'DYEING')).toMatchObject({ id: s.DYEING.id, name: s.DYEING.name, counts: { ...ZERO, IN_WAY: 1, PROCESSING: 1, COMPLETE: 1 } });
  expect(by(o, 'FINISHING').counts).toEqual(ZERO);
  expect(by(o, 'PRINTING').counts).toEqual(ZERO);

  // the same numbers as the lists the screen used to call
  const sameAsLists = async (list) => {
    for (const d of list) {
      for (const st of STATUSES) expect(d.counts[st]).toBe((await dept(d.code, `/incoming?status=${st}`, undefined, 'get')).body.total);
      expect(d.counts.REJECTED).toBe((await dept(d.code, '/rejected', undefined, 'get')).body.total);
      expect(d.counts.rejectedHere).toBe((await dept(d.code, '/incoming?status=REJECTED', undefined, 'get')).body.total);
    }
  };
  await sameAsLists(o);

  // dyeing sends the complete job on: it leaves dyeing's list and counts at finishing
  await dept('DYEING', `/jobs/${c.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' }, 'put');
  const form = (await dept('DYEING', '/send-form', undefined, 'get')).body;
  const fin = (await dept('DYEING', '/send', { toDepartmentCode: 'FINISHING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  o = await overview();
  expect(by(o, 'DYEING').counts).toEqual({ ...ZERO, IN_WAY: 1, PROCESSING: 1 });
  expect(by(o, 'FINISHING').counts).toEqual({ ...ZERO, IN_WAY: 1 });

  // finishing completes it and sends it to printing, which rejects it: the job comes back to finishing
  await dept('FINISHING', `/jobs/${fin.id}/receive`);
  await dept('FINISHING', `/jobs/${fin.id}/accept`);
  await dept('FINISHING', `/jobs/${fin.id}/status`, { status: 'COMPLETE' }, 'put');
  await dept('FINISHING', `/jobs/${fin.id}/operator`, { operatorName: 'Bilal', processDate: '2026-10-19' }, 'put');
  const form2 = (await dept('FINISHING', '/send-form', undefined, 'get')).body;
  const pr = (await dept('FINISHING', '/send', { toDepartmentCode: 'PRINTING', items: [{ jobItemId: form2.rows[0].jobItemId }] })).body;
  await dept('PRINTING', `/jobs/${pr.id}/reject`, { reason: 'Colour sahi nahi hua' });
  o = await overview();
  expect(by(o, 'FINISHING').counts).toEqual({ ...ZERO, COMPLETE: 1, REJECTED: 1 }); // its own job is back, and one job it sent was rejected
  expect(by(o, 'PRINTING').counts).toEqual({ ...ZERO, rejectedHere: 1 });
  await sameAsLists(o);

  // a user sees only the departments given to them (VIEW is enough); none given = an empty list
  const user = await makeUser({ userType: 'USER', companyId: company.id });
  expect(await overview(asUser(user))).toEqual([]);
  await UserService.create({ userId: user.id, serviceId: s.DYEING.id, access: 'VIEW' });
  const mine = await overview(asUser(user));
  expect(mine.map((d) => d.code)).toEqual(['DYEING']);
  expect(mine[0].counts).toEqual({ ...ZERO, IN_WAY: 1, PROCESSING: 1 });

  // another company sees nothing of this company's jobs
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: s.DYEING.id });
  const stranger = await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id });
  const theirs = await overview(asUser(stranger));
  expect(theirs.map((d) => d.code)).toEqual(['DYEING']);
  expect(theirs[0].counts).toEqual(ZERO);
  expect((await request(app).get('/api/v1/departments/overview')).status).toBe(401);
});
