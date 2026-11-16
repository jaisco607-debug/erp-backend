// Yarn cost of Jobs and SO cards: the value of the yarn a department USED (departmentYarnService) is the yarn cost, next to the chemical cost.
// A use that names an SO card is that card's cost; a use for the whole job is shared between the job's SO cards by their meters in the job (like a chemical request for the whole job).
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { round: r2 } = require('../utils/money');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const title = (r) => (r.brand ? `${r.yarnName} - ${r.brand}` : r.yarnName);

/** The yarn uses of these jobs: [{ id, usageNo, usageDate, jobId, soCardId, departmentId, departmentName, totalBags, totalLbs, totalValue, lines: [{ title, bags, lbs, value }] }]. */
async function usagesOf(companyId, jobIds, transaction) {
  if (!jobIds.length) return [];
  const rows = await q(`SELECT u.id, u."usageNo", to_char(u."usageDate", 'YYYY-MM-DD') AS "usageDate", u."jobId", u."soCardId", u."departmentId", svc_name(s.id, u."companyId", s.name) AS "departmentName",
      s.code AS "departmentCode", u."totalBags", u."totalLbs"::float AS "totalLbs", u."totalValue"::float AS "totalValue"
    FROM store_yarn_usages u JOIN services s ON s.id = u."departmentId" WHERE u."companyId" = :companyId AND u."jobId" IN (:jobIds) ORDER BY u."usageDate", u."usageNo"`, { companyId, jobIds }, transaction);
  if (!rows.length) return [];
  const lines = await q(`SELECT ul."usageId", ul.bags, ul.lbs::float AS lbs, ul.value::float AS value, i."yarnName", i.brand
    FROM store_yarn_usage_lines ul JOIN store_yarn_outward_lines l ON l.id = ul."outwardLineId" JOIN store_yarn_inwards i ON i.id = l."inwardId" WHERE ul."usageId" IN (:ids)`, { ids: rows.map((r) => r.id) }, transaction);
  return rows.map((u) => ({ ...u, lines: lines.filter((l) => l.usageId === u.id).map((l) => ({ title: title(l), bags: l.bags, lbs: l.lbs, value: l.value })) }));
}

/** The part of a use that belongs to an SO card: the card it was made for, or the card's share (by meters) of a use for the whole job. */
const factor = (u, cardId, share) => (u.soCardId ? (u.soCardId === cardId ? 1 : 0) : (share[u.jobId] || 0));

/** Add up the lines by yarn: [{ title, bags, lbs, value }], biggest value first. */
function itemsOf(parts) {
  const by = new Map();
  for (const { u, f } of parts) {
    for (const l of u.lines) {
      const x = by.get(l.title) || { title: l.title, bags: 0, lbs: 0, value: 0 };
      x.bags += l.bags * f;
      x.lbs += l.lbs * f;
      x.value += l.value * f;
      by.set(l.title, x);
    }
  }
  return [...by.values()].map((x) => ({ title: x.title, bags: r2(x.bags), lbs: r2(x.lbs), value: r2(x.value) })).filter((x) => x.value > 0 || x.bags > 0).sort((a, b) => b.value - a.value);
}

const usageBrief = (u, f = 1) => ({ id: u.id, usageNo: u.usageNo, usageText: String(u.usageNo).padStart(5, '0'), usageDate: u.usageDate, department: { id: u.departmentId, code: u.departmentCode, name: u.departmentName }, soCardId: u.soCardId, bags: r2(u.totalBags * f), lbs: r2(u.totalLbs * f), value: r2(u.totalValue * f) });

/** The yarn cost of one Job: everything its department(s) used on it. */
async function jobYarn(req, jobId) {
  const usages = await usagesOf(req.user.companyId, [jobId]);
  return { totalValue: r2(usages.reduce((t, u) => t + u.totalValue, 0)), totalBags: usages.reduce((t, u) => t + u.totalBags, 0), items: itemsOf(usages.map((u) => ({ u, f: 1 }))), usages: usages.map((u) => usageBrief(u)) };
}

/** The yarn cost of one SO card over its jobs; `share[jobId]` = the card's share of the job (by meters). `byJob` = value per job. */
async function cardYarn(req, cardId, jobIds, share) {
  const usages = await usagesOf(req.user.companyId, jobIds);
  const parts = usages.map((u) => ({ u, f: factor(u, cardId, share) })).filter((p) => p.f > 0);
  const byJob = new Map();
  const departments = new Map();
  for (const { u, f } of parts) {
    byJob.set(u.jobId, r2((byJob.get(u.jobId) || 0) + u.totalValue * f));
    departments.set(u.jobId, { id: u.departmentId, code: u.departmentCode, name: u.departmentName });
  }
  return { totalValue: r2(parts.reduce((t, p) => t + p.u.totalValue * p.f, 0)), totalBags: r2(parts.reduce((t, p) => t + p.u.totalBags * p.f, 0)), items: itemsOf(parts), usages: parts.map((p) => usageBrief(p.u, p.f)), byJob, departments };
}

/** For the cost report: the uses (by usageDate) of a department, as plain rows. */
async function reportUsages(companyId, { departmentId, dateFrom, dateTo }) {
  const where = ['u."companyId" = :companyId'];
  const r = { companyId };
  if (departmentId) { where.push('u."departmentId" = :departmentId'); r.departmentId = departmentId; }
  if (dateFrom) { where.push('u."usageDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('u."usageDate" <= :dateTo'); r.dateTo = dateTo; }
  return q(`SELECT u.id, u."usageDate", u."jobId", u."soCardId", u."departmentId", u."totalValue"::float AS "totalValue" FROM store_yarn_usages u WHERE ${where.join(' AND ')} ORDER BY u."usageDate", u."usageNo"`, r);
}

/**
 * The yarn uses of these jobs: Map(jobId -> [{ jobId, soCardId, value, bags, lbs, usageId, requestId, titles }]) (for the job lists: yarn amount, bags, lbs per job / per SO card).
 * `.pending` on every list = the yarn requests of the job still waiting at the store (Pending / Accepted): [{ soCardId }].
 */
async function valuesOfJobs(jobIds) {
  const out = new Map(jobIds.map((id) => {
    const list = [];
    list.pending = [];
    return [id, list];
  }));
  if (!jobIds.length) return out;
  const rows = await q(`SELECT u."jobId", u."soCardId", u."totalValue"::float AS value, u."totalBags" AS bags, u."totalLbs"::float AS lbs, u.id AS "usageId", u."requestId",
      (SELECT array_agg(DISTINCT i."yarnName" || COALESCE(' - ' || i.brand, '')) FROM store_yarn_usage_lines ul JOIN store_yarn_outward_lines l ON l.id = ul."outwardLineId" JOIN store_yarn_inwards i ON i.id = l."inwardId" WHERE ul."usageId" = u.id) AS titles
    FROM store_yarn_usages u WHERE u."jobId" IN (:jobIds)`, { jobIds });
  for (const r of rows) out.get(r.jobId).push(r);
  const open = await q(`SELECT "jobId", "soCardId" FROM yarn_requests WHERE "jobId" IN (:jobIds) AND status IN ('PENDING', 'ACCEPTED')`, { jobIds });
  for (const r of open) out.get(r.jobId).pending.push({ soCardId: r.soCardId });
  return out;
}

/**
 * The yarn columns of one row of a job list (the whole job, or one SO card of it with its share of the job): what the departments used on it, like the chemical columns.
 *   yarnCount (different yarns), yarnBags, yarnLbs, yarnAmount, yarnPerMeter, yarnUsages, yarnRequests (sent requests), pendingYarnRequests (still at the store)
 */
function yarnCols(rows, meters, card) {
  let amount = 0;
  let bags = 0;
  let lbs = 0;
  const titles = new Set();
  const requests = new Set();
  let usages = 0;
  for (const l of rows || []) {
    const f = !card ? 1 : (l.soCardId ? (l.soCardId === card.id ? 1 : 0) : card.share);
    if (!f) continue;
    amount += l.value * f; bags += l.bags * f; lbs += l.lbs * f;
    usages += 1;
    for (const t of l.titles || []) titles.add(t);
    if (l.requestId) requests.add(l.requestId);
  }
  amount = r2(amount);
  const pending = ((rows && rows.pending) || []).filter((p) => !card || !p.soCardId || p.soCardId === card.id).length;
  return { yarnCount: titles.size, yarnBags: r2(bags), yarnLbs: r2(lbs), yarnAmount: amount, yarnPerMeter: meters ? r2(amount / meters, 4) : 0, yarnUsages: usages, yarnRequests: requests.size, pendingYarnRequests: pending };
}

/** Yarn cost the cloth picked up in earlier departments, per job item (the same walk as the chemical one: each earlier job's cost for the SO card, shared by meters). */
async function previousYarnCosts(itemIds) {
  const out = new Map(itemIds.map((id) => [id, 0]));
  if (!itemIds.length) return out;
  const up = await sequelize.query(`
    WITH RECURSIVE up AS (
      SELECT ji.id AS start, ji."sourceJobItemId" AS anc FROM job_items ji WHERE ji.id = ANY($1::uuid[]) AND ji."sourceJobItemId" IS NOT NULL
      UNION
      SELECT up.start, p."sourceJobItemId" FROM up JOIN job_items p ON p.id = up.anc WHERE p."sourceJobItemId" IS NOT NULL)
    SELECT up.start, a.id, a."jobId", a."soCardId", a.meters::float AS meters, s.meters::float AS "startMeters" FROM up JOIN job_items a ON a.id = up.anc JOIN job_items s ON s.id = up.start`,
  { bind: [itemIds], type: QueryTypes.SELECT });
  if (!up.length) return out;
  const jobIds = [...new Set(up.map((a) => a.jobId))];
  const uses = await valuesOfJobs(jobIds);
  const all = await q('SELECT "jobId", "soCardId", meters::float AS meters FROM job_items WHERE "jobId" IN (:jobIds)', { jobIds });
  const meters = (jid, card) => all.filter((i) => i.jobId === jid && (!card || i.soCardId === card)).reduce((t, i) => t + i.meters, 0);
  for (const a of up) {
    const total = meters(a.jobId);
    const cardM = meters(a.jobId, a.soCardId);
    const cardCost = yarnCols(uses.get(a.jobId), cardM, { id: a.soCardId, share: total ? cardM / total : 0 }).yarnAmount;
    const part = a.meters > 0 ? Math.min(1, a.startMeters / a.meters) : 1;
    out.set(a.start, out.get(a.start) + (cardM ? cardCost * (a.meters / cardM) * part : 0));
  }
  return out;
}

module.exports = { jobYarn, cardYarn, reportUsages, valuesOfJobs, yarnCols, previousYarnCosts, usagesOf };
