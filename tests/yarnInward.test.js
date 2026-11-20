const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, Customer, Vendor } = require('../src/models');

const { withContract } = require('./contractHelper');
jest.setTimeout(180000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  const svc = await Service.findOne({ where: { code: 'WEAVING_MASTERS' } });
  await CompanyService.create({ companyId: company.id, serviceId: svc.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: svc.id, access: 'VIEW' });
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  return { company, svc, api, viewer: call(viewer), item, count, brand };
}

test('customers and vendors: the common masters opened from the weaving service (same tables, running codes)', async () => {
  const w = await setup();
  const cu = await w.api('post', '/weaving/customers', { name: 'Ali Traders', phone: '0300' });
  expect([cu.status, cu.body.code, cu.body.name]).toEqual([201, 1, 'Ali Traders']);
  const ve = await w.api('post', '/weaving/vendors', { name: 'Yarn Mills', city: 'Faisalabad' });
  expect([ve.status, ve.body.code, ve.body.city]).toEqual([201, 1, 'Faisalabad']);
  // the same rows are in the common tables
  expect(await Customer.count({ where: { companyId: w.company.id } })).toBe(1);
  expect(await Vendor.count({ where: { companyId: w.company.id } })).toBe(1);
  err(await w.api('post', '/weaving/customers', { name: 'ali traders' }), 422, 'NAME_TAKEN');
  expect((await w.api('get', '/weaving/customers?search=ali')).body.total).toBe(1);
  expect((await w.api('get', '/weaving/vendors/options')).body.provinces).toContain('Sindh');
  expect((await w.api('get', '/weaving/customers/options')).body.statuses.length).toBeGreaterThan(0);
  expect((await w.viewer('get', '/weaving/vendors')).status).toBe(200);
  expect((await w.viewer('post', '/weaving/vendors', { name: 'Zed' })).status).toBe(403);
  expect((await w.api('patch', `/weaving/vendors/${ve.body.id}`, { phone: '021' })).body.phone).toBe('021');
});

test('yarn inward: purchase from a vendor and overhead from a customer; bags x lbs, rate, amount; form data; edit / delete; filters and totals', async () => {
  const w = await setup();
  const vendor = (await w.api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const customer = (await w.api('post', '/weaving/customers', { name: 'Ali Traders' })).body;

  const fd = (await w.api('get', '/weaving/yarn-inwards/form-data')).body;
  expect(fd.items).toHaveLength(1);
  expect(fd.items[0]).toMatchObject({ id: w.item.id, name: '22|s Cotton - Crescent - 24 - 100', packing: 24, bags: 100, lbsPerBag: 100, yarnCount: { name: '22|s Cotton' }, brand: { name: 'Crescent' } });
  expect(fd.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // purchase: vendor, 10 bags of 100 lbs at 350 per lb
  const p = await w.api('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: w.item.id, bags: 10, lbsPerBag: 100, ratePerLb: 350.5, inwardDate: '2026-11-10', dcNo: 'DC-9' });
  expect(p.status).toBe(201);
  expect(p.body).toMatchObject({ code: 1, type: 'PURCHASE', party: { kind: 'VENDOR', name: 'Yarn Mills' }, bags: 10, lbsPerBag: 100, totalLbs: 1000, ratePerLb: 350.5, amount: 350500, dcNo: 'DC-9', inwardDate: '2026-11-10' });
  expect(p.body.item).toMatchObject({ name: '22|s Cotton - Crescent - 24 - 100', packing: 24, bags: 100 });
  // overhead: customer, rate not needed
  const o = await w.api('post', '/weaving/yarn-inwards', await withContract(w.api, w.item, { customerId: customer.id, itemId: w.item.id, bags: 5, lbsPerBag: 50.5 }));
  expect(o.status).toBe(201);
  expect(o.body).toMatchObject({ code: 2, type: 'OVERHEAD', party: { kind: 'CUSTOMER', name: 'Ali Traders' }, totalLbs: 252.5, ratePerLb: null, amount: null });
  // overhead with a rate gets an amount too
  const o2 = await w.api('post', '/weaving/yarn-inwards', await withContract(w.api, w.item, { customerId: customer.id, itemId: w.item.id, bags: 2, lbsPerBag: 100, ratePerLb: 10 }));
  expect(o2.body.amount).toBe(2000);

  // rules
  err(await w.api('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: w.item.id, bags: 1, lbsPerBag: 100 }), 422, 'RATE_REQUIRED');
  expect((await w.api('post', '/weaving/yarn-inwards', { vendorId: vendor.id, customerId: customer.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, ratePerLb: 1 })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-inwards', { itemId: w.item.id, bags: 1, lbsPerBag: 100 })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: w.item.id, bags: 0, lbsPerBag: 100, ratePerLb: 1 })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: w.item.id, bags: 1.5, lbsPerBag: 100, ratePerLb: 1 })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: w.item.id, bags: 1, lbsPerBag: 0, ratePerLb: 1 })).status).toBe(400);
  err(await w.api('post', '/weaving/yarn-inwards', { vendorId: customer.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, ratePerLb: 1 }), 422, 'UNKNOWN_VENDOR');
  err(await w.api('post', '/weaving/yarn-inwards', { customerId: vendor.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, contractLineId: '11111111-1111-4111-8111-111111111111' }), 422, 'UNKNOWN_CUSTOMER');
  err(await w.api('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: vendor.id, bags: 1, lbsPerBag: 100, ratePerLb: 1 }), 422, 'UNKNOWN_ITEM');
  expect((await w.viewer('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, ratePerLb: 1 })).status).toBe(403);

  // list, filters, totals
  const all = (await w.api('get', '/weaving/yarn-inwards')).body;
  expect(all.total).toBe(3);
  expect(all.totals).toEqual({ bags: 17, totalLbs: 1452.5, amount: 352500 });
  expect((await w.api('get', '/weaving/yarn-inwards?type=PURCHASE')).body.data.map((x) => x.code)).toEqual([1]);
  expect((await w.api('get', '/weaving/yarn-inwards?type=OVERHEAD')).body.total).toBe(2);
  expect((await w.api('get', `/weaving/yarn-inwards?vendorId=${vendor.id}`)).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-inwards?dateFrom=2026-11-10&dateTo=2026-11-10')).body.data.map((x) => x.code)).toEqual([1]);
  expect((await w.api('get', '/weaving/yarn-inwards?search=ali')).body.total).toBe(2);
  expect((await w.api('get', '/weaving/yarn-inwards?search=DC-9')).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-inwards?search=crescent')).body.total).toBe(3);
  expect((await w.viewer('get', `/weaving/yarn-inwards/${p.body.id}`)).body.code).toBe(1);

  // edit: numbers are worked out again; the kind of party cannot change
  const e = await w.api('patch', `/weaving/yarn-inwards/${p.body.id}`, { bags: 20, ratePerLb: 300 });
  expect(e.body).toMatchObject({ bags: 20, totalLbs: 2000, ratePerLb: 300, amount: 600000 });
  err(await w.api('patch', `/weaving/yarn-inwards/${p.body.id}`, { customerId: customer.id }), 422, 'TYPE_LOCKED');
  err(await w.api('patch', `/weaving/yarn-inwards/${o.body.id}`, { vendorId: vendor.id }), 422, 'TYPE_LOCKED');
  err(await w.api('patch', `/weaving/yarn-inwards/${p.body.id}`, { ratePerLb: null }), 422, 'RATE_REQUIRED');

  // in use: the item card, the vendor cannot be deleted; a delete of the entry frees them
  err(await w.api('delete', `/weaving/item-cards/${w.item.id}`), 422, 'IN_USE');
  err(await w.api('delete', `/weaving/vendors/${vendor.id}`), 422, 'IN_USE');
  expect((await w.api('delete', `/weaving/yarn-inwards/${p.body.id}`)).body.deleted).toBe(true);
  err(await w.api('get', `/weaving/yarn-inwards/${p.body.id}`), 404, 'NOT_FOUND');
  // the deleted entry is kept for the record, so the vendor stays
  err(await w.api('delete', `/weaving/vendors/${vendor.id}`), 422, 'IN_USE');
  const spare = (await w.api('post', '/weaving/vendors', { name: 'Spare' })).body;
  expect((await w.api('delete', `/weaving/vendors/${spare.id}`)).status).toBe(204);

  // a switched-off item card cannot be used for a new entry
  await w.api('patch', `/weaving/item-cards/${w.item.id}`, { isActive: false });
  err(await w.api('post', '/weaving/yarn-inwards', await withContract(w.api, w.item, { customerId: customer.id, itemId: w.item.id, bags: 1, lbsPerBag: 100 })), 422, 'ITEM_INACTIVE');
  expect((await w.api('get', '/weaving/yarn-inwards/form-data')).body.items).toHaveLength(0);
});

test('yarn inward: another company cannot see or use these entries, vendors or item cards', async () => {
  const w = await setup();
  const vendor = (await w.api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const e = (await w.api('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, ratePerLb: 1 })).body;
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/yarn-inwards')).body.total).toBe(0);
  err(await oa('get', `/weaving/yarn-inwards/${e.id}`), 404, 'NOT_FOUND');
  err(await oa('post', '/weaving/yarn-inwards', { vendorId: vendor.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, ratePerLb: 1 }), 422, 'UNKNOWN_VENDOR');
  expect((await oa('get', '/weaving/vendors')).body.total).toBe(0);
});

test('weaving has its OWN customers and vendors: the main lists do not show up there, and weaving ones do not show in the main lists', async () => {
  const w = await setup();
  // existing (main module) customer and vendor
  const mainCu = await Customer.create({ companyId: w.company.id, code: 1, name: 'Main Party' });
  const mainVe = await Vendor.create({ companyId: w.company.id, code: 1, name: 'Main Vendor' });
  expect((await w.api('get', '/weaving/customers')).body.total).toBe(0);
  expect((await w.api('get', '/weaving/vendors')).body.total).toBe(0);
  err(await w.api('get', `/weaving/customers/${mainCu.id}`), 404, 'NOT_FOUND');
  err(await w.api('get', `/weaving/vendors/${mainVe.id}`), 404, 'NOT_FOUND');
  err(await w.api('patch', `/weaving/vendors/${mainVe.id}`, { phone: '1' }), 404, 'NOT_FOUND');
  // a weaving party starts at code 1 and may have the same name and code as a main one
  const cu = await w.api('post', '/weaving/customers', { name: 'Main Party' });
  const ve = await w.api('post', '/weaving/vendors', { name: 'Main Vendor' });
  expect([cu.status, cu.body.code, ve.status, ve.body.code]).toEqual([201, 1, 201, 1]);
  err(await w.api('post', '/weaving/customers', { name: 'main party' }), 422, 'NAME_TAKEN');
  // a main party cannot be used in a yarn inward
  err(await w.api('post', '/weaving/yarn-inwards', { vendorId: mainVe.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, ratePerLb: 1 }), 422, 'UNKNOWN_VENDOR');
  err(await w.api('post', '/weaving/yarn-inwards', { customerId: mainCu.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, contractLineId: '11111111-1111-4111-8111-111111111111' }), 422, 'UNKNOWN_CUSTOMER');
  expect((await w.api('post', '/weaving/yarn-inwards', { vendorId: ve.body.id, itemId: w.item.id, bags: 1, lbsPerBag: 100, ratePerLb: 1 })).status).toBe(201);
  // the main lists (Grey Store / stores) show only the main parties
  const grey = await Service.findAll({ where: { code: ['GREY_STORE', 'GENERAL_STORE'] } });
  for (const s of grey) await CompanyService.findOrCreate({ where: { companyId: w.company.id, serviceId: s.id } });
  const main = (await w.api('get', '/customers')).body;
  expect(main.data.map((c) => c.name)).toEqual(['Main Party']);
  expect((await w.api('get', '/vendors')).body.data.map((c) => c.name)).toEqual(['Main Vendor']);
  err(await w.api('get', `/customers/${cu.body.id}`), 404, 'NOT_FOUND');
  expect((await w.api('post', '/customers', { name: 'Third' })).body.code).toBe(2);
  expect((await w.api('post', '/weaving/customers', { name: 'Third' })).body.code).toBe(2);
});

test('yarn stock: per item card and lbs per bag; inward added up, balance = inward - outward; filters; deleted entries leave the stock', async () => {
  const w = await setup();
  const vendor = (await w.api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const customer = (await w.api('post', '/weaving/customers', { name: 'Ali' })).body;
  const brand2 = (await w.api('post', '/weaving/brands', { name: 'Reliance' })).body;
  const item2 = (await w.api('post', '/weaving/item-cards', { yarnCountId: w.count.id, brandId: brand2.id, packing: 12, bags: 50 })).body;
  const post = async (b) => w.api('post', '/weaving/yarn-inwards', await withContract(w.api, b.itemId === w.item.id ? w.item : item2, b));
  const a = (await post({ vendorId: vendor.id, itemId: w.item.id, bags: 10, lbsPerBag: 100, ratePerLb: 10, inwardDate: '2026-11-01' })).body;
  await post({ vendorId: vendor.id, itemId: w.item.id, bags: 5, lbsPerBag: 100, ratePerLb: 12, inwardDate: '2026-11-05' });
  await post({ customerId: customer.id, itemId: w.item.id, bags: 4, lbsPerBag: 50.5, inwardDate: '2026-11-06' });
  await post({ vendorId: vendor.id, itemId: item2.id, bags: 2, lbsPerBag: 50, ratePerLb: 9, inwardDate: '2026-11-07' });

  const s = (await w.api('get', '/weaving/yarn-stock')).body;
  expect(s.total).toBe(3);
  const row100 = s.data.find((r) => r.itemId === w.item.id && r.lbsPerBag === 100);
  expect(row100).toMatchObject({ name: '22|s Cotton - Crescent - 24 - 100', yarnCount: { name: '22|s Cotton' }, brand: { name: 'Crescent' }, packing: 24, lbsPerBag: 100,
    inwardBags: 15, inwardLbs: 1500, outwardBags: 0, outwardLbs: 0, balanceBags: 15, balanceLbs: 1500 });
  expect(s.data.find((r) => r.lbsPerBag === 50.5)).toMatchObject({ balanceBags: 4, balanceLbs: 202 });
  expect(s.data.find((r) => r.itemId === item2.id)).toMatchObject({ packing: 12, balanceBags: 2, balanceLbs: 100 });
  expect(s.totals).toEqual({ inwardBags: 21, inwardLbs: 1802, outwardBags: 0, outwardLbs: 0, balanceBags: 21, balanceLbs: 1802 });

  // filters
  expect((await w.api('get', '/weaving/yarn-stock?type=OVERHEAD')).body.totals.balanceBags).toBe(4);
  expect((await w.api('get', '/weaving/yarn-stock?type=PURCHASE')).body.totals.balanceBags).toBe(17);
  expect((await w.api('get', `/weaving/yarn-stock?brandId=${brand2.id}`)).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-stock?search=reliance')).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-stock?dateTo=2026-11-01')).body.totals.balanceBags).toBe(10);
  expect((await w.viewer('get', '/weaving/yarn-stock')).status).toBe(200);

  // a deleted entry leaves the stock; a row with nothing left is hidden unless asked for
  await w.api('delete', `/weaving/yarn-inwards/${a.id}`);
  expect((await w.api('get', '/weaving/yarn-stock')).body.data.find((r) => r.lbsPerBag === 100 && r.itemId === w.item.id).balanceBags).toBe(5);
  const only = (await w.api('get', `/weaving/yarn-inwards?itemId=${item2.id}`)).body.data[0];
  await w.api('delete', `/weaving/yarn-inwards/${only.id}`);
  expect((await w.api('get', '/weaving/yarn-stock')).body.total).toBe(2);

  // another company sees nothing of it
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/yarn-stock')).body.total).toBe(0);
});
