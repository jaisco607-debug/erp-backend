const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(180000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const codesOf = async (api) => (await api('get', '/auth/me')).body.services.map((s) => s.code);

async function setup() {
  const company = await makeCompany({ processManagement: false, processLimit: 0 });
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', 'PACKING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const sa = await makeUser({ userType: 'SUPER_ADMIN' });
  const ca = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const staff = await makeUser({ userType: 'USER', companyId: company.id });
  return { company, s, sa: call(sa), ca: call(ca), staff, staffApi: call(staff) };
}

test('the super admin switches Process Management on with a limit; the client admin adds his own processes within it; off = no processes, no tab', async () => {
  const w = await setup();
  // OFF: no process and no Folding in the menu, and the screen is closed
  let codes = await codesOf(w.ca);
  expect(codes).toEqual(expect.arrayContaining(['GREY_STORE', 'SO_CARD', 'PACKING']));
  expect(codes).not.toEqual(expect.arrayContaining(['DYEING']));
  expect(codes).not.toEqual(expect.arrayContaining(['FOLDING']));
  err(await w.ca('get', '/processes'), 403, 'PROCESS_MANAGEMENT_OFF');
  err(await w.ca('post', '/processes', { name: 'Washing' }), 403, 'PROCESS_MANAGEMENT_OFF');
  err(await w.ca('get', '/departments/DYEING/incoming'), 404, 'NOT_FOUND');

  // the super admin: ON with a limit of 2 (the company screen shows both and how many are used)
  const on = (await w.sa('patch', `/companies/${w.company.id}`, { processManagement: true, processLimit: 3 })).body;
  expect(on).toMatchObject({ processManagement: true, processLimit: 3, processesUsed: 1 });
  const listed = (await w.sa('get', '/companies')).body.data.find((c) => c.id === w.company.id);
  expect(listed).toMatchObject({ processManagement: true, processLimit: 3, processesUsed: 1 });
  expect((await w.sa('patch', `/companies/${w.company.id}`, { processLimit: -1 })).status).toBe(400);
  codes = await codesOf(w.ca);
  expect(codes).toEqual(expect.arrayContaining(['DYEING', 'FOLDING']));

  // the client admin's screen
  const s0 = (await w.ca('get', '/processes')).body;
  expect(s0).toMatchObject({ enabled: true, limit: 3, used: 1, remaining: 2, canAdd: true, data: [] });
  expect(s0.assigned.map((p) => p.code)).toEqual(expect.arrayContaining(['DYEING']));
  const a = await w.ca('post', '/processes', { name: ' Washing   Unit ' });
  expect(a.status).toBe(201);
  expect(a.body).toMatchObject({ code: 'WASHING_UNIT', name: 'Washing Unit', kind: 'PROCESS', menuGroup: 'PROCESS', isActive: true, canDelete: true });
  err(await w.ca('post', '/processes', { name: 'washing unit' }), 422, 'PROCESS_NAME_TAKEN');
  err(await w.ca('post', '/processes', { name: 'Dyeing' }), 422, 'PROCESS_NAME_TAKEN'); // the super admin gave him a Dyeing already
  const b = (await w.ca('post', '/processes', { name: 'Stitching Line', tracksColour: false })).body;
  expect(b).toMatchObject({ code: 'STITCHING_LINE', tracksColour: false });
  err(await w.ca('post', '/processes', { name: 'One More' }), 422, 'PROCESS_LIMIT_REACHED');
  expect((await w.ca('get', '/processes')).body).toMatchObject({ used: 3, remaining: 0, canAdd: false });
  // a name that is a code of a platform service (SO Card, Packing) gets another code
  expect((await w.sa('patch', `/companies/${w.company.id}`, { processLimit: 4 })).body.processLimit).toBe(4);
  expect((await w.ca('post', '/processes', { name: 'SO Card' })).body.code).toBe('SO_CARD_2');
  // it is a service of the company like any other: menu, users, department URLs
  const me = (await w.ca('get', '/auth/me')).body.services;
  expect(me.find((x) => x.code === 'WASHING_UNIT')).toMatchObject({ name: 'Washing Unit', kind: 'PROCESS', menuGroup: 'PROCESS', access: 'FULL' });
  expect((await w.ca('get', '/departments')).body.map((d) => d.code)).toEqual(expect.arrayContaining(['WASHING_UNIT', 'STITCHING_LINE', 'DYEING']));
  expect((await w.ca('get', '/departments/WASHING_UNIT/incoming')).status).toBe(200);
  await UserService.create({ userId: w.staff.id, serviceId: a.body.id, access: 'FULL' });
  expect((await w.staffApi('get', '/auth/me')).body.services.map((x) => x.code)).toContain('WASHING_UNIT');
  // rename, switch off (it leaves the menu), the code never changes
  expect((await w.ca('patch', `/processes/${a.body.id}`, { name: 'Washing Plant' })).body).toMatchObject({ name: 'Washing Plant', code: 'WASHING_UNIT' });
  expect((await w.ca('patch', `/processes/${a.body.id}`, { code: 'X' })).status).toBe(400);
  err(await w.ca('patch', `/processes/${b.id}`, { name: 'Washing Plant' }), 422, 'PROCESS_NAME_TAKEN');
  expect((await w.ca('patch', `/processes/${b.id}`, { isActive: false })).body.isActive).toBe(false);
  expect(await codesOf(w.ca)).not.toContain('STITCHING_LINE');
  expect((await w.ca('patch', `/processes/${b.id}`, { isActive: true })).body.isActive).toBe(true);
  // the super admin's own list does not have the client's processes, and "exactly this list" never removes them
  expect((await w.sa('get', '/services')).body.data.map((x) => x.code)).not.toContain('WASHING_UNIT');
  const ids = (await w.sa('get', `/companies/${w.company.id}`)).body.services.map((x) => x.id);
  const kept = (await w.sa('put', `/companies/${w.company.id}/services`, { serviceIds: ids })).body;
  expect(kept.ownProcesses.map((x) => x.code)).toEqual(expect.arrayContaining(['WASHING_UNIT', 'STITCHING_LINE']));
  expect(kept.processesUsed).toBe(4);
  // an own process id in the list is ignored (not an error), and his processes stay even when the platform ones are taken away
  const bare = (await w.sa('put', `/companies/${w.company.id}/services`, { serviceIds: [a.body.id] })).body;
  expect(bare.services.map((x) => x.code)).toEqual([]);
  expect(bare.ownProcesses).toHaveLength(3);
  expect(await codesOf(w.ca)).toContain('WASHING_UNIT');
  await w.sa('put', `/companies/${w.company.id}/services`, { serviceIds: ids });

  // work in a process: it cannot be deleted any more (switch it off instead)
  const cu = (await w.ca('post', '/customers', { name: 'AZ' })).body;
  const q = (await w.ca('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await w.ca('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [60, 40] })).body;
  await w.ca('post', `/grey-lots/${lot.id}/approve`);
  await w.ca('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] });
  const fd = (await w.ca('get', '/jobs/form-data')).body;
  const job = await w.ca('post', '/jobs', { departmentId: a.body.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] });
  expect(job.status).toBe(201);
  const used = await w.ca('delete', `/processes/${a.body.id}`);
  err(used, 422, 'PROCESS_IN_USE');
  expect(used.body.error.details.usage).toMatchObject({ jobs: 1 });
  expect((await w.ca('get', '/processes')).body.data.find((x) => x.id === a.body.id)).toMatchObject({ canDelete: false, userCount: 1 });
  // an empty one can: the users lose it
  const gone = await w.ca('delete', `/processes/${b.id}`);
  expect(gone.body).toMatchObject({ deleted: true });
  expect(await codesOf(w.ca)).not.toContain('STITCHING_LINE');
  expect((await w.ca('get', '/processes')).body.used).toBe(3); // Dyeing (given), Washing Plant and SO Card 2

  // access: only a client admin of his own company; another company cannot touch it
  err(await w.staffApi('get', '/processes'), 403, 'FORBIDDEN');
  const other = await makeCompany({ processManagement: true, processLimit: 1 });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  err(await oa('patch', `/processes/${a.body.id}`, { name: 'Mine' }), 404, 'NOT_FOUND');
  err(await oa('delete', `/processes/${a.body.id}`), 404, 'NOT_FOUND');
  // two companies can both have a process of the same name
  expect((await oa('post', '/processes', { name: 'Washing Plant' })).body).toMatchObject({ code: 'WASHING_PLANT', name: 'Washing Plant' });
  expect((await oa('get', '/processes')).body.data).toHaveLength(1);

  // OFF again: all processes disappear from the menu (nothing is lost) and the screen closes
  await w.sa('patch', `/companies/${w.company.id}`, { processManagement: false });
  codes = await codesOf(w.ca);
  expect(codes).not.toContain('WASHING_UNIT');
  expect(codes).not.toContain('DYEING');
  err(await w.ca('get', '/processes'), 403, 'PROCESS_MANAGEMENT_OFF');
  expect((await w.staffApi('get', '/auth/me')).body.services.map((x) => x.code)).not.toContain('WASHING_UNIT');
  await w.sa('patch', `/companies/${w.company.id}`, { processManagement: true });
  expect(await codesOf(w.ca)).toContain('WASHING_UNIT');
});

test('a company the super admin registers starts with Process Management OFF and a limit of 0', async () => {
  const sa = call(await makeUser({ userType: 'SUPER_ADMIN' }));
  const made = await sa('post', '/companies', { name: 'New Mill', admin: { name: 'Boss', email: 'boss@newmill.com', password: 'Strong-Pass-123' } });
  expect(made.status).toBe(201);
  expect(made.body).toMatchObject({ processManagement: false, processLimit: 0, processesUsed: 0 });
  const withOn = await sa('post', '/companies', { name: 'Mill Two', processManagement: true, processLimit: 3, admin: { name: 'Boss', email: 'boss@milltwo.com', password: 'Strong-Pass-123' } });
  expect(withOn.body).toMatchObject({ processManagement: true, processLimit: 3 });
  // switching it on gives the company Folding and Packing (the end of every process)
  await sa('patch', `/companies/${made.body.id}`, { processManagement: true, processLimit: 1 });
  const svc = (await sa('get', `/companies/${made.body.id}`)).body.services.map((x) => x.code);
  expect(svc).toEqual(expect.arrayContaining(['FOLDING', 'PACKING']));
});

test('the limit counts every active process (own + given by the super admin); the client admin chooses which stay active; nothing is deleted', async () => {
  const company = await makeCompany({ processManagement: true, processLimit: 10 });
  for (const n of [1, 2, 3]) await Service.create({ code: `TEST_P${n}`, name: `Test Process ${n}`, kind: 'PROCESS', menuGroup: 'PROCESS', sortOrder: 900 + n });
  const platform = await Service.findAll({ where: { kind: 'PROCESS', isActive: true, companyId: null }, order: [['sortOrder', 'ASC']] });
  expect(platform.length).toBeGreaterThanOrEqual(11);
  const ten = platform.slice(0, 10);
  for (const s of ten) await CompanyService.create({ companyId: company.id, serviceId: s.id });
  for (const code of ['FOLDING', 'PACKING', 'SO_CARD']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const sa = call(await makeUser({ userType: 'SUPER_ADMIN' }));
  const ca = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id }));
  const staff = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: staff.id, serviceId: ten[0].id, access: 'FULL' });
  await UserService.create({ userId: staff.id, serviceId: ten[9].id, access: 'FULL' });
  const staffApi = call(staff);
  const processCodes = async (api) => (await api('get', '/auth/me')).body.services.filter((s) => s.kind === 'PROCESS').map((s) => s.code);

  // the super admin lowers the limit to 5 while 10 are active: nothing is switched off for the client admin
  expect((await sa('patch', `/companies/${company.id}`, { processLimit: 5 })).body).toMatchObject({ processLimit: 5, processesUsed: 10 });
  expect(await processCodes(ca)).toHaveLength(10);
  const s0 = (await ca('get', '/processes')).body;
  expect(s0).toMatchObject({ limit: 5, used: 10, remaining: 0, canAdd: false, overLimit: true, data: [] });
  expect(s0.assigned).toHaveLength(10);
  expect(s0.assigned[0]).toMatchObject({ isOwn: false, isActive: true, userCount: 1, usage: {} });
  expect((await sa('get', `/companies/${company.id}`)).body.processesUsed).toBe(10);
  err(await ca('post', '/processes', { name: 'Extra' }), 422, 'PROCESS_LIMIT_REACHED');
  // only isActive can be changed on an assigned process
  const first = ten[0].id;
  err(await ca('patch', `/processes/${first}`, { name: 'Xyz' }), 422, 'PROCESS_NOT_EDITABLE');
  err(await ca('patch', `/processes/${first}`, { isActive: false, tracksColour: false }), 422, 'PROCESS_NOT_EDITABLE');
  expect((await ca('patch', `/processes/${first}`, { code: 'X' })).status).toBe(400);
  err(await ca('delete', `/processes/${first}`), 404, 'NOT_FOUND');
  // a process the company does not have is not his
  err(await ca('patch', `/processes/${platform[10].id}`, { isActive: true }), 404, 'NOT_FOUND');

  // he switches 5 off: back to the limit, the menu has 5, the users lose those from their menu, nothing is deleted
  for (const s of ten.slice(0, 5)) {
    const r = await ca('patch', `/processes/${s.id}`, { isActive: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.id, isActive: false, isOwn: false });
  }
  const s1 = (await ca('get', '/processes')).body;
  expect(s1).toMatchObject({ used: 5, remaining: 0, canAdd: false, overLimit: false });
  expect(s1.assigned.filter((p) => p.isActive)).toHaveLength(5);
  expect(s1.assigned.filter((p) => !p.isActive)).toHaveLength(5);
  expect((await processCodes(ca)).sort()).toEqual(ten.slice(5).map((s) => s.code).sort());
  expect(await processCodes(staffApi)).toEqual([ten[9].code]);
  expect((await ca('get', '/auth/me')).body.services.map((s) => s.code)).toEqual(expect.arrayContaining(['FOLDING', 'PACKING', 'SO_CARD']));
  expect((await sa('get', `/companies/${company.id}`)).body.processesUsed).toBe(5);
  // switching ON needs room: used 5 = limit is refused with the numbers
  const refused = await ca('patch', `/processes/${first}`, { isActive: true });
  err(refused, 422, 'PROCESS_LIMIT_REACHED');
  expect(refused.body.error.details).toEqual({ limit: 5, used: 5 });
  err(await ca('post', '/processes', { name: 'Extra' }), 422, 'PROCESS_LIMIT_REACHED');
  // one more switched off makes room for an own process
  await ca('patch', `/processes/${ten[5].id}`, { isActive: false });
  const own = await ca('post', '/processes', { name: 'My Process' });
  expect(own.status).toBe(201);
  expect((await ca('get', '/processes')).body).toMatchObject({ used: 5, canAdd: false });
  // an own process switched off frees its place too, and obeys the same rule when switched on
  expect((await ca('patch', `/processes/${own.body.id}`, { isActive: false })).body).toMatchObject({ isActive: false, used: 4, overLimit: false });
  expect((await ca('patch', `/processes/${first}`, { isActive: true })).status).toBe(200);
  err(await ca('patch', `/processes/${own.body.id}`, { isActive: true }), 422, 'PROCESS_LIMIT_REACHED');

  // the super admin "exactly this list" keeps the choices; a process added to the list starts active
  const ids = (await sa('get', `/companies/${company.id}`)).body.services.map((x) => x.id);
  await sa('put', `/companies/${company.id}/services`, { serviceIds: [...ids, platform[10].id] });
  const s2 = (await ca('get', '/processes')).body;
  expect(s2.assigned.find((p) => p.id === ten[1].id).isActive).toBe(false);
  expect(s2.assigned.find((p) => p.id === first).isActive).toBe(true);
  expect(s2.assigned.find((p) => p.id === platform[10].id).isActive).toBe(true);
  expect(s2.overLimit).toBe(true);
  // two companies share one platform process and keep independent switches
  const other = await makeCompany({ processManagement: true, processLimit: 3 });
  await CompanyService.create({ companyId: other.id, serviceId: first });
  await CompanyService.create({ companyId: other.id, serviceId: ten[1].id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/processes')).body.assigned.map((p) => [p.id === first, p.isActive])).toEqual([[true, true], [false, true]]);
  expect((await oa('patch', `/processes/${first}`, { isActive: false })).status).toBe(200);
  expect((await ca('get', '/processes')).body.assigned.find((p) => p.id === first).isActive).toBe(true);
  expect((await oa('get', '/processes')).body.assigned.find((p) => p.id === first).isActive).toBe(false);
  expect(await processCodes(oa)).toEqual([ten[1].code]);

  // toggle OFF: closed, nothing is deleted; ON again: every choice is back
  const before = (await ca('get', '/processes')).body.assigned.map((p) => [p.id, p.isActive]);
  await sa('patch', `/companies/${company.id}`, { processManagement: false });
  err(await ca('get', '/processes'), 403, 'PROCESS_MANAGEMENT_OFF');
  err(await ca('patch', `/processes/${first}`, { isActive: false }), 403, 'PROCESS_MANAGEMENT_OFF');
  expect(await processCodes(ca)).toEqual([]);
  await sa('patch', `/companies/${company.id}`, { processManagement: true });
  expect((await ca('get', '/processes')).body.assigned.map((p) => [p.id, p.isActive])).toEqual(before);
});
