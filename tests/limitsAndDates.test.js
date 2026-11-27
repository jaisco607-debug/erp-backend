const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');
const { businessRange, addYears } = require('../src/utils/dates');

jest.setTimeout(240000);
beforeEach(clean);

const SERVICES = ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'ACC_COA', 'ACC_PURCHASES'];

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  return { company, api: (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };

// owner 2026-11-24 (A1.1, A2.1): dates at most 5 years from today; thaan length and quantities at most 100,000; no limit on rates
test('GET /limits tells the screens the usual maximums and the allowed dates', async () => {
  const w = await setup();
  const l = await ok(w.api('get', '/limits'));
  const r = businessRange();
  expect(l.dates).toMatchObject({ today: r.today, min: r.min, max: r.max, years: 5 });
  expect(l.numbers).toMatchObject({ meters: 100000, quantity: 100000, unitsPerShift: 100000, lotNo: 999999, lotNoAhead: 1000, voucherAmount: 1000000000, basicSalary: 5000000 });
  expect(l.decimals).toEqual({ meters: 2 });
  expect(r.max).toBe(addYears(r.today, 5));
});

test('a document date more than 5 years from today is refused; the report filters stay free', async () => {
  const w = await setup();
  const r = businessRange();
  const cu = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const ql = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const lot = (inwardDate) => w.api('post', '/grey-lots', { inwardDate, customerId: cu.id, qualityId: ql.id, thaans: [100, 120] });

  for (const bad of ['2062-01-01', '1900-01-01', '2099-12-31', addYears(r.today, -6), addYears(r.today, 6)]) {
    const e = await fails(lot(bad), 422, 'DATE_OUT_OF_RANGE');
    expect(e.details).toMatchObject({ field: 'inwardDate', value: bad, min: r.min, max: r.today });
  }
  // the first allowed day and today (a stock document is not dated ahead)
  await ok(lot(r.min), 201);

  await ok(lot(r.today), 201);
  // a store purchase with the same rule, another module
  const vendor = await ok(w.api('post', '/vendors', { name: 'V1' }), 201);
  const item = await ok(w.api('post', '/stores/chemical/items', { name: 'Acid', unit: 'KG' }), 201);
  await fails(w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, inwardDate: '2062-01-01', lines: [{ itemId: item.id, qty: 1, rate: 10 }] }), 422, 'DATE_OUT_OF_RANGE');
  // the filters of a list are not documents: a far dateTo is fine
  await ok(w.api('get', '/grey-lots?dateTo=2099-12-31'));
});

test('thaan length, quantities, lot number and vendor limits; rates have none', async () => {
  const w = await setup();
  const cu = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const ql = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const lot = (body) => w.api('post', '/grey-lots', { inwardDate: businessRange().today, customerId: cu.id, qualityId: ql.id, ...body });
  const validation = async (p, field) => { const r = await p; expect(r.status).toBe(400); expect(r.body.error.details.some((d) => d.field.includes(field))).toBe(true); return r.body.error; };

  // thaan length: 100,000 m is the most; 10.123 is refused, not rounded; a float like 12.299999999999999 is not a typed decimal
  await validation(lot({ thaans: [100001] }), 'thaans');
  const tooLong = await validation(lot({ thaans: [10.123] }), 'thaans');
  expect(JSON.stringify(tooLong)).toContain('at most 2 decimals');
  await ok(lot({ thaans: [100000, 10.5, 12.299999999999999] }), 201);
  await validation(lot({ meters: 99999999 }), 'meters');

  // lot number: at most 999,999; a typed number is at most 1,000 above the next automatic one
  await validation(lot({ thaans: [10], lotNo: 1000000 }), 'lotNo');
  await fails(lot({ thaans: [10], lotNo: 5000 }), 422, 'LOT_NO_TOO_FAR');
  await ok(lot({ thaans: [10], lotNo: 500 }), 201);
  await ok(lot({ thaans: [10] }), 201); // the automatic number continues after 500

  // a store purchase: a vendor is required; the quantity of a line is at most 100,000; a rate of any size is not limited by us
  const vendor = await ok(w.api('post', '/vendors', { name: 'V1' }), 201);
  const item = await ok(w.api('post', '/stores/chemical/items', { name: 'Acid', unit: 'KG' }), 201);
  const inward = (body) => w.api('post', '/stores/chemical/inwards', { inwardDate: businessRange().today, ...body });
  await fails(inward({ lines: [{ itemId: item.id, qty: 5, rate: 10 }] }), 422, 'VENDOR_REQUIRED');
  await validation(inward({ vendorId: vendor.id, lines: [{ itemId: item.id, qty: 100001, rate: 10 }] }), 'qty');
  await ok(inward({ vendorId: vendor.id, lines: [{ itemId: item.id, qty: 100000, rate: 5000000 }] }), 201);
});

// owner 2026-11-25: every company sets its own limits (one value for all the quantities, or one for each); rates stay free
test('Settings > Limits: one value for all the quantities, a value for each, back to the standard; another company is not touched; rates have none', async () => {
  const w = await setup();
  const other = await setup();
  const today = businessRange().today;
  const cu = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const ql = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const lot = (thaans) => w.api('post', '/grey-lots', { inwardDate: today, customerId: cu.id, qualityId: ql.id, thaans });
  const validation = async (p) => { const r = await p; expect(r.status).toBe(400); return r.body.error; };
  const vendor = await ok(w.api('post', '/vendors', { name: 'V1' }), 201);
  const item = await ok(w.api('post', '/stores/chemical/items', { name: 'Acid', unit: 'KG' }), 201);
  const inward = (qty, rate = 10) => w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, inwardDate: today, lines: [{ itemId: item.id, qty, rate }] });

  const s0 = await ok(w.api('get', '/limits/settings'));
  expect(s0).toMatchObject({ allQuantities: null });
  expect(s0.items.find((i) => i.key === 'meters')).toMatchObject({ standard: 100000, custom: null, effective: 100000, group: 'quantity' });

  // one value for all the quantities
  await ok(w.api('put', '/limits/settings', { allQuantities: 500 }));
  expect((await ok(w.api('get', '/limits'))).numbers).toMatchObject({ meters: 500, storeQty: 500, bags: 500, unitsPerShift: 500, lotNo: 999999, voucherAmount: 1000000000 }); // the lot number and the money are not quantities
  await validation(lot([501]));
  await ok(lot([500]), 201);
  await validation(inward(501));
  await ok(inward(500, 5000000), 201); // a rate of any size
  // a value for one item wins over the value for all
  await ok(w.api('put', '/limits/settings', { limits: { meters: 2000 } }));
  await ok(lot([2000]), 201);
  await validation(lot([2001]));
  await validation(inward(501)); // the store quantity is still the value for all
  // the other company keeps the standard values
  expect((await ok(other.api('get', '/limits'))).numbers.meters).toBe(100000);
  // back to the standard: null for one item, null for all
  await ok(w.api('put', '/limits/settings', { allQuantities: null, limits: { meters: null } }));
  expect((await ok(w.api('get', '/limits'))).numbers).toMatchObject({ meters: 100000, storeQty: 100000 });
  await ok(lot([100000]), 201);
  // refused: above what the database holds, a name that is not a limit, a normal user
  await validation(w.api('put', '/limits/settings', { limits: { yarnBags: 5000000 } }));
  await validation(w.api('put', '/limits/settings', { limits: { rate: 5 } }));
  const user = await makeUser({ userType: 'USER', companyId: w.company.id });
  const token = (await loginAs(user)).accessToken;
  expect((await request(app).put('/api/v1/limits/settings').set({ Authorization: `Bearer ${token}` }).send({ allQuantities: 5 })).status).toBe(403);
  expect((await request(app).get('/api/v1/limits').set({ Authorization: `Bearer ${token}` })).status).toBe(200); // everybody reads the numbers
});

test('date rules of a company: stock documents are not dated ahead, vouchers a few days ahead, nothing before the opening date', async () => {
  const w = await setup();
  const { windowsOf } = require('../src/services/limitsService');
  const r = businessRange();
  const std = windowsOf(null);
  expect(std.stock).toEqual({ min: r.min, max: r.today }); // 0 days ahead
  const plus = (n) => { const d = new Date(`${r.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  expect(std.voucher.max).toBe(plus(31));
  expect(std.other.max).toBe(r.max);

  const cu = await ok(w.api('post', '/customers', { name: 'AZ' }), 201);
  const ql = await ok(w.api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const lot = (inwardDate) => w.api('post', '/grey-lots', { inwardDate, customerId: cu.id, qualityId: ql.id, thaans: [100] });
  const e = await fails(lot(plus(1)), 422, 'DATE_OUT_OF_RANGE'); // tomorrow: a stock document is not dated ahead
  expect(e.details).toMatchObject({ field: 'inwardDate', max: r.today });
  await ok(lot(r.today), 201);
  // the company allows 3 days ahead for stock, and an opening date 10 days ago
  await ok(w.api('put', '/limits/settings', { maxFutureDaysStock: 3, openingDate: plus(-10) }));
  await ok(lot(plus(3)), 201);
  await fails(lot(plus(4)), 422, 'DATE_OUT_OF_RANGE');
  await fails(lot(plus(-11)), 422, 'DATE_OUT_OF_RANGE'); // before the opening date
  await ok(lot(plus(-10)), 201);
  await fails(w.api('put', '/limits/settings', { openingDate: plus(5) }), 422, 'OPENING_DATE_FUTURE');
  const l = await ok(w.api('get', '/limits'));
  expect(l.dates).toMatchObject({ openingDate: plus(-10), stock: { min: plus(-10), max: plus(3) } });
});
