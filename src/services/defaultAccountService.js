// Default accounts (owner 2026-10-28): the accounts the invoices and vouchers post to. Invoices and vouchers always look for the company's default account
// of a role first (accountService.ensureDefault) and only make one when the company has none. This service lets the owner SEE the defaults in one place
// (a "Default accounts" tab), choose an account he already has for a role, or make the standard one now, before the first invoice.
//   list         every role with the account that fills it (the id is the Chart of Accounts id) or "not set"
//   candidates   the accounts of the Chart that may fill a role
//   set          choose an existing account for a role
//   create       make the standard account of a role (or of every role that has none)
// A default account is a system account: its role, type and switch are locked (it may be renamed); that is how the books keep one place for each role.
const { sequelize } = require('../models');
const { Account } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const accountService = require('./accountService');
const catalog = require('./accountCatalog');

const { lockCompany, loadAll, json, byCode } = accountService.internals;
const q = (sql, bind, transaction) => sequelize.query(sql, { bind, transaction }).then(([rows]) => rows);

// the roles, in the order of the screen. `party`: the account holds the balances of customers / vendors, so every line on it names one
const ROLES = [
  { key: 'SALES', group: 'SALES_INVOICE', title: 'Sales', description: 'The income account a sales invoice credits (the invoice amount before tax).', usedBy: ['Sales invoice'] },
  { key: 'OUTPUT_TAX', group: 'SALES_INVOICE', title: 'Sales Tax (Output)', description: 'The sales tax we charge our customers and owe to the government.', usedBy: ['Sales invoice'] },
  { key: 'CUSTOMERS', group: 'SALES_INVOICE', title: 'Accounts Receivable', description: 'What customers owe us. Every line names the customer.', usedBy: ['Sales invoice', 'Receipt voucher', 'Contra voucher'], party: 'CUSTOMER' },
  { key: 'PURCHASES', group: 'PURCHASE_INVOICE', title: 'Purchases / Cost of Goods Sold', description: 'The expense account a purchase invoice debits (the bill amount before tax).', usedBy: ['Purchase invoice'] },
  { key: 'INPUT_TAX', group: 'PURCHASE_INVOICE', title: 'Sales Tax (Input)', description: 'The sales tax our vendors charged us, which we may claim back.', usedBy: ['Purchase invoice'] },
  { key: 'SUPPLIERS', group: 'PURCHASE_INVOICE', title: 'Accounts Payable', description: 'What we owe our vendors. Every line names the vendor.', usedBy: ['Purchase invoice', 'Payment voucher', 'Contra voucher'], party: 'VENDOR' },
  { key: 'INCOME_TAX_CUSTOMERS', group: 'VOUCHERS', title: 'Income Tax - Customers', description: 'Income tax our customers withheld when they paid us.', usedBy: ['Receipt voucher'] },
  { key: 'INCOME_TAX_VENDORS', group: 'VOUCHERS', title: 'Income Tax - Vendors', description: 'Income tax we withhold when we pay our vendors.', usedBy: ['Payment voucher'] },
  { key: 'CUSTOMER_ADVANCES', group: 'VOUCHERS', title: 'Customer Advances', description: 'Money a customer paid before an invoice. Every line names the customer.', usedBy: ['Receipt voucher'], party: 'CUSTOMER' },
  { key: 'SUPPLIER_ADVANCES', group: 'VOUCHERS', title: 'Supplier Advances', description: 'Money we paid a vendor before his bill. Every line names the vendor.', usedBy: ['Payment voucher'], party: 'VENDOR' },
  { key: 'EMPLOYEE_LOANS', group: 'PAYROLL', title: 'Employee Loans', description: 'What employees owe us for the loans we paid them. Each instalment the payroll takes from a salary brings it down.', usedBy: ['Employee loan voucher', 'Payroll'] },
  { key: 'EMPLOYEE_ADVANCES', group: 'PAYROLL', title: 'Employee Advances', description: 'What employees owe us for the advances we paid them. The next payroll takes each advance back from the salary and brings it down.', usedBy: ['Employee advance voucher', 'Payroll'] },
  { key: 'SALARY_EXPENSE', group: 'PAYROLL', title: 'Salaries & Wages', description: 'The expense account every approved payslip debits: the salary earned (basic, overtime and the additions).', usedBy: ['Payroll'] },
  { key: 'SALARIES_PAYABLE', group: 'PAYROLL', title: 'Salaries Payable', description: 'The net salary the company owes its employees from the approved payslip until it is paid by a salary payment voucher.', usedBy: ['Payroll', 'Salary payment voucher'] },
  { key: 'EOBI_PAYABLE', group: 'PAYROLL', title: 'EOBI Payable', description: 'The EOBI withheld from the salaries and owed to EOBI.', usedBy: ['Payroll'] },
  { key: 'SALARY_TAX_PAYABLE', group: 'PAYROLL', title: 'Income Tax Payable - Salaries', description: 'The income tax withheld from the salaries and owed to the government.', usedBy: ['Payroll'] },
  { key: 'EMPLOYEE_DEDUCTIONS', group: 'PAYROLL', title: 'Other Employee Deductions', description: 'The other deductions made from the salaries (the Others deduction of a payslip).', usedBy: ['Payroll'] },
  { key: 'EOBI_EMPLOYER_EXPENSE', group: 'PAYROLL', title: 'EOBI Employer Contribution', description: 'The expense account of the EOBI the company pays for its employees (the employer share), debited by the EOBI contribution voucher.', usedBy: ['EOBI contribution voucher'] },
];
const GROUP_TEXT = { SALES_INVOICE: 'Sales invoice', PURCHASE_INVOICE: 'Purchase invoice', VOUCHERS: 'Vouchers', PAYROLL: 'Payroll' };
const roleOf = (key) => ROLES.find((r) => r.key === key);

function roleOr400(key) {
  const role = roleOf(key);
  if (!role) throw AppError.rule('UNKNOWN_DEFAULT', `${key} is not a default account role`, { roles: ROLES.map((r) => r.key) });
  return role;
}

/** The account that fills a role now (by its system key, else by its control type), or undefined. */
const holder = (rows, key) => rows.find((r) => r.systemKey === catalog.SYSTEM_KEY_OF_CONTROL[key]) || rows.find((r) => r.controlType === key);

/** How many lines every account has, and how many of them do not name a customer / vendor. */
async function usage(companyId, transaction) {
  const rows = await q(`SELECT "accountId", count(*)::int AS lines, count(*) FILTER (WHERE "partyId" IS NULL)::int AS "withoutParty" FROM journal_lines WHERE "companyId" = $1 GROUP BY "accountId"`, [companyId], transaction);
  return new Map(rows.map((r) => [r.accountId, r]));
}

const accountJson = (a, use) => ({ id: a.id, code: a.code, name: a.name, isActive: a.isActive, hasEntries: Boolean((use.get(a.id) || {}).lines) });

function itemJson(role, rows, use) {
  const a = holder(rows, role.key);
  const hasEntries = a ? Boolean((use.get(a.id) || {}).lines) : false;
  return {
    key: role.key, group: role.group, groupText: GROUP_TEXT[role.group], title: role.title, description: role.description, usedBy: role.usedBy,
    accountType: accountService.internals.DEFAULT_ACCOUNTS[role.key].accountType, holdsParties: role.party || null,
    status: !a ? 'NOT_SET' : a.isActive ? 'SET' : 'INACTIVE',
    account: a ? accountJson(a, use) : null,
    // a customer / vendor account that already has entries cannot be swapped for another one: its balances would be split between two accounts
    canChange: !a || !role.party || !hasEntries,
    standardName: accountService.internals.DEFAULT_ACCOUNTS[role.key].name,
  };
}

/** GET /accounts/defaults */
async function list(req) {
  const { companyId } = req.user;
  const { rows } = await loadAll(companyId);
  const use = await usage(companyId);
  const items = ROLES.map((r) => itemJson(r, rows, use));
  return { data: items, missing: items.filter((i) => i.status === 'NOT_SET').length, inactive: items.filter((i) => i.status === 'INACTIVE').length, groups: Object.entries(GROUP_TEXT).map(([code, text]) => ({ code, text })) };
}

/** Why an account cannot fill a role (null when it can). */
function refusal(role, a, use) {
  const def = accountService.internals.DEFAULT_ACCOUNTS[role.key];
  if (a.isGroup) return ['NOT_POSTING_ACCOUNT', `Account ${a.code} (${a.name}) is a folder; choose an account inside it`];
  if (!a.isActive) return ['ACCOUNT_INACTIVE', `Account ${a.code} (${a.name}) is switched off`];
  if (a.accountType !== def.accountType) return ['DEFAULT_TYPE_MISMATCH', `${role.title} must be an ${def.accountType.toLowerCase()} account; ${a.code} (${a.name}) is ${a.accountType.toLowerCase()}`];
  if (a.isContra) return ['ACCOUNT_IS_CONTRA', `Account ${a.code} (${a.name}) is a contra account; it cannot be a default account`];
  const own = a.systemKey === catalog.SYSTEM_KEY_OF_CONTROL[role.key] || a.controlType === role.key;
  if (!own && (a.controlType || a.systemKey)) return ['ACCOUNT_HAS_OTHER_ROLE', `Account ${a.code} (${a.name}) already has another role (${a.controlType || a.systemKey})`];
  if (role.party && !own && (use.get(a.id) || {}).withoutParty) return ['ACCOUNT_HAS_ENTRIES', `Account ${a.code} (${a.name}) has entries that do not name a ${role.party.toLowerCase()}; it cannot hold the ${role.party.toLowerCase()} balances`];
  return null;
}

/** GET /accounts/defaults/:key/candidates */
async function candidates(req, key) {
  const role = roleOr400(key);
  const { companyId } = req.user;
  const { rows } = await loadAll(companyId);
  const use = await usage(companyId);
  const current = holder(rows, key);
  const data = rows.filter((a) => !refusal(role, a, use)).sort(byCode).map((a) => ({ ...accountJson(a, use), accountType: a.accountType, current: Boolean(current && current.id === a.id) }));
  return { key, title: role.title, currentAccountId: current ? current.id : null, data };
}

/** PUT /accounts/defaults/:key  { accountId } */
async function set(req, key, { accountId }) {
  const role = roleOr400(key);
  const { companyId } = req.user;
  const systemKey = catalog.SYSTEM_KEY_OF_CONTROL[key];
  await sequelize.transaction(async (transaction) => {
    await lockCompany(companyId, transaction);
    const { rows } = await loadAll(companyId, transaction);
    const use = await usage(companyId, transaction);
    const a = rows.find((r) => r.id === accountId);
    if (!a) throw AppError.notFound('Account');
    const why = refusal(role, a, use);
    if (why) throw AppError.rule(why[0], why[1]);
    const current = holder(rows, key);
    if (current && current.id === a.id) return; // already the default
    if (current && role.party && (use.get(current.id) || {}).lines) {
      throw AppError.rule('DEFAULT_IN_USE', `${current.code} (${current.name}) is the ${role.title} account and already has entries; the balances of the ${role.party.toLowerCase()}s cannot be split over two accounts`, { currentAccountId: current.id });
    }
    if (current) {
      // the old account stays in the Chart with its history, as an ordinary account
      const old = await Account.findByPk(current.id, { transaction });
      const before = json(old);
      old.controlType = null;
      old.systemKey = null;
      old.isSystem = false;
      await old.save({ transaction });
      await audit.log(req, { action: 'ACCOUNT_UPDATED', entityType: 'Account', entityId: old.id, before, after: { ...json(old), noLongerDefault: key } }, { transaction });
    }
    const row = await Account.findByPk(a.id, { transaction });
    const before = json(row);
    row.controlType = key;
    row.systemKey = systemKey;
    row.isSystem = true;
    await row.save({ transaction });
    await audit.log(req, { action: 'DEFAULT_ACCOUNT_SET', entityType: 'Account', entityId: row.id, before, after: { ...json(row), defaultFor: key, replaced: current ? current.id : null } }, { transaction });
  });
  return one(req, key);
}

async function one(req, key) {
  const { companyId } = req.user;
  const { rows } = await loadAll(companyId);
  return itemJson(roleOf(key), rows, await usage(companyId));
}

/** POST /accounts/defaults/:key/create : makes the standard account of the role when the company has none (nothing changes if it has one). */
async function create(req, key) {
  roleOr400(key);
  await sequelize.transaction(async (transaction) => { await accountService.ensureDefault(req, key, transaction); });
  return one(req, key);
}

/** POST /accounts/defaults/create-all : makes every default account the company does not have yet. */
async function createAll(req) {
  const { companyId } = req.user;
  const created = [];
  await sequelize.transaction(async (transaction) => {
    const { rows } = await loadAll(companyId, transaction);
    for (const role of ROLES) {
      if (holder(rows, role.key)) continue;
      await accountService.ensureDefault(req, role.key, transaction);
      created.push(role.key);
    }
  });
  return { created, ...(await list(req)) };
}

module.exports = { list, candidates, set, create, createAll, ROLES };
