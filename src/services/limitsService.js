// The limits and the date rules of a company (owner 2026-11-25): the standard values of config/limits.js, changed by the client admin in Settings > Limits.
//   - one value for ALL the quantities (meters, bags, store quantities ... not the lot number, money or salary), and/or one value for each one; a value for one wins
//   - rates have no limit
//   - the dates: an opening date (nothing before it), and how far ahead a stock / production document and a voucher may be dated
// The validate middleware reads the effective numbers of the company of the request (cached for a few seconds, cleared when the settings are saved).
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const LIMITS = require('../config/limits');
const { today, addYears } = require('../utils/dates');

const { DEFS } = LIMITS;
const TTL_MS = 15000;
const cache = new Map(); // companyId -> { at, row }

// the date fields of a body, by how far ahead they may be (everything else is "other": up to dateYears ahead)
const STOCK_DATES = ['inwardDate', 'returnDate', 'outwardDate', 'jobDate', 'processDate', 'usageDate', 'issueDate', 'adjDate', 'inspectionDate', 'batchDate', 'receiptDate', 'beamDate', 'passDate'];
const VOUCHER_DATES = ['voucherDate', 'invoiceDate', 'contractDate', 'deliveryDate', 'poDate', 'cardDate', 'entryDate', 'clearedDate'];
const OTHER_DATES = ['date', 'dueDate', 'chequeDate', 'etaDate', 'startDate', 'endDate', 'statusDate', 'applicationDate', 'lastWorkingDay', 'holidayDate', 'leavingDate', 'advanceDate',
  'ratesFrom', 'fromDate', 'toDate', 'effectiveDate', 'effectiveFrom', 'promisedDate', 'asOf', 'expectedDate'];
const OLD_DATES = ['joiningDate'];

async function rowOf(companyId, force = false) {
  if (!companyId) return null;
  const hit = cache.get(companyId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.row;
  const [row] = await sequelize.query(`SELECT "allQuantities"::text AS "allQuantities", "limits", to_char("openingDate", 'YYYY-MM-DD') AS "openingDate", "maxFutureDaysStock", "maxFutureDaysVouchers"
    FROM company_limits WHERE "companyId" = :companyId`, { replacements: { companyId }, type: 'SELECT' });
  cache.set(companyId, { at: Date.now(), row: row || null });
  return row || null;
}
const forget = (companyId) => cache.delete(companyId);

/** The effective numbers: standard < one value for all the quantities < the value of that one. */
function numbersOf(row) {
  const all = row && row.allQuantities != null ? Math.min(Number(row.allQuantities), LIMITS.QUANTITY_HARD_MAX) : null;
  const own = (row && row.limits) || {};
  const out = {};
  for (const [k, d] of Object.entries(DEFS)) {
    let v = d.default;
    if (all != null && d.group === 'quantity') v = Math.min(all, d.hardMax);
    if (own[k] != null) v = Math.min(Number(own[k]), d.hardMax);
    out[k] = v;
  }
  return out;
}

/** The allowed days of each kind of date. */
function windowsOf(row) {
  const t = today();
  const back = addYears(t, -LIMITS.dateYears);
  const min = row && row.openingDate && row.openingDate > back ? row.openingDate : back;
  const far = addYears(t, LIMITS.dateYears);
  const ahead = (days) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); const x = d.toISOString().slice(0, 10); return x > far ? far : x; };
  const stockDays = row ? row.maxFutureDaysStock : LIMITS.maxFutureDaysStock;
  const voucherDays = row ? row.maxFutureDaysVouchers : LIMITS.maxFutureDaysVouchers;
  const old = addYears(t, -40);
  return {
    today: t, openingDate: (row && row.openingDate) || null,
    stock: { min, max: ahead(stockDays) }, voucher: { min, max: ahead(voucherDays) }, other: { min, max: far }, old: { min: old, max: far },
  };
}

/** What a request needs: the numbers (Joi context) and the date windows. Without a company (a login) the standard values. */
async function forCompany(companyId) {
  const row = await rowOf(companyId);
  return { numbers: numbersOf(row), windows: windowsOf(row), row };
}

// ---- Settings > Limits (client admin) ----

function settingsJson(row) {
  const own = (row && row.limits) || {};
  const numbers = numbersOf(row);
  return {
    allQuantities: row && row.allQuantities != null ? Number(row.allQuantities) : null,
    allQuantitiesMax: LIMITS.QUANTITY_HARD_MAX,
    items: Object.entries(DEFS).map(([key, d]) => ({
      key, label: d.label, group: d.group, unit: d.unit, standard: d.default, hardMax: d.hardMax, custom: own[key] != null ? Number(own[key]) : null, effective: numbers[key],
    })),
    dates: {
      openingDate: (row && row.openingDate) || null,
      maxFutureDaysStock: row ? row.maxFutureDaysStock : LIMITS.maxFutureDaysStock,
      maxFutureDaysVouchers: row ? row.maxFutureDaysVouchers : LIMITS.maxFutureDaysVouchers,
      standard: { maxFutureDaysStock: LIMITS.maxFutureDaysStock, maxFutureDaysVouchers: LIMITS.maxFutureDaysVouchers },
    },
    note: 'Rates (price per kg, lb or meter) have no limit. A value for one item wins over the value for all the quantities.',
  };
}

async function getSettings(req) {
  return settingsJson(await rowOf(req.user.companyId, true));
}

/** PUT: only what is sent changes; null puts an item back to the standard (or to the value for all the quantities). */
async function saveSettings(req, input) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const [cur] = await sequelize.query(`SELECT "allQuantities"::text AS "allQuantities", "limits", to_char("openingDate", 'YYYY-MM-DD') AS "openingDate", "maxFutureDaysStock", "maxFutureDaysVouchers"
      FROM company_limits WHERE "companyId" = :companyId FOR UPDATE`, { replacements: { companyId }, type: 'SELECT', transaction });
    const before = settingsJson(cur || null);
    const next = {
      allQuantities: input.allQuantities !== undefined ? input.allQuantities : (cur && cur.allQuantities != null ? Number(cur.allQuantities) : null),
      limits: { ...((cur && cur.limits) || {}) },
      openingDate: input.openingDate !== undefined ? input.openingDate : ((cur && cur.openingDate) || null),
      maxFutureDaysStock: input.maxFutureDaysStock !== undefined ? input.maxFutureDaysStock : (cur ? cur.maxFutureDaysStock : LIMITS.maxFutureDaysStock),
      maxFutureDaysVouchers: input.maxFutureDaysVouchers !== undefined ? input.maxFutureDaysVouchers : (cur ? cur.maxFutureDaysVouchers : LIMITS.maxFutureDaysVouchers),
    };
    for (const [k, v] of Object.entries(input.limits || {})) {
      if (!DEFS[k]) throw AppError.validation([{ field: `limits.${k}`, message: `${k} is not a limit that can be set` }]);
      if (v === null) delete next.limits[k];
      else if (v > DEFS[k].hardMax) throw AppError.validation([{ field: `limits.${k}`, message: `${DEFS[k].label}: the highest value you can set is ${DEFS[k].hardMax}` }]);
      else next.limits[k] = v;
    }
    if (next.openingDate && next.openingDate > today()) throw AppError.rule('OPENING_DATE_FUTURE', 'The opening date cannot be a day that has not come yet', { field: 'openingDate' });
    await sequelize.query(`INSERT INTO company_limits ("companyId", "allQuantities", "limits", "openingDate", "maxFutureDaysStock", "maxFutureDaysVouchers", "updatedById")
      VALUES (:companyId, :allQuantities, CAST(:limits AS jsonb), :openingDate, :stock, :vouchers, :userId)
      ON CONFLICT ("companyId") DO UPDATE SET "allQuantities" = EXCLUDED."allQuantities", "limits" = EXCLUDED."limits", "openingDate" = EXCLUDED."openingDate",
        "maxFutureDaysStock" = EXCLUDED."maxFutureDaysStock", "maxFutureDaysVouchers" = EXCLUDED."maxFutureDaysVouchers", "updatedById" = EXCLUDED."updatedById", "updatedAt" = now()`,
    { replacements: { companyId, allQuantities: next.allQuantities, limits: JSON.stringify(next.limits), openingDate: next.openingDate, stock: next.maxFutureDaysStock, vouchers: next.maxFutureDaysVouchers, userId: req.user.id }, transaction });
    const after = settingsJson({ ...next, allQuantities: next.allQuantities == null ? null : String(next.allQuantities) });
    await audit.log(req, { action: 'LIMITS_CHANGED', entityType: 'CompanyLimits', entityId: companyId, before, after }, { transaction });
  });
  forget(companyId);
  return getSettings(req);
}

module.exports = { forCompany, rowOf, forget, numbersOf, windowsOf, getSettings, saveSettings, STOCK_DATES, VOUCHER_DATES, OTHER_DATES, OLD_DATES };
