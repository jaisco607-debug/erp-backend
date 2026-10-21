// Reports (owner 2026-10-20): read-only reports over the whole system, for the REPORTS module.
// Every list report answers in one shape, so the frontend shows it with one table component and
// turns it into PDF / Excel itself:
//   { report, title, filters, columns: [{ key, label, type, total }], rows, totals, page, limit, total }
// rows are flat (one value per column); totals are over all filtered rows, not only this page.
// all=true sends every row (for downloads). The SO card detail report sends several such tables.
//
// Where cloth is right now (used by several reports), per SO card lot:
//   SO desk      on the SO card, not sent to any department yet
//   in process   in a process department (Singeing, Dyeing ...), any status from In-Way to Complete
//   in folding   in Folding, not sent on yet (a closed folding row keeps nothing)
//   in packing   reached Packing, not left the factory yet (no gate pass)
//   dispatched   on a packing list that has a gate pass (left the factory)
// Cloth of a rejected job is back with the sender. Folding grades meters, so cloth can grow or
// shrink there: packing / dispatched meters are the graded meters.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const folding = require('./foldingService');
const { soLabel, parseCardSearch } = require('../utils/soLabel');
const { companyServices, userServices } = require('./accessService');

const MAX_ROWS = 20000;
const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING', 'PACKING'];
const STATUSES = ['IN_WAY', 'QUEUE', 'PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED'];
const STATUS_TEXT = { IN_WAY: 'In-Way', QUEUE: 'Queue', PENDING: 'Pending', PROCESSING: 'Processing', COMPLETE: 'Complete', REJECTED: 'Rejected' };
const CARD_STATUS_TEXT = { NEW: 'New (not sent)', SENT: 'Sent', IN_DEPARTMENT: 'In department' };
const GRADE_TEXT = { A: 'A', B: 'B', CP: 'Cut Piece' };

const { round } = require('../utils/money');
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const party = (r) => (r.customerName ? `${r.customerName} (${r.customerCode})` : null);
const nos = (xs) => [...new Set((xs || []).filter((x) => x !== null && x !== undefined))].sort((a, b) => a - b).join(', ');
const NONE = '00000000-0000-0000-0000-000000000000';

// ---------- table shape ----------

/** A column. type: text | int | meters | money | qty | rate | percent | date | datetime | boolean. total: add up in totals. */
const col = (key, label, type = 'text', total = false) => ({ key, label, type, ...(total && { total: true }) });

function filtersOf(f) {
  const { page, limit, all, ...rest } = f;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function totalsOf(columns, rows) {
  const totals = {};
  for (const c of columns) if (c.total) totals[c.key] = round(rows.reduce((t, r) => t + (Number(r[c.key]) || 0), 0), c.type === 'qty' ? 3 : 2);
  return totals;
}

/** One report table: page of rows + totals over all rows. */
function table(report, title, columns, rows, f, extra = {}) {
  const limit = f.all ? MAX_ROWS : f.limit;
  const page = f.all ? 1 : f.page;
  return {
    report, title, filters: filtersOf(f), columns,
    rows: rows.slice((page - 1) * limit, page * limit),
    totals: totalsOf(columns, rows),
    page, limit, total: rows.length,
    ...(f.all && rows.length > MAX_ROWS && { truncated: true }),
    ...extra,
  };
}

/** A small table inside a detail report (no paging). */
const section = (key, title, columns, rows) => ({ key, title, columns, rows, totals: totalsOf(columns, rows), total: rows.length });

/** "x BETWEEN dateFrom AND dateTo" for whichever ends are given. */
function dateWhere(field, f, r, prefix = 'd') {
  const out = [];
  if (f.dateFrom) { out.push(`${field} >= :${prefix}From`); r[`${prefix}From`] = f.dateFrom; }
  if (f.dateTo) { out.push(`${field} <= :${prefix}To`); r[`${prefix}To`] = f.dateTo; }
  return out;
}
const inRange = (d, f) => d && (!f.dateFrom || String(d).slice(0, 10) >= f.dateFrom) && (!f.dateTo || String(d).slice(0, 10) <= f.dateTo);

async function departmentsOf(companyId) {
  return (await companyServices(companyId)).filter((s) => DEPARTMENT_KINDS.includes(s.kind));
}

// ---------- shared data ----------

/**
 * Where every meter of every SO card is right now (see the top of this file).
 * items: live job items with the meters still in their department (here).
 */
async function positions(companyId) {
  const items = await q(`
    SELECT ji.id, ji."jobId", ji."soCardId", ji."soCardLotId", scl."greyLotId", sc."customerId", ji.meters::float AS meters,
           j."jobNo", j.status, j."departmentId", s.name AS department, s.kind,
           COALESCE((SELECT SUM(nx.meters) FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId"
                     WHERE nx."sourceJobItemId" = ji.id AND nj.status <> 'REJECTED'), 0)::float AS "sentOn",
           COALESCE(fe."isClosed", false) AS "isClosed"
    FROM job_items ji
    JOIN jobs j ON j.id = ji."jobId"
    JOIN services s ON s.id = j."departmentId"
    JOIN so_cards sc ON sc.id = ji."soCardId"
    JOIN so_card_lots scl ON scl.id = ji."soCardLotId"
    LEFT JOIN folding_entries fe ON fe."jobId" = j.id AND fe."soCardId" = ji."soCardId"
    WHERE j."companyId" = :companyId AND j.status <> 'REJECTED'`, { companyId });
  for (const i of items) i.here = i.kind === 'FOLDING' && i.isClosed ? 0 : Math.max(0, round(i.meters - i.sentOn));
  const desk = await q(`
    SELECT scl.id AS "soCardLotId", scl."soCardId", scl."greyLotId", sc."customerId", scl.meters::float AS meters,
           COALESCE((SELECT SUM(ji.meters) FROM job_items ji JOIN jobs j ON j.id = ji."jobId"
                     WHERE ji."soCardLotId" = scl.id AND ji."sourceJobItemId" IS NULL AND j.status <> 'REJECTED'), 0)::float AS sent
    FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL
    WHERE sc."companyId" = :companyId`, { companyId });
  const packed = await q(`
    SELECT p."soCardId", pl."greyLotId", sc."customerId", SUM(pl.meters)::float AS packed,
           SUM(CASE WHEN g.id IS NULL THEN 0 ELSE pl.meters END)::float AS dispatched
    FROM packing_list_lines pl JOIN packing_lists p ON p.id = pl."packingListId" JOIN so_cards sc ON sc.id = p."soCardId"
    LEFT JOIN gate_passes g ON g."packingListId" = p.id
    WHERE p."companyId" = :companyId GROUP BY p."soCardId", pl."greyLotId", sc."customerId"`, { companyId });
  return { items, desk, packed };
}

const emptyCloth = () => ({ soDeskMeters: 0, inProcessMeters: 0, inFoldingMeters: 0, inPackingMeters: 0, activeMeters: 0, packedMeters: 0, dispatchedMeters: 0 });

/**
 * Adds up positions per key. keyOf(row) gets { soCardId, greyLotId, customerId } and returns a key
 * (or null to skip the row). Packing: what reached Packing minus what left with a gate pass.
 */
function clothBy(pos, keyOf) {
  const out = new Map();
  const get = (k) => {
    if (!out.has(k)) out.set(k, emptyCloth());
    return out.get(k);
  };
  for (const d of pos.desk) {
    const k = keyOf(d);
    if (k !== null && k !== undefined) get(k).soDeskMeters += Math.max(0, d.meters - d.sent);
  }
  const inPacking = new Map();
  for (const i of pos.items) {
    const k = keyOf(i);
    if (k === null || k === undefined) continue;
    if (i.kind === 'PACKING') {
      const pk = `${i.soCardId}|${i.greyLotId}`;
      const p = inPacking.get(pk) || { key: k, here: 0, dispatched: 0 };
      p.here += i.here;
      inPacking.set(pk, p);
    } else if (i.kind === 'FOLDING') get(k).inFoldingMeters += i.here;
    else get(k).inProcessMeters += i.here;
  }
  for (const p of pos.packed) {
    const k = keyOf(p);
    if (k === null || k === undefined) continue;
    const c = get(k);
    c.packedMeters += p.packed;
    c.dispatchedMeters += p.dispatched;
    const pk = `${p.soCardId}|${p.greyLotId}`;
    if (inPacking.has(pk)) inPacking.get(pk).dispatched += p.dispatched;
  }
  for (const p of inPacking.values()) get(p.key).inPackingMeters += Math.max(0, p.here - p.dispatched);
  for (const c of out.values()) {
    for (const k of Object.keys(c)) c[k] = round(c[k]);
    c.activeMeters = round(c.inProcessMeters + c.inFoldingMeters + c.inPackingMeters);
  }
  return out;
}

/**
 * Chemical cost after returns, given to job items. A request for one SO card goes to that card's
 * items in the job, a request for the whole job to all its items; shared by meters (as on the
 * cost screens). sentFrom / sentTo: only chemicals the store sent in those days.
 * -> [{ jobItemId, jobId, soCardId, soCardLotId, departmentId, itemId, chemical, unit, qty, value, sentAt }]
 */
async function chemicalShares(companyId, f = {}) {
  const r = { companyId };
  const where = dateWhere("(r.\"sentAt\" AT TIME ZONE 'Asia/Karachi')::date", { dateFrom: f.sentFrom, dateTo: f.sentTo }, r, 's');
  const lines = await q(`
    SELECT r.id AS "requestId", r."reqNo", r."jobId", r."soCardId", r."departmentId", r."sentAt", l."itemId",
           si.name AS chemical, si.unit, (l."sentQty" - l."returnedQty")::float AS qty, (l.value - l."returnedValue")::float AS value
    FROM chemical_requests r JOIN chemical_request_lines l ON l."requestId" = r.id JOIN store_items si ON si.id = l."itemId"
    WHERE r."companyId" = :companyId AND r.status IN ('IN_WAY', 'DELIVERED') AND l."sentQty" > 0 ${where.map((w) => `AND ${w}`).join(' ')}`, r);
  if (!lines.length) return [];
  const jobIds = [...new Set(lines.map((l) => l.jobId))];
  const items = await q(`SELECT id, "jobId", "soCardId", "soCardLotId", meters::float AS meters FROM job_items WHERE "jobId" IN (:jobIds)`, { jobIds });
  const out = [];
  for (const l of lines) {
    const targets = items.filter((i) => i.jobId === l.jobId && (!l.soCardId || i.soCardId === l.soCardId));
    const total = targets.reduce((t, i) => t + i.meters, 0);
    for (const t of targets) {
      const share = total ? t.meters / total : 1 / targets.length;
      out.push({
        jobItemId: t.id, jobId: l.jobId, soCardId: t.soCardId, soCardLotId: t.soCardLotId, departmentId: l.departmentId,
        requestId: l.requestId, reqNo: l.reqNo, itemId: l.itemId, chemical: l.chemical, unit: l.unit, sentAt: l.sentAt,
        qty: l.qty * share, value: l.value * share,
      });
    }
  }
  return out;
}

const sumBy = (rows, keyOf, valueOf = (x) => x.value) => {
  const m = new Map();
  for (const x of rows) m.set(keyOf(x), (m.get(keyOf(x)) || 0) + valueOf(x));
  return m;
};

/** Thaan parts of SO card lots: soCardLotId -> [{ thaanId, thaanNo, meters }]. */
async function thaanParts(soCardLotIds) {
  const out = new Map();
  if (!soCardLotIds.length) return out;
  const rows = await q(`
    SELECT p."soCardLotId", t.id AS "thaanId", t."thaanNo", p.meters::float AS meters
    FROM so_card_lot_thaans p JOIN grey_lot_thaans t ON t.id = p."thaanId"
    WHERE p."soCardLotId" IN (:ids) ORDER BY t."thaanNo"`, { ids: soCardLotIds });
  for (const r of rows) {
    if (!out.has(r.soCardLotId)) out.set(r.soCardLotId, []);
    out.get(r.soCardLotId).push(r);
  }
  return out;
}

/**
 * One row per SO card inside each job (what went to which department).
 * f: departmentId, customerId, soCardId, status, dateFrom/dateTo (job date), operatorName, search
 */
async function jobCardRows(companyId, f = {}) {
  const r = { companyId };
  const where = ['j."companyId" = :companyId', ...dateWhere('j."jobDate"', f, r)];
  if (f.departmentId) { where.push('j."departmentId" = :departmentId'); r.departmentId = f.departmentId; }
  if (f.fromDepartmentId) { where.push('j."fromDepartmentId" = :fromDepartmentId'); r.fromDepartmentId = f.fromDepartmentId; }
  if (f.customerId) { where.push('sc."customerId" = :customerId'); r.customerId = f.customerId; }
  if (f.soCardId) { where.push('sc.id = :soCardId'); r.soCardId = f.soCardId; }
  if (f.status) { where.push('j.status = :status'); r.status = f.status; }
  if (f.operatorName) { where.push('j."operatorName" ILIKE :operator'); r.operator = `%${f.operatorName}%`; }
  const cs = f.search ? parseCardSearch(f.search) : null;
  if (cs) { where.push(cs.grey ? '(sc."cardNo" = :n AND sc."isGreyReturn")' : '(j."jobNo" = :n OR sc."cardNo" = :n)'); r.n = cs.n; }
  const rows = await q(`
    SELECT j.id AS "jobId", j."jobNo", j."jobDate", j.status, j."isRework", j."isReprocess", j."operatorName", j."processDate",
           j."createdAt" AS "sentAt", j."receivedAt", j."acceptedAt", j."rejectReason", j."sentThrough",
           d.id AS "departmentId", d.name AS department, d.kind, COALESCE(fd.name, 'SO Card') AS "fromDepartment",
           sc.id AS "soCardId", sc."cardNo", sc."isGreyReturn", cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
           COALESCE(MAX(q1.name), MAX(q2.name)) AS quality, string_agg(DISTINCT co.name, ', ') AS colour,
           array_agg(DISTINCT gl."lotNo") AS "lotNos", array_agg(ji.id::text) AS "itemIds", array_agg(DISTINCT ji."soCardLotId"::text) AS "soCardLotIds",
           SUM(ji.meters)::float AS meters
    FROM jobs j
    JOIN services d ON d.id = j."departmentId"
    LEFT JOIN services fd ON fd.id = j."fromDepartmentId"
    JOIN job_items ji ON ji."jobId" = j.id
    JOIN so_cards sc ON sc.id = ji."soCardId"
    JOIN customers cu ON cu.id = sc."customerId"
    JOIN so_card_lots scl ON scl.id = ji."soCardLotId"
    JOIN grey_lots gl ON gl.id = scl."greyLotId"
    LEFT JOIN qualities q1 ON q1.id = sc."qualityId"
    LEFT JOIN qualities q2 ON q2.id = gl."qualityId"
    LEFT JOIN colours co ON co.id = COALESCE(ji."colourId", j."colourId")
    WHERE ${where.join(' AND ')}
    GROUP BY j.id, d.id, fd.name, sc.id, cu.id
    ORDER BY j."jobNo" DESC, sc."cardNo"`, r);
  const parts = await thaanParts([...new Set(rows.flatMap((x) => x.soCardLotIds))]);
  for (const x of rows) x.thaans = x.soCardLotIds.reduce((t, id) => t + (parts.get(id) || []).length, 0);
  return rows;
}

// ---------- catalog ----------

const CATALOG = [
  { key: 'overview', title: 'Overview (all modules)', url: '/v1/reports/overview', filters: ['dateFrom', 'dateTo'] },
  { key: 'grey-parties', title: 'Grey: party wise cloth', url: '/v1/reports/grey/parties', filters: ['dateFrom', 'dateTo', 'customerId'] },
  { key: 'grey-lots', title: 'Grey: lot wise stock', url: '/v1/reports/grey/lots', filters: ['dateFrom', 'dateTo', 'customerId', 'qualityId', 'stock', 'search'] },
  { key: 'grey-returns', title: 'Grey: cloth given back to party', url: '/v1/reports/grey/returns', filters: ['dateFrom', 'dateTo', 'customerId'] },
  { key: 'so-cards', title: 'SO cards', url: '/v1/reports/so-cards', filters: ['dateFrom', 'dateTo', 'customerId', 'departmentId', 'status', 'search'] },
  { key: 'so-card-lots', title: 'SO cards: lots and thaans', url: '/v1/reports/so-cards/lots', filters: ['dateFrom', 'dateTo', 'customerId', 'soCardId', 'search'] },
  { key: 'so-card-detail', title: 'One SO card: full story', url: '/v1/reports/so-cards/:id', filters: [] },
  { key: 'departments', title: 'Departments summary', url: '/v1/reports/departments', filters: ['dateFrom', 'dateTo', 'departmentId', 'customerId'] },
  { key: 'department-jobs', title: 'Departments: SO cards / jobs received', url: '/v1/reports/departments/jobs', filters: ['dateFrom', 'dateTo', 'departmentId', 'fromDepartmentId', 'customerId', 'soCardId', 'status', 'operatorName', 'search'] },
  { key: 'operators', title: 'Departments: operator performance', url: '/v1/reports/departments/operators', filters: ['dateFrom', 'dateTo', 'departmentId', 'operatorName'] },
  { key: 'chemical-cost', title: 'Chemical costing', url: '/v1/reports/chemical-cost', filters: ['by', 'dateFrom', 'dateTo', 'departmentId', 'customerId', 'soCardId', 'itemId'] },
  { key: 'folding', title: 'Folding', url: '/v1/reports/folding', filters: ['by', 'dateFrom', 'dateTo', 'customerId', 'fromDepartmentId', 'tab', 'search'] },
  { key: 'active-fabric', title: 'Active fabric (where cloth is now)', url: '/v1/reports/active-fabric', filters: ['by', 'customerId', 'departmentId'] },
  { key: 'packing-lists', title: 'Packing lists', url: '/v1/reports/packing-lists', filters: ['dateFrom', 'dateTo', 'customerId', 'soCardId', 'status', 'gatePass', 'search'] },
  { key: 'packing-lines', title: 'Packing lists: thaan wise', url: '/v1/reports/packing-lists/lines', filters: ['dateFrom', 'dateTo', 'customerId', 'soCardId', 'status', 'grade', 'search'] },
  { key: 'gate-passes', title: 'Gate passes', url: '/v1/reports/gate-passes', filters: ['dateFrom', 'dateTo', 'customerId', 'search'] },
];

// which service gives access to which report (see routes/reportRoutes.js)
const SERVICE_OF = {
  overview: 'REPORT_OVERVIEW',
  'grey-parties': 'REPORT_GREY', 'grey-lots': 'REPORT_GREY', 'grey-returns': 'REPORT_GREY',
  'so-cards': 'REPORT_SO_CARDS', 'so-card-lots': 'REPORT_SO_CARDS', 'so-card-detail': 'REPORT_SO_CARDS',
  departments: 'REPORT_DEPARTMENTS', 'department-jobs': 'REPORT_DEPARTMENTS', operators: 'REPORT_DEPARTMENTS',
  'chemical-cost': 'REPORT_CHEMICAL_COST', folding: 'REPORT_FOLDING', 'active-fabric': 'REPORT_ACTIVE_FABRIC',
  'packing-lists': 'REPORT_PACKING', 'packing-lines': 'REPORT_PACKING', 'gate-passes': 'REPORT_GATE_PASSES',
};

/** Report services the signed-in person may use: client admin = all the company has, a user = what was given. */
async function allowedServices(req) {
  const { user } = req;
  if (!user.companyId) throw AppError.forbidden();
  const have = user.userType === 'CLIENT_ADMIN'
    ? (await companyServices(user.companyId)).map((s) => s.code)
    : (await userServices(user)).map((g) => g.service.code);
  return new Set(have.filter((c) => c.startsWith('REPORT_')));
}

async function catalog(req) {
  const allowed = await allowedServices(req);
  if (!allowed.size) throw AppError.forbidden('You do not have any report');
  const departments = (await departmentsOf(req.user.companyId)).map((d) => ({ id: d.id, code: d.code, name: d.name, kind: d.kind }));
  const customers = await q('SELECT id, code, name FROM customers WHERE "companyId" = :c AND "deletedAt" IS NULL ORDER BY name', { c: req.user.companyId });
  const qualities = await q('SELECT id, name FROM qualities WHERE "companyId" = :c AND "deletedAt" IS NULL ORDER BY name', { c: req.user.companyId });
  return {
    // only the reports this person may open (each belongs to a service, see `service`)
    reports: CATALOG.filter((c) => allowed.has(SERVICE_OF[c.key])).map((c) => ({ ...c, service: SERVICE_OF[c.key] })),
    // dropdowns for the filters
    departments, customers, qualities,
    jobStatuses: STATUSES.map((s) => ({ value: s, text: STATUS_TEXT[s] })),
    soCardStatuses: Object.entries(CARD_STATUS_TEXT).map(([value, text]) => ({ value, text })),
  };
}

// ---------- grey ----------

/** Per party: what came, given back, on SO cards, still in the grey store, and where the SO card cloth is now. */
async function greyParties(req, f) {
  const companyId = req.user.companyId;
  const r = { companyId };
  const where = ['gl."companyId" = :companyId', 'gl."deletedAt" IS NULL', ...dateWhere('gl."inwardDate"', f, r)];
  if (f.customerId) { where.push('gl."customerId" = :customerId'); r.customerId = f.customerId; }
  const lots = await q(`
    SELECT gl.id, gl."customerId", cu.code AS "customerCode", cu.name AS "customerName", gl."inwardMeters"::float AS inward, gl."outwardMeters"::float AS outward,
           gl."returnedMeters"::float AS returned, gl."returnedPieces", gl.pieces, gl."isActive",
           (SELECT COUNT(*) FROM grey_lot_thaans t WHERE t."lotId" = gl.id AND t.status <> 'RETURNED' AND t.meters > t."takenMeters")::int AS "freeThaans",
           (SELECT COALESCE(SUM(l.meters), 0) FROM so_card_lots l JOIN so_cards s ON s.id = l."soCardId" AND s."deletedAt" IS NULL WHERE l."greyLotId" = gl.id AND s."isGreyReturn")::float AS "greyReturnCard"
    FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" WHERE ${where.join(' AND ')}`, r);
  const lotIds = new Set(lots.map((l) => l.id));
  const cloth = clothBy(await positions(companyId), (x) => (lotIds.has(x.greyLotId) ? x.customerId : null));
  const by = new Map();
  for (const l of lots) {
    const p = by.get(l.customerId) || { customerId: l.customerId, customerCode: l.customerCode, customer: l.customerName, lots: 0, activeLots: 0, pieces: 0, inwardMeters: 0, returnedMeters: 0, returnedPieces: 0, soCardMeters: 0, greyReturnCardMeters: 0, greyStockMeters: 0, greyStockThaans: 0 };
    p.lots += 1;
    if (l.isActive) p.activeLots += 1;
    p.pieces += l.pieces;
    p.inwardMeters += l.inward;
    p.returnedMeters += l.returned;
    p.returnedPieces += l.returnedPieces;
    p.soCardMeters += l.outward - l.returned - l.greyReturnCard;
    p.greyReturnCardMeters += l.greyReturnCard;
    p.greyStockMeters += l.inward - l.outward;
    p.greyStockThaans += l.freeThaans;
    by.set(l.customerId, p);
  }
  const rows = [...by.values()].map((p) => {
    const c = cloth.get(p.customerId) || emptyCloth();
    const out = { ...p, ...c };
    for (const k of ['inwardMeters', 'returnedMeters', 'soCardMeters', 'greyReturnCardMeters', 'greyStockMeters']) out[k] = round(out[k]);
    return out;
  }).sort((a, b) => b.inwardMeters - a.inwardMeters);
  return table('grey-parties', 'Party wise cloth (grey inward to dispatch)', [
    col('customer', 'Party'), col('customerCode', 'Party #', 'int'), col('lots', 'Lots', 'int', true), col('activeLots', 'Active lots', 'int', true),
    col('pieces', 'Thaans in', 'int', true), col('inwardMeters', 'Inward (m)', 'meters', true),
    col('returnedMeters', 'Given back (m)', 'meters', true), col('soCardMeters', 'On SO cards (m)', 'meters', true),
    col('greyReturnCardMeters', 'Fabric return grey (m)', 'meters', true),
    col('greyStockMeters', 'In grey store (m)', 'meters', true), col('greyStockThaans', 'Thaans in grey store', 'int', true),
    col('soDeskMeters', 'SO card not sent (m)', 'meters', true), col('inProcessMeters', 'In departments (m)', 'meters', true),
    col('inFoldingMeters', 'In folding (m)', 'meters', true), col('inPackingMeters', 'In packing (m)', 'meters', true),
    col('activeMeters', 'Active / in process (m)', 'meters', true), col('packedMeters', 'Packed (m)', 'meters', true),
    col('dispatchedMeters', 'Dispatched, gate pass (m)', 'meters', true),
  ], rows, f);
}

async function greyLots(req, f) {
  const companyId = req.user.companyId;
  const r = { companyId };
  const where = ['gl."companyId" = :companyId', 'gl."deletedAt" IS NULL', ...dateWhere('gl."inwardDate"', f, r)];
  if (f.customerId) { where.push('gl."customerId" = :customerId'); r.customerId = f.customerId; }
  if (f.qualityId) { where.push('gl."qualityId" = :qualityId'); r.qualityId = f.qualityId; }
  if (f.stock === 'in-stock') where.push('gl."inwardMeters" > gl."outwardMeters"');
  if (f.stock === 'finished') where.push('gl."inwardMeters" <= gl."outwardMeters"');
  if (f.search) {
    r.like = `%${f.search}%`;
    where.push(`(gl."dcNo" ILIKE :like OR gl."partyRef" ILIKE :like OR gl."typeNo" ILIKE :like${/^\d+$/.test(f.search) ? ' OR gl."lotNo" = :n' : ''})`);
    if (/^\d+$/.test(f.search)) r.n = Number(f.search);
  }
  const lots = await q(`
    SELECT gl.id, gl."lotNo", gl."typeNo", gl."dcNo", gl."inwardDate", gl.unit, gl.pieces, gl."inwardMeters"::float AS "inwardMeters", gl."inwardYards"::float AS "inwardYards",
           gl."outwardMeters"::float AS outward, gl."returnedMeters"::float AS "returnedMeters", gl."returnedPieces", gl.glm::float AS glm, gl.gsm::float AS gsm,
           gl."partyRef", gl."vehicleNo", gl."isApproved", gl."isActive", gl."isReprocess", gl.remarks,
           cu.code AS "customerCode", cu.name AS "customerName", qu.name AS quality,
           (SELECT COUNT(*) FROM grey_lot_thaans t WHERE t."lotId" = gl.id)::int AS "thaanList",
           (SELECT COUNT(*) FROM grey_lot_thaans t WHERE t."lotId" = gl.id AND t.status <> 'RETURNED' AND t.meters > t."takenMeters")::int AS "freeThaans",
           (SELECT array_agg(DISTINCT s."cardNo") FROM so_card_lots l JOIN so_cards s ON s.id = l."soCardId" AND s."deletedAt" IS NULL AND NOT s."isGreyReturn" WHERE l."greyLotId" = gl.id) AS "cardNos",
           (SELECT COALESCE(SUM(l.meters), 0) FROM so_card_lots l JOIN so_cards s ON s.id = l."soCardId" AND s."deletedAt" IS NULL AND s."isGreyReturn" WHERE l."greyLotId" = gl.id)::float AS "fabricReturn"
    FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" JOIN qualities qu ON qu.id = gl."qualityId"
    WHERE ${where.join(' AND ')} ORDER BY gl."lotNo" DESC`, r);
  const cloth = clothBy(await positions(companyId), (x) => x.greyLotId);
  const rows = lots.map((l) => {
    const c = cloth.get(l.id) || emptyCloth();
    return {
      lotNo: l.lotNo, typeNo: l.typeNo, dcNo: l.dcNo, inwardDate: l.inwardDate, party: party(l), quality: l.quality, unit: l.unit,
      thaans: l.thaanList || l.pieces, inwardMeters: round(l.inwardMeters), inwardYards: l.unit === 'YARD' ? round(l.inwardYards) : null,
      glm: l.glm, gsm: l.gsm, soCardMeters: round(l.outward - l.returnedMeters - l.fabricReturn), soCards: nos(l.cardNos), fabricReturnMeters: round(l.fabricReturn),
      returnedMeters: round(l.returnedMeters), returnedPieces: l.returnedPieces, balanceMeters: round(l.inwardMeters - l.outward),
      freeThaans: l.thaanList ? l.freeThaans : null,
      activeMeters: c.activeMeters, packedMeters: c.packedMeters, dispatchedMeters: c.dispatchedMeters,
      partyRef: l.partyRef, vehicleNo: l.vehicleNo, isReprocess: l.isReprocess, isApproved: l.isApproved, isActive: l.isActive, remarks: l.remarks,
    };
  });
  return table('grey-lots', 'Lot wise grey stock', [
    col('lotNo', 'Lot #', 'int'), col('typeNo', 'Type #'), col('dcNo', 'DC #'), col('inwardDate', 'Inward date', 'date'), col('party', 'Party'), col('quality', 'Quality'),
    col('unit', 'Unit'), col('thaans', 'Thaans', 'int', true), col('inwardMeters', 'Inward (m)', 'meters', true), col('inwardYards', 'Inward (yd)', 'meters', true),
    col('glm', 'GLM', 'number'), col('gsm', 'GSM', 'number'), col('soCardMeters', 'On SO cards (m)', 'meters', true), col('soCards', 'SO #'), col('fabricReturnMeters', 'Fabric return grey (m)', 'meters', true),
    col('returnedMeters', 'Given back (m)', 'meters', true), col('returnedPieces', 'Given back thaans', 'int', true),
    col('balanceMeters', 'In grey store (m)', 'meters', true), col('freeThaans', 'Thaans in store', 'int', true),
    col('activeMeters', 'Active (m)', 'meters', true), col('packedMeters', 'Packed (m)', 'meters', true), col('dispatchedMeters', 'Dispatched (m)', 'meters', true),
    col('partyRef', 'Party ref'), col('vehicleNo', 'Vehicle #'), col('isReprocess', 'Re-process', 'boolean'), col('isApproved', 'Approved', 'boolean'),
    col('isActive', 'Active', 'boolean'), col('remarks', 'Remarks'),
  ], rows, f);
}

async function greyReturns(req, f) {
  const r = { companyId: req.user.companyId };
  const where = ['gr."companyId" = :companyId', ...dateWhere('gr."returnDate"', f, r)];
  if (f.customerId) { where.push('gl."customerId" = :customerId'); r.customerId = f.customerId; }
  const rows = (await q(`
    SELECT gr."returnNo", gr."returnDate", gl."lotNo", cu.code AS "customerCode", cu.name AS "customerName", qu.name AS quality,
           gr.pieces, gr.meters::float AS meters, gr."vehicleNo", gr.remarks,
           (SELECT string_agg(t."thaanNo"::text, ', ' ORDER BY t."thaanNo") FROM grey_lot_thaans t WHERE t."returnId" = gr.id) AS "thaanNos"
    FROM grey_returns gr JOIN grey_lots gl ON gl.id = gr."lotId" JOIN customers cu ON cu.id = gl."customerId" JOIN qualities qu ON qu.id = gl."qualityId"
    WHERE ${where.join(' AND ')} ORDER BY gr."returnNo" DESC`, r)).map((x) => ({ ...x, party: party(x), meters: round(x.meters) }));
  return table('grey-returns', 'Cloth given back to party (not processed)', [
    col('returnNo', 'Return #', 'int'), col('returnDate', 'Date', 'date'), col('lotNo', 'Lot #', 'int'), col('party', 'Party'), col('quality', 'Quality'),
    col('pieces', 'Thaans', 'int', true), col('thaanNos', 'Thaan #'), col('meters', 'Meters', 'meters', true), col('vehicleNo', 'Vehicle #'), col('remarks', 'Remarks'),
  ], rows, f);
}

// ---------- SO cards ----------

async function cardBase(companyId, f) {
  const r = { companyId };
  const where = ['sc."companyId" = :companyId', 'sc."deletedAt" IS NULL', ...dateWhere('sc."cardDate"', f, r)];
  if (f.customerId) { where.push('sc."customerId" = :customerId'); r.customerId = f.customerId; }
  if (f.soCardId) { where.push('sc.id = :soCardId'); r.soCardId = f.soCardId; }
  if (f.isGreyReturn !== undefined) where.push(f.isGreyReturn ? 'sc."isGreyReturn"' : 'NOT sc."isGreyReturn"');
  if (f.status) { where.push('sc.status = :status'); r.status = f.status; }
  if (f.departmentId) {
    where.push(`EXISTS (SELECT 1 FROM job_items ji JOIN jobs j ON j.id = ji."jobId" WHERE ji."soCardId" = sc.id AND j."departmentId" = :departmentId AND j.status <> 'REJECTED')`);
    r.departmentId = f.departmentId;
  }
  const cs = f.search ? parseCardSearch(f.search) : null;
  if (cs) { where.push(cs.grey ? '(sc."cardNo" = :n AND sc."isGreyReturn")' : '(sc."cardNo" = :n OR sc."idNo" = :n)'); r.n = cs.n; }
  return q(`
    SELECT sc.id, sc."cardNo", sc."idNo", sc."cardDate", sc.status, sc."isGreyReturn", sc."isReprocess", sc."isConfirmed", sc."totalMeters"::float AS "totalMeters",
           sc."totalPieces", sc."deliveryDate", sc.article, sc.description, sc.instructions, sc.remarks,
           cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName", cd.name AS "currentDepartment",
           COALESCE(q1.name, (SELECT MAX(q2.name) FROM so_card_lots l JOIN grey_lots g ON g.id = l."greyLotId" JOIN qualities q2 ON q2.id = g."qualityId" WHERE l."soCardId" = sc.id)) AS quality,
           (SELECT COUNT(*) FROM so_card_lots l WHERE l."soCardId" = sc.id)::int AS lots,
           (SELECT array_agg(g."lotNo") FROM so_card_lots l JOIN grey_lots g ON g.id = l."greyLotId" WHERE l."soCardId" = sc.id) AS "lotNos",
           (SELECT COUNT(*) FROM so_card_lot_thaans p JOIN so_card_lots l ON l.id = p."soCardLotId" WHERE l."soCardId" = sc.id)::int AS thaans,
           u.name AS "createdBy"
    FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" LEFT JOIN qualities q1 ON q1.id = sc."qualityId"
    LEFT JOIN services cd ON cd.id = sc."currentDepartmentId" LEFT JOIN users u ON u.id = sc."createdById"
    WHERE ${where.join(' AND ')} ORDER BY sc."cardNo" DESC`, r);
}

const lastVisit = (visits, id) => { const v = visits.filter((x) => x.soCardId === id); return v.length ? v.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt))[0].name : null; };

async function soCards(req, f) {
  const companyId = req.user.companyId;
  const cards = await cardBase(companyId, { ...f, isGreyReturn: f.isGreyReturn === undefined ? false : f.isGreyReturn });
  const cloth = clothBy(await positions(companyId), (x) => x.soCardId);
  const visits = await q(`
    SELECT ji."soCardId", s.name, MIN(j."createdAt") AS at, MAX(j."createdAt") AS "lastAt" FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN services s ON s.id = j."departmentId"
    WHERE j."companyId" = :companyId AND j.status <> 'REJECTED' GROUP BY ji."soCardId", s.name ORDER BY at`, { companyId });
  const lists = await q(`
    SELECT p."soCardId", COUNT(DISTINCT p.id)::int AS lists, COUNT(DISTINCT g.id)::int AS passes
    FROM packing_lists p LEFT JOIN gate_passes g ON g."packingListId" = p.id WHERE p."companyId" = :companyId GROUP BY p."soCardId"`, { companyId });
  const cost = sumBy(await chemicalShares(companyId), (x) => x.soCardId);
  const rows = cards.map((c) => {
    const pos = cloth.get(c.id) || emptyCloth();
    const l = lists.find((x) => x.soCardId === c.id) || { lists: 0, passes: 0 };
    const chem = round(cost.get(c.id) || 0);
    return {
      soCardId: c.id, cardNo: c.cardNo, cardLabel: soLabel(c.cardNo, c.isGreyReturn), idNo: c.idNo, cardDate: c.cardDate, party: party(c), quality: c.quality,
      lots: c.lots, lotNos: nos(c.lotNos), thaans: c.thaans, meters: round(c.totalMeters),
      // where the cloth went last (the stored department of a card stays the first one it was sent to)
      status: CARD_STATUS_TEXT[c.status] || c.status, currentDepartment: lastVisit(visits, c.id) || c.currentDepartment,
      departments: visits.filter((v) => v.soCardId === c.id).map((v) => v.name).join(' > '),
      sentMeters: round(c.totalMeters - pos.soDeskMeters), ...pos,
      chemicalCost: chem, costPerMeter: c.totalMeters ? round(chem / c.totalMeters, 4) : 0,
      packingLists: l.lists, gatePasses: l.passes,
      isGreyReturn: c.isGreyReturn, isReprocess: c.isReprocess, deliveryDate: c.deliveryDate, article: c.article, createdBy: c.createdBy,
    };
  });
  return table('so-cards', 'SO cards', [
    col('cardLabel', 'SO #'), col('idNo', 'ID #', 'int'), col('cardDate', 'Date', 'date'), col('party', 'Party'), col('quality', 'Quality'),
    col('lots', 'Lots', 'int', true), col('lotNos', 'Lot #'), col('thaans', 'Thaans', 'int', true), col('meters', 'Meters', 'meters', true),
    col('status', 'Status'), col('currentDepartment', 'Last sent to'), col('departments', 'Departments (in order)'),
    col('sentMeters', 'Sent to departments (m)', 'meters', true), col('soDeskMeters', 'Not sent (m)', 'meters', true),
    col('inProcessMeters', 'In departments (m)', 'meters', true), col('inFoldingMeters', 'In folding (m)', 'meters', true),
    col('inPackingMeters', 'In packing (m)', 'meters', true), col('packedMeters', 'Packed (m)', 'meters', true), col('dispatchedMeters', 'Dispatched (m)', 'meters', true),
    col('chemicalCost', 'Chemical cost', 'money', true), col('costPerMeter', 'Cost / m', 'rate'),
    col('packingLists', 'Packing lists', 'int', true), col('gatePasses', 'Gate passes', 'int', true),
    col('isGreyReturn', 'Fabric return grey', 'boolean'), col('isReprocess', 'Re-process', 'boolean'), col('deliveryDate', 'Delivery date', 'date'),
    col('article', 'Article'), col('createdBy', 'Made by'),
  ], rows, f);
}

async function soCardLots(req, f) {
  const companyId = req.user.companyId;
  const r = { companyId };
  const where = ['sc."companyId" = :companyId', 'sc."deletedAt" IS NULL', ...dateWhere('sc."cardDate"', f, r)];
  if (f.customerId) { where.push('sc."customerId" = :customerId'); r.customerId = f.customerId; }
  if (f.soCardId) { where.push('sc.id = :soCardId'); r.soCardId = f.soCardId; }
  where.push(f.isGreyReturn ? 'sc."isGreyReturn"' : 'NOT sc."isGreyReturn"');
  if (f.search && /^\d+$/.test(f.search)) { where.push('(sc."cardNo" = :n OR gl."lotNo" = :n)'); r.n = Number(f.search); }
  const lots = await q(`
    SELECT scl.id, sc."cardNo", sc."isGreyReturn", sc."cardDate", cu.code AS "customerCode", cu.name AS "customerName", gl."lotNo", gl."inwardDate", qu.name AS quality,
           scl.meters::float AS meters, scl.pieces, scl."balanceBefore"::float AS "balanceBefore"
    FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" JOIN customers cu ON cu.id = sc."customerId"
    JOIN grey_lots gl ON gl.id = scl."greyLotId" JOIN qualities qu ON qu.id = COALESCE(sc."qualityId", gl."qualityId")
    WHERE ${where.join(' AND ')} ORDER BY sc."cardNo" DESC, gl."lotNo"`, r);
  const parts = await thaanParts(lots.map((l) => l.id));
  const rows = lots.map((l) => {
    const ts = parts.get(l.id) || [];
    return {
      cardNo: l.cardNo, cardLabel: soLabel(l.cardNo, l.isGreyReturn), cardDate: l.cardDate, party: party(l), lotNo: l.lotNo, lotInwardDate: l.inwardDate, quality: l.quality,
      thaans: ts.length || l.pieces, thaanNos: ts.map((t) => `${t.thaanNo} (${round(t.meters)})`).join(', '),
      meters: round(l.meters), lotBalanceBefore: l.balanceBefore === null ? null : round(l.balanceBefore),
    };
  });
  return table('so-card-lots', 'SO cards: lots and thaans', [
    col('cardLabel', 'SO #'), col('cardDate', 'Date', 'date'), col('party', 'Party'), col('lotNo', 'Lot #', 'int'), col('lotInwardDate', 'Lot inward date', 'date'),
    col('quality', 'Quality'), col('thaans', 'Thaans', 'int', true), col('thaanNos', 'Thaan # (meters)'), col('meters', 'Meters', 'meters', true),
    col('lotBalanceBefore', 'Lot balance before (m)', 'meters'),
  ], rows, f);
}

/** Everything about one SO card: lots, thaans, its road through departments, chemicals, folding, packing, gate passes. */
async function soCardDetail(req, id) {
  const companyId = req.user.companyId;
  const [c] = await cardBase(companyId, { soCardId: id });
  if (!c) throw AppError.notFound('SO card');
  const lots = await q(`
    SELECT scl.id, gl.id AS "greyLotId", gl."lotNo", gl."inwardDate", qu.name AS quality, scl.meters::float AS meters, scl.pieces
    FROM so_card_lots scl JOIN grey_lots gl ON gl.id = scl."greyLotId" JOIN qualities qu ON qu.id = gl."qualityId"
    WHERE scl."soCardId" = :id ORDER BY gl."lotNo"`, { id });
  const parts = await thaanParts(lots.map((l) => l.id));
  const jobs = await jobCardRows(companyId, { soCardId: id });
  jobs.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
  const shares = (await chemicalShares(companyId)).filter((x) => x.soCardId === id);
  const costByItem = sumBy(shares, (x) => x.jobItemId);
  const deptName = new Map((await departmentsOf(companyId)).map((d) => [d.id, d.name]));
  const pos = clothBy(await positions(companyId), (x) => (x.soCardId === id ? 'card' : null)).get('card') || emptyCloth();

  // chemical cost per lot / thaan: each job item is one lot of the card
  const items = jobs.length ? await q(`SELECT id, "soCardLotId", meters::float AS meters FROM job_items WHERE id IN (:ids)`, { ids: jobs.flatMap((j) => j.itemIds) }) : [];
  const lotCost = new Map();
  for (const i of items) lotCost.set(i.soCardLotId, (lotCost.get(i.soCardLotId) || 0) + (costByItem.get(i.id) || 0));

  const thaanRows = [];
  for (const l of lots) {
    const ts = parts.get(l.id) || [];
    const lotTotal = ts.reduce((t, x) => t + x.meters, 0);
    for (const t of ts) thaanRows.push({ lotNo: l.lotNo, thaanNo: t.thaanNo, meters: round(t.meters), chemicalCost: round(lotTotal ? (lotCost.get(l.id) || 0) * (t.meters / lotTotal) : 0) });
  }
  const chemByJob = new Map();
  for (const x of shares) {
    const k = `${x.jobId}|${x.itemId}`;
    const j = jobs.find((y) => y.jobId === x.jobId);
    const o = chemByJob.get(k) || { department: deptName.get(x.departmentId) || null, jobNo: j ? j.jobNo : null, chemical: x.chemical, unit: x.unit, qty: 0, value: 0 };
    o.qty += x.qty;
    o.value += x.value;
    chemByJob.set(k, o);
  }
  const chemRows = [...chemByJob.values()].map((o) => ({ ...o, qty: round(o.qty, 3), value: round(o.value) }))
    .sort((a, b) => (a.jobNo || 0) - (b.jobNo || 0) || b.value - a.value);

  const foldRows = await q(`
    SELECT j."jobNo", gl."lotNo", t."thaanNo", fl."aMeters"::float AS a, fl."bMeters"::float AS b, fl."cpMeters"::float AS cp,
           (fl."sentA" + fl."sentB" + fl."sentCP")::float AS sent
    FROM folding_lines fl JOIN jobs j ON j.id = fl."jobId" JOIN grey_lots gl ON gl.id = fl."greyLotId" LEFT JOIN grey_lot_thaans t ON t.id = fl."thaanId"
    WHERE fl."soCardId" = :id ORDER BY j."jobNo", gl."lotNo", t."thaanNo"`, { id });
  const listRows = await q(`
    SELECT p."listNo", p."listDate", p.status, g."gatePassNo", g."passDate", g."vehicleNo", g."driverName", g.destination,
           COUNT(pl.id)::int AS thaans, COALESCE(SUM(pl.meters), 0)::float AS meters,
           COALESCE(SUM(ROUND(pl.meters * CASE pl.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END, 2)), 0)::float AS amount
    FROM packing_lists p LEFT JOIN packing_list_lines pl ON pl."packingListId" = p.id LEFT JOIN gate_passes g ON g."packingListId" = p.id
    WHERE p."soCardId" = :id GROUP BY p.id, g.id ORDER BY p."listNo"`, { id });
  const chemTotal = round(shares.reduce((t, x) => t + x.value, 0));

  return {
    report: 'so-card-detail',
    title: `SO card ${soLabel(c.cardNo, c.isGreyReturn)}`,
    header: {
      soCardId: c.id, cardNo: c.cardNo, cardLabel: soLabel(c.cardNo, c.isGreyReturn), idNo: c.idNo, cardDate: c.cardDate, party: party(c), quality: c.quality,
      status: CARD_STATUS_TEXT[c.status] || c.status, currentDepartment: (jobs.filter((x) => x.status !== 'REJECTED').pop() || {}).department || c.currentDepartment, lots: c.lots, thaans: c.thaans, meters: round(c.totalMeters),
      isGreyReturn: c.isGreyReturn, isReprocess: c.isReprocess, deliveryDate: c.deliveryDate, article: c.article, description: c.description,
      instructions: c.instructions, remarks: c.remarks, createdBy: c.createdBy,
      chemicalCost: chemTotal, costPerMeter: c.totalMeters ? round(chemTotal / c.totalMeters, 4) : 0,
      cloth: pos,
    },
    // label + value pairs for the top of the PDF
    headerFields: [
      ['SO #', soLabel(c.cardNo, c.isGreyReturn)], ['ID #', c.idNo], ['Date', c.cardDate], ['Party', party(c)], ['Quality', c.quality], ['Status', CARD_STATUS_TEXT[c.status] || c.status],
      ['Lots', c.lots], ['Thaans', c.thaans], ['Meters', round(c.totalMeters)], ['Chemical cost', chemTotal],
      ['In departments (m)', pos.inProcessMeters], ['In folding (m)', pos.inFoldingMeters], ['In packing (m)', pos.inPackingMeters], ['Dispatched (m)', pos.dispatchedMeters],
    ].map(([label, value]) => ({ label, value })),
    tables: [
      section('lots', 'Lots', [
        col('lotNo', 'Lot #', 'int'), col('inwardDate', 'Inward date', 'date'), col('quality', 'Quality'), col('thaans', 'Thaans', 'int', true),
        col('meters', 'Meters', 'meters', true), col('chemicalCost', 'Chemical cost', 'money', true),
      ], lots.map((l) => ({ lotNo: l.lotNo, inwardDate: l.inwardDate, quality: l.quality, thaans: (parts.get(l.id) || []).length || l.pieces, meters: round(l.meters), chemicalCost: round(lotCost.get(l.id) || 0) }))),
      section('thaans', 'Thaans', [
        col('lotNo', 'Lot #', 'int'), col('thaanNo', 'Thaan #', 'int'), col('meters', 'Meters', 'meters', true), col('chemicalCost', 'Chemical cost', 'money', true),
      ], thaanRows),
      section('journey', 'Departments (in order)', [
        col('jobNo', 'Job #', 'int'), col('jobDate', 'Date', 'date'), col('fromDepartment', 'From'), col('department', 'To'), col('status', 'Status'),
        col('lotNos', 'Lot #'), col('thaans', 'Thaans', 'int'), col('meters', 'Meters', 'meters'), col('colour', 'Colour'), col('operatorName', 'Operator'),
        col('processDate', 'Process date', 'date'), col('receivedAt', 'Received', 'datetime'), col('acceptedAt', 'Accepted', 'datetime'),
        col('rejectReason', 'Reject reason'), col('chemicalCost', 'Chemical cost', 'money', true),
      ], jobs.map((j) => ({
        jobNo: j.jobNo, jobDate: j.jobDate, fromDepartment: j.fromDepartment, department: j.department, status: STATUS_TEXT[j.status], lotNos: nos(j.lotNos),
        thaans: j.thaans, meters: round(j.meters), colour: j.colour, operatorName: j.operatorName, processDate: j.processDate, receivedAt: j.receivedAt,
        acceptedAt: j.acceptedAt, rejectReason: j.status === 'REJECTED' ? j.rejectReason : null, chemicalCost: round(j.itemIds.reduce((t, x) => t + (costByItem.get(x) || 0), 0)),
      }))),
      section('chemicals', 'Chemicals used', [
        col('department', 'Department'), col('jobNo', 'Job #', 'int'), col('chemical', 'Chemical'), col('unit', 'Unit'), col('qty', 'Qty', 'qty', true), col('value', 'Cost', 'money', true),
      ], chemRows),
      section('folding', 'Folding (A / B / CP)', [
        col('jobNo', 'Job #', 'int'), col('lotNo', 'Lot #', 'int'), col('thaanNo', 'Thaan #', 'int'), col('a', 'A (m)', 'meters', true), col('b', 'B (m)', 'meters', true),
        col('cp', 'CP (m)', 'meters', true), col('sent', 'Sent to packing (m)', 'meters', true),
      ], foldRows.map((x) => ({ ...x, a: round(x.a), b: round(x.b), cp: round(x.cp), sent: round(x.sent) }))),
      section('packing', 'Packing lists and gate passes', [
        col('listNo', 'Packing list #', 'int'), col('listDate', 'Date', 'date'), col('status', 'Status'), col('thaans', 'Thaans', 'int', true),
        col('meters', 'Meters', 'meters', true), col('amount', 'Amount', 'money', true), col('gatePassNo', 'Gate pass #', 'int'), col('passDate', 'Pass date', 'date'),
        col('vehicleNo', 'Vehicle #'), col('driverName', 'Driver'), col('destination', 'Destination'),
      ], listRows.map((x) => ({ ...x, meters: round(x.meters), amount: round(x.amount) }))),
    ],
  };
}

// ---------- departments ----------

async function departments(req, f) {
  const companyId = req.user.companyId;
  let depts = await departmentsOf(companyId);
  if (f.departmentId) depts = depts.filter((d) => d.id === f.departmentId);
  const rows = await jobCardRows(companyId, { dateFrom: f.dateFrom, dateTo: f.dateTo, customerId: f.customerId, departmentId: f.departmentId });
  const pos = await positions(companyId);
  const custOk = (x) => !f.customerId || x.customerId === f.customerId;
  const cost = sumBy(await chemicalShares(companyId), (x) => x.jobItemId);
  // cloth there right now (not limited by the dates); packing: until the gate pass
  const now = new Map();
  for (const i of pos.items) if (custOk(i) && i.kind !== 'PACKING') now.set(i.departmentId, (now.get(i.departmentId) || 0) + i.here);
  const packingNow = clothBy(pos, (x) => (custOk(x) ? 'all' : null)).get('all');
  const out = depts.map((d) => {
    const mine = rows.filter((x) => x.departmentId === d.id);
    const live = mine.filter((x) => x.status !== 'REJECTED');
    const by = (s) => round(mine.filter((x) => x.status === s).reduce((t, x) => t + x.meters, 0));
    const meters = round(live.reduce((t, x) => t + x.meters, 0));
    const chem = round(live.reduce((t, x) => t + x.itemIds.reduce((u, id) => u + (cost.get(id) || 0), 0), 0));
    return {
      departmentId: d.id, department: d.name, kind: d.kind,
      jobs: new Set(live.map((x) => x.jobId)).size, soCards: new Set(live.map((x) => x.soCardId)).size,
      lots: live.reduce((t, x) => t + x.soCardLotIds.length, 0), thaans: live.reduce((t, x) => t + x.thaans, 0), meters,
      inWayMeters: by('IN_WAY'), queueMeters: by('QUEUE'), pendingMeters: by('PENDING'), processingMeters: by('PROCESSING'),
      completeMeters: by('COMPLETE'), rejectedMeters: by('REJECTED'), rejectedJobs: new Set(mine.filter((x) => x.status === 'REJECTED').map((x) => x.jobId)).size,
      reworkMeters: round(live.filter((x) => x.isRework).reduce((t, x) => t + x.meters, 0)),
      operators: new Set(live.map((x) => x.operatorName).filter(Boolean)).size,
      chemicalCost: chem, costPerMeter: meters ? round(chem / meters, 4) : 0,
      activeNowMeters: round(d.kind === 'PACKING' ? (packingNow ? packingNow.inPackingMeters : 0) : (now.get(d.id) || 0)),
    };
  });
  return table('departments', 'Departments summary', [
    col('department', 'Department'), col('jobs', 'Jobs', 'int', true), col('soCards', 'SO cards', 'int', true), col('lots', 'Lots', 'int', true),
    col('thaans', 'Thaans', 'int', true), col('meters', 'Meters received', 'meters', true),
    col('inWayMeters', 'In-Way (m)', 'meters', true), col('queueMeters', 'Queue (m)', 'meters', true), col('pendingMeters', 'Pending (m)', 'meters', true),
    col('processingMeters', 'Processing (m)', 'meters', true), col('completeMeters', 'Complete (m)', 'meters', true),
    col('rejectedMeters', 'Rejected (m)', 'meters', true), col('rejectedJobs', 'Rejected jobs', 'int', true), col('reworkMeters', 'Re-work (m)', 'meters', true),
    col('operators', 'Operators', 'int'), col('chemicalCost', 'Chemical cost', 'money', true), col('costPerMeter', 'Cost / m', 'rate'),
    col('activeNowMeters', 'Cloth there now (m)', 'meters', true),
  ], out, f);
}

async function departmentJobs(req, f) {
  const companyId = req.user.companyId;
  const rows = await jobCardRows(companyId, f);
  const cost = sumBy(await chemicalShares(companyId), (x) => x.jobItemId);
  const out = rows.map((x) => {
    const chem = round(x.itemIds.reduce((t, id) => t + (cost.get(id) || 0), 0));
    return {
      jobId: x.jobId, soCardId: x.soCardId, department: x.department, jobNo: x.jobNo, jobDate: x.jobDate, fromDepartment: x.fromDepartment,
      cardNo: x.cardNo, cardLabel: soLabel(x.cardNo, x.isGreyReturn), party: party(x), quality: x.quality, colour: x.colour, lots: x.soCardLotIds.length, lotNos: nos(x.lotNos), thaans: x.thaans,
      meters: round(x.meters), status: STATUS_TEXT[x.status], operatorName: x.operatorName, processDate: x.processDate, sentAt: x.sentAt,
      receivedAt: x.receivedAt, acceptedAt: x.acceptedAt, sentThrough: x.sentThrough, rejectReason: x.status === 'REJECTED' ? x.rejectReason : null,
      isRework: x.isRework, isReprocess: x.isReprocess, isGreyReturn: x.isGreyReturn,
      chemicalCost: chem, costPerMeter: x.meters ? round(chem / x.meters, 4) : 0,
    };
  });
  return table('department-jobs', 'Departments: SO cards / jobs received', [
    col('department', 'Department'), col('jobNo', 'Job #', 'int'), col('jobDate', 'Date', 'date'), col('fromDepartment', 'From'), col('cardLabel', 'SO #'),
    col('party', 'Party'), col('quality', 'Quality'), col('colour', 'Colour'), col('lots', 'Lots', 'int', true), col('lotNos', 'Lot #'), col('thaans', 'Thaans', 'int', true),
    col('meters', 'Meters', 'meters', true), col('status', 'Status'), col('operatorName', 'Operator'), col('processDate', 'Process date', 'date'),
    col('sentAt', 'Sent', 'datetime'), col('receivedAt', 'Received', 'datetime'), col('acceptedAt', 'Accepted', 'datetime'), col('sentThrough', 'Sent through'),
    col('rejectReason', 'Reject reason'), col('isRework', 'Re-work', 'boolean'), col('isReprocess', 'Re-process', 'boolean'), col('isGreyReturn', 'Fabric return grey', 'boolean'),
    col('chemicalCost', 'Chemical cost', 'money', true), col('costPerMeter', 'Cost / m', 'rate'),
  ], out, f);
}

/** Per department and operator: jobs, SO cards, lots, thaans, meters, chemical cost. Dates = process date (job date when empty). */
async function operators(req, f) {
  const companyId = req.user.companyId;
  let rows = (await jobCardRows(companyId, { departmentId: f.departmentId, operatorName: f.operatorName })).filter((x) => x.status !== 'REJECTED');
  rows = rows.filter((x) => (!f.dateFrom && !f.dateTo) || inRange(x.processDate || x.jobDate, f));
  const cost = sumBy(await chemicalShares(companyId), (x) => x.jobItemId);
  const by = new Map();
  for (const x of rows) {
    const name = x.operatorName || '(not entered)';
    const k = `${x.departmentId}|${name.toLowerCase()}`;
    const o = by.get(k) || { department: x.department, operatorName: name, jobs: new Set(), soCards: new Set(), lots: 0, thaans: 0, meters: 0, chemicalCost: 0, completeJobs: new Set(), first: null, last: null };
    o.jobs.add(x.jobId);
    o.soCards.add(x.soCardId);
    if (x.status === 'COMPLETE') o.completeJobs.add(x.jobId);
    o.lots += x.soCardLotIds.length;
    o.thaans += x.thaans;
    o.meters += x.meters;
    o.chemicalCost += x.itemIds.reduce((t, id) => t + (cost.get(id) || 0), 0);
    const d = x.processDate || x.jobDate;
    if (!o.first || d < o.first) o.first = d;
    if (!o.last || d > o.last) o.last = d;
    by.set(k, o);
  }
  const out = [...by.values()].map((o) => ({
    department: o.department, operatorName: o.operatorName, jobs: o.jobs.size, completeJobs: o.completeJobs.size, soCards: o.soCards.size,
    lots: o.lots, thaans: o.thaans, meters: round(o.meters), chemicalCost: round(o.chemicalCost), costPerMeter: o.meters ? round(o.chemicalCost / o.meters, 4) : 0,
    firstDate: o.first, lastDate: o.last,
  })).sort((a, b) => a.department.localeCompare(b.department) || b.meters - a.meters);
  return table('operators', 'Operator performance', [
    col('department', 'Department'), col('operatorName', 'Operator'), col('jobs', 'Jobs', 'int', true), col('completeJobs', 'Complete jobs', 'int', true),
    col('soCards', 'SO cards', 'int', true), col('lots', 'Lots', 'int', true), col('thaans', 'Thaans', 'int', true), col('meters', 'Meters', 'meters', true),
    col('chemicalCost', 'Chemical cost', 'money', true), col('costPerMeter', 'Cost / m', 'rate'), col('firstDate', 'From', 'date'), col('lastDate', 'To', 'date'),
  ], out, f);
}

// ---------- chemical cost ----------

/**
 * Chemical costing. by:
 *   so-card   one row per department, job and SO card
 *   lot       one row per department, job, SO card and lot
 *   thaan     one row per thaan (the lot's cost shared by thaan meters)
 *   chemical  one row per department, job, SO card, lot and chemical (qty + cost)
 *   item      one row per chemical (all departments together)
 * Dates = when the store sent the chemical.
 */
async function chemicalCost(req, f) {
  const companyId = req.user.companyId;
  let shares = await chemicalShares(companyId, { sentFrom: f.dateFrom, sentTo: f.dateTo });
  if (f.departmentId) shares = shares.filter((x) => x.departmentId === f.departmentId);
  if (f.soCardId) shares = shares.filter((x) => x.soCardId === f.soCardId);
  if (f.itemId) shares = shares.filter((x) => x.itemId === f.itemId);
  const info = new Map();
  if (shares.length) {
    const rows = await q(`
      SELECT ji.id, ji.meters::float AS meters, ji."soCardLotId", j."jobNo", j."jobDate", j."operatorName", d.name AS department, sc.id AS "soCardId", sc."cardNo", sc."isGreyReturn",
             cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName", gl."lotNo", COALESCE(q1.name, q2.name) AS quality
      FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN services d ON d.id = j."departmentId" JOIN so_cards sc ON sc.id = ji."soCardId"
      JOIN customers cu ON cu.id = sc."customerId" JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId"
      LEFT JOIN qualities q1 ON q1.id = sc."qualityId" LEFT JOIN qualities q2 ON q2.id = gl."qualityId"
      WHERE ji.id IN (:ids)`, { ids: [...new Set(shares.map((x) => x.jobItemId))] });
    for (const r of rows) info.set(r.id, r);
  }
  if (f.customerId) shares = shares.filter((x) => info.get(x.jobItemId).customerId === f.customerId);
  const by = f.by || 'so-card';
  const base = (i) => ({ department: i.department, jobNo: i.jobNo, jobDate: i.jobDate, operatorName: i.operatorName, cardNo: i.cardNo, cardLabel: soLabel(i.cardNo, i.isGreyReturn), party: party(i), quality: i.quality });
  const head = [col('department', 'Department'), col('jobNo', 'Job #', 'int'), col('jobDate', 'Job date', 'date'), col('operatorName', 'Operator'), col('cardLabel', 'SO #'), col('party', 'Party'), col('quality', 'Quality')];
  let rows;
  let columns;
  if (by === 'item') {
    const m = new Map();
    for (const x of shares) {
      const o = m.get(x.itemId) || { chemical: x.chemical, unit: x.unit, qty: 0, value: 0, jobs: new Set(), soCards: new Set(), departments: new Set() };
      o.qty += x.qty;
      o.value += x.value;
      o.jobs.add(x.jobId);
      o.soCards.add(x.soCardId);
      o.departments.add(info.get(x.jobItemId).department);
      m.set(x.itemId, o);
    }
    rows = [...m.values()].map((o) => ({ chemical: o.chemical, unit: o.unit, qty: round(o.qty, 3), value: round(o.value), avgRate: o.qty ? round(o.value / o.qty, 4) : 0, jobs: o.jobs.size, soCards: o.soCards.size, departments: [...o.departments].sort().join(', ') }))
      .sort((a, b) => b.value - a.value);
    columns = [col('chemical', 'Chemical'), col('unit', 'Unit'), col('qty', 'Qty', 'qty'), col('value', 'Cost', 'money', true), col('avgRate', 'Avg rate', 'rate'), col('jobs', 'Jobs', 'int'), col('soCards', 'SO cards', 'int'), col('departments', 'Departments')];
  } else if (by === 'chemical') {
    const m = new Map();
    for (const x of shares) {
      const k = `${x.jobItemId}|${x.itemId}`;
      const o = m.get(k) || { ...base(info.get(x.jobItemId)), lotNo: info.get(x.jobItemId).lotNo, lotMeters: round(info.get(x.jobItemId).meters), chemical: x.chemical, unit: x.unit, qty: 0, value: 0 };
      o.qty += x.qty;
      o.value += x.value;
      m.set(k, o);
    }
    rows = [...m.values()].map((o) => ({ ...o, qty: round(o.qty, 3), value: round(o.value) }))
      .sort((a, b) => b.jobNo - a.jobNo || a.cardNo - b.cardNo || a.lotNo - b.lotNo || b.value - a.value);
    columns = [...head, col('lotNo', 'Lot #', 'int'), col('lotMeters', 'Lot meters', 'meters'), col('chemical', 'Chemical'), col('unit', 'Unit'), col('qty', 'Qty', 'qty'), col('value', 'Cost', 'money', true)];
  } else {
    const perItem = sumBy(shares, (x) => x.jobItemId);
    const chemicalsOf = new Map();
    for (const x of shares) {
      if (!chemicalsOf.has(x.jobItemId)) chemicalsOf.set(x.jobItemId, new Set());
      chemicalsOf.get(x.jobItemId).add(x.chemical);
    }
    if (by === 'thaan') {
      const parts = await thaanParts([...new Set([...info.values()].map((i) => i.soCardLotId))]);
      rows = [];
      for (const [itemId, value] of perItem) {
        const i = info.get(itemId);
        const ts = parts.get(i.soCardLotId) || [];
        const all = ts.reduce((t, x) => t + x.meters, 0);
        if (!ts.length) rows.push({ ...base(i), lotNo: i.lotNo, thaanNo: null, meters: round(i.meters), value: round(value) });
        for (const t of ts) rows.push({ ...base(i), lotNo: i.lotNo, thaanNo: t.thaanNo, meters: round(i.meters * (t.meters / all)), value: round(value * (t.meters / all)) });
      }
      columns = [...head, col('lotNo', 'Lot #', 'int'), col('thaanNo', 'Thaan #', 'int'), col('meters', 'Meters', 'meters', true), col('value', 'Chemical cost', 'money', true), col('costPerMeter', 'Cost / m', 'rate')];
    } else {
      const m = new Map();
      for (const [itemId, value] of perItem) {
        const i = info.get(itemId);
        const k = by === 'lot' ? itemId : `${i.jobNo}|${i.soCardId}`;
        const o = m.get(k) || { ...base(i), lotNos: [], lots: 0, meters: 0, value: 0, chemicals: new Set() };
        o.lotNos.push(i.lotNo);
        o.lots += 1;
        o.meters += i.meters;
        o.value += value;
        for (const c of chemicalsOf.get(itemId)) o.chemicals.add(c);
        m.set(k, o);
      }
      rows = [...m.values()].map(({ lotNos, chemicals, ...o }) => ({ ...o, lotNos: nos(lotNos), meters: round(o.meters), value: round(o.value), chemicals: chemicals.size, chemicalNames: [...chemicals].sort().join(', ') }));
      columns = [...head, col('lots', 'Lots', 'int', true), col('lotNos', 'Lot #'), col('meters', 'Meters', 'meters', true), col('chemicals', 'Chemicals', 'int'), col('chemicalNames', 'Chemical names'), col('value', 'Chemical cost', 'money', true), col('costPerMeter', 'Cost / m', 'rate')];
    }
    for (const r of rows) r.costPerMeter = r.meters ? round(r.value / r.meters, 4) : 0;
    rows.sort((a, b) => b.jobNo - a.jobNo || a.cardNo - b.cardNo || (a.lotNo || 0) - (b.lotNo || 0) || (a.thaanNo || 0) - (b.thaanNo || 0));
  }
  const titles = { 'so-card': 'SO card wise', lot: 'Lot wise', thaan: 'Thaan wise', chemical: 'Chemical wise per lot', item: 'Per chemical' };
  return table('chemical-cost', `Chemical costing (${titles[by]})`, columns, rows, f, { totalCost: round(shares.reduce((t, x) => t + x.value, 0)) });
}

// ---------- folding ----------

async function foldingReport(req, f) {
  const companyId = req.user.companyId;
  const depts = (await departmentsOf(companyId)).filter((d) => d.kind === 'FOLDING');
  let all = [];
  for (const d of depts) all.push(...(await folding.rows(req, d.id, '', {})).map((x) => ({ ...x, department: d.name })));
  const from = all.length ? await q(`
    SELECT j.id, j."fromDepartmentId", COALESCE(s.name, 'SO Card') AS name FROM jobs j LEFT JOIN services s ON s.id = j."fromDepartmentId" WHERE j.id IN (:ids)`, { ids: [...new Set(all.map((x) => x.jobId))] }) : [];
  const fromOf = new Map(from.map((x) => [x.id, x]));
  all = all.filter((x) => (!f.dateFrom && !f.dateTo) || inRange(x.jobDate, f));
  if (f.customerId) all = all.filter((x) => x.customer.id === f.customerId);
  if (f.fromDepartmentId) all = all.filter((x) => fromOf.get(x.jobId).fromDepartmentId === f.fromDepartmentId);
  if (f.tab === 'open') all = all.filter((x) => x.leftInFolding > 0);
  if (f.tab === 'closed') all = all.filter((x) => x.isClosed);
  if (f.search && /^\d+$/.test(f.search)) all = all.filter((x) => x.jobNo === Number(f.search) || x.soCard.cardNo === Number(f.search));
  const rows = all.map((x) => ({
    department: x.department, jobNo: x.jobNo, jobDate: x.jobDate, fromDepartment: fromOf.get(x.jobId).name, cardNo: x.soCard.cardNo, cardLabel: x.soCard.cardLabel,
    customerId: x.customer.id, party: `${x.customer.name} (${x.customer.code})`, quality: x.quality, colour: x.colour, pageNo: x.pageNo,
    lots: x.lots.length, thaans: x.lots.reduce((t, l) => t + l.thaanCount, 0),
    receivedMeters: x.totals.received, aMeters: x.totals.a, bMeters: x.totals.b, cpMeters: x.totals.cp, foldedMeters: x.totals.folded, diffMeters: x.totals.diff,
    notGradedMeters: x.totals.notGraded, sentToPackingMeters: x.totals.sent, leftInFoldingMeters: x.leftInFolding,
    sentBackTo: x.sentBackTo, isClosed: x.isClosed, closeNote: x.closeNote, isConfirmed: x.isConfirmed, isRework: x.isRework, isGreyReturn: x.isGreyReturn,
    chemicalCost: x.cost.totalCost, costPerMeter: x.cost.costPerMeter,
  })).sort((a, b) => b.jobNo - a.jobNo || a.cardNo - b.cardNo);
  const meters = [
    col('receivedMeters', 'Received (m)', 'meters', true), col('aMeters', 'A (m)', 'meters', true), col('bMeters', 'B (m)', 'meters', true), col('cpMeters', 'CP (m)', 'meters', true),
    col('foldedMeters', 'Folded (m)', 'meters', true), col('diffMeters', 'Gain / loss (m)', 'meters', true), col('notGradedMeters', 'Not graded (m)', 'meters', true),
    col('sentToPackingMeters', 'Sent to packing (m)', 'meters', true), col('leftInFoldingMeters', 'Left in folding (m)', 'meters', true),
  ];
  const by = f.by || 'row';
  if (by === 'row') {
    return table('folding', 'Folding', [
      col('department', 'Department'), col('jobNo', 'Job #', 'int'), col('jobDate', 'Date', 'date'), col('fromDepartment', 'Came from'), col('cardLabel', 'SO #'),
      col('party', 'Party'), col('quality', 'Quality'), col('colour', 'Colour'), col('pageNo', 'Page #'), col('lots', 'Lots', 'int', true), col('thaans', 'Thaans', 'int', true),
      ...meters, col('sentBackTo', 'Sent back for re-work to'), col('isClosed', 'Closed', 'boolean'), col('closeNote', 'Close note'),
      col('isConfirmed', 'Confirmed', 'boolean'), col('isRework', 'Re-work', 'boolean'), col('isGreyReturn', 'Fabric return grey', 'boolean'),
      col('chemicalCost', 'Chemical cost', 'money', true), col('costPerMeter', 'Cost / m', 'rate'),
    ], rows, f);
  }
  const keyOf = by === 'party' ? (x) => x.party : (x) => x.fromDepartment;
  const m = new Map();
  for (const x of rows) {
    const o = m.get(keyOf(x)) || { name: keyOf(x), soCards: new Set(), jobs: new Set(), thaans: 0, ...Object.fromEntries(meters.map((c) => [c.key, 0])), chemicalCost: 0 };
    o.soCards.add(x.cardLabel);
    o.jobs.add(x.jobNo);
    o.thaans += x.thaans;
    for (const c of meters) o[c.key] += x[c.key];
    o.chemicalCost += x.chemicalCost;
    m.set(keyOf(x), o);
  }
  const grouped = [...m.values()].map((o) => {
    const out = { ...o, soCards: o.soCards.size, jobs: o.jobs.size, chemicalCost: round(o.chemicalCost) };
    for (const c of meters) out[c.key] = round(o[c.key]);
    return out;
  }).sort((a, b) => b.receivedMeters - a.receivedMeters);
  return table('folding', by === 'party' ? 'Folding: party wise' : 'Folding: by department it came from', [
    col('name', by === 'party' ? 'Party' : 'Came from'), col('jobs', 'Jobs', 'int', true), col('soCards', 'SO cards', 'int', true), col('thaans', 'Thaans', 'int', true),
    ...meters, col('chemicalCost', 'Chemical cost', 'money', true),
  ], grouped, f);
}

// ---------- active fabric ----------

/**
 * Cloth inside the factory right now, by party / department / SO card, or every piece (detail):
 * SO card not sent, in departments (by status), in folding, in packing (no gate pass yet).
 */
async function activeFabric(req, f) {
  const companyId = req.user.companyId;
  const pos = await positions(companyId);
  const custOk = (x) => !f.customerId || x.customerId === f.customerId;
  const names = new Map((await q('SELECT id, code, name FROM customers WHERE "companyId" = :companyId', { companyId })).map((c) => [c.id, `${c.name} (${c.code})`]));
  const by = f.by || 'party';
  if (f.departmentId && (by === 'party' || by === 'so-card')) throw AppError.rule('BAD_FILTER', 'departmentId works with by=department or by=detail');
  const cloth = [
    col('soDeskMeters', 'SO card not sent (m)', 'meters', true), col('inProcessMeters', 'In departments (m)', 'meters', true),
    col('inFoldingMeters', 'In folding (m)', 'meters', true), col('inPackingMeters', 'In packing (m)', 'meters', true), col('activeMeters', 'Active total (m)', 'meters', true),
  ];
  if (by === 'party' || by === 'so-card') {
    const m = clothBy(pos, (x) => (custOk(x) ? (by === 'party' ? x.customerId : x.soCardId) : null));
    let rows;
    if (by === 'party') {
      rows = [...m.entries()].map(([id, c]) => ({ party: names.get(id), ...c }));
    } else {
      const cards = new Map((await q('SELECT sc.id, sc."cardNo", sc."isGreyReturn", sc."cardDate", sc."customerId" FROM so_cards sc WHERE sc."companyId" = :companyId', { companyId })).map((c) => [c.id, c]));
      rows = [...m.entries()].map(([id, c]) => ({ cardNo: cards.get(id).cardNo, cardLabel: soLabel(cards.get(id).cardNo, cards.get(id).isGreyReturn), cardDate: cards.get(id).cardDate, party: names.get(cards.get(id).customerId), ...c }));
    }
    rows = rows.filter((r) => r.activeMeters > 0 || r.soDeskMeters > 0).sort((a, b) => b.activeMeters - a.activeMeters);
    return table('active-fabric', by === 'party' ? 'Active fabric: party wise' : 'Active fabric: SO card wise', [
      ...(by === 'party' ? [col('party', 'Party')] : [col('cardLabel', 'SO #'), col('cardDate', 'Date', 'date'), col('party', 'Party')]), ...cloth,
    ], rows, f);
  }
  // by department / detail: every live piece of cloth in a department
  const depts = await departmentsOf(companyId);
  const dispatched = new Map(pos.packed.map((p) => [`${p.soCardId}|${p.greyLotId}`, p.dispatched]));
  const pieces = [];
  const packingTaken = new Map();
  for (const i of pos.items) {
    if (!custOk(i) || (f.departmentId && i.departmentId !== f.departmentId) || i.here <= 0) continue;
    let here = i.here;
    if (i.kind === 'PACKING') {
      // what left with a gate pass is no longer in the factory
      const k = `${i.soCardId}|${i.greyLotId}`;
      const gone = Math.max(0, (dispatched.get(k) || 0) - (packingTaken.get(k) || 0));
      const take = Math.min(here, gone);
      packingTaken.set(k, (packingTaken.get(k) || 0) + take);
      here = round(here - take);
      if (here <= 0) continue;
    }
    pieces.push({ ...i, here });
  }
  if (by === 'department') {
    const rows = depts.filter((d) => !f.departmentId || d.id === f.departmentId).map((d) => {
      const mine = pieces.filter((p) => p.departmentId === d.id);
      const st = (s) => round(mine.filter((p) => p.status === s).reduce((t, p) => t + p.here, 0));
      return {
        department: d.name, soCards: new Set(mine.map((p) => p.soCardId)).size, parties: new Set(mine.map((p) => p.customerId)).size,
        partyNames: [...new Set(mine.map((p) => names.get(p.customerId)))].sort().join(', '),
        inWayMeters: st('IN_WAY'), queueMeters: st('QUEUE'), pendingMeters: st('PENDING'), processingMeters: st('PROCESSING'), completeMeters: st('COMPLETE'),
        meters: round(mine.reduce((t, p) => t + p.here, 0)),
      };
    });
    const desk = clothBy(pos, (x) => (custOk(x) ? 'desk' : null)).get('desk');
    if (!f.departmentId && desk && desk.soDeskMeters > 0) rows.unshift({ department: 'SO Card (not sent)', soCards: null, parties: null, partyNames: null, inWayMeters: 0, queueMeters: 0, pendingMeters: 0, processingMeters: 0, completeMeters: 0, meters: desk.soDeskMeters });
    return table('active-fabric', 'Active fabric: department wise', [
      col('department', 'Department'), col('soCards', 'SO cards', 'int'), col('parties', 'Parties', 'int'), col('partyNames', 'Party names'),
      col('inWayMeters', 'In-Way (m)', 'meters', true), col('queueMeters', 'Queue (m)', 'meters', true), col('pendingMeters', 'Pending (m)', 'meters', true),
      col('processingMeters', 'Processing (m)', 'meters', true), col('completeMeters', 'Complete, not sent on (m)', 'meters', true), col('meters', 'Total (m)', 'meters', true),
    ], rows, f);
  }
  const meta = pieces.length ? await q(`
    SELECT ji.id, sc."cardNo", sc."isGreyReturn", gl."lotNo", j."jobDate", j."operatorName", COALESCE(fd.name, 'SO Card') AS "fromDepartment"
    FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN so_cards sc ON sc.id = ji."soCardId" JOIN so_card_lots scl ON scl.id = ji."soCardLotId"
    JOIN grey_lots gl ON gl.id = scl."greyLotId" LEFT JOIN services fd ON fd.id = j."fromDepartmentId" WHERE ji.id IN (:ids)`, { ids: pieces.map((p) => p.id) }) : [];
  const mm = new Map(meta.map((x) => [x.id, x]));
  const rows = pieces.map((p) => ({
    department: p.department, status: STATUS_TEXT[p.status], jobNo: p.jobNo, jobDate: mm.get(p.id).jobDate, fromDepartment: mm.get(p.id).fromDepartment,
    cardNo: mm.get(p.id).cardNo, cardLabel: soLabel(mm.get(p.id).cardNo, mm.get(p.id).isGreyReturn), lotNo: mm.get(p.id).lotNo, party: names.get(p.customerId), operatorName: mm.get(p.id).operatorName, meters: p.here,
  })).sort((a, b) => a.department.localeCompare(b.department) || b.jobNo - a.jobNo);
  return table('active-fabric', 'Active fabric: every piece in departments', [
    col('department', 'Department'), col('status', 'Status'), col('jobNo', 'Job #', 'int'), col('jobDate', 'Job date', 'date'), col('fromDepartment', 'Came from'),
    col('cardLabel', 'SO #'), col('lotNo', 'Lot #', 'int'), col('party', 'Party'), col('operatorName', 'Operator'), col('meters', 'Meters there', 'meters', true),
  ], rows, f);
}

// ---------- packing lists, gate passes ----------

function packingWhere(f, r) {
  const where = ['p."companyId" = :companyId', ...dateWhere('p."listDate"', f, r)];
  if (f.customerId) { where.push('sc."customerId" = :customerId'); r.customerId = f.customerId; }
  if (f.soCardId) { where.push('p."soCardId" = :soCardId'); r.soCardId = f.soCardId; }
  if (f.status) { where.push('p.status = :status'); r.status = f.status; }
  if (f.gatePass === 'yes') where.push('g.id IS NOT NULL');
  if (f.gatePass === 'no') where.push('g.id IS NULL');
  const cs = f.search ? parseCardSearch(f.search) : null;
  if (cs) { where.push(cs.grey ? '(sc."cardNo" = :n AND sc."isGreyReturn")' : '(p."listNo" = :n OR sc."cardNo" = :n OR g."gatePassNo" = :n)'); r.n = cs.n; }
  return where;
}

async function packingLists(req, f) {
  const r = { companyId: req.user.companyId };
  const where = packingWhere(f, r);
  const rows = (await q(`
    SELECT p."listNo", p."listDate", p.status, sc."cardNo", sc."isGreyReturn", cu.code AS "customerCode", cu.name AS "customerName",
           COALESCE(q1.name, (SELECT MAX(q2.name) FROM so_card_lots l JOIN grey_lots gg ON gg.id = l."greyLotId" JOIN qualities q2 ON q2.id = gg."qualityId" WHERE l."soCardId" = sc.id)) AS quality,
           p.description, p."madeFor", p."ctnQty", p."netWeight"::float AS "netWeight", p."grossWeight"::float AS "grossWeight",
           p."rateA"::float AS "rateA", p."rateB"::float AS "rateB", p."rateCP"::float AS "rateCP", p.remarks,
           COUNT(pl.id)::int AS thaans, array_agg(DISTINCT gl."lotNo") AS "lotNos",
           COALESCE(SUM(pl.meters) FILTER (WHERE pl.grade = 'A'), 0)::float AS "aMeters",
           COALESCE(SUM(pl.meters) FILTER (WHERE pl.grade = 'B'), 0)::float AS "bMeters",
           COALESCE(SUM(pl.meters) FILTER (WHERE pl.grade = 'CP'), 0)::float AS "cpMeters",
           COALESCE(SUM(ROUND(pl.meters * CASE pl.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END, 2)), 0)::float AS amount,
           g."gatePassNo", g."passDate", u.name AS "createdBy"
    FROM packing_lists p JOIN so_cards sc ON sc.id = p."soCardId" JOIN customers cu ON cu.id = sc."customerId" LEFT JOIN qualities q1 ON q1.id = sc."qualityId"
    LEFT JOIN packing_list_lines pl ON pl."packingListId" = p.id LEFT JOIN grey_lots gl ON gl.id = pl."greyLotId"
    LEFT JOIN gate_passes g ON g."packingListId" = p.id LEFT JOIN users u ON u.id = p."createdById"
    WHERE ${where.join(' AND ')} GROUP BY p.id, sc.id, cu.id, q1.name, g.id, u.name ORDER BY p."listNo" DESC`, r)).map((x) => {
    const meters = round(x.aMeters + x.bMeters + x.cpMeters);
    return {
      listNo: x.listNo, listDate: x.listDate, status: x.status === 'FINAL' ? 'Final' : 'Draft', cardNo: x.cardNo, cardLabel: soLabel(x.cardNo, x.isGreyReturn), party: party(x), quality: x.quality,
      description: x.description, madeFor: x.madeFor, lotNos: nos(x.lotNos), thaans: x.thaans,
      aMeters: round(x.aMeters), bMeters: round(x.bMeters), cpMeters: round(x.cpMeters), meters,
      rateA: x.rateA, rateB: x.rateB, rateCP: x.rateCP, amount: round(x.amount),
      ctnQty: x.ctnQty, netWeight: x.netWeight, grossWeight: x.grossWeight, gatePassNo: x.gatePassNo, passDate: x.passDate, createdBy: x.createdBy, remarks: x.remarks,
    };
  });
  return table('packing-lists', 'Packing lists', [
    col('listNo', 'List #', 'int'), col('listDate', 'Date', 'date'), col('status', 'Status'), col('cardLabel', 'SO #'), col('party', 'Party'), col('quality', 'Quality'),
    col('description', 'Description'), col('madeFor', 'Made for'), col('lotNos', 'Lot #'), col('thaans', 'Thaans', 'int', true),
    col('aMeters', 'A (m)', 'meters', true), col('bMeters', 'B (m)', 'meters', true), col('cpMeters', 'CP (m)', 'meters', true), col('meters', 'Total (m)', 'meters', true),
    col('rateA', 'Rate A', 'rate'), col('rateB', 'Rate B', 'rate'), col('rateCP', 'Rate CP', 'rate'), col('amount', 'Amount', 'money', true),
    col('ctnQty', 'CTN qty', 'int', true), col('netWeight', 'Net weight', 'number', true), col('grossWeight', 'Gross weight', 'number', true),
    col('gatePassNo', 'Gate pass #', 'int'), col('passDate', 'Pass date', 'date'), col('createdBy', 'Made by'), col('remarks', 'Remarks'),
  ], rows, f);
}

async function packingLines(req, f) {
  const r = { companyId: req.user.companyId };
  const where = packingWhere(f, r);
  if (f.grade) { where.push('pl.grade = :grade'); r.grade = f.grade; }
  const rows = (await q(`
    SELECT p."listNo", p."listDate", p.status, sc."cardNo", sc."isGreyReturn", cu.code AS "customerCode", cu.name AS "customerName", gl."lotNo", pl."thaanNo", pl.grade,
           pl.meters::float AS meters, (CASE pl.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END)::float AS rate, g."gatePassNo"
    FROM packing_list_lines pl JOIN packing_lists p ON p.id = pl."packingListId" JOIN so_cards sc ON sc.id = p."soCardId" JOIN customers cu ON cu.id = sc."customerId"
    JOIN grey_lots gl ON gl.id = pl."greyLotId" LEFT JOIN gate_passes g ON g."packingListId" = p.id
    WHERE ${where.join(' AND ')} ORDER BY p."listNo" DESC, pl."lineNo"`, r)).map((x) => ({
    listNo: x.listNo, listDate: x.listDate, status: x.status === 'FINAL' ? 'Final' : 'Draft', cardNo: x.cardNo, cardLabel: soLabel(x.cardNo, x.isGreyReturn), party: party(x), lotNo: x.lotNo,
    thaanNo: x.thaanNo, grade: GRADE_TEXT[x.grade], meters: round(x.meters), rate: x.rate, amount: round(x.meters * x.rate), gatePassNo: x.gatePassNo,
  }));
  return table('packing-lines', 'Packing lists: thaan wise', [
    col('listNo', 'List #', 'int'), col('listDate', 'Date', 'date'), col('status', 'Status'), col('cardLabel', 'SO #'), col('party', 'Party'), col('lotNo', 'Lot #', 'int'),
    col('thaanNo', 'Thaan #', 'int'), col('grade', 'Category'), col('meters', 'Meters', 'meters', true), col('rate', 'Rate', 'rate'), col('amount', 'Amount', 'money', true),
    col('gatePassNo', 'Gate pass #', 'int'),
  ], rows, f);
}

async function gatePasses(req, f) {
  const r = { companyId: req.user.companyId };
  const where = ['g."companyId" = :companyId', ...dateWhere('g."passDate"', f, r)];
  if (f.customerId) { where.push('sc."customerId" = :customerId'); r.customerId = f.customerId; }
  if (f.search) {
    r.like = `%${f.search}%`;
    where.push(`(g."vehicleNo" ILIKE :like OR g."driverName" ILIKE :like OR g.destination ILIKE :like${/^\d+$/.test(f.search) ? ' OR g."gatePassNo" = :n OR p."listNo" = :n OR sc."cardNo" = :n' : ''})`);
    if (/^\d+$/.test(f.search)) r.n = Number(f.search);
  }
  const rows = (await q(`
    SELECT g."gatePassNo", g."passDate", p."listNo", sc."cardNo", sc."isGreyReturn", cu.code AS "customerCode", cu.name AS "customerName",
           COALESCE(q1.name, (SELECT MAX(q2.name) FROM so_card_lots l JOIN grey_lots gg ON gg.id = l."greyLotId" JOIN qualities q2 ON q2.id = gg."qualityId" WHERE l."soCardId" = sc.id)) AS quality,
           array_agg(DISTINCT gl."lotNo") AS "lotNos", COUNT(pl.id)::int AS thaans, COALESCE(SUM(pl.meters), 0)::float AS meters,
           g."driverName", g."vehicleNo", g.destination, g."operatorName", g.remarks
    FROM gate_passes g JOIN packing_lists p ON p.id = g."packingListId" JOIN so_cards sc ON sc.id = p."soCardId" JOIN customers cu ON cu.id = sc."customerId"
    LEFT JOIN qualities q1 ON q1.id = sc."qualityId" LEFT JOIN packing_list_lines pl ON pl."packingListId" = p.id LEFT JOIN grey_lots gl ON gl.id = pl."greyLotId"
    WHERE ${where.join(' AND ')} GROUP BY g.id, p.id, sc.id, cu.id, q1.name ORDER BY g."gatePassNo" DESC`, r)).map((x) => ({
    gatePassNo: x.gatePassNo, passDate: x.passDate, listNo: x.listNo, cardNo: x.cardNo, cardLabel: soLabel(x.cardNo, x.isGreyReturn), party: party(x), quality: x.quality, lotNos: nos(x.lotNos),
    thaans: x.thaans, meters: round(x.meters), driverName: x.driverName, vehicleNo: x.vehicleNo, destination: x.destination, operatorName: x.operatorName, remarks: x.remarks,
  }));
  return table('gate-passes', 'Gate passes', [
    col('gatePassNo', 'Gate pass #', 'int'), col('passDate', 'Date', 'date'), col('listNo', 'Packing list #', 'int'), col('cardLabel', 'SO #'), col('party', 'Party'),
    col('quality', 'Quality'), col('lotNos', 'Lot #'), col('thaans', 'Thaans', 'int', true), col('meters', 'Meters', 'meters', true), col('driverName', 'Driver'),
    col('vehicleNo', 'Vehicle #'), col('destination', 'Destination'), col('operatorName', 'Packing operator'), col('remarks', 'Remarks'),
  ], rows, f);
}

// ---------- overview ----------

/** Headline numbers of every module for the dates (each by its own date: inward, card, job, list, pass). */
async function overview(req, f) {
  const companyId = req.user.companyId;
  const one = async (sql, field) => {
    const r = { companyId };
    const where = dateWhere(field, f, r);
    return (await q(sql.replace('%DATES%', where.map((w) => `AND ${w}`).join(' ')), r))[0];
  };
  const grey = await one(`SELECT COUNT(*)::int AS lots, COALESCE(SUM("inwardMeters"), 0)::float AS inward, COALESCE(SUM("returnedMeters"), 0)::float AS returned,
      COALESCE(SUM("outwardMeters" - "returnedMeters" - COALESCE((SELECT SUM(l.meters) FROM so_card_lots l JOIN so_cards s ON s.id = l."soCardId" AND s."deletedAt" IS NULL AND s."isGreyReturn" WHERE l."greyLotId" = grey_lots.id), 0)), 0)::float AS "onCards",
      COALESCE(SUM((SELECT COALESCE(SUM(l.meters), 0) FROM so_card_lots l JOIN so_cards s ON s.id = l."soCardId" AND s."deletedAt" IS NULL AND s."isGreyReturn" WHERE l."greyLotId" = grey_lots.id)), 0)::float AS "fabricReturn",
      COALESCE(SUM("inwardMeters" - "outwardMeters"), 0)::float AS stock
    FROM grey_lots WHERE "companyId" = :companyId AND "deletedAt" IS NULL %DATES%`, '"inwardDate"');
  const cards = await one(`SELECT COUNT(*)::int AS cards, COALESCE(SUM("totalMeters"), 0)::float AS meters, COUNT(*) FILTER (WHERE status = 'NEW')::int AS "notSent"
    FROM so_cards WHERE "companyId" = :companyId AND "deletedAt" IS NULL AND NOT "isGreyReturn" %DATES%`, '"cardDate"');
  const jobs = await one(`SELECT COUNT(*)::int AS jobs, COALESCE(SUM("totalMeters") FILTER (WHERE status <> 'REJECTED'), 0)::float AS meters,
      COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected FROM jobs WHERE "companyId" = :companyId %DATES%`, '"jobDate"');
  const lists = await one(`SELECT COUNT(DISTINCT p.id)::int AS lists, COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'FINAL')::int AS final, COALESCE(SUM(pl.meters), 0)::float AS meters
    FROM packing_lists p LEFT JOIN packing_list_lines pl ON pl."packingListId" = p.id WHERE p."companyId" = :companyId %DATES%`, 'p."listDate"');
  const passes = await one(`SELECT COUNT(DISTINCT g.id)::int AS passes, COALESCE(SUM(pl.meters), 0)::float AS meters
    FROM gate_passes g LEFT JOIN packing_list_lines pl ON pl."packingListId" = g."packingListId" WHERE g."companyId" = :companyId %DATES%`, 'g."passDate"');
  const chem = round((await chemicalShares(companyId, { sentFrom: f.dateFrom, sentTo: f.dateTo })).reduce((t, x) => t + x.value, 0));
  const now = clothBy(await positions(companyId), () => 'all').get('all') || emptyCloth();
  const tiles = [
    ['grey', 'Grey lots received', grey.lots, 'int'], ['grey', 'Grey inward (m)', round(grey.inward), 'meters'], ['grey', 'Given back to party (m)', round(grey.returned), 'meters'],
    ['grey', 'Taken on SO cards (m)', round(grey.onCards), 'meters'], ['grey', 'Fabric return grey (m)', round(grey.fabricReturn), 'meters'], ['grey', 'Still in grey store (m)', round(grey.stock), 'meters'],
    ['soCards', 'SO cards made', cards.cards, 'int'], ['soCards', 'SO card meters', round(cards.meters), 'meters'], ['soCards', 'SO cards not sent', cards.notSent, 'int'],
    ['departments', 'Jobs sent to departments', jobs.jobs, 'int'], ['departments', 'Meters sent to departments', round(jobs.meters), 'meters'], ['departments', 'Rejected jobs', jobs.rejected, 'int'],
    ['chemicals', 'Chemical cost', chem, 'money'],
    ['packing', 'Packing lists', lists.lists, 'int'], ['packing', 'Final packing lists', lists.final, 'int'], ['packing', 'Packed (m)', round(lists.meters), 'meters'],
    ['gatePasses', 'Gate passes', passes.passes, 'int'], ['gatePasses', 'Dispatched (m)', round(passes.meters), 'meters'],
    ['now', 'Now: SO card not sent (m)', now.soDeskMeters, 'meters'], ['now', 'Now: in departments (m)', now.inProcessMeters, 'meters'],
    ['now', 'Now: in folding (m)', now.inFoldingMeters, 'meters'], ['now', 'Now: in packing (m)', now.inPackingMeters, 'meters'], ['now', 'Now: active total (m)', now.activeMeters, 'meters'],
  ].map(([group, label, value, type]) => ({ group, label, value, type }));
  return table('overview', 'Overview', [col('group', 'Section'), col('label', 'Item'), col('value', 'Value', 'number')], tiles, { ...f, all: true }, {
    // the same numbers as an object, for dashboard cards
    summary: { grey, soCards: cards, jobs, packing: lists, gatePasses: passes, chemicalCost: chem, now },
  });
}

module.exports = {
  catalog, overview, greyParties, greyLots, greyReturns, soCards, soCardLots, soCardDetail,
  departments, departmentJobs, operators, chemicalCost, foldingReport, activeFabric, packingLists, packingLines, gatePasses,
};
