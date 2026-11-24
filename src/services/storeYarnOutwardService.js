// Store Management > Yarn Outward: the Yarn Store gives yarn (bags of an approved yarn inward) to a DEPARTMENT.
// - The inward's outwardBags goes up, so the Yarn Stock falls; the yarn is then the department's (departmentYarnService): it checks what it has and uses it on a Job / SO card.
// - Every line keeps the bags, the weight of a bag and the rate per lb of its inward, so the value (bags x lbs per bag x rate) is fixed when the yarn is given. No rate = value 0.
// - An outward can be cancelled while the department has used none of its yarn; the bags go back to the stock.
const { QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { sequelize, StoreYarnInward } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { round: r2 } = require('../utils/money');
const audit = require('./auditService');
const counters = require('./counterService');
const { companyServices } = require('./accessService');

const NO = 'store_yarn_outward_no';
const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const label = (n) => String(n).padStart(5, '0');
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const title = (r) => (r.brand ? `${r.yarnName} - ${r.brand}` : r.yarnName);

const departmentsOf = async (req, transaction) => (await companyServices(req.user.companyId, transaction)).filter((s) => DEPARTMENT_KINDS.includes(s.kind));

const LINES_SQL = `SELECT l.id, l."outwardId", l."lineNo", l."inwardId", l.bags, l."lbsPerBag"::float AS "lbsPerBag", l."ratePerLb"::float AS "ratePerLb", l.value::float AS value, l."usedBags",
    i."inwardNo", i."yarnName", i.brand, i."dcNo" AS "inwardDcNo", v.name AS "vendorName"
  FROM store_yarn_outward_lines l JOIN store_yarn_inwards i ON i.id = l."inwardId" JOIN vendors v ON v.id = i."vendorId"
  WHERE l."outwardId" IN (:ids) ORDER BY l."lineNo"`;

function lineJson(r) {
  const left = r.bags - r.usedBags;
  return {
    id: r.id, lineNo: r.lineNo, inwardId: r.inwardId, inwardNo: r.inwardNo, inwardText: label(r.inwardNo), yarnName: r.yarnName, brand: r.brand, title: title(r), vendorName: r.vendorName, inwardDcNo: r.inwardDcNo,
    bags: r.bags, lbsPerBag: r.lbsPerBag, lbs: r2(r.bags * r.lbsPerBag), ratePerLb: r.ratePerLb, value: r.value,
    usedBags: r.usedBags, balanceBags: left, balanceLbs: r2(left * r.lbsPerBag), balanceValue: r.bags ? r2((r.value * left) / r.bags) : 0,
  };
}

const HEAD_SQL = `SELECT o.id, o."outwardNo", to_char(o."outwardDate", 'YYYY-MM-DD') AS "outwardDate", o."departmentId", svc_name(s.id, o."companyId", s.name) AS "departmentName", s.code AS "departmentCode",
    o."dcNo", o."sentThrough", o.remarks, o."totalBags", o."totalLbs"::float AS "totalLbs", o."totalValue"::float AS "totalValue", o."createdAt", u.name AS "createdByName", o."requestId", yr."reqNo" AS "requestNo"
  FROM store_yarn_outwards o JOIN services s ON s.id = o."departmentId" LEFT JOIN users u ON u.id = o."createdById" LEFT JOIN yarn_requests yr ON yr.id = o."requestId"`;

function headJson(r, lines) {
  const used = lines.reduce((t, l) => t + l.usedBags, 0);
  return {
    id: r.id, outwardNo: r.outwardNo, outwardText: label(r.outwardNo), outwardDate: r.outwardDate,
    department: { id: r.departmentId, code: r.departmentCode, name: r.departmentName },
    dcNo: r.dcNo, sentThrough: r.sentThrough, remarks: r.remarks,
    totalBags: r.totalBags, totalLbs: r.totalLbs, totalValue: r.totalValue,
    // an outward made by sending a yarn request belongs to that request (it is not taken back here)
    request: r.requestId ? { id: r.requestId, reqNo: r.requestNo, reqText: label(r.requestNo) } : null,
    usedBags: used, balanceBags: r.totalBags - used, canCancel: used === 0 && !r.requestId,
    createdBy: r.createdByName ? { name: r.createdByName } : null, createdAt: r.createdAt,
    lines: lines.map(lineJson),
  };
}

async function load(req, id, transaction) {
  const [r] = await q(`${HEAD_SQL} WHERE o.id = :id AND o."companyId" = :cid`, { id, cid: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Yarn outward');
  return headJson(r, await q(LINES_SQL, { ids: [id] }, transaction));
}

/** Entry screen: the next number, the departments, and the yarn in the store (approved entries with bags left). */
async function formData(req) {
  const cid = req.user.companyId;
  const [no, depts, stock] = await Promise.all([
    counters.peek(cid, NO, async () => ((await q('SELECT MAX("outwardNo") AS m FROM store_yarn_outwards WHERE "companyId" = :cid', { cid }))[0].m || 0) + 1),
    departmentsOf(req),
    q(`SELECT i.id, i."inwardNo", i."yarnName", i.brand, to_char(i."inwardDate", 'YYYY-MM-DD') AS "inwardDate", i.bags, i."outwardBags", i."lbsPerBag"::float AS "lbsPerBag", i."ratePerLb"::float AS "ratePerLb", i."dcNo", v.name AS "vendorName"
       FROM store_yarn_inwards i JOIN vendors v ON v.id = i."vendorId" WHERE i."companyId" = :cid AND i."deletedAt" IS NULL AND i."isApproved" AND i."isActive" AND i.bags > i."outwardBags" ORDER BY i."inwardDate", i."inwardNo"`, { cid }),
  ]);
  return {
    nextOutwardNo: no, nextOutwardText: label(no), today: today(),
    departments: depts.map((d) => ({ id: d.id, code: d.code, name: d.name, kind: d.kind })),
    stock: stock.map((r) => ({
      inwardId: r.id, inwardNo: r.inwardNo, inwardText: label(r.inwardNo), inwardDate: r.inwardDate, title: title(r), yarnName: r.yarnName, brand: r.brand, vendorName: r.vendorName, dcNo: r.dcNo,
      bags: r.bags, balanceBags: r.bags - r.outwardBags, lbsPerBag: r.lbsPerBag, balanceLbs: r2((r.bags - r.outwardBags) * r.lbsPerBag), ratePerLb: r.ratePerLb,
    })),
  };
}

/** Give yarn to a department: { outwardDate, departmentId, dcNo, sentThrough, remarks, lines: [{ inwardId, bags }] }. */
async function createCore(req, data, transaction) {
  {
    const companyId = req.user.companyId;
    const dept = (await departmentsOf(req, transaction)).find((d) => d.id === data.departmentId);
    if (!dept) throw AppError.rule('UNKNOWN_DEPARTMENT', 'Your company does not have this department');
    const date = data.outwardDate || today();
    const ids = data.lines.map((l) => l.inwardId).sort();
    const inwards = await StoreYarnInward.findAll({ where: { id: ids, companyId }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
    const byId = new Map(inwards.map((i) => [i.id, i]));
    for (const l of data.lines) {
      const i = byId.get(l.inwardId);
      if (!i) throw AppError.notFound('Yarn inward');
      const name = `Yarn inward ${label(i.inwardNo)} (${i.yarnName})`;
      if (!i.isApproved) throw AppError.rule('INWARD_NOT_APPROVED', `${name} is not approved: only approved yarn is in the stock`);
      if (!i.isActive) throw AppError.rule('INWARD_INACTIVE', `${name} is switched off`);
      if (String(date) < String(i.inwardDate).slice(0, 10)) throw AppError.rule('OUTWARD_BEFORE_INWARD', `${name} arrived on ${String(i.inwardDate).slice(0, 10)}: it cannot go out before that`);
      const balance = i.bags - i.outwardBags;
      if (l.bags > balance) throw AppError.rule('NOT_ENOUGH_BAGS', `${name} has only ${balance} bags in the store`, { inwardId: i.id, balanceBags: balance });
    }
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`store-yarn-outward-no:${companyId}`], transaction });
    const no = await counters.take(companyId, NO, async () => ((await q('SELECT MAX("outwardNo") AS m FROM store_yarn_outwards WHERE "companyId" = :cid', { cid: companyId }, transaction))[0].m || 0) + 1, transaction);
    const lines = data.lines.map((l, idx) => {
      const i = byId.get(l.inwardId);
      const value = i.ratePerLb == null ? 0 : r2(l.bags * i.lbsPerBag * i.ratePerLb);
      return { id: crypto.randomUUID(), lineNo: idx + 1, inward: i, bags: l.bags, lbsPerBag: i.lbsPerBag, ratePerLb: i.ratePerLb, value };
    });
    const totals = { bags: lines.reduce((t, l) => t + l.bags, 0), lbs: r2(lines.reduce((t, l) => t + l.bags * l.lbsPerBag, 0)), value: r2(lines.reduce((t, l) => t + l.value, 0)) };
    const id = crypto.randomUUID();
    await sequelize.query(`INSERT INTO store_yarn_outwards (id, "companyId", "outwardNo", "outwardDate", "departmentId", "dcNo", "sentThrough", remarks, "totalBags", "totalLbs", "totalValue", "createdById", "requestId")
      VALUES (:id, :companyId, :no, :date, :departmentId, :dcNo, :sentThrough, :remarks, :bags, :lbs, :value, :userId, :requestId)`,
    { replacements: { id, companyId, no, date, departmentId: dept.id, dcNo: data.dcNo || null, sentThrough: data.sentThrough || null, remarks: data.remarks || null, ...totals, userId: req.user.id, requestId: data.requestId || null }, transaction });
    for (const l of lines) {
      await sequelize.query(`INSERT INTO store_yarn_outward_lines (id, "outwardId", "companyId", "lineNo", "inwardId", bags, "lbsPerBag", "ratePerLb", value)
        VALUES (:id, :outwardId, :companyId, :lineNo, :inwardId, :bags, :lbsPerBag, :ratePerLb, :value)`,
      { replacements: { id: l.id, outwardId: id, companyId, lineNo: l.lineNo, inwardId: l.inward.id, bags: l.bags, lbsPerBag: l.lbsPerBag, ratePerLb: l.ratePerLb, value: l.value }, transaction });
      l.inward.outwardBags += l.bags;
      await l.inward.save({ transaction });
    }
    const after = await load(req, id, transaction);
    await audit.log(req, { action: 'STORE_YARN_OUTWARD_CREATED', entityType: 'StoreYarnOutward', entityId: id, after }, { transaction });
    return after;
  }
}

const create = (req, data) => sequelize.transaction((transaction) => createCore(req, data, transaction));

/** Take an outward back: allowed while the department has used none of its yarn. The bags go back to the stock. */
async function cancel(req, id) {
  return sequelize.transaction(async (transaction) => {
    const [head] = await q('SELECT id, "requestId" FROM store_yarn_outwards WHERE id = :id AND "companyId" = :cid FOR UPDATE', { id, cid: req.user.companyId }, transaction);
    if (!head) throw AppError.notFound('Yarn outward');
    if (head.requestId) throw AppError.rule('OUTWARD_FROM_REQUEST', 'This outward was made by a yarn request: it belongs to that request');
    // lock the yarn entries first, then read what was used (a department using the yarn at the same moment waits)
    const lockIds = (await q('SELECT DISTINCT "inwardId" FROM store_yarn_outward_lines WHERE "outwardId" = :id ORDER BY 1', { id }, transaction)).map((r) => r.inwardId);
    if (lockIds.length) await StoreYarnInward.findAll({ where: { id: lockIds }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, paranoid: false, transaction });
    const before = await load(req, id, transaction);
    const used = before.lines.filter((l) => l.usedBags > 0);
    if (used.length) throw AppError.rule('OUTWARD_IN_USE', `The department has already used the yarn of ${used.map((l) => l.title).join(', ')}`, { lines: used.map((l) => ({ id: l.id, title: l.title, usedBags: l.usedBags })) });
    const ids = before.lines.map((l) => l.inwardId).sort();
    await StoreYarnInward.findAll({ where: { id: ids }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, paranoid: false, transaction });
    for (const l of before.lines) await sequelize.query('UPDATE store_yarn_inwards SET "outwardBags" = "outwardBags" - :bags, "updatedAt" = now() WHERE id = :id', { replacements: { bags: l.bags, id: l.inwardId }, transaction });
    await sequelize.query('DELETE FROM store_yarn_outwards WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'STORE_YARN_OUTWARD_CANCELLED', entityType: 'StoreYarnOutward', entityId: id, before }, { transaction });
    return { id, outwardNo: before.outwardNo, deleted: true };
  });
}

function filtersOf(req, f) {
  const parts = ['o."companyId" = :cid'];
  const r = { cid: req.user.companyId };
  if (f.departmentId) { parts.push('o."departmentId" = :departmentId'); r.departmentId = f.departmentId; }
  if (f.dateFrom) { parts.push('o."outwardDate" >= :dateFrom'); r.dateFrom = f.dateFrom; }
  if (f.dateTo) { parts.push('o."outwardDate" <= :dateTo'); r.dateTo = f.dateTo; }
  if (f.inwardId) { parts.push('EXISTS (SELECT 1 FROM store_yarn_outward_lines x WHERE x."outwardId" = o.id AND x."inwardId" = :inwardId)'); r.inwardId = f.inwardId; }
  if (f.search) {
    r.s = `%${f.search}%`;
    const n = /^\d+$/.test(f.search) ? ' OR o."outwardNo" = :n' : '';
    if (n) r.n = Number(f.search);
    parts.push(`(o."dcNo" ILIKE :s OR o."sentThrough" ILIKE :s OR s.name ILIKE :s OR EXISTS (SELECT 1 FROM store_yarn_outward_lines x JOIN store_yarn_inwards i ON i.id = x."inwardId" WHERE x."outwardId" = o.id AND (i."yarnName" ILIKE :s OR i.brand ILIKE :s))${n})`);
  }
  return { where: parts.join(' AND '), r };
}

async function list(req, f) {
  const { where, r } = filtersOf(req, f);
  const rows = await q(`${HEAD_SQL} WHERE ${where} ORDER BY o."outwardNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit: f.limit, offset: (f.page - 1) * f.limit });
  const [t] = await q(`SELECT count(*)::int AS n, COALESCE(SUM(o."totalBags"), 0)::int AS bags, COALESCE(SUM(o."totalLbs"), 0)::float AS lbs, COALESCE(SUM(o."totalValue"), 0)::float AS value
    FROM store_yarn_outwards o JOIN services s ON s.id = o."departmentId" WHERE ${where}`, r);
  const lines = rows.length ? await q(LINES_SQL, { ids: rows.map((x) => x.id) }) : [];
  return {
    data: rows.map((x) => headJson(x, lines.filter((l) => l.outwardId === x.id))),
    totals: { outwards: t.n, bags: t.bags, lbs: r2(t.lbs), value: r2(t.value) },
    page: f.page, limit: f.limit, total: t.n,
  };
}

const get = (req, id) => load(req, id);

/**
 * Where the yarn went: groupBy=department (what every department got, used and still has) or groupBy=yarn (every yarn: given out, used, still with the departments).
 * Filters: dateFrom / dateTo (of the outward), departmentId.
 */
async function summary(req, f) {
  const { where, r } = filtersOf(req, f);
  const usedValue = '(SELECT COALESCE(SUM(ul.value), 0) FROM store_yarn_usage_lines ul WHERE ul."outwardLineId" = l.id)';
  const by = f.groupBy === 'yarn'
    ? { key: "lower(i.\"yarnName\") || '|' || lower(COALESCE(i.brand, ''))", name: "min(i.\"yarnName\") || CASE WHEN min(i.brand) IS NULL THEN '' ELSE ' - ' || min(i.brand) END", join: 'JOIN store_yarn_inwards i ON i.id = l."inwardId"' }
    : { key: 'o."departmentId"::text', name: 'min(svc_name(s.id, o."companyId", s.name))', join: '' };
  const rows = await q(`SELECT ${by.key} AS key, ${by.name} AS label, count(DISTINCT o.id)::int AS outwards, SUM(l.bags)::int AS "issuedBags", SUM(l.bags * l."lbsPerBag")::float AS "issuedLbs", SUM(l.value)::float AS "issuedValue",
      SUM(l."usedBags")::int AS "usedBags", SUM(${usedValue})::float AS "usedValue"
    FROM store_yarn_outwards o JOIN services s ON s.id = o."departmentId" JOIN store_yarn_outward_lines l ON l."outwardId" = o.id ${by.join}
    WHERE ${where} GROUP BY 1 ORDER BY SUM(l.value) DESC, 2`, r);
  const data = rows.map((x) => ({
    key: x.key, label: x.label, outwards: x.outwards, issuedBags: x.issuedBags, issuedLbs: r2(x.issuedLbs), issuedValue: r2(x.issuedValue),
    usedBags: x.usedBags, usedValue: r2(x.usedValue), balanceBags: x.issuedBags - x.usedBags, balanceValue: r2(x.issuedValue - x.usedValue),
  }));
  const sum = (k) => r2(data.reduce((t, x) => t + x[k], 0));
  return { groupBy: f.groupBy === 'yarn' ? 'yarn' : 'department', data, totals: { issuedBags: sum('issuedBags'), issuedLbs: sum('issuedLbs'), issuedValue: sum('issuedValue'), usedBags: sum('usedBags'), usedValue: sum('usedValue'), balanceBags: sum('balanceBags'), balanceValue: sum('balanceValue') } };
}

/** The outwards of one inward entry (where its yarn went): used by the entry screen of the yarn inward. */
async function ofInward(req, inwardId) {
  const rows = await q(`SELECT o.id AS "outwardId", o."outwardNo", to_char(o."outwardDate", 'YYYY-MM-DD') AS "outwardDate", svc_name(s.id, o."companyId", s.name) AS department, s.code AS "departmentCode", l.bags, l."usedBags", l.value::float AS value
    FROM store_yarn_outward_lines l JOIN store_yarn_outwards o ON o.id = l."outwardId" JOIN services s ON s.id = o."departmentId"
    WHERE l."inwardId" = :inwardId AND o."companyId" = :cid ORDER BY o."outwardNo"`, { inwardId, cid: req.user.companyId });
  return rows.map((x) => ({ outwardId: x.outwardId, outwardNo: x.outwardNo, outwardText: label(x.outwardNo), outwardDate: x.outwardDate, department: { code: x.departmentCode, name: x.department }, bags: x.bags, usedBags: x.usedBags, balanceBags: x.bags - x.usedBags, value: x.value }));
}

module.exports = { formData, create, createCore, cancel, list, get, summary, ofInward };
