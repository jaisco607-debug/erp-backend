// Weaving > Yarn Outward. One entry = one delivery challan (challanNo, the DC#) that takes yarn out of the stock.
// Kinds (type): WEFT (yarn sent to the weft), RETURN, SALE, and SIZING (yarn bags AND empty beams sent to a sizing party, our vendor, on one challan: beams go EMPTY -> AT_SIZING).
// A line takes `bags` from ONE yarn inward entry (a stock entry); lbs = bags x that entry's lbs per bag. The stock of an entry = its bags - what the challans took.
// The balance of the yarn stock (yarnStockService) and of every inward entry follows. Deleting a challan puts its yarn back.
const { Op } = require('sequelize');
const { sequelize, YarnOutward, YarnOutwardLine, YarnOutwardBeam, YarnInward, YarnBeam, Customer, Vendor } = require('../models');
const { STATUS_TEXT: BEAM_TEXT } = require('../models/YarnBeam');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const { usedBags } = require('./yarnUsage');
const inwards = require('./yarnInwardService');

const n2 = (v) => Math.round(Number(v) * 100) / 100;
const challanText = (n) => String(n).padStart(5, '0');
// run inside the caller's transaction (the yarn sale makes the challan and the invoice in one), or in a transaction of its own
const inTx = (outer, fn) => (outer ? fn(outer) : sequelize.transaction(fn));

const INCLUDE = [
  { model: Customer, as: 'customer', paranoid: false, attributes: ['id', 'code', 'name'] },
  { model: Vendor, as: 'vendor', paranoid: false, attributes: ['id', 'code', 'name'] },
  { model: YarnOutwardBeam, as: 'beamRows', include: [{ model: YarnBeam, as: 'beam', paranoid: false }] },
  { model: YarnOutwardLine, as: 'lines', include: [{ model: YarnInward, as: 'inward', paranoid: false, include: inwards.INCLUDE }] },
];

const lineJSON = (l) => {
  const e = l.inward;
  const party = e.vendor || e.customer;
  const it = e.item;
  return {
    id: l.id, inwardId: e.id, inwardCode: e.code, inwardDate: e.inwardDate, dcNo: e.dcNo,
    party: { kind: e.vendorId ? 'VENDOR' : 'CUSTOMER', id: party.id, code: party.code, name: party.name },
    itemId: it.id, name: `${it.yarnCount.name} - ${it.brand.name} - ${it.packing} - ${it.bags}`,
    yarnCount: { id: it.yarnCount.id, name: it.yarnCount.name }, brand: { id: it.brand.id, name: it.brand.name }, packing: it.packing,
    lbsPerBag: Number(e.lbsPerBag), bags: l.bags, lbs: Number(l.lbs),
    // yarn the supplier delivered straight to the sizing party did not leave our factory: it is on the challan but not on the gate pass
    viaFactory: !e.directVendorId,
    ratePerLb: l.ratePerLb == null ? null : Number(l.ratePerLb), amount: l.amount == null ? null : Number(l.amount),
  };
};
/** A sizing challan: the beams on it, and how the bags split: FACTORY bags (on the gate pass) and DIRECT bags (the supplier delivered them to the sizing party). */
function sizingJSON(lines, o) {
  const beams = [...(o.beamRows || [])].map((r) => ({ id: r.beam.id, beamNo: r.beam.beamNo, beamLabel: String(r.beam.beamNo).padStart(5, '0'), name: r.beam.name })).sort((a, b) => a.beamNo - b.beamNo);
  const factoryBags = lines.filter((l) => l.viaFactory).reduce((t, l) => t + l.bags, 0);
  const totalBags = lines.reduce((t, l) => t + l.bags, 0);
  return { beams, totalBeams: beams.length, factoryBags, directBags: totalBags - factoryBags, factoryLbs: n2(lines.filter((l) => l.viaFactory).reduce((t, l) => t + l.lbs, 0)) };
}
const json = (o) => {
  const lines = [...o.lines].sort((a, b) => a.inward.code - b.inward.code).map(lineJSON);
  const p = o.vendor || o.customer; // RETURN: the party the yarn goes back to
  return {
    id: o.id, type: o.type, party: p ? { kind: o.vendorId ? 'VENDOR' : 'CUSTOMER', id: p.id, code: p.code, name: p.name } : null, challanNo: o.challanNo, challanText: challanText(o.challanNo), outwardDate: o.outwardDate, department: o.department, description: o.description,
    totalBags: lines.reduce((t, l) => t + l.bags, 0), totalLbs: n2(lines.reduce((t, l) => t + l.lbs, 0)), totalAmount: o.type === 'SALE' ? n2(lines.reduce((t, l) => t + (l.amount || 0), 0)) : null, lines, createdAt: o.createdAt,
    ...(o.type === 'SIZING' ? sizingJSON(lines, o) : {}),
  };
};

const load = (companyId, id, transaction) => YarnOutward.findOne({ where: { id, companyId }, include: INCLUDE, transaction });
async function findOr404(req, type, id, transaction) {
  const row = await load(req.user.companyId, id, transaction);
  if (!row || row.type !== type) throw AppError.notFound('Yarn outward');
  return row;
}

/** The yarn inward entries with yarn left, for the picker: the user takes any bags from any of them. */
async function stockEntries(req, { search, itemId, type, vendorId, customerId, sizingVendorId }) {
  const where = { companyId: req.user.companyId };
  // yarn the supplier delivered straight to a sizing party can only go out on a SIZING challan of that party; every other picker leaves it out
  where.directVendorId = sizingVendorId ? { [Op.or]: [null, sizingVendorId] } : null;
  if (itemId) where.itemId = itemId;
  if (type === 'PURCHASE') where.vendorId = { [Op.ne]: null };
  if (type === 'OVERHEAD') where.customerId = { [Op.ne]: null };
  if (vendorId) where.vendorId = vendorId;
  if (customerId) where.customerId = customerId;
  if (search) {
    const like = { [Op.iLike]: `%${search.replace(/[\\%_]/g, '\\$&')}%` };
    const or = [{ dcNo: like }, { '$customer.name$': like }, { '$vendor.name$': like }, { '$item.yarnCount.name$': like }, { '$item.brand.name$': like }];
    if (/^\d+$/.test(search)) or.push({ code: Number(search) });
    where[Op.or] = or;
  }
  const rows = await YarnInward.findAll({ where, include: inwards.INCLUDE, order: [['inwardDate', 'ASC'], ['code', 'ASC']] });
  const used = await usedBags(rows.map((r) => r.id));
  const data = rows.map((r) => inwards.json(r, used.get(r.id) || 0)).filter((r) => r.balanceBags > 0)
    .map((r) => ({ ...r, balanceLbs: n2(r.balanceBags * r.lbsPerBag) }));
  return { data, total: data.length };
}

/** Lock the stock entries of the lines, check they are of this company, have the yarn and are not newer than the challan. Answers the line rows to save. */
async function checkLines(req, lines, outwardDate, excludeOutwardId, transaction, party, type, sizingVendorId) {
  const ids = lines.map((l) => l.inwardId).sort();
  const entries = await YarnInward.findAll({ where: { id: ids, companyId: req.user.companyId }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const used = await usedBags(ids, { transaction, excludeOutwardId });
  return lines.map((l, i) => {
    const e = byId.get(l.inwardId);
    if (!e) throw AppError.rule('UNKNOWN_STOCK_ENTRY', 'This yarn inward entry does not exist', { line: i + 1, inwardId: l.inwardId });
    if (party && (party.vendorId ? e.vendorId !== party.vendorId : e.customerId !== party.customerId)) throw AppError.rule('WRONG_PARTY', `Inward entry ${e.code} is not of ${party.name}: a return takes back only the party's own yarn`, { line: i + 1, inwardId: e.id, inwardCode: e.code });
    if (e.directVendorId && type !== 'SIZING') throw AppError.rule('DIRECT_YARN_SIZING_ONLY', `Inward entry ${e.code} was delivered straight to the sizing party: it can only go out on a sizing challan`, { line: i + 1, inwardId: e.id, inwardCode: e.code });
    if (type === 'SIZING' && e.directVendorId && e.directVendorId !== sizingVendorId) throw AppError.rule('DIRECT_OTHER_PARTY', `Inward entry ${e.code} was delivered to another sizing party`, { line: i + 1, inwardId: e.id, inwardCode: e.code });
    if (type === 'SALE' && !e.vendorId) throw AppError.rule('OVERHEAD_NOT_SOLD', `Inward entry ${e.code} is a customer's own (overhead) yarn: it is not ours to sell`, { line: i + 1, inwardId: e.id, inwardCode: e.code });
    if (type === 'SALE' && !(Number(l.ratePerLb) > 0)) throw AppError.rule('RATE_REQUIRED', 'The selling rate per lb is required on every line of a sale', { line: i + 1, field: 'ratePerLb' });
    const balance = e.bags - (used.get(e.id) || 0);
    if (l.bags > balance) throw AppError.rule('NOT_ENOUGH_STOCK', `Only ${balance} bag${balance === 1 ? '' : 's'} left in inward entry ${e.code}`, { line: i + 1, inwardId: e.id, inwardCode: e.code, balanceBags: balance, askedBags: l.bags });
    if (String(e.inwardDate) > String(outwardDate)) throw AppError.rule('BEFORE_INWARD', `The yarn of inward entry ${e.code} came in on ${e.inwardDate}: the challan cannot be dated before it`, { line: i + 1, inwardId: e.id, inwardDate: e.inwardDate });
    const lbs = n2(l.bags * Number(e.lbsPerBag));
    return { inwardId: e.id, bags: l.bags, lbs, ...(type === 'SALE' ? { ratePerLb: Number(l.ratePerLb), amount: n2(lbs * Number(l.ratePerLb)) } : {}) };
  });
}

async function list(req, type, { page, limit, search, dateFrom, dateTo, department, vendorId, customerId }) {
  const rep = { companyId: req.user.companyId, type };
  const where = ['o."companyId" = :companyId', 'o."deletedAt" IS NULL', 'o.type = :type'];
  if (dateFrom) { where.push('o."outwardDate" >= :dateFrom'); rep.dateFrom = dateFrom; }
  if (dateTo) { where.push('o."outwardDate" <= :dateTo'); rep.dateTo = dateTo; }
  if (department) { where.push('o.department ILIKE :dept'); rep.dept = department; }
  if (vendorId) { where.push('o."vendorId" = :vendorId'); rep.vendorId = vendorId; }
  if (customerId) { where.push('o."customerId" = :customerId'); rep.customerId = customerId; }
  if (search) {
    rep.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    rep.num = /^\d+$/.test(search) ? Number(search) : -1;
    where.push(`(o.description ILIKE :like OR o.department ILIKE :like OR o."challanNo" = :num OR EXISTS (SELECT 1 FROM vendors hv2 WHERE hv2.id = o."vendorId" AND hv2.name ILIKE :like) OR EXISTS (SELECT 1 FROM customers hc2 WHERE hc2.id = o."customerId" AND hc2.name ILIKE :like) OR o.id IN (
      SELECT l2."outwardId" FROM yarn_outward_lines l2 JOIN yarn_inwards i2 ON i2.id = l2."inwardId" JOIN yarn_items yi2 ON yi2.id = i2."itemId"
      JOIN yarn_counts yc2 ON yc2.id = yi2."yarnCountId" JOIN yarn_brands yb2 ON yb2.id = yi2."brandId" LEFT JOIN vendors v2 ON v2.id = i2."vendorId" LEFT JOIN customers c2 ON c2.id = i2."customerId"
      WHERE v2.name ILIKE :like OR c2.name ILIKE :like OR yc2.name ILIKE :like OR yb2.name ILIKE :like))`);
  }
  const w = where.join(' AND ');
  const q = (sql, r) => sequelize.query(sql, { replacements: { ...rep, ...r }, type: sequelize.QueryTypes.SELECT });
  const rows = await q(`SELECT o.id, o.type, o."challanNo", o."outwardDate", o.department, o.description, COUNT(l.id)::int AS "lineCount", COALESCE(SUM(l.bags), 0)::int AS "totalBags", COALESCE(SUM(l.lbs), 0)::float AS "totalLbs",
      COALESCE(SUM(l.bags) FILTER (WHERE i."directVendorId" IS NULL), 0)::int AS "factoryBags", (SELECT COUNT(*)::int FROM yarn_outward_beams xb WHERE xb."outwardId" = o.id) AS "totalBeams",
      string_agg(DISTINCT COALESCE(v.name, c.name), ', ') AS parties, string_agg(DISTINCT yb.name, ', ') AS brands, COALESCE(hv.name, hc.name) AS "partyName"
    FROM yarn_outwards o LEFT JOIN vendors hv ON hv.id = o."vendorId" LEFT JOIN customers hc ON hc.id = o."customerId" LEFT JOIN yarn_outward_lines l ON l."outwardId" = o.id LEFT JOIN yarn_inwards i ON i.id = l."inwardId" LEFT JOIN vendors v ON v.id = i."vendorId" LEFT JOIN customers c ON c.id = i."customerId"
    LEFT JOIN yarn_items yi ON yi.id = i."itemId" LEFT JOIN yarn_brands yb ON yb.id = yi."brandId"
    WHERE ${w} GROUP BY o.id, hv.name, hc.name ORDER BY o."outwardDate" DESC, o."challanNo" DESC LIMIT :limit OFFSET :offset`, { limit, offset: (page - 1) * limit });
  const [t] = await q(`SELECT COUNT(DISTINCT o.id)::int AS entries, COALESCE(SUM(l.bags), 0)::int AS bags, COALESCE(SUM(l.lbs), 0)::float AS lbs
    FROM yarn_outwards o LEFT JOIN yarn_outward_lines l ON l."outwardId" = o.id WHERE ${w}`);
  const sizing = type === 'SIZING';
  const [tb] = sizing ? await q(`SELECT COUNT(*)::int AS n FROM yarn_outward_beams xb JOIN yarn_outwards o ON o.id = xb."outwardId" WHERE ${w}`) : [{ n: 0 }];
  return {
    data: rows.map(({ factoryBags, totalBeams, ...r }) => ({ ...r, challanText: challanText(r.challanNo), totalLbs: n2(r.totalLbs), ...(sizing ? { factoryBags, directBags: r.totalBags - factoryBags, totalBeams } : {}) })),
    page, limit, total: t.entries, totals: { entries: t.entries, bags: t.bags, lbs: n2(t.lbs), ...(sizing ? { beams: tb.n } : {}) },
  };
}

const get = async (req, type, id) => json(await findOr404(req, type, id));

/** The party of a RETURN: a vendor or a customer of the weaving list. */
async function partyOf(req, { vendorId, customerId }, transaction) {
  const { companyId } = req.user;
  if (vendorId) {
    const v = await Vendor.findOne({ where: { id: vendorId, companyId, module: 'WEAVING' }, transaction });
    if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'This vendor does not exist', { field: 'vendorId' });
    return { vendorId, name: v.name };
  }
  const c = await Customer.findOne({ where: { id: customerId, companyId, module: 'WEAVING' }, transaction });
  if (!c) throw AppError.rule('UNKNOWN_CUSTOMER', 'This customer does not exist', { field: 'customerId' });
  return { customerId, name: c.name };
}

/** Puts the beams of a sizing challan back where they were (EMPTY) and forgets them. */
async function releaseBeams(outwardId, transaction) {
  const rows = await YarnOutwardBeam.findAll({ where: { outwardId }, transaction });
  for (const r of rows) await YarnBeam.update({ status: r.prevStatus, statusDate: r.prevStatusDate }, { where: { id: r.beamId, status: 'AT_SIZING' }, transaction });
  await YarnOutwardBeam.destroy({ where: { outwardId }, transaction });
}

/** Sends the beams to sizing: each must be an active EMPTY beam of this company, empty since a day not after the challan. EMPTY -> AT_SIZING dated like the challan. */
async function applyBeams(req, outwardId, beamIds, date, transaction) {
  const ids = [...new Set(beamIds)];
  if (!ids.length) return;
  const beams = await YarnBeam.findAll({ where: { id: ids, companyId: req.user.companyId }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
  const byId = new Map(beams.map((b) => [b.id, b]));
  const rows = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) throw AppError.rule('UNKNOWN_BEAM', 'This beam does not exist', { beamId: id });
    if (!b.isActive) throw AppError.rule('BEAM_INACTIVE', `Beam ${b.beamNo} is switched off`, { beamId: id, beamNo: b.beamNo });
    if (b.status !== 'EMPTY') throw AppError.rule('BEAM_NOT_EMPTY', `Beam ${b.beamNo} is not empty (it is ${BEAM_TEXT[b.status].toLowerCase()}): only empty beams go to sizing`, { beamId: id, beamNo: b.beamNo, status: b.status });
    if (String(b.statusDate) > String(date)) throw AppError.rule('BEAM_DATE', `Beam ${b.beamNo} has been empty since ${b.statusDate}: the challan cannot be dated before it`, { beamId: id, beamNo: b.beamNo, since: b.statusDate });
    rows.push({ outwardId, beamId: id, prevStatus: b.status, prevStatusDate: b.statusDate });
  }
  await YarnBeam.update({ status: 'AT_SIZING', statusDate: date }, { where: { id: ids }, transaction });
  await YarnOutwardBeam.bulkCreate(rows, { transaction });
}

/** A sizing challan that sized beams were already received on cannot be changed (only its description) or deleted: delete the receipts first. */
async function assertNoReceipt(outwardId, what, transaction) {
  const [r] = await sequelize.query('SELECT count(*)::int AS n FROM yarn_sizing_inwards WHERE "outwardId" = :outwardId AND "deletedAt" IS NULL', { replacements: { outwardId }, type: sequelize.QueryTypes.SELECT, transaction });
  if (r.n) throw AppError.rule('HAS_SIZING_INWARD', `Sized beams were already received on this challan (${r.n} receipt${r.n === 1 ? '' : 's'}): delete the receipt${r.n === 1 ? '' : 's'} first to ${what}`, { receipts: r.n });
}

const nothingToSend = () => AppError.rule('NOTHING_TO_SEND', 'A sizing challan needs yarn bags, beams, or both');

async function create(req, type, { outwardDate, department, description, lines, vendorId, customerId, beamIds = [] }, opts = {}) {
  const { companyId } = req.user;
  return inTx(opts.transaction, async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`yarn-challan:${companyId}`], transaction });
    const date = outwardDate || today();
    if (type === 'SIZING' && !lines.length && !beamIds.length) throw nothingToSend();
    const party = type === 'RETURN' || type === 'SALE' || type === 'SIZING' ? await partyOf(req, { vendorId, customerId }, transaction) : null;
    // a return takes back only the party's own yarn; a sale sells our purchased yarn to the customer (no match with the customer)
    const rows = await checkLines(req, lines, date, null, transaction, type === 'RETURN' ? party : null, type, type === 'SIZING' ? party.vendorId : null);
    const challanNo = ((await YarnOutward.max('challanNo', { where: { companyId }, paranoid: false, transaction })) || 0) + 1;
    const o = await YarnOutward.create({ companyId, type, challanNo, outwardDate: date, department: department || null, description: description || null, vendorId: party && party.vendorId || null, customerId: party && party.customerId || null, createdById: req.user.id }, { transaction });
    await YarnOutwardLine.bulkCreate(rows.map((r) => ({ ...r, outwardId: o.id })), { transaction });
    if (type === 'SIZING') await applyBeams(req, o.id, beamIds, date, transaction);
    const out = json(await load(companyId, o.id, transaction));
    await audit.log(req, { action: 'YARN_OUTWARD_CREATED', entityType: 'YarnOutward', entityId: o.id, after: out }, { transaction });
    return out;
  });
}

/** Change a challan: date, department, description and/or its lines (the lines sent REPLACE the old ones; the stock is checked as if the old ones were not taken). */
async function update(req, type, id, changes, opts = {}) {
  const { companyId } = req.user;
  return inTx(opts.transaction, async (transaction) => {
    const o = await findOr404(req, type, id, transaction);
    const before = json(o);
    const date = changes.outwardDate || o.outwardDate;
    const set = {};
    for (const f of ['outwardDate', 'department', 'description']) if (changes[f] !== undefined) set[f] = changes[f] === '' ? null : changes[f];
    const sizing = o.type === 'SIZING';
    if (sizing && (changes.lines || changes.outwardDate || changes.beamIds !== undefined)) await assertNoReceipt(id, 'change it', transaction);
    if (changes.lines || changes.outwardDate) {
      const lines = changes.lines || o.lines.map((l) => ({ inwardId: l.inwardId, bags: l.bags, ratePerLb: l.ratePerLb }));
      const party = o.type === 'RETURN' ? { vendorId: o.vendorId, customerId: o.customerId, name: (o.vendor || o.customer).name } : null;
      const rows = await checkLines(req, lines, date, id, transaction, party, o.type, sizing ? o.vendorId : null);
      await YarnOutwardLine.destroy({ where: { outwardId: id }, transaction });
      await YarnOutwardLine.bulkCreate(rows.map((r) => ({ ...r, outwardId: id })), { transaction });
    }
    if (sizing && (changes.beamIds !== undefined || changes.outwardDate)) {
      // the beams of the challan are put back and taken again (so the date, and the beams, may change)
      const keep = changes.beamIds !== undefined ? changes.beamIds : o.beamRows.map((r) => r.beamId);
      await releaseBeams(id, transaction);
      await applyBeams(req, id, keep, date, transaction);
    }
    if (Object.keys(set).length) await YarnOutward.update(set, { where: { id, companyId }, transaction });
    const out = json(await load(companyId, id, transaction));
    if (sizing && !out.lines.length && !out.beams.length) throw nothingToSend();
    await audit.log(req, { action: 'YARN_OUTWARD_UPDATED', entityType: 'YarnOutward', entityId: id, before, after: out }, { transaction });
    return out;
  });
}

/** Deleting a challan puts its yarn back in the stock (the challan number is never used again). */
async function remove(req, type, id, opts = {}) {
  return inTx(opts.transaction, async (transaction) => {
    const o = await findOr404(req, type, id, transaction);
    const before = json(o);
    if (o.type === 'SIZING') await assertNoReceipt(id, 'delete it', transaction);
    if (o.type === 'SIZING') await releaseBeams(id, transaction); // the beams are empty again, where they were
    await YarnOutward.destroy({ where: { id, companyId: req.user.companyId }, transaction });
    await audit.log(req, { action: 'YARN_OUTWARD_DELETED', entityType: 'YarnOutward', entityId: id, before }, { transaction });
    return { deleted: true, id };
  });
}

/**
 * The gate pass of a challan that leaves the factory (RETURN now; sale and sizing later): ONLY the date, the party, the delivery challan number and a signature.
 * It is printed in 3 copies (`copies`); the signature line is drawn by the frontend.
 */
async function gatePass(req, type, id) {
  const o = await findOr404(req, type, id);
  const p = o.vendor || o.customer;
  if (!p) throw AppError.rule('NO_PARTY', 'This challan has no party: a gate pass is made for yarn that leaves for a party');
  // a sizing gate pass also says how many BAGS (only what leaves our factory) and how many BEAMS go; the full details are on the challan
  let extra = {};
  if (o.type === 'SIZING') {
    const j = json(o);
    if (!j.factoryBags && !j.totalBeams) throw AppError.rule('NOTHING_LEAVES', 'Nothing leaves the factory on this challan (the yarn went straight from the supplier and there are no beams): there is no gate pass');
    extra = { bags: j.factoryBags, beams: j.totalBeams };
  }
  return { challanId: o.id, type: o.type, date: o.outwardDate, party: { kind: o.vendorId ? 'VENDOR' : 'CUSTOMER', id: p.id, name: p.name }, partyName: p.name, challanNo: o.challanNo, challanText: challanText(o.challanNo), ...extra, copies: 3 };
}

module.exports = { list, get, create, update, remove, stockEntries, gatePass };
