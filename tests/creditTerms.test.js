const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, Account, Customer, Vendor } = require('../src/models');
const journal = require('../src/services/journalService');

beforeEach(clean);

const SERVICES = ['ACC_COA', 'ACC_PAYMENTS', 'ACC_RECEIPTS', 'ACC_REPORTS', 'ACC_SALES', 'ACC_PURCHASES', 'GREY_STORE', 'CHEMICAL_STORE'];
const token = async (u) => ({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
const caller = (auth) => (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = caller(await token(admin));
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  expect((await api('post', '/accounts/apply-template', { templateKey: 'other' })).status).toBe(200);
  const id = async (code) => (await Account.findOne({ where: { companyId: company.id, code } })).id;
  const post = (entry) => sequelize.transaction((t) => journal.post(req, entry, t));
  let n = 0;
  const customer = (name, extra = {}) => Customer.create({ companyId: company.id, code: (n += 1), name, ...extra });
  const vendor = (name, extra = {}) => Vendor.create({ companyId: company.id, code: (n += 1), name, ...extra });
  return { company, admin, api, req, id, post, customer, vendor };
}

const ok = async (p, status = 201) => { const r = await p; expect(r.status).toBe(status); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); expect(r.body.error.code).toBe(code); return r.body.error; };

let counter = 0;
/** An approved sales invoice (no tax) with its entry; `dueDate` may be left out (then invoice date + the customer's credit days). */
async function salesInvoice(w, customer, { net, date = '2026-10-01', dueDate = null }) {
  counter += 1;
  const [[inv]] = await sequelize.query(`INSERT INTO sales_invoices ("companyId", "voucherNo", "invoiceNo", "invoiceDate", "dueDate", "customerId", "taxRate", "grossAmount", "taxAmount", "netAmount", status, "approvedAt")
    VALUES (:c, :n, :n, :date, :dueDate, :customer, 0, :net, 0, :net, 'APPROVED', now()) RETURNING id`, { replacements: { c: w.company.id, n: counter, date, dueDate, customer: customer.id, net } });
  await w.post({ entryDate: date, sourceType: 'SALES_INVOICE', sourceId: inv.id, narration: `Sales invoice ${counter}`, lines: [
    { accountId: await w.id('1103'), debit: net, partyType: 'CUSTOMER', partyId: customer.id }, { accountId: await w.id('4001'), credit: net },
  ] });
  return inv.id;
}
async function purchaseInvoice(w, vendor, { net, date = '2026-10-01', dueDate = null }) {
  counter += 1;
  const [[inv]] = await sequelize.query(`INSERT INTO purchase_invoices ("companyId", "voucherNo", "invoiceDate", "dueDate", "vendorId", "grossAmount", "taxAmount", "netAmount", status, "approvedAt")
    VALUES (:c, :n, :date, :dueDate, :vendor, :net, 0, :net, 'APPROVED', now()) RETURNING id`, { replacements: { c: w.company.id, n: counter, date, dueDate, vendor: vendor.id, net } });
  await w.post({ entryDate: date, sourceType: 'PURCHASE_INVOICE', sourceId: inv.id, narration: `Purchase invoice ${counter}`, lines: [
    { accountId: await w.id('5001'), debit: net }, { accountId: await w.id('2101'), credit: net, partyType: 'VENDOR', partyId: vendor.id },
  ] });
  return inv.id;
}

test('credit terms on the customer and vendor forms: a limit (optional) and days; bad values are refused', async () => {
  const w = await setup();
  const c = await ok(w.api('post', '/customers', { name: 'AZ TEXTILES' }));
  expect(c).toMatchObject({ creditLimit: null, creditDays: 0 });
  const c2 = await ok(w.api('post', '/customers', { name: 'BILAL', creditLimit: 500000.5, creditDays: 30 }));
  expect(c2).toMatchObject({ creditLimit: 500000.5, creditDays: 30 });
  expect(await ok(w.api('patch', `/customers/${c2.id}`, { creditLimit: null }), 200)).toMatchObject({ creditLimit: null, creditDays: 30 });
  expect(await ok(w.api('patch', `/customers/${c2.id}`, { creditLimit: 0, creditDays: 45 }), 200)).toMatchObject({ creditLimit: 0, creditDays: 45 });
  for (const bad of [{ creditDays: -1 }, { creditDays: 3651 }, { creditDays: 1.5 }, { creditDays: '10' }, { creditDays: null }, { creditLimit: -5 }, { creditLimit: 'abc' }, { creditLimit: 1.234 }]) {
    await fails(w.api('patch', `/customers/${c2.id}`, bad), 400, 'VALIDATION_FAILED');
  }
  expect((await ok(w.api('get', `/customers/${c2.id}`), 200))).toMatchObject({ creditLimit: 0, creditDays: 45 });

  const v = await ok(w.api('post', '/vendors', { name: 'NEXUS CHEMICAL', creditDays: 15 }));
  expect(v).toMatchObject({ creditLimit: null, creditDays: 15 });
  expect(await ok(w.api('patch', `/vendors/${v.id}`, { creditLimit: 250000 }), 200)).toMatchObject({ creditLimit: 250000, creditDays: 15 });
  await fails(w.api('patch', `/vendors/${v.id}`, { creditDays: -3 }), 400, 'VALIDATION_FAILED');
  const list = await ok(w.api('get', '/vendors'), 200);
  expect(list.data.find((x) => x.id === v.id)).toMatchObject({ creditLimit: 250000, creditDays: 15 });
});

test('credit status of a party: limit, balance, what is left; a party of another company is not found', async () => {
  const w = await setup();
  const c = await w.customer('AZ TEXTILES', { creditLimit: 100000, creditDays: 10 });
  const v = await w.vendor('NEXUS CHEMICAL', { creditDays: 20 });
  await salesInvoice(w, c, { net: 40000 });
  await purchaseInvoice(w, v, { net: 7000.25 });
  expect(await ok(w.api('get', `/sales-invoices/credit/${c.id}`), 200)).toMatchObject({ partyType: 'CUSTOMER', name: 'AZ TEXTILES', creditLimit: '100000.00', creditDays: 10, balance: '40000.00', available: '60000.00', exceeded: false, exceededBy: null });
  expect(await ok(w.api('get', `/purchase-invoices/credit/${v.id}`), 200)).toMatchObject({ partyType: 'VENDOR', creditLimit: null, creditDays: 20, balance: '7000.25', available: null, exceeded: false });
  await salesInvoice(w, c, { net: 70000.5 });
  expect(await ok(w.api('get', `/sales-invoices/credit/${c.id}`), 200)).toMatchObject({ balance: '110000.50', available: '-10000.50', exceeded: true, exceededBy: '10000.50' });
  const other = await setup();
  const alien = await other.customer('ALIEN');
  await fails(w.api('get', `/sales-invoices/credit/${alien.id}`), 404, 'NOT_FOUND');
  await fails(w.api('get', `/purchase-invoices/credit/${c.id}`), 404, 'NOT_FOUND');
});

test('due schedule: unpaid invoices and bills by due date (overdue, today, next 15 / 30 / 60 days), the net of both sides, party rows and documents', async () => {
  const w = await setup();
  const c1 = await w.customer('AZ TEXTILES', { creditDays: 10 });
  const c2 = await w.customer('BILAL');
  const v1 = await w.vendor('NEXUS CHEMICAL', { creditDays: 30 });
  await salesInvoice(w, c1, { net: 1000, date: '2026-10-01' }); // no due date: 1 Oct + 10 = 11 Oct, 18 days overdue
  await salesInvoice(w, c1, { net: 2000, date: '2026-10-20', dueDate: '2026-11-05' }); // in 7 days
  await salesInvoice(w, c2, { net: 4000, date: '2026-10-20', dueDate: '2026-11-20' }); // in 22 days
  await salesInvoice(w, c2, { net: 8000, date: '2026-10-29', dueDate: '2026-10-29' }); // today
  await salesInvoice(w, c2, { net: 16000, date: '2026-09-01', dueDate: '2026-09-02' }); // 57 days overdue
  await salesInvoice(w, c2, { net: 32000, date: '2026-10-29', dueDate: '2027-03-01' }); // far away
  await purchaseInvoice(w, v1, { net: 500, date: '2026-10-10', dueDate: '2026-11-10' }); // in 12 days
  await purchaseInvoice(w, v1, { net: 250, date: '2026-10-01' }); // 1 Oct + 30 = 31 Oct: in 2 days

  const r = await ok(w.api('get', '/accounting/due-schedule?date=2026-10-29'), 200);
  expect(r).toMatchObject({ date: '2026-10-29', bucketDays: [15, 30, 60] });
  const by = (side) => Object.fromEntries(r[side].buckets.map((b) => [b.key, b]));
  const rec = by('receivable');
  expect(r.receivable.buckets.map((b) => b.key)).toEqual(['OVERDUE_OVER_60', 'OVERDUE_31_60', 'OVERDUE_16_30', 'OVERDUE_1_15', 'DUE_TODAY', 'DUE_1_15', 'DUE_16_30', 'DUE_31_60', 'DUE_AFTER_60']);
  expect(rec.OVERDUE_31_60).toMatchObject({ count: 1, balance: '16000.00' });
  expect(rec.OVERDUE_16_30).toMatchObject({ count: 1, balance: '1000.00' });
  expect(rec.OVERDUE_1_15).toMatchObject({ count: 0, balance: '0.00' });
  expect(rec.DUE_TODAY).toMatchObject({ count: 1, balance: '8000.00' });
  expect(rec.DUE_1_15).toMatchObject({ count: 1, balance: '2000.00', upToDays: 15, cumulative: '10000.00' });
  expect(rec.DUE_16_30).toMatchObject({ count: 1, balance: '4000.00', upToDays: 30, cumulative: '14000.00' });
  expect(rec.DUE_AFTER_60).toMatchObject({ count: 1, balance: '32000.00' });
  expect(r.receivable).toMatchObject({ total: '63000.00', count: 6, overdue: '17000.00', notYetDue: '46000.00' });
  const pay = by('payable');
  expect(pay.DUE_1_15).toMatchObject({ count: 2, balance: '750.00', cumulative: '750.00' });
  expect(r.payable).toMatchObject({ total: '750.00', overdue: '0.00' });
  expect(r.net.find((n) => n.key === 'DUE_1_15').balance).toBe('1250.00'); // 2,000 to come in - 750 to pay out
  expect(r.net.find((n) => n.key === 'OVERDUE_31_60').balance).toBe('16000.00');
  expect(r.netTotal).toBe('62250.00');
  // party rows: every bucket per party
  const bilal = r.receivable.parties.find((p) => p.name === 'BILAL');
  expect(bilal).toMatchObject({ count: 4, total: '60000.00' });
  expect(bilal.buckets).toMatchObject({ OVERDUE_31_60: '16000.00', DUE_TODAY: '8000.00', DUE_16_30: '4000.00', DUE_AFTER_60: '32000.00', DUE_1_15: '0.00' });
  // documents on request, the most overdue first
  const d = await ok(w.api('get', '/accounting/due-schedule?date=2026-10-29&detail=true&search=NEXUS'), 200);
  expect(d.receivable.count).toBe(0);
  expect(d.payable.documents.map((x) => [x.dueDate, x.daysToDue, x.balance, x.bucket])).toEqual([['2026-10-31', 2, '250.00', 'DUE_1_15'], ['2026-11-10', 12, '500.00', 'DUE_1_15']]);
  // own bucket days
  const own = await ok(w.api('get', '/accounting/due-schedule?date=2026-10-29&buckets=7,14'), 200);
  expect(own.bucketDays).toEqual([7, 14]);
  expect(own.receivable.buckets.find((b) => b.key === 'DUE_1_7')).toMatchObject({ count: 1, balance: '2000.00' });
  expect(own.receivable.buckets.find((b) => b.key === 'DUE_AFTER_14')).toMatchObject({ count: 2, balance: '36000.00' });
  for (const bad of ['0', 'abc', '1,2,3,4,5,6,7,8,9', '15,,30', '4000']) await fails(w.api('get', `/accounting/due-schedule?buckets=${bad}`), 400, 'VALIDATION_FAILED');
  const nobody = caller(await token(await makeUser({ userType: 'USER', companyId: w.company.id })));
  await fails(nobody('get', '/accounting/due-schedule'), 403, 'FORBIDDEN');
});
