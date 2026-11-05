const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account } = require('../src/models');

beforeEach(clean);

const SERVICES = ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', 'PACKING', 'ACC_COA', 'ACC_SALES', 'ACC_REPORTS'];
const token = async (u) => ({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
const caller = (auth) => (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of SERVICES) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = caller(await token(admin));
  return { company, s, api, admin };
}

/** The whole road of the cloth up to FINAL packing lists with gate passes (see packing.test.js): one customer, one SO card, two lists. */
async function twoGatePasses({ api, s }, customerName = 'AZ TEXTILES') {
  const cu = (await api('post', '/customers', { name: customerName, ntn: '2123864-2', city: 'Karachi' })).body;
  const q = (await api('post', '/qualities', { name: `Q ${customerName}` })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [100, 120, 80, 60] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const card = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2, 3, 4] }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const dye = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: fd.rows.find((r) => r.soCard.id === card.id).soCardLotId }] })).body;
  await api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'COMPLETE' });
  await api('put', `/departments/DYEING/jobs/${dye.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' });
  const form = (await api('get', '/departments/DYEING/send-form')).body;
  const fold = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows.find((r) => r.soCard.id === card.id).jobItemId }] })).body;
  await api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);
  const frow = (await api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`)).body;
  const ls = frow.lots[0].lines;
  await api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: [
    { greyLotId: lot.id, thaanId: ls[0].thaanId, a: 100 }, { greyLotId: lot.id, thaanId: ls[1].thaanId, b: 120 },
    { greyLotId: lot.id, thaanId: ls[2].thaanId, a: 80 }, { greyLotId: lot.id, thaanId: ls[3].thaanId, b: 60 },
  ] });
  const pack = (await api('post', `/departments/FOLDING/folding/${fold.id}/${card.id}/send-packing`, { keepRemaining: false })).body.packingJob;
  await api('post', `/departments/PACKING/jobs/${pack.id}/accept`);
  const f = (await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  const [t1, t2, t3, t4] = f.lots[0].thaans;
  const line = (t, grade, meters) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade, meters });
  const finish = async (body, destination) => {
    const pl = (await api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, ...body })).body;
    await api('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
    return (await api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { destination, vehicleNo: 'LEA-1', passDate: '2030-01-01' })).body;
  };
  // list 1: A 100 + B 120 at 50 / 25  = 5,000 + 3,000 = 8,000, billed 220 m
  const gp1 = await finish({ rateA: 50, rateB: 25, lines: [line(t1, 'A', 100), line(t2, 'B', 120)] }, 'Lahore');
  // list 2: A 80 at 40 = 3,200; B 60 has no rate: shown, not billed
  const gp2 = await finish({ rateA: 40, lines: [line(t3, 'A', 80), line(t4, 'B', 60)] }, 'Karachi');
  return { cu, gp1, gp2, card };
}

const ok = async (p, status = 201) => { const r = await p; expect(r.status).toBe(status); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); expect(r.body.error.code).toBe(code); };
const journalOf = (companyId) => sequelize.query('SELECT count(*)::int AS entries, COALESCE(SUM(debit), 0)::float AS debit, COALESCE(SUM(credit), 0)::float AS credit FROM journal_lines WHERE "companyId" = :companyId', { replacements: { companyId }, type: sequelize.QueryTypes.SELECT }).then((r) => r[0]);

test('gate passes of a customer are offered with their amounts; delivered-to venues can be filtered', async () => {
  const w = await setup();
  const { cu, gp1, gp2 } = await twoGatePasses(w);
  const other = await twoGatePasses(w, 'HAMID ENTERPRISES');

  const all = await ok(w.api('get', `/sales-invoices/gate-passes?customerId=${cu.id}`), 200);
  expect(all.total).toBe(2);
  expect(all.destinations).toEqual(['Karachi', 'Lahore']);
  const one = all.data.find((g) => g.gatePassNo === gp1.gatePassNo);
  expect(one).toMatchObject({ deliveredTo: 'Lahore', qtyA: 100, qtyB: 120, qtyCP: 0, totalQty: 220, billedQty: 220, rateA: 50, rateB: 25, amount: 8000, canBill: true, quality: 'Q AZ TEXTILES' });
  expect(all.data.find((g) => g.gatePassNo === gp2.gatePassNo)).toMatchObject({ qtyA: 80, qtyB: 60, totalQty: 140, billedQty: 80, amount: 3200 });
  expect((await ok(w.api('get', `/sales-invoices/gate-passes?customerId=${cu.id}&destination=lahore`), 200)).data.map((g) => g.gatePassNo)).toEqual([gp1.gatePassNo]);
  expect((await ok(w.api('get', `/sales-invoices/gate-passes?customerId=${other.cu.id}`), 200)).total).toBe(2);
  expect((await ok(w.api('get', `/sales-invoices/options`), 200))).toMatchObject({ defaultTaxRate: 18, defaultHsCode: '5208.1100' });
});

test('a draft invoice: totals follow the gate passes, tax is worked out, nothing reaches the books', async () => {
  const w = await setup();
  const { cu, gp1, gp2 } = await twoGatePasses(w);
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, invoiceDate: '2026-10-24', gatePassIds: [gp1.id, gp2.id], notes: 'SMELL BLACK' }));
  expect(inv).toMatchObject({
    voucherNo: 1, invoiceNo: 1, invoiceLabel: '00001', status: 'UNAPPROVED', statusText: 'Un-approved', taxRate: 18, hsCode: '5208.1100',
    gross: 11200, tax: 2016, net: 13216, received: 0, balance: 13216, qty: 300, canEdit: true, canApprove: true, canUnapprove: false, notes: 'SMELL BLACK',
    customer: { name: 'AZ TEXTILES', ntn: '2123864-2' },
  });
  expect(inv.lines.map((l) => [l.deliveredTo, l.qtyA, l.qtyB, l.billedQty, l.amount])).toEqual([['Lahore', 100, 120, 220, 8000], ['Karachi', 80, 60, 80, 3200]]);
  expect(await journalOf(w.company.id)).toMatchObject({ entries: 0 }); // a draft never touches the books
  // the three default accounts are made when the first invoice is saved (a draft posts nothing to them)
  const made = await Account.findAll({ where: { companyId: w.company.id, isSystem: true }, raw: true });
  expect(made.map((a) => a.systemKey).sort()).toEqual(['AR_CONTROL', 'DEFAULT_SALES', 'OUTPUT_TAX']);
  expect(made.every((a) => a.isActive)).toBe(true);

  // the gate passes are taken now
  expect((await ok(w.api('get', `/sales-invoices/gate-passes?customerId=${cu.id}`), 200)).total).toBe(0);
  expect((await ok(w.api('get', `/sales-invoices/gate-passes?customerId=${cu.id}&invoiceId=${inv.id}`), 200)).total).toBe(2);
  await fails(w.api('post', '/sales-invoices', { customerId: cu.id, gatePassIds: [gp1.id] }), 422, 'GATE_PASS_TAKEN');

  // change it: only the Lahore gate pass, tax 5 %
  const changed = await ok(w.api('patch', `/sales-invoices/${inv.id}`, { gatePassIds: [gp1.id], taxRate: 5, invoiceNo: 2750 }), 200);
  expect(changed).toMatchObject({ gross: 8000, tax: 400, net: 8400, invoiceNo: 2750, voucherNo: 1 });
  expect((await ok(w.api('get', `/sales-invoices/gate-passes?customerId=${cu.id}`), 200)).data.map((g) => g.gatePassNo)).toEqual([gp2.gatePassNo]); // the other one is free again
  await fails(w.api('post', '/sales-invoices', { customerId: cu.id, invoiceNo: 2750, gatePassIds: [gp2.id] }), 422, 'INVOICE_NO_TAKEN');
  const second = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, gatePassIds: [gp2.id], taxRate: 0 }));
  expect(second).toMatchObject({ invoiceNo: 2751, voucherNo: 2, gross: 3200, tax: 0, net: 3200 });

  // delete a draft: its gate pass is free again
  expect((await w.api('delete', `/sales-invoices/${second.id}`)).status).toBe(204);
  expect((await w.api('get', `/sales-invoices/${second.id}`)).status).toBe(404);
  expect((await ok(w.api('get', `/sales-invoices/gate-passes?customerId=${cu.id}`), 200)).total).toBe(1);
});

test('one invoice is for one customer; wrong gate passes are refused', async () => {
  const w = await setup();
  const a = await twoGatePasses(w);
  const b = await twoGatePasses(w, 'HAMID ENTERPRISES');
  await fails(w.api('post', '/sales-invoices', { customerId: a.cu.id, gatePassIds: [a.gp1.id, b.gp1.id] }), 422, 'GATE_PASS_OTHER_CUSTOMER');
  await fails(w.api('post', '/sales-invoices', { customerId: a.cu.id, gatePassIds: ['6b4a0f4e-0c5d-4c6e-8a55-1d6c7a9f0b11'] }), 404, 'NOT_FOUND');
  await fails(w.api('post', '/sales-invoices', { customerId: a.cu.id, gatePassIds: [] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/sales-invoices', { gatePassIds: [a.gp1.id] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/sales-invoices', { customerId: a.cu.id, gatePassIds: [a.gp1.id], taxRate: 150 }), 400, 'VALIDATION_FAILED');
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: a.cu.id, gatePassIds: [a.gp1.id] }));
  await fails(w.api('patch', `/sales-invoices/${inv.id}`, { customerId: b.cu.id }), 422, 'GATE_PASSES_REQUIRED');
  await fails(w.api('patch', `/sales-invoices/${inv.id}`, { customerId: b.cu.id, gatePassIds: [a.gp1.id] }), 422, 'GATE_PASS_OTHER_CUSTOMER');
  expect((await ok(w.api('patch', `/sales-invoices/${inv.id}`, { customerId: b.cu.id, gatePassIds: [b.gp1.id, b.gp2.id] }), 200)).customer.name).toBe('HAMID ENTERPRISES');
});

test('approve posts Debit Receivable / Credit Sales / Credit Sales Tax, makes the default accounts, and balances', async () => {
  const w = await setup();
  const { cu, gp1, gp2 } = await twoGatePasses(w);
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, invoiceDate: '2026-10-24', gatePassIds: [gp1.id, gp2.id] }));
  const done = await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  expect(done).toMatchObject({ status: 'APPROVED', statusText: 'Approved', canEdit: false, canApprove: false, canUnapprove: true, net: 13216 });

  const view = await ok(w.api('get', `/sales-invoices/${inv.id}/accounts-entry`), 200);
  expect(view).toMatchObject({ posted: true, status: 'APPROVED' });
  expect(view.current).toMatchObject({ balanced: true, totals: { debit: 13216, credit: 13216 }, entryDate: '2026-10-24', sourceType: 'SALES_INVOICE', sourceId: inv.id });
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit, l.partyType])).toEqual([
    ['Accounts Receivable', 13216, 0, 'CUSTOMER'], ['Sales', 0, 11200, null], ['Output Sales Tax', 0, 2016, null],
  ]);
  expect(view.current.lines[0].partyId).toBe(cu.id);
  expect(await journalOf(w.company.id)).toEqual({ entries: 3, debit: 13216, credit: 13216 });

  const accounts = await Account.findAll({ where: { companyId: w.company.id, isSystem: true }, raw: true });
  expect(accounts.map((a) => a.controlType).sort()).toEqual(['CUSTOMERS', 'OUTPUT_TAX', 'SALES']);

  await fails(w.api('patch', `/sales-invoices/${inv.id}`, { notes: 'x' }), 422, 'INVOICE_APPROVED');
  await fails(w.api('delete', `/sales-invoices/${inv.id}`), 422, 'INVOICE_APPROVED');
  await fails(w.api('post', `/sales-invoices/${inv.id}/approve`), 422, 'ALREADY_APPROVED');
  // the account that holds the entries cannot be deleted any more
  const sales = accounts.find((a) => a.controlType === 'SALES');
  await fails(w.api('delete', `/accounts/${sales.id}`), 422, 'SYSTEM_LOCKED');
});

test('an invoice without tax posts two lines and needs no tax account', async () => {
  const w = await setup();
  const { cu, gp1 } = await twoGatePasses(w);
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, gatePassIds: [gp1.id], taxRate: 0 }));
  await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  const view = await ok(w.api('get', `/sales-invoices/${inv.id}/accounts-entry`), 200);
  expect(view.current.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Accounts Receivable', 8000, 0], ['Sales', 0, 8000]]);
  // the tax account was made when the invoice was saved, but nothing is posted to it
  const taxAccount = await Account.findOne({ where: { companyId: w.company.id, controlType: 'OUTPUT_TAX' } });
  expect(taxAccount).not.toBeNull();
  expect((await sequelize.query('SELECT count(*)::int AS n FROM journal_lines WHERE "accountId" = :id', { replacements: { id: taxAccount.id }, type: sequelize.QueryTypes.SELECT }))[0].n).toBe(0);
});

test('un-approve reverses the entry (both stay in the books), the invoice can be changed and approved again', async () => {
  const w = await setup();
  const { cu, gp1, gp2 } = await twoGatePasses(w);
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, invoiceDate: '2026-10-24', gatePassIds: [gp1.id, gp2.id] }));
  await fails(w.api('post', `/sales-invoices/${inv.id}/unapprove`, {}), 422, 'NOT_APPROVED');
  await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  const back = await ok(w.api('post', `/sales-invoices/${inv.id}/unapprove`, { reason: 'wrong rate' }), 200);
  expect(back).toMatchObject({ status: 'UNAPPROVED', canEdit: true });

  const view = await ok(w.api('get', `/sales-invoices/${inv.id}/accounts-entry`), 200);
  expect(view.posted).toBe(false);
  expect(view.entries.map((e) => [e.entryNo, e.status, Boolean(e.reversalOfId)])).toEqual([[1, 'REVERSED', false], [2, 'POSTED', true]]);
  expect(view.entries[1].narration).toContain('wrong rate');
  expect(await journalOf(w.company.id)).toEqual({ entries: 6, debit: 26432, credit: 26432 });
  // the books balance, and every account is back to zero
  const net = await sequelize.query(`SELECT a.name, (SUM(l.debit) - SUM(l.credit))::float AS balance FROM journal_lines l JOIN accounts a ON a.id = l."accountId" WHERE l."companyId" = :c GROUP BY a.name ORDER BY a.name`,
    { replacements: { c: w.company.id }, type: sequelize.QueryTypes.SELECT });
  expect(net.every((r) => r.balance === 0)).toBe(true);

  await ok(w.api('patch', `/sales-invoices/${inv.id}`, { gatePassIds: [gp1.id] }), 200);
  const again = await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  expect(again).toMatchObject({ status: 'APPROVED', gross: 8000, net: 9440 });
  const after = await ok(w.api('get', `/sales-invoices/${inv.id}/accounts-entry`), 200);
  expect(after.entries).toHaveLength(3);
  expect(after.current).toMatchObject({ entryNo: 3, totals: { debit: 9440, credit: 9440 } });
});

test('the sales summary: totals of the list, filters and search', async () => {
  const w = await setup();
  const a = await twoGatePasses(w);
  const b = await twoGatePasses(w, 'HAMID ENTERPRISES');
  const i1 = await ok(w.api('post', '/sales-invoices', { customerId: a.cu.id, invoiceDate: '2026-10-20', gatePassIds: [a.gp1.id], invoiceDetails: 'SMELL BLACK' }));
  await ok(w.api('post', '/sales-invoices', { customerId: b.cu.id, invoiceDate: '2026-10-22', gatePassIds: [b.gp1.id, b.gp2.id], taxRate: 0 }));
  await ok(w.api('post', `/sales-invoices/${i1.id}/approve`), 200);

  const all = await ok(w.api('get', '/sales-invoices'), 200);
  expect(all.data.map((x) => x.invoiceNo)).toEqual([2, 1]);
  expect(all.summary).toEqual({ invoices: 2, amount: 19200, tax: 1440, net: 20640, received: 0, balance: 20640 });
  expect((await ok(w.api('get', '/sales-invoices?status=APPROVED'), 200)).summary).toMatchObject({ invoices: 1, net: 9440 });
  expect((await ok(w.api('get', `/sales-invoices?customerId=${b.cu.id}`), 200)).summary).toMatchObject({ invoices: 1, net: 11200 });
  expect((await ok(w.api('get', '/sales-invoices?dateFrom=2026-10-21&dateTo=2026-10-23'), 200)).data.map((x) => x.invoiceNo)).toEqual([2]);
  expect((await ok(w.api('get', '/sales-invoices?search=smell'), 200)).data.map((x) => x.invoiceNo)).toEqual([1]);
  expect((await ok(w.api('get', '/sales-invoices?search=hamid'), 200)).data.map((x) => x.invoiceNo)).toEqual([2]);
  expect((await ok(w.api('get', '/sales-invoices?search=00002'), 200)).data.map((x) => x.invoiceNo)).toEqual([2]);
  expect((await ok(w.api('get', '/sales-invoices?limit=1&page=2'), 200)).data.map((x) => x.invoiceNo)).toEqual([1]);
});

test('access: needs the service; VIEW only reads; another company sees nothing', async () => {
  const w = await setup();
  const { cu, gp1 } = await twoGatePasses(w);
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, gatePassIds: [gp1.id] }));

  const employee = async (access) => {
    const u = await makeUser({ userType: 'USER', companyId: w.company.id });
    if (access) await UserService.create({ userId: u.id, serviceId: w.s.ACC_SALES.id, access });
    return caller(await token(u));
  };
  expect((await (await employee(null))('get', '/sales-invoices')).status).toBe(403);
  const viewer = await employee('VIEW');
  expect((await viewer('get', '/sales-invoices')).status).toBe(200);
  expect((await viewer('get', `/sales-invoices/${inv.id}/accounts-entry`)).status).toBe(200);
  await fails(viewer('post', '/sales-invoices', { customerId: cu.id, gatePassIds: [gp1.id] }), 403, 'FORBIDDEN');
  await fails(viewer('post', `/sales-invoices/${inv.id}/approve`), 403, 'FORBIDDEN');
  await fails(viewer('delete', `/sales-invoices/${inv.id}`), 403, 'FORBIDDEN');

  const other = await setup();
  expect((await ok(other.api('get', '/sales-invoices'), 200)).total).toBe(0);
  expect((await other.api('get', `/sales-invoices/${inv.id}`)).status).toBe(404);
  expect((await other.api('post', `/sales-invoices/${inv.id}/approve`)).status).toBe(404);
  expect((await other.api('delete', `/sales-invoices/${inv.id}`)).status).toBe(404);
  await fails(other.api('post', '/sales-invoices', { customerId: cu.id, gatePassIds: [gp1.id] }), 404, 'NOT_FOUND');
});

test('the trial balance follows the sales invoices, and says when an invoice and the ledger disagree', async () => {
  const w = await setup();
  const { cu, gp1, gp2 } = await twoGatePasses(w);
  const tb = (q = '') => ok(w.api('get', `/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31${q}`), 200);
  const row = (t, name) => t.rows.find((r) => r.name === name);

  // a draft: the books are empty
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, invoiceDate: '2026-10-24', gatePassIds: [gp1.id, gp2.id] }));
  let t = await tb();
  expect(t).toMatchObject({ rows: [], balanced: true, difference: '0.00', ok: true });
  expect(t.checks.map((c) => [c.key, c.ok])).toEqual([['TRIAL_BALANCE_BALANCED', true], ['CONTROL_ACCOUNTS_MATCH_SUBLEDGERS', true], ['SALES_INVOICES_MATCH_LEDGER', true], ['PURCHASE_INVOICES_MATCH_LEDGER', true], ['PAYMENT_VOUCHERS_MATCH_LEDGER', true], ['RECEIPT_VOUCHERS_MATCH_LEDGER', true], ['JOURNAL_VOUCHERS_MATCH_LEDGER', true], ['CONTRA_VOUCHERS_MATCH_LEDGER', true], ['INVOICE_PAYMENTS_MATCH_VOUCHERS', true]]);

  // approved: receivable debit, sales and tax credit
  await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  t = await tb();
  expect(row(t, 'Accounts Receivable')).toMatchObject({ periodDebit: '13216.00', periodCredit: '0.00', closingDebit: '13216.00', closingCredit: '0.00', openingDebit: '0.00', accountType: 'ASSET' });
  expect(row(t, 'Sales')).toMatchObject({ periodDebit: '0.00', periodCredit: '11200.00', closingCredit: '11200.00', accountType: 'INCOME' });
  expect(row(t, 'Output Sales Tax')).toMatchObject({ periodCredit: '2016.00', closingCredit: '2016.00', accountType: 'LIABILITY' });
  expect(t.totals).toEqual({ openingDebit: '0.00', openingCredit: '0.00', periodDebit: '13216.00', periodCredit: '13216.00', closingDebit: '13216.00', closingCredit: '13216.00' });
  expect(t.sections.map((s) => [s.accountType, s.closingDebit, s.closingCredit])).toEqual([['ASSET', '13216.00', '0.00'], ['LIABILITY', '0.00', '2016.00'], ['INCOME', '0.00', '11200.00']]);
  expect(t).toMatchObject({ balanced: true, difference: '0.00', ok: true });
  const control = t.checks.find((c) => c.key === 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS');
  expect(control.accounts).toEqual([expect.objectContaining({ name: 'Accounts Receivable', glBalance: '13216.00', subledgerBalance: '13216.00', difference: '0.00', ok: true })]);
  expect(t.checks.find((c) => c.key === 'SALES_INVOICES_MATCH_LEDGER')).toMatchObject({ ok: true, checked: 1, mismatches: [] });

  // the account ledger: one line, with the customer and the way back to the invoice
  const ar = row(t, 'Accounts Receivable').accountId;
  const led = await ok(w.api('get', `/accounting/ledger?accountId=${ar}&dateFrom=2026-10-01&dateTo=2026-10-31`), 200);
  expect(led).toMatchObject({ account: { name: 'Accounts Receivable' }, opening: { balance: '0.00', balanceSide: null }, totals: { debit: '13216.00', credit: '0.00' }, closing: { balance: '13216.00', balanceSide: 'DEBIT' }, truncated: false });
  expect(led.lines).toEqual([expect.objectContaining({ sourceType: 'SALES_INVOICE', sourceId: inv.id, debit: '13216.00', credit: '0.00', balance: '13216.00', balanceSide: 'DEBIT', partyType: 'CUSTOMER', partyName: 'AZ TEXTILES', entryDate: '2026-10-24' })]);
  expect(led.lines[0].narration).toContain('Sales invoice 00001');
  // another period: it is all "opening" later on
  const later = await ok(w.api('get', `/accounting/trial-balance?dateFrom=2026-11-01&dateTo=2026-11-30`), 200);
  expect(row(later, 'Accounts Receivable')).toMatchObject({ openingDebit: '13216.00', periodDebit: '0.00', closingDebit: '13216.00' });

  // un-approved again: both entries show in the period, every closing is zero, the books still agree with the invoices
  await ok(w.api('post', `/sales-invoices/${inv.id}/unapprove`, {}), 200);
  t = await ok(w.api('get', '/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2099-12-31'), 200); // the reversal is dated today
  expect(t.totals).toMatchObject({ periodDebit: '26432.00', periodCredit: '26432.00', closingDebit: '0.00', closingCredit: '0.00' });
  expect(t.ok).toBe(true);

  // the checks catch an invoice that is "approved" without an entry
  await sequelize.query(`UPDATE sales_invoices SET status = 'APPROVED' WHERE id = :id`, { replacements: { id: inv.id } });
  t = await tb();
  const sales = t.checks.find((c) => c.key === 'SALES_INVOICES_MATCH_LEDGER');
  expect(sales.ok).toBe(false);
  expect(sales.mismatches).toEqual([expect.objectContaining({ invoiceNo: 1, reason: 'APPROVED_WITHOUT_ENTRY' })]);
  expect(t).toMatchObject({ balanced: true, ok: false });
});

test('default accounts chosen before the first invoice are used by approve; nothing is made on the way', async () => {
  const w = await setup();
  // the company has its own accounts and chooses them as the defaults (the tab "Default accounts")
  const folder = (name, accountType) => ok(w.api('post', '/accounts', { name, isGroup: true, accountType }));
  const account = (name, parentId, accountType) => ok(w.api('post', '/accounts', { name, parentId, accountType }));
  const assets = await folder('My Assets', 'ASSET');
  const liabilities = await folder('My Liabilities', 'LIABILITY');
  const income = await folder('My Income', 'INCOME');
  const debtors = await account('Debtors', assets.id, 'ASSET');
  const gst = await account('GST Collected', liabilities.id, 'LIABILITY');
  const fabric = await account('Fabric Sales', income.id, 'INCOME');
  for (const [key, a] of [['CUSTOMERS', debtors], ['OUTPUT_TAX', gst], ['SALES', fabric]]) await ok(w.api('put', `/accounts/defaults/${key}`, { accountId: a.id }), 200);
  const before = (await ok(w.api('get', '/accounts'), 200)).total;

  const { cu, gp1, gp2 } = await twoGatePasses(w);
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, invoiceDate: '2026-10-24', gatePassIds: [gp1.id, gp2.id] }));
  await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  const view = await ok(w.api('get', `/sales-invoices/${inv.id}/accounts-entry`), 200);
  expect(view.current.lines.map((l) => [l.account.id, l.account.name, l.debit, l.credit])).toEqual([
    [debtors.id, 'Debtors', 13216, 0], [fabric.id, 'Fabric Sales', 0, 11200], [gst.id, 'GST Collected', 0, 2016],
  ]);
  expect((await ok(w.api('get', '/accounts'), 200)).total).toBe(before); // no Accounts Receivable / Sales / Output Sales Tax were made
  const t = await ok(w.api('get', '/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31'), 200);
  expect(t.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
  expect(t.rows.map((r) => r.name).sort()).toEqual(['Debtors', 'Fabric Sales', 'GST Collected']);
});

test('others: an extra amount with a note is ADDED to the bill; the tax is on the gross only; it is booked on the sales account on its own line', async () => {
  const w = await setup();
  const { cu, gp1, gp2 } = await twoGatePasses(w);
  const base = { customerId: cu.id, invoiceDate: '2026-10-24', gatePassIds: [gp1.id, gp2.id] };
  const plain = await ok(w.api('post', '/sales-invoices', base));
  expect(plain).toMatchObject({ othersAmount: 0, othersNote: null, othersEffect: 'ADD', gross: 11200, tax: 2016, net: 13216 });
  expect((await w.api('delete', `/sales-invoices/${plain.id}`)).status).toBe(204); // the gate passes are free again

  const inv = await ok(w.api('post', '/sales-invoices', { ...base, invoiceNo: 9001, othersAmount: '500.50', othersNote: 'Extra packing charges' }));
  expect(inv).toMatchObject({ othersAmount: 500.5, othersNote: 'Extra packing charges', gross: 11200, tax: 2016, net: 13716.5, balance: 13716.5 });
  // change it
  expect(await ok(w.api('patch', `/sales-invoices/${inv.id}`, { othersAmount: 300 }), 200)).toMatchObject({ othersAmount: 300, othersNote: 'Extra packing charges', net: 13516 });
  expect(await ok(w.api('patch', `/sales-invoices/${inv.id}`, { othersAmount: 500, othersNote: 'Freight' }), 200)).toMatchObject({ othersAmount: 500, othersNote: 'Freight', tax: 2016, net: 13716 });
  // bad values
  for (const bad of [-1, '-5', 'abc', 1.234, '1.234', null, 1e20]) await fails(w.api('patch', `/sales-invoices/${inv.id}`, { othersAmount: bad }), 400, 'VALIDATION_FAILED');
  // approve: Debit Receivable (bill + others), Credit Sales (gross), Credit Sales (others, with the note), Credit Sales Tax
  await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  const e = await ok(w.api('get', `/sales-invoices/${inv.id}/accounts-entry`), 200);
  expect(e.current.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Accounts Receivable', 13716, 0], ['Sales', 0, 11200], ['Sales', 0, 500], ['Output Sales Tax', 0, 2016]]);
  expect(e.current.lines[2].narration).toContain('others - Freight');
  expect(e.current).toMatchObject({ balanced: true, totals: { debit: 13716, credit: 13716 } });
  const t = await ok(w.api('get', '/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31'), 200);
  expect(t.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([]);
  expect((await ok(w.api('get', `/sales-invoices/${inv.id}`), 200)).net).toBe(13716);
  await fails(w.api('patch', `/sales-invoices/${inv.id}`, { othersAmount: 1 }), 422, 'INVOICE_APPROVED');
  // un-approve, remove the others, approve again: no extra line
  await ok(w.api('post', `/sales-invoices/${inv.id}/unapprove`, {}), 200);
  expect(await ok(w.api('patch', `/sales-invoices/${inv.id}`, { othersAmount: 0 }), 200)).toMatchObject({ othersAmount: 0, net: 13216 });
  await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  const again = await ok(w.api('get', `/sales-invoices/${inv.id}/accounts-entry`), 200);
  expect(again.current.lines.map((l) => [l.account.name, l.debit, l.credit])).toEqual([['Accounts Receivable', 13216, 0], ['Sales', 0, 11200], ['Output Sales Tax', 0, 2016]]);
});

test('credit terms: the due date is the invoice date + the customer\'s credit days unless typed; going over the credit limit only WARNS (nothing is blocked)', async () => {
  const w = await setup();
  const { cu, gp1, gp2 } = await twoGatePasses(w);
  expect(await ok(w.api('patch', `/customers/${cu.id}`, { creditDays: 30, creditLimit: 10000 }), 200)).toMatchObject({ creditDays: 30, creditLimit: 10000 });
  const base = { customerId: cu.id, invoiceDate: '2026-10-24', gatePassIds: [gp1.id, gp2.id] };
  await fails(w.api('post', '/sales-invoices', { ...base, dueDate: '2026-10-01', invoiceNo: 9100 }), 422, 'DUE_BEFORE_DATE');
  const inv = await ok(w.api('post', '/sales-invoices', base));
  expect(inv).toMatchObject({ dueDate: '2026-11-23', isOverdue: false, net: 13216 });
  // 13,216 is more than the 10,000 limit: a warning, the invoice is saved
  expect(inv.creditWarning).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED', creditLimit: '10000.00', balance: '0.00', thisInvoice: '13216.00', afterInvoice: '13216.00', exceededBy: '3216.00' });
  // a typed due date wins and stays when other things change; empty / a new invoice date work it out again
  expect(await ok(w.api('patch', `/sales-invoices/${inv.id}`, { dueDate: '2026-12-01' }), 200)).toMatchObject({ dueDate: '2026-12-01' });
  expect(await ok(w.api('patch', `/sales-invoices/${inv.id}`, { notes: 'x' }), 200)).toMatchObject({ dueDate: '2026-12-01' });
  expect(await ok(w.api('patch', `/sales-invoices/${inv.id}`, { dueDate: '' }), 200)).toMatchObject({ dueDate: '2026-11-23' });
  expect(await ok(w.api('patch', `/sales-invoices/${inv.id}`, { invoiceDate: '2026-10-30' }), 200)).toMatchObject({ dueDate: '2026-11-29' });
  await fails(w.api('patch', `/sales-invoices/${inv.id}`, { dueDate: '2026-10-01' }), 422, 'DUE_BEFORE_DATE');
  // approve: not blocked; the books carry the invoice, so the warning now comes from the balance
  const approved = await ok(w.api('post', `/sales-invoices/${inv.id}/approve`), 200);
  expect(approved).toMatchObject({ status: 'APPROVED', dueDate: '2026-11-29' });
  expect(approved.creditWarning).toMatchObject({ balance: '13216.00', thisInvoice: '0.00', exceededBy: '3216.00' });
  expect(await ok(w.api('get', `/sales-invoices/credit/${cu.id}`), 200)).toMatchObject({ creditLimit: '10000.00', creditDays: 30, balance: '13216.00', available: '-3216.00', exceeded: true });
  // no limit, no warning; a limit big enough, no warning
  await ok(w.api('patch', `/customers/${cu.id}`, { creditLimit: null }), 200);
  expect((await ok(w.api('get', `/sales-invoices/${inv.id}`), 200)).creditWarning).toBeNull();
  await ok(w.api('patch', `/customers/${cu.id}`, { creditLimit: 13216 }), 200);
  expect((await ok(w.api('get', `/sales-invoices/${inv.id}`), 200)).creditWarning).toBeNull();
  // overdue: the due date has passed (the invoice is old) and money is still due
  await sequelize.query('UPDATE sales_invoices SET "invoiceDate" = \'2020-01-01\', "dueDate" = \'2020-01-31\' WHERE id = :id', { replacements: { id: inv.id } });
  expect(await ok(w.api('get', `/sales-invoices/${inv.id}`), 200)).toMatchObject({ dueDate: '2020-01-31', isOverdue: true });
});
