// Chart of Accounts. Every company has its own tree of accounts; another company's accounts are "not found".
// Group accounts are folders (they only hold other accounts); posting accounts are the ones entries are posted to. Rules (accounting practice):
//   - a parent is always an active group account of the SAME type; the type of a child follows its parent
//   - only posting accounts have a control type
//   - an account with children, or with entries, cannot be deleted (it can be switched off, but only when its balance is zero)
//   - a system account (default sales, receivable ... see accountCatalog.SYSTEM_KEYS) cannot be deleted, switched off or re-typed; it may be renamed
//   - a contra account (accumulated depreciation, drawings, sales returns) has the opposite normal balance of its type
// Opening balances are NOT kept on the account: they are one real journal entry (openingBalanceService).
// Every change runs in one transaction under one lock per company, so two people cannot break the tree together.
const { Op } = require('sequelize');
const { sequelize, Account } = require('../models');
const { ACCOUNT_TYPES, NORMAL_BALANCE, SUB_TYPES, CONTROL_TYPES } = require('../models/Account');
const catalog = require('./accountCatalog');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const MAX_DEPTH = 8; // levels from the top folder down to the last account
const OPPOSITE = { DEBIT: 'CREDIT', CREDIT: 'DEBIT' };
const normalBalanceOf = (accountType, isContra) => (isContra ? OPPOSITE[NORMAL_BALANCE[accountType]] : NORMAL_BALANCE[accountType]);

const json = (a, extra = {}) => ({
  id: a.id, code: a.code, name: a.name, parentId: a.parentId, isGroup: a.isGroup, accountType: a.accountType, normalBalance: a.normalBalance,
  subType: a.subType, controlType: a.controlType, isActive: a.isActive,
  isSystem: a.isSystem, systemKey: a.systemKey, isContra: a.isContra, isLocked: a.isSystem, // isLocked = old name of isSystem
  // legacy, readable only: the opening balance is now one journal entry (GET /accounting/opening-balances)
  openingBalance: Number(a.openingBalance), openingSide: a.openingSide,
  ...extra,
});

const normalizeCode = (code) => String(code).trim().toUpperCase();
const blank = (v) => (v === '' ? null : v);
const byCode = (a, b) => a.code.length - b.code.length || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const isNumeric = (code) => /^\d{1,15}$/.test(code);

// ---- money: exact, in cents, never a float ----------------------------------------------------------------------------------------
const toCents = (text) => {
  const s = String(text);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const c = BigInt(whole || '0') * 100n + BigInt(`${frac}00`.slice(0, 2));
  return neg ? -c : c;
};
const fromCents = (c) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const text = `${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
  return neg ? `-${text}` : text;
};

const lockCompany = (companyId, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`coa:${companyId}`], transaction });

async function loadAll(companyId, transaction) {
  const rows = await Account.findAll({ where: { companyId }, raw: true, transaction });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map();
  for (const r of rows) if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) || []), r]);
  return { rows, byId, children };
}

/** Everything a screen needs about the tree: the accounts, and the balance (debit - credit, in cents) of each, folders rolled up. */
async function context(companyId, transaction) {
  const base = await loadAll(companyId, transaction);
  const [lines] = await sequelize.query('SELECT "accountId", SUM(debit)::text AS d, SUM(credit)::text AS c, count(*)::int AS n FROM journal_lines WHERE "companyId" = $1 GROUP BY "accountId"', { bind: [companyId], transaction });
  const own = new Map(lines.map((l) => [l.accountId, { net: toCents(l.d) - toCents(l.c), n: l.n }]));
  const total = new Map();
  for (const r of base.rows) {
    const o = own.get(r.id);
    if (!o || o.net === 0n) continue;
    for (let a = r; a; a = a.parentId && base.byId.get(a.parentId)) total.set(a.id, (total.get(a.id) || 0n) + o.net);
  }
  return { ...base, own, total };
}

/** Levels from the top folder down to this account (a top account is level 1). */
function depthOf(account, byId) {
  let n = 1;
  for (let p = account.parentId && byId.get(account.parentId); p; p = p.parentId && byId.get(p.parentId)) n += 1;
  return n;
}

/** Levels below this account (0 when it has no children). */
function heightBelow(id, children) {
  return (children.get(id) || []).reduce((max, c) => Math.max(max, 1 + heightBelow(c.id, children)), 0);
}

function isInside(candidate, ancestorId, byId) {
  for (let p = candidate; p; p = p.parentId && byId.get(p.parentId)) if (p.id === ancestorId) return true;
  return false;
}

/** A new parent must be an active group account, and the tree may not get too deep. `below` = levels the moved account brings along. */
function checkParent(parent, byId, below = 0) {
  if (!parent.isGroup) throw AppError.rule('PARENT_NOT_GROUP', `Account ${parent.code} is not a group account; only a group account can hold other accounts`);
  if (!parent.isActive) throw AppError.rule('PARENT_INACTIVE', `Group account ${parent.code} is switched off`);
  if (depthOf(parent, byId) + 1 + below > MAX_DEPTH) throw AppError.rule('TOO_DEEP', `The chart of accounts can have at most ${MAX_DEPTH} levels`);
}

const nameTakenAmongSiblings = (rows, parentId, name, exceptId) => rows.some((r) => r.id !== exceptId && (r.parentId || null) === (parentId || null) && r.name.toLowerCase() === name.toLowerCase());

/** Rules about the account's own shape (after all changes are applied). */
function checkShape(a) {
  if (a.subType && !SUB_TYPES[a.accountType].includes(a.subType)) {
    throw AppError.rule('BAD_SUB_TYPE', `Sub type ${a.subType} does not belong to ${a.accountType}`, { allowed: SUB_TYPES[a.accountType] });
  }
  if (a.controlType) {
    if (a.isGroup) throw AppError.rule('GROUP_CANNOT_BE_CONTROL', 'A group account cannot be a control account');
    if (CONTROL_TYPES[a.controlType].accountType !== a.accountType) {
      throw AppError.rule('CONTROL_TYPE_MISMATCH', `A ${a.controlType} account must be of type ${CONTROL_TYPES[a.controlType].accountType}`);
    }
  }
}

function checkControlFree(rows, controlType, exceptId) {
  if (!controlType || !CONTROL_TYPES[controlType].single) return;
  const other = rows.find((r) => r.id !== exceptId && r.controlType === controlType);
  if (other) throw AppError.rule('CONTROL_TAKEN', `Account ${other.code} (${other.name}) is already the ${controlType} control account`);
}

/** An opening balance is no longer a field of the account: it goes through PUT /accounting/opening-balances. */
function refuseLooseOpening(value) {
  if (value !== undefined && value !== null && Number(value) !== 0) {
    throw AppError.rule('USE_OPENING_BALANCES', 'An opening balance is not entered on the account. Use PUT /accounting/opening-balances');
  }
}

// ---- code numbers -------------------------------------------------------------------------------------------------------------------

/**
 * The next free code (switched-off accounts count as taken).
 *   top account: Asset 1000, Liability 2000, Equity 3000, Income 4000, Cost of Sales 5000, Operating Expenses 6000 (then +100 until free)
 *   folder inside a top account: parent + 100 (+100 until free)      posting account inside a top account: parent + 1
 *   deeper: the highest sibling + 1
 */
function nextCodeFor(rows, { parent, accountType, isGroup, subType }) {
  const taken = new Set(rows.map((r) => r.code));
  const free = (start, step) => {
    let n = start;
    while (taken.has(String(n))) n += step;
    return String(n);
  };
  if (!parent) {
    const base = accountType === 'EXPENSE' ? (subType === 'COST_OF_SALES' ? catalog.TOP_CODES.COST_OF_SALES : catalog.TOP_CODES.OPERATING_EXPENSE) : catalog.TOP_CODES[accountType];
    return { code: free(base, 100), rule: 'TOP' };
  }
  if (!isNumeric(parent.code)) {
    const biggest = Math.max(999, ...rows.filter((r) => isNumeric(r.code)).map((r) => Number(r.code)));
    return { code: free(biggest + 1, 1), rule: 'AFTER_LAST' };
  }
  const base = Number(parent.code);
  if (!parent.parentId) return isGroup ? { code: free(base + 100, 100), rule: 'FOLDER_IN_TOP' } : { code: free(base + 1, 1), rule: 'POSTING_IN_TOP' };
  const siblings = rows.filter((r) => r.parentId === parent.id && isNumeric(r.code)).map((r) => Number(r.code));
  return { code: free((siblings.length ? Math.max(...siblings) : base) + 1, 1), rule: 'SIBLING' };
}

/** GET /accounts/next-code */
async function nextCode(req, { parentId, accountType, isGroup, subType }) {
  const { rows, byId } = await loadAll(req.user.companyId);
  let parent = null;
  let type = accountType;
  if (parentId) {
    parent = byId.get(parentId);
    if (!parent) throw AppError.notFound('Parent account');
    type = parent.accountType;
  } else if (!type) {
    throw AppError.rule('TYPE_REQUIRED', 'A top account needs an account type (Asset, Liability, Equity, Income or Expense)');
  }
  return nextCodeFor(rows, { parent, accountType: type, isGroup: Boolean(isGroup), subType });
}

// ---- screens: balances, what can be done ----------------------------------------------------------------------------------------------

function view(a, ctx, extra = {}) {
  const net = ctx.total.get(a.id) || 0n;
  const kids = ctx.children.get(a.id) || [];
  const deleteReason = a.isSystem ? 'SYSTEM_LOCKED' : kids.length ? 'HAS_CHILDREN' : (ctx.own.get(a.id) || {}).n ? 'HAS_ENTRIES' : null;
  const deactivateReason = !a.isActive ? 'ALREADY_INACTIVE' : a.isSystem ? 'SYSTEM_LOCKED' : kids.some((k) => k.isActive) ? 'HAS_ACTIVE_CHILDREN' : net !== 0n ? 'HAS_BALANCE' : null;
  return json(a, {
    currentBalance: fromCents(net < 0n ? -net : net), balanceSide: net > 0n ? 'DEBIT' : net < 0n ? 'CREDIT' : null, balanceSigned: fromCents(net),
    canDelete: !deleteReason, deleteReason, canDeactivate: !deactivateReason, deactivateReason,
    level: depthOf(a, ctx.byId), parentCode: ctx.byId.get(a.parentId)?.code ?? null, parentName: ctx.byId.get(a.parentId)?.name ?? null, childCount: kids.length,
    ...extra,
  });
}

/** Hints, not errors: the name looks like another kind of account. */
const NAME_HINTS = [
  [/\b(cash|bank|receivable|inventory|stock|equipment|machinery|furniture|vehicle|prepaid|deposit)\b/i, 'ASSET'],
  [/\b(payable|loan|accrued|borrowing|overdraft)\b/i, 'LIABILITY'],
  [/\b(capital|drawings?|retained|reserves?|equity)\b/i, 'EQUITY'],
  [/\b(sales|revenue|income|commission earned)\b(?!\s*tax)/i, 'INCOME'], // "Sales Tax" and "Income Tax" are tax accounts, not income
  [/\b(expenses?|rent|salary|salaries|wages|electricity|utilities|internet|phone|charges|fuel|freight|repairs?|cost of)\b/i, 'EXPENSE'],
];
function nameHints(name, accountType, isContra) {
  if (isContra) return [];
  const hits = NAME_HINTS.filter(([re]) => re.test(name));
  // no hint when the name does not point anywhere, or when one of the guesses is the account's own type ("Bank loan" may be either)
  if (!hits.length || hits.some(([, type]) => type === accountType)) return [];
  return [{ code: 'NAME_TYPE_HINT', message: `"${name}" usually belongs to ${hits[0][1]}, but this account is ${accountType}`, suggestedAccountType: hits[0][1] }];
}

function options() {
  return {
    accountTypes: ACCOUNT_TYPES,
    normalBalance: NORMAL_BALANCE,
    contraRule: 'A contra account (isContra) has the opposite normal balance of its type.',
    subTypes: SUB_TYPES,
    controlTypes: Object.entries(CONTROL_TYPES).map(([code, c]) => ({ code, accountType: c.accountType, onlyOne: c.single })),
    maxLevels: MAX_DEPTH,
    // one definition of the expense ranges: both are of type EXPENSE
    topCodes: catalog.TOP_CODES,
    expenseRanges: {
      costOfGoodsSold: { code: String(catalog.TOP_CODES.COST_OF_SALES), accountType: 'EXPENSE', subType: 'COST_OF_SALES', name: catalog.FOLDERS[5000].name },
      operatingExpenses: { code: String(catalog.TOP_CODES.OPERATING_EXPENSE), accountType: 'EXPENSE', subType: 'OPERATING_EXPENSE', name: catalog.FOLDERS[6000].name },
    },
    folders: Object.values(catalog.FOLDERS),
    systemKeys: Object.entries(catalog.SYSTEM_KEYS).map(([key, v]) => ({ key, label: v.label, controlType: v.controlType })),
  };
}

// the cards of the "add an account" wizard: the default accounts (receivable, payable, sales, sales tax) are made in the Default Accounts tab, not here
function presets() {
  return { data: catalog.PRESETS.filter((p) => !catalog.DEFAULT_ROLE_KEYS.includes(p.controlType)) };
}

/** A default role (Accounts Receivable, Sales, ...) is given in the Default Accounts tab; the Chart of Accounts screen cannot give or take it. */
function refuseDefaultRole(controlType, currentControlType = null) {
  if (controlType && controlType !== currentControlType && catalog.DEFAULT_ROLE_KEYS.includes(controlType)) {
    throw AppError.rule('USE_DEFAULT_ACCOUNTS', 'Default accounts (the ones invoices and vouchers post to) are made and chosen in the Default Accounts tab', { controlType });
  }
}

async function list(req, { page, limit, search, accountType, isGroup, isActive, parentId }) {
  const where = { companyId: req.user.companyId };
  if (accountType) where.accountType = accountType;
  if (isGroup !== undefined) where.isGroup = isGroup;
  if (isActive !== undefined) where.isActive = isActive;
  if (parentId) where.parentId = parentId;
  if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { code: { [Op.iLike]: `%${search}%` } }];
  const { rows, count } = await Account.findAndCountAll({ where, order: [[sequelize.fn('length', sequelize.col('code')), 'ASC'], ['code', 'ASC']], limit, offset: (page - 1) * limit, raw: true });
  const ctx = await context(req.user.companyId);
  return { data: rows.map((r) => view(r, ctx)), page, limit, total: count };
}

/** The whole chart as a tree (top folders with their accounts inside), codes in order. */
async function tree(req, { isActive }) {
  const ctx = await context(req.user.companyId);
  const keep = (r) => isActive === undefined || r.isActive === isActive;
  const build = (r) => ({ ...view(r, ctx), children: (ctx.children.get(r.id) || []).filter(keep).sort(byCode).map(build) });
  return { data: ctx.rows.filter((r) => !r.parentId && keep(r)).sort(byCode).map(build), total: ctx.rows.length };
}

async function get(req, id, extra = {}) {
  const ctx = await context(req.user.companyId);
  const a = ctx.byId.get(id);
  if (!a) throw AppError.notFound('Account');
  return view(a, ctx, extra);
}

// ---- presets ----------------------------------------------------------------------------------------------------------------------

function missingFolder(code, rows) {
  const have = new Set(rows.map((r) => r.code));
  const chain = [];
  for (let f = catalog.FOLDERS[code]; f; f = f.parentCode ? catalog.FOLDERS[f.parentCode] : null) if (!have.has(f.code)) chain.unshift(f);
  return AppError.rule('PARENT_FOLDER_MISSING', `The folder "${catalog.FOLDERS[code].name}" (${code}) does not exist yet. Create it first`, { suggestedFolder: catalog.FOLDERS[code], missingFolders: chain });
}

/** Fills what the client left out from the chosen preset (what the client sent wins). */
function withPreset(data, rows) {
  if (!data.presetKey) return data;
  const p = catalog.PRESETS.find((x) => x.key === data.presetKey);
  if (!p) throw AppError.rule('UNKNOWN_PRESET', `There is no preset ${data.presetKey}`);
  if (data.controlType === undefined) refuseDefaultRole(p.controlType);
  const filled = { ...data };
  for (const f of ['accountType', 'subType', 'controlType', 'isContra']) if (filled[f] === undefined) filled[f] = p[f];
  if (!filled.name) filled.name = p.defaultName;
  if (!filled.parentId) {
    const parent = rows.find((r) => r.code === p.suggestedParentCode);
    if (!parent) throw missingFolder(p.suggestedParentCode, rows);
    filled.parentId = parent.id;
  }
  return filled;
}

// ---- create / update / delete -----------------------------------------------------------------------------------------------------

async function create(req, input) {
  const { companyId } = req.user;
  refuseLooseOpening(input.openingBalance);
  const created = await sequelize.transaction(async (transaction) => {
    await lockCompany(companyId, transaction);
    const { rows, byId } = await loadAll(companyId, transaction);
    const data = withPreset(input, rows);
    refuseDefaultRole(blank(data.controlType) ?? null);
    if (!data.name) throw AppError.rule('NAME_REQUIRED', 'The account needs a name');

    let accountType = data.accountType;
    let parent = null;
    if (data.parentId) {
      parent = byId.get(data.parentId);
      if (!parent) throw AppError.notFound('Parent account');
      checkParent(parent, byId);
      if (accountType && accountType !== parent.accountType) throw AppError.rule('TYPE_MISMATCH', `This account is inside ${parent.code}, so its type is ${parent.accountType}`);
      accountType = parent.accountType;
    } else if (!accountType) {
      throw AppError.rule('TYPE_REQUIRED', 'A top account needs an account type (Asset, Liability, Equity, Income or Expense)');
    }
    if (nameTakenAmongSiblings(rows, data.parentId, data.name, null)) throw AppError.rule('NAME_TAKEN', `"${data.name}" already exists at this place`);

    // codes are given under the company lock, so two people adding at the same moment never get the same code
    const code = data.code ? normalizeCode(data.code) : nextCodeFor(rows, { parent, accountType, isGroup: Boolean(data.isGroup), subType: blank(data.subType) ?? undefined }).code;
    if (rows.some((r) => r.code === code)) throw AppError.rule('CODE_TAKEN', `Account code ${code} already exists`);

    // an old client that sends the opposite normal balance means a contra account
    const isContra = Boolean(data.isContra) || Boolean(data.normalBalance && data.normalBalance !== normalBalanceOf(accountType, false));
    const normalBalance = normalBalanceOf(accountType, isContra);
    const fields = {
      companyId, code, name: data.name, parentId: data.parentId || null, isGroup: Boolean(data.isGroup), accountType, normalBalance,
      subType: blank(data.subType) ?? null, controlType: blank(data.controlType) ?? null, isContra, isActive: data.isActive !== false,
      openingBalance: 0, openingSide: normalBalance, createdById: req.user.id,
    };
    checkShape(fields);
    checkControlFree(rows, fields.controlType, null);

    const row = await Account.create(fields, { transaction });
    await audit.log(req, { action: 'ACCOUNT_CREATED', entityType: 'Account', entityId: row.id, after: json(row) }, { transaction });
    return { id: row.id, warnings: nameHints(fields.name, accountType, isContra) };
  });
  return get(req, created.id, { warnings: created.warnings });
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  refuseLooseOpening(changes.openingBalance);
  const warnings = await sequelize.transaction(async (transaction) => {
    await lockCompany(companyId, transaction);
    const row = await Account.findOne({ where: { id, companyId }, transaction });
    if (!row) throw AppError.notFound('Account');
    const ctx = await context(companyId, transaction);
    const { rows, byId, children } = ctx;
    const current = byId.get(id);
    const before = json(row);
    const merged = { ...current };
    const has = (f) => changes[f] !== undefined;

    // a system account keeps its role: only its name, code and place may change
    if (current.isSystem) {
      const retype = (has('accountType') && changes.accountType !== current.accountType) || (has('isGroup') && changes.isGroup !== current.isGroup)
        || (has('controlType') && blank(changes.controlType) !== current.controlType) || (has('isContra') && changes.isContra !== current.isContra) || (has('normalBalance') && changes.normalBalance !== current.normalBalance);
      if (retype || changes.isActive === false) throw AppError.rule('SYSTEM_LOCKED', 'This is a system account; its type, group flag, control type and switch cannot change. You may rename it');
    }

    if (has('code')) {
      merged.code = normalizeCode(changes.code);
      if (rows.some((r) => r.id !== id && r.code === merged.code)) throw AppError.rule('CODE_TAKEN', `Account code ${merged.code} already exists`);
    }
    if (has('name')) merged.name = changes.name;

    // where it sits: the new parent must be an active group account of the same type, not itself or inside itself
    const wantedType = changes.accountType ?? current.accountType;
    if (has('parentId') && blank(changes.parentId) !== current.parentId) {
      merged.parentId = blank(changes.parentId);
      if (merged.parentId) {
        const parent = byId.get(merged.parentId);
        if (!parent) throw AppError.notFound('Parent account');
        if (isInside(parent, id, byId)) throw AppError.rule('CYCLE', 'An account cannot be moved inside itself');
        checkParent(parent, byId, heightBelow(id, children));
        if (parent.accountType !== wantedType) throw AppError.rule('TYPE_MISMATCH', `Account ${parent.code} is of type ${parent.accountType}; this account is ${wantedType}`);
      }
    }

    // type: only a top account without accounts inside it and without entries may change it
    if (changes.accountType && changes.accountType !== current.accountType) {
      if (merged.parentId || (children.get(id) || []).length || (ctx.own.get(id) || {}).n) {
        throw AppError.rule('TYPE_LOCKED', 'The type follows the parent account, and cannot change once the account holds accounts or entries');
      }
      merged.accountType = changes.accountType;
      if (merged.subType && !SUB_TYPES[merged.accountType].includes(merged.subType) && !has('subType')) merged.subType = null;
    }

    if (has('isContra')) merged.isContra = changes.isContra;
    // an old client that sends the opposite normal balance means a contra account
    if (has('normalBalance') && !has('isContra')) merged.isContra = changes.normalBalance !== normalBalanceOf(merged.accountType, false);
    if (has('subType')) merged.subType = blank(changes.subType);
    if (has('controlType')) { merged.controlType = blank(changes.controlType); refuseDefaultRole(merged.controlType, current.controlType); }
    merged.normalBalance = normalBalanceOf(merged.accountType, merged.isContra);
    merged.openingSide = merged.normalBalance;

    if (has('isGroup') && changes.isGroup !== current.isGroup) {
      if (changes.isGroup && (ctx.own.get(id) || {}).n) throw AppError.rule('HAS_ENTRIES', 'This account already has entries; it cannot become a group account');
      if (!changes.isGroup && (children.get(id) || []).length) throw AppError.rule('HAS_CHILDREN', 'This account holds other accounts; it must stay a group account');
      merged.isGroup = changes.isGroup;
    }

    if (has('isActive') && changes.isActive !== current.isActive) {
      if (!changes.isActive) {
        if ((children.get(id) || []).some((c) => c.isActive)) throw AppError.rule('HAS_ACTIVE_CHILDREN', 'Switch off the accounts inside it first');
        const net = ctx.total.get(id) || 0n;
        if (net !== 0n) throw AppError.rule('HAS_BALANCE', `This account still has a balance of ${fromCents(net < 0n ? -net : net)} ${net > 0n ? 'debit' : 'credit'}; it cannot be switched off`, { amount: fromCents(net < 0n ? -net : net), side: net > 0n ? 'DEBIT' : 'CREDIT' });
      }
      if (changes.isActive && merged.parentId && !byId.get(merged.parentId).isActive) throw AppError.rule('PARENT_INACTIVE', 'The group account it sits in is switched off');
      merged.isActive = changes.isActive;
    }

    if (nameTakenAmongSiblings(rows, merged.parentId, merged.name, id)) throw AppError.rule('NAME_TAKEN', `"${merged.name}" already exists at this place`);
    checkShape(merged);
    checkControlFree(rows, merged.controlType, id);

    for (const f of ['code', 'name', 'parentId', 'isGroup', 'accountType', 'normalBalance', 'subType', 'controlType', 'isContra', 'isActive', 'openingSide']) row[f] = merged[f];
    await row.save({ transaction });
    await audit.log(req, { action: 'ACCOUNT_UPDATED', entityType: 'Account', entityId: id, before, after: json(row) }, { transaction });
    return nameHints(merged.name, merged.accountType, merged.isContra);
  });
  return get(req, id, { warnings });
}

/** Delete: only an account with no accounts inside it and no entries. Otherwise it can be switched off. */
async function remove(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockCompany(companyId, transaction);
    const row = await Account.findOne({ where: { id, companyId }, transaction });
    if (!row) throw AppError.notFound('Account');
    if (row.isSystem) throw AppError.rule('SYSTEM_LOCKED', 'This is a system account; it cannot be deleted');
    const ctx = await context(companyId, transaction);
    if ((ctx.children.get(id) || []).length) throw AppError.rule('HAS_CHILDREN', 'This account holds other accounts; delete or move them first');
    if ((ctx.own.get(id) || {}).n) throw AppError.rule('HAS_ENTRIES', 'This account has entries; it can only be switched off');
    const before = json(row);
    await row.destroy({ transaction });
    await audit.log(req, { action: 'ACCOUNT_DELETED', entityType: 'Account', entityId: id, before }, { transaction });
  });
}

// ---- default accounts (found or made when an invoice needs them) -------------------------------------------------------------------------

/**
 * A sales invoice needs three accounts: Accounts Receivable, Sales and Sales Tax - Output. They are found by their system key / control type.
 * If the company has none yet, they are made here, with the folders above them, as system accounts. A folder that already exists under
 * another spelling ("Assets") is reused, never doubled. An account of the same name that the user made earlier is adopted.
 */
const header = (name, match, subType = null) => ({ name, match, subType });
const DEFAULT_ACCOUNTS = {
  CUSTOMERS: {
    name: 'Accounts Receivable', accountType: 'ASSET', subType: 'CURRENT_ASSET',
    path: [header('Assets', /^assets?$/i), header('Current Assets', /^current assets?$/i, 'CURRENT_ASSET')],
  },
  OUTPUT_TAX: {
    name: 'Output Sales Tax', accountType: 'LIABILITY', subType: 'CURRENT_LIABILITY', alsoNamed: /^sales tax\s*-\s*output$/i,
    path: [header('Liabilities', /^liabilit(y|ies)$/i), header('Current Liabilities', /^current liabilit(y|ies)$/i, 'CURRENT_LIABILITY')],
  },
  SALES: {
    name: 'Sales', accountType: 'INCOME', subType: 'OPERATING_REVENUE',
    path: [header('Income', /^(revenue|income)$/i)],
  },
  // the three of a purchase invoice
  SUPPLIERS: {
    name: 'Accounts Payable', accountType: 'LIABILITY', subType: 'CURRENT_LIABILITY', alsoNamed: /^trade (and other )?payables?$/i,
    path: [header('Liabilities', /^liabilit(y|ies)$/i), header('Current Liabilities', /^current liabilit(y|ies)$/i, 'CURRENT_LIABILITY')],
  },
  INPUT_TAX: {
    name: 'Input Sales Tax', accountType: 'ASSET', subType: 'CURRENT_ASSET', alsoNamed: /^sales tax\s*-\s*input$/i,
    path: [header('Assets', /^assets?$/i), header('Current Assets', /^current assets?$/i, 'CURRENT_ASSET')],
  },
  PURCHASES: {
    name: 'Purchases', accountType: 'EXPENSE', subType: 'COST_OF_SALES', alsoNamed: /^(cost of goods sold|purchases)$/i,
    path: [header('Cost of Sales', /^cost of (sales?|goods sold)$/i, 'COST_OF_SALES')],
  },
  // the vouchers: income tax withheld, and money paid / received in advance
  INCOME_TAX_CUSTOMERS: {
    name: 'Income Tax - Customers', accountType: 'ASSET', subType: 'CURRENT_ASSET', alsoNamed: /^income tax\s*-\s*customers?$/i,
    path: [header('Assets', /^assets?$/i), header('Current Assets', /^current assets?$/i, 'CURRENT_ASSET')],
  },
  INCOME_TAX_VENDORS: {
    name: 'Income Tax - Vendors', accountType: 'LIABILITY', subType: 'CURRENT_LIABILITY', alsoNamed: /^income tax\s*-\s*vendors?$/i,
    path: [header('Liabilities', /^liabilit(y|ies)$/i), header('Current Liabilities', /^current liabilit(y|ies)$/i, 'CURRENT_LIABILITY')],
  },
  CUSTOMER_ADVANCES: {
    name: 'Customer Advances', accountType: 'LIABILITY', subType: 'CURRENT_LIABILITY', alsoNamed: /^(customer advances?|advances? from customers?)$/i,
    path: [header('Liabilities', /^liabilit(y|ies)$/i), header('Current Liabilities', /^current liabilit(y|ies)$/i, 'CURRENT_LIABILITY')],
  },
  SUPPLIER_ADVANCES: {
    name: 'Supplier Advances', accountType: 'ASSET', subType: 'CURRENT_ASSET', alsoNamed: /^((supplier|vendor) advances?|advances? to (suppliers?|vendors?))$/i,
    path: [header('Assets', /^assets?$/i), header('Current Assets', /^current assets?$/i, 'CURRENT_ASSET')],
  },
  // payroll: what employees owe us for the loans we paid them
  // payroll: what the approved payrolls post to
  SALARY_EXPENSE: {
    name: 'Salaries & Wages', accountType: 'EXPENSE', subType: 'OPERATING_EXPENSE', alsoNamed: /^(salar(y|ies)(s*(and|&)s*wages)?|wages(s*(and|&)s*salar(y|ies))?|staff cost|payroll expense)$/i,
    path: [header('Operating Expenses', /^operating expenses?$/i, 'OPERATING_EXPENSE')],
  },
  SALARIES_PAYABLE: {
    name: 'Salaries Payable', accountType: 'LIABILITY', subType: 'CURRENT_LIABILITY', alsoNamed: /^(salar(y|ies)(s*(and|&)s*wages)? payable|wages payable|payroll payable)$/i,
    path: [header('Liabilities', /^liabilit(y|ies)$/i), header('Current Liabilities', /^current liabilit(y|ies)$/i, 'CURRENT_LIABILITY')],
  },
  EOBI_PAYABLE: {
    name: 'EOBI Payable', accountType: 'LIABILITY', subType: 'CURRENT_LIABILITY', alsoNamed: /^eobi( contribution)?( payable)?$/i,
    path: [header('Liabilities', /^liabilit(y|ies)$/i), header('Current Liabilities', /^current liabilit(y|ies)$/i, 'CURRENT_LIABILITY')],
  },
  SALARY_TAX_PAYABLE: {
    name: 'Income Tax Payable - Salaries', accountType: 'LIABILITY', subType: 'CURRENT_LIABILITY', alsoNamed: /^(income tax payables*-s*salar(y|ies)|salary tax( payable)?|tax payable on salar(y|ies))$/i,
    path: [header('Liabilities', /^liabilit(y|ies)$/i), header('Current Liabilities', /^current liabilit(y|ies)$/i, 'CURRENT_LIABILITY')],
  },
  EMPLOYEE_DEDUCTIONS: {
    name: 'Other Employee Deductions', accountType: 'LIABILITY', subType: 'CURRENT_LIABILITY', alsoNamed: /^((other )?(employee|staff|salary) deductions?( payable)?)$/i,
    path: [header('Liabilities', /^liabilit(y|ies)$/i), header('Current Liabilities', /^current liabilit(y|ies)$/i, 'CURRENT_LIABILITY')],
  },
  EOBI_EMPLOYER_EXPENSE: {
    name: 'EOBI Employer Contribution', accountType: 'EXPENSE', subType: 'OPERATING_EXPENSE', alsoNamed: /^(eobi( employer)?( contribution| expense)|employer'?s? eobi( contribution)?)$/i,
    path: [header('Operating Expenses', /^operating expenses?$/i, 'OPERATING_EXPENSE')],
  },
  EMPLOYEE_ADVANCES: {
    name: 'Employee Advances', accountType: 'ASSET', subType: 'CURRENT_ASSET', alsoNamed: /^((employee|staff|salary) advances?|advances? (to|from) (employees?|staff))$/i,
    path: [header('Assets', /^assets?$/i), header('Current Assets', /^current assets?$/i, 'CURRENT_ASSET')],
  },
  EMPLOYEE_LOANS: {
    name: 'Employee Loans', accountType: 'ASSET', subType: 'CURRENT_ASSET', alsoNamed: /^((employee|staff) loans?|loans? (to|from) (employees?|staff)|loans? and advances? to (employees?|staff))$/i,
    path: [header('Assets', /^assets?$/i), header('Current Assets', /^current assets?$/i, 'CURRENT_ASSET')],
  },
};

async function addAccount(req, rows, byId, f, transaction) {
  const parent = f.parentId ? byId.get(f.parentId) : null;
  if (parent) checkParent(parent, byId);
  const normalBalance = normalBalanceOf(f.accountType, false);
  const fields = {
    companyId: req.user.companyId, code: nextCodeFor(rows, { parent, accountType: f.accountType, isGroup: Boolean(f.isGroup), subType: f.subType }).code,
    name: f.name, parentId: f.parentId || null, isGroup: Boolean(f.isGroup), accountType: f.accountType, normalBalance,
    subType: f.subType || null, controlType: f.controlType || null, isActive: true, isSystem: Boolean(f.systemKey), systemKey: f.systemKey || null,
    isContra: false, openingBalance: 0, openingSide: normalBalance, createdById: req.user.id,
  };
  checkShape(fields);
  if (nameTakenAmongSiblings(rows, fields.parentId, fields.name, null)) throw AppError.rule('NAME_TAKEN', `"${fields.name}" already exists at this place`);
  const row = await Account.create(fields, { transaction });
  const plain = row.get({ plain: true });
  rows.push(plain);
  byId.set(plain.id, plain);
  await audit.log(req, { action: 'ACCOUNT_CREATED', entityType: 'Account', entityId: plain.id, after: { ...json(plain), createdBySystem: true } }, { transaction });
  return plain;
}

/** The id of the account for this control type (CUSTOMERS, OUTPUT_TAX or SALES); makes it when the company has none. Needs the caller's transaction. */
async function ensureDefault(req, controlType, transaction) {
  const def = DEFAULT_ACCOUNTS[controlType];
  if (!def) throw new Error(`No default account for ${controlType}`);
  const systemKey = catalog.SYSTEM_KEY_OF_CONTROL[controlType];
  const { companyId } = req.user;
  await lockCompany(companyId, transaction);
  const { rows, byId } = await loadAll(companyId, transaction);

  const found = rows.find((r) => r.systemKey === systemKey) || rows.find((r) => r.controlType === controlType);
  if (found) {
    if (!found.isActive) throw AppError.rule('DEFAULT_ACCOUNT_INACTIVE', `Account ${found.code} (${found.name}) is the ${systemKey} account but it is switched off; switch it on first`);
    return found.id;
  }

  // an account of the same name that the user made earlier (anywhere in the chart) becomes the default account
  const same = rows.find((r) => !r.isGroup && !r.controlType && !r.systemKey && r.accountType === def.accountType
    && (r.name.toLowerCase() === def.name.toLowerCase() || (def.alsoNamed && def.alsoNamed.test(r.name))));
  if (same) {
    const row = await Account.findByPk(same.id, { transaction });
    const before = json(row);
    row.controlType = controlType;
    row.isSystem = true;
    row.systemKey = systemKey;
    await row.save({ transaction });
    await audit.log(req, { action: 'ACCOUNT_UPDATED', entityType: 'Account', entityId: row.id, before, after: { ...json(row), madeDefaultBySystem: true } }, { transaction });
    return row.id;
  }

  let parent = null;
  for (const step of def.path) {
    let node = rows.find((r) => (r.parentId || null) === (parent ? parent.id : null) && r.isGroup && r.accountType === def.accountType && step.match.test(r.name));
    if (!node) node = await addAccount(req, rows, byId, { name: step.name, parentId: parent && parent.id, isGroup: true, accountType: def.accountType, subType: step.subType }, transaction);
    parent = node;
  }
  const made = await addAccount(req, rows, byId, { name: def.name, parentId: parent && parent.id, isGroup: false, accountType: def.accountType, subType: def.subType, controlType, systemKey }, transaction);
  return made.id;
}

module.exports = {
  options, presets, nextCode, list, tree, get, create, update, remove, ensureDefault, MAX_DEPTH,
  // for the template, opening balance and issue services
  internals: { lockCompany, loadAll, context, json, view, nameHints, checkShape, nameTakenAmongSiblings, normalBalanceOf, nextCodeFor, toCents, fromCents, normalizeCode, byCode, DEFAULT_ACCOUNTS },
};
