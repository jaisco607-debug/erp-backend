// GET /accounts/issues: the problems of the chart, worked out by the server so the screen only shows them.
// Each issue: { accountId, ruleKey, severity (ERROR | WARNING | INFO), message, suggestedFix: { action, payload } | null }.
// A fix is something the frontend can send as it is: action PATCH_ACCOUNT -> PATCH /accounts/:id with `payload`;
// action APPLY_TEMPLATE -> POST /accounts/apply-template with `payload`. `suggestedFix` is null when only a person can decide.
// Switched-off accounts are looked at where it matters (a balance on a switched-off account). Contra accounts are left out of the side rules.
const { sequelize } = require('../models');
const catalog = require('./accountCatalog');
const accountService = require('./accountService');

const { context, fromCents, toCents, nameHints } = accountService.internals;

const RULES = [
  { key: 'OPENING_WRONG_SIDE', severity: 'WARNING', label: 'The opening balance is on the opposite side of the normal balance of the account' },
  { key: 'BALANCE_WRONG_SIDE', severity: 'WARNING', label: 'The balance is on the opposite side of the normal balance of the account' },
  { key: 'INACTIVE_WITH_BALANCE', severity: 'ERROR', label: 'A switched-off account still has a balance' },
  { key: 'NAME_TYPE_MISMATCH', severity: 'INFO', label: 'The name looks like another type of account' },
  { key: 'SYSTEM_ACCOUNT_MISSING', severity: 'WARNING', label: 'An account the software needs does not exist yet' },
  { key: 'EMPTY_FOLDER', severity: 'INFO', label: 'A folder with nothing inside it' },
];
const severity = (key) => RULES.find((r) => r.key === key).severity;

async function list(req) {
  const { companyId } = req.user;
  const ctx = await context(companyId);
  const issues = [];
  const add = (accountId, ruleKey, message, suggestedFix = null) => issues.push({ accountId, ruleKey, severity: severity(ruleKey), message, suggestedFix });

  // opening balances sitting on the wrong side (contra accounts are meant to be on the other side)
  const [opening] = await sequelize.query(`SELECT l."accountId", l.debit::text AS debit, l.credit::text AS credit FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE e."companyId" = $1 AND e."sourceType" = 'OPENING' AND e.status = 'POSTED' AND e."reversalOfId" IS NULL`, { bind: [companyId] });
  for (const l of opening) {
    const a = ctx.byId.get(l.accountId);
    if (!a || a.isContra) continue;
    const side = toCents(l.debit) > 0n ? 'DEBIT' : 'CREDIT';
    if (side !== a.normalBalance) add(a.id, 'OPENING_WRONG_SIDE', `${a.code} ${a.name}: the opening balance is on the ${side.toLowerCase()} side, but this account normally has a ${a.normalBalance.toLowerCase()} balance`);
  }

  for (const a of ctx.rows) {
    const net = ctx.total.get(a.id) || 0n;
    const label = `${a.code} ${a.name}`;
    if (!a.isGroup && net !== 0n && !a.isContra) {
      const side = net > 0n ? 'DEBIT' : 'CREDIT';
      if (side !== a.normalBalance) add(a.id, 'BALANCE_WRONG_SIDE', `${label}: the balance of ${fromCents(net < 0n ? -net : net)} is on the ${side.toLowerCase()} side, but this account normally has a ${a.normalBalance.toLowerCase()} balance`);
    }
    if (!a.isActive && net !== 0n) {
      add(a.id, 'INACTIVE_WITH_BALANCE', `${label} is switched off but still has a balance of ${fromCents(net < 0n ? -net : net)}`, { action: 'PATCH_ACCOUNT', accountId: a.id, payload: { isActive: true } });
    }
    const hint = nameHints(a.name, a.accountType, a.isContra)[0];
    if (hint) {
      const canRetype = !a.parentId && !(ctx.children.get(a.id) || []).length && !(ctx.own.get(a.id) || {}).n;
      add(a.id, 'NAME_TYPE_MISMATCH', `${label}: ${hint.message}`, canRetype ? { action: 'PATCH_ACCOUNT', accountId: a.id, payload: { accountType: hint.suggestedAccountType } } : null);
    }
    if (a.isGroup && a.isActive && !(ctx.children.get(a.id) || []).length) {
      add(a.id, 'EMPTY_FOLDER', `${label} is a folder with no accounts inside it`, { action: 'PATCH_ACCOUNT', accountId: a.id, payload: { isActive: false } });
    }
  }

  // the accounts the software relies on: only worth saying once the chart has something in it
  if (ctx.rows.length) {
    for (const [key, v] of Object.entries(catalog.SYSTEM_KEYS)) {
      if (ctx.rows.some((r) => r.systemKey === key)) continue;
      issues.push({
        accountId: null, ruleKey: 'SYSTEM_ACCOUNT_MISSING', severity: severity('SYSTEM_ACCOUNT_MISSING'),
        message: `There is no "${v.label}" account (${key}). It is made by a template, or when the first invoice needs it`,
        suggestedFix: { action: 'APPLY_TEMPLATE', payload: { templateKey: 'other' } }, systemKey: key,
      });
    }
  }

  const order = { ERROR: 0, WARNING: 1, INFO: 2 };
  issues.sort((x, y) => order[x.severity] - order[y.severity]);
  return {
    data: issues, total: issues.length,
    summary: { ERROR: issues.filter((i) => i.severity === 'ERROR').length, WARNING: issues.filter((i) => i.severity === 'WARNING').length, INFO: issues.filter((i) => i.severity === 'INFO').length },
    rules: RULES,
  };
}

module.exports = { list, RULES };
