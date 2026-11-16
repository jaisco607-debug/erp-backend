// The Store Management overview (one call for the whole screen): per store the last months of inwards and outwards, the stock position,
// the top vendors and the drafts waiting. Only the stores the person has a service for (Chemical Store / General Store / Fabric Store) are answered.
//   FABRIC (the Fabric Store, cloth bought from vendors): inwards = approved, switched-on fabric inwards (their amount: rate x length, 0 without a rate);
//   outwards = fabric issues to SO cards that are still issued (a returned issue counts nothing); stock value = the same as GET /fabric-inwards/stock; by category = by quality.
// A few aggregated queries for all stores together, run side by side; money is returned as strings with 2 decimals.
//   inwards   approved store inwards by inward date; amount = billed (amount + sales tax)
//   outwards  the approved issues to departments (store moves of kind ISSUE) at the stock rate; the General Store has no outwards yet, so it is zero
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { today } = require('../utils/dates');
const { companyServices, userServices } = require('./accessService');

const STORES = [
  { store: 'CHEMICAL', service: 'CHEMICAL_STORE', name: 'Chemical Store' },
  { store: 'GENERAL', service: 'GENERAL_STORE', name: 'General Store' },
  { store: 'FABRIC', service: 'FABRIC_STORE', name: 'Fabric Store' },
];
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** ['2026-05', ... '2026-10'] oldest -> newest, `months` of them ending with the month of `day` (YYYY-MM-DD, Pakistan date). */
function monthsBack(day, months) {
  let y = Number(day.slice(0, 4));
  let m = Number(day.slice(5, 7));
  const out = [];
  for (let i = 0; i < months; i += 1) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}
const nextMonthStart = (month) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

/** The Fabric Store rows, in the same shapes as the store_inwards queries (every row has store = 'FABRIC'). Value of an entry still in the store = its amount x balance / inward meters. */
async function fabricRows(r) {
  const live = 'f."companyId" = :companyId AND f."deletedAt" IS NULL AND f."isApproved" AND f."isActive"';
  const inRange = 'f."inwardDate" >= :from AND f."inwardDate" < :to';
  const bal = 'GREATEST(f."inwardMeters" - f."outwardMeters", 0)';
  const value = `round(COALESCE(f.amount, 0) * ${bal} / NULLIF(f."inwardMeters", 0), 2)`;
  // what an issue is worth: the amounts of the thaans it holds, or (an entry without a thaan list) its meters x the rate
  const issueValue = `CASE WHEN array_length(fi."thaanNos", 1) > 0 THEN (SELECT COALESCE(SUM(t.amount), 0) FROM fabric_inward_thaans t WHERE t."issueId" = fi.id)
    ELSE fi.meters * COALESCE(f.rate, 0) / CASE WHEN f."rateUnit" = 'YARD' THEN 0.9144 ELSE 1 END END`;
  const [inwards, issues, stock, categories, vendors, drafts] = await Promise.all([
    q(`SELECT 'FABRIC' AS store, to_char(f."inwardDate", 'YYYY-MM') AS month, round(COALESCE(SUM(f.amount), 0), 2)::text AS amount, count(*)::int AS n FROM fabric_inwards f WHERE ${live} AND ${inRange} GROUP BY month`, r),
    q(`SELECT 'FABRIC' AS store, to_char(fi."issueDate", 'YYYY-MM') AS month, round(SUM(${issueValue}), 2)::text AS amount, count(*)::int AS n
       FROM fabric_issues fi JOIN fabric_inwards f ON f.id = fi."fabricInwardId" WHERE fi."companyId" = :companyId AND fi."cancelledAt" IS NULL AND fi."issueDate" >= :from AND fi."issueDate" < :to GROUP BY month`, r),
    q(`SELECT 'FABRIC' AS store, round(COALESCE(SUM(${value}), 0), 2)::text AS value, count(*) FILTER (WHERE ${bal} > 0)::int AS items, 0 AS low, 0 AS out FROM fabric_inwards f WHERE ${live}`, r),
    q(`SELECT 'FABRIC' AS store, ql.name AS category, round(SUM(${value}), 2)::text AS value, count(*) FILTER (WHERE ${bal} > 0)::int AS items
       FROM fabric_inwards f JOIN qualities ql ON ql.id = f."qualityId" WHERE ${live} GROUP BY ql.id, ql.name HAVING SUM(${value}) > 0 ORDER BY SUM(${value}) DESC`, r),
    q(`SELECT * FROM (SELECT 'FABRIC' AS store, v.id AS "vendorId", v.name, round(COALESCE(SUM(f.amount), 0), 2)::text AS amount, count(*)::int AS n,
         row_number() OVER (ORDER BY COALESCE(SUM(f.amount), 0) DESC, v.name) AS rn
       FROM fabric_inwards f JOIN vendors v ON v.id = f."vendorId" WHERE ${live} AND ${inRange} GROUP BY v.id, v.name) t WHERE rn <= 10 ORDER BY rn`, r),
    q('SELECT \'FABRIC\' AS store, count(*)::int AS n FROM fabric_inwards f WHERE f."companyId" = :companyId AND f."deletedAt" IS NULL AND NOT f."isApproved"', r),
  ]);
  return { inwards, issues, stock, categories, vendors, drafts };
}

async function overview(req, { months = 6 } = {}) {
  const asOf = today();
  const { companyId, userType } = req.user;
  if (!companyId) return { asOf, stores: [] };
  const have = new Set((await companyServices(companyId)).map((s) => s.code));
  const own = userType === 'CLIENT_ADMIN' ? null : new Set((await userServices(req.user)).map((g) => g.service.code));
  const allowed = STORES.filter((s) => have.has(s.service) && (!own || own.has(s.service)));
  if (!allowed.length) return { asOf, stores: [] };

  const keys = allowed.map((s) => s.store);
  const list = monthsBack(asOf, months);
  const r = { companyId, stores: keys, from: `${list[0]}-01`, to: nextMonthStart(list[list.length - 1]) };
  const inwardWhere = 'i."companyId" = :companyId AND i.store IN (:stores) AND i."isApproved" AND i."inwardDate" >= :from AND i."inwardDate" < :to';
  const [inwards, issues, stock, categories, vendors, draftInwards, pending, fabric] = await Promise.all([
    q(`SELECT i.store, to_char(i."inwardDate", 'YYYY-MM') AS month, round(SUM(i.amount + i."salesTax"), 2)::text AS amount, count(*)::int AS n
       FROM store_inwards i WHERE ${inwardWhere} GROUP BY i.store, month`, r),
    q(`SELECT mv.store, to_char(mv."moveDate", 'YYYY-MM') AS month, round(-SUM(mv.value), 2)::text AS amount, count(DISTINCT COALESCE(mv."requestId", mv.id))::int AS n
       FROM store_moves mv WHERE mv."companyId" = :companyId AND mv.store IN (:stores) AND mv.kind = 'ISSUE' AND mv."moveDate" >= :from AND mv."moveDate" < :to GROUP BY mv.store, month`, r),
    q(`SELECT it.store, round(COALESCE(SUM(it."stockValue"), 0), 2)::text AS value, count(*) FILTER (WHERE it."stockQty" > 0)::int AS items,
         count(*) FILTER (WHERE it."isActive" AND it."stockQty" > 0 AND it."reorderLevel" IS NOT NULL AND it."stockQty" <= it."reorderLevel")::int AS low,
         count(*) FILTER (WHERE it."isActive" AND it."stockQty" <= 0)::int AS out
       FROM store_items it WHERE it."companyId" = :companyId AND it.store IN (:stores) GROUP BY it.store`, r),
    q(`SELECT it.store, COALESCE(c.name, 'No category') AS category, round(SUM(it."stockValue"), 2)::text AS value, count(*) FILTER (WHERE it."stockQty" > 0)::int AS items
       FROM store_items it LEFT JOIN store_categories c ON c.id = it."categoryId" WHERE it."companyId" = :companyId AND it.store IN (:stores)
       GROUP BY it.store, c.id, c.name HAVING SUM(it."stockValue") > 0 ORDER BY it.store, SUM(it."stockValue") DESC`, r),
    q(`SELECT * FROM (SELECT i.store, v.id AS "vendorId", v.name, round(SUM(i.amount + i."salesTax"), 2)::text AS amount, count(*)::int AS n,
         row_number() OVER (PARTITION BY i.store ORDER BY SUM(i.amount + i."salesTax") DESC, v.name) AS rn
       FROM store_inwards i JOIN vendors v ON v.id = i."vendorId" WHERE ${inwardWhere} GROUP BY i.store, v.id, v.name) t WHERE rn <= 10 ORDER BY store, rn`, r),
    q('SELECT i.store, count(*)::int AS n FROM store_inwards i WHERE i."companyId" = :companyId AND i.store IN (:stores) AND NOT i."isApproved" GROUP BY i.store', r),
    // chemical requests the store has not sent yet (Queue and Process): the outwards still waiting
    keys.includes('CHEMICAL') ? q('SELECT count(*)::int AS n FROM chemical_requests WHERE "companyId" = :companyId AND status IN (\'PENDING\', \'ACCEPTED\')', r) : [],
    keys.includes('FABRIC') ? fabricRows(r) : null,
  ]);
  if (fabric) {
    inwards.push(...fabric.inwards); issues.push(...fabric.issues); stock.push(...fabric.stock); categories.push(...fabric.categories); vendors.push(...fabric.vendors); draftInwards.push(...fabric.drafts);
  }

  const pick = (rows, store) => rows.filter((x) => x.store === store);
  return {
    asOf,
    stores: allowed.map(({ store, name }) => {
      const inn = new Map(pick(inwards, store).map((x) => [x.month, x]));
      const out = new Map(pick(issues, store).map((x) => [x.month, x]));
      const s = pick(stock, store)[0] || { value: '0.00', items: 0, low: 0, out: 0 };
      return {
        store, name,
        series: list.map((month) => ({
          month,
          inwardsAmount: inn.has(month) ? inn.get(month).amount : '0.00', inwardsCount: inn.has(month) ? inn.get(month).n : 0,
          outwardsAmount: out.has(month) ? out.get(month).amount : '0.00', outwardsCount: out.has(month) ? out.get(month).n : 0,
        })),
        stock: {
          value: s.value, itemCount: s.items, lowCount: s.low, outCount: s.out,
          byCategory: pick(categories, store).map((c) => ({ category: c.category, value: c.value, items: c.items })),
        },
        topVendors: pick(vendors, store).map((v) => ({ vendorId: v.vendorId, name: v.name, amount: v.amount, count: v.n })),
        drafts: { inwards: (pick(draftInwards, store)[0] || { n: 0 }).n, outwards: store === 'CHEMICAL' ? (pending[0] || { n: 0 }).n : 0 },
      };
    }),
  };
}

module.exports = { overview, monthsBack };
