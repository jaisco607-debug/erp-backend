// Yarn requests: a department asks the Yarn Store for yarn for one of its Jobs (optionally one SO card of it) — the same flow as a chemical request.
//   department      store            status
//   Pending         Queue            PENDING     the department sent it; it can still edit or cancel it
//   Accepted        Process          ACCEPTED    the store accepted it (or REJECTED with a reason)
//   In-Way          In-Way           IN_WAY      the store sent it: the yarn goes out of the stock now
//   Received        Delivered        DELIVERED   the department marked it received
// The department types what it needs (yarn name, brand, bags). The store assigns the bags from its approved yarn inwards (oldest first, or the entries it picks) and may send less than asked,
// never more. Sending makes a Yarn Outward to the department AND the use of that yarn on the request's Job / SO card in one go, so the store stock, the outward record and ledger,
// and the yarn cost of the Job / SO card (next to the chemical cost) all follow from it. Only departments the client admin switched on (Settings > Departments) can ask for yarn.
const { QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today, dayStart, dayEnd } = require('../utils/dates');
const { round: r2 } = require('../utils/money');
const { soLabel } = require('../utils/soLabel');
const audit = require('./auditService');
const counters = require('./counterService');
const { companyServices } = require('./accessService');
const settings = require('./departmentSettingsService');
const deptYarn = require('./departmentYarnService');
const outwards = require('./storeYarnOutwardService');

const NO = 'yarn_request_no';
const JOB_OK = ['PROCESSING', 'COMPLETE'];
const DEPT_TEXT = { PENDING: 'Pending', ACCEPTED: 'Accepted', IN_WAY: 'In-Way', DELIVERED: 'Received', CANCELLED: 'Cancelled', REJECTED: 'Rejected' };
const STORE_TEXT = { PENDING: 'Queue', ACCEPTED: 'Process', IN_WAY: 'In-Way', DELIVERED: 'Delivered', CANCELLED: 'Cancelled', REJECTED: 'Rejected' };
const DEPT_TABS = { pending: ['PENDING'], accepted: ['ACCEPTED'], in_way: ['IN_WAY'], received: ['DELIVERED'], closed: ['CANCELLED', 'REJECTED'] };
const STORE_TABS = { queue: ['PENDING'], process: ['ACCEPTED'], in_way: ['IN_WAY'], delivered: ['DELIVERED'], closed: ['CANCELLED', 'REJECTED'] };
const label = (n) => String(n).padStart(5, '0');
const squeeze = (s) => (s == null ? s : String(s).replace(/\s+/g, ' ').trim());
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const titleOf = (name, brand) => (brand ? `${name} - ${brand}` : name);
const same = (a, b) => `${String(a).toLowerCase()}|${String(b || '').toLowerCase()}`;

const HEAD_SQL = `SELECT r.id, r."reqNo", r.status, r."departmentId", s.code AS "departmentCode", svc_name(s.id, r."companyId", s.name) AS "departmentName", r."jobId", j."jobNo", j.status AS "jobStatus",
    r."soCardId", sc."cardNo", sc."isGreyReturn", r.notes, r."rejectReason", r."sentThrough", r."totalBags", r."sentBags", r."totalValue"::float AS "totalValue", r."outwardId", o."outwardNo", r."usageId",
    r."requestedAt", r."acceptedAt", r."sentAt", r."receivedAt", r."closedAt", ru.name AS "requestedBy", au.name AS "acceptedBy", su.name AS "sentBy", rcu.name AS "receivedBy"
  FROM yarn_requests r JOIN services s ON s.id = r."departmentId" JOIN jobs j ON j.id = r."jobId" LEFT JOIN so_cards sc ON sc.id = r."soCardId" LEFT JOIN store_yarn_outwards o ON o.id = r."outwardId"
  LEFT JOIN users ru ON ru.id = r."requestedById" LEFT JOIN users au ON au.id = r."acceptedById" LEFT JOIN users su ON su.id = r."sentById" LEFT JOIN users rcu ON rcu.id = r."receivedById"`;

const person = (name) => (name ? { name } : null);

/** Requests with their lines (what was asked and what the store assigned) and the SO cards of their jobs. */
async function build(rows, transaction) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lines = await q('SELECT id, "requestId", "lineNo", "yarnName", brand, bags, "sentBags", value::float AS value FROM yarn_request_lines WHERE "requestId" IN (:ids) ORDER BY "lineNo"', { ids }, transaction);
  const allocs = lines.length ? await q(`SELECT a."lineId", a."inwardId", i."inwardNo", i."yarnName", i.brand, a.bags, a."lbsPerBag"::float AS "lbsPerBag", a."ratePerLb"::float AS "ratePerLb", a.value::float AS value
    FROM yarn_request_allocations a JOIN store_yarn_inwards i ON i.id = a."inwardId" WHERE a."lineId" IN (:ids) ORDER BY i."inwardNo"`, { ids: lines.map((l) => l.id) }, transaction) : [];
  const cards = await q(`SELECT DISTINCT r.id AS "requestId", sc.id, sc."cardNo", sc."isGreyReturn", c.name AS customer FROM yarn_requests r JOIN job_items ji ON ji."jobId" = r."jobId"
    JOIN so_cards sc ON sc.id = ji."soCardId" LEFT JOIN customers c ON c.id = sc."customerId" WHERE r.id IN (:ids)`, { ids }, transaction);
  return rows.map((r) => ({
    id: r.id, reqNo: r.reqNo, reqText: label(r.reqNo), status: r.status, departmentStatusText: DEPT_TEXT[r.status], storeStatusText: STORE_TEXT[r.status],
    department: { id: r.departmentId, code: r.departmentCode, name: r.departmentName },
    job: { id: r.jobId, jobNo: r.jobNo, status: r.jobStatus },
    // the SO card the yarn is for; empty = the whole job (the cost is shared between its SO cards by meters)
    soCard: r.soCardId ? { id: r.soCardId, cardNo: r.cardNo, cardLabel: soLabel(r.cardNo, r.isGreyReturn) } : null,
    soCards: cards.filter((c) => c.requestId === r.id).sort((a, b) => a.cardNo - b.cardNo).map((c) => ({ id: c.id, cardNo: c.cardNo, cardLabel: soLabel(c.cardNo, c.isGreyReturn), customer: c.customer })),
    notes: r.notes, rejectReason: r.rejectReason, sentThrough: r.sentThrough,
    totalBags: r.totalBags, sentBags: r.sentBags, totalValue: r.totalValue,
    outward: r.outwardId ? { id: r.outwardId, outwardNo: r.outwardNo, outwardText: label(r.outwardNo) } : null, usageId: r.usageId,
    requestedBy: person(r.requestedBy), requestedAt: r.requestedAt, acceptedBy: person(r.acceptedBy), acceptedAt: r.acceptedAt, sentBy: person(r.sentBy), sentAt: r.sentAt, receivedBy: person(r.receivedBy), receivedAt: r.receivedAt, closedAt: r.closedAt,
    lines: lines.filter((l) => l.requestId === r.id).map((l) => ({
      id: l.id, lineNo: l.lineNo, yarnName: l.yarnName, brand: l.brand, title: titleOf(l.yarnName, l.brand), bags: l.bags, sentBags: l.sentBags, value: l.value,
      assigned: allocs.filter((a) => a.lineId === l.id).map((a) => ({ inwardId: a.inwardId, inwardNo: a.inwardNo, inwardText: label(a.inwardNo), title: titleOf(a.yarnName, a.brand), bags: a.bags, lbsPerBag: a.lbsPerBag, lbs: r2(a.bags * a.lbsPerBag), ratePerLb: a.ratePerLb, value: a.value })),
    })),
  }));
}

async function loadOne(id, transaction) {
  const rows = await q(`${HEAD_SQL} WHERE r.id = :id`, { id }, transaction);
  return (await build(rows, transaction))[0];
}

/** The approved, switched-on yarn inward entries of a yarn (name, and brand when given), oldest first. */
async function stockOf(companyId, yarnName, brand, transaction, lock = false) {
  return q(`SELECT i.id, i."inwardNo", i."yarnName", i.brand, i.bags, i."outwardBags", i."lbsPerBag"::float AS "lbsPerBag", i."ratePerLb"::float AS "ratePerLb", to_char(i."inwardDate", 'YYYY-MM-DD') AS "inwardDate", v.name AS "vendorName"
    FROM store_yarn_inwards i JOIN vendors v ON v.id = i."vendorId" WHERE i."companyId" = :companyId AND i."deletedAt" IS NULL AND i."isApproved" AND i."isActive" AND i.bags > i."outwardBags"
      AND lower(i."yarnName") = lower(:yarnName) ${brand ? 'AND lower(COALESCE(i.brand, \'\')) = lower(:brand)' : ''} ORDER BY i."inwardDate", i."inwardNo"${lock ? ' FOR UPDATE OF i' : ''}`, { companyId, yarnName, brand }, transaction);
}

/* ---------------- access ---------------- */

/** The department by code, the person's access, and the client admin's yarn switch. */
async function needDept(req, code, want, transaction) {
  const d = await deptYarn.dept(req, code, want, transaction);
  if (!(await settings.yarnEnabled(req.user.companyId, d.id, transaction))) throw new AppError(403, 'YARN_NOT_ALLOWED', `${d.name} has no yarn request access`);
  return d;
}

async function findOr404(req, id, where, transaction) {
  const parts = ['r.id = :id', 'r."companyId" = :cid'];
  const rep = { id, cid: req.user.companyId };
  if (where.departmentId) { parts.push('r."departmentId" = :did'); rep.did = where.departmentId; }
  const [r] = await q(`SELECT r.* FROM yarn_requests r WHERE ${parts.join(' AND ')}${transaction ? ' FOR UPDATE' : ''}`, rep, transaction);
  if (!r) throw AppError.notFound('Yarn request');
  return r;
}

/** Checks the job / SO card / yarn lines and returns what to save. */
async function prepare(req, d, { jobId, soCardId, lines }, transaction) {
  const out = {};
  if (jobId !== undefined) {
    const [job] = await q('SELECT id, "departmentId", status FROM jobs WHERE id = :id AND "companyId" = :cid', { id: jobId, cid: req.user.companyId }, transaction);
    if (!job || job.departmentId !== d.id) throw AppError.rule('UNKNOWN_JOB', 'This job is not in your department');
    if (!JOB_OK.includes(job.status)) throw AppError.rule('JOB_NOT_ACCEPTED', 'Accept the job (Processing) before asking for yarn');
    out.jobId = job.id;
  }
  if (soCardId !== undefined) out.soCardId = soCardId || null;
  if (lines) {
    const seen = new Set();
    out.lines = lines.map((l, i) => {
      const yarnName = squeeze(l.yarnName);
      const brand = squeeze(l.brand) || null;
      if (!yarnName) throw AppError.rule('YARN_REQUIRED', 'Type the yarn you need');
      const key = same(yarnName, brand);
      if (seen.has(key)) throw AppError.rule('DUPLICATE_YARN', `${titleOf(yarnName, brand)} is twice in the list; put it once`);
      seen.add(key);
      return { id: crypto.randomUUID(), lineNo: i + 1, yarnName, brand, bags: l.bags };
    });
  }
  return out;
}

async function checkCard(jobId, soCardId, transaction) {
  if (!soCardId) return;
  const [x] = await q('SELECT 1 AS ok FROM job_items WHERE "jobId" = :jobId AND "soCardId" = :soCardId LIMIT 1', { jobId, soCardId }, transaction);
  if (!x) throw AppError.rule('SO_NOT_IN_JOB', 'This SO card is not in this job');
}

async function writeLines(requestId, lines, transaction) {
  await sequelize.query('DELETE FROM yarn_request_lines WHERE "requestId" = :requestId', { replacements: { requestId }, transaction });
  for (const l of lines) {
    await sequelize.query('INSERT INTO yarn_request_lines (id, "requestId", "lineNo", "yarnName", brand, bags) VALUES (:id, :requestId, :lineNo, :yarnName, :brand, :bags)', { replacements: { ...l, requestId }, transaction });
  }
  await sequelize.query('UPDATE yarn_requests SET "totalBags" = :bags, "updatedAt" = now() WHERE id = :requestId', { replacements: { requestId, bags: lines.reduce((t, l) => t + l.bags, 0) }, transaction });
}

/* ---------------- lists ---------------- */

function listParts(req, f, base, tabs) {
  const parts = ['r."companyId" = :cid'];
  const rep = { cid: req.user.companyId };
  if (base.departmentId) { parts.push('r."departmentId" = :did'); rep.did = base.departmentId; }
  if (f.tab && f.tab !== 'all') { parts.push('r.status IN (:sts)'); rep.sts = tabs[f.tab]; }
  if (f.reqNo) { parts.push('r."reqNo" = :reqNo'); rep.reqNo = f.reqNo; }
  if (f.jobNo) { parts.push('j."jobNo" = :jobNo'); rep.jobNo = f.jobNo; }
  if (f.soNo) { parts.push('EXISTS (SELECT 1 FROM job_items ji JOIN so_cards c ON c.id = ji."soCardId" WHERE ji."jobId" = r."jobId" AND c."cardNo" = :soNo)'); rep.soNo = f.soNo; }
  if (f.dateFrom) { parts.push('r."requestedAt" >= :from'); rep.from = dayStart(f.dateFrom); }
  if (f.dateTo) { parts.push('r."requestedAt" <= :to'); rep.to = dayEnd(f.dateTo); }
  return { where: parts.join(' AND '), rep };
}

async function page(req, f, base, tabs) {
  const { where, rep } = listParts(req, f, base, tabs);
  const rows = await q(`${HEAD_SQL} WHERE ${where} ORDER BY r."requestedAt" DESC, r."reqNo" DESC LIMIT :limit OFFSET :offset`, { ...rep, limit: f.limit, offset: (f.page - 1) * f.limit });
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM yarn_requests r JOIN jobs j ON j.id = r."jobId" WHERE ${where}`, rep);
  const cw = ['r."companyId" = :cid'];
  const crep = { cid: req.user.companyId };
  if (base.departmentId) { cw.push('r."departmentId" = :did'); crep.did = base.departmentId; }
  const by = Object.fromEntries((await q(`SELECT status, count(*)::int AS n FROM yarn_requests r WHERE ${cw.join(' AND ')} GROUP BY status`, crep)).map((x) => [x.status, x.n]));
  const counts = Object.fromEntries(Object.entries(tabs).map(([tab, sts]) => [tab, sts.reduce((t, s) => t + (by[s] || 0), 0)]));
  return { data: await build(rows), total: n, page: f.page, limit: f.limit, counts };
}

/* ---------------- department side ---------------- */

/** What the request form needs: the department's accepted jobs (with SO cards) and the yarn the store has (names to pick from; anything else can be typed). */
async function formData(req, code) {
  const d = await needDept(req, code, 'VIEW');
  const companyId = req.user.companyId;
  const jobs = await q(`SELECT j.id, j."jobNo", j.status, to_char(j."jobDate", 'YYYY-MM-DD') AS "jobDate", j."totalMeters"::float AS "totalMeters",
      (SELECT json_agg(x ORDER BY x."cardNo") FROM (SELECT sc.id, sc."cardNo", sc."isGreyReturn", min(c.name) AS customer, SUM(ji.meters)::float AS meters FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId"
         LEFT JOIN customers c ON c.id = sc."customerId" WHERE ji."jobId" = j.id GROUP BY sc.id, sc."cardNo", sc."isGreyReturn") x) AS cards
    FROM jobs j WHERE j."companyId" = :companyId AND j."departmentId" = :did AND j.status IN (:ok) ORDER BY j."jobNo" DESC LIMIT 300`, { companyId, did: d.id, ok: JOB_OK });
  const yarn = await q(`SELECT min(i."yarnName") AS "yarnName", min(i.brand) AS brand, SUM(i.bags - i."outwardBags")::int AS "availableBags" FROM store_yarn_inwards i
    WHERE i."companyId" = :companyId AND i."deletedAt" IS NULL AND i."isApproved" AND i."isActive" AND i.bags > i."outwardBags" GROUP BY lower(i."yarnName"), lower(COALESCE(i.brand, '')) ORDER BY min(i."yarnName"), min(i.brand)`, { companyId });
  const [next] = await q('SELECT MAX("reqNo") AS m FROM yarn_requests WHERE "companyId" = :companyId', { companyId });
  return {
    department: { id: d.id, code: d.code, name: d.name }, nextReqNo: await counters.peek(companyId, NO, async () => (next.m || 0) + 1),
    jobs: jobs.map((j) => ({ id: j.id, jobNo: j.jobNo, jobDate: j.jobDate, status: j.status, totalMeters: j.totalMeters, soCards: (j.cards || []).map((c) => ({ id: c.id, cardNo: c.cardNo, cardLabel: soLabel(c.cardNo, c.isGreyReturn), customer: c.customer, meters: c.meters })) })),
    yarn: yarn.map((y) => ({ yarnName: y.yarnName, brand: y.brand, title: titleOf(y.yarnName, y.brand), availableBags: y.availableBags, inStock: y.availableBags > 0 })),
  };
}

async function deptList(req, code, f) {
  const d = await needDept(req, code, 'VIEW');
  return page(req, f, { departmentId: d.id }, DEPT_TABS);
}

async function deptGet(req, code, id) {
  const d = await needDept(req, code, 'VIEW');
  await findOr404(req, id, { departmentId: d.id });
  return loadOne(id);
}

async function create(req, code, data) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const out = await prepare(req, d, data, transaction);
    await checkCard(out.jobId, out.soCardId, transaction);
    const companyId = req.user.companyId;
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`yarn-request-no:${companyId}`], transaction });
    const reqNo = await counters.take(companyId, NO, async () => ((await q('SELECT MAX("reqNo") AS m FROM yarn_requests WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1, transaction);
    const id = crypto.randomUUID();
    await sequelize.query(`INSERT INTO yarn_requests (id, "companyId", "reqNo", "departmentId", "jobId", "soCardId", notes, "requestedById") VALUES (:id, :companyId, :reqNo, :did, :jobId, :soCardId, :notes, :userId)`,
      { replacements: { id, companyId, reqNo, did: d.id, jobId: out.jobId, soCardId: out.soCardId || null, notes: data.notes || null, userId: req.user.id }, transaction });
    await writeLines(id, out.lines, transaction);
    const after = await loadOne(id, transaction);
    await audit.log(req, { action: 'YARN_REQUEST_CREATED', entityType: 'YarnRequest', entityId: id, after }, { transaction });
    return after;
  });
}

/** Edit while still Pending (not accepted by the store yet). */
async function update(req, code, id, data) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const r = await findOr404(req, id, { departmentId: d.id }, transaction);
    if (r.status !== 'PENDING') throw AppError.rule('NOT_PENDING', 'The store has already taken this request; it cannot be changed');
    const before = await loadOne(id, transaction);
    const out = await prepare(req, d, data, transaction);
    const jobId = out.jobId || r.jobId;
    const soCardId = out.soCardId !== undefined ? out.soCardId : (out.jobId ? null : r.soCardId);
    await checkCard(jobId, soCardId, transaction);
    await sequelize.query('UPDATE yarn_requests SET "jobId" = :jobId, "soCardId" = :soCardId, notes = :notes, "updatedAt" = now() WHERE id = :id',
      { replacements: { id, jobId, soCardId, notes: data.notes !== undefined ? (data.notes || null) : r.notes }, transaction });
    if (out.lines) await writeLines(id, out.lines, transaction);
    const after = await loadOne(id, transaction);
    await audit.log(req, { action: 'YARN_REQUEST_UPDATED', entityType: 'YarnRequest', entityId: id, before, after }, { transaction });
    return after;
  });
}

async function closeAs(req, r, status, reason, transaction) {
  await sequelize.query('UPDATE yarn_requests SET status = :status, "closedById" = :userId, "closedAt" = now(), "rejectReason" = :reason, "updatedAt" = now() WHERE id = :id',
    { replacements: { id: r.id, status, userId: req.user.id, reason: reason || null }, transaction });
  const after = await loadOne(r.id, transaction);
  await audit.log(req, { action: `YARN_REQUEST_${status}`, entityType: 'YarnRequest', entityId: r.id, before: { status: r.status }, after }, { transaction });
  return after;
}

async function cancel(req, code, id) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const r = await findOr404(req, id, { departmentId: d.id }, transaction);
    if (r.status !== 'PENDING') throw AppError.rule('NOT_PENDING', 'The store has already taken this request; ask the store');
    return closeAs(req, r, 'CANCELLED', null, transaction);
  });
}

async function receive(req, code, id) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const r = await findOr404(req, id, { departmentId: d.id }, transaction);
    if (r.status !== 'IN_WAY') throw AppError.rule('NOT_IN_WAY', 'Only a request on its way can be marked received');
    await sequelize.query('UPDATE yarn_requests SET status = \'DELIVERED\', "receivedById" = :userId, "receivedAt" = now(), "updatedAt" = now() WHERE id = :id', { replacements: { id, userId: req.user.id }, transaction });
    const after = await loadOne(id, transaction);
    await audit.log(req, { action: 'YARN_REQUEST_RECEIVED', entityType: 'YarnRequest', entityId: id, after }, { transaction });
    return after;
  });
}

/* ---------------- yarn store side ---------------- */

async function storeList(req, f) {
  return page(req, f, { departmentId: f.departmentId }, STORE_TABS);
}

/** One request; while it is open each line also shows the yarn the store has for it (what it can assign). */
async function storeGet(req, id) {
  await findOr404(req, id, {});
  const r = await loadOne(id);
  if (['PENDING', 'ACCEPTED'].includes(r.status)) {
    for (const l of r.lines) {
      const have = await stockOf(req.user.companyId, l.yarnName, l.brand);
      l.availableBags = have.reduce((t, x) => t + (x.bags - x.outwardBags), 0);
      l.stock = have.map((x) => ({ inwardId: x.id, inwardNo: x.inwardNo, inwardText: label(x.inwardNo), inwardDate: x.inwardDate, title: titleOf(x.yarnName, x.brand), vendorName: x.vendorName, balanceBags: x.bags - x.outwardBags, lbsPerBag: x.lbsPerBag, ratePerLb: x.ratePerLb }));
    }
  }
  return r;
}

async function accept(req, id) {
  return sequelize.transaction(async (transaction) => {
    const r = await findOr404(req, id, {}, transaction);
    if (r.status !== 'PENDING') throw AppError.rule('NOT_IN_QUEUE', 'Only a request in the Queue can be accepted');
    await sequelize.query('UPDATE yarn_requests SET status = \'ACCEPTED\', "acceptedById" = :userId, "acceptedAt" = now(), "updatedAt" = now() WHERE id = :id', { replacements: { id, userId: req.user.id }, transaction });
    const after = await loadOne(id, transaction);
    await audit.log(req, { action: 'YARN_REQUEST_ACCEPTED', entityType: 'YarnRequest', entityId: id, after }, { transaction });
    return after;
  });
}

async function reject(req, id, { reason }) {
  return sequelize.transaction(async (transaction) => {
    const r = await findOr404(req, id, {}, transaction);
    if (!['PENDING', 'ACCEPTED'].includes(r.status)) throw AppError.rule('ALREADY_SENT', 'A sent request cannot be rejected');
    return closeAs(req, r, 'REJECTED', reason, transaction);
  });
}

/**
 * The store sends the yarn. Each line may be sent in a different number of bags (0 = not sent), never more than asked.
 *   lines: [{ lineId, bags }]                         bags from the oldest approved inwards of that yarn (default: all that was asked)
 *   lines: [{ lineId, allocations: [{ inwardId, bags }] }]   the store picks the inward entries (bags = their sum)
 * The yarn goes out of the stock now (a Yarn Outward to the department); its value (bags x lbs per bag x the rate of the entry) is the yarn cost of the Job / SO card.
 */
async function send(req, id, { lines = [], sentThrough }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const r = await findOr404(req, id, {}, transaction);
    if (r.status === 'PENDING') throw AppError.rule('NOT_ACCEPTED', 'Accept the request first');
    if (r.status !== 'ACCEPTED') throw AppError.rule('ALREADY_SENT', 'This request is not in Process');
    const rows = await q('SELECT id, "lineNo", "yarnName", brand, bags FROM yarn_request_lines WHERE "requestId" = :id ORDER BY "lineNo"', { id }, transaction);
    const change = new Map(lines.map((l) => [l.lineId, l]));
    for (const lid of change.keys()) if (!rows.some((l) => l.id === lid)) throw AppError.rule('UNKNOWN_LINE', 'A line is not in this request');

    const left = new Map(); // inwardId -> bags still free while this request is being worked out
    const entry = new Map();
    const plan = [];
    const short = [];
    const over = [];
    for (const l of rows) {
      const c = change.get(l.id);
      const have = await stockOf(companyId, l.yarnName, l.brand, transaction, true);
      for (const x of have) { entry.set(x.id, x); if (!left.has(x.id)) left.set(x.id, x.bags - x.outwardBags); }
      let picks = [];
      if (c && c.allocations && c.allocations.length) {
        for (const a of c.allocations) {
          if (!entry.has(a.inwardId)) {
            const [x] = await q(`SELECT i.id, i."inwardNo", i."yarnName", i.brand, i.bags, i."outwardBags", i."lbsPerBag"::float AS "lbsPerBag", i."ratePerLb"::float AS "ratePerLb" FROM store_yarn_inwards i
              WHERE i.id = :id AND i."companyId" = :companyId AND i."deletedAt" IS NULL AND i."isApproved" AND i."isActive" FOR UPDATE`, { id: a.inwardId, companyId }, transaction);
            if (!x) throw AppError.rule('UNKNOWN_INWARD', 'This yarn inward is not in the stock');
            entry.set(x.id, x); left.set(x.id, x.bags - x.outwardBags);
          }
          picks.push({ inwardId: a.inwardId, bags: a.bags });
        }
      } else {
        const want = c && c.bags !== undefined ? c.bags : l.bags;
        let need = want;
        for (const x of have) {
          if (need <= 0) break;
          const take = Math.min(need, left.get(x.id));
          if (take > 0) picks.push({ inwardId: x.id, bags: take });
          need -= take;
        }
        if (need > 0) short.push({ lineId: l.id, yarn: titleOf(l.yarnName, l.brand), asked: want, available: want - need });
      }
      const sum = picks.reduce((t, p) => t + p.bags, 0);
      if (sum > l.bags) over.push({ lineId: l.id, yarn: titleOf(l.yarnName, l.brand), asked: l.bags, sending: sum });
      for (const p of picks) {
        if (p.bags > left.get(p.inwardId)) short.push({ lineId: l.id, yarn: titleOf(l.yarnName, l.brand), asked: p.bags, available: left.get(p.inwardId) });
        left.set(p.inwardId, left.get(p.inwardId) - p.bags);
      }
      plan.push({ line: l, picks: picks.filter((p) => p.bags > 0) });
    }
    if (short.length) throw AppError.rule('NOT_ENOUGH_STOCK', `Not enough ${short[0].yarn}: ${short[0].available} bags in stock, ${short[0].asked} asked`, { lines: short });
    if (over.length) throw AppError.rule('MORE_THAN_REQUESTED', `${over[0].yarn}: ${over[0].sending} bags is more than the ${over[0].asked} asked for`, { lines: over });
    const total = plan.reduce((t, p) => t + p.picks.reduce((s, x) => s + x.bags, 0), 0);
    if (!total) throw AppError.rule('NOTHING_TO_SEND', 'Send at least one bag');

    // one outward per request: the same inward entry of two lines is one outward line
    const merged = new Map();
    for (const p of plan) for (const x of p.picks) merged.set(x.inwardId, (merged.get(x.inwardId) || 0) + x.bags);
    const out = await outwards.createCore(req, {
      outwardDate: today(), departmentId: r.departmentId, sentThrough: sentThrough || null, remarks: `Yarn request ${label(r.reqNo)}`, requestId: id,
      lines: [...merged].map(([inwardId, bags]) => ({ inwardId, bags })),
    }, transaction);
    // the same yarn is used on the request's Job / SO card at once: that is the yarn cost
    const d = (await companyServices(companyId, transaction)).find((s) => s.id === r.departmentId);
    const use = await deptYarn.useCore(req, d, {
      usageDate: today(), jobId: r.jobId, soCardId: r.soCardId, remarks: `Yarn request ${label(r.reqNo)}`,
      lines: out.lines.map((x) => ({ outwardLineId: x.id, bags: x.bags })),
    }, transaction, { requestId: id });

    for (const p of plan) {
      let value = 0;
      let sent = 0;
      for (const x of p.picks) {
        const e = entry.get(x.inwardId);
        const v = e.ratePerLb == null ? 0 : r2(x.bags * e.lbsPerBag * e.ratePerLb);
        value = r2(value + v);
        sent += x.bags;
        await sequelize.query('INSERT INTO yarn_request_allocations (id, "lineId", "inwardId", bags, "lbsPerBag", "ratePerLb", value) VALUES (:id, :lineId, :inwardId, :bags, :lbsPerBag, :rate, :value)',
          { replacements: { id: crypto.randomUUID(), lineId: p.line.id, inwardId: x.inwardId, bags: x.bags, lbsPerBag: e.lbsPerBag, rate: e.ratePerLb, value: v }, transaction });
      }
      await sequelize.query('UPDATE yarn_request_lines SET "sentBags" = :sent, value = :value WHERE id = :id', { replacements: { id: p.line.id, sent, value }, transaction });
    }
    await sequelize.query(`UPDATE yarn_requests SET status = 'IN_WAY', "sentById" = :userId, "sentAt" = now(), "sentThrough" = :sentThrough, "sentBags" = :bags, "totalValue" = :value, "outwardId" = :outwardId, "usageId" = :usageId, "updatedAt" = now() WHERE id = :id`,
      { replacements: { id, userId: req.user.id, sentThrough: sentThrough || null, bags: total, value: out.totalValue, outwardId: out.id, usageId: use.id }, transaction });
    const after = await loadOne(id, transaction);
    await audit.log(req, { action: 'YARN_REQUEST_SENT', entityType: 'YarnRequest', entityId: id, after }, { transaction });
    return after;
  });
}

module.exports = { formData, deptList, deptGet, create, update, cancel, receive, storeList, storeGet, accept, reject, send };
