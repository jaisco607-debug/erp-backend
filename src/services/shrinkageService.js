// Wastage and shrinkage report (owner plan N-B4) and the shrinkage the owner expects (shrinkage_limits). Read only; nothing here changes the cloth.
//
// A department receives some meters and sends some on. The difference is its loss (it received more than it sent on) or gain (less):
//   - a process department (Dyeing, Printing ...) that wrote the thaans of what it made: received = the meters of the line it received,
//     sent on = the meters the next departments received from it (the same way the department ledger counts "process loss / gain (thaans)")
//   - Folding: received = the meters of a thaan it received, sent on = what it graded (A + B + CP), counted when the thaan is fully graded or the row is closed
// Only cloth that has really gone on counts: a line still waiting in a department, a job that was rejected, and an open machine run are not a loss.
// The period is the day the cloth was sent on (a process department) or the Folding job date.
const AppError = require('../utils/AppError');
const { sequelize } = require('../models');
const { companyServices } = require('./accessService');
const audit = require('./auditService');
const foldingService = require('./foldingService');
const { _x } = require('./reportService');

const { q, round, col, section, respond, myDepartments } = _x;
const ROW_CAP = 5000;
const DETAIL_CAP = 50000;
const NO_QUALITY = 'No quality';
const GROUPS = { department: 'department', dept: 'department', quality: 'quality', customer: 'customer', party: 'customer', month: 'month', job: 'job' };

const limitKey = (departmentId, qualityId) => `${departmentId}|${qualityId || ''}`;

/** Every limit of the company: Map "departmentId|qualityId" -> percent (qualityId empty = the department's own limit). */
async function limitMap(companyId) {
  const rows = await q('SELECT "departmentId", "qualityId", "limitPercent"::float AS p FROM shrinkage_limits WHERE "companyId" = :companyId', { companyId });
  return new Map(rows.map((r) => [limitKey(r.departmentId, r.qualityId), r.p]));
}
/** The percent expected for a department and quality: that quality's own, else the department's, else none. */
const expectedFor = (limits, departmentId, qualityId) => {
  const own = limits.get(limitKey(departmentId, qualityId));
  return own !== undefined ? own : (limits.get(limitKey(departmentId, null)) ?? null);
};

/* ---------------- the detail rows ---------------- */

async function processRows(companyId, depIds, f) {
  if (!depIds.length) return [];
  const where = [];
  const rep = { cid: companyId, ids: depIds, cap: DETAIL_CAP + 1 };
  if (f.customerId) { where.push('sc."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.qualityId) { where.push('COALESCE(sc."qualityId", gl."qualityId") = :qualityId'); rep.qualityId = f.qualityId; }
  if (f.lotNo) { where.push('gl."lotNo" = :lotNo'); rep.lotNo = f.lotNo; }
  if (f.jobNo) { where.push('pj."jobNo" = :jobNo'); rep.jobNo = f.jobNo; }
  if (f.dateFrom) { where.push('n.last >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('n.last <= :dateTo'); rep.dateTo = f.dateTo; }
  return q(`
    SELECT pj."departmentId", svc_name(ps.id, pj."companyId", ps.name) AS department, pj.id AS "jobId", pj."jobNo", sc.id AS "soCardId", sc."cardNo" AS "soNo", sc."isGreyReturn",
           sc."customerId", cu.name AS customer, COALESCE(sc."qualityId", gl."qualityId") AS "qualityId", qu.name AS quality, gl."lotNo",
           pi.meters::float AS received, n.sent::float AS "sentOn", to_char(n.last, 'YYYY-MM-DD') AS date
    FROM job_items pi
    JOIN jobs pj ON pj.id = pi."jobId" AND pj.status <> 'REJECTED' AND pj."companyId" = :cid
    JOIN services ps ON ps.id = pj."departmentId"
    JOIN so_cards sc ON sc.id = pi."soCardId" AND sc."companyId" = :cid
    JOIN so_card_lots scl ON scl.id = pi."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId" AND gl."companyId" = :cid
    JOIN customers cu ON cu.id = sc."customerId" AND cu."companyId" = :cid
    LEFT JOIN qualities qu ON qu.id = COALESCE(sc."qualityId", gl."qualityId")
    CROSS JOIN LATERAL (SELECT SUM(ci.meters) AS sent, MAX(cj."jobDate") AS last FROM job_items ci JOIN jobs cj ON cj.id = ci."jobId" AND cj.status <> 'REJECTED' AND cj."companyId" = :cid
                        WHERE ci."sourceJobItemId" = pi.id) n
    WHERE pj."departmentId" IN (:ids) AND n.sent IS NOT NULL AND EXISTS (SELECT 1 FROM job_item_thaans t WHERE t."jobItemId" = pi.id)${where.length ? ` AND ${where.join(' AND ')}` : ''}
    ORDER BY n.last, pj."jobNo" LIMIT :cap`, rep);
}

/** Folding: the thaans that are fully graded (or the row closed): received and what was graded. */
async function foldingRows(req, depIds, f) {
  const fd = (await companyServices(req.user.companyId)).find((s) => s.kind === 'FOLDING' && depIds.includes(s.id));
  if (!fd) return [];
  let list;
  try {
    list = await foldingService.list(req, fd.code, { tab: 'all', page: 1, limit: 100000, dateFrom: f.dateFrom, dateTo: f.dateTo });
  } catch (e) {
    if ((e.status || e.statusCode) === 403) return []; // the person has the report but not the Folding department
    throw e;
  }
  const cards = [...new Set(list.data.map((r) => r.soCard.id))];
  const qmap = new Map(cards.length ? (await q(`SELECT sc.id, COALESCE(sc."qualityId", (SELECT gl."qualityId" FROM so_card_lots l JOIN grey_lots gl ON gl.id = l."greyLotId" WHERE l."soCardId" = sc.id ORDER BY l."createdAt" LIMIT 1)) AS "qualityId"
    FROM so_cards sc WHERE sc.id IN (:cards) AND sc."companyId" = :cid`, { cards, cid: req.user.companyId })).map((r) => [r.id, r.qualityId]) : []);
  const out = [];
  for (const r of list.data) {
    if (r.isGreyReturn) continue; // nothing is graded, so nothing is lost
    if (f.customerId && r.customer.id !== f.customerId) continue;
    const qualityId = qmap.get(r.soCard.id) || null;
    if (f.qualityId && qualityId !== f.qualityId) continue;
    if (f.jobNo && r.jobNo !== f.jobNo) continue;
    if (f.lotNo && !r.lots.some((l) => l.lotNo === f.lotNo)) continue;
    let received = 0;
    let sentOn = 0;
    for (const lot of r.lots) {
      if (f.lotNo && lot.lotNo !== f.lotNo) continue;
      for (const l of lot.lines) {
        if (l.folded > 0 && (r.isClosed || l.folded >= l.received)) { received += l.received; sentOn += l.folded; }
      }
    }
    if (received <= 0) continue;
    out.push({ departmentId: fd.id, department: fd.name, jobId: r.jobId, jobNo: r.jobNo, soCardId: r.soCard.id, soNo: r.soCard.cardNo, customerId: r.customer.id, customer: r.customer.name,
      qualityId, quality: r.quality, received: round(received), sentOn: round(sentOn), date: String(r.jobDate).slice(0, 10) });
  }
  return out;
}

/* ---------------- the report ---------------- */

async function report(req, f) {
  const deps = await myDepartments(req);
  if (!deps.length) throw AppError.forbidden('You do not have a department');
  const ids = f.departmentId ? deps.filter((d) => d.id === f.departmentId).map((d) => d.id) : deps.map((d) => d.id);
  const processIds = deps.filter((d) => ids.includes(d.id) && d.kind === 'PROCESS').map((d) => d.id);
  const [proc, fold, limits] = await Promise.all([processRows(req.user.companyId, processIds, f), foldingRows(req, ids, f), limitMap(req.user.companyId)]);
  if (proc.length > DETAIL_CAP) throw AppError.rule('REPORT_TOO_BIG', 'The report has too many lines: choose a shorter period or a department', { cap: DETAIL_CAP });
  const detail = [...proc, ...fold].map((r) => ({ ...r, month: r.date.slice(0, 7), expected: expectedFor(limits, r.departmentId, r.qualityId) }));
  const by = GROUPS[String(f.groupBy || 'department').toLowerCase()] || 'department';

  // one row per group: the meters add up, the expected loss is each line's meters x the percent of its department and quality
  const groups = new Map();
  for (const r of detail) {
    const key = { department: r.departmentId, quality: r.qualityId || 'none', customer: r.customerId, month: r.month, job: `${r.jobId}` }[by];
    let g = groups.get(key);
    if (!g) {
      g = { key, departmentId: r.departmentId, department: r.department, qualityId: r.qualityId, quality: r.quality || NO_QUALITY, customerId: r.customerId, customer: r.customer, month: r.month,
        jobId: r.jobId, jobNo: r.jobNo, soNo: r.soNo, received: 0, sentOn: 0, limitedReceived: 0, expectedLoss: 0, lines: 0, departments: new Set(), qualities: new Set(), customers: new Set() };
      groups.set(key, g);
    }
    g.received += r.received; g.sentOn += r.sentOn; g.lines += 1;
    if (r.expected !== null) { g.limitedReceived += r.received; g.expectedLoss += (r.received * r.expected) / 100; }
    g.departments.add(r.department); g.qualities.add(r.quality || NO_QUALITY); g.customers.add(r.customer);
  }
  const rows = [...groups.values()].map((g) => {
    const diff = round(g.received - g.sentOn);
    const pct = g.received ? round((diff / g.received) * 100, 2) : 0;
    const expectedPercent = g.limitedReceived ? round((g.expectedLoss / g.limitedReceived) * 100, 2) : null;
    const over = expectedPercent !== null && diff > 0 && pct > expectedPercent;
    const label = { department: g.department, quality: g.quality, customer: g.customer, month: g.month, job: `Job# ${g.jobNo}` }[by];
    return {
      group: label, department: by === 'department' || by === 'job' ? g.department : [...g.departments].join(', '), quality: by === 'quality' || by === 'job' ? g.quality : [...g.qualities].join(', '),
      customer: by === 'customer' || by === 'job' ? g.customer : [...g.customers].join(', '), month: g.month, jobNo: by === 'job' ? g.jobNo : null, soNo: by === 'job' ? g.soNo : null, lines: g.lines,
      receivedMeters: round(g.received), sentOnMeters: round(g.sentOn), diffMeters: diff, diffPercent: pct, kind: diff > 0.004 ? 'Loss' : diff < -0.004 ? 'Gain' : '-',
      expectedPercent, overLimit: over, status: over ? 'Over the expected limit' : (expectedPercent !== null && diff > 0 ? 'Within the limit' : ''),
      // what the row stands for, to open the jobs behind it (the Departments > job wise report takes these filters)
      keys: { departmentId: by === 'department' || by === 'job' ? g.departmentId : null, qualityId: by === 'quality' || by === 'job' ? g.qualityId : null, customerId: by === 'customer' || by === 'job' ? g.customerId : null,
        month: by === 'month' ? g.month : null, jobId: by === 'job' ? g.jobId : null },
    };
  });
  const sortKey = by === 'month' ? (a, b) => a.month.localeCompare(b.month) : (a, b) => b.diffMeters - a.diffMeters || String(a.group).localeCompare(String(b.group));
  rows.sort(sortKey);
  if (rows.length > ROW_CAP) throw AppError.rule('REPORT_TOO_BIG', `The report has more than ${ROW_CAP} rows: choose a shorter period or a filter`, { cap: ROW_CAP });

  const first = { department: [col('group', 'Department')], quality: [col('group', 'Quality')], customer: [col('group', 'Customer')], month: [col('group', 'Month')],
    job: [col('group', 'Job'), col('department', 'Department'), col('soNo', 'SO#', 'number'), col('customer', 'Customer'), col('quality', 'Quality')] }[by];
  const columns = [...first, col('lines', 'Lines', 'number'), col('receivedMeters', 'Received (m)', 'number'), col('sentOnMeters', 'Sent on (m)', 'number'), col('diffMeters', 'Difference (m)', 'number'),
    col('diffPercent', 'Difference %', 'number'), col('kind', 'Loss / gain', 'tag'), col('expectedPercent', 'Expected %', 'number'), col('status', 'Status', 'tag')];
  const sec = section('shrinkage', 'Wastage and shrinkage', columns, rows, ['lines', 'receivedMeters', 'sentOnMeters', 'diffMeters']);
  sec.totals.diffPercent = sec.totals.receivedMeters ? round((sec.totals.diffMeters / sec.totals.receivedMeters) * 100, 2) : 0;
  sec.totals.overLimitRows = rows.filter((r) => r.overLimit).length;
  const out = respond('Wastage and shrinkage', { ...f, groupBy: by }, [sec], f);
  out.groupBy = by;
  return out;
}

/* ---------------- the expected shrinkage (settings) ---------------- */

const SHOWN_KINDS = ['PROCESS', 'FOLDING'];

async function getLimits(req) {
  const { companyId } = req.user;
  const departments = (await companyServices(companyId)).filter((s) => SHOWN_KINDS.includes(s.kind)).map((s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind }));
  const qualities = await q('SELECT id, name FROM qualities WHERE "companyId" = :companyId AND "deletedAt" IS NULL ORDER BY name', { companyId });
  const limits = await q('SELECT id, "departmentId", "qualityId", "limitPercent"::float AS "limitPercent" FROM shrinkage_limits WHERE "companyId" = :companyId ORDER BY "departmentId"', { companyId });
  return { departments, qualities, limits, note: 'A limit with no quality is the limit of the whole department; a limit for a quality wins over it.' };
}

/** PUT { items: [{ departmentId, qualityId (or null), limitPercent (or null to remove) }] } */
async function saveLimits(req, { items }) {
  const { companyId } = req.user;
  const deps = new Set((await companyServices(companyId)).filter((s) => SHOWN_KINDS.includes(s.kind)).map((s) => s.id));
  const qualityIds = [...new Set(items.map((i) => i.qualityId).filter(Boolean))];
  const known = new Set(qualityIds.length ? (await q('SELECT id FROM qualities WHERE "companyId" = :companyId AND id IN (:ids)', { companyId, ids: qualityIds })).map((r) => r.id) : []);
  for (const i of items) {
    if (!deps.has(i.departmentId)) throw AppError.notFound('Department');
    if (i.qualityId && !known.has(i.qualityId)) throw AppError.notFound('Quality');
  }
  const seen = new Set(items.map((i) => limitKey(i.departmentId, i.qualityId)));
  if (seen.size !== items.length) throw AppError.rule('DUPLICATE_LIMIT', 'The same department and quality is in the list twice');
  await sequelize.transaction(async (transaction) => {
    for (const i of items) {
      const rep = { companyId, departmentId: i.departmentId, qualityId: i.qualityId || null, percent: i.limitPercent, userId: req.user.id };
      const [before] = await sequelize.query(`SELECT "limitPercent"::float AS p FROM shrinkage_limits WHERE "companyId" = :companyId AND "departmentId" = :departmentId
        AND COALESCE("qualityId", '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(CAST(:qualityId AS uuid), '00000000-0000-0000-0000-000000000000'::uuid) FOR UPDATE`, { replacements: rep, type: 'SELECT', transaction });
      if (i.limitPercent === null) {
        if (!before) continue;
        await sequelize.query(`DELETE FROM shrinkage_limits WHERE "companyId" = :companyId AND "departmentId" = :departmentId
          AND COALESCE("qualityId", '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(CAST(:qualityId AS uuid), '00000000-0000-0000-0000-000000000000'::uuid)`, { replacements: rep, transaction });
      } else if (before) {
        if (before.p === Number(i.limitPercent)) continue;
        await sequelize.query(`UPDATE shrinkage_limits SET "limitPercent" = :percent, "updatedById" = :userId, "updatedAt" = now() WHERE "companyId" = :companyId AND "departmentId" = :departmentId
          AND COALESCE("qualityId", '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(CAST(:qualityId AS uuid), '00000000-0000-0000-0000-000000000000'::uuid)`, { replacements: rep, transaction });
      } else {
        await sequelize.query('INSERT INTO shrinkage_limits ("companyId", "departmentId", "qualityId", "limitPercent", "updatedById") VALUES (:companyId, :departmentId, CAST(:qualityId AS uuid), :percent, :userId)', { replacements: rep, transaction });
      }
      await audit.log(req, { action: 'SHRINKAGE_LIMIT_SET', entityType: 'ShrinkageLimit', entityId: i.departmentId, before: { qualityId: i.qualityId || null, limitPercent: before ? before.p : null }, after: { qualityId: i.qualityId || null, limitPercent: i.limitPercent } }, { transaction });
    }
  });
  return getLimits(req);
}

module.exports = { report, getLimits, saveLimits, expectedFor, limitMap };
