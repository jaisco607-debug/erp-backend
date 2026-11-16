// A department's yarn (Yarn Store outward -> department -> Job / SO card).
// - Stock: what the Yarn Store gave this department (storeYarnOutwardService) minus what it has used. The department checks it any time.
// - Use: the department takes yarn from its stock for one of its Jobs (accepted there: PROCESSING / COMPLETE), optionally for one SO card of the job. The value of the yarn
//   (bags x lbs per bag x the rate the store paid, fixed when the store gave it) is the yarn cost of that Job / SO card (yarnCostService), next to the chemical cost.
// - A use can be taken back by the department (the yarn is in its stock again).
const { QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { sequelize, Job, JobItem } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { round: r2 } = require('../utils/money');
const { soLabel } = require('../utils/soLabel');
const audit = require('./auditService');
const counters = require('./counterService');
const yarnCost = require('./yarnCostService');
const { companyServices, userServices } = require('./accessService');

const NO = 'store_yarn_usage_no';
const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const JOB_OK = ['PROCESSING', 'COMPLETE'];
const label = (n) => String(n).padStart(5, '0');
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const title = (r) => (r.brand ? `${r.yarnName} - ${r.brand}` : r.yarnName);

/** :code -> the company's department; `want` = 'VIEW' | 'FULL' (the client admin has FULL on everything the company has). */
async function dept(req, code, want, transaction) {
  const d = (await companyServices(req.user.companyId, transaction)).find((s) => DEPARTMENT_KINDS.includes(s.kind) && s.code === String(code).toUpperCase());
  if (!d) throw AppError.notFound('Department');
  let level = 'FULL';
  if (req.user.userType !== 'CLIENT_ADMIN') {
    const g = (await userServices(req.user, transaction)).find((x) => x.service.id === d.id);
    level = g ? g.access : null;
  }
  if (!level || (want === 'FULL' && level !== 'FULL')) throw AppError.forbidden(want === 'FULL' ? 'You need FULL access to this department' : 'You do not have this department');
  return d;
}

const STOCK_SQL = `SELECT l.id AS "lineId", o.id AS "outwardId", o."outwardNo", to_char(o."outwardDate", 'YYYY-MM-DD') AS "outwardDate", o."dcNo", l.bags, l."usedBags", l."lbsPerBag"::float AS "lbsPerBag",
    l."ratePerLb"::float AS "ratePerLb", l.value::float AS value, i.id AS "inwardId", i."inwardNo", i."yarnName", i.brand
  FROM store_yarn_outward_lines l JOIN store_yarn_outwards o ON o.id = l."outwardId" JOIN store_yarn_inwards i ON i.id = l."inwardId"
  WHERE o."companyId" = :cid AND o."departmentId" = :did`;

function stockLine(r) {
  const left = r.bags - r.usedBags;
  return {
    outwardLineId: r.lineId, outwardId: r.outwardId, outwardNo: r.outwardNo, outwardText: label(r.outwardNo), outwardDate: r.outwardDate, dcNo: r.dcNo,
    inwardId: r.inwardId, inwardNo: r.inwardNo, title: title(r), yarnName: r.yarnName, brand: r.brand,
    receivedBags: r.bags, usedBags: r.usedBags, balanceBags: left, lbsPerBag: r.lbsPerBag, balanceLbs: r2(left * r.lbsPerBag), ratePerLb: r.ratePerLb,
    receivedValue: r.value, balanceValue: r.bags ? r2((r.value * left) / r.bags) : 0,
  };
}

/** How much yarn the department has: one row per outward line (what it got and used), the same yarn added up, and totals. showZero also lists used-up lines. */
async function stock(req, code, { showZero = false, search } = {}) {
  const d = await dept(req, code, 'VIEW');
  const rows = (await q(`${STOCK_SQL} ORDER BY o."outwardDate", o."outwardNo", l."lineNo"`, { cid: req.user.companyId, did: d.id })).map(stockLine)
    .filter((r) => (showZero || r.balanceBags > 0) && (!search || r.title.toLowerCase().includes(String(search).toLowerCase())));
  const by = new Map();
  for (const r of rows) {
    const key = `${r.yarnName.toLowerCase()}|${(r.brand || '').toLowerCase()}`;
    const g = by.get(key) || { title: r.title, yarnName: r.yarnName, brand: r.brand, receivedBags: 0, usedBags: 0, balanceBags: 0, balanceLbs: 0, balanceValue: 0 };
    g.receivedBags += r.receivedBags; g.usedBags += r.usedBags; g.balanceBags += r.balanceBags;
    g.balanceLbs = r2(g.balanceLbs + r.balanceLbs); g.balanceValue = r2(g.balanceValue + r.balanceValue);
    by.set(key, g);
  }
  const sum = (f) => r2(rows.reduce((t, r) => t + f(r), 0));
  return {
    department: { id: d.id, code: d.code, name: d.name },
    totals: { receivedBags: sum((r) => r.receivedBags), usedBags: sum((r) => r.usedBags), balanceBags: sum((r) => r.balanceBags), balanceLbs: sum((r) => r.balanceLbs), balanceValue: sum((r) => r.balanceValue) },
    byYarn: [...by.values()].sort((a, b) => a.title.localeCompare(b.title)),
    data: rows,
  };
}

/** What the department needs to use yarn: its jobs that can take yarn (with their SO cards), and its yarn with bags left. */
async function formData(req, code) {
  const d = await dept(req, code, 'VIEW');
  const jobs = await q(`SELECT j.id, j."jobNo", j.status, to_char(j."jobDate", 'YYYY-MM-DD') AS "jobDate",
      (SELECT json_agg(x ORDER BY x."cardNo") FROM (SELECT DISTINCT sc.id, sc."cardNo", sc."isGreyReturn" FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" WHERE ji."jobId" = j.id) x) AS cards
    FROM jobs j WHERE j."companyId" = :cid AND j."departmentId" = :did AND j.status IN (:ok) ORDER BY j."jobNo" DESC LIMIT 500`, { cid: req.user.companyId, did: d.id, ok: JOB_OK });
  return {
    department: { id: d.id, code: d.code, name: d.name }, today: today(), nextUsageNo: await counters.peek(req.user.companyId, NO, async () => ((await q('SELECT MAX("usageNo") AS m FROM store_yarn_usages WHERE "companyId" = :cid', { cid: req.user.companyId }))[0].m || 0) + 1),
    jobs: jobs.map((j) => ({ id: j.id, jobNo: j.jobNo, status: j.status, jobDate: j.jobDate, soCards: (j.cards || []).map((c) => ({ id: c.id, cardNo: c.cardNo, cardLabel: soLabel(c.cardNo, c.isGreyReturn) })) })),
    stock: (await stock(req, code)).data,
  };
}

const USAGE_SQL = `SELECT u.id, u."usageNo", to_char(u."usageDate", 'YYYY-MM-DD') AS "usageDate", u."departmentId", u."jobId", j."jobNo", u."soCardId", sc."cardNo", sc."isGreyReturn",
    u."totalBags", u."totalLbs"::float AS "totalLbs", u."totalValue"::float AS "totalValue", u.remarks, u."createdAt", us.name AS "createdByName", u."requestId", yr."reqNo" AS "requestNo"
  FROM store_yarn_usages u JOIN jobs j ON j.id = u."jobId" LEFT JOIN so_cards sc ON sc.id = u."soCardId" LEFT JOIN users us ON us.id = u."createdById" LEFT JOIN yarn_requests yr ON yr.id = u."requestId"`;

async function usageJson(rows, d) {
  if (!rows.length) return [];
  const lines = await q(`SELECT ul."usageId", ul.bags, ul.lbs::float AS lbs, ul.value::float AS value, l.id AS "outwardLineId", l."ratePerLb"::float AS "ratePerLb", o."outwardNo", i."yarnName", i.brand
    FROM store_yarn_usage_lines ul JOIN store_yarn_outward_lines l ON l.id = ul."outwardLineId" JOIN store_yarn_outwards o ON o.id = l."outwardId" JOIN store_yarn_inwards i ON i.id = l."inwardId"
    WHERE ul."usageId" IN (:ids) ORDER BY o."outwardNo"`, { ids: rows.map((r) => r.id) });
  return rows.map((r) => ({
    id: r.id, usageNo: r.usageNo, usageText: label(r.usageNo), usageDate: r.usageDate,
    department: { id: d.id, code: d.code, name: d.name },
    job: { id: r.jobId, jobNo: r.jobNo },
    // the SO card the yarn is charged to; empty = the whole job (shared between its SO cards by meters)
    soCard: r.soCardId ? { id: r.soCardId, cardNo: r.cardNo, cardLabel: soLabel(r.cardNo, r.isGreyReturn) } : null,
    totalBags: r.totalBags, totalLbs: r.totalLbs, totalValue: r.totalValue, remarks: r.remarks,
    // a use made by a yarn request the store sent (it is the cost of that request; it cannot be taken back)
    request: r.requestId ? { id: r.requestId, reqNo: r.requestNo, reqText: label(r.requestNo) } : null, canRemove: !r.requestId,
    lines: lines.filter((l) => l.usageId === r.id).map((l) => ({ outwardLineId: l.outwardLineId, outwardNo: l.outwardNo, outwardText: label(l.outwardNo), title: title(l), bags: l.bags, lbs: l.lbs, ratePerLb: l.ratePerLb, value: l.value })),
    createdBy: r.createdByName ? { name: r.createdByName } : null, createdAt: r.createdAt,
  }));
}

/** The uses of the department, newest first. Filters: jobId, soCardId, dateFrom, dateTo, search (usage no, job no, SO no, yarn). */
async function usages(req, code, f) {
  const d = await dept(req, code, 'VIEW');
  const parts = ['u."companyId" = :cid', 'u."departmentId" = :did'];
  const r = { cid: req.user.companyId, did: d.id };
  if (f.jobId) { parts.push('u."jobId" = :jobId'); r.jobId = f.jobId; }
  if (f.soCardId) { parts.push('u."soCardId" = :soCardId'); r.soCardId = f.soCardId; }
  if (f.dateFrom) { parts.push('u."usageDate" >= :dateFrom'); r.dateFrom = f.dateFrom; }
  if (f.dateTo) { parts.push('u."usageDate" <= :dateTo'); r.dateTo = f.dateTo; }
  if (f.search) {
    r.n = /^\d+$/.test(f.search) ? Number(f.search) : -1;
    r.s = `%${f.search}%`;
    parts.push(`(u."usageNo" = :n OR j."jobNo" = :n OR sc."cardNo" = :n OR EXISTS (SELECT 1 FROM store_yarn_usage_lines ul JOIN store_yarn_outward_lines l ON l.id = ul."outwardLineId" JOIN store_yarn_inwards i ON i.id = l."inwardId"
      WHERE ul."usageId" = u.id AND (i."yarnName" ILIKE :s OR i.brand ILIKE :s)))`);
  }
  const where = parts.join(' AND ');
  const rows = await q(`${USAGE_SQL} WHERE ${where} ORDER BY u."usageNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit: f.limit, offset: (f.page - 1) * f.limit });
  const [t] = await q(`SELECT count(*)::int AS n, COALESCE(SUM(u."totalBags"), 0)::int AS bags, COALESCE(SUM(u."totalLbs"), 0)::float AS lbs, COALESCE(SUM(u."totalValue"), 0)::float AS value
    FROM store_yarn_usages u JOIN jobs j ON j.id = u."jobId" LEFT JOIN so_cards sc ON sc.id = u."soCardId" WHERE ${where}`, r);
  return { data: await usageJson(rows, d), totals: { usages: t.n, bags: t.bags, lbs: r2(t.lbs), value: r2(t.value) }, page: f.page, limit: f.limit, total: t.n };
}

async function loadUsage(req, d, id, transaction) {
  const rows = await q(`${USAGE_SQL} WHERE u.id = :id AND u."companyId" = :cid AND u."departmentId" = :did`, { id, cid: req.user.companyId, did: d.id }, transaction);
  if (!rows.length) throw AppError.notFound('Yarn use');
  return (await usageJson(rows, d))[0];
}

/** Use yarn on a job: { usageDate, jobId, soCardId (optional: charge that card only), remarks, lines: [{ outwardLineId, bags }] }. */
async function useCore(req, d, data, transaction, { requestId = null } = {}) {
  {
    const companyId = req.user.companyId;
    const job = await Job.findOne({ where: { id: data.jobId, companyId }, include: [{ model: JobItem, as: 'items' }], transaction });
    if (!job || job.departmentId !== d.id) throw AppError.rule('UNKNOWN_JOB', 'This job is not in your department');
    // a use made by sending a request: the request was made on an accepted job, the job may have moved on since
    if (!requestId && !JOB_OK.includes(job.status)) throw AppError.rule('JOB_NOT_ACCEPTED', 'Accept the job (Processing) before using yarn on it');
    let soCardId = null;
    if (data.soCardId) {
      if (!job.items.some((i) => i.soCardId === data.soCardId)) throw AppError.rule('SO_NOT_IN_JOB', 'This SO card is not in this job');
      soCardId = data.soCardId;
    }
    const date = data.usageDate || today();
    const ids = data.lines.map((l) => l.outwardLineId).sort();
    const rows = await q(`SELECT l.id, l.bags, l."usedBags", l."lbsPerBag"::float AS "lbsPerBag", l.value::float AS value, o."outwardNo", to_char(o."outwardDate", 'YYYY-MM-DD') AS "outwardDate", i."yarnName", i.brand
      FROM store_yarn_outward_lines l JOIN store_yarn_outwards o ON o.id = l."outwardId" JOIN store_yarn_inwards i ON i.id = l."inwardId"
      WHERE l.id IN (:ids) AND o."companyId" = :cid AND o."departmentId" = :did ORDER BY l.id FOR UPDATE OF l`, { ids, cid: companyId, did: d.id }, transaction);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lines = data.lines.map((l) => {
      const r = byId.get(l.outwardLineId);
      if (!r) throw AppError.rule('UNKNOWN_YARN', 'This yarn is not in your department stock');
      const left = r.bags - r.usedBags;
      if (l.bags > left) throw AppError.rule('NOT_ENOUGH_BAGS', `${title(r)} (outward ${label(r.outwardNo)}): your department has only ${left} bags`, { outwardLineId: r.id, balanceBags: left });
      if (String(date) < r.outwardDate) throw AppError.rule('USE_BEFORE_OUTWARD', `${title(r)} reached your department on ${r.outwardDate}: it cannot be used before that`);
      return { row: r, bags: l.bags };
    });
    // value: the share of the line's value; the last bags of a line take what is left of it, so the parts always add up to the line's value
    for (const l of lines) {
      const left = l.row.bags - l.row.usedBags;
      if (l.bags === left) {
        const [done] = await q('SELECT COALESCE(SUM(value), 0)::float AS v FROM store_yarn_usage_lines WHERE "outwardLineId" = :id', { id: l.row.id }, transaction);
        l.value = r2(l.row.value - done.v);
      } else l.value = r2((l.row.value * l.bags) / l.row.bags);
      l.lbs = r2(l.bags * l.row.lbsPerBag);
    }
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`store-yarn-usage-no:${companyId}`], transaction });
    const no = await counters.take(companyId, NO, async () => ((await q('SELECT MAX("usageNo") AS m FROM store_yarn_usages WHERE "companyId" = :cid', { cid: companyId }, transaction))[0].m || 0) + 1, transaction);
    const totals = { bags: lines.reduce((t, l) => t + l.bags, 0), lbs: r2(lines.reduce((t, l) => t + l.lbs, 0)), value: r2(lines.reduce((t, l) => t + l.value, 0)) };
    const id = crypto.randomUUID();
    await sequelize.query(`INSERT INTO store_yarn_usages (id, "companyId", "usageNo", "usageDate", "departmentId", "jobId", "soCardId", "totalBags", "totalLbs", "totalValue", remarks, "createdById", "requestId")
      VALUES (:id, :companyId, :no, :date, :did, :jobId, :soCardId, :bags, :lbs, :value, :remarks, :userId, :requestId)`,
    { replacements: { id, companyId, no, date, did: d.id, jobId: job.id, soCardId, ...totals, remarks: data.remarks || null, userId: req.user.id, requestId }, transaction });
    for (const l of lines) {
      await sequelize.query('INSERT INTO store_yarn_usage_lines (id, "usageId", "outwardLineId", bags, lbs, value) VALUES (:id, :usageId, :lineId, :bags, :lbs, :value)',
        { replacements: { id: crypto.randomUUID(), usageId: id, lineId: l.row.id, bags: l.bags, lbs: l.lbs, value: l.value }, transaction });
      await sequelize.query('UPDATE store_yarn_outward_lines SET "usedBags" = "usedBags" + :bags WHERE id = :id', { replacements: { bags: l.bags, id: l.row.id }, transaction });
    }
    const after = await loadUsage(req, d, id, transaction);
    await audit.log(req, { action: 'STORE_YARN_USED', entityType: 'StoreYarnUsage', entityId: id, after }, { transaction });
    return after;
  }
}

const use = (req, code, data) => sequelize.transaction(async (transaction) => useCore(req, await dept(req, code, 'FULL', transaction), data, transaction));

/** Take a use back (entered by mistake): the yarn is in the department stock again and leaves the cost of the Job / SO card. */
async function removeUsage(req, code, id) {
  return sequelize.transaction(async (transaction) => {
    const d = await dept(req, code, 'FULL', transaction);
    const [head] = await q('SELECT id, "requestId" FROM store_yarn_usages WHERE id = :id AND "companyId" = :cid AND "departmentId" = :did FOR UPDATE', { id, cid: req.user.companyId, did: d.id }, transaction);
    if (!head) throw AppError.notFound('Yarn use');
    if (head.requestId) throw AppError.rule('USE_FROM_REQUEST', 'This use was made by a yarn request that the store sent: it cannot be taken back here');
    const before = await loadUsage(req, d, id, transaction);
    const lines = await q('SELECT "outwardLineId", bags FROM store_yarn_usage_lines WHERE "usageId" = :id ORDER BY "outwardLineId"', { id }, transaction);
    for (const l of lines) await sequelize.query('UPDATE store_yarn_outward_lines SET "usedBags" = "usedBags" - :bags WHERE id = :id', { replacements: { bags: l.bags, id: l.outwardLineId }, transaction });
    await sequelize.query('DELETE FROM store_yarn_usages WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'STORE_YARN_USE_REMOVED', entityType: 'StoreYarnUsage', entityId: id, before }, { transaction });
    return { id, usageNo: before.usageNo, deleted: true };
  });
}

const getUsage = async (req, code, id) => loadUsage(req, await dept(req, code, 'VIEW'), id);

/** The yarn cost of one of this department's jobs. */
async function jobCost(req, code, jobId) {
  const d = await dept(req, code, 'VIEW');
  const job = await Job.findOne({ where: { id: jobId, companyId: req.user.companyId, departmentId: d.id } });
  if (!job) throw AppError.notFound('Job');
  return { job: { id: job.id, jobNo: job.jobNo }, ...(await yarnCost.jobYarn(req, job.id)) };
}

/** The yarn cost of an SO card over this department's jobs (its own uses, and its share by meters of the uses for a whole job). */
async function soCardCost(req, code, soCardId) {
  const d = await dept(req, code, 'VIEW');
  const mine = await JobItem.findAll({ where: { soCardId }, attributes: ['jobId'], include: [{ model: Job, as: 'job', attributes: [], where: { departmentId: d.id, companyId: req.user.companyId } }] });
  const jobIds = [...new Set(mine.map((i) => i.jobId))];
  if (!jobIds.length) throw AppError.notFound('SO card');
  const all = await JobItem.findAll({ where: { jobId: jobIds } });
  const share = {};
  for (const jid of jobIds) {
    const items = all.filter((i) => i.jobId === jid);
    const total = items.reduce((t, i) => t + i.meters, 0);
    share[jid] = total ? items.filter((i) => i.soCardId === soCardId).reduce((t, i) => t + i.meters, 0) / total : 0;
  }
  const { byJob, departments, ...cost } = await yarnCost.cardYarn(req, soCardId, jobIds, share);
  return { soCardId, ...cost };
}

module.exports = { stock, formData, usages, use, useCore, removeUsage, getUsage, jobCost, soCardCost, dept };
