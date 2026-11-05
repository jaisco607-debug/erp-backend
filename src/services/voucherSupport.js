// Small things the three voucher services (payment, receipt, journal) share. Money is worked out in cents (BigInt): exact, never a float.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const accountService = require('./accountService');
const { today } = require('../utils/dates');

const { toCents, fromCents } = accountService.internals;

const MODES = ['CASH', 'CHEQUE', 'ONLINE', 'PAY_ORDER'];
const MODE_TEXT = { CASH: 'Cash', CHEQUE: 'Cheque', ONLINE: 'Online / bank transfer', PAY_ORDER: 'Pay order' };
const STATUS_TEXT = { DRAFT: 'Draft', CONFIRMED: 'Confirmed' };
// only suggestions for the dropdown: any rate from 0 up to (but not including) 100 is accepted
const INCOME_TAX_RATES = [0, 0.25, 0.5, 1, 1.5, 2, 3, 4.5, 5, 7.5, 10, 15];

const label = (n) => String(n).padStart(5, '0');
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const lock = (name, companyId, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `${name}:${companyId}` }, transaction });

/** An amount typed by the user (a decimal string "1500.50" or a number with at most 2 decimals) as exact cents; must be more than zero. */
function amountCents(value, where) {
  const text = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) throw AppError.rule('BAD_AMOUNT', `${where}: the amount must be a number with at most 2 decimals`);
  const c = toCents(text);
  if (c <= 0n) throw AppError.rule('BAD_AMOUNT', `${where}: the amount must be more than zero`);
  return c;
}
/** A number (with 2 decimals) from cents, for the journal and for answers. */
const num = (c) => Number(fromCents(c));

const rateBp = (rate) => BigInt(Math.round(Number(rate) * 100)); // 0.25 % -> 25 basis points of a percent: 25 / 10000
/** Income tax withheld from a GROSS amount: gross x rate / 100, half a paisa goes up. */
const taxOnGross = (gross, bp) => (gross * bp * 2n + 10000n) / 20000n;
/** Income tax when the NET amount (what was really paid) is known: the gross was net / (1 - rate); tax = gross - net. */
const taxOnNet = (net, bp) => (net * bp * 2n + (10000n - bp)) / (2n * (10000n - bp));

const dayDiff = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const ageDays = (date) => dayDiff(date, today());

/** The bank or cash accounts of the company (for the "pay from" / "deposit into" picker). */
async function bankAndCashAccounts(companyId, transaction) {
  return q(`SELECT id, code, name, "controlType" FROM accounts WHERE "companyId" = :companyId AND "controlType" IN ('BANK', 'CASH') AND NOT "isGroup" AND "isActive" ORDER BY code`, { companyId }, transaction);
}

async function bankOrCash(companyId, accountId, transaction) {
  const [a] = await q('SELECT id, code, name, "controlType", "isGroup", "isActive" FROM accounts WHERE id = :accountId AND "companyId" = :companyId', { accountId, companyId }, transaction);
  if (!a) throw AppError.notFound('Bank / cash account');
  if (a.isGroup) throw AppError.rule('NOT_POSTING_ACCOUNT', `${a.code} (${a.name}) is a folder; pick a bank or cash account`);
  if (!a.isActive) throw AppError.rule('ACCOUNT_INACTIVE', `Account ${a.code} (${a.name}) is switched off`);
  if (a.controlType !== 'BANK' && a.controlType !== 'CASH') throw AppError.rule('NOT_BANK_OR_CASH', `${a.code} (${a.name}) is not a bank or cash account`);
  return a;
}

const nextNo = async (table, companyId, transaction) => ((await q(`SELECT MAX("voucherNo") AS m FROM ${table} WHERE "companyId" = :companyId`, { companyId }, transaction))[0].m || 0) + 1;

module.exports = {
  MODES, MODE_TEXT, STATUS_TEXT, INCOME_TAX_RATES, label, q, lock, amountCents, num, rateBp, taxOnGross, taxOnNet, ageDays, bankAndCashAccounts, bankOrCash, nextNo, toCents, fromCents,
};
