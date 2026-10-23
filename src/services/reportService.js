// Reports (owner 2026-10-20). Every report answers the same shape so the frontend can build one
// screen, one PDF and one Excel export for all of them:
//   { title, generatedAt, filters, sections: [{ key, title, columns: [{ key, label, type }], rows: [...], totals: {...} }],
//     page, limit, total }
//   column types: text | number | money | date | datetime | list | tag
//   `export=true` returns every row (no paging) for PDF / Excel.
// The reports only read data. Cloth "now" = what is left of every job item: its meters minus what was
// sent on in a job that is not rejected (a partial send from Folding leaves the rest in Folding).
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { companyServices, userServices } = require('./accessService');
const foldingService = require('./foldingService');
const packingService = require('./packingService');

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const q = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const STATUS_TEXT = { IN_WAY: 'In-Way', QUEUE: 'Queue', PENDING: 'Pending', PROCESSING: 'Processing', COMPLETE: 'Complete', REJECTED: 'Rejected' };
const TAG = 'Fabric return grey';
const col = (key, label, type = 'text') => ({ key, label, type });
const DEPT_KINDS = ['PROCESS', 'FOLDING', 'PACKING'];

/* ---------------- access ---------------- */

/** Departments of the company this person may see (client admin: all of them). */
async function myDepartments(req, kinds = DEPT_KINDS) {
  const all = (await companyServices(req.user.companyId)).filter((s) => kinds.includes(s.kind));
  if (req.user.userType === 'CLIENT_ADMIN') return all;
  const mine = new Set((await userServices(req.user)).map((g) => g.service.id));
  return all.filter((s) => mine.has(s.id));
}

async function needAnyService(req, codes) {
  if (!req.user || !req.user.companyId) throw AppError.forbidden();
  const have = await companyServices(req.user.companyId);
  const ok = req.user.userType === 'CLIENT_ADMIN'
    ? have.some((s) => codes.includes(s.code))
    : (await userServices(req.user)).some((g) => codes.includes(g.service.code));
  if (!ok) throw AppError.forbidden('You do not have the service for this report');
}

/* ---------------- shared pieces ---------------- */

/** Builds one section; totals are the sums of the columns named in sum. */
function section(key, title, columns, rows, sum = []) {
  const totals = {};
  for (const k of sum) totals[k] = round(rows.reduce((t, r) => t + (Number(r[k]) || 0), 0));
  return { key, title, columns, rows, totals };
}

/** Wraps sections: pages the first section's rows unless export=true. */
function respond(title, filters, sections, query = {}) {
  const first = sections[0];
  const total = first ? first.rows.length : 0;
  const page = query.page || 1;
  const limit = query.limit || 50;
  if (first && !query.export && sections.length === 1) first.rows = first.rows.slice((page - 1) * limit, page * limit);
  return { title, generatedAt: new Date().toISOString(), filters, sections, page, limit: query.export ? total : limit, total, export: Boolean(query.export) };
}

const LEFT_SQL = `(ji.meters - COALESCE((SELECT SUM(nx.meters) FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" WHERE nx."sourceJobItemId" = ji.id AND nj.status <> 'REJECTED'), 0))`;

/** Where all the cloth is right now: grey store, SO card desk (not sent), departments. One row per lot line. */
async function clothNow(companyId) {
  const rows = [];
  // 1. still in the grey store: lot balance
  for (const r of await q(`
    SELECT gl.id AS "lotId", gl."lotNo", gl."customerId", cu.code AS "customerCode", cu.name AS "customerName", gl."inwardDate",
           (gl."inwardMeters" - gl."outwardMeters")::float AS meters,
           (SELECT count(*)::int FROM grey_lot_thaans t WHERE t."lotId" = gl.id AND t.status = 'IN_STOCK') AS thaans
    FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId"
    WHERE gl."companyId" = :companyId AND gl."deletedAt" IS NULL AND gl."isApproved" AND gl."inwardMeters" - gl."outwardMeters" > 0.004`, { companyId })) {
    rows.push({ stage: 'Grey Store', stageKind: 'GREY_STORE', department: 'Grey Store', status: 'IN_STORE', statusText: 'In grey store', soCardId: null, soNo: null, isGreyReturn: false, ...r });
  }
  // 2. on an SO card but not sent to a department yet
  for (const r of await q(`
    SELECT sc.id AS "soCardId", sc."cardNo" AS "soNo", sc."isGreyReturn", gl.id AS "lotId", gl."lotNo", gl."customerId", cu.code AS "customerCode", cu.name AS "customerName", gl."inwardDate",
           (scl.meters - COALESCE((SELECT SUM(ji.meters) FROM job_items ji JOIN jobs j ON j.id = ji."jobId" WHERE ji."soCardLotId" = scl.id AND ji."sourceJobItemId" IS NULL AND j.status <> 'REJECTED'), 0))::float AS meters,
           scl.meters::float AS "lineMeters", (SELECT count(*)::int FROM so_card_lot_thaans p WHERE p."soCardLotId" = scl.id) AS thaans
    FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL JOIN grey_lots gl ON gl.id = scl."greyLotId" JOIN customers cu ON cu.id = gl."customerId"
    WHERE sc."companyId" = :companyId`, { companyId })) {
    if (r.meters <= 0.004) continue;
    rows.push({ stage: 'SO Card (not sent)', stageKind: 'SO_CARD', department: 'SO Card', status: 'NEW', statusText: 'Not sent yet', ...r, thaans: r.meters >= r.lineMeters - 0.005 ? r.thaans : null });
  }
  // 3. inside departments
  for (const r of await q(`
    SELECT ji.id AS "itemId", ji."soCardId", sc."cardNo" AS "soNo", sc."isGreyReturn", gl.id AS "lotId", gl."lotNo", gl."customerId", cu.code AS "customerCode", cu.name AS "customerName", gl."inwardDate",
           j.id AS "jobId", j."jobNo", j."departmentId", s.name AS department, s.kind, j.status, j."operatorName", ${LEFT_SQL}::float AS meters, ji.meters::float AS "itemMeters", scl.meters::float AS "lineMeters",
           (SELECT count(*)::int FROM so_card_lot_thaans p WHERE p."soCardLotId" = ji."soCardLotId") AS thaans
    FROM job_items ji JOIN jobs j ON j.id = ji."jobId" AND j.status <> 'REJECTED' JOIN services s ON s.id = j."departmentId"
    JOIN so_cards sc ON sc.id = ji."soCardId" JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId" JOIN customers cu ON cu.id = gl."customerId"
    WHERE j."companyId" = :companyId
      AND NOT EXISTS (SELECT 1 FROM folding_entries fe WHERE fe."jobId" = j.id AND fe."soCardId" = ji."soCardId" AND fe."isClosed")`, { companyId })) {
    if (r.meters <= 0.004) continue;
    const whole = r.meters >= r.lineMeters - 0.005;
    rows.push({ stage: r.kind === 'PACKING' ? 'Packing' : r.department, stageKind: r.kind === 'PACKING' ? 'PACKING' : 'DEPARTMENT', statusText: STATUS_TEXT[r.status], ...r, thaans: whole ? r.thaans : null });
  }
  return rows;
}

/** Chemical cost lines: one row per request line and SO card (a whole-job request is shared by meters). */
async function chemLines(companyId, f = {}) {
  const where = ['r."companyId" = :companyId', `r.status IN ('IN_WAY','DELIVERED')`];
  const rep = { companyId };
  if (f.dateFrom) { where.push('r."sentAt"::date >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('r."sentAt"::date <= :dateTo'); rep.dateTo = f.dateTo; }
  return q(`
    WITH jm AS (SELECT "jobId", SUM(meters) AS tot FROM job_items GROUP BY "jobId"),
         cm AS (SELECT "jobId", "soCardId", SUM(meters) AS m FROM job_items GROUP BY "jobId", "soCardId")
    SELECT r.id AS "requestId", r."reqNo", r."sentAt", r."departmentId", s.name AS department, r."jobId", j."jobNo", cm."soCardId", l."itemId", it.name AS chemical, it.unit,
           ((l."sentQty" - l."returnedQty") * x.f)::float AS qty, ((l.value - l."returnedValue") * x.f)::float AS amount
    FROM chemical_requests r
    JOIN chemical_request_lines l ON l."requestId" = r.id AND l."sentQty" > 0
    JOIN store_items it ON it.id = l."itemId" JOIN services s ON s.id = r."departmentId" JOIN jobs j ON j.id = r."jobId"
    JOIN cm ON cm."jobId" = r."jobId" AND (r."soCardId" IS NULL OR cm."soCardId" = r."soCardId")
    JOIN jm ON jm."jobId" = r."jobId"
    CROSS JOIN LATERAL (SELECT CASE WHEN r."soCardId" IS NOT NULL THEN 1 ELSE cm.m / NULLIF(jm.tot, 0) END AS f) x
    WHERE ${where.join(' AND ')}`, rep);
}
const costMap = (lines, keyFn) => {
  const m = new Map();
  for (const l of lines) m.set(keyFn(l), round((m.get(keyFn(l)) || 0) + l.amount));
  return m;
};

/** One row per job and SO card: what went to a department. */
async function jobCards(companyId, f = {}) {
  const where = ['j."companyId" = :companyId'];
  const rep = { companyId };
  if (f.dateFrom) { where.push('j."jobDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('j."jobDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.departmentIds) { where.push('j."departmentId" IN (:deps)'); rep.deps = f.departmentIds.length ? f.departmentIds : ['00000000-0000-0000-0000-000000000000']; }
  if (f.customerId) { where.push('sc."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.soCardId) { where.push('sc.id = :soCardId'); rep.soCardId = f.soCardId; }
  if (f.soNo) { where.push('sc."cardNo" = :soNo'); rep.soNo = f.soNo; }
  if (f.jobNo) { where.push('j."jobNo" = :jobNo'); rep.jobNo = f.jobNo; }
  if (f.status) { where.push('j.status = :status'); rep.status = f.status; }
  if (f.operator) { where.push('j."operatorName" ILIKE :operator'); rep.operator = `%${f.operator}%`; }
  return q(`
    SELECT j.id AS "jobId", j."jobNo", j."jobDate", j."createdAt" AS "sentAt", j.status, j."operatorName", j."processDate", j."isRework", j."departmentId", s.name AS department, s.kind AS "departmentKind",
           fs.name AS "fromDepartment", sc.id AS "soCardId", sc."cardNo" AS "soNo", sc."isGreyReturn", cu.id AS "customerId", cu.name AS customer,
           MAX(q.name) AS quality, string_agg(DISTINCT COALESCE(ic.name, jc.name), ', ') AS colour,
           SUM(ji.meters)::float AS meters, array_agg(DISTINCT gl."lotNo" ORDER BY gl."lotNo") AS lots,
           (SELECT count(DISTINCT p."thaanId")::int FROM so_card_lot_thaans p WHERE p."soCardLotId" IN (SELECT i2."soCardLotId" FROM job_items i2 WHERE i2."jobId" = j.id AND i2."soCardId" = sc.id)) AS thaans,
           (SELECT string_agg(DISTINCT s2.name, ', ') FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" JOIN services s2 ON s2.id = nj."departmentId"
             WHERE nj.status <> 'REJECTED' AND nx."sourceJobItemId" IN (SELECT x.id FROM job_items x WHERE x."jobId" = j.id AND x."soCardId" = sc.id)) AS "sentTo",
           (SELECT COALESCE(SUM(nx.meters), 0)::float FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId"
             WHERE nj.status <> 'REJECTED' AND nx."sourceJobItemId" IN (SELECT x.id FROM job_items x WHERE x."jobId" = j.id AND x."soCardId" = sc.id)) AS "sentOnMeters"
    FROM jobs j JOIN services s ON s.id = j."departmentId" LEFT JOIN services fs ON fs.id = j."fromDepartmentId"
    JOIN job_items ji ON ji."jobId" = j.id JOIN so_cards sc ON sc.id = ji."soCardId" JOIN customers cu ON cu.id = sc."customerId"
    JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId"
    LEFT JOIN qualities q ON q.id = COALESCE(sc."qualityId", gl."qualityId") LEFT JOIN colours ic ON ic.id = ji."colourId" LEFT JOIN colours jc ON jc.id = j."colourId"
    WHERE ${where.join(' AND ')}
    GROUP BY j.id, s.name, s.kind, fs.name, sc.id, cu.id ORDER BY j."jobNo" DESC, sc."cardNo"`, rep);
}

const lotsText = (a) => (a || []).join(', ');
const nz = (v) => (v === null || v === undefined ? 0 : v);

/* ---------------- 1. grey store ---------------- */

/** Per party: how much cloth came, went on SO cards, went back, is in the store, is being processed, is packed. */
async function greyParties(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD']);
  const companyId = req.user.companyId;
  const dateOk = (d) => (!f.dateFrom || d >= f.dateFrom) && (!f.dateTo || d <= f.dateTo);
  const lots = await q(`SELECT gl.id, gl."customerId", gl."inwardDate", gl."inwardMeters"::float AS inward, gl.pieces, gl."outwardMeters"::float AS outward, gl."returnedMeters"::float AS "givenBack"
    FROM grey_lots gl WHERE gl."companyId" = :companyId AND gl."deletedAt" IS NULL AND gl."isApproved"`, { companyId });
  const cards = await q(`SELECT gl."customerId", gl."inwardDate", sc."isGreyReturn", sc.id AS "soCardId", scl.meters::float AS meters FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL
    JOIN grey_lots gl ON gl.id = scl."greyLotId" WHERE sc."companyId" = :companyId`, { companyId });
  const customers = new Map((await q('SELECT id, code, name FROM customers WHERE "companyId" = :companyId AND "deletedAt" IS NULL', { companyId })).map((c) => [c.id, c]));
  const now = (await clothNow(companyId)).filter((r) => dateOk(r.inwardDate));
  const packed = await q(`SELECT gl."customerId", gl."inwardDate", SUM(pl.meters)::float AS meters, bool_or(g.id IS NOT NULL) AS gp, SUM(CASE WHEN g.id IS NOT NULL THEN pl.meters ELSE 0 END)::float AS dispatched
    FROM packing_list_lines pl JOIN packing_lists p ON p.id = pl."packingListId" LEFT JOIN gate_passes g ON g."packingListId" = p.id JOIN grey_lots gl ON gl.id = pl."greyLotId"
    WHERE p."companyId" = :companyId GROUP BY gl."customerId", gl."inwardDate"`, { companyId });
  const out = new Map();
  const get = (id) => {
    if (!out.has(id)) {
      const c = customers.get(id) || { code: null, name: '(deleted party)' };
      out.set(id, { customerId: id, code: c.code, party: c.name, lots: 0, inwardMeters: 0, inwardThaans: 0, soCardMeters: 0, soCards: new Set(), fabricReturnMeters: 0, givenBackMeters: 0, inStoreMeters: 0, notSentMeters: 0, inProcessMeters: 0, atPackingMeters: 0, packedMeters: 0, dispatchedMeters: 0 });
    }
    return out.get(id);
  };
  for (const l of lots) {
    if (!dateOk(l.inwardDate) || (f.customerId && l.customerId !== f.customerId)) continue;
    const r = get(l.customerId);
    r.lots += 1; r.inwardMeters += l.inward; r.inwardThaans += l.pieces || 0; r.givenBackMeters += l.givenBack;
  }
  for (const c of cards) {
    if (!dateOk(c.inwardDate) || (f.customerId && c.customerId !== f.customerId)) continue;
    const r = get(c.customerId);
    if (c.isGreyReturn) r.fabricReturnMeters += c.meters; else { r.soCardMeters += c.meters; }
    r.soCards.add(c.soCardId);
  }
  for (const n of now) {
    if (f.customerId && n.customerId !== f.customerId) continue;
    const r = get(n.customerId);
    if (n.stageKind === 'GREY_STORE') r.inStoreMeters += n.meters;
    else if (n.stageKind === 'SO_CARD') r.notSentMeters += n.meters;
    else if (n.stageKind === 'PACKING') r.atPackingMeters += n.meters;
    else r.inProcessMeters += n.meters;
  }
  for (const p of packed) {
    if (!dateOk(p.inwardDate) || (f.customerId && p.customerId !== f.customerId)) continue;
    const r = get(p.customerId);
    r.packedMeters += p.meters; r.dispatchedMeters += p.dispatched;
  }
  const rows = [...out.values()].map((r) => ({ ...r, soCards: r.soCards.size,
    inwardMeters: round(r.inwardMeters), soCardMeters: round(r.soCardMeters), fabricReturnMeters: round(r.fabricReturnMeters), givenBackMeters: round(r.givenBackMeters),
    inStoreMeters: round(r.inStoreMeters), notSentMeters: round(r.notSentMeters), inProcessMeters: round(r.inProcessMeters), atPackingMeters: round(r.atPackingMeters),
    packedMeters: round(r.packedMeters), dispatchedMeters: round(r.dispatchedMeters) }))
    .sort((a, b) => a.party.localeCompare(b.party));
  const columns = [col('code', 'Party code'), col('party', 'Party'), col('lots', 'Lots', 'number'), col('inwardMeters', 'Came (m)', 'number'), col('inwardThaans', 'Thaans', 'number'),
    col('soCards', 'SO cards', 'number'), col('soCardMeters', 'On SO cards (m)', 'number'), col('fabricReturnMeters', 'Fabric return (m)', 'number'), col('givenBackMeters', 'Given back (m)', 'number'),
    col('inStoreMeters', 'In grey store (m)', 'number'), col('notSentMeters', 'SO card, not sent (m)', 'number'), col('inProcessMeters', 'In process (m)', 'number'),
    col('atPackingMeters', 'Reached Packing (m)', 'number'), col('packedMeters', 'On packing lists (m)', 'number'), col('dispatchedMeters', 'Gone with gate pass (m)', 'number')];
  return respond('Grey store: party wise cloth', f, [section('parties', 'Party wise', columns, rows,
    ['lots', 'inwardMeters', 'inwardThaans', 'soCards', 'soCardMeters', 'fabricReturnMeters', 'givenBackMeters', 'inStoreMeters', 'notSentMeters', 'inProcessMeters', 'atPackingMeters', 'packedMeters', 'dispatchedMeters'])], f);
}

/** Lot wise: came, on SO cards, given back, in store, where the rest is. */
async function greyLots(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD']);
  const companyId = req.user.companyId;
  const where = ['gl."companyId" = :companyId', 'gl."deletedAt" IS NULL', 'gl."isApproved"'];
  const rep = { companyId };
  if (f.customerId) { where.push('gl."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.dateFrom) { where.push('gl."inwardDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('gl."inwardDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.search) { where.push('(gl."lotNo"::text = :search OR gl."dcNo" ILIKE :like OR gl."typeNo"::text = :search)'); rep.search = f.search; rep.like = `%${f.search}%`; }
  const lots = await q(`
    SELECT gl.id, gl."lotNo", gl."typeNo", gl."dcNo", gl."inwardDate", cu.name AS party, qu.name AS quality, gl."inwardMeters"::float AS inward, gl.pieces,
           gl."outwardMeters"::float AS outward, gl."returnedMeters"::float AS "givenBack", gl."isReprocess",
           COALESCE((SELECT SUM(scl.meters) FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL WHERE scl."greyLotId" = gl.id AND NOT sc."isGreyReturn"), 0)::float AS "onSoCard",
           COALESCE((SELECT SUM(scl.meters) FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL WHERE scl."greyLotId" = gl.id AND sc."isGreyReturn"), 0)::float AS "fabricReturn",
           (SELECT count(*)::int FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL WHERE scl."greyLotId" = gl.id) AS "soCards"
    FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" LEFT JOIN qualities qu ON qu.id = gl."qualityId"
    WHERE ${where.join(' AND ')} ORDER BY gl."lotNo" DESC`, rep);
  const now = await clothNow(companyId);
  const by = (lotId, kind) => round(now.filter((n) => n.lotId === lotId && (kind === 'PROCESS' ? !['GREY_STORE', 'SO_CARD', 'PACKING'].includes(n.stageKind) : n.stageKind === kind)).reduce((t, n) => t + n.meters, 0));
  let rows = lots.map((l) => ({
    lotNo: l.lotNo, typeNo: l.typeNo, dcNo: l.dcNo, inwardDate: l.inwardDate, party: l.party, quality: l.quality, thaans: l.pieces, inwardMeters: round(l.inward),
    soCards: l.soCards, onSoCardMeters: round(l.onSoCard), fabricReturnMeters: round(l.fabricReturn), givenBackMeters: round(l.givenBack), inStoreMeters: round(l.inward - l.outward),
    notSentMeters: by(l.id, 'SO_CARD'), inProcessMeters: by(l.id, 'PROCESS'), atPackingMeters: by(l.id, 'PACKING'), isReprocess: l.isReprocess ? 'Re-process' : '',
  }));
  if (f.status === 'in_store') rows = rows.filter((r) => r.inStoreMeters > 0);
  const columns = [col('lotNo', 'Lot#', 'number'), col('typeNo', 'Type#'), col('dcNo', 'DC#'), col('inwardDate', 'Date', 'date'), col('party', 'Party'), col('quality', 'Quality'), col('thaans', 'Thaans', 'number'),
    col('inwardMeters', 'Came (m)', 'number'), col('soCards', 'SO cards', 'number'), col('onSoCardMeters', 'On SO cards (m)', 'number'), col('fabricReturnMeters', 'Fabric return (m)', 'number'),
    col('givenBackMeters', 'Given back (m)', 'number'), col('inStoreMeters', 'In grey store (m)', 'number'), col('notSentMeters', 'SO card, not sent (m)', 'number'),
    col('inProcessMeters', 'In process (m)', 'number'), col('atPackingMeters', 'Reached Packing (m)', 'number'), col('isReprocess', 'Re-process', 'tag')];
  return respond('Grey store: lot wise', f, [section('lots', 'Lot wise', columns, rows, ['thaans', 'inwardMeters', 'onSoCardMeters', 'fabricReturnMeters', 'givenBackMeters', 'inStoreMeters', 'notSentMeters', 'inProcessMeters', 'atPackingMeters'])], f);
}

/* ---------------- 2. SO cards ---------------- */

const CARD_STATUS = { NEW: 'Not sent', SENT: 'Sent (waiting accept)', IN_DEPARTMENT: 'In department' };

/** All SO cards with lots, thaans, meters, where it went and its chemical cost. */
async function soCards(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const companyId = req.user.companyId;
  const where = ['sc."companyId" = :companyId', 'sc."deletedAt" IS NULL'];
  const rep = { companyId };
  if (f.customerId) { where.push('sc."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.dateFrom) { where.push('sc."cardDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('sc."cardDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.status) { where.push('sc.status = :status'); rep.status = f.status; }
  if (f.isGreyReturn !== undefined) { where.push('sc."isGreyReturn" = :gr'); rep.gr = f.isGreyReturn; }
  if (f.soNo) { where.push('sc."cardNo" = :soNo'); rep.soNo = f.soNo; }
  if (f.departmentId) { where.push('EXISTS (SELECT 1 FROM job_items ji JOIN jobs j ON j.id = ji."jobId" WHERE ji."soCardId" = sc.id AND j."departmentId" = :dep)'); rep.dep = f.departmentId; }
  const cards = await q(`
    SELECT sc.id, sc."cardNo", sc."idNo", sc."cardDate", sc.status, sc."isGreyReturn", sc."deliveryDate", sc.article, cu.name AS party, qu.name AS quality, cd.name AS "currentDepartment",
           sc."totalMeters"::float AS meters, (SELECT count(*)::int FROM so_card_lots l WHERE l."soCardId" = sc.id) AS "lotCount",
           (SELECT array_agg(DISTINCT g."lotNo" ORDER BY g."lotNo") FROM so_card_lots l JOIN grey_lots g ON g.id = l."greyLotId" WHERE l."soCardId" = sc.id) AS lots,
           (SELECT count(*)::int FROM so_card_lot_thaans p JOIN so_card_lots l ON l.id = p."soCardLotId" WHERE l."soCardId" = sc.id) AS thaans,
           (SELECT string_agg(DISTINCT s.name, ', ') FROM job_items ji JOIN jobs j ON j.id = ji."jobId" AND j.status <> 'REJECTED' JOIN services s ON s.id = j."departmentId" WHERE ji."soCardId" = sc.id) AS "wentTo"
    FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" LEFT JOIN qualities qu ON qu.id = sc."qualityId" LEFT JOIN services cd ON cd.id = sc."currentDepartmentId"
    WHERE ${where.join(' AND ')} ORDER BY sc."cardNo" DESC`, rep);
  const now = await clothNow(companyId);
  const cost = costMap(await chemLines(companyId), (l) => l.soCardId);
  const rows = cards.map((c) => {
    const mine = now.filter((n) => n.soCardId === c.id);
    return {
      soNo: c.cardNo, idNo: c.idNo, cardDate: c.cardDate, party: c.party, quality: c.quality, article: c.article, deliveryDate: c.deliveryDate,
      lotCount: c.lotCount, lots: lotsText(c.lots), thaans: c.thaans, meters: round(c.meters), statusText: CARD_STATUS[c.status], currentDepartment: c.currentDepartment, wentTo: c.wentTo,
      inProcessMeters: round(mine.filter((n) => n.stageKind === 'DEPARTMENT').reduce((t, n) => t + n.meters, 0)),
      atPackingMeters: round(mine.filter((n) => n.stageKind === 'PACKING').reduce((t, n) => t + n.meters, 0)),
      chemicalCost: nz(cost.get(c.id)), costPerMeter: c.meters ? round(nz(cost.get(c.id)) / c.meters) : 0, tag: c.isGreyReturn ? TAG : '',
    };
  });
  const columns = [col('soNo', 'SO#', 'number'), col('idNo', 'ID#', 'number'), col('cardDate', 'Date', 'date'), col('party', 'Party'), col('quality', 'Quality'), col('article', 'Article'),
    col('lotCount', 'Lots', 'number'), col('lots', 'Lot#s', 'list'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number'), col('statusText', 'Status'),
    col('currentDepartment', 'Now at'), col('wentTo', 'Went to', 'list'), col('inProcessMeters', 'In process (m)', 'number'), col('atPackingMeters', 'Reached Packing (m)', 'number'),
    col('chemicalCost', 'Chemical cost', 'money'), col('costPerMeter', 'Cost / m', 'money'), col('tag', 'Tag', 'tag')];
  return respond('SO cards', f, [section('cards', 'SO cards', columns, rows, ['lotCount', 'thaans', 'meters', 'inProcessMeters', 'atPackingMeters', 'chemicalCost'])], f);
}

/** Which SO card went to which department: one row per job and card, with lots, thaans and meters. */
async function soCardMovement(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const deps = await myDepartments(req);
  const rows0 = await jobCards(req.user.companyId, { ...f, departmentIds: f.departmentId ? [f.departmentId].filter((id) => deps.some((d) => d.id === id)) : deps.map((d) => d.id) });
  const rows = rows0.map((r) => ({
    soNo: r.soNo, party: r.customer, quality: r.quality, colour: r.colour, department: r.department, fromDepartment: r.fromDepartment || 'SO Card', jobNo: r.jobNo, jobDate: r.jobDate,
    lotCount: r.lots.length, lots: lotsText(r.lots), thaans: nz(r.thaans), meters: round(r.meters), statusText: STATUS_TEXT[r.status], sentTo: r.sentTo || '', tag: r.isGreyReturn ? TAG : (r.isRework ? 'RE-WORK' : ''),
  }));
  const columns = [col('soNo', 'SO#', 'number'), col('party', 'Party'), col('quality', 'Quality'), col('colour', 'Colour'), col('department', 'Department'), col('fromDepartment', 'From'),
    col('jobNo', 'Job#', 'number'), col('jobDate', 'Date', 'date'), col('lotCount', 'Lots', 'number'), col('lots', 'Lot#s', 'list'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number'),
    col('statusText', 'Status'), col('sentTo', 'Then sent to', 'list'), col('tag', 'Tag', 'tag')];
  return respond('SO card movement between departments', f, [section('movement', 'Movement', columns, rows, ['lotCount', 'thaans', 'meters'])], f);
}

/** One SO card, everything: lots and thaans, every department it passed, chemicals, Folding, packing, gate pass. */
async function soCardDetail(req, id) {
  await needAnyService(req, ['SO_CARD']);
  const companyId = req.user.companyId;
  const [c] = await q(`SELECT sc.*, cu.name AS party, cu.code AS "partyCode", qu.name AS quality, cd.name AS "currentDepartment" FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId"
    LEFT JOIN qualities qu ON qu.id = sc."qualityId" LEFT JOIN services cd ON cd.id = sc."currentDepartmentId" WHERE sc.id = :id AND sc."companyId" = :companyId`, { id, companyId });
  if (!c) throw AppError.notFound('SO card');
  const lotRows = await q(`SELECT g."lotNo", g."dcNo", g."typeNo", scl.meters::float AS meters, scl.id AS "lineId",
      (SELECT string_agg(t."thaanNo"::text, ', ' ORDER BY t."thaanNo") FROM so_card_lot_thaans p JOIN grey_lot_thaans t ON t.id = p."thaanId" WHERE p."soCardLotId" = scl.id) AS "thaanNos",
      (SELECT count(*)::int FROM so_card_lot_thaans p WHERE p."soCardLotId" = scl.id) AS thaans
    FROM so_card_lots scl JOIN grey_lots g ON g.id = scl."greyLotId" WHERE scl."soCardId" = :id ORDER BY g."lotNo"`, { id });
  const lots = section('lots', 'Lots and thaans', [col('lotNo', 'Lot#', 'number'), col('dcNo', 'DC#'), col('typeNo', 'Type#'), col('thaans', 'Thaans', 'number'), col('thaanNos', 'Thaan numbers', 'list'), col('meters', 'Meters', 'number')],
    lotRows.map((r) => ({ lotNo: r.lotNo, dcNo: r.dcNo, typeNo: r.typeNo, thaans: r.thaans, thaanNos: r.thaanNos || '', meters: round(r.meters) })), ['thaans', 'meters']);
  const jobs = await jobCards(companyId, { soCardId: id });
  const chem = await chemLines(companyId);
  const mineChem = chem.filter((l) => l.soCardId === id);
  const cost = costMap(mineChem, (l) => l.jobId);
  const path = section('path', 'Departments it passed', [col('jobNo', 'Job#', 'number'), col('jobDate', 'Date', 'date'), col('department', 'Department'), col('fromDepartment', 'From'), col('lots', 'Lot#s', 'list'),
    col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number'), col('statusText', 'Status'), col('operatorName', 'Operator'), col('processDate', 'Process date', 'date'), col('sentTo', 'Then sent to', 'list'),
    col('chemicalCost', 'Chemical cost', 'money')],
  jobs.slice().sort((a, b) => a.jobNo - b.jobNo).map((r) => ({ jobNo: r.jobNo, jobDate: r.jobDate, department: r.department, fromDepartment: r.fromDepartment || 'SO Card', lots: lotsText(r.lots), thaans: nz(r.thaans),
    meters: round(r.meters), statusText: STATUS_TEXT[r.status], operatorName: r.operatorName, processDate: r.processDate, sentTo: r.sentTo || '', chemicalCost: nz(cost.get(r.jobId)) })), ['meters', 'chemicalCost']);
  const chemRows = new Map();
  for (const l of mineChem) {
    const k = `${l.department}|${l.itemId}`;
    const r = chemRows.get(k) || { department: l.department, chemical: l.chemical, unit: l.unit, qty: 0, amount: 0 };
    r.qty = round(r.qty + l.qty); r.amount = round(r.amount + l.amount); chemRows.set(k, r);
  }
  const chemicals = section('chemicals', 'Chemicals used', [col('department', 'Department'), col('chemical', 'Chemical'), col('qty', 'Qty', 'number'), col('unit', 'Unit'), col('rate', 'Avg rate', 'money'), col('amount', 'Amount', 'money')],
    [...chemRows.values()].map((r) => ({ ...r, rate: r.qty ? round(r.amount / r.qty) : 0 })).sort((a, b) => a.department.localeCompare(b.department) || b.amount - a.amount), ['amount']);
  const now = (await clothNow(companyId)).filter((n) => n.soCardId === id);
  const where = section('now', 'Where the cloth is now', [col('stage', 'Place'), col('statusText', 'Status'), col('lotNo', 'Lot#', 'number'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number')],
    now.map((n) => ({ stage: n.stage, statusText: n.statusText, lotNo: n.lotNo, thaans: n.thaans, meters: round(n.meters) })), ['meters']);
  const lists = await q(`SELECT p."listNo", p."listDate", p.status, g."gatePassNo", g."driverName", g."vehicleNo", g.destination, g."passDate",
      (SELECT SUM(l.meters)::float FROM packing_list_lines l WHERE l."packingListId" = p.id) AS meters, (SELECT count(*)::int FROM packing_list_lines l WHERE l."packingListId" = p.id) AS lines
    FROM packing_lists p LEFT JOIN gate_passes g ON g."packingListId" = p.id WHERE p."soCardId" = :id ORDER BY p."listNo"`, { id });
  const packing = section('packing', 'Packing lists and gate passes', [col('listNo', 'List#', 'number'), col('listDate', 'Date', 'date'), col('statusText', 'Status'), col('meters', 'Meters', 'number'),
    col('gatePassNo', 'Gate pass#', 'number'), col('passDate', 'Gate pass date', 'date'), col('driverName', 'Driver'), col('vehicleNo', 'Vehicle'), col('destination', 'Going to')],
  lists.map((r) => ({ listNo: r.listNo, listDate: r.listDate, statusText: r.status === 'FINAL' ? 'Final' : 'Draft', meters: round(r.meters), gatePassNo: r.gatePassNo, passDate: r.passDate, driverName: r.driverName, vehicleNo: r.vehicleNo, destination: r.destination })), ['meters']);
  const head = { soNo: c.cardNo, idNo: c.idNo, cardDate: c.cardDate, party: c.party, partyCode: c.partyCode, quality: c.quality, article: c.article, description: c.description, deliveryDate: c.deliveryDate,
    statusText: CARD_STATUS[c.status], currentDepartment: c.currentDepartment, totalMeters: round(c.totalMeters), instructions: c.instructions, tag: c.isGreyReturn ? TAG : null,
    chemicalCost: round(mineChem.reduce((t, l) => t + l.amount, 0)) };
  const out = respond(`SO card ${c.cardNo}`, { soCardId: id }, [lots, path, chemicals, where, packing], { export: true });
  out.header = head;
  return out;
}

/* ---------------- 3. departments ---------------- */

/** Per department: SO cards, jobs, lots, thaans, meters in / done / in process / sent on, cost. */
async function departmentSummary(req, f) {
  const deps = await myDepartments(req);
  if (!deps.length) throw AppError.forbidden('You do not have a department');
  const ids = f.departmentId ? deps.filter((d) => d.id === f.departmentId).map((d) => d.id) : deps.map((d) => d.id);
  const jobs = await jobCards(req.user.companyId, { ...f, departmentIds: ids });
  const chem = await chemLines(req.user.companyId, {});
  const rows = deps.filter((d) => ids.includes(d.id)).map((d) => {
    const mine = jobs.filter((j) => j.departmentId === d.id && j.status !== 'REJECTED');
    const sum = (fn) => round(mine.reduce((t, j) => t + fn(j), 0));
    const lotSet = new Set(mine.flatMap((j) => j.lots));
    const jobSet = new Set(mine.map((j) => j.jobId));
    const cost = chem.filter((l) => l.departmentId === d.id && jobSet.has(l.jobId)).reduce((t, l) => t + l.amount, 0);
    return {
      department: d.name, jobs: jobSet.size, soCards: new Set(mine.map((j) => j.soCardId)).size, lots: lotSet.size, thaans: sum((j) => nz(j.thaans)), meters: sum((j) => j.meters),
      waitingMeters: sum((j) => (['IN_WAY', 'QUEUE'].includes(j.status) ? j.meters : 0)), inProcessMeters: sum((j) => (['PENDING', 'PROCESSING'].includes(j.status) ? j.meters : 0)),
      doneMeters: sum((j) => (j.status === 'COMPLETE' ? j.meters : 0)), sentOnMeters: sum((j) => j.sentOnMeters),
      leftMeters: sum((j) => j.meters - j.sentOnMeters), rejectedMeters: round(jobs.filter((j) => j.departmentId === d.id && j.status === 'REJECTED').reduce((t, j) => t + j.meters, 0)),
      chemicalCost: round(cost), costPerMeter: sum((j) => j.meters) ? round(cost / sum((j) => j.meters)) : 0,
    };
  });
  const columns = [col('department', 'Department'), col('jobs', 'Jobs', 'number'), col('soCards', 'SO cards', 'number'), col('lots', 'Lots', 'number'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters came', 'number'),
    col('waitingMeters', 'Waiting (m)', 'number'), col('inProcessMeters', 'In process (m)', 'number'), col('doneMeters', 'Complete (m)', 'number'), col('sentOnMeters', 'Sent on (m)', 'number'),
    col('leftMeters', 'Still here (m)', 'number'), col('rejectedMeters', 'Rejected (m)', 'number'), col('chemicalCost', 'Chemical cost', 'money'), col('costPerMeter', 'Cost / m', 'money')];
  return respond('Departments summary', f, [section('departments', 'Departments', columns, rows, ['jobs', 'soCards', 'lots', 'thaans', 'meters', 'waitingMeters', 'inProcessMeters', 'doneMeters', 'sentOnMeters', 'leftMeters', 'rejectedMeters', 'chemicalCost'])], f);
}

/** One department (or all): every job and SO card with lots, thaans, meters, operator and chemical cost. */
async function departmentJobs(req, f, code) {
  const deps = await myDepartments(req);
  let ids = deps.map((d) => d.id);
  if (code) {
    const d = deps.find((x) => x.code === String(code).toUpperCase());
    if (!d) throw AppError.notFound('Department');
    ids = [d.id];
  } else if (f.departmentId) ids = ids.filter((id) => id === f.departmentId);
  const jobs = await jobCards(req.user.companyId, { ...f, departmentIds: ids });
  const cost = costMap(await chemLines(req.user.companyId), (l) => `${l.jobId}:${l.soCardId}`);
  const rows = jobs.map((r) => {
    const c = nz(cost.get(`${r.jobId}:${r.soCardId}`));
    return { department: r.department, jobNo: r.jobNo, jobDate: r.jobDate, fromDepartment: r.fromDepartment || 'SO Card', soNo: r.soNo, party: r.customer, quality: r.quality, colour: r.colour,
      lots: lotsText(r.lots), thaans: nz(r.thaans), meters: round(r.meters), statusText: STATUS_TEXT[r.status], operatorName: r.operatorName, processDate: r.processDate, sentTo: r.sentTo || '',
      sentOnMeters: round(r.sentOnMeters), chemicalCost: c, costPerMeter: r.meters ? round(c / r.meters) : 0, tag: r.isGreyReturn ? TAG : (r.isRework ? 'RE-WORK' : '') };
  });
  const columns = [col('department', 'Department'), col('jobNo', 'Job#', 'number'), col('jobDate', 'Date', 'date'), col('fromDepartment', 'From'), col('soNo', 'SO#', 'number'), col('party', 'Party'),
    col('quality', 'Quality'), col('colour', 'Colour'), col('lots', 'Lot#s', 'list'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number'), col('statusText', 'Status'),
    col('operatorName', 'Operator'), col('processDate', 'Process date', 'date'), col('sentTo', 'Sent to', 'list'), col('sentOnMeters', 'Sent on (m)', 'number'),
    col('chemicalCost', 'Chemical cost', 'money'), col('costPerMeter', 'Cost / m', 'money'), col('tag', 'Tag', 'tag')];
  return respond(code ? `${code} jobs` : 'Department jobs', f, [section('jobs', 'Jobs and SO cards', columns, rows, ['thaans', 'meters', 'sentOnMeters', 'chemicalCost'])], f);
}

/** Per department and operator: jobs, SO cards, lots, thaans, meters and chemical cost they handled. */
async function operators(req, f) {
  const deps = await myDepartments(req, ['PROCESS', 'FOLDING']);
  const ids = f.departmentId ? deps.filter((d) => d.id === f.departmentId).map((d) => d.id) : deps.map((d) => d.id);
  const jobs = (await jobCards(req.user.companyId, { ...f, departmentIds: ids })).filter((j) => j.status !== 'REJECTED');
  const cost = costMap(await chemLines(req.user.companyId), (l) => `${l.jobId}:${l.soCardId}`);
  const by = new Map();
  for (const j of jobs) {
    const key = `${j.departmentId}|${(j.operatorName || '').toLowerCase()}`;
    const r = by.get(key) || { department: j.department, operator: j.operatorName || '(not entered)', jobs: new Set(), soCards: new Set(), lots: new Set(), thaans: 0, meters: 0, chemicalCost: 0, first: null, last: null };
    r.jobs.add(j.jobId); r.soCards.add(j.soCardId); j.lots.forEach((l) => r.lots.add(l));
    r.thaans += nz(j.thaans); r.meters += j.meters; r.chemicalCost += nz(cost.get(`${j.jobId}:${j.soCardId}`));
    const d = j.processDate || j.jobDate;
    if (!r.first || d < r.first) r.first = d;
    if (!r.last || d > r.last) r.last = d;
    by.set(key, r);
  }
  const rows = [...by.values()].map((r) => ({ department: r.department, operator: r.operator, jobs: r.jobs.size, soCards: r.soCards.size, lots: r.lots.size, thaans: r.thaans, meters: round(r.meters),
    chemicalCost: round(r.chemicalCost), costPerMeter: r.meters ? round(r.chemicalCost / r.meters) : 0, firstDate: r.first, lastDate: r.last }))
    .sort((a, b) => a.department.localeCompare(b.department) || b.meters - a.meters);
  const columns = [col('department', 'Department'), col('operator', 'Operator'), col('jobs', 'Jobs', 'number'), col('soCards', 'SO cards', 'number'), col('lots', 'Lots', 'number'), col('thaans', 'Thaans', 'number'),
    col('meters', 'Meters', 'number'), col('chemicalCost', 'Chemical cost', 'money'), col('costPerMeter', 'Cost / m', 'money'), col('firstDate', 'First', 'date'), col('lastDate', 'Last', 'date')];
  return respond('Operator wise work', f, [section('operators', 'Operators', columns, rows, ['jobs', 'soCards', 'lots', 'thaans', 'meters', 'chemicalCost'])], f);
}

/* ---------------- 4. chemicals ---------------- */

/**
 * Chemical cost by department, Job, SO card and chemical. groupBy: none (detail) | chemical | department | job | so_card.
 * A request for the whole job is shared between its SO cards by meters.
 */
async function chemicalUsage(req, f) {
  const deps = await myDepartments(req, ['PROCESS', 'FOLDING']);
  const isStore = req.user.userType === 'CLIENT_ADMIN' || (await userServices(req.user)).some((g) => g.service.code === 'CHEMICAL_STORE');
  if (!isStore && !deps.length) throw AppError.forbidden('You do not have access to chemical costs');
  const companyId = req.user.companyId;
  let lines = await chemLines(companyId, f);
  if (!isStore) lines = lines.filter((l) => deps.some((d) => d.id === l.departmentId));
  if (f.departmentId) lines = lines.filter((l) => l.departmentId === f.departmentId);
  if (f.itemId) lines = lines.filter((l) => l.itemId === f.itemId);
  if (f.jobNo) lines = lines.filter((l) => l.jobNo === f.jobNo);
  const cards = new Map((await q(`SELECT sc.id, sc."cardNo", sc."customerId", cu.name AS party, sc."isGreyReturn" FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" WHERE sc."companyId" = :companyId`, { companyId })).map((c) => [c.id, c]));
  const jc = new Map((await jobCards(companyId, {})).map((j) => [`${j.jobId}:${j.soCardId}`, j]));
  lines = lines.filter((l) => (!f.customerId || (cards.get(l.soCardId) || {}).customerId === f.customerId) && (!f.soNo || (cards.get(l.soCardId) || {}).cardNo === f.soNo));
  const detail = lines.map((l) => {
    const c = cards.get(l.soCardId) || {};
    const j = jc.get(`${l.jobId}:${l.soCardId}`) || { lots: [], thaans: 0, meters: 0 };
    return { date: l.sentAt, department: l.department, reqNo: l.reqNo, jobNo: l.jobNo, soNo: c.cardNo, party: c.party, lots: lotsText(j.lots), thaans: nz(j.thaans), meters: round(j.meters),
      chemical: l.chemical, unit: l.unit, qty: round(l.qty), rate: l.qty ? round(l.amount / l.qty) : 0, amount: round(l.amount), tag: c.isGreyReturn ? TAG : '' };
  }).filter((r) => r.qty !== 0 || r.amount !== 0).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!f.groupBy || f.groupBy === 'none') {
    const columns = [col('date', 'Sent', 'datetime'), col('department', 'Department'), col('reqNo', 'Req#', 'number'), col('jobNo', 'Job#', 'number'), col('soNo', 'SO#', 'number'), col('party', 'Party'),
      col('lots', 'Lot#s', 'list'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number'), col('chemical', 'Chemical'), col('qty', 'Qty', 'number'), col('unit', 'Unit'),
      col('rate', 'Rate', 'money'), col('amount', 'Amount', 'money'), col('tag', 'Tag', 'tag')];
    return respond('Chemical usage and cost', f, [section('usage', 'Usage', columns, detail, ['qty', 'amount'])], f);
  }
  const keyOf = { chemical: (r) => `${r.chemical}|${r.unit}`, department: (r) => r.department, job: (r) => `${r.department}|${r.jobNo}`, so_card: (r) => `${r.soNo}` }[f.groupBy];
  const g = new Map();
  for (const r of detail) {
    const k = keyOf(r);
    const x = g.get(k) || { department: r.department, jobNo: r.jobNo, soNo: r.soNo, party: r.party, chemical: r.chemical, unit: r.unit, qty: 0, amount: 0 };
    x.qty = round(x.qty + r.qty); x.amount = round(x.amount + r.amount); g.set(k, x);
  }
  const rows = [...g.values()].map((x) => ({ ...x, rate: x.qty ? round(x.amount / x.qty) : 0 })).sort((a, b) => b.amount - a.amount);
  const columns = { chemical: [col('chemical', 'Chemical'), col('unit', 'Unit'), col('qty', 'Qty', 'number'), col('rate', 'Avg rate', 'money'), col('amount', 'Amount', 'money')],
    department: [col('department', 'Department'), col('amount', 'Amount', 'money')], job: [col('department', 'Department'), col('jobNo', 'Job#', 'number'), col('amount', 'Amount', 'money')],
    so_card: [col('soNo', 'SO#', 'number'), col('party', 'Party'), col('amount', 'Amount', 'money')] }[f.groupBy];
  return respond(`Chemical cost by ${f.groupBy.replace('_', ' ')}`, f, [section('usage', 'Cost', columns, rows, ['qty', 'amount'].filter((k) => columns.some((c) => c.key === k)))], f);
}

/** Chemical store stock, rate by rate (batches). */
async function chemicalStock(req, f) {
  await needAnyService(req, ['CHEMICAL_STORE']);
  const store = (f.store || 'chemical').toUpperCase() === 'GENERAL' ? 'GENERAL' : 'CHEMICAL';
  const rows = await q(`SELECT i.name AS item, c.name AS category, i.unit, b."inDate", b.rate::float AS rate, b."qtyLeft"::float AS qty, b."valueLeft"::float AS value, v.name AS vendor, b.source
    FROM store_batches b JOIN store_items i ON i.id = b."itemId" LEFT JOIN store_categories c ON c.id = i."categoryId" LEFT JOIN vendors v ON v.id = b."vendorId"
    WHERE b."companyId" = :companyId AND b.store = :store AND b."qtyLeft" > 0 ${f.itemId ? 'AND b."itemId" = :itemId' : ''} ORDER BY c.name, i.name, b."inDate"`, { companyId: req.user.companyId, store, itemId: f.itemId });
  const data = rows.map((r) => ({ category: r.category, item: r.item, unit: r.unit, batchDate: r.inDate, vendor: r.vendor, source: r.source === 'OPENING' ? 'Old stock' : r.source, rate: r.rate, qty: round(r.qty), value: round(r.value) }));
  const columns = [col('category', 'Category'), col('item', 'Chemical / item'), col('unit', 'Unit'), col('batchDate', 'Batch date', 'date'), col('vendor', 'Vendor'), col('source', 'Source'),
    col('rate', 'Rate', 'money'), col('qty', 'Qty', 'number'), col('value', 'Value', 'money')];
  return respond('Store stock by rate', f, [section('stock', 'Stock', columns, data, ['qty', 'value'])], f);
}

/** Chemical / general store purchases (approved inwards). */
async function chemicalPurchases(req, f) {
  await needAnyService(req, ['CHEMICAL_STORE']);
  const store = (f.store || 'chemical').toUpperCase() === 'GENERAL' ? 'GENERAL' : 'CHEMICAL';
  const where = ['i."companyId" = :companyId', 'i.store = :store', 'i."isApproved"'];
  const rep = { companyId: req.user.companyId, store };
  if (f.dateFrom) { where.push('i."inwardDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('i."inwardDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.itemId) { where.push('l."itemId" = :itemId'); rep.itemId = f.itemId; }
  const rows = await q(`SELECT i."inwardDate", i."ipNo", i."dcNo", v.name AS vendor, it.name AS item, it.unit, l.qty::float AS qty, l.rate::float AS rate, l.amount::float AS amount
    FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" JOIN store_items it ON it.id = l."itemId" LEFT JOIN vendors v ON v.id = i."vendorId"
    WHERE ${where.join(' AND ')} ORDER BY i."inwardDate" DESC, i."ipNo" DESC`, rep);
  const columns = [col('inwardDate', 'Date', 'date'), col('ipNo', 'IP#', 'number'), col('dcNo', 'DC#'), col('vendor', 'Vendor'), col('item', 'Chemical / item'), col('unit', 'Unit'),
    col('qty', 'Qty', 'number'), col('rate', 'Rate', 'money'), col('amount', 'Amount', 'money')];
  return respond('Store purchases', f, [section('purchases', 'Purchases', columns, rows.map((r) => ({ ...r, qty: round(r.qty), amount: round(r.amount) })), ['qty', 'amount'])], f);
}

/* ---------------- 5. Folding, in-process cloth ---------------- */

/** Folding: what came, from which department, A / B / CP, what went to Packing, what is left. */
async function folding(req, f) {
  await needAnyService(req, ['FOLDING']);
  const fd = (await companyServices(req.user.companyId)).find((s) => s.kind === 'FOLDING');
  if (!fd) throw AppError.rule('NO_FOLDING', 'Your company does not have the Folding department');
  const list = await foldingService.list(req, fd.code, { tab: 'all', page: 1, limit: 100000, dateFrom: f.dateFrom, dateTo: f.dateTo });
  const from = new Map((await q(`SELECT j.id, fs.name AS name FROM jobs j LEFT JOIN services fs ON fs.id = j."fromDepartmentId" WHERE j."companyId" = :companyId AND j."departmentId" = :dep`, { companyId: req.user.companyId, dep: fd.id })).map((r) => [r.id, r.name || 'SO Card']));
  let rows = list.data.map((r) => ({
    jobNo: r.jobNo, jobDate: r.jobDate, fromDepartment: from.get(r.jobId), soNo: r.soCard.cardNo, party: r.customer.name, quality: r.quality, colour: r.colour,
    lots: r.lots.map((l) => l.lotNo).join(', '), thaans: r.lots.reduce((t, l) => t + (l.thaanCount || 0), 0), receivedMeters: r.totals.received, aMeters: r.totals.a, bMeters: r.totals.b, cpMeters: r.totals.cp,
    diff: r.totals.diff, sentToPacking: r.totals.sent, leftInFolding: r.leftInFolding, sentForRework: r.sentBackTo || '', statusText: r.isClosed ? 'Closed' : (r.leftInFolding > 0 ? 'Open' : 'Done'),
    chemicalCost: r.cost.totalCost, costPerMeter: r.cost.costPerMeter, tag: r.isGreyReturn ? TAG : (r.isRework ? 'RE-WORK' : ''), customerId: r.customer.id,
  }));
  if (f.customerId) rows = rows.filter((r) => r.customerId === f.customerId);
  if (f.status === 'open') rows = rows.filter((r) => r.leftInFolding > 0);
  const columns = [col('jobNo', 'Job#', 'number'), col('jobDate', 'Date', 'date'), col('fromDepartment', 'Came from'), col('soNo', 'SO#', 'number'), col('party', 'Party'), col('quality', 'Quality'), col('colour', 'Colour'),
    col('lots', 'Lot#s', 'list'), col('thaans', 'Thaans', 'number'), col('receivedMeters', 'Received (m)', 'number'), col('aMeters', 'A (m)', 'number'), col('bMeters', 'B (m)', 'number'), col('cpMeters', 'CP (m)', 'number'),
    col('diff', 'Gain / loss (m)', 'number'), col('sentToPacking', 'Sent to Packing (m)', 'number'), col('leftInFolding', 'Left in Folding (m)', 'number'), col('sentForRework', 'Re-work sent to'),
    col('statusText', 'Status'), col('chemicalCost', 'Cost', 'money'), col('costPerMeter', 'Cost / m', 'money'), col('tag', 'Tag', 'tag')];
  return respond('Folding report', f, [section('folding', 'Folding', columns, rows.map(({ customerId, ...r }) => r), ['thaans', 'receivedMeters', 'aMeters', 'bMeters', 'cpMeters', 'diff', 'sentToPacking', 'leftInFolding', 'chemicalCost'])], f);
}

/**
 * Cloth that is moving right now: where it is (grey store, SO card desk, each department and status) and whose it is.
 * groupBy: party_department (default) | party | department | so_card | detail
 */
async function clothInProcess(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD', 'FOLDING']);
  let now = await clothNow(req.user.companyId);
  const deps = req.user.userType === 'CLIENT_ADMIN' ? null : new Set((await myDepartments(req)).map((d) => d.id));
  if (deps) now = now.filter((n) => !n.departmentId || deps.has(n.departmentId) || n.stageKind === 'GREY_STORE' || n.stageKind === 'SO_CARD');
  if (f.customerId) now = now.filter((n) => n.customerId === f.customerId);
  if (f.departmentId) now = now.filter((n) => n.departmentId === f.departmentId);
  if (f.onlyProcess) now = now.filter((n) => n.stageKind === 'DEPARTMENT');
  const mode = f.groupBy || 'party_department';
  const keyOf = { party_department: (n) => `${n.customerId}|${n.stage}|${n.statusText}`, party: (n) => n.customerId, department: (n) => `${n.stage}|${n.statusText}`,
    so_card: (n) => `${n.soNo}|${n.stage}|${n.statusText}`, detail: (n) => `${n.soNo}|${n.lotId}|${n.stage}|${n.statusText}|${n.jobId}` }[mode];
  const g = new Map();
  for (const n of now) {
    const k = keyOf(n);
    const r = g.get(k) || { party: n.customerName, stage: n.stage, statusText: n.statusText, soCards: new Set(), lots: new Set(), jobs: new Set(), thaans: 0, meters: 0, tag: false };
    if (n.soNo) r.soCards.add(n.soNo);
    r.lots.add(n.lotNo); if (n.jobNo) r.jobs.add(n.jobNo);
    r.thaans += nz(n.thaans); r.meters += n.meters; r.tag = r.tag || n.isGreyReturn;
    g.set(k, r);
  }
  const rows = [...g.values()].map((r) => ({ party: r.party, place: r.stage, statusText: r.statusText, soCards: [...r.soCards].sort((a, b) => a - b).join(', '), lots: [...r.lots].sort((a, b) => a - b).join(', '),
    jobs: [...r.jobs].sort((a, b) => a - b).join(', '), thaans: r.thaans, meters: round(r.meters), tag: r.tag ? TAG : '' })).sort((a, b) => a.party.localeCompare(b.party) || a.place.localeCompare(b.place));
  const columns = [col('party', 'Party'), col('place', 'Where'), col('statusText', 'Status'), col('soCards', 'SO#s', 'list'), col('lots', 'Lot#s', 'list'), col('jobs', 'Job#s', 'list'),
    col('thaans', 'Thaans (whole lots only)', 'number'), col('meters', 'Meters', 'number'), col('tag', 'Tag', 'tag')];
  return respond('Cloth now: where every party\'s cloth is', f, [section('now', 'Cloth now', columns, rows, ['thaans', 'meters'])], f);
}

/* ---------------- 6. packing ---------------- */

/** Packing lists with thaans, A / B / CP meters, rates, amount and gate pass. view=lines gives thaan wise rows. */
async function packingLists(req, f) {
  await needAnyService(req, ['PACKING']);
  const companyId = req.user.companyId;
  const where = ['p."companyId" = :companyId'];
  const rep = { companyId };
  if (f.dateFrom) { where.push('p."listDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('p."listDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.customerId) { where.push('sc."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.soNo) { where.push('sc."cardNo" = :soNo'); rep.soNo = f.soNo; }
  if (f.status) { where.push('p.status = :status'); rep.status = f.status; }
  const head = `FROM packing_lists p JOIN so_cards sc ON sc.id = p."soCardId" JOIN customers cu ON cu.id = sc."customerId" LEFT JOIN gate_passes g ON g."packingListId" = p.id`;
  if (f.view === 'lines') {
    const rows = await q(`SELECT p."listNo", p."listDate", sc."cardNo" AS "soNo", cu.name AS party, gl."lotNo", l."thaanNo", l.grade, l.meters::float AS meters,
        (CASE l.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END)::float AS rate, sc."isGreyReturn"
      ${head} JOIN packing_list_lines l ON l."packingListId" = p.id JOIN grey_lots gl ON gl.id = l."greyLotId" WHERE ${where.join(' AND ')} ORDER BY p."listNo" DESC, gl."lotNo", l."thaanNo", l.grade`, rep);
    const columns = [col('listNo', 'List#', 'number'), col('listDate', 'Date', 'date'), col('soNo', 'SO#', 'number'), col('party', 'Party'), col('lotNo', 'Lot#', 'number'), col('thaanNo', 'Thaan#', 'number'),
      col('grade', 'Category'), col('meters', 'Meters', 'number'), col('rate', 'Rate', 'money'), col('amount', 'Amount', 'money'), col('tag', 'Tag', 'tag')];
    return respond('Packing lists: thaan wise', f, [section('lines', 'Thaans', columns, rows.map((r) => ({ ...r, grade: r.grade === 'CP' ? 'Cut Piece' : r.grade, meters: round(r.meters), amount: round(r.meters * r.rate), tag: r.isGreyReturn ? TAG : '' })), ['meters', 'amount'])], f);
  }
  const rows = await q(`SELECT p."listNo", p."listDate", p.status, sc."cardNo" AS "soNo", cu.name AS party, sc."isGreyReturn", p."rateA"::float AS "rateA", p."rateB"::float AS "rateB", p."rateCP"::float AS "rateCP",
      g."gatePassNo", g."driverName", g."vehicleNo", g.destination,
      (SELECT qu.name FROM qualities qu WHERE qu.id = sc."qualityId") AS quality,
      COALESCE((SELECT SUM(l.meters) FILTER (WHERE l.grade = 'A') FROM packing_list_lines l WHERE l."packingListId" = p.id), 0)::float AS "aMeters",
      COALESCE((SELECT SUM(l.meters) FILTER (WHERE l.grade = 'B') FROM packing_list_lines l WHERE l."packingListId" = p.id), 0)::float AS "bMeters",
      COALESCE((SELECT SUM(l.meters) FILTER (WHERE l.grade = 'CP') FROM packing_list_lines l WHERE l."packingListId" = p.id), 0)::float AS "cpMeters",
      (SELECT count(DISTINCT (l."greyLotId", COALESCE(l."thaanId"::text, l.id::text))) FROM packing_list_lines l WHERE l."packingListId" = p.id)::int AS thaans,
      (SELECT string_agg(DISTINCT gl."lotNo"::text, ', ') FROM packing_list_lines l JOIN grey_lots gl ON gl.id = l."greyLotId" WHERE l."packingListId" = p.id) AS lots
    ${head} WHERE ${where.join(' AND ')} ORDER BY p."listNo" DESC`, rep);
  const data = rows.map((r) => ({ listNo: r.listNo, listDate: r.listDate, statusText: r.status === 'FINAL' ? 'Final' : 'Draft', soNo: r.soNo, party: r.party, quality: r.quality, lots: r.lots, thaans: r.thaans,
    aMeters: round(r.aMeters), bMeters: round(r.bMeters), cpMeters: round(r.cpMeters), meters: round(r.aMeters + r.bMeters + r.cpMeters), amount: round(r.aMeters * r.rateA + r.bMeters * r.rateB + r.cpMeters * r.rateCP),
    gatePassNo: r.gatePassNo, vehicleNo: r.vehicleNo, tag: r.isGreyReturn ? TAG : '' }));
  const columns = [col('listNo', 'List#', 'number'), col('listDate', 'Date', 'date'), col('statusText', 'Status'), col('soNo', 'SO#', 'number'), col('party', 'Party'), col('quality', 'Quality'), col('lots', 'Lot#s', 'list'),
    col('thaans', 'Thaans', 'number'), col('aMeters', 'A (m)', 'number'), col('bMeters', 'B (m)', 'number'), col('cpMeters', 'CP (m)', 'number'), col('meters', 'Total (m)', 'number'), col('amount', 'Amount', 'money'),
    col('gatePassNo', 'Gate pass#', 'number'), col('vehicleNo', 'Vehicle'), col('tag', 'Tag', 'tag')];
  return respond('Packing lists', f, [section('lists', 'Packing lists', columns, data, ['thaans', 'aMeters', 'bMeters', 'cpMeters', 'meters', 'amount'])], f);
}

/** Gate passes: driver, vehicle, destination, lots and thaan numbers. */
async function gatePasses(req, f) {
  await needAnyService(req, ['PACKING']);
  const pk = (await companyServices(req.user.companyId)).find((s) => s.kind === 'PACKING');
  if (!pk) throw AppError.rule('NO_PACKING', 'Your company does not have the Packing department');
  const list = await packingService.listGatePasses(req, pk.code, { page: 1, limit: 100000, dateFrom: f.dateFrom, dateTo: f.dateTo, search: f.search });
  let rows = list.data.map((g) => ({ gatePassNo: g.gatePassNo, passDate: g.passDate, listNo: g.packingList.listNo, soNo: g.soCard.cardNo, party: g.customer.name, quality: g.quality,
    lots: g.lots.map((l) => `Lot ${l.lotNo}: ${l.thaanNos.join(', ')}`).join(' | '), thaans: g.totalThaans, operatorName: g.operatorName, driverName: g.driverName, vehicleNo: g.vehicleNo,
    destination: g.destination, tag: g.isGreyReturn ? TAG : '', customerId: g.customer.id }));
  if (f.customerId) rows = rows.filter((r) => r.customerId === f.customerId);
  const columns = [col('gatePassNo', 'Gate pass#', 'number'), col('passDate', 'Date', 'date'), col('listNo', 'List#', 'number'), col('soNo', 'SO#', 'number'), col('party', 'Party'), col('lots', 'Lots and thaans', 'list'),
    col('thaans', 'Thaans', 'number'), col('operatorName', 'Operator'), col('driverName', 'Driver'), col('vehicleNo', 'Vehicle'), col('destination', 'Going to'), col('tag', 'Tag', 'tag')];
  return respond('Gate passes', f, [section('passes', 'Gate passes', columns, rows.map(({ customerId, ...r }) => r), ['thaans'])], f);
}

module.exports = { greyParties, greyLots, soCards, soCardMovement, soCardDetail, departmentSummary, departmentJobs, operators, chemicalUsage, chemicalStock, chemicalPurchases, folding, clothInProcess, packingLists, gatePasses };
