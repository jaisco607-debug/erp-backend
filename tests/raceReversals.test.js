const { app, request, clean, makeUser, makeCompany, loginAs, raceTwice, expectOneSuccess } = require('./helpers');
const { Service, CompanyService, StoreItem } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

const SERVICES = ['CHEMICAL_STORE', 'GENERAL_STORE', 'ACC_COA', 'ACC_PURCHASES', 'ACC_REPORTS'];

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  return { company, api: (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };

// owner 2026-11-24 (A3.1): stock 100, a return of 60 gives 40, two cancels sent together must give back 60 once: stock 100, not 160
test('two cancels of a vendor return at the same moment put the stock back once', async () => {
  const w = await setup();
  const vendor = await ok(w.api('post', '/vendors', { name: 'RACE CHEM' }), 201);
  const item = await ok(w.api('post', '/stores/chemical/items', { name: 'Race Acid', unit: 'KG' }), 201);
  const inw = await ok(w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, approve: true, inwardDate: '2026-10-10', lines: [{ itemId: item.id, qty: 100, rate: 50 }] }), 201);
  const ret = await ok(w.api('post', '/stores/chemical/vendor-returns', { returnDate: '2026-10-12', vendorId: vendor.id, reason: 'DAMAGED', lines: [{ inwardLineId: inw.lines[0].id, qty: 60 }] }), 201);
  const stock = async () => Number((await StoreItem.findByPk(item.id)).stockQty);
  expect(await stock()).toBe(40);

  const { bad } = expectOneSuccess(await raceTwice(() => w.api('post', `/stores/chemical/vendor-returns/${ret.id}/cancel`, { reason: 'double click' })));
  expect(bad.body.error.code).toBe('ALREADY_CANCELLED');
  expect(await stock()).toBe(100);
});

test('two approvals and two un-approvals of a purchase return invoice at the same moment count once', async () => {
  const w = await setup();
  const vendor = await ok(w.api('post', '/vendors', { name: 'RACE CHEM 2' }), 201);
  const item = await ok(w.api('post', '/stores/chemical/items', { name: 'Race Soda', unit: 'KG' }), 201);
  const inw = await ok(w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, approve: true, inwardDate: '2026-10-10', lines: [{ itemId: item.id, qty: 100, rate: 100 }] }), 201);
  const bill = await ok(w.api('post', '/purchase-invoices', { vendorId: vendor.id, inwardIds: [inw.id], invoiceDate: '2026-10-20' }), 201);
  await ok(w.api('post', `/purchase-invoices/${bill.id}/approve`));
  const ret = await ok(w.api('post', '/stores/chemical/vendor-returns', { returnDate: '2026-10-25', vendorId: vendor.id, reason: 'DAMAGED', lines: [{ inwardLineId: inw.lines[0].id, qty: 40 }] }), 201);
  const pr = await ok(w.api('post', '/purchase-returns', { vendorId: vendor.id, vendorReturnIds: [ret.id], returnDate: '2026-10-25' }), 201);

  expectOneSuccess(await raceTwice(() => w.api('post', `/purchase-returns/${pr.id}/approve`)));
  expect(await ok(w.api('get', `/purchase-invoices/${bill.id}`))).toMatchObject({ returnedAmount: 4000, balance: 6000 });
  expectOneSuccess(await raceTwice(() => w.api('post', `/purchase-returns/${pr.id}/unapprove`, {})));
  expect(await ok(w.api('get', `/purchase-invoices/${bill.id}`))).toMatchObject({ returnedAmount: 0, balance: 10000 });
});

// owner 2026-11-24 (A3.3): a double click on approve / un-approve must count once, in the store and in the purchase bill
test('two approvals and two un-approvals of a store purchase and of a purchase bill at the same moment count once', async () => {
  const w = await setup();
  const vendor = await ok(w.api('post', '/vendors', { name: 'RACE CHEM 3' }), 201);
  const item = await ok(w.api('post', '/stores/chemical/items', { name: 'Race Lime', unit: 'KG' }), 201);
  const stock = async () => Number((await StoreItem.findByPk(item.id)).stockQty);
  const inw = await ok(w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, inwardDate: '2026-10-10', lines: [{ itemId: item.id, qty: 100, rate: 100 }] }), 201);

  expectOneSuccess(await raceTwice(() => w.api('post', `/stores/chemical/inwards/${inw.id}/approve`)));
  expect(await stock()).toBe(100);
  const bill = await ok(w.api('post', '/purchase-invoices', { vendorId: vendor.id, inwardIds: [inw.id], invoiceDate: '2026-10-20' }), 201);
  expectOneSuccess(await raceTwice(() => w.api('post', `/purchase-invoices/${bill.id}/approve`)));
  expect(await ok(w.api('get', `/purchase-invoices/${bill.id}`))).toMatchObject({ balance: 10000 });
  expectOneSuccess(await raceTwice(() => w.api('post', `/purchase-invoices/${bill.id}/unapprove`, {})));
  await ok(w.api('delete', `/purchase-invoices/${bill.id}`), 204);
  expectOneSuccess(await raceTwice(() => w.api('post', `/stores/chemical/inwards/${inw.id}/unapprove`, {})));
  expect(await stock()).toBe(0);
});
