const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, AuditLog, sequelize } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

// owner 2026-11-25 (N-A1): a deleted grey lot waits in Deleted items: revert brings it back, permanent delete removes it from the tables, keeps a copy and frees the number
async function setup() {
  const company = await makeCompany();
  for (const code of ['GREY_STORE', 'SO_CARD']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const store = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: store.id, serviceId: (await Service.findOne({ where: { code: 'GREY_STORE' } })).id, access: 'FULL' });
  const as = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  return { company, api: as(admin), storeApi: as(store) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };
const today = () => require('../src/utils/dates').today();

test('delete -> Deleted items -> revert, and delete for good: the number is kept while it waits and free after', async () => {
  const w = await setup();
  const cu = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const ql = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const lot = (extra = {}) => w.api('post', '/grey-lots', { inwardDate: today(), customerId: cu.id, qualityId: ql.id, thaans: [100, 50], ...extra });
  const a = await ok(lot({ lotNo: 101 }), 201);
  expect(a.lotNo).toBe(101);

  // delete needs a reason; the lot leaves Grey Inward
  await fails(w.api('delete', `/grey-lots/${a.id}`), 400, 'VALIDATION_FAILED');
  await fails(w.api('delete', `/grey-lots/${a.id}`, { reason: 'abc' }), 400, 'VALIDATION_FAILED');
  await ok(w.storeApi('delete', `/grey-lots/${a.id}`, { reason: 'Entered by mistake' }), 204);
  expect((await ok(w.api('get', '/grey-lots'))).total).toBe(0);

  // it waits in Deleted items (client admin only)
  const d = await ok(w.api('get', '/deleted-items'));
  expect(d).toMatchObject({ view: 'deleted', total: 1, counts: { deleted: 1, permanent: 0 } });
  expect(d.data[0]).toMatchObject({ id: a.id, lotNo: 101, thaans: 2, meters: 150, reason: 'Entered by mistake', canRevert: true, canPermanentDelete: true, customer: { name: 'AZ' } });
  expect((await w.storeApi('get', '/deleted-items')).status).toBe(403);
  expect((await ok(w.api('get', '/deleted-items?search=101'))).total).toBe(1);
  expect((await ok(w.api('get', '/deleted-items?search=zzz'))).total).toBe(0);

  // while it waits the number 101 is taken
  await fails(lot({ lotNo: 101 }), 422, 'LOT_NO_TAKEN');

  // revert: the lot is back in Grey Inward with its number and thaans
  const back = await ok(w.api('post', `/deleted-items/lot/${a.id}/restore`));
  expect(back).toMatchObject({ lotNo: 101, restored: true });
  const got = await ok(w.api('get', `/grey-lots/${a.id}`));
  expect(got).toMatchObject({ lotNo: 101, inwardMeters: 150 });
  expect((await ok(w.api('get', '/deleted-items'))).total).toBe(0);
  await fails(w.api('post', `/deleted-items/lot/${a.id}/restore`), 422, 'NOT_DELETED');

  // delete again and delete for good: the number must be typed again
  await ok(w.api('delete', `/grey-lots/${a.id}`, { reason: 'Entered twice' }), 204);
  await fails(w.api('post', `/deleted-items/lot/${a.id}/permanent-delete`, { lotNo: 102 }), 422, 'CONFIRM_MISMATCH');
  expect(await ok(w.api('post', `/deleted-items/lot/${a.id}/permanent-delete`, { lotNo: 101 }))).toMatchObject({ lotNo: 101, permanentlyDeleted: true });

  // it is gone from the tables, a copy is in the archive
  const [{ n }] = await sequelize.query('SELECT count(*)::int AS n FROM grey_lots WHERE id = :id', { replacements: { id: a.id }, type: 'SELECT' });
  const [{ t }] = await sequelize.query('SELECT count(*)::int AS t FROM grey_lot_thaans WHERE "lotId" = :id', { replacements: { id: a.id }, type: 'SELECT' });
  expect([n, t]).toEqual([0, 0]);
  const [arc] = await sequelize.query('SELECT "itemNo", snapshot, "deleteReason" FROM deleted_items_archive WHERE "originalId" = :id', { replacements: { id: a.id }, type: 'SELECT' });
  expect(arc).toMatchObject({ itemNo: 101, deleteReason: 'Entered twice' });
  expect(arc.snapshot.thaans).toHaveLength(2);
  expect(Number(arc.snapshot.lot.inwardMeters)).toBe(150);
  const perm = await ok(w.api('get', '/deleted-items?view=permanent'));
  expect(perm).toMatchObject({ view: 'permanent', total: 1, counts: { deleted: 0, permanent: 1 } });
  expect(perm.data[0]).toMatchObject({ lotNo: 101, thaans: 2, meters: 150, reason: 'Entered twice', canRevert: false });
  await fails(w.api('post', `/deleted-items/lot/${a.id}/restore`), 404, 'NOT_FOUND');

  // the number 101 is free: a new entry with it works
  const again = await ok(lot({ lotNo: 101, thaans: [70] }), 201);
  expect(again).toMatchObject({ lotNo: 101, inwardMeters: 70 });
  // the audit trail
  const actions = (await AuditLog.findAll({ where: { companyId: w.company.id } })).map((x) => x.action);
  expect(actions).toEqual(expect.arrayContaining(['GREY_LOT_DELETED', 'GREY_LOT_RESTORED', 'GREY_LOT_PERMANENTLY_DELETED']));
});

test('Deleted items: another company sees and touches nothing of this one; a lot that is not deleted is refused', async () => {
  const w = await setup();
  const other = await setup();
  const cu = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const ql = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const a = await ok(w.api('post', '/grey-lots', { inwardDate: today(), customerId: cu.id, qualityId: ql.id, thaans: [100] }), 201);
  await fails(w.api('post', `/deleted-items/lot/${a.id}/permanent-delete`, { lotNo: a.lotNo }), 422, 'NOT_DELETED');
  await ok(w.api('delete', `/grey-lots/${a.id}`, { reason: 'Entered by mistake' }), 204);
  expect((await ok(other.api('get', '/deleted-items'))).total).toBe(0);
  await fails(other.api('post', `/deleted-items/lot/${a.id}/restore`), 404, 'NOT_FOUND');
  await fails(other.api('post', `/deleted-items/lot/${a.id}/permanent-delete`, { lotNo: a.lotNo }), 404, 'NOT_FOUND');
  expect((await ok(w.api('get', '/deleted-items'))).total).toBe(1);
});
