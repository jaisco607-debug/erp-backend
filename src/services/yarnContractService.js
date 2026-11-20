// Weaving > Contracts: PURCHASE ("Contract Yarn Purchase", with a vendor) and OVERHEAD ("Weaving Overhead Sell Contract", with a customer).
// A contract has lines, one per yarn quality (= a yarn count of the Yarn Count master): bags x bag weight = lbs (or lbs typed directly), rate per lb, amount.
// Yarn inward entries count against a line: delivered = sum of their lbs, balance = ordered - delivered. A contract / line that is CLOSED takes no new inward.
// Raw SQL on purpose (reports, balances); the numbers come back as strings from Postgres and are turned into numbers here.
const crypto = require('crypto');
const { sequelize, Vendor, Customer, YarnCount } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');

const KINDS = ['PURCHASE', 'OVERHEAD'];
const KIND_TEXT = { PURCHASE: 'Contract Yarn Purchase', OVERHEAD: 'Weaving Overhead Sell Contract' };
const STATUS_TEXT = { OPEN: 'Open', CLOSED: 'Closed' };
const DEFAULT_TAX = 18;
const n2 = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => (v == null ? null : Number(v));
const label = (code) => String(code).padStart(4, '0');
const QT = sequelize.QueryTypes.SELECT;
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QT, transaction });

const party = (r) => ({ kind: r.vendorId ? 'VENDOR' : 'CUSTOMER', id: r.vendorId || r.customerId, code: r.partyCode, name: r.partyName });
const pct = (delivered, ordered) => (ordered > 0 ? Math.min(100, Math.round((delivered / ordered) * 1000) / 10) : 0);
const deliveryStatus = (delivered, ordered) => (delivered <= 0 ? 'NOT_STARTED' : delivered >= ordered ? 'COMPLETE' : 'PART');
const DELIVERY_TEXT = { NOT_STARTED: 'Not started', PART: 'Part delivered', COMPLETE: 'Complete' };

const lineJson = (l) => {
  const lbs = Number(l.lbs); const delivered = Number(l.delivered || 0);
  return {
    id: l.id, lineNo: l.lineNo, lineLabel: String(l.lineNo).padStart(6, '0'), yarnCountId: l.yarnCountId, yarnCount: { id: l.yarnCountId, name: l.yarnCountName },
    bags: l.bags, bagWeight: num(l.bagWeight), lbs, ratePerLb: num(l.ratePerLb), amount: num(l.amount),
    isClosed: l.isClosed, status: l.isClosed ? 'CLOSED' : 'ACTIVE', statusText: l.isClosed ? 'Closed' : 'Active',
    deliveredLbs: n2(delivered), balanceLbs: n2(Math.max(0, lbs - delivered)), overLbs: n2(Math.max(0, delivered - lbs)), percentDone: pct(delivered, lbs),
    bagsIn: Number(l.bagsIn || 0), deliveries: Number(l.deliveries || 0), lastDelivery: l.lastDelivery || null,
    deliveryStatus: deliveryStatus(delivered, lbs), deliveryStatusText: DELIVERY_TEXT[deliveryStatus(delivered, lbs)],
  };
};

const LINES_SQL = `SELECT l.*, yc.name AS "yarnCountName", COALESCE(s.lbs, 0) AS delivered, COALESCE(s.bags, 0) AS "bagsIn", COALESCE(s.cnt, 0) AS deliveries, s.last AS "lastDelivery"
  FROM yarn_contract_lines l JOIN yarn_counts yc ON yc.id = l."yarnCountId"
  LEFT JOIN (SELECT "contractLineId", SUM("totalLbs") AS lbs, SUM(bags) AS bags, COUNT(*) AS cnt, MAX("inwardDate") AS last FROM yarn_inwards WHERE "deletedAt" IS NULL AND "contractLineId" IS NOT NULL GROUP BY 1) s ON s."contractLineId" = l.id`;

const HEAD_SQL = `SELECT c.*, COALESCE(v.code, cu.code) AS "partyCode", COALESCE(v.name, cu.name) AS "partyName"
  FROM yarn_contracts c LEFT JOIN vendors v ON v.id = c."vendorId" LEFT JOIN customers cu ON cu.id = c."customerId"`;

function totalsOf(lines, taxPercent) {
  const subtotal = n2(lines.reduce((t, l) => t + (l.amount || 0), 0));
  const taxAmount = n2((subtotal * Number(taxPercent)) / 100);
  const lbs = n2(lines.reduce((t, l) => t + l.lbs, 0)); const delivered = n2(lines.reduce((t, l) => t + l.deliveredLbs, 0));
  return { bags: lines.reduce((t, l) => t + (l.bags || 0), 0), lbs, subtotal, taxAmount, net: n2(subtotal + taxAmount),
    deliveredLbs: delivered, balanceLbs: n2(lines.reduce((t, l) => t + l.balanceLbs, 0)), percentDone: pct(delivered, lbs) };
}

/** What the screen's "Delivery summary" shows: the lines of one yarn quality added together. */
function summaryOf(lines) {
  const by = new Map();
  for (const l of lines) {
    const s = by.get(l.yarnCountId) || { yarnCount: l.yarnCount, orderedLbs: 0, deliveredLbs: 0, bagsIn: 0, deliveries: 0, lastDelivery: null };
    s.orderedLbs = n2(s.orderedLbs + l.lbs); s.deliveredLbs = n2(s.deliveredLbs + l.deliveredLbs); s.bagsIn += l.bagsIn; s.deliveries += l.deliveries;
    if (l.lastDelivery && (!s.lastDelivery || l.lastDelivery > s.lastDelivery)) s.lastDelivery = l.lastDelivery;
    by.set(l.yarnCountId, s);
  }
  return [...by.values()].map((s) => ({ ...s, balanceLbs: n2(Math.max(0, s.orderedLbs - s.deliveredLbs)), percentDone: pct(s.deliveredLbs, s.orderedLbs),
    status: deliveryStatus(s.deliveredLbs, s.orderedLbs), statusText: DELIVERY_TEXT[deliveryStatus(s.deliveredLbs, s.orderedLbs)] }));
}

const headJson = (c) => ({
  id: c.id, kind: c.kind, kindText: KIND_TEXT[c.kind], code: c.code, codeLabel: label(c.code),
  contractDate: c.contractDate, deliveryDate: c.deliveryDate || null, termsDays: c.termsDays, notes: c.notes, taxPercent: Number(c.taxPercent),
  status: c.status, statusText: STATUS_TEXT[c.status], party: party(c), vendorId: c.vendorId, customerId: c.customerId, createdAt: c.createdAt,
});

async function inwardsOf(contractId, transaction) {
  const rows = await run(`SELECT i.id, i.code, i."inwardDate", i."dcNo", i.bags, i."totalLbs", i."ratePerLb", i.amount, i.purpose, l.id AS "lineId", l."lineNo", l."yarnCountId", yc.name AS "yarnCountName"
    FROM yarn_inwards i JOIN yarn_contract_lines l ON l.id = i."contractLineId" JOIN yarn_counts yc ON yc.id = l."yarnCountId"
    WHERE l."contractId" = :contractId AND i."deletedAt" IS NULL ORDER BY i."inwardDate", i.code`, { contractId }, transaction);
  return rows.map((r) => ({ id: r.id, code: r.code, inwardDate: r.inwardDate, dcNo: r.dcNo, purpose: r.purpose, lineId: r.lineId, lineNo: r.lineNo, yarnCount: { id: r.yarnCountId, name: r.yarnCountName },
    bags: r.bags, totalLbs: Number(r.totalLbs), ratePerLb: num(r.ratePerLb), amount: num(r.amount) }));
}

/** One whole contract: header, lines (with delivered / balance), totals, delivery summary and the inwards on it. */
async function full(companyId, id, transaction) {
  const [c] = await run(`${HEAD_SQL} WHERE c.id = :id AND c."companyId" = :companyId AND c."deletedAt" IS NULL`, { id, companyId }, transaction);
  if (!c) throw AppError.notFound('Yarn contract');
  const lines = (await run(`${LINES_SQL} WHERE l."contractId" = :id ORDER BY l."lineNo"`, { id }, transaction)).map(lineJson);
  const inw = await inwardsOf(id, transaction);
  return { ...headJson(c), lines, totals: totalsOf(lines, c.taxPercent), deliverySummary: summaryOf(lines), inwards: inw, inwardCount: inw.length };
}
const get = (req, id) => full(req.user.companyId, id);

async function list(req, { page, limit, search, kind, status, vendorId, customerId, dateFrom, dateTo }) {
  const r = { companyId: req.user.companyId };
  const f = [];
  if (kind) { f.push('c.kind = :kind'); r.kind = kind; }
  if (vendorId) { f.push('c."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (customerId) { f.push('c."customerId" = :customerId'); r.customerId = customerId; }
  if (dateFrom) { f.push('c."contractDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { f.push('c."contractDate" <= :dateTo'); r.dateTo = dateTo; }
  if (search) {
    r.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    f.push(`(COALESCE(v.name, cu.name) ILIKE :like OR c.notes ILIKE :like OR c.code::text = :exact OR EXISTS (SELECT 1 FROM yarn_contract_lines sl JOIN yarn_counts sy ON sy.id = sl."yarnCountId" WHERE sl."contractId" = c.id AND sy.name ILIKE :like))`);
    r.exact = String(Number(search) || '');
  }
  const base = `WITH base AS (SELECT c.id, c.kind, c.code, c."contractDate", c."deliveryDate", c."termsDays", c.notes, c."taxPercent", c.status, c."vendorId", c."customerId",
      COALESCE(v.code, cu.code) AS "partyCode", COALESCE(v.name, cu.name) AS "partyName",
      COALESCE(a.ordered, 0) AS ordered, COALESCE(a.amount, 0) AS subtotal, COALESCE(a.goods, '') AS goods, COALESCE(d.delivered, 0) AS delivered, COALESCE(d.bags, 0) AS "bagsIn"
    FROM yarn_contracts c LEFT JOIN vendors v ON v.id = c."vendorId" LEFT JOIN customers cu ON cu.id = c."customerId"
    LEFT JOIN (SELECT l."contractId", SUM(l.lbs) AS ordered, SUM(l.amount) AS amount, string_agg(DISTINCT yc.name, ', ') AS goods FROM yarn_contract_lines l JOIN yarn_counts yc ON yc.id = l."yarnCountId" GROUP BY 1) a ON a."contractId" = c.id
    LEFT JOIN (SELECT l."contractId", SUM(i."totalLbs") AS delivered, SUM(i.bags) AS bags FROM yarn_inwards i JOIN yarn_contract_lines l ON l.id = i."contractLineId" WHERE i."deletedAt" IS NULL GROUP BY 1) d ON d."contractId" = c.id
    WHERE c."companyId" = :companyId AND c."deletedAt" IS NULL${f.length ? ` AND ${f.join(' AND ')}` : ''})`;
  // `status` is applied after the other filters: the Open / Closed numbers follow the other filters but not the status tab
  const st = { ...r, status: status || null };
  const rows = await run(`${base} SELECT * FROM base WHERE (:status::text IS NULL OR status = :status) ORDER BY "contractDate" DESC, code DESC LIMIT :limit OFFSET :offset`, { ...st, limit, offset: (page - 1) * limit });
  const [t] = await run(`${base} SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open, COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed,
    COUNT(*) FILTER (WHERE :status::text IS NULL OR status = :status)::int AS total,
    COALESCE(SUM(ordered) FILTER (WHERE :status::text IS NULL OR status = :status), 0) AS ordered, COALESCE(SUM(delivered) FILTER (WHERE :status::text IS NULL OR status = :status), 0) AS delivered,
    COALESCE(SUM(subtotal) FILTER (WHERE :status::text IS NULL OR status = :status), 0) AS subtotal FROM base`, st);
  const data = rows.map((c) => {
    const ordered = Number(c.ordered); const delivered = Number(c.delivered); const subtotal = n2(c.subtotal);
    return { ...headJson(c), goods: c.goods, orderedLbs: ordered, deliveredLbs: n2(delivered), balanceLbs: n2(Math.max(0, ordered - delivered)), percentDone: pct(delivered, ordered), bagsIn: Number(c.bagsIn),
      subtotal, taxAmount: n2((subtotal * Number(c.taxPercent)) / 100), net: n2(subtotal + (subtotal * Number(c.taxPercent)) / 100) };
  });
  const ordered = n2(t.ordered); const delivered = n2(t.delivered);
  return { data, page, limit, total: t.total, counts: { open: t.open, closed: t.closed },
    totals: { orderedLbs: ordered, deliveredLbs: delivered, balanceLbs: n2(Math.max(0, ordered - delivered)), amount: n2(t.subtotal) } };
}

/** Dropdown help for the contract form. */
async function formData(req) {
  const counts = await YarnCount.findAll({ where: { companyId: req.user.companyId, isActive: true }, order: [['code', 'ASC']] });
  return { date: today(), defaultTaxPercent: DEFAULT_TAX, defaultBagWeight: 100, kinds: KINDS.map((value) => ({ value, text: KIND_TEXT[value] })),
    yarnCounts: counts.map((c) => ({ id: c.id, code: c.code, name: c.name })) };
}

// ---- checks ----
async function checkParty(companyId, kind, { vendorId, customerId }, keep, transaction) {
  if (kind === 'PURCHASE') {
    if (!vendorId) throw AppError.rule('VENDOR_REQUIRED', 'A purchase contract needs a vendor', { field: 'vendorId' });
    const v = await Vendor.findOne({ where: { id: vendorId, companyId, module: 'WEAVING' }, transaction });
    if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'This vendor does not exist', { field: 'vendorId' });
    if (!v.isActive && vendorId !== keep) throw AppError.rule('VENDOR_INACTIVE', 'This vendor is switched off', { field: 'vendorId' });
  } else {
    if (!customerId) throw AppError.rule('CUSTOMER_REQUIRED', 'An overhead contract needs a customer', { field: 'customerId' });
    const c = await Customer.findOne({ where: { id: customerId, companyId, module: 'WEAVING' }, transaction });
    if (!c) throw AppError.rule('UNKNOWN_CUSTOMER', 'This customer does not exist', { field: 'customerId' });
    if (!c.isActive && customerId !== keep) throw AppError.rule('CUSTOMER_INACTIVE', 'This customer is switched off', { field: 'customerId' });
  }
}
async function checkCount(companyId, yarnCountId, keep, transaction) {
  const c = await YarnCount.findOne({ where: { id: yarnCountId, companyId }, transaction });
  if (!c) throw AppError.rule('UNKNOWN_YARN_COUNT', 'This yarn quality (yarn count) does not exist', { field: 'yarnCountId' });
  if (!c.isActive && yarnCountId !== keep) throw AppError.rule('YARN_COUNT_INACTIVE', 'This yarn count is switched off', { field: 'yarnCountId' });
}

/** bags x bag weight = lbs, or lbs typed directly. A purchase line needs a rate. */
function work(kind, d) {
  let { bags = null, bagWeight = null, lbs, ratePerLb = null } = d;
  if ((bags == null) !== (bagWeight == null)) throw AppError.rule('BAGS_INCOMPLETE', 'Give both the bags and the bag weight (or only the lbs)', { field: bags == null ? 'bags' : 'bagWeight' });
  if (bags != null) lbs = n2(bags * bagWeight);
  if (lbs == null) throw AppError.rule('LBS_REQUIRED', 'Give the lbs (or the bags and the bag weight)', { field: 'lbs' });
  if (kind === 'PURCHASE' && ratePerLb == null) throw AppError.rule('RATE_REQUIRED', 'The rate per lb is required on a purchase contract line', { field: 'ratePerLb' });
  return { bags, bagWeight, lbs: n2(lbs), ratePerLb, amount: ratePerLb == null ? null : n2(lbs * ratePerLb) };
}

async function insertLine(companyId, contractId, kind, lineNo, d, transaction) {
  await checkCount(companyId, d.yarnCountId, null, transaction);
  const w = work(kind, d);
  await sequelize.query(`INSERT INTO yarn_contract_lines (id, "companyId", "contractId", "lineNo", "yarnCountId", bags, "bagWeight", lbs, "ratePerLb", amount)
    VALUES (:id, :companyId, :contractId, :lineNo, :yarnCountId, :bags, :bagWeight, :lbs, :ratePerLb, :amount)`,
  { replacements: { id: crypto.randomUUID(), companyId, contractId, lineNo, yarnCountId: d.yarnCountId, ...w }, transaction });
}

async function openOne(companyId, id, transaction, { lock = true } = {}) {
  const [c] = await run(`SELECT * FROM yarn_contracts WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL${lock ? ' FOR UPDATE' : ''}`, { id, companyId }, transaction);
  if (!c) throw AppError.notFound('Yarn contract');
  return c;
}

async function create(req, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`yarn-contract:${companyId}:${data.kind}`], transaction });
    await checkParty(companyId, data.kind, data, null, transaction);
    const [{ next }] = await run('SELECT COALESCE(MAX(code), 0) + 1 AS next FROM yarn_contracts WHERE "companyId" = :companyId AND kind = :kind', { companyId, kind: data.kind }, transaction);
    const id = crypto.randomUUID();
    await sequelize.query(`INSERT INTO yarn_contracts (id, "companyId", kind, code, "vendorId", "customerId", "contractDate", "deliveryDate", "termsDays", notes, "taxPercent", "createdById")
      VALUES (:id, :companyId, :kind, :code, :vendorId, :customerId, :contractDate, :deliveryDate, :termsDays, :notes, :taxPercent, :createdById)`,
    { replacements: { id, companyId, kind: data.kind, code: Number(next), vendorId: data.kind === 'PURCHASE' ? data.vendorId : null, customerId: data.kind === 'OVERHEAD' ? data.customerId : null,
      contractDate: data.contractDate || today(), deliveryDate: data.deliveryDate || null, termsDays: data.termsDays || 0, notes: data.notes || null, taxPercent: data.taxPercent == null ? DEFAULT_TAX : data.taxPercent, createdById: req.user.id }, transaction });
    let no = 0;
    for (const l of data.lines) await insertLine(companyId, id, data.kind, ++no, l, transaction);
    const out = await full(companyId, id, transaction);
    await audit.log(req, { action: 'YARN_CONTRACT_CREATED', entityType: 'YarnContract', entityId: id, after: { ...headJson(await openOne(companyId, id, transaction, { lock: false })), lines: out.lines.length } }, { transaction });
    return out;
  });
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const c = await openOne(companyId, id, transaction);
    const [{ n }] = await run('SELECT COUNT(*)::int AS n FROM yarn_inwards i JOIN yarn_contract_lines l ON l.id = i."contractLineId" WHERE l."contractId" = :id AND i."deletedAt" IS NULL', { id }, transaction);
    const newParty = (c.kind === 'PURCHASE' ? changes.vendorId : changes.customerId);
    if ((c.kind === 'PURCHASE' ? changes.customerId : changes.vendorId)) throw AppError.rule('TYPE_LOCKED', c.kind === 'PURCHASE' ? 'This is a purchase contract: choose a vendor' : 'This is an overhead contract: choose a customer');
    const samePartyId = c.kind === 'PURCHASE' ? c.vendorId : c.customerId;
    if (newParty && newParty !== samePartyId) {
      if (n) throw AppError.rule('USED_IN_INWARD', 'Yarn already came in on this contract: its party cannot be changed', { inwards: n });
      await checkParty(companyId, c.kind, { vendorId: newParty, customerId: newParty }, samePartyId, transaction);
    }
    const before = headJson((await run(`${HEAD_SQL} WHERE c.id = :id`, { id }, transaction))[0]);
    const set = {};
    if (newParty) set[c.kind === 'PURCHASE' ? 'vendorId' : 'customerId'] = newParty;
    for (const f of ['contractDate', 'deliveryDate', 'termsDays', 'notes', 'taxPercent']) if (changes[f] !== undefined) set[f] = changes[f] === '' ? null : changes[f];
    const keys = Object.keys(set);
    if (keys.length) await sequelize.query(`UPDATE yarn_contracts SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :id`, { replacements: { ...set, id }, transaction });
    const out = await full(companyId, id, transaction);
    await audit.log(req, { action: 'YARN_CONTRACT_UPDATED', entityType: 'YarnContract', entityId: id, before, after: headJson((await run(`${HEAD_SQL} WHERE c.id = :id`, { id }, transaction))[0]) }, { transaction });
    return out;
  });
}

/** Close / activate the whole contract. */
const setStatus = (status) => async (req, id) => {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const c = await openOne(companyId, id, transaction);
    if (c.status !== status) {
      await sequelize.query('UPDATE yarn_contracts SET status = :status, "updatedAt" = now() WHERE id = :id', { replacements: { status, id }, transaction });
      await audit.log(req, { action: status === 'CLOSED' ? 'YARN_CONTRACT_CLOSED' : 'YARN_CONTRACT_ACTIVATED', entityType: 'YarnContract', entityId: id, before: { status: c.status }, after: { status } }, { transaction });
    }
    return full(companyId, id, transaction);
  });
};

async function remove(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const c = await openOne(companyId, id, transaction);
    const [{ n }] = await run('SELECT COUNT(*)::int AS n FROM yarn_inwards i JOIN yarn_contract_lines l ON l.id = i."contractLineId" WHERE l."contractId" = :id AND i."deletedAt" IS NULL', { id }, transaction);
    if (n) throw AppError.rule('IN_USE', `${n} yarn inward${n === 1 ? '' : 's'} came in on this contract: delete or change ${n === 1 ? 'it' : 'them'} first (or close the contract)`, { inwards: n });
    const [{ sb }] = await run('SELECT COUNT(*)::int AS sb FROM sizing_batches WHERE "contractId" = :id AND "deletedAt" IS NULL', { id }, transaction);
    if (sb) throw AppError.rule('IN_USE', `${sb} sizing batch${sb === 1 ? '' : 'es'} ${sb === 1 ? 'is' : 'are'} tagged to this contract: untag ${sb === 1 ? 'it' : 'them'} first (or close the contract)`, { sizingBatches: sb });
    await sequelize.query('UPDATE yarn_contracts SET "deletedAt" = now() WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'YARN_CONTRACT_DELETED', entityType: 'YarnContract', entityId: id, before: { kind: c.kind, code: c.code } }, { transaction });
    return { deleted: true, id };
  });
}

// ---- lines ----
async function addLine(req, id, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const c = await openOne(companyId, id, transaction);
    if (c.status === 'CLOSED') throw AppError.rule('CONTRACT_CLOSED', 'This contract is closed: activate it to add a line');
    const [{ next }] = await run('SELECT COALESCE(MAX("lineNo"), 0) + 1 AS next FROM yarn_contract_lines WHERE "contractId" = :id', { id }, transaction);
    await insertLine(companyId, id, c.kind, Number(next), data, transaction);
    await audit.log(req, { action: 'YARN_CONTRACT_LINE_ADDED', entityType: 'YarnContract', entityId: id, after: { lineNo: Number(next), ...data } }, { transaction });
    return full(companyId, id, transaction);
  });
}

async function lineOr404(companyId, id, lineId, transaction) {
  const [l] = await run(`${LINES_SQL} WHERE l.id = :lineId AND l."contractId" = :id AND l."companyId" = :companyId`, { lineId, id, companyId }, transaction);
  if (!l) throw AppError.notFound('Contract line');
  return l;
}

async function updateLine(req, id, lineId, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const c = await openOne(companyId, id, transaction);
    const l = await lineOr404(companyId, id, lineId, transaction);
    const delivered = Number(l.delivered);
    const yarnCountId = changes.yarnCountId || l.yarnCountId;
    if (yarnCountId !== l.yarnCountId) {
      if (delivered > 0) throw AppError.rule('USED_IN_INWARD', 'Yarn already came in on this line: its yarn quality cannot be changed', { deliveredLbs: delivered });
      await checkCount(companyId, yarnCountId, l.yarnCountId, transaction);
    }
    const touchesQty = ['bags', 'bagWeight', 'lbs'].some((k) => changes[k] !== undefined);
    const d = { bags: l.bags, bagWeight: num(l.bagWeight), lbs: Number(l.lbs), ratePerLb: changes.ratePerLb !== undefined ? changes.ratePerLb : num(l.ratePerLb) };
    if (touchesQty) {
      if (changes.bags !== undefined || changes.bagWeight !== undefined) { d.bags = changes.bags !== undefined ? changes.bags : l.bags; d.bagWeight = changes.bagWeight !== undefined ? changes.bagWeight : num(l.bagWeight); d.lbs = changes.lbs; }
      else { d.bags = null; d.bagWeight = null; d.lbs = changes.lbs; }
    }
    const w = work(c.kind, d);
    if (w.lbs < delivered) throw AppError.rule('BELOW_DELIVERED', `${delivered} lbs already came in on this line: the quantity cannot be less than that`, { field: 'lbs', deliveredLbs: delivered });
    await sequelize.query('UPDATE yarn_contract_lines SET "yarnCountId" = :yarnCountId, bags = :bags, "bagWeight" = :bagWeight, lbs = :lbs, "ratePerLb" = :ratePerLb, amount = :amount, "updatedAt" = now() WHERE id = :lineId',
      { replacements: { yarnCountId, ...w, lineId }, transaction });
    await audit.log(req, { action: 'YARN_CONTRACT_LINE_UPDATED', entityType: 'YarnContract', entityId: id, before: { lineNo: l.lineNo, lbs: Number(l.lbs), ratePerLb: num(l.ratePerLb) }, after: { lineNo: l.lineNo, ...w, yarnCountId } }, { transaction });
    return full(companyId, id, transaction);
  });
}

async function removeLine(req, id, lineId) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await openOne(companyId, id, transaction);
    const l = await lineOr404(companyId, id, lineId, transaction);
    const [{ n }] = await run('SELECT COUNT(*)::int AS n FROM yarn_inwards WHERE "contractLineId" = :lineId AND "deletedAt" IS NULL', { lineId }, transaction);
    if (n) throw AppError.rule('IN_USE', `${n} yarn inward${n === 1 ? '' : 's'} came in on this line: close the line instead of deleting it`, { inwards: n });
    const [{ m }] = await run('SELECT COUNT(*)::int AS m FROM yarn_contract_lines WHERE "contractId" = :id', { id }, transaction);
    if (m <= 1) throw AppError.rule('LAST_LINE', 'A contract needs at least one line: delete the whole contract instead');
    await sequelize.query('DELETE FROM yarn_contract_lines WHERE id = :lineId', { replacements: { lineId }, transaction });
    await audit.log(req, { action: 'YARN_CONTRACT_LINE_DELETED', entityType: 'YarnContract', entityId: id, before: { lineNo: l.lineNo, lbs: Number(l.lbs) } }, { transaction });
    return full(companyId, id, transaction);
  });
}

const setLineClosed = (isClosed) => async (req, id, lineId) => {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const c = await openOne(companyId, id, transaction);
    const l = await lineOr404(companyId, id, lineId, transaction);
    if (!isClosed && c.status === 'CLOSED') throw AppError.rule('CONTRACT_CLOSED', 'This contract is closed: activate the contract first');
    if (l.isClosed !== isClosed) {
      await sequelize.query('UPDATE yarn_contract_lines SET "isClosed" = :isClosed, "updatedAt" = now() WHERE id = :lineId', { replacements: { isClosed, lineId }, transaction });
      await audit.log(req, { action: isClosed ? 'YARN_CONTRACT_LINE_CLOSED' : 'YARN_CONTRACT_LINE_ACTIVATED', entityType: 'YarnContract', entityId: id, after: { lineNo: l.lineNo } }, { transaction });
    }
    return full(companyId, id, transaction);
  });
};

// ---- for the yarn inward ----
/** The active lines of the OPEN contracts of one party (the contract picker of the yarn inward form), with their balance. `itemId` / `yarnCountId` narrow it to one yarn quality. */
async function openLines(req, { vendorId, customerId, yarnCountId, itemId }) {
  const { companyId } = req.user;
  let count = yarnCountId;
  if (itemId) { const [it] = await run('SELECT "yarnCountId" FROM yarn_items WHERE id = :itemId AND "companyId" = :companyId', { itemId, companyId }); count = it ? it.yarnCountId : '00000000-0000-4000-8000-000000000000'; }
  const rows = await run(`SELECT l.*, yc.name AS "yarnCountName", c.id AS "cId", c.kind, c.code AS "cCode", c."contractDate", c."taxPercent", COALESCE(s.lbs, 0) AS delivered, COALESCE(s.bags, 0) AS "bagsIn", COALESCE(s.cnt, 0) AS deliveries, s.last AS "lastDelivery"
    FROM yarn_contract_lines l JOIN yarn_contracts c ON c.id = l."contractId" JOIN yarn_counts yc ON yc.id = l."yarnCountId"
    LEFT JOIN (SELECT "contractLineId", SUM("totalLbs") AS lbs, SUM(bags) AS bags, COUNT(*) AS cnt, MAX("inwardDate") AS last FROM yarn_inwards WHERE "deletedAt" IS NULL AND "contractLineId" IS NOT NULL GROUP BY 1) s ON s."contractLineId" = l.id
    WHERE l."companyId" = :companyId AND c."deletedAt" IS NULL AND c.status = 'OPEN' AND NOT l."isClosed" AND ${vendorId ? 'c."vendorId" = :party' : 'c."customerId" = :party'}${count ? ' AND l."yarnCountId" = :count' : ''}
    ORDER BY c."contractDate" DESC, c.code DESC, l."lineNo"`, { companyId, party: vendorId || customerId, count }, undefined);
  return { data: rows.map((l) => ({ ...lineJson(l), contract: { id: l.cId, kind: l.kind, kindText: KIND_TEXT[l.kind], code: l.cCode, codeLabel: label(l.cCode), contractDate: l.contractDate } })) };
}

/** The OPEN overhead contracts of the company with their customer (the contract picker of the sizing batch). */
async function overheadList(req, { customerId, search }) {
  const r = { companyId: req.user.companyId, customerId: customerId || null };
  let like = null;
  if (search) like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await run(`SELECT c.id, c.code, to_char(c."contractDate", 'YYYY-MM-DD') AS "contractDate", c.status, cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
      (SELECT string_agg(DISTINCT yc.name, ', ') FROM yarn_contract_lines l JOIN yarn_counts yc ON yc.id = l."yarnCountId" WHERE l."contractId" = c.id) AS goods
    FROM yarn_contracts c JOIN customers cu ON cu.id = c."customerId" WHERE c."companyId" = :companyId AND c.kind = 'OVERHEAD' AND c.status = 'OPEN' AND c."deletedAt" IS NULL
      AND (:customerId::uuid IS NULL OR c."customerId" = :customerId::uuid) AND (:like::text IS NULL OR cu.name ILIKE :like OR c.code::text = :exact)
    ORDER BY c."contractDate" DESC, c.code DESC LIMIT 200`, { ...r, like, exact: String(Number(search) || '') });
  return { data: rows.map((c) => ({ id: c.id, code: c.code, codeLabel: label(c.code), contractDate: c.contractDate, status: c.status, goods: c.goods || '', customer: { id: c.customerId, code: c.customerCode, name: c.customerName }, title: `${c.customerName} (${c.customerCode}), Cont#${c.code}` })), total: rows.length };
}

/** One line with its contract, for the checks of a yarn inward. null when it is not of this company / the contract is deleted. */
async function lineInfo(companyId, lineId, transaction) {
  const [l] = await run(`SELECT l.id, l."lineNo", l."yarnCountId", l."isClosed", l."ratePerLb", c.id AS "contractId", c.kind, c.code, c.status, c."vendorId", c."customerId"
    FROM yarn_contract_lines l JOIN yarn_contracts c ON c.id = l."contractId" WHERE l.id = :lineId AND l."companyId" = :companyId AND c."deletedAt" IS NULL`, { lineId, companyId }, transaction);
  return l || null;
}

/** Map inwardId -> the contract line the entry counts against (for the yarn inward answers). */
async function contractsOf(ids, transaction) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await run(`SELECT i.id AS "inwardId", l.id AS "lineId", l."lineNo", c.id, c.kind, c.code, c.status FROM yarn_inwards i JOIN yarn_contract_lines l ON l.id = i."contractLineId"
    JOIN yarn_contracts c ON c.id = l."contractId" WHERE i.id IN (:ids)`, { ids }, transaction);
  for (const r of rows) map.set(r.inwardId, { id: r.id, kind: r.kind, kindText: KIND_TEXT[r.kind], code: r.code, codeLabel: label(r.code), status: r.status, lineId: r.lineId, lineNo: r.lineNo });
  return map;
}

module.exports = { KINDS, overheadList, list, get, create, update, remove, formData, addLine, updateLine, removeLine, openLines, lineInfo, contractsOf,
  close: setStatus('CLOSED'), activate: setStatus('OPEN'), closeLine: setLineClosed(true), activateLine: setLineClosed(false) };
