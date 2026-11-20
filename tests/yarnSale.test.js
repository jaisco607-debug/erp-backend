const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account } = require('../src/models');

const { withContract } = require('./contractHelper');
jest.setTimeout(240000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const SERVICES = ['WEAVING_MASTERS', 'ACC_COA', 'ACC_SALES', 'ACC_RECEIPTS', 'ACC_REPORTS', 'GREY_STORE'];

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of SERVICES) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  // a weaving user who may make the sale but may not make accounting documents
  const weaver = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: weaver.id, serviceId: s.WEAVING_MASTERS.id, access: 'FULL' });
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const vendor = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const buyer = (await api('post', '/weaving/customers', { name: 'Ali Traders', creditDays: 30 })).body;
  const buyer2 = (await api('post', '/weaving/customers', { name: 'Second Buyer' })).body;
  const owner = (await api('post', '/weaving/customers', { name: 'Own Yarn Party' })).body;
  const inward = async (b) => (await api('post', '/weaving/yarn-inwards', await withContract(api, item, { itemId: item.id, ...b }))).body;
  const p1 = await inward({ vendorId: vendor.id, bags: 10, lbsPerBag: 100, ratePerLb: 300, inwardDate: '2026-11-01' });
  const p2 = await inward({ vendorId: vendor.id, bags: 5, lbsPerBag: 50, ratePerLb: 310, inwardDate: '2026-11-02' });
  const o1 = await inward({ customerId: owner.id, bags: 8, lbsPerBag: 100, inwardDate: '2026-11-03' });
  return { company, s, api, weaver: call(weaver), vendor, buyer, buyer2, owner, p1, p2, o1, item };
}
const journalOf = async (companyId) => (await sequelize.query('SELECT count(*)::int AS entries, COALESCE(SUM(debit),0)::float AS debit, COALESCE(SUM(credit),0)::float AS credit FROM journal_lines WHERE "companyId" = :c', { replacements: { c: companyId }, type: sequelize.QueryTypes.SELECT }))[0];

test('yarn sale (weaving): only the challan and gate pass, no invoice fields; purchased yarn only; stock goes down; change / delete while not invoiced', async () => {
  const w = await setup();
  // only OUR purchased yarn can be picked for a sale (not the customer's own yarn)
  const pick = (await w.api('get', '/weaving/yarn-sales/stock-entries')).body;
  expect(pick.data.map((e) => [e.code, e.type, e.balanceBags])).toEqual([[1, 'PURCHASE', 10], [2, 'PURCHASE', 5]]);

  const sale = await w.weaver('post', '/weaving/yarn-sales', { customerId: w.buyer.id, outwardDate: '2026-11-05', description: 'direct yarn sale',
    lines: [{ inwardId: w.p1.id, bags: 4, ratePerLb: 350 }, { inwardId: w.p2.id, bags: 2, ratePerLb: 360.5 }] });
  expect(sale.status).toBe(201);
  // 4 x 100 lbs at 350 = 140,000;  2 x 50 lbs at 360.5 = 36,050
  expect(sale.body).toMatchObject({ type: 'SALE', challanNo: 1, challanText: '00001', outwardDate: '2026-11-05', description: 'direct yarn sale', party: { kind: 'CUSTOMER', name: 'Ali Traders' },
    totalBags: 6, totalLbs: 500, totalAmount: 176050, invoiced: false, invoice: null, canEdit: true, canDelete: true });
  expect(sale.body.lines.map((l) => [l.inwardCode, l.bags, l.lbs, l.ratePerLb, l.amount])).toEqual([[1, 4, 400, 350, 140000], [2, 2, 100, 360.5, 36050]]);
  // the sale has no invoice, no tax, no accounts: nothing in the books and no default account yet
  expect(sale.body.taxRate).toBeUndefined();
  expect(sale.body.net).toBeUndefined();
  expect(await journalOf(w.company.id)).toMatchObject({ entries: 0 });
  expect(await Account.count({ where: { companyId: w.company.id, isSystem: true } })).toBe(0);
  // invoice fields are not accepted on the sale form
  expect((await w.api('post', '/weaving/yarn-sales', { customerId: w.buyer.id, taxRate: 18, lines: [{ inwardId: w.p1.id, bags: 1, ratePerLb: 1 }] })).status).toBe(400);

  // the yarn is out of the stock
  expect((await w.api('get', '/weaving/yarn-sales/stock-entries')).body.data.map((e) => [e.code, e.balanceBags])).toEqual([[1, 6], [2, 3]]);
  expect((await w.api('get', '/weaving/yarn-stock')).body.data.find((r) => r.lbsPerBag === 100)).toMatchObject({ inwardBags: 18, outwardBags: 4, balanceBags: 14 });

  // rules
  const base = { customerId: w.buyer.id, outwardDate: '2026-11-05' };
  err(await w.api('post', '/weaving/yarn-sales', { ...base, lines: [{ inwardId: w.o1.id, bags: 1, ratePerLb: 10 }] }), 422, 'OVERHEAD_NOT_SOLD');
  err(await w.api('post', '/weaving/yarn-sales', { ...base, lines: [{ inwardId: w.p1.id, bags: 7, ratePerLb: 10 }] }), 422, 'NOT_ENOUGH_STOCK');
  err(await w.api('post', '/weaving/yarn-sales', { ...base, outwardDate: '2026-10-30', lines: [{ inwardId: w.p1.id, bags: 1, ratePerLb: 10 }] }), 422, 'BEFORE_INWARD');
  err(await w.api('post', '/weaving/yarn-sales', { ...base, customerId: w.vendor.id, lines: [{ inwardId: w.p1.id, bags: 1, ratePerLb: 10 }] }), 422, 'UNKNOWN_CUSTOMER');
  expect((await w.api('post', '/weaving/yarn-sales', { ...base, lines: [{ inwardId: w.p1.id, bags: 1 }] })).status).toBe(400); // the rate is needed
  expect((await w.api('post', '/weaving/yarn-sales', { ...base, lines: [] })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-sales', { lines: [{ inwardId: w.p1.id, bags: 1, ratePerLb: 1 }] })).status).toBe(400);

  // gate pass: date, party, delivery challan number, 3 copies
  expect((await w.weaver('get', `/weaving/yarn-sales/${sale.body.id}/gate-pass`)).body).toEqual({ challanId: sale.body.id, type: 'SALE', date: '2026-11-05', party: { kind: 'CUSTOMER', id: w.buyer.id, name: 'Ali Traders' }, partyName: 'Ali Traders', challanNo: 1, challanText: '00001', copies: 3 });

  // change while not invoiced (rates, bags), then the list
  const ch = await w.api('patch', `/weaving/yarn-sales/${sale.body.id}`, { lines: [{ inwardId: w.p1.id, bags: 5, ratePerLb: 320 }], description: 'changed' });
  expect(ch.body).toMatchObject({ totalBags: 5, totalLbs: 500, totalAmount: 160000, description: 'changed' });
  const s2 = await w.api('post', '/weaving/yarn-sales', { customerId: w.buyer2.id, outwardDate: '2026-11-07', description: 'second', lines: [{ inwardId: w.p2.id, bags: 1, ratePerLb: 400 }] });
  const l = (await w.api('get', '/weaving/yarn-sales')).body;
  expect(l.data.map((x) => [x.challanNo, x.customer.name, x.totalAmount, x.invoiced])).toEqual([[2, 'Second Buyer', 20000, false], [1, 'Ali Traders', 160000, false]]);
  expect(l.summary).toEqual({ sales: 2, bags: 6, lbs: 550, amount: 180000 });
  expect((await w.api('get', `/weaving/yarn-sales?customerId=${w.buyer2.id}`)).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-sales?search=second')).body.data.map((x) => x.challanNo)).toEqual([2]);
  expect((await w.api('get', '/weaving/yarn-sales?search=00001')).body.data.map((x) => x.challanNo)).toEqual([1]);
  expect((await w.api('get', '/weaving/yarn-sales?invoiced=true')).body.total).toBe(0);
  // not in the weft / return lists
  expect((await w.api('get', '/weaving/yarn-weft')).body.total).toBe(0);
  err(await w.api('get', `/weaving/yarn-returns/${s2.body.id}`), 404, 'NOT_FOUND');
  // the yarn on a sale holds its inward entry; delete a sale: the yarn is back
  err(await w.api('delete', `/weaving/yarn-inwards/${w.p2.id}`), 422, 'IN_USE');
  expect((await w.api('delete', `/weaving/yarn-sales/${s2.body.id}`)).body.deleted).toBe(true);
  expect((await w.api('get', '/weaving/yarn-sales/stock-entries')).body.data.map((e) => [e.code, e.balanceBags])).toEqual([[1, 5], [2, 5]]);
  expect((await w.api('get', `/weaving/yarn-sales/credit/${w.buyer.id}`)).body).toMatchObject({ partyType: 'CUSTOMER', name: 'Ali Traders', creditDays: 30 });
});

test('yarn sale invoice is made in the ACCOUNTS from yarn sales; approve posts the books; it shows in the accounts lists; the sale is held by the invoice; generate invoice from weaving', async () => {
  const w = await setup();
  const sale1 = (await w.api('post', '/weaving/yarn-sales', { customerId: w.buyer.id, outwardDate: '2026-11-05', description: 'first', lines: [{ inwardId: w.p1.id, bags: 4, ratePerLb: 350 }, { inwardId: w.p2.id, bags: 2, ratePerLb: 360.5 }] })).body; // 176,050
  const sale2 = (await w.api('post', '/weaving/yarn-sales', { customerId: w.buyer.id, outwardDate: '2026-11-06', description: 'second', lines: [{ inwardId: w.p1.id, bags: 1, ratePerLb: 400 }] })).body; // 40,000
  const other = (await w.api('post', '/weaving/yarn-sales', { customerId: w.buyer2.id, outwardDate: '2026-11-06', lines: [{ inwardId: w.p1.id, bags: 1, ratePerLb: 100 }] })).body; // 10,000

  // the accounts picker: the yarn sales of the customer that can still be billed
  const pick = (await w.api('get', `/sales-invoices/yarn-sales?customerId=${w.buyer.id}`)).body;
  expect(pick.data.map((x) => [x.challanNo, x.bags, x.lbs, x.amount, x.canBill])).toEqual([[2, 1, 100, 40000, true], [1, 6, 500, 176050, true]]);

  // rules of the invoice
  err(await w.api('post', '/sales-invoices', { customerId: w.buyer.id, yarnSaleIds: [other.id] }), 422, 'SALE_OTHER_CUSTOMER');
  expect((await w.api('post', '/sales-invoices', { customerId: w.buyer.id, yarnSaleIds: [sale1.id], gatePassIds: [sale1.id] })).status).toBe(400); // one kind only
  expect((await w.api('post', '/sales-invoices', { customerId: w.buyer.id })).status).toBe(400);
  err(await w.api('post', '/sales-invoices', { customerId: w.buyer.id, yarnSaleIds: ['11111111-1111-4111-8111-111111111111'] }), 404, 'NOT_FOUND');
  expect(await Account.count({ where: { companyId: w.company.id, isSystem: true } })).toBe(0);

  // one invoice for two sales of the customer: gross 216,050, tax 18 % = 38,889, net 254,939
  const inv = await w.api('post', '/sales-invoices', { customerId: w.buyer.id, yarnSaleIds: [sale1.id, sale2.id], invoiceDate: '2026-11-07', taxRate: 18, notes: 'yarn' });
  expect(inv.status).toBe(201);
  expect(inv.body).toMatchObject({ kind: 'YARN', kindText: 'Yarn', voucherNo: 1, invoiceNo: 1, status: 'UNAPPROVED', taxRate: 18, gross: 216050, tax: 38889, net: 254939, qty: 600, qtyUnit: 'lbs',
    hsCode: null, dueDate: '2026-12-07', customer: { name: 'Ali Traders' }, canEdit: true, canApprove: true });
  expect(inv.body.lines.map((l) => [l.challanNo, l.bags, l.lbs, l.amount, l.items.length])).toEqual([[1, 6, 500, 176050, 2], [2, 1, 100, 40000, 1]]);
  expect(inv.body.lines[0].items[0]).toMatchObject({ brand: { name: 'Crescent' }, lbsPerBag: 100, bags: 4, ratePerLb: 350, amount: 140000 });
  // a draft posts nothing but the three default accounts exist from now on
  expect(await journalOf(w.company.id)).toMatchObject({ entries: 0 });
  expect((await Account.findAll({ where: { companyId: w.company.id, isSystem: true }, raw: true })).map((a) => a.systemKey).sort()).toEqual(['AR_CONTROL', 'DEFAULT_SALES', 'OUTPUT_TAX']);

  // the sales are on the invoice now: not in the picker, held in weaving
  expect((await w.api('get', `/sales-invoices/yarn-sales?customerId=${w.buyer.id}`)).body.total).toBe(0);
  expect((await w.api('get', `/sales-invoices/yarn-sales?customerId=${w.buyer.id}&invoiceId=${inv.body.id}`)).body.total).toBe(2); // while editing it
  const held = (await w.api('get', `/weaving/yarn-sales/${sale1.id}`)).body;
  expect(held).toMatchObject({ invoiced: true, canEdit: false, canDelete: false, invoice: { id: inv.body.id, invoiceNo: 1, status: 'UNAPPROVED' } });
  err(await w.api('patch', `/weaving/yarn-sales/${sale1.id}`, { description: 'x' }), 422, 'SALE_INVOICED');
  err(await w.api('delete', `/weaving/yarn-sales/${sale1.id}`), 422, 'SALE_INVOICED');
  err(await w.api('post', '/sales-invoices', { customerId: w.buyer.id, yarnSaleIds: [sale1.id] }), 422, 'SALE_TAKEN');
  err(await w.api('post', `/weaving/yarn-sales/${sale1.id}/generate-invoice`, {}), 422, 'ALREADY_INVOICED');
  expect((await w.api('get', '/weaving/yarn-sales?invoiced=true')).body.total).toBe(2);

  // change the invoice (only one sale, no tax), then back
  const only = await w.api('patch', `/sales-invoices/${inv.body.id}`, { yarnSaleIds: [sale1.id], taxRate: 0 });
  expect(only.body).toMatchObject({ gross: 176050, tax: 0, net: 176050 });
  expect((await w.api('get', `/weaving/yarn-sales/${sale2.id}`)).body.invoiced).toBe(false); // free again
  err(await w.api('patch', `/sales-invoices/${inv.body.id}`, { gatePassIds: [sale1.id] }), 422, 'WRONG_INVOICE_KIND');
  const back = await w.api('patch', `/sales-invoices/${inv.body.id}`, { yarnSaleIds: [sale1.id, sale2.id], taxRate: 18 });
  expect(back.body).toMatchObject({ gross: 216050, tax: 38889, net: 254939 });

  // approve (in the accounts): Debit Accounts Receivable / Credit Sales / Credit Sales Tax
  const done = await w.api('post', `/sales-invoices/${inv.body.id}/approve`);
  expect(done.body).toMatchObject({ status: 'APPROVED', kind: 'YARN', canEdit: false });
  const view = (await w.api('get', `/sales-invoices/${inv.body.id}/accounts-entry`)).body;
  expect(view.current).toMatchObject({ balanced: true, totals: { debit: 254939, credit: 254939 }, entryDate: '2026-11-07', sourceType: 'SALES_INVOICE' });
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([['Accounts Receivable', 254939, 0, 'CUSTOMER'], ['Sales', 0, 216050, null], ['Output Sales Tax', 0, 38889, null]]);
  expect(view.current.lines[0].narration).toMatch(/Yarn sales invoice 00001/);
  expect((await w.api('get', `/weaving/yarn-sales/${sale1.id}`)).body.invoice).toMatchObject({ status: 'APPROVED' });

  // it is a sales invoice of the accounts: in the list (kind filter), the receipt voucher's open invoices, and the party
  const list = (await w.api('get', '/sales-invoices')).body;
  expect(list.data.map((x) => [x.invoiceNo, x.kind, x.status])).toEqual([[1, 'YARN', 'APPROVED']]);
  expect((await w.api('get', '/sales-invoices?kind=CLOTH')).body.total).toBe(0);
  expect((await w.api('get', '/sales-invoices?kind=YARN')).body.total).toBe(1);
  expect(JSON.stringify((await w.api('get', `/receipt-vouchers/invoices?customerId=${w.buyer.id}`)).body)).toContain('"invoiceNo":1');
  // the customer is in the accounts' customer list (both lists), not in the Grey Store's default list
  expect((await w.api('get', '/customers?module=ALL')).body.data.map((c) => [c.name, c.module]).sort()).toEqual([['Ali Traders', 'WEAVING'], ['Own Yarn Party', 'WEAVING'], ['Second Buyer', 'WEAVING']]);
  expect((await w.api('get', '/customers')).body.total).toBe(0);
  expect((await w.api('get', '/customers?module=WEAVING')).body.total).toBe(3);

  // an approved invoice cannot be changed or deleted; money received blocks un-approve
  err(await w.api('patch', `/sales-invoices/${inv.body.id}`, { notes: 'x' }), 422, 'INVOICE_APPROVED');
  err(await w.api('delete', `/sales-invoices/${inv.body.id}`), 422, 'INVOICE_APPROVED');
  await sequelize.query('UPDATE sales_invoices SET "receivedAmount" = 100 WHERE id = :id', { replacements: { id: inv.body.id } });
  err(await w.api('post', `/sales-invoices/${inv.body.id}/unapprove`, {}), 422, 'HAS_RECEIPTS');
  await sequelize.query('UPDATE sales_invoices SET "receivedAmount" = 0 WHERE id = :id', { replacements: { id: inv.body.id } });
  const un = await w.api('post', `/sales-invoices/${inv.body.id}/unapprove`, { reason: 'wrong rate' });
  expect(un.body.status).toBe('UNAPPROVED');
  expect(await journalOf(w.company.id)).toEqual({ entries: 6, debit: 509878, credit: 509878 });

  // delete the invoice: the sales are free again; "Generate invoice" from weaving makes the draft invoice of ONE sale (needs the accounting right)
  expect((await w.api('delete', `/sales-invoices/${inv.body.id}`)).status).toBe(204);
  expect((await w.api('get', `/weaving/yarn-sales/${sale1.id}`)).body).toMatchObject({ invoiced: false, canEdit: true });
  err(await w.weaver('post', `/weaving/yarn-sales/${sale2.id}/generate-invoice`, {}), 403, 'FORBIDDEN');
  const gen = await w.api('post', `/weaving/yarn-sales/${sale2.id}/generate-invoice`, { taxRate: 5 });
  expect(gen.status).toBe(201);
  expect(gen.body.invoice).toMatchObject({ kind: 'YARN', status: 'UNAPPROVED', gross: 40000, tax: 2000, net: 42000, invoiceDate: '2026-11-06', invoiceNo: 1 });
  expect(gen.body.sale).toMatchObject({ invoiced: true, invoice: { invoiceNo: 1, status: 'UNAPPROVED' } });
  // the accountant approves it in the accounts
  expect((await w.api('post', `/sales-invoices/${gen.body.invoice.id}/approve`)).body.status).toBe('APPROVED');

  // another company sees nothing
  const o = await makeCompany();
  for (const c of ['WEAVING_MASTERS', 'ACC_SALES']) await CompanyService.create({ companyId: o.id, serviceId: (await Service.findOne({ where: { code: c } })).id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: o.id }));
  expect((await oa('get', '/weaving/yarn-sales')).body.total).toBe(0);
  err(await oa('get', `/weaving/yarn-sales/${sale2.id}`), 404, 'NOT_FOUND');
  err(await oa('post', `/weaving/yarn-sales/${sale2.id}/generate-invoice`, {}), 404, 'NOT_FOUND');
});
