const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account, Customer } = require('../src/models');
const journal = require('../src/services/journalService');
const { today } = require('../src/utils/dates');

jest.setTimeout(240000);
beforeEach(clean);

// owner plan N-C2: receivable ageing and the credit follow-up notes
const SERVICES = ['ACC_COA', 'ACC_RECEIPTS', 'ACC_REPORTS', 'ACC_SALES', 'SO_CARD'];
const day = (n, from = today()) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const production = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: production.id, serviceId: (await Service.findOne({ where: { code: 'SO_CARD' } })).id, access: 'FULL' });
  const as = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  const api = as(admin);
  expect((await api('post', '/accounts/apply-template', { templateKey: 'other' })).status).toBe(200);
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  const id = async (code) => (await Account.findOne({ where: { companyId: company.id, code } })).id;
  const post = (entry) => sequelize.transaction((t) => journal.post(req, entry, t));
  let n = 0;
  const customer = (name, extra = {}) => Customer.create({ companyId: company.id, code: (n += 1), name, ...extra });
  return { company, api, productionApi: as(production), id, post, customer };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };

let counter = 0;
/** An approved sales invoice (no tax) with its entry on the customer's ledger; `received` is the part already paid (and its entry). */
async function invoice(w, customer, { net, date, dueDate = null, received = 0 }) {
  counter += 1;
  const [[inv]] = await sequelize.query(`INSERT INTO sales_invoices ("companyId", "voucherNo", "invoiceNo", "invoiceDate", "dueDate", "customerId", "taxRate", "grossAmount", "taxAmount", "netAmount", "receivedAmount", status, "approvedAt")
    VALUES (:c, :n, :n, :date, :dueDate, :customer, 0, :net, 0, :net, :received, 'APPROVED', now()) RETURNING id`, { replacements: { c: w.company.id, n: counter, date, dueDate, customer: customer.id, net, received } });
  await w.post({ entryDate: date, sourceType: 'SALES_INVOICE', sourceId: inv.id, narration: `Sales invoice ${counter}`, lines: [
    { accountId: await w.id('1103'), debit: net, partyType: 'CUSTOMER', partyId: customer.id }, { accountId: await w.id('4001'), credit: net }] });
  if (received) {
    await w.post({ entryDate: date, sourceType: 'RECEIPT_VOUCHER', sourceId: inv.id, narration: 'Receipt', lines: [
      { accountId: await w.id('1101'), debit: received }, { accountId: await w.id('1103'), credit: received, partyType: 'CUSTOMER', partyId: customer.id }] });
  }
  return inv.id;
}
/** The customer paid in advance: no invoice, only the ledger. */
async function advance(w, customer, amount) {
  await w.post({ entryDate: today(), sourceType: 'RECEIPT_VOUCHER', sourceId: customer.id, narration: 'Advance', lines: [
    { accountId: await w.id('1101'), debit: amount }, { accountId: await w.id('1103'), credit: amount, partyType: 'CUSTOMER', partyId: customer.id }] });
}

test('receivable ageing: buckets by due date, advances beside them, credit limit and 60 days on top, the total is the ledger and the receivable account', async () => {
  const w = await setup();
  const a = await w.customer('A TEXTILES', { creditDays: 15 }); // due = invoice date + 15
  const b = await w.customer('B PROCESSING', { creditLimit: 6000 });
  const c = await w.customer('C APPAREL');
  const d = await w.customer('D CLEAN');
  void d;
  await invoice(w, a, { net: 10000, date: day(-120), received: 2000 }); // due 105 days ago: over 90, 8,000 unpaid
  await invoice(w, a, { net: 5000, date: day(-50) }); // due 35 days ago: 31-60
  await invoice(w, a, { net: 4000, date: day(-5) }); // due in 10 days: not due yet
  await invoice(w, b, { net: 8000, date: day(-10), dueDate: day(-10) }); // 10 days past due: 1-30, over its limit of 6,000
  await advance(w, c, 3000); // C paid 3,000 in advance: -3,000, no invoice

  const r = await ok(w.api('get', '/reports/receivable-ageing'));
  const rows = r.sections[0].rows;
  // A (over 90 days) and B (over the limit) are on top, then by balance
  expect(rows.map((x) => x.name)).toEqual(['A TEXTILES', 'B PROCESSING', 'C APPAREL']);
  expect(rows[0]).toMatchObject({ current: 4000, d1_30: 0, d31_60: 5000, d61_90: 0, d90plus: 8000, other: 0, balance: 17000, openInvoices: 3, maxDaysPastDue: 105, attention: true, attentionReasons: ['OVER_60_DAYS'], creditLimit: null, availableCredit: null });
  expect(rows[0].oldestInvoiceDate).toBe(day(-120));
  expect(rows[1]).toMatchObject({ d1_30: 8000, balance: 8000, overLimit: true, availableCredit: -2000, attentionReasons: ['OVER_LIMIT'], attention: true });
  expect(rows[2]).toMatchObject({ other: -3000, balance: -3000, openInvoices: 0, attention: false }); // an advance is negative
  expect(r.sections[0].totals).toMatchObject({ current: 4000, d31_60: 5000, d90plus: 8000, d1_30: 8000, other: -3000, balance: 22000, customers: 3, attention: 2 });
  // every row adds up to the ledger balance, and all of them to the receivable account of the trial balance
  for (const x of rows) expect(x.current + x.d1_30 + x.d31_60 + x.d61_90 + x.d90plus + x.other).toBeCloseTo(x.balance, 2);
  expect(r.reconciliation).toEqual({ customersTotal: 22000, controlAccountBalance: 22000, difference: 0 });
  expect(r.buckets).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus']);

  // filters
  expect((await ok(w.api('get', '/reports/receivable-ageing?tab=attention'))).sections[0].rows).toHaveLength(2);
  expect((await ok(w.api('get', `/reports/receivable-ageing?customerId=${b.id}`))).sections[0].rows.map((x) => x.name)).toEqual(['B PROCESSING']);
  expect((await ok(w.api('get', '/reports/receivable-ageing?search=apparel'))).sections[0].rows).toHaveLength(1);
  expect((await ok(w.api('get', '/reports'))).reports.map((x) => x.key)).toContain('receivable-ageing');
});

test('receivable ageing: the bucket borders (day 30 and day 31, 60 / 61, 90 / 91) and the day it is counted from', async () => {
  const w = await setup();
  const a = await w.customer('A TEXTILES');
  await invoice(w, a, { net: 1000, date: day(0), dueDate: day(0) }); // due today
  const bucket = async (asOf) => { const row = (await ok(w.api('get', `/reports/receivable-ageing?asOf=${asOf}`))).sections[0].rows[0]; return ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'].filter((k) => row[k] === 1000)[0]; };
  expect(await bucket(day(0))).toBe('current'); // due today is not past due
  expect(await bucket(day(1))).toBe('d1_30');
  expect(await bucket(day(30))).toBe('d1_30');
  expect(await bucket(day(31))).toBe('d31_60');
  expect(await bucket(day(60))).toBe('d31_60');
  expect(await bucket(day(61))).toBe('d61_90');
  expect(await bucket(day(90))).toBe('d61_90');
  expect(await bucket(day(91))).toBe('d90plus');
  expect(await bucket(day(-5))).toBe('current'); // counted from a day before the due date
});

test('credit follow-up notes and the customer detail; rights and the other company', async () => {
  const w = await setup();
  const other = await setup();
  const a = await w.customer('A TEXTILES');
  await invoice(w, a, { net: 7000, date: day(-40), dueDate: day(-40) });
  // notes: text only; the latest shows on the report
  const none = await ok(w.api('get', `/customers/${a.id}/follow-ups`));
  expect(none.data).toEqual([]);
  const one = await ok(w.api('post', `/customers/${a.id}/follow-ups`, { note: 'Called the accountant, cheque promised', promisedDate: day(5), promisedAmount: 4000 }), 201);
  expect(one.data[0]).toMatchObject({ date: today(), note: 'Called the accountant, cheque promised', promisedDate: day(5), promisedAmount: 4000 });
  await ok(w.api('post', `/customers/${a.id}/follow-ups`, { date: day(-1), note: 'Sent the statement' }), 201);
  const list = await ok(w.api('get', `/customers/${a.id}/follow-ups`));
  expect(list.data.map((x) => x.note)).toEqual(['Called the accountant, cheque promised', 'Sent the statement']); // newest first
  const row = (await ok(w.api('get', '/reports/receivable-ageing'))).sections[0].rows[0];
  expect(row).toMatchObject({ followUps: 2, lastFollowUp: { note: 'Called the accountant, cheque promised', promisedDate: day(5), promisedAmount: 4000 } });
  await fails(w.api('post', `/customers/${a.id}/follow-ups`, { date: day(0), note: 'x ok', promisedDate: day(-3) }), 422, 'PROMISE_BEFORE_NOTE');
  await fails(w.api('post', `/customers/${a.id}/follow-ups`, { note: '' }), 400, 'VALIDATION_FAILED');

  // the drawer: the unpaid invoices of one customer with their age, and the notes
  const d = await ok(w.api('get', `/reports/receivable-ageing/${a.id}`));
  expect(d).toMatchObject({ balance: 7000, customer: { name: 'A TEXTILES' } });
  expect(d.invoices).toHaveLength(1);
  expect(d.invoices[0]).toMatchObject({ unpaid: 7000, daysPastDue: 40, bucket: 'd31_60', dueDate: day(-40) });
  expect(d.followUps).toHaveLength(2);

  // rights: a production user (SO card only) sees nothing of it; another company sees nothing
  await fails(w.productionApi('get', '/reports/receivable-ageing'), 403, 'FORBIDDEN');
  await fails(w.productionApi('get', `/reports/receivable-ageing/${a.id}`), 403, 'FORBIDDEN');
  expect((await w.productionApi('get', `/customers/${a.id}/follow-ups`)).status).toBe(403);
  expect((await w.productionApi('post', `/customers/${a.id}/follow-ups`, { note: 'no' })).status).toBe(403);
  expect((await ok(other.api('get', '/reports/receivable-ageing'))).sections[0].rows).toHaveLength(0);
  await fails(other.api('get', `/reports/receivable-ageing/${a.id}`), 404, 'NOT_FOUND');
  await fails(other.api('get', `/customers/${a.id}/follow-ups`), 404, 'NOT_FOUND');
  await fails(other.api('post', `/customers/${a.id}/follow-ups`, { note: 'steal' }), 404, 'NOT_FOUND');
});
