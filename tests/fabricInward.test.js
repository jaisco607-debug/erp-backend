const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, FabricInward } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup(extra = []) {
  const company = await makeCompany();
  for (const code of ['FABRIC_STORE', 'GREY_STORE', ...extra]) {
    await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'FABRIC_STORE' } })).id, access: 'VIEW' });
  const staff = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: staff.id, serviceId: (await Service.findOne({ where: { code: 'FABRIC_STORE' } })).id, access: 'FULL' });
  const api = call(admin);
  const vendor = (await api('post', '/vendors', { name: 'Cloth Mills' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  return { company, api, viewer: call(viewer), staff: call(staff), vendor, q };
}
const body = (w, extra = {}) => ({ inwardDate: '2026-11-10', vendorId: w.vendor.id, qualityId: w.q.id, dcNo: 'DC-9', thaans: [60, 40.5, { length: 50, width: 58 }], width: 60, ...extra });

test('fabric inward: the grey inward form with a vendor; numbers, thaans, widths, totals', async () => {
  const w = await setup(['GENERAL_STORE']);
  const fd = await w.api('get', '/fabric-inwards/form-data');
  expect([fd.status, fd.body.nextInwardNo, fd.body.nextInwardText, fd.body.nextTypeNo]).toEqual([200, 1, '00001', '0001']);
  expect(fd.body.vendors.map((v) => v.name)).toEqual(['Cloth Mills']);
  expect(fd.body.qualities.map((v) => v.name)).toEqual(['PC TWILL']);
  const r = await w.api('post', '/fabric-inwards', body(w));
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ inwardNo: 1, inwardText: '00001', typeNo: '0001', pieces: 3, inwardMeters: 150.5, balanceMeters: 150.5, unit: 'METER', showYards: false, inwardYards: null, isApproved: false, statusText: 'UN-APPROVED', widths: [58, 60] });
  expect(r.body.vendor).toMatchObject({ name: 'Cloth Mills', label: 'Cloth Mills (1)' });
  expect(r.body.thaans.map((t) => [t.thaanNo, t.meters, t.width])).toEqual([[1, 60, 60], [2, 40.5, 60], [3, 50, 58]]);
  // yards
  const y = await w.api('post', '/fabric-inwards', body(w, { unit: 'YARD', thaans: [100, 100], width: undefined }));
  expect([y.status, y.body.inwardNo, y.body.showYards, y.body.inwardYards, y.body.inwardMeters]).toEqual([201, 2, true, 200, 182.88]);
  // a plain total without thaans
  const t = await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-10', vendorId: w.vendor.id, qualityName: 'pc twill', inwardMeters: 500, pieces: 10 });
  expect([t.status, t.body.quality.id, t.body.pieces, t.body.thaans]).toEqual([201, w.q.id, 10, []]);
  // a new quality typed by hand is added to the list
  const n = await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-10', vendorId: w.vendor.id, qualityName: 'Cotton Sheeting', thaans: [10] });
  expect(n.status).toBe(201);
  expect((await w.api('get', '/qualities')).body.total).toBe(2);
  err(await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-10', vendorId: w.vendor.id, thaans: [10] }), 400, 'VALIDATION_FAILED');
  err(await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-10', vendorId: w.vendor.id, qualityId: w.q.id }), 422, 'QTY_REQUIRED');
  // the vendor is required (a customer cannot be given)
  err(await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-10', qualityId: w.q.id, thaans: [5] }), 400, 'VALIDATION_FAILED');
  // list, search, filters
  const list = await w.api('get', '/fabric-inwards');
  expect([list.body.total, list.body.data.map((x) => x.inwardNo)]).toEqual([4, [4, 3, 2, 1]]);
  expect((await w.api('get', '/fabric-inwards?search=DC-9')).body.total).toBe(2);
  expect((await w.api('get', '/fabric-inwards?search=cloth mills')).body.total).toBe(4);
  expect((await w.api('get', '/fabric-inwards?search=2')).body.data.map((x) => x.inwardNo)).toContain(2);
  expect((await w.api('get', `/fabric-inwards?vendorId=${w.vendor.id}&dateFrom=2026-11-11`)).body.total).toBe(0);
});

test('edit, approve, delete rules, numbering', async () => {
  const w = await setup();
  const a = (await w.api('post', '/fabric-inwards', body(w))).body;
  // edit a draft: thaans again, vendor, remarks
  const v2 = (await w.api('post', '/vendors', { name: 'Second Mills' })).body;
  const e = await w.api('patch', `/fabric-inwards/${a.id}`, { thaans: [10, 20], remarks: 'changed', vendorId: v2.id });
  expect([e.status, e.body.pieces, e.body.inwardMeters, e.body.remarks, e.body.vendor.name]).toEqual([200, 2, 30, 'changed', 'Second Mills']);
  // unit change needs the quantity again
  err(await w.api('patch', `/fabric-inwards/${a.id}`, { unit: 'YARD' }), 422, 'QTY_REQUIRED');
  // approve: locked; only the admin takes it back
  const ap = await w.api('post', `/fabric-inwards/${a.id}/approve`);
  expect([ap.status, ap.body.isApproved, ap.body.statusText]).toEqual([200, true, 'APPROVED']);
  err(await w.api('patch', `/fabric-inwards/${a.id}`, { remarks: 'x' }), 422, 'INWARD_APPROVED');
  err(await w.api('delete', `/fabric-inwards/${a.id}`), 422, 'INWARD_APPROVED');
  expect((await w.staff('post', `/fabric-inwards/${a.id}/unapprove`)).status).toBe(403);
  expect((await w.api('post', `/fabric-inwards/${a.id}/unapprove`)).body.isApproved).toBe(false);
  // switched off: cannot approve
  await w.api('put', `/fabric-inwards/${a.id}/active`, { isActive: false });
  err(await w.api('post', `/fabric-inwards/${a.id}/approve`), 422, 'INWARD_INACTIVE');
  await w.api('put', `/fabric-inwards/${a.id}/active`, { isActive: true });
  // delete a draft: gone from the list; the number is not reused
  expect((await w.api('delete', `/fabric-inwards/${a.id}`)).status).toBe(204);
  expect((await w.api('get', `/fabric-inwards/${a.id}`)).status).toBe(404);
  expect((await w.api('post', '/fabric-inwards', body(w))).body.inwardNo).toBe(2);
  // numbering: typed number, taken number, carry on from the old system
  const typed = await w.api('post', '/fabric-inwards', body(w, { inwardNo: 50 }));
  expect(typed.body.inwardNo).toBe(50);
  expect((await w.api('get', '/fabric-inwards/numbering')).body.nextInwardNo).toBe(51);
  err(await w.api('post', '/fabric-inwards', body(w, { inwardNo: 50 })), 422, 'INWARD_NO_TAKEN');
  err(await w.api('put', '/fabric-inwards/numbering', { nextInwardNo: 10 }), 422, 'NUMBER_USED');
  expect((await w.api('put', '/fabric-inwards/numbering', { nextInwardNo: 100, nextTypeNo: 700 })).body).toEqual({ nextInwardNo: 100, nextTypeNo: '0700' });
  expect((await w.api('post', '/fabric-inwards', body(w))).body).toMatchObject({ inwardNo: 100, typeNo: '0700' });
  expect((await w.staff('put', '/fabric-inwards/numbering', { nextInwardNo: 200 })).status).toBe(403);
  // a vendor that is switched off is refused; a vendor used by an entry cannot be deleted
  await w.api('patch', `/vendors/${v2.id}`, { isActive: false });
  err(await w.api('post', '/fabric-inwards', body(w, { vendorId: v2.id })), 422, 'VENDOR_INACTIVE');
  err(await w.api('delete', `/vendors/${w.vendor.id}`), 422, 'IN_USE');
});

test('stock: only approved cloth with a balance; per quality totals; access rules', async () => {
  const w = await setup();
  const q2 = (await w.api('post', '/qualities', { name: 'Poplin' })).body;
  const a = (await w.api('post', '/fabric-inwards', body(w))).body; // 150.5 m, 3 pieces
  const b = (await w.api('post', '/fabric-inwards', body(w, { qualityId: q2.id, qualityName: undefined, thaans: [100] }))).body;
  const c = (await w.api('post', '/fabric-inwards', body(w, { thaans: [20, 30] }))).body; // stays a draft
  expect((await w.api('get', '/fabric-inwards/stock')).body.total).toBe(0); // nothing approved yet
  await w.api('post', `/fabric-inwards/${a.id}/approve`);
  await w.api('post', `/fabric-inwards/${b.id}/approve`);
  const s = await w.api('get', '/fabric-inwards/stock');
  expect(s.status).toBe(200);
  expect(s.body.totals).toMatchObject({ entries: 2, inwardMeters: 250.5, balanceMeters: 250.5 });
  expect(s.body.data.map((x) => x.inwardNo).sort()).toEqual([1, 2]);
  expect(s.body.data.find((x) => x.inwardNo === 1)).toMatchObject({ freePieces: 3, freeThaanNos: [1, 2, 3], balanceMeters: 150.5 });
  expect(s.body.byQuality.map((x) => [x.quality.name, x.balanceMeters])).toEqual([['PC TWILL', 150.5], ['Poplin', 100]]);
  expect(s.body.data[0].thaans).toBeUndefined();
  // used up entries are hidden unless showZero; a switched-off entry is not stock
  await FabricInward.update({ outwardMeters: 100 }, { where: { id: b.id } });
  expect((await w.api('get', '/fabric-inwards/stock')).body.total).toBe(1);
  expect((await w.api('get', '/fabric-inwards/stock?showZero=true')).body.total).toBe(2);
  expect((await w.api('get', `/fabric-inwards/stock?qualityId=${q2.id}`)).body.total).toBe(0);
  // cloth that has gone out cannot be un-approved / deleted / re-written below what went out
  err(await w.api('post', `/fabric-inwards/${b.id}/unapprove`), 422, 'INWARD_IN_USE');
  await w.api('put', `/fabric-inwards/${a.id}/active`, { isActive: false });
  expect((await w.api('get', '/fabric-inwards/stock')).body.total).toBe(0);
  // access: view only reads; the service is required
  expect((await w.viewer('get', '/fabric-inwards/stock')).status).toBe(200);
  expect((await w.viewer('get', '/fabric-inwards')).status).toBe(200);
  expect((await w.viewer('post', '/fabric-inwards', body(w))).status).toBe(403);
  expect((await w.viewer('post', `/fabric-inwards/${c.id}/approve`)).status).toBe(403);
  expect((await w.staff('post', `/fabric-inwards/${c.id}/approve`)).status).toBe(200);
  // the vendors list opens for the Fabric Store people too
  expect((await w.viewer('get', '/vendors')).status).toBe(200);
  // another company never sees it
  const other = await setup();
  expect((await other.api('get', `/fabric-inwards/${a.id}`)).status).toBe(404);
  expect((await other.api('get', '/fabric-inwards')).body.total).toBe(0);
});

test('a company without the Fabric Store service is refused', async () => {
  const company = await makeCompany();
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  expect((await call(admin)('get', '/fabric-inwards')).status).toBe(403);
});
