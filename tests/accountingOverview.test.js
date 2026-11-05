const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account, Customer, Vendor, StoreItem } = require('../src/models');
const journal = require('../src/services/journalService');
const { today } = require('../src/utils/dates');
const { monthsBack } = require('../src/services/storeOverviewService');

beforeEach(clean);

const ALL = ['ACC_COA', 'ACC_PAYMENTS', 'ACC_RECEIPTS', 'ACC_JOURNAL', 'ACC_REPORTS', 'ACC_SALES', 'ACC_PURCHASES', 'ACC_BANK', 'CHEMICAL_STORE', 'GENERAL_STORE'];
const MONEY = /^-?\d+\.\d{2}$/;
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 201) => { const r = await p; expect(r.status).toBe(status); return r.body; };

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of ALL) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  expect((await api('post', '/accounts/apply-template', { templateKey: 'other' })).status).toBe(200);
  const id = async (code) => (await Account.findOne({ where: { companyId: company.id, code } })).id;
  const post = (entry) => sequelize.transaction((t) => journal.post(req, entry, t));
  return { company, s, admin, api, id, post };
}

let counter = 0;
async function salesInvoice(w, customer, { net, date, status = 'APPROVED' }) {
  counter += 1;
  const [[inv]] = await sequelize.query(`INSERT INTO sales_invoices ("companyId", "voucherNo", "invoiceNo", "invoiceDate", "customerId", "taxRate", "grossAmount", "taxAmount", "netAmount", status, "approvedAt")
    VALUES (:c, :n, :n, :date, :customer, 0, :net, 0, :net, :status, :at) RETURNING id`, { replacements: { c: w.company.id, n: counter, date, customer: customer.id, net, status, at: status === 'APPROVED' ? new Date() : null } });
  if (status === 'APPROVED') {
    await w.post({ entryDate: date, sourceType: 'SALES_INVOICE', sourceId: inv.id, narration: `Sales invoice ${counter}`, lines: [
      { accountId: await w.id('1103'), debit: net, partyType: 'CUSTOMER', partyId: customer.id }, { accountId: await w.id('4001'), credit: net }] });
  }
  return inv.id;
}
async function purchaseInvoice(w, vendor, { net, date }) {
  counter += 1;
  const [[inv]] = await sequelize.query(`INSERT INTO purchase_invoices ("companyId", "voucherNo", "invoiceDate", "vendorId", "grossAmount", "taxAmount", "netAmount", status, "approvedAt")
    VALUES (:c, :n, :date, :vendor, :net, 0, :net, 'APPROVED', now()) RETURNING id`, { replacements: { c: w.company.id, n: counter, date, vendor: vendor.id, net } });
  await w.post({ entryDate: date, sourceType: 'PURCHASE_INVOICE', sourceId: inv.id, narration: `Purchase invoice ${counter}`, lines: [
    { accountId: await w.id('5001'), debit: net }, { accountId: await w.id('2101'), credit: net, partyType: 'VENDOR', partyId: vendor.id }] });
  return inv.id;
}

test('accounting overview: every block from the existing numbers, money as strings, the same as the party balances / profit and loss / balance sheet reports', async () => {
  const w = await setup();
  const day = today();
  const c1 = await Customer.create({ companyId: w.company.id, code: 1, name: 'FORGENTIS' });
  const c2 = await Customer.create({ companyId: w.company.id, code: 2, name: 'AJ GROUPS' });
  const v1 = await Vendor.create({ companyId: w.company.id, code: 3, name: 'OWAIS CHEMICALS' });
  const sold = await salesInvoice(w, c1, { net: 10000, date: day });
  await salesInvoice(w, c2, { net: 3000.5, date: '2026-06-10' }); // an old invoice, unpaid
  await salesInvoice(w, c2, { net: 700, date: day, status: 'UNAPPROVED' }); // a draft: not in today, but in the recent list
  const bought = await purchaseInvoice(w, v1, { net: 4000, date: day });
  const bank = await w.id('1102');
  const rec = await ok(w.api('post', '/receipt-vouchers', { customerId: c1.id, depositAccountId: bank, paymentMode: 'CASH', voucherDate: day, lines: [{ salesInvoiceId: sold, chequeAmount: 2500 }] }));
  await ok(w.api('post', `/receipt-vouchers/${rec.id}/confirm`), 200);
  const pay = await ok(w.api('post', '/payment-vouchers', { vendorId: v1.id, payFromAccountId: bank, paymentMode: 'ONLINE', voucherDate: day, lines: [{ purchaseInvoiceId: bought, amount: 1000 }] }));
  await ok(w.api('post', `/payment-vouchers/${pay.id}/confirm`), 200);
  await ok(w.api('post', '/payment-vouchers', { vendorId: v1.id, payFromAccountId: bank, paymentMode: 'ONLINE', voucherDate: day, lines: [{ purchaseInvoiceId: bought, amount: 500 }] })); // a draft
  const jv = await ok(w.api('post', '/journal-vouchers', { voucherDate: day, narration: 'Rent for the month', lines: [{ accountId: await w.id('1101'), debit: 50 }, { accountId: await w.id('2101'), credit: 50, partyId: v1.id }] }));
  // stock: one chemical item with value, one general item out of stock
  const red = (await w.api('post', '/stores/chemical/items', { name: 'RED', unit: 'KG' })).body;
  const bolt = (await w.api('post', '/stores/general/items', { name: 'Bolts', unit: 'PCS' })).body;
  await sequelize.query('UPDATE store_items SET "stockQty" = 4, "stockValue" = 800, "reorderLevel" = 10 WHERE id = :id', { replacements: { id: red.id } }); // low
  expect(bolt.id).toBeTruthy();

  const o = await ok(w.api('get', '/accounting/overview'), 200);
  expect(o.asOf).toBe(day);
  // today
  expect(o.today).toEqual({ sales: { net: '10000.00', count: 1 }, purchases: { net: '4000.00', count: 1 }, received: { net: '2500.00', count: 1 }, paid: { net: '1000.00', count: 1 } });
  // cash and bank: bank +2500 -1000; the journal voucher is a draft, so cash is zero
  expect(o.cashBank).toEqual({ cash: '0.00', bank: '1500.00', total: '1500.00' });
  // the same as the balances report
  const bal = await ok(w.api('get', `/accounting/balances?date=${day}`), 200);
  expect(o.partyBalances).toEqual({ receivable: bal.receivables.total, payable: bal.payables.total });
  expect(o.partyBalances).toEqual({ receivable: '10500.50', payable: '3000.00' });
  expect(o.topReceivables).toEqual([{ partyId: c1.id, name: 'FORGENTIS', balance: '7500.00' }, { partyId: c2.id, name: 'AJ GROUPS', balance: '3000.50' }]);
  expect(o.topPayables).toEqual([{ partyId: v1.id, name: 'OWAIS CHEMICALS', balance: '3000.00' }]);
  // stock: both stores are allowed; RED is low, the bolts are out (no stock)
  expect(o.stock).toEqual({ value: '800.00', lowCount: 2 });
  // profit and books are the reports' own answers
  const pl = await ok(w.api('get', '/accounting/profit-loss'), 200);
  expect(o.profit).toEqual({ result: pl.netProfit.result, amount: pl.netProfit.amount, revenue: pl.revenue.total });
  const bs = await ok(w.api('get', `/accounting/balance-sheet?date=${day}`), 200);
  expect(o.books).toEqual({ balanced: bs.balanced, difference: bs.difference });
  expect(o.books.balanced).toBe(true);
  // the months: 6, oldest first, current last; revenue / expenses as the Profit & Loss of that month
  expect(o.months.map((m) => m.month)).toEqual(monthsBack(day, 6));
  const thisMonth = o.months[5];
  const plMonth = await ok(w.api('get', `/accounting/profit-loss?dateFrom=${day.slice(0, 7)}-01&dateTo=${day}`), 200);
  expect(thisMonth).toEqual({ month: day.slice(0, 7), revenue: plMonth.revenue.total, expenses: String((Number(plMonth.costOfSales.total) + Number(plMonth.expenses.total)).toFixed(2)) });
  expect(thisMonth).toMatchObject({ revenue: '10000.00', expenses: '4000.00' });
  // vouchers: all dates, all statuses of the kinds
  expect(o.vouchers).toEqual({ confirmed: 2, draft: 2, byKind: { payment: 2, receipt: 1, journal: 1 } });
  expect(o.recentVouchers).toHaveLength(4);
  expect(o.recentVouchers.map((v) => v.kind).sort()).toEqual(['journal', 'payment', 'payment', 'receipt']);
  const recentRec = o.recentVouchers.find((v) => v.kind === 'receipt');
  expect(recentRec).toEqual({ kind: 'receipt', id: rec.id, label: String(rec.voucherNo).padStart(5, '0'), date: day, title: 'FORGENTIS', amount: '2500.00', status: 'CONFIRMED' });
  expect(o.recentVouchers.find((v) => v.kind === 'journal')).toMatchObject({ id: jv.id, title: 'Rent for the month', status: 'DRAFT' });
  // recent invoices: newest first, any status; the draft has no payment status
  expect(o.recentSales.map((s) => [s.name, s.status, s.paymentStatus, s.net, s.balance])).toEqual([
    ['AJ GROUPS', 'UNAPPROVED', null, '700.00', '700.00'], ['FORGENTIS', 'APPROVED', 'PARTIAL', '10000.00', '7500.00'], ['AJ GROUPS', 'APPROVED', 'UNPAID', '3000.50', '3000.50']]);
  expect(o.recentSales[1].ref).toMatch(/^Invoice \d{5}$/);
  expect(o.recentPurchases).toEqual([{ id: bought, name: 'OWAIS CHEMICALS', ref: expect.stringMatching(/^Voucher \d{5}$/), date: day, net: '4000.00', balance: '3000.00', status: 'APPROVED', paymentStatus: 'PARTIAL' }]);

  // every money value is a string with 2 decimals, every count an integer
  const walk = (x, path = '') => {
    if (Array.isArray(x)) return x.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (x && typeof x === 'object') return Object.entries(x).forEach(([k, v]) => walk(v, `${path}.${k}`));
    if (typeof x === 'number') expect(Number.isInteger(x)).toBe(true);
    return null;
  };
  walk(o);
  for (const m of [o.today.sales.net, o.cashBank.total, o.stock.value, o.profit.amount, o.profit.revenue, o.books.difference, ...o.months.flatMap((x) => [x.revenue, x.expenses])]) expect(m).toMatch(MONEY);
});

test('accounting overview: each block follows the person\'s own services (null, never 403); an empty company answers zeros and empty lists', async () => {
  const w = await setup();
  const day = today();
  const user = await makeUser({ userType: 'USER', companyId: w.company.id });
  const mine = asUser(user);
  const none = await ok(mine('get', '/accounting/overview'), 200);
  expect(none).toEqual({ asOf: day, today: { sales: null, purchases: null, received: null, paid: null }, cashBank: null, partyBalances: null, stock: null, profit: null, books: null, months: null, vouchers: null,
    topReceivables: null, topPayables: null, recentSales: null, recentPurchases: null, recentVouchers: null });
  const grant = (code) => UserService.create({ userId: user.id, serviceId: w.s[code].id, access: 'VIEW' });

  await grant('ACC_SALES');
  let o = await ok(mine('get', '/accounting/overview'), 200);
  expect(o.today).toEqual({ sales: { net: '0.00', count: 0 }, purchases: null, received: null, paid: null });
  expect(o.recentSales).toEqual([]);
  expect(o.recentPurchases).toBeNull();
  expect(o.partyBalances).toBeNull();

  await grant('ACC_RECEIPTS');
  o = await ok(mine('get', '/accounting/overview'), 200);
  expect(o.vouchers).toEqual({ confirmed: 0, draft: 0, byKind: { payment: null, receipt: 0, journal: null } }); // only the kinds she may see
  expect(o.recentVouchers).toEqual([]);
  expect(o.today.received).toEqual({ net: '0.00', count: 0 });

  await grant('ACC_REPORTS');
  await grant('ACC_COA');
  await grant('GENERAL_STORE');
  o = await ok(mine('get', '/accounting/overview'), 200);
  expect(o.partyBalances).toEqual({ receivable: '0.00', payable: '0.00' });
  expect(o.topReceivables).toEqual([]);
  expect(o.topPayables).toEqual([]);
  expect(o.cashBank).toEqual({ cash: '0.00', bank: '0.00', total: '0.00' });
  expect(o.stock).toEqual({ value: '0.00', lowCount: 0 });
  expect(o.profit).toEqual({ result: 'PROFIT', amount: '0.00', revenue: '0.00' });
  expect(o.books).toEqual({ balanced: true, difference: '0.00' });
  expect(o.months).toHaveLength(6);
  expect(o.months.every((m) => m.revenue === '0.00' && m.expenses === '0.00')).toBe(true);
  expect(o.today.purchases).toBeNull();

  // another company's data never shows; no token = 401
  const other = await setup();
  const c = await Customer.create({ companyId: other.company.id, code: 1, name: 'STRANGER' });
  await salesInvoice(other, c, { net: 999, date: day });
  const mineAgain = await ok(w.api('get', '/accounting/overview'), 200);
  expect(mineAgain.today.sales).toEqual({ net: '0.00', count: 0 });
  expect(mineAgain.topReceivables).toEqual([]);
  expect((await request(app).get('/api/v1/accounting/overview')).status).toBe(401);
  // a client admin has every block (the company has all these services)
  expect(Object.values(mineAgain).filter((v) => v === null)).toEqual([]);
  expect(StoreItem).toBeTruthy();
});
