const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(180000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);

async function setup() {
  const company = await makeCompany();
  const svc = await Service.findOne({ where: { code: 'WEAVING_MASTERS' } });
  await CompanyService.create({ companyId: company.id, serviceId: svc.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: svc.id, access: 'VIEW' });
  const api = call(admin);
  const c22 = (await api('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const c30 = (await api('post', '/weaving/yarn-counts', { name: '30|s Cotton' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item22 = (await api('post', '/weaving/item-cards', { yarnCountId: c22.id, brandId: brand.id })).body;
  const item30 = (await api('post', '/weaving/item-cards', { yarnCountId: c30.id, brandId: brand.id })).body;
  const vendor = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const customer = (await api('post', '/weaving/customers', { name: 'Ali Traders' })).body;
  const other = (await api('post', '/weaving/customers', { name: 'Bilal Traders' })).body;
  return { api, viewer: call(viewer), c22, c30, item22, item30, vendor, customer, other };
}

test('yarn contracts: purchase and overhead; balance, close, lines, delete rules', async () => {
  const w = await setup();
  const fd = (await w.api('get', '/weaving/yarn-contracts/form-data')).body;
  expect(fd.kinds.map((k) => k.text)).toEqual(['Contract Yarn Purchase', 'Weaving Overhead Sell Contract']);
  expect(fd.defaultTaxPercent).toBe(18);
  expect(fd.yarnCounts).toHaveLength(2);

  // purchase contract with a vendor: bags x bag weight = lbs, rate, tax
  const p = await w.api('post', '/weaving/yarn-contracts', { kind: 'PURCHASE', vendorId: w.vendor.id, notes: 'first', lines: [
    { yarnCountId: w.c22.id, bags: 115, bagWeight: 100, ratePerLb: 245 }, { yarnCountId: w.c30.id, bags: 150, bagWeight: 100, ratePerLb: 235 }] });
  expect(p.status).toBe(201);
  expect(p.body).toMatchObject({ kind: 'PURCHASE', code: 1, codeLabel: '0001', status: 'OPEN', taxPercent: 18, party: { kind: 'VENDOR', name: 'Yarn Mills' } });
  expect(p.body.lines.map((l) => [l.lineNo, l.lbs, l.amount, l.balanceLbs])).toEqual([[1, 11500, 2817500, 11500], [2, 15000, 3525000, 15000]]);
  expect(p.body.totals).toMatchObject({ bags: 265, lbs: 26500, subtotal: 6342500, taxAmount: 1141650, net: 7484150, deliveredLbs: 0, balanceLbs: 26500 });
  // a purchase line needs a rate; lbs without bags is fine on an overhead one
  expect((await w.api('post', '/weaving/yarn-contracts', { kind: 'PURCHASE', vendorId: w.vendor.id, lines: [{ yarnCountId: w.c22.id, lbs: 100 }] })).status).toBe(422);
  expect((await w.api('post', '/weaving/yarn-contracts', { kind: 'PURCHASE', customerId: w.customer.id, lines: [{ yarnCountId: w.c22.id, lbs: 100, ratePerLb: 1 }] })).status).toBe(422);
  const o = await w.api('post', '/weaving/yarn-contracts', { kind: 'OVERHEAD', customerId: w.customer.id, taxPercent: 0, lines: [{ yarnCountId: w.c22.id, lbs: 280 }] });
  expect(o.status).toBe(201);
  expect(o.body).toMatchObject({ code: 1, kindText: 'Weaving Overhead Sell Contract', party: { kind: 'CUSTOMER' } });
  expect(o.body.lines[0]).toMatchObject({ lbs: 280, bags: null, ratePerLb: null, amount: null });
  const oLine = o.body.lines[0].id;

  // overhead yarn of a customer cannot come in without a contract
  const base = { customerId: w.customer.id, itemId: w.item22.id, bags: 1, lbsPerBag: 100 };
  const none = await w.api('post', '/weaving/yarn-inwards', base);
  expect([none.status, none.body.error?.code || none.body.code]).toEqual([422, 'CONTRACT_REQUIRED']);
  // wrong contract: another customer's, a purchase line, another yarn count
  expect((await w.api('post', '/weaving/yarn-inwards', { ...base, customerId: w.other.id, contractLineId: oLine })).status).toBe(422);
  expect((await w.api('post', '/weaving/yarn-inwards', { ...base, contractLineId: p.body.lines[0].id })).status).toBe(422);
  expect((await w.api('post', '/weaving/yarn-inwards', { ...base, itemId: w.item30.id, contractLineId: oLine })).status).toBe(422);
  // the picker offers the open lines of the party
  const pick = (await w.api('get', `/weaving/yarn-contracts/open-lines?customerId=${w.customer.id}&itemId=${w.item22.id}`)).body.data;
  expect(pick.map((l) => [l.id, l.balanceLbs, l.contract.codeLabel])).toEqual([[oLine, 280, '0001']]);

  // two part deliveries: 100 + 100 lbs; the balance goes down
  const a = await w.api('post', '/weaving/yarn-inwards', { ...base, contractLineId: oLine });
  expect(a.status).toBe(201);
  expect(a.body.contract).toMatchObject({ kind: 'OVERHEAD', codeLabel: '0001', lineNo: 1 });
  await w.api('post', '/weaving/yarn-inwards', { ...base, bags: 1, contractLineId: oLine });
  let d = (await w.api('get', `/weaving/yarn-contracts/${o.body.id}`)).body;
  expect(d.lines[0]).toMatchObject({ deliveredLbs: 200, balanceLbs: 80, percentDone: 71.4, deliveries: 2, deliveryStatus: 'PART' });
  expect(d.inwardCount).toBe(2);
  expect(d.deliverySummary[0]).toMatchObject({ orderedLbs: 280, deliveredLbs: 200, balanceLbs: 80, statusText: 'Part delivered' });
  // the list shows ordered / delivered / balance and the totals
  const lst = (await w.api('get', '/weaving/yarn-contracts?kind=OVERHEAD')).body;
  expect(lst.data[0]).toMatchObject({ orderedLbs: 280, deliveredLbs: 200, balanceLbs: 80, goods: '22|s Cotton' });
  expect(lst.totals).toMatchObject({ orderedLbs: 280, deliveredLbs: 200, balanceLbs: 80 });
  expect(lst.counts).toEqual({ open: 1, closed: 0 });
  expect((await w.api('get', '/weaving/yarn-inwards?contractId=' + o.body.id)).body.total).toBe(2);
  expect((await w.api('get', '/weaving/yarn-inwards?noContract=true')).body.total).toBe(0);

  // lines with yarn in: cannot be deleted, quantity not below delivered, yarn quality fixed; the contract cannot be deleted or change party
  expect((await w.api('delete', `/weaving/yarn-contracts/${o.body.id}/lines/${oLine}`)).status).toBe(422);
  expect((await w.api('patch', `/weaving/yarn-contracts/${o.body.id}/lines/${oLine}`, { lbs: 150 })).status).toBe(422);
  expect((await w.api('patch', `/weaving/yarn-contracts/${o.body.id}/lines/${oLine}`, { yarnCountId: w.c30.id })).status).toBe(422);
  expect((await w.api('patch', `/weaving/yarn-contracts/${o.body.id}/lines/${oLine}`, { lbs: 300, ratePerLb: 12 })).body.lines[0]).toMatchObject({ lbs: 300, amount: 3600, balanceLbs: 100 });
  expect((await w.api('delete', `/weaving/yarn-contracts/${o.body.id}`)).status).toBe(422);
  expect((await w.api('patch', `/weaving/yarn-contracts/${o.body.id}`, { customerId: w.other.id })).status).toBe(422);

  // close the line / the contract: no new inward; activate again
  await w.api('post', `/weaving/yarn-contracts/${o.body.id}/lines/${oLine}/close`);
  expect((await w.api('post', '/weaving/yarn-inwards', { ...base, contractLineId: oLine })).status).toBe(422);
  expect((await w.api('get', `/weaving/yarn-contracts/open-lines?customerId=${w.customer.id}`)).body.data).toHaveLength(0);
  await w.api('post', `/weaving/yarn-contracts/${o.body.id}/lines/${oLine}/activate`);
  const closed = (await w.api('post', `/weaving/yarn-contracts/${o.body.id}/close`)).body;
  expect(closed).toMatchObject({ status: 'CLOSED', statusText: 'Closed' });
  expect((await w.api('post', '/weaving/yarn-inwards', { ...base, contractLineId: oLine })).status).toBe(422);
  expect((await w.api('get', '/weaving/yarn-contracts?status=CLOSED')).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-contracts?status=OPEN')).body).toMatchObject({ total: 1, counts: { open: 1, closed: 1 } });
  // an existing entry on the closed contract can still be edited
  expect((await w.api('patch', `/weaving/yarn-inwards/${a.body.id}`, { dcNo: '55' })).status).toBe(200);
  // an overhead entry cannot lose its contract
  expect((await w.api('patch', `/weaving/yarn-inwards/${a.body.id}`, { contractLineId: null })).status).toBe(422);
  await w.api('post', `/weaving/yarn-contracts/${o.body.id}/activate`);

  // purchase: contract optional; with one and no rate, the rate of the line is used; wrong vendor / kind refused
  const v1 = await w.api('post', '/weaving/yarn-inwards', { vendorId: w.vendor.id, itemId: w.item22.id, bags: 10, lbsPerBag: 100, ratePerLb: 250 });
  expect([v1.status, v1.body.contract]).toEqual([201, null]);
  const v2 = await w.api('post', '/weaving/yarn-inwards', { vendorId: w.vendor.id, itemId: w.item22.id, bags: 20, lbsPerBag: 100, contractLineId: p.body.lines[0].id });
  expect([v2.status, v2.body.ratePerLb, v2.body.amount, v2.body.contract.codeLabel]).toEqual([201, 245, 490000, '0001']);
  expect((await w.api('post', '/weaving/yarn-inwards', { vendorId: w.vendor.id, itemId: w.item22.id, bags: 1, lbsPerBag: 100, ratePerLb: 1, contractLineId: oLine })).status).toBe(422);
  const pd = (await w.api('get', `/weaving/yarn-contracts/${p.body.id}`)).body;
  expect(pd.lines[0]).toMatchObject({ deliveredLbs: 2000, balanceLbs: 9500, bagsIn: 20 });
  expect(pd.totals).toMatchObject({ deliveredLbs: 2000, balanceLbs: 24500, percentDone: 7.5 });

  // delete: an unused contract goes (its number is not reused); the last line stays
  const p2 = (await w.api('post', '/weaving/yarn-contracts', { kind: 'PURCHASE', vendorId: w.vendor.id, lines: [{ yarnCountId: w.c22.id, lbs: 50, ratePerLb: 1 }] })).body;
  expect(p2.code).toBe(2);
  expect((await w.api('delete', `/weaving/yarn-contracts/${p2.id}/lines/${p2.lines[0].id}`)).status).toBe(422);
  expect((await w.api('delete', `/weaving/yarn-contracts/${p2.id}`)).body).toEqual({ deleted: true, id: p2.id });
  expect((await w.api('get', `/weaving/yarn-contracts/${p2.id}`)).status).toBe(404);
  expect((await w.api('post', '/weaving/yarn-contracts', { kind: 'PURCHASE', vendorId: w.vendor.id, lines: [{ yarnCountId: w.c22.id, lbs: 50, ratePerLb: 1 }] })).body.code).toBe(3);
  // add a line to the first purchase contract
  const added = await w.api('post', `/weaving/yarn-contracts/${p.body.id}/lines`, { yarnCountId: w.c22.id, bags: 5, bagWeight: 50, ratePerLb: 300 });
  expect([added.status, added.body.lines.length, added.body.lines[2].lbs]).toEqual([201, 3, 250]);

  // the viewer reads, cannot write
  expect((await w.viewer('get', '/weaving/yarn-contracts')).body.total).toBe(3);
  expect((await w.viewer('post', '/weaving/yarn-contracts', { kind: 'OVERHEAD', customerId: w.customer.id, lines: [{ yarnCountId: w.c22.id, lbs: 1 }] })).status).toBe(403);
});
