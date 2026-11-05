// Credit terms of customers and vendors: the due date of an invoice (invoice date + the party's credit days) and the credit-limit WARNING.
// The limit never blocks anything: an invoice that takes the party over it is saved and approved, and the answer carries `creditWarning`.
// "Balance" is what the ledger says the party owes us (customer) / we owe the party (vendor) today, so opening balances, vouchers and advances count.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const accountService = require('./accountService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });

const PARTY = {
  CUSTOMER: { table: 'customers', label: 'Customer', sign: 1n, live: ' AND "deletedAt" IS NULL' },
  VENDOR: { table: 'vendors', label: 'Vendor', sign: -1n, live: '' },
};

/** The party's name, credit limit (null = none) and credit days. */
async function termsOf(companyId, partyType, partyId, transaction) {
  const p = PARTY[partyType];
  const [row] = await q(`SELECT id, code, name, "creditLimit"::text AS "creditLimit", "creditDays" FROM ${p.table} WHERE id = :partyId AND "companyId" = :companyId${p.live}`, { partyId, companyId }, transaction);
  if (!row) throw AppError.notFound(p.label);
  return row;
}

/** invoice date + days, as 'YYYY-MM-DD' (calendar days, no time zone involved). */
function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The due date an invoice gets when nobody typed one: invoice date + credit days; null when the party has no credit days (it is due on the invoice date). */
async function defaultDueDate(companyId, partyType, partyId, invoiceDate, transaction) {
  const t = await termsOf(companyId, partyType, partyId, transaction);
  return t.creditDays > 0 ? addDays(invoiceDate, t.creditDays) : null;
}

/** The ledger balance of one party in cents: positive = the party owes us (customer) / we owe the party (vendor). */
async function balanceOf(companyId, partyType, partyId, transaction) {
  const [r] = await q('SELECT COALESCE(SUM(debit - credit), 0)::text AS net FROM journal_lines WHERE "companyId" = :companyId AND "partyType" = :partyType AND "partyId" = :partyId', { companyId, partyType, partyId }, transaction);
  return PARTY[partyType].sign * toCents(r.net);
}

/** GET .../credit/:partyId : the limit, the days, the balance and what is left, for the invoice form. */
async function status(req, partyType, partyId, { add = 0n, transaction } = {}) {
  const { companyId } = req.user;
  const t = await termsOf(companyId, partyType, partyId, transaction);
  const balance = await balanceOf(companyId, partyType, partyId, transaction);
  const limit = t.creditLimit == null ? null : toCents(t.creditLimit);
  const after = balance + add;
  return {
    partyType, partyId: t.id, code: t.code, name: t.name,
    creditLimit: limit === null ? null : fromCents(limit), creditDays: t.creditDays,
    balance: fromCents(balance), available: limit === null ? null : fromCents(limit - balance),
    exceeded: limit !== null && after > limit,
    ...(add ? { thisInvoice: fromCents(add), afterInvoice: fromCents(after) } : {}),
    exceededBy: limit !== null && after > limit ? fromCents(after - limit) : null,
    _cents: { limit, balance, after },
  };
}

/** The warning of an invoice (null when the party has no limit or stays within it). An un-approved invoice counts on top of the balance; an approved one is in it already. */
async function warning(req, partyType, partyId, { status: invoiceStatus, net }, transaction) {
  const add = invoiceStatus === 'UNAPPROVED' ? toCents(String(net)) : 0n;
  const s = await status(req, partyType, partyId, { add, transaction });
  if (s.creditLimit === null || !(s._cents.after > s._cents.limit)) return null;
  const who = PARTY[partyType].label.toLowerCase();
  return {
    code: 'CREDIT_LIMIT_EXCEEDED',
    message: `This ${who} is over the credit limit: ${fromCents(s._cents.after)} against a limit of ${s.creditLimit}`,
    creditLimit: s.creditLimit, balance: s.balance, thisInvoice: fromCents(add), afterInvoice: fromCents(s._cents.after), exceededBy: s.exceededBy,
  };
}

/** `status` for the routes: without the internal cents. */
async function publicStatus(req, partyType, partyId) {
  const { _cents, ...rest } = await status(req, partyType, partyId);
  return rest;
}

module.exports = { termsOf, addDays, defaultDueDate, balanceOf, warning, publicStatus };
