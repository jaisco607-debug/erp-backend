const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, AuditLog, Account } = require('../src/models');
const journal = require('../src/services/journalService');

beforeEach(clean);

const token = async (u) => ({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
const caller = (auth) => (m, url, body) => request(app)[m](`/api/v1/accounts${url}`).set(auth).send(body);

async function setup() {
  const company = await makeCompany();
  const coa = await Service.findOne({ where: { code: 'ACC_COA' } });
  await CompanyService.create({ companyId: company.id, serviceId: coa.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const adm = caller(await token(admin));
  const req = { user: { id: admin.id, companyId: company.id, userType: 'CLIENT_ADMIN', email: admin.email }, headers: {}, ip: '127.0.0.1' };
  // an employee: access 'VIEW' / 'FULL', or null for none
  const employee = async (access) => {
    const u = await makeUser({ userType: 'USER', companyId: company.id });
    if (access) await UserService.create({ userId: u.id, serviceId: coa.id, access });
    return caller(await token(u));
  };
  const post = (entry) => sequelize.transaction((t) => journal.post(req, entry, t));
  return { company, adm, employee, req, post };
}

const ok = async (p, status = 201) => {
  const r = await p;
  expect(r.status).toBe(status);
  return r.body;
};
const fails = async (p, status, code) => {
  const r = await p;
  expect(r.status).toBe(status);
  expect(r.body.error.code).toBe(code);
  return r.body.error;
};
const byCode = (tree, code) => {
  for (const n of tree) {
    if (n.code === code) return n;
    const inner = byCode(n.children || [], code);
    if (inner) return inner;
  }
  return null;
};

test('the headers and accounts inside them: the type follows the parent, codes are unique per company', async () => {
  const { adm } = await setup();
  const assets = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));
  expect(assets).toMatchObject({ code: '1000', isGroup: true, accountType: 'ASSET', normalBalance: 'DEBIT', parentId: null, childCount: 0, isSystem: false, isContra: false, systemKey: null });
  const liab = await ok(adm('post', '', { code: '2000', name: 'Liabilities', accountType: 'LIABILITY', isGroup: true }));
  expect(liab.normalBalance).toBe('CREDIT');

  const cash = await ok(adm('post', '', { code: '1100', name: 'Cash in Hand', parentId: assets.id, subType: 'CURRENT_ASSET', controlType: 'CASH' }));
  expect(cash).toMatchObject({ accountType: 'ASSET', parentCode: '1000', parentName: 'Assets', isGroup: false, currentBalance: '0.00', balanceSide: null, warnings: [] });
  expect((await ok(adm('get', `/${assets.id}`), 200)).childCount).toBe(1);

  await fails(adm('post', '', { code: '1100', name: 'Other', parentId: assets.id }), 422, 'CODE_TAKEN');
  await ok(adm('post', '', { code: 'ab-1', name: 'Lower case code', parentId: assets.id }));
  await fails(adm('post', '', { code: 'AB-1', name: 'x', parentId: assets.id }), 422, 'CODE_TAKEN');
  await fails(adm('post', '', { code: '1101', name: 'cash in hand', parentId: assets.id }), 422, 'NAME_TAKEN');
  await fails(adm('post', '', { code: '9000', name: 'No type' }), 422, 'TYPE_REQUIRED');
  await fails(adm('post', '', { code: '1200', name: 'Wrong type', parentId: assets.id, accountType: 'EXPENSE' }), 422, 'TYPE_MISMATCH');
  await fails(adm('post', '', { code: '1 2', name: 'bad code', parentId: assets.id }), 400, 'VALIDATION_FAILED');
  await fails(adm('post', '', { code: '1300', parentId: assets.id }), 422, 'NAME_REQUIRED');
  // an opening balance is no longer a field of the account
  await fails(adm('post', '', { code: '1300', name: 'With money', parentId: assets.id, openingBalance: 5 }), 422, 'USE_OPENING_BALANCES');
  await ok(adm('post', '', { code: '1301', name: 'With zero', parentId: assets.id, openingBalance: 0 }));
});

test('parents must be active group accounts; no cycles; depth is limited', async () => {
  const { adm } = await setup();
  const top = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));
  const leaf = await ok(adm('post', '', { code: '1100', name: 'Cash', parentId: top.id }));
  await fails(adm('post', '', { code: '1101', name: 'Inside a posting account', parentId: leaf.id }), 422, 'PARENT_NOT_GROUP');

  const mid = await ok(adm('post', '', { code: '1500', name: 'Current assets', parentId: top.id, isGroup: true }));
  const inner = await ok(adm('post', '', { code: '1510', name: 'Banks', parentId: mid.id, isGroup: true }));
  await fails(adm('patch', `/${top.id}`, { parentId: inner.id }), 422, 'CYCLE');
  await fails(adm('patch', `/${mid.id}`, { parentId: mid.id }), 422, 'CYCLE');

  // a switched-off group takes no new account
  await ok(adm('patch', `/${inner.id}`, { isActive: false }), 200);
  await fails(adm('post', '', { code: '1511', name: 'Meezan', parentId: inner.id }), 422, 'PARENT_INACTIVE');

  // levels: the top folder is level 1, level 8 is the last
  let parent = top;
  const levels = { 1: top };
  for (let i = 2; i <= 8; i += 1) {
    parent = await ok(adm('post', '', { code: `L${i}`, name: `Level ${i}`, parentId: parent.id, isGroup: true }));
    levels[i] = parent;
  }
  await fails(adm('post', '', { code: 'L9', name: 'Level 9', parentId: levels[8].id }), 422, 'TOO_DEEP');
  // moving a whole branch deeper than level 8 is refused too
  const lone = await ok(adm('post', '', { code: '1900', name: 'Lone group', parentId: top.id, isGroup: true }));
  await ok(adm('post', '', { code: '1901', name: 'Inside lone', parentId: lone.id }));
  await fails(adm('patch', `/${lone.id}`, { parentId: levels[7].id }), 422, 'TOO_DEEP');
});

test('group accounts have no control type; control accounts match their type', async () => {
  const { adm } = await setup();
  const assets = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));
  const liab = await ok(adm('post', '', { code: '2000', name: 'Liabilities', accountType: 'LIABILITY', isGroup: true }));
  await fails(adm('post', '', { code: '1901', name: 'Group control', parentId: assets.id, isGroup: true, controlType: 'BANK' }), 422, 'GROUP_CANNOT_BE_CONTROL');
  await fails(adm('post', '', { code: '2100', name: 'Bank in liabilities', parentId: liab.id, controlType: 'BANK' }), 422, 'CONTROL_TYPE_MISMATCH');
  await fails(adm('post', '', { code: '1902', name: 'Bad sub type', parentId: assets.id, subType: 'CURRENT_LIABILITY' }), 422, 'BAD_SUB_TYPE');

  // the default roles (receivable, payable, sales, taxes, advances) are not given from the Chart screen: they are chosen in the Default Accounts tab
  for (const controlType of ['CUSTOMERS', 'SUPPLIERS', 'SALES', 'PURCHASES', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES']) {
    const e = await fails(adm('post', '', { name: `Default ${controlType}`, parentId: assets.id, controlType }), 422, 'USE_DEFAULT_ACCOUNTS');
    expect(e.details).toEqual({ controlType });
  }
  // several cash and bank accounts are normal
  await ok(adm('post', '', { code: '1210', name: 'Meezan Bank', parentId: assets.id, controlType: 'BANK' }));
  await ok(adm('post', '', { code: '1220', name: 'HBL Bank', parentId: assets.id, controlType: 'BANK' }));
  // one account of its kind: the SRB withholding account
  await ok(adm('post', '', { name: 'SRB Withholding', parentId: liab.id, controlType: 'SRB_WITHHOLDING' }));
  await fails(adm('post', '', { name: 'SRB again', parentId: liab.id, controlType: 'SRB_WITHHOLDING' }), 422, 'CONTROL_TAKEN');
  // the control type of an account cannot be changed into a default role either
  const plain = await ok(adm('post', '', { name: 'Plain asset', parentId: assets.id }));
  await fails(adm('patch', `/${plain.id}`, { controlType: 'CUSTOMERS' }), 422, 'USE_DEFAULT_ACCOUNTS');
  await ok(adm('patch', `/${plain.id}`, { controlType: 'CASH' }), 200);
});

test('editing: move, change type, group <-> posting, switch off, delete', async () => {
  const { adm } = await setup();
  const assets = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));
  const expenses = await ok(adm('post', '', { code: '6000', name: 'Expenses', accountType: 'EXPENSE', isGroup: true }));
  const cash = await ok(adm('post', '', { code: '1100', name: 'Cash', parentId: assets.id }));

  await fails(adm('patch', `/${cash.id}`, { parentId: expenses.id }), 422, 'TYPE_MISMATCH');
  await fails(adm('patch', `/${cash.id}`, { accountType: 'EXPENSE' }), 422, 'TYPE_LOCKED');
  await fails(adm('patch', `/${assets.id}`, { accountType: 'EXPENSE' }), 422, 'TYPE_LOCKED'); // it holds an account
  expect(await ok(adm('patch', `/${expenses.id}`, { accountType: 'LIABILITY' }), 200)).toMatchObject({ accountType: 'LIABILITY', normalBalance: 'CREDIT' });

  // an empty posting account may become a group, and back
  expect(await ok(adm('patch', `/${cash.id}`, { isGroup: true }), 200)).toMatchObject({ isGroup: true });
  const sub = await ok(adm('post', '', { code: '1110', name: 'Petty cash', parentId: cash.id }));
  await fails(adm('patch', `/${cash.id}`, { isGroup: false }), 422, 'HAS_CHILDREN');

  // switch off: a group only after the accounts in it
  await fails(adm('patch', `/${cash.id}`, { isActive: false }), 422, 'HAS_ACTIVE_CHILDREN');
  await ok(adm('patch', `/${sub.id}`, { isActive: false }), 200);
  await ok(adm('patch', `/${cash.id}`, { isActive: false }), 200);
  await fails(adm('patch', `/${sub.id}`, { isActive: true }), 422, 'PARENT_INACTIVE');

  // move to another top account of the same type, change code and name
  const assets2 = await ok(adm('post', '', { code: '1500', name: 'Other assets', accountType: 'ASSET', isGroup: true }));
  await ok(adm('patch', `/${cash.id}`, { isActive: true }), 200);
  const moved = await ok(adm('patch', `/${cash.id}`, { parentId: assets2.id, code: '1510', name: 'Cash box' }), 200);
  expect(moved).toMatchObject({ parentCode: '1500', code: '1510', name: 'Cash box' });
  await fails(adm('patch', `/${cash.id}`, { code: '1000' }), 422, 'CODE_TAKEN');

  // delete: not while it holds accounts; a free account goes
  await fails(adm('delete', `/${cash.id}`), 422, 'HAS_CHILDREN');
  expect((await adm('delete', `/${sub.id}`)).status).toBe(204);
  expect((await adm('delete', `/${cash.id}`)).status).toBe(204);
  expect((await adm('get', `/${cash.id}`)).status).toBe(404);
});

test('list, search and tree come out in code order', async () => {
  const { adm } = await setup();
  const assets = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));
  const rev = await ok(adm('post', '', { code: '4000', name: 'Revenue', accountType: 'INCOME', isGroup: true }));
  for (const [code, name] of [['1200', 'Bank'], ['1100', 'Cash'], ['900', 'Odd small code']]) await ok(adm('post', '', { code, name, parentId: assets.id }));
  await ok(adm('post', '', { code: '4100', name: 'Sales', parentId: rev.id }));

  const all = await ok(adm('get', ''), 200);
  expect(all.total).toBe(6);
  expect(all.data.map((a) => a.code)).toEqual(['900', '1000', '1100', '1200', '4000', '4100']);
  expect((await ok(adm('get', '?search=sales'), 200)).data.map((a) => a.code)).toEqual(['4100']);
  expect((await ok(adm('get', '?accountType=ASSET&isGroup=true'), 200)).data.map((a) => a.code)).toEqual(['1000']);
  expect((await ok(adm('get', `?parentId=${assets.id}`), 200)).total).toBe(3);

  const tree = await ok(adm('get', '/tree'), 200);
  expect(tree.total).toBe(6);
  expect(tree.data.map((n) => n.code)).toEqual(['1000', '4000']);
  expect(tree.data[0].children.map((n) => n.code)).toEqual(['900', '1100', '1200']);
  expect(tree.data[0]).toMatchObject({ level: 1, canDelete: false, deleteReason: 'HAS_CHILDREN', canDeactivate: false, deactivateReason: 'HAS_ACTIVE_CHILDREN' });
  expect(tree.data[0].children[0]).toMatchObject({ level: 2, canDelete: true, deleteReason: null, canDeactivate: true, deactivateReason: null });
  const opts = await ok(adm('get', '/options'), 200);
  expect(opts.accountTypes).toEqual(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);
  // one definition of the expense ranges
  expect(opts.topCodes).toEqual({ ASSET: 1000, LIABILITY: 2000, EQUITY: 3000, INCOME: 4000, COST_OF_SALES: 5000, OPERATING_EXPENSE: 6000 });
  expect(opts.expenseRanges).toMatchObject({ costOfGoodsSold: { code: '5000', accountType: 'EXPENSE', subType: 'COST_OF_SALES' }, operatingExpenses: { code: '6000', accountType: 'EXPENSE', subType: 'OPERATING_EXPENSE' } });
  expect(opts.systemKeys.map((k) => k.key).sort()).toEqual(['AP_CONTROL', 'AR_CONTROL', 'CURRENT_YEAR_EARNINGS', 'CUSTOMER_ADVANCES', 'DEFAULT_PURCHASES', 'DEFAULT_SALES', 'EMPLOYEE_ADVANCES', 'EMPLOYEE_DEDUCTIONS', 'EMPLOYEE_LOANS', 'EOBI_EMPLOYER_EXPENSE', 'EOBI_PAYABLE', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'INPUT_TAX', 'OPENING_BALANCE_EQUITY', 'OUTPUT_TAX', 'RETAINED_EARNINGS', 'ROUNDING', 'SALARIES_PAYABLE', 'SALARY_EXPENSE', 'SALARY_TAX_PAYABLE', 'SUPPLIER_ADVANCES']);
});

test('access: needs the service; VIEW only reads; another company sees nothing and may use the same codes', async () => {
  const { adm, employee, company } = await setup();
  const acc = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));

  expect((await (await employee(null))('get', '')).status).toBe(403);
  const viewer = await employee('VIEW');
  expect((await viewer('get', '')).status).toBe(200);
  expect((await viewer('get', '/presets')).status).toBe(200);
  expect((await viewer('get', '/templates')).status).toBe(200);
  await fails(viewer('post', '', { code: '1', name: 'x', accountType: 'ASSET' }), 403, 'FORBIDDEN');
  await fails(viewer('post', '/apply-template', { templateKey: 'shop' }), 403, 'FORBIDDEN');
  await fails(viewer('patch', `/${acc.id}`, { name: 'y' }), 403, 'FORBIDDEN');
  await fails(viewer('delete', `/${acc.id}`), 403, 'FORBIDDEN');
  expect((await (await employee('FULL'))('patch', `/${acc.id}`, { name: 'Assets 2' })).status).toBe(200);

  const { adm: other, company: otherCompany } = await setup();
  expect(otherCompany.id).not.toBe(company.id);
  expect((await other('get', '')).body.total).toBe(0);
  expect((await other('get', `/${acc.id}`)).status).toBe(404);
  expect((await other('patch', `/${acc.id}`, { name: 'hack' })).status).toBe(404);
  expect((await other('delete', `/${acc.id}`)).status).toBe(404);
  await ok(other('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));
});

test('every change is in the audit log', async () => {
  const { adm, company } = await setup();
  const a = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET' }));
  await ok(adm('patch', `/${a.id}`, { name: 'All Assets' }), 200);
  await adm('delete', `/${a.id}`);
  const log = await AuditLog.findAll({ where: { companyId: company.id, entityType: 'Account' }, order: [['id', 'ASC']] });
  expect(log.map((l) => l.action)).toEqual(['ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'ACCOUNT_DELETED']);
});

test('next code: the numbering rules, switched-off accounts count, and no two people get the same code', async () => {
  const { adm } = await setup();
  const next = async (q) => (await ok(adm('get', `/next-code${q}`), 200)).code;
  expect(await next('?accountType=ASSET')).toBe('1000');
  expect(await next('?accountType=LIABILITY')).toBe('2000');
  expect(await next('?accountType=EQUITY')).toBe('3000');
  expect(await next('?accountType=INCOME')).toBe('4000');
  expect(await next('?accountType=EXPENSE&subType=COST_OF_SALES')).toBe('5000');
  expect(await next('?accountType=EXPENSE&subType=OPERATING_EXPENSE')).toBe('6000');
  expect(await next('?accountType=EXPENSE')).toBe('6000');
  await fails(adm('get', '/next-code'), 422, 'TYPE_REQUIRED');

  // POST without a code uses the same numbers
  const assets = await ok(adm('post', '', { name: 'Assets', accountType: 'ASSET', isGroup: true }));
  expect(assets.code).toBe('1000');
  expect(await next('?accountType=ASSET')).toBe('1100'); // 1000 is taken: +100 until free
  expect(await next(`?parentId=${assets.id}&isGroup=true`)).toBe('1100'); // a folder in a top account: parent + 100
  expect(await next(`?parentId=${assets.id}`)).toBe('1001'); // a posting account in a top account: parent + 1
  const current = await ok(adm('post', '', { name: 'Current Assets', parentId: assets.id, isGroup: true }));
  expect(current.code).toBe('1100');
  const folder2 = await ok(adm('post', '', { name: 'Fixed Assets', parentId: assets.id, isGroup: true }));
  expect(folder2.code).toBe('1200');
  const posting = await ok(adm('post', '', { name: 'Cash in Hand', parentId: assets.id }));
  expect(posting.code).toBe('1001');

  // deeper: the highest sibling + 1
  const c1 = await ok(adm('post', '', { name: 'Cash', parentId: current.id }));
  const c2 = await ok(adm('post', '', { name: 'Bank', parentId: current.id }));
  expect([c1.code, c2.code]).toEqual(['1101', '1102']);
  await ok(adm('patch', `/${c2.id}`, { isActive: false }), 200);
  expect(await next(`?parentId=${current.id}`)).toBe('1103'); // the switched-off 1102 still counts
  await ok(adm('patch', `/${c1.id}`, { code: '1150' }), 200);
  expect(await next(`?parentId=${current.id}`)).toBe('1151'); // highest sibling + 1

  // a client that sends a taken code still gets CODE_TAKEN
  await fails(adm('post', '', { code: '1150', name: 'Another', parentId: current.id }), 422, 'CODE_TAKEN');
});

// needs real parallel connections (the shared-connection runner used on the dev database cannot run it)
test('next code: many people adding at the same moment never get the same code', async () => {
  const { adm } = await setup();
  const assets = await ok(adm('post', '', { name: 'Assets', accountType: 'ASSET', isGroup: true }));
  const current = await ok(adm('post', '', { name: 'Current Assets', parentId: assets.id, isGroup: true }));
  const made = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => adm('post', '', { name: `Parallel ${i}`, parentId: current.id })));
  expect(made.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201, 201, 201]);
  expect(new Set(made.map((r) => r.body.code)).size).toBe(8);
});

test('presets: friendly cards; the account is filled in from the preset; a missing folder is reported', async () => {
  const { adm } = await setup();
  const { data } = await ok(adm('get', '/presets'), 200);
  // Accounts Receivable, Accounts Payable, Sales and Sales Tax are default accounts: made in the Default Accounts tab, so they are not cards here
  expect(data.map((p) => p.key)).not.toEqual(expect.arrayContaining(['customers_owe_us']));
  expect(data.map((p) => p.key).filter((k) => ['customers_owe_us', 'suppliers_we_owe', 'tax_payable', 'sales_income'].includes(k))).toEqual([]);
  expect(data).toHaveLength(18);
  await fails(adm('post', '', { presetKey: 'customers_owe_us' }), 422, 'USE_DEFAULT_ACCOUNTS');
  expect(data.map((p) => p.key)).toEqual(expect.arrayContaining([
    'cash_in_hand', 'bank_account', 'inventory', 'equipment', 'accumulated_depreciation', 'loan', 'owner_investment', 'owner_drawings',
    'sales_returns', 'other_income', 'cost_of_goods_sold', 'rent', 'salaries', 'utilities', 'internet_phone', 'bank_charges', 'transport', 'misc_expense',
  ]));
  for (const p of data) {
    expect(Object.keys(p).sort()).toEqual(['accountType', 'controlType', 'defaultName', 'description', 'icon', 'isContra', 'key', 'label', 'subType', 'suggestedParentCode']);
  }
  expect(data.find((p) => p.key === 'bank_charges')).toMatchObject({ accountType: 'EXPENSE', suggestedParentCode: '6000' });
  expect(data.filter((p) => p.isContra).map((p) => p.key).sort()).toEqual(['accumulated_depreciation', 'owner_drawings', 'sales_returns']);

  // no folders yet: the error says which folders to make, top first
  const error = await fails(adm('post', '', { presetKey: 'cash_in_hand' }), 422, 'PARENT_FOLDER_MISSING');
  expect(error.details.suggestedFolder).toMatchObject({ code: '1100', name: 'Current Assets', accountType: 'ASSET', subType: 'CURRENT_ASSET', isGroup: true, parentCode: '1000' });
  expect(error.details.missingFolders.map((f) => f.code)).toEqual(['1000', '1100']);

  const assets = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));
  const e2 = await fails(adm('post', '', { presetKey: 'cash_in_hand' }), 422, 'PARENT_FOLDER_MISSING');
  expect(e2.details.missingFolders.map((f) => f.code)).toEqual(['1100']);
  await ok(adm('post', '', { code: '1100', name: 'Current Assets', parentId: assets.id, isGroup: true, subType: 'CURRENT_ASSET' }));

  const cash = await ok(adm('post', '', { presetKey: 'cash_in_hand' }));
  expect(cash).toMatchObject({ name: 'Cash in Hand', code: '1101', accountType: 'ASSET', subType: 'CURRENT_ASSET', controlType: 'CASH', parentCode: '1100', isContra: false });
  // what the client sends wins over the preset
  const bank = await ok(adm('post', '', { presetKey: 'bank_account', name: 'Meezan Bank' }));
  expect(bank).toMatchObject({ name: 'Meezan Bank', controlType: 'BANK', code: '1102' });
  await fails(adm('post', '', { presetKey: 'nonsense' }), 400, 'VALIDATION_FAILED');
});

test('presets: contra accounts have the opposite normal balance', async () => {
  const { adm } = await setup();
  const applied = await adm('post', '/apply-template', { templateKey: 'other' });
  expect(applied.status).toBe(200);
  const dep = await ok(adm('post', '', { presetKey: 'accumulated_depreciation', name: 'Accumulated Depreciation - Machines' }));
  expect(dep).toMatchObject({ accountType: 'ASSET', isContra: true, normalBalance: 'CREDIT' });
  const drawings = await ok(adm('post', '', { presetKey: 'owner_drawings', name: 'Drawings of the partner' }));
  expect(drawings).toMatchObject({ accountType: 'EQUITY', isContra: true, normalBalance: 'DEBIT' });
  const returns = await ok(adm('post', '', { presetKey: 'sales_returns', name: 'Returns inwards' }));
  expect(returns).toMatchObject({ accountType: 'INCOME', isContra: true, normalBalance: 'DEBIT' });

  // by hand, and from an old client that sends the opposite normal balance
  const parent = (await ok(adm('get', '?accountType=ASSET&isGroup=true'), 200)).data.find((a) => a.code === '1200');
  expect(await ok(adm('post', '', { name: 'Provision', parentId: parent.id, isContra: true }))).toMatchObject({ isContra: true, normalBalance: 'CREDIT' });
  expect(await ok(adm('post', '', { name: 'Old style', parentId: parent.id, normalBalance: 'CREDIT' }))).toMatchObject({ isContra: true, normalBalance: 'CREDIT' });
  const plain = await ok(adm('post', '', { name: 'Plain machine', parentId: parent.id }));
  expect(plain).toMatchObject({ isContra: false, normalBalance: 'DEBIT' });
  expect(await ok(adm('patch', `/${plain.id}`, { isContra: true }), 200)).toMatchObject({ isContra: true, normalBalance: 'CREDIT' });
  expect(await ok(adm('patch', `/${plain.id}`, { isContra: false }), 200)).toMatchObject({ isContra: false, normalBalance: 'DEBIT' });
});

test('templates: five of them with a preview; applying is safe to repeat and every template has the system accounts', async () => {
  const { adm, company } = await setup();
  const { data } = await ok(adm('get', '/templates'), 200);
  expect(data.map((t) => t.key)).toEqual(['shop', 'service', 'restaurant', 'manufacturing', 'other']);
  const SYSTEM = ['AP_CONTROL', 'AR_CONTROL', 'CURRENT_YEAR_EARNINGS', 'CUSTOMER_ADVANCES', 'DEFAULT_PURCHASES', 'DEFAULT_SALES', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'INPUT_TAX', 'OPENING_BALANCE_EQUITY', 'OUTPUT_TAX', 'RETAINED_EARNINGS', 'ROUNDING', 'SUPPLIER_ADVANCES'];
  for (const t of data) {
    expect(t.accounts.length).toBe(t.accountCount);
    expect(t.systemAccounts.sort()).toEqual(SYSTEM);
    expect(new Set(t.accounts.map((a) => a.code)).size).toBe(t.accounts.length); // no code twice
  }
  expect(data.find((t) => t.key === 'manufacturing').accounts.map((a) => a.name)).toEqual(expect.arrayContaining(['Raw Material', 'Work in Progress', 'Finished Goods']));
  expect(data.find((t) => t.key === 'shop').accounts.find((a) => a.name === 'Inventory')).toMatchObject({ code: '1105', parentCode: '1100' });

  const first = await ok(adm('post', '/apply-template', { templateKey: 'shop' }), 200);
  expect(first.skipped).toEqual([]);
  expect(first.created.length).toBe(data.find((t) => t.key === 'shop').accountCount);
  const keys = (await Account.findAll({ where: { companyId: company.id }, raw: true })).filter((a) => a.systemKey).map((a) => a.systemKey).sort();
  expect(keys).toEqual(SYSTEM);

  // again: nothing new, everything skipped
  const again = await ok(adm('post', '/apply-template', { templateKey: 'shop' }), 200);
  expect(again.created).toEqual([]);
  expect(again.skipped.length).toBe(first.created.length);
  expect(new Set(again.skipped.map((s) => s.reason))).toEqual(new Set(['CODE_EXISTS']));
  expect(await Account.count({ where: { companyId: company.id } })).toBe(first.created.length);

  // another template on top: only what is new
  const manu = await ok(adm('post', '/apply-template', { templateKey: 'manufacturing' }), 200);
  // codes the shop template already took (1105, 5002, 6009) are skipped, the rest is new
  expect(manu.created.map((c) => c.name).sort()).toEqual(['Factory Overhead', 'Finished Goods', 'Work in Progress']);
  expect(manu.skipped.map((x) => x.name).sort()).toContain('Raw Material');

  // the tree is right: the system accounts are locked, contra accounts have the opposite balance
  const tree = (await ok(adm('get', '/tree'), 200)).data;
  expect(byCode(tree, '1103')).toMatchObject({ name: 'Accounts Receivable', controlType: 'CUSTOMERS', systemKey: 'AR_CONTROL', isSystem: true, parentCode: '1100' });
  expect(byCode(tree, '1202')).toMatchObject({ isContra: true, normalBalance: 'CREDIT' });
  expect(byCode(tree, '3002')).toMatchObject({ isContra: true, normalBalance: 'DEBIT' });
  await fails(adm('post', '/apply-template', { templateKey: 'nonsense' }), 400, 'VALIDATION_FAILED');
});

test('templates: a system account the company already has is kept, not doubled', async () => {
  const { adm, company } = await setup();
  const assets = await ok(adm('post', '', { code: '9000', name: 'My assets', accountType: 'ASSET', isGroup: true }));
  const mine = await ok(adm('post', '', { code: '9100', name: 'Debtors', parentId: assets.id }));
  await ok(adm('put', '/defaults/CUSTOMERS', { accountId: mine.id }), 200); // chosen in the Default Accounts tab
  const result = await ok(adm('post', '/apply-template', { templateKey: 'service' }), 200);
  expect(result.adopted).toEqual([]); // it is already the default (chosen in the tab): the template skips its own Accounts Receivable
  expect(result.skipped).toContainEqual(expect.objectContaining({ code: '1103', reason: 'SYSTEM_KEY_EXISTS' }));
  expect(await Account.count({ where: { companyId: company.id, systemKey: 'AR_CONTROL' } })).toBe(1);
  expect((await ok(adm('get', `/${mine.id}`), 200))).toMatchObject({ isSystem: true, systemKey: 'AR_CONTROL' });
  expect(await Account.count({ where: { companyId: company.id, controlType: 'CUSTOMERS' } })).toBe(1);
  // the service template names its income account "Service Income"
  expect((await Account.findOne({ where: { companyId: company.id, systemKey: 'DEFAULT_SALES' } })).name).toBe('Service Income');
});

test('templates are refused once entries are posted', async () => {
  const { adm, post, company } = await setup();
  await ok(adm('post', '/apply-template', { templateKey: 'other' }), 200);
  const accounts = await Account.findAll({ where: { companyId: company.id }, raw: true });
  const id = (code) => accounts.find((a) => a.code === code).id;
  await post({ sourceType: 'TEST', lines: [{ accountId: id('1101'), debit: 100 }, { accountId: id('3001'), credit: 100 }] });
  await fails(adm('post', '/apply-template', { templateKey: 'shop' }), 422, 'CHART_HAS_ENTRIES');
});

test('system accounts cannot be deleted, switched off, re-typed or made groups; they can be renamed', async () => {
  const { adm, company } = await setup();
  await ok(adm('post', '/apply-template', { templateKey: 'other' }), 200);
  const ar = await Account.findOne({ where: { companyId: company.id, systemKey: 'AR_CONTROL' } });
  const tree = (await ok(adm('get', '/tree'), 200)).data;
  expect(byCode(tree, '1103')).toMatchObject({ canDelete: false, deleteReason: 'SYSTEM_LOCKED', canDeactivate: false, deactivateReason: 'SYSTEM_LOCKED' });

  await fails(adm('delete', `/${ar.id}`), 422, 'SYSTEM_LOCKED');
  await fails(adm('patch', `/${ar.id}`, { isActive: false }), 422, 'SYSTEM_LOCKED');
  await fails(adm('patch', `/${ar.id}`, { isGroup: true }), 422, 'SYSTEM_LOCKED');
  await fails(adm('patch', `/${ar.id}`, { accountType: 'LIABILITY' }), 422, 'SYSTEM_LOCKED');
  await fails(adm('patch', `/${ar.id}`, { controlType: null }), 422, 'SYSTEM_LOCKED');
  await fails(adm('patch', `/${ar.id}`, { isContra: true }), 422, 'SYSTEM_LOCKED');
  const renamed = await ok(adm('patch', `/${ar.id}`, { name: 'Debtors' }), 200);
  expect(renamed).toMatchObject({ name: 'Debtors', isSystem: true, systemKey: 'AR_CONTROL', isLocked: true });
  // the other system accounts too
  for (const key of ['RETAINED_EARNINGS', 'ROUNDING', 'DEFAULT_SALES', 'OPENING_BALANCE_EQUITY']) {
    const a = await Account.findOne({ where: { companyId: company.id, systemKey: key } });
    await fails(adm('delete', `/${a.id}`), 422, 'SYSTEM_LOCKED');
  }
});

test('balances (exact, in cents), folders add up, an account with a balance cannot be switched off', async () => {
  const { adm, post, company } = await setup();
  await ok(adm('post', '/apply-template', { templateKey: 'other' }), 200);
  const id = async (code) => (await Account.findOne({ where: { companyId: company.id, code } })).id;
  const bank = await id('1102');
  const capital = await id('3001');
  await post({ sourceType: 'TEST', lines: [{ accountId: bank, debit: 0.1 }, { accountId: capital, credit: 0.1 }] });
  await post({ sourceType: 'TEST', lines: [{ accountId: bank, debit: 0.2 }, { accountId: capital, credit: 0.2 }] });
  await post({ sourceType: 'TEST', lines: [{ accountId: bank, debit: 1000000000000.5 }, { accountId: capital, credit: 1000000000000.5 }] });

  let tree = (await ok(adm('get', '/tree'), 200)).data;
  expect(byCode(tree, '1102')).toMatchObject({ currentBalance: '1000000000000.80', balanceSide: 'DEBIT', balanceSigned: '1000000000000.80', canDelete: false, deleteReason: 'HAS_ENTRIES', canDeactivate: false, deactivateReason: 'HAS_BALANCE' });
  expect(byCode(tree, '3001')).toMatchObject({ currentBalance: '1000000000000.80', balanceSide: 'CREDIT', balanceSigned: '-1000000000000.80' });
  // the folders roll up
  expect(byCode(tree, '1000')).toMatchObject({ currentBalance: '1000000000000.80', balanceSide: 'DEBIT' });
  expect(byCode(tree, '1100')).toMatchObject({ currentBalance: '1000000000000.80', balanceSide: 'DEBIT' });
  expect(byCode(tree, '3000')).toMatchObject({ currentBalance: '1000000000000.80', balanceSide: 'CREDIT' });
  expect(byCode(tree, '1200')).toMatchObject({ currentBalance: '0.00', balanceSide: null });
  expect(typeof byCode(tree, '1102').currentBalance).toBe('string'); // never a float

  const list = await ok(adm('get', '?search=Bank%20Account'), 200);
  expect(list.data[0]).toMatchObject({ code: '1102', currentBalance: '1000000000000.80', balanceSide: 'DEBIT' });
  expect(await ok(adm('get', `/${bank}`), 200)).toMatchObject({ currentBalance: '1000000000000.80', balanceSide: 'DEBIT' });

  const error = await fails(adm('patch', `/${bank}`, { isActive: false }), 422, 'HAS_BALANCE');
  expect(error.details).toEqual({ amount: '1000000000000.80', side: 'DEBIT' });
  await fails(adm('delete', `/${bank}`), 422, 'HAS_ENTRIES');

  // an account without entries can go; one that is back to zero can be switched off
  const cash = await id('1101');
  expect(byCode(tree, '1101')).toMatchObject({ canDelete: true, canDeactivate: true });
  const loan = await id('2201');
  await post({ sourceType: 'TEST', lines: [{ accountId: cash, debit: 5 }, { accountId: loan, credit: 5 }] });
  await fails(adm('patch', `/${cash}`, { isActive: false }), 422, 'HAS_BALANCE');
  await post({ sourceType: 'TEST', lines: [{ accountId: loan, debit: 5 }, { accountId: cash, credit: 5 }] }); // pays the loan back: cash is at zero again
  tree = (await ok(adm('get', '/tree'), 200)).data;
  expect(byCode(tree, '1101')).toMatchObject({ currentBalance: '0.00', balanceSide: null, canDeactivate: true, deactivateReason: null, canDelete: false, deleteReason: 'HAS_ENTRIES' });
  expect(await ok(adm('patch', `/${cash}`, { isActive: false }), 200)).toMatchObject({ isActive: false });
  expect(byCode((await ok(adm('get', '/tree'), 200)).data, '1101')).toMatchObject({ canDeactivate: false, deactivateReason: 'ALREADY_INACTIVE' });
});

test('a contra account: its balance is on the opposite side and it nets inside its folder', async () => {
  const { adm, post, company } = await setup();
  await ok(adm('post', '/apply-template', { templateKey: 'other' }), 200);
  const id = async (code) => (await Account.findOne({ where: { companyId: company.id, code } })).id;
  await post({ sourceType: 'TEST', lines: [{ accountId: await id('1201'), debit: 1000 }, { accountId: await id('3001'), credit: 1000 }] }); // equipment 1,000
  await post({ sourceType: 'TEST', lines: [{ accountId: await id('3003'), debit: 100 }, { accountId: await id('1202'), credit: 100 }] }); // depreciation 100
  const tree = (await ok(adm('get', '/tree'), 200)).data;
  expect(byCode(tree, '1201')).toMatchObject({ currentBalance: '1000.00', balanceSide: 'DEBIT' });
  expect(byCode(tree, '1202')).toMatchObject({ currentBalance: '100.00', balanceSide: 'CREDIT', normalBalance: 'CREDIT', isContra: true });
  expect(byCode(tree, '1200')).toMatchObject({ currentBalance: '900.00', balanceSide: 'DEBIT' }); // 1,000 - 100
});

test('name / type hints come back as warnings, not errors', async () => {
  const { adm } = await setup();
  const assets = await ok(adm('post', '', { code: '1000', name: 'Assets', accountType: 'ASSET', isGroup: true }));
  const rent = await ok(adm('post', '', { name: 'Office Rent', parentId: assets.id }));
  expect(rent.warnings).toEqual([expect.objectContaining({ code: 'NAME_TYPE_HINT', suggestedAccountType: 'EXPENSE' })]);
  expect(rent.warnings[0].message).toContain('EXPENSE');
  expect((await ok(adm('post', '', { name: 'Petty Cash', parentId: assets.id }))).warnings).toEqual([]);
  // a contra account is allowed an odd name
  expect((await ok(adm('post', '', { name: 'Sales Provision', parentId: assets.id, isContra: true }))).warnings).toEqual([]);
  // and on update
  const cash = await ok(adm('post', '', { name: 'Cash', parentId: assets.id }));
  const patched = await ok(adm('patch', `/${cash.id}`, { name: 'Loan payable' }), 200);
  expect(patched.warnings).toEqual([expect.objectContaining({ code: 'NAME_TYPE_HINT', suggestedAccountType: 'LIABILITY' })]);
  expect((await ok(adm('patch', `/${cash.id}`, { name: 'Cash box' }), 200)).warnings).toEqual([]);
});
