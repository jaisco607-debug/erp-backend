// Profit & Loss and Balance Sheet (service ACC_REPORTS, read only). Both are worked out from the journal lines and the chart of accounts tree,
// never from saved totals. All amounts are exact (cents as BigInt, shown as strings).
//   Profit & Loss   income less cost of sales = gross profit; less expenses = net profit, for a period (movement only, the opening balances entry is not a movement).
//   Balance Sheet   assets, liabilities and equity as at a date. There is no year-end closing in the books, so the profit of the earlier years and of
//                   this fiscal year are shown as two computed lines of the equity; then assets = liabilities + equity (the DIFF is shown, it must be 0).
// A folder is the total of what is inside it. The sign of an amount is its natural one: assets and expenses = debit - credit, the others = credit - debit,
// so a contra account (accumulated depreciation, sales returns) comes out negative inside its folder.
const { sequelize } = require('../models');
const accountService = require('./accountService');
const { range } = require('./trialBalanceService');
const { TOP_CODES } = require('./accountCatalog');

const { loadAll, toCents, fromCents, byCode } = accountService.internals;
const q = (sql, bind) => sequelize.query(sql, { bind }).then(([rows]) => rows);
const abs = (n) => (n < 0n ? -n : n);

/** The movement (debit - credit) of every account, as {accountId -> cents}, for the entries in [from, to] (null = no limit), the opening balances entry excluded or included. */
async function nets(companyId, { from, to, withOpening }) {
  const rows = await q(`SELECT l."accountId", SUM(l.debit - l.credit)::text AS net FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE l."companyId" = $1 AND ($2::date IS NULL OR e."entryDate" >= $2) AND e."entryDate" <= $3 ${withOpening ? '' : `AND e."sourceType" <> 'OPENING'`} GROUP BY l."accountId"`, [companyId, from, to]);
  return new Map(rows.map((r) => [r.accountId, toCents(r.net)]));
}

/**
 * The tree of one section: every account of `types` that passes `pick`, with its folders, each with the amount of what is inside it.
 * `natural` = +1 shows debit - credit, -1 shows credit - debit (a negative amount = the unusual side). A folder or account with nothing in it is left out unless includeZero.
 */
function section(base, net, { types, pick = () => true, natural, includeZero }) {
  const { rows, children } = base;
  const build = (a) => {
    if (a.isGroup) {
      const kids = (children.get(a.id) || []).filter((k) => types.includes(k.accountType)).sort(byCode).map(build).filter(Boolean);
      const sum = kids.reduce((t, k) => t + toCents(k.amount), 0n);
      if (!kids.length && !includeZero) return null;
      return { accountId: a.id, code: a.code, name: a.name, isGroup: true, amount: fromCents(sum), children: kids };
    }
    const v = BigInt(natural) * (net.get(a.id) || 0n);
    if (v === 0n && !includeZero) return null;
    return { accountId: a.id, code: a.code, name: a.name, isGroup: false, isContra: !!a.isContra, amount: fromCents(v), children: [] };
  };
  // start from the top of each tree so that the folders come out nested; an account whose parent is not of these types is a root
  const inSection = (a) => types.includes(a.accountType) && pick(a);
  const roots = rows.filter((a) => inSection(a) && (!a.parentId || !rows.find((p) => p.id === a.parentId) || !inSection(rows.find((p) => p.id === a.parentId)))).sort(byCode);
  const nodes = roots.map(build).filter(Boolean);
  return { nodes, total: nodes.reduce((t, n) => t + toCents(n.amount), 0n) };
}

/** The root (top level folder) of an account. */
function rootOf(byId, a) {
  let r = a;
  while (r.parentId && byId.get(r.parentId)) r = byId.get(r.parentId);
  return r;
}

/** GET /accounting/profit-loss */
async function profitLoss(req, { dateFrom, dateTo, fiscalYear, includeZero }) {
  const { companyId } = req.user;
  const { from, to } = await range(companyId, { dateFrom, dateTo, fiscalYear });
  const base = await loadAll(companyId);
  const net = await nets(companyId, { from, to, withOpening: false });
  const isCost = (a) => rootOf(base.byId, a).code === String(TOP_CODES.COST_OF_SALES);

  const revenue = section(base, net, { types: ['INCOME'], natural: -1, includeZero });
  const cost = section(base, net, { types: ['EXPENSE'], pick: isCost, natural: 1, includeZero });
  const expenses = section(base, net, { types: ['EXPENSE'], pick: (a) => !isCost(a), natural: 1, includeZero });
  const gross = revenue.total - cost.total;
  const profit = gross - expenses.total;
  const side = (n) => (n > 0n ? 'PROFIT' : n < 0n ? 'LOSS' : null);
  return {
    dateFrom: from, dateTo: to,
    revenue: { total: fromCents(revenue.total), nodes: revenue.nodes },
    costOfSales: { total: fromCents(cost.total), nodes: cost.nodes },
    grossProfit: { amount: fromCents(abs(gross)), result: side(gross) },
    expenses: { total: fromCents(expenses.total), nodes: expenses.nodes },
    netProfit: { amount: fromCents(abs(profit)), result: side(profit) },
  };
}

/** GET /accounting/balance-sheet */
async function balanceSheet(req, { date, includeZero }) {
  const { companyId } = req.user;
  const { to, startMonth } = await range(companyId, { dateTo: date });
  const { fiscalYearStart } = require('./trialBalanceService');
  const yearStart = fiscalYearStart(to, startMonth);
  const base = await loadAll(companyId);
  const all = await nets(companyId, { from: null, to, withOpening: true });

  const assets = section(base, all, { types: ['ASSET'], natural: 1, includeZero });
  const liabilities = section(base, all, { types: ['LIABILITY'], natural: -1, includeZero });
  const equity = section(base, all, { types: ['EQUITY'], natural: -1, includeZero });

  // the profit not yet moved into equity: everything income and expense posted up to the date, split at the start of the fiscal year
  const pl = base.rows.filter((a) => !a.isGroup && (a.accountType === 'INCOME' || a.accountType === 'EXPENSE')).map((a) => a.id);
  const before = await q(`SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS p FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE l."companyId" = $1 AND l."accountId" = ANY($2::uuid[]) AND e."entryDate" < $3`, [companyId, pl, yearStart]);
  const during = await q(`SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS p FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE l."companyId" = $1 AND l."accountId" = ANY($2::uuid[]) AND e."entryDate" >= $3 AND e."entryDate" <= $4`, [companyId, pl, yearStart, to]);
  const earlier = toCents(before[0].p);
  const thisYear = toCents(during[0].p);

  const totalEquity = equity.total + earlier + thisYear;
  const totalRight = liabilities.total + totalEquity;
  const diff = assets.total - totalRight;
  const side = (n) => (n > 0n ? 'PROFIT' : n < 0n ? 'LOSS' : null);
  return {
    date: to, fiscalYearStart: yearStart,
    assets: { total: fromCents(assets.total), nodes: assets.nodes },
    liabilities: { total: fromCents(liabilities.total), nodes: liabilities.nodes },
    equity: {
      accountsTotal: fromCents(equity.total), nodes: equity.nodes,
      earlierYears: { amount: fromCents(abs(earlier)), result: side(earlier) },
      thisYear: { amount: fromCents(abs(thisYear)), result: side(thisYear) },
      total: fromCents(totalEquity),
    },
    liabilitiesAndEquity: fromCents(totalRight),
    difference: fromCents(abs(diff)), balanced: diff === 0n,
  };
}

module.exports = { profitLoss, balanceSheet };
