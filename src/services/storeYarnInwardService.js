// Store Management > Yarn Inward: yarn (dhaaga) BOUGHT from a vendor. Nothing is picked from a master: the yarn name, brand, bags, lbs per bag and the rate per lb are typed;
// only the vendor is picked. All bags of one arrival weigh the same (e.g. 10 bags x 50 lbs).
//   totalLbs = bags x lbsPerBag;  amount = totalLbs x ratePerLb (empty until a rate is given)
// - An entry starts as a draft (can be edited / deleted); APPROVED entries are the stock; only the client admin takes an approval back, and only while no bag has gone out.
// - Stock = bags - outwardBags (the outward step comes next). Entries are deleted softly; their numbers are never reused.
const { Op } = require('sequelize');
const { sequelize, StoreYarnInward, Vendor } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { round: r2 } = require('../utils/money');
const audit = require('./auditService');
const counters = require('./counterService');
const poReceipts = require('./poReceiptService');
const m = require('./storeMasterService');

const NO = 'store_yarn_inward_no';
const noText = (n) => String(n).padStart(5, '0');
const squeeze = (s) => (s == null ? s : String(s).replace(/\s+/g, ' ').trim());
const maxNo = (companyId, transaction) => StoreYarnInward.max('inwardNo', { where: { companyId }, paranoid: false, transaction });

const include = [{ model: Vendor, as: 'vendor', paranoid: false }];

function json(e, extra = {}) {
  const balanceBags = e.bags - e.outwardBags;
  return {
    id: e.id,
    inwardNo: e.inwardNo,
    inwardText: noText(e.inwardNo),
    inwardDate: e.inwardDate,
    vendor: e.vendor ? { id: e.vendor.id, code: e.vendor.code, name: e.vendor.name, label: `${e.vendor.name} (${e.vendor.code})` } : { id: e.vendorId },
    yarnName: e.yarnName,
    brand: e.brand,
    // "22/s Cotton - Crescent": what the stock and the lists show
    title: e.brand ? `${e.yarnName} - ${e.brand}` : e.yarnName,
    bags: e.bags,
    lbsPerBag: e.lbsPerBag,
    totalLbs: e.totalLbs,
    ratePerLb: e.ratePerLb ?? null,
    hasRate: e.ratePerLb != null,
    amount: e.amount ?? null,
    outwardBags: e.outwardBags,
    balanceBags,
    balanceLbs: r2(balanceBags * e.lbsPerBag),
    balanceValue: e.amount != null && e.bags > 0 ? r2((e.amount * balanceBags) / e.bags) : null,
    dcNo: e.dcNo,
    remarks: e.remarks,
    isApproved: e.isApproved,
    statusText: e.isApproved ? 'APPROVED' : 'UN-APPROVED',
    approvedAt: e.approvedAt,
    isActive: e.isActive,
    createdAt: e.createdAt,
    ...(e.poLineId ? { poLineId: e.poLineId, poRateNote: e.poRateNote } : {}),
    ...extra,
  };
}

async function findOr404(req, id, transaction, lock = false) {
  const e = await StoreYarnInward.findOne({ where: { id, companyId: req.user.companyId }, lock: lock ? transaction.LOCK.UPDATE : undefined, transaction });
  if (!e) throw AppError.notFound('Yarn inward');
  return e;
}
const load = async (id, transaction) => {
  const row = await StoreYarnInward.findByPk(id, { include, transaction });
  const out = json(row);
  await poReceipts.describe(row.companyId, [out], transaction); // the purchase order, when it came against one
  return out;
};

async function checkVendor(req, vendorId, transaction) {
  const v = await Vendor.findOne({ where: { id: vendorId, companyId: req.user.companyId }, transaction });
  if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'Vendor not found');
  if (!v.isActive) throw AppError.rule('VENDOR_INACTIVE', 'This vendor is switched off');
}

/** totalLbs and amount from bags, lbs per bag and the rate. */
function worked(e) {
  e.totalLbs = r2(e.bags * e.lbsPerBag);
  e.amount = e.ratePerLb == null ? null : r2(e.totalLbs * e.ratePerLb);
}

async function takeTypedNo(req, inwardNo, transaction, exceptId) {
  const companyId = req.user.companyId;
  const where = { companyId, inwardNo };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  if (await StoreYarnInward.findOne({ where, paranoid: false, transaction })) throw AppError.rule('INWARD_NO_TAKEN', `Yarn inward ${noText(inwardNo)} already exists`);
  const next = await counters.peek(companyId, NO, async () => ((await maxNo(companyId, transaction)) || 0) + 1, transaction);
  if (inwardNo >= next) await counters.set(companyId, NO, inwardNo + 1, transaction);
}

async function nextNumbers(req) {
  const companyId = req.user.companyId;
  return { nextInwardNo: await counters.peek(companyId, NO, async () => ((await maxNo(companyId)) || 0) + 1) };
}

/** The entry screen: the next number, the vendors, and what was typed before (to suggest the yarn name, brand and bag weight again). */
async function formData(req) {
  const companyId = req.user.companyId;
  const distinct = (col) => sequelize.query(`SELECT ${col} AS v, count(*)::int AS n FROM store_yarn_inwards WHERE "companyId" = :companyId AND "deletedAt" IS NULL AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC, ${col} LIMIT 100`,
    { replacements: { companyId }, type: sequelize.QueryTypes.SELECT });
  const [numbers, vendors, names, brands, weights] = await Promise.all([
    nextNumbers(req),
    Vendor.findAll({ where: { companyId, isActive: true, module: 'MAIN' }, order: [['name', 'ASC']] }),
    distinct('"yarnName"'), distinct('brand'), distinct('"lbsPerBag"'),
  ]);
  return {
    ...numbers, nextInwardText: noText(numbers.nextInwardNo), today: today(), vendors: vendors.map(m.vendorJSON),
    yarnNames: names.map((x) => x.v), brands: brands.map((x) => x.v), lbsPerBagValues: weights.map((x) => Number(x.v)),
  };
}

function filters(req, q) {
  const where = { companyId: req.user.companyId };
  for (const f of ['isActive', 'isApproved', 'vendorId']) if (q[f] !== undefined) where[f] = q[f];
  if (q.dateFrom || q.dateTo) {
    where.inwardDate = {};
    if (q.dateFrom) where.inwardDate[Op.gte] = q.dateFrom;
    if (q.dateTo) where.inwardDate[Op.lte] = q.dateTo;
  }
  if (q.search) {
    const s = `%${q.search}%`;
    const or = [{ dcNo: { [Op.iLike]: s } }, { yarnName: { [Op.iLike]: s } }, { brand: { [Op.iLike]: s } }, { '$vendor.name$': { [Op.iLike]: s } }];
    if (/^\d+$/.test(q.search)) or.push({ inwardNo: Number(q.search) });
    where[Op.or] = or;
  }
  return where;
}

/** The purchase invoice each entry is on: Map(inwardId -> { id, voucherNo, voucherLabel, status }). */
async function invoicesOf(ids, transaction) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await sequelize.query('SELECT f."inwardId", p.id, p."voucherNo", p.status FROM purchase_invoice_store_yarn_inwards f JOIN purchase_invoices p ON p.id = f."invoiceId" WHERE f."inwardId" IN (:ids)', { replacements: { ids }, type: sequelize.QueryTypes.SELECT, transaction });
  for (const r of rows) map.set(r.inwardId, { id: r.id, voucherNo: r.voucherNo, voucherLabel: String(r.voucherNo).padStart(5, '0'), status: r.status });
  return map;
}
const billed = (inv) => ({ purchaseInvoice: inv || null, invoiced: Boolean(inv) });

async function list(req, q) {
  const where = filters(req, q);
  const { rows, count } = await StoreYarnInward.findAndCountAll({ where, include, order: [['inwardNo', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit, subQuery: false, distinct: true });
  const [t] = await sequelize.query('SELECT COALESCE(SUM(bags), 0)::int AS bags, COALESCE(SUM("totalLbs"), 0)::float AS lbs, COALESCE(SUM(amount), 0)::float AS amount FROM store_yarn_inwards WHERE "companyId" = :c AND "deletedAt" IS NULL',
    { replacements: { c: req.user.companyId }, type: sequelize.QueryTypes.SELECT });
  const inv = await invoicesOf(rows.map((r) => r.id));
  return { data: rows.map((r) => json(r, billed(inv.get(r.id)))), page: q.page, limit: q.limit, total: count, totals: { entries: count, allBags: t.bags, allLbs: r2(t.lbs), allAmount: r2(t.amount) } };
}

/** One entry with where its yarn went (every outward to a department: bags, used by the department, left there). */
async function get(req, id) {
  const e = await findOr404(req, id);
  return { ...(await load(e.id)), ...billed((await invoicesOf([e.id])).get(e.id)), outwards: await require('./storeYarnOutwardService').ofInward(req, e.id) };
}

async function create(req, data) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    await checkVendor(req, data.vendorId, transaction);
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`store-yarn-inward-no:${companyId}`], transaction });
    if (data.inwardNo) await takeTypedNo(req, data.inwardNo, transaction);
    const inwardNo = data.inwardNo || await counters.take(companyId, NO, async () => ((await maxNo(companyId, transaction)) || 0) + 1, transaction);
    const e = StoreYarnInward.build({
      companyId, inwardNo, inwardDate: data.inwardDate, vendorId: data.vendorId, yarnName: squeeze(data.yarnName), brand: squeeze(data.brand) || null,
      bags: data.bags, lbsPerBag: data.lbsPerBag, ratePerLb: data.ratePerLb ?? null, dcNo: data.dcNo || null, remarks: data.remarks || null, createdById: req.user.id,
      poLineId: data.poLineId || null,
    });
    // goods against a purchase order (optional): checked, and the order's rate when none is typed
    await poReceipts.yarn(req, e, { note: data.poRateNote }, transaction);
    worked(e);
    await e.save({ transaction });
    const after = await load(e.id, transaction);
    await audit.log(req, { action: 'STORE_YARN_INWARD_CREATED', entityType: 'StoreYarnInward', entityId: e.id, after }, { transaction });
    return after;
  });
}

async function update(req, id, changes) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, id, transaction, true);
    if (e.isApproved) throw AppError.rule('INWARD_APPROVED', 'An approved yarn inward cannot be edited');
    if (changes.vendorId) await checkVendor(req, changes.vendorId, transaction);
    if (changes.inwardNo !== undefined && changes.inwardNo !== e.inwardNo) {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`store-yarn-inward-no:${req.user.companyId}`], transaction });
      await takeTypedNo(req, changes.inwardNo, transaction, e.id);
      e.inwardNo = changes.inwardNo;
    }
    const before = await load(e.id, transaction);
    const wasOnOrder = { poLineId: e.poLineId, qty: Number(e.totalLbs) };
    if (changes.poLineId !== undefined) e.poLineId = changes.poLineId || null;
    for (const f of ['inwardDate', 'vendorId', 'bags', 'lbsPerBag', 'ratePerLb']) if (changes[f] !== undefined) e[f] = changes[f];
    if (changes.yarnName !== undefined) e.yarnName = squeeze(changes.yarnName);
    if (changes.brand !== undefined) e.brand = squeeze(changes.brand) || null;
    for (const f of ['dcNo', 'remarks']) if (changes[f] !== undefined) e[f] = changes[f] || null;
    await poReceipts.yarn(req, e, { before: wasOnOrder, inwardId: e.id, note: changes.poRateNote !== undefined ? changes.poRateNote : e.poRateNote }, transaction);
    worked(e);
    await e.save({ transaction });
    const after = await load(e.id, transaction);
    await audit.log(req, { action: 'STORE_YARN_INWARD_UPDATED', entityType: 'StoreYarnInward', entityId: id, before, after }, { transaction });
    return after;
  });
}

async function setActive(req, id, isActive) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, id, transaction, true);
    const before = e.isActive;
    e.isActive = isActive;
    await e.save({ transaction });
    await audit.log(req, { action: 'STORE_YARN_INWARD_ACTIVE_CHANGED', entityType: 'StoreYarnInward', entityId: id, before: { inwardNo: e.inwardNo, isActive: before }, after: { inwardNo: e.inwardNo, isActive } }, { transaction });
    return load(e.id, transaction);
  });
}

/** Approve (FULL access): the yarn is now in stock. Taking the approval back is for the client admin (checked in the route), while no bag has gone out. */
async function setApproved(req, id, approved) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, id, transaction, true);
    if (approved && !e.isActive) throw AppError.rule('INWARD_INACTIVE', 'Switch the entry on before approving it');
    if (!approved && e.outwardBags > 0) throw AppError.rule('INWARD_IN_USE', `${e.outwardBags} bags have already gone out of this entry`);
    if (!approved) {
      const inv = (await invoicesOf([e.id], transaction)).get(e.id);
      if (inv) throw AppError.rule('ON_PURCHASE_INVOICE', `This entry is on purchase invoice ${inv.voucherLabel}: delete that invoice first`, { invoiceId: inv.id, voucherNo: inv.voucherNo });
    }
    e.isApproved = approved;
    e.approvedById = approved ? req.user.id : null;
    e.approvedAt = approved ? new Date() : null;
    await e.save({ transaction });
    await audit.log(req, { action: approved ? 'STORE_YARN_INWARD_APPROVED' : 'STORE_YARN_INWARD_UNAPPROVED', entityType: 'StoreYarnInward', entityId: id, after: { inwardNo: e.inwardNo, isApproved: approved } }, { transaction });
    return load(e.id, transaction);
  });
}

async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, id, transaction, true);
    if (e.isApproved) throw AppError.rule('INWARD_APPROVED', 'An approved yarn inward cannot be deleted');
    const before = await load(e.id, transaction);
    await e.destroy({ transaction });
    await audit.log(req, { action: 'STORE_YARN_INWARD_DELETED', entityType: 'StoreYarnInward', entityId: id, before }, { transaction });
  });
}

/** Client admin: where the numbering continues. A number already used is refused. */
async function setNextNumbers(req, { nextInwardNo }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const before = await nextNumbers(req);
    const used = (await maxNo(companyId, transaction)) || 0;
    if (nextInwardNo <= used) throw AppError.rule('NUMBER_USED', `Yarn inward ${used} is already used; the next one must be above it`);
    await counters.set(companyId, NO, nextInwardNo, transaction);
    await audit.log(req, { action: 'STORE_YARN_NUMBERING_CHANGED', entityType: 'Company', entityId: companyId, before, after: { nextInwardNo } }, { transaction });
    return { nextInwardNo };
  });
}

/**
 * Yarn stock: the APPROVED, switched-on entries with bags still in the store (balance = bags - outward bags).
 *   data    one row per entry (vendor, yarn, brand, bags / lbs left, value), newest first, paged
 *   byYarn  the same yarn added up (same yarn name + brand, any letter case): entries, bags, lbs and value left
 *   totals  all of it
 * showZero=true also lists used-up entries.
 */
async function stock(req, q) {
  const where = { ...filters(req, { ...q, isApproved: undefined, isActive: undefined }), isApproved: true, isActive: true };
  const all = await StoreYarnInward.findAll({ where, include, order: [['inwardDate', 'DESC'], ['inwardNo', 'DESC']] });
  const rows = all.map((e) => json(e)).filter((r) => q.showZero || r.balanceBags > 0);
  const sum = (list, f) => r2(list.reduce((t, x) => t + (f(x) || 0), 0));
  const group = new Map();
  for (const r of rows) {
    const key = `${r.yarnName.toLowerCase()}|${(r.brand || '').toLowerCase()}`;
    const g = group.get(key) || { yarnName: r.yarnName, brand: r.brand, title: r.title, entries: 0, inwardBags: 0, balanceBags: 0, balanceLbs: 0, balanceValue: 0 };
    g.entries += 1;
    g.inwardBags += r.bags;
    g.balanceBags += r.balanceBags;
    g.balanceLbs = r2(g.balanceLbs + r.balanceLbs);
    g.balanceValue = r2(g.balanceValue + (r.balanceValue || 0));
    group.set(key, g);
  }
  const start = (q.page - 1) * q.limit;
  return {
    totals: { entries: rows.length, inwardBags: rows.reduce((t, r) => t + r.bags, 0), balanceBags: rows.reduce((t, r) => t + r.balanceBags, 0), balanceLbs: sum(rows, (r) => r.balanceLbs), balanceValue: sum(rows, (r) => r.balanceValue) },
    byYarn: [...group.values()].sort((a, b) => a.title.localeCompare(b.title)),
    // the yarn that has gone out, per department: given, used by the department, still with it
    byDepartment: (await require('./storeYarnOutwardService').summary(req, { groupBy: 'department' })).data.map((x) => ({ department: { id: x.key, name: x.label }, outwards: x.outwards, issuedBags: x.issuedBags, issuedLbs: x.issuedLbs, issuedValue: x.issuedValue, usedBags: x.usedBags, balanceBags: x.balanceBags, balanceValue: x.balanceValue })),
    data: rows.slice(start, start + q.limit),
    page: q.page, limit: q.limit, total: rows.length,
  };
}

/**
 * The Yarn Store ledger: every movement of the yarn in date order with a running balance (bags, lbs and value).
 *   INWARD   +  approved yarn inward from a vendor (party = vendor)
 *   OUTWARD  -  yarn given to a department (party = department); `request` says which yarn request it was sent for (empty = a direct outward)
 * Filters: inwardId, vendorId, departmentId (outwards only), yarn (name or brand), dateFrom / dateTo. Rows before dateFrom are summed into `opening`.
 */
async function ledger(req, f) {
  const r = { cid: req.user.companyId };
  const inw = ['i."companyId" = :cid', 'i."deletedAt" IS NULL'];
  if (f.inwardId) { inw.push('i.id = :inwardId'); r.inwardId = f.inwardId; }
  if (f.vendorId) { inw.push('i."vendorId" = :vendorId'); r.vendorId = f.vendorId; }
  if (f.yarn) { inw.push('(i."yarnName" ILIKE :yarn OR i.brand ILIKE :yarn)'); r.yarn = `%${f.yarn}%`; }
  const inwWhere = inw.join(' AND ');
  const dept = f.departmentId ? ' AND o."departmentId" = :departmentId' : '';
  if (f.departmentId) r.departmentId = f.departmentId;
  const moves = await sequelize.query(`
    SELECT * FROM (
      SELECT 'INWARD' AS kind, i."inwardDate"::date AS day, i."createdAt" AS ts, i.id AS "inwardId", i."inwardNo", i."inwardNo" AS "refNo", i."yarnName", i.brand, i.bags AS bags, (i.bags * i."lbsPerBag")::float AS lbs,
        COALESCE(i.amount, 0)::float AS value, v.name AS party, i."dcNo" AS note, NULL::int AS "requestNo"
      FROM store_yarn_inwards i JOIN vendors v ON v.id = i."vendorId" WHERE ${inwWhere} AND i."isApproved" AND ${f.departmentId ? 'false' : 'true'}
      UNION ALL
      SELECT 'OUTWARD', o."outwardDate"::date, o."createdAt", i.id, i."inwardNo", o."outwardNo", i."yarnName", i.brand, l.bags, (l.bags * l."lbsPerBag")::float, l.value::float,
        svc_name(s.id, o."companyId", s.name), o."dcNo", yr."reqNo"
      FROM store_yarn_outward_lines l JOIN store_yarn_outwards o ON o.id = l."outwardId" JOIN services s ON s.id = o."departmentId" JOIN store_yarn_inwards i ON i.id = l."inwardId"
        LEFT JOIN yarn_requests yr ON yr.id = o."requestId" WHERE ${inwWhere}${dept}
    ) m ORDER BY day, ts, kind, "refNo"`, { replacements: r, type: sequelize.QueryTypes.SELECT });
  let opening = { bags: 0, lbs: 0, value: 0 };
  const rows = [];
  for (const m of moves) {
    const day = String(m.day).slice(0, 10);
    if (f.dateFrom && day < f.dateFrom) { const s = m.kind === 'INWARD' ? 1 : -1; opening = { bags: opening.bags + s * m.bags, lbs: r2(opening.lbs + s * m.lbs), value: r2(opening.value + s * m.value) }; continue; }
    if (f.dateTo && day > f.dateTo) continue;
    rows.push(m);
  }
  let run = { ...opening };
  const totals = { inBags: 0, outBags: 0, inLbs: 0, outLbs: 0, inValue: 0, outValue: 0 };
  const data = rows.map((m) => {
    const inn = m.kind === 'INWARD';
    run = { bags: run.bags + (inn ? m.bags : -m.bags), lbs: r2(run.lbs + (inn ? m.lbs : -m.lbs)), value: r2(run.value + (inn ? m.value : -m.value)) };
    totals[inn ? 'inBags' : 'outBags'] += m.bags;
    totals[inn ? 'inLbs' : 'outLbs'] = r2(totals[inn ? 'inLbs' : 'outLbs'] + m.lbs);
    totals[inn ? 'inValue' : 'outValue'] = r2(totals[inn ? 'inValue' : 'outValue'] + m.value);
    return {
      date: String(m.day).slice(0, 10), kind: m.kind, kindText: inn ? 'Yarn inward' : 'Given to department', refText: noText(m.refNo), inwardId: m.inwardId, inwardText: noText(m.inwardNo),
      title: m.brand ? `${m.yarnName} - ${m.brand}` : m.yarnName, party: m.party, note: m.note, request: m.requestNo ? { reqNo: m.requestNo, reqText: noText(m.requestNo) } : null,
      inBags: inn ? m.bags : 0, outBags: inn ? 0 : m.bags, inLbs: inn ? m.lbs : 0, outLbs: inn ? 0 : m.lbs, inValue: inn ? m.value : 0, outValue: inn ? 0 : m.value,
      balanceBags: run.bags, balanceLbs: run.lbs, balanceValue: run.value,
    };
  });
  const start = (f.page - 1) * f.limit;
  return { opening, totals, closing: run, data: data.slice(start, start + f.limit), page: f.page, limit: f.limit, total: data.length };
}

module.exports = { list, get, create, update, remove, setActive, setApproved, formData, nextNumbers, setNextNumbers, stock, ledger };
