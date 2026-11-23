// Weaving > Sizing Inward. The sized beams come back from the sizing party (our vendor) against a SIZING challan (yarn outward).
//   For every beam received the user writes the METERS of sized yarn on it; the beam goes AT_SIZING -> FULL (dated like the receipt) and carries the meters.
//   lbsUsed    the lbs of the yarn that went into the sizing: the party charges per lb on THESE only  (sizing charge = lbsUsed x ratePerLb)
//   cutConeKg  the leftover yarn the party gives back (cut cone), weighed in kg; cutConeLbs is the same weight in lbs (information: it is not charged)
// A challan may be received in parts: each receipt takes some of its beams still at sizing, and its lbsUsed together cannot be more than the lbs sent on the challan.
// A receipt can be changed or deleted while its beams are still FULL (not moved on); deleting puts the beams back at sizing.
const { Op } = require('sequelize');
const { sequelize, YarnSizingInward, YarnSizingInwardBeam, YarnOutward, YarnBeam, Vendor } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');

const KG_TO_LB = 2.20462262;
const n2 = (v) => Math.round(Number(v) * 100) / 100;
const text = (n) => String(n).padStart(5, '0');
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });

/** Map receiptId -> the purchase invoice (accounts) the receipt is on: { id, voucherNo, voucherLabel, status }. */
async function invoicesOf(ids, transaction) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await q('SELECT s."inwardId", p.id, p."voucherNo", p.status FROM purchase_invoice_sizing_inwards s JOIN purchase_invoices p ON p.id = s."invoiceId" WHERE s."inwardId" IN (:ids)', { ids }, transaction);
  for (const r of rows) map.set(r.inwardId, { id: r.id, voucherNo: r.voucherNo, voucherLabel: text(r.voucherNo), status: r.status });
  return map;
}
const onInvoice = (inv) => AppError.rule('ON_PURCHASE_INVOICE', `This receipt is on purchase invoice ${inv.voucherLabel}: delete that invoice first to change it (only the DC no and description can change)`, { invoiceId: inv.id, voucherNo: inv.voucherNo });

const INCLUDE = [
  { model: Vendor, as: 'vendor', paranoid: false, attributes: ['id', 'code', 'name'] },
  { model: YarnOutward, as: 'outward', paranoid: false, attributes: ['id', 'challanNo', 'outwardDate', 'description'] },
  { model: YarnSizingInwardBeam, as: 'beamRows', include: [{ model: YarnBeam, as: 'beam', paranoid: false }] },
];

const json = (r, extra = {}) => {
  const beams = [...r.beamRows].map((b) => ({ id: b.beam.id, beamNo: b.beam.beamNo, beamLabel: text(b.beam.beamNo), name: b.beam.name, meters: Number(b.meters) })).sort((a, b) => a.beamNo - b.beamNo);
  return {
    id: r.id, inwardNo: r.inwardNo, inwardLabel: text(r.inwardNo), inwardDate: r.inwardDate, dcNo: r.dcNo, description: r.description,
    party: { id: r.vendor.id, code: r.vendor.code, name: r.vendor.name },
    challan: { id: r.outward.id, challanNo: r.outward.challanNo, challanText: text(r.outward.challanNo), outwardDate: r.outward.outwardDate },
    beams, totalBeams: beams.length, totalMeters: n2(beams.reduce((t, b) => t + b.meters, 0)),
    lbsUsed: Number(r.lbsUsed), cutConeKg: Number(r.cutConeKg), cutConeLbs: Number(r.cutConeLbs), ratePerLb: Number(r.ratePerLb), amount: Number(r.amount),
    // billed in the accounts (a sizing purchase invoice): the receipt is then locked
    purchaseInvoice: extra.purchaseInvoice || null, invoiced: Boolean(extra.purchaseInvoice),
    createdAt: r.createdAt, ...extra,
  };
};

const load = (companyId, id, transaction) => YarnSizingInward.findOne({ where: { id, companyId }, include: INCLUDE, transaction });
async function findOr404(req, id, transaction) {
  const row = await load(req.user.companyId, id, transaction);
  if (!row) throw AppError.notFound('Sizing inward');
  return row;
}

/** The yarn the challan sent (lbs, all lines) and what the receipts already used (lbsUsed), leaving `excludeId` out. */
async function yarnOf(outwardId, excludeId, transaction) {
  const [s] = await q('SELECT COALESCE(SUM(lbs), 0)::float AS lbs, COALESCE(SUM(bags), 0)::int AS bags FROM yarn_outward_lines WHERE "outwardId" = :outwardId', { outwardId }, transaction);
  const [u] = await q(`SELECT COALESCE(SUM("lbsUsed"), 0)::float AS used, COALESCE(SUM("cutConeLbs"), 0)::float AS cut FROM yarn_sizing_inwards WHERE "outwardId" = :outwardId AND "deletedAt" IS NULL${excludeId ? ' AND id <> :excludeId' : ''}`, { outwardId, excludeId }, transaction);
  return { sentLbs: n2(s.lbs), sentBags: s.bags, usedLbs: n2(u.used), cutConeLbs: n2(u.cut), remainingLbs: n2(s.lbs - u.used) };
}

/** The beams of a challan that have NOT been received yet (still at sizing). */
async function pendingBeams(outwardId, excludeInwardId, transaction) {
  return q(`SELECT b.id, b."beamNo", b.name, b.status, b."statusDate" FROM yarn_outward_beams x JOIN yarn_beams b ON b.id = x."beamId" AND b."deletedAt" IS NULL
    WHERE x."outwardId" = :outwardId AND NOT EXISTS (SELECT 1 FROM yarn_sizing_inward_beams ib JOIN yarn_sizing_inwards i ON i.id = ib."inwardId" AND i."deletedAt" IS NULL
      WHERE ib."beamId" = x."beamId" AND i."outwardId" = x."outwardId"${excludeInwardId ? ' AND i.id <> :excludeInwardId' : ''}) ORDER BY b."beamNo"`, { outwardId, excludeInwardId }, transaction);
}

/** GET /sizing-inwards/challans?vendorId= : the sizing challans that still wait for their beams (or have yarn not accounted for), with what is pending. */
async function challans(req, { vendorId, search }) {
  const rows = await q(`SELECT o.id, o."challanNo", to_char(o."outwardDate", 'YYYY-MM-DD') AS "outwardDate", o.description, v.id AS "vendorId", v.name AS "vendorName"
    FROM yarn_outwards o JOIN vendors v ON v.id = o."vendorId" WHERE o."companyId" = :companyId AND o.type = 'SIZING' AND o."deletedAt" IS NULL${vendorId ? ' AND o."vendorId" = :vendorId' : ''} ORDER BY o."challanNo" DESC`,
  { companyId: req.user.companyId, vendorId });
  const out = [];
  for (const o of rows) {
    const beams = await pendingBeams(o.id);
    const yarn = await yarnOf(o.id);
    if (!beams.length) continue; // every beam is back: nothing to receive
    const item = {
      id: o.id, challanNo: o.challanNo, challanText: text(o.challanNo), outwardDate: o.outwardDate, description: o.description, party: { id: o.vendorId, name: o.vendorName },
      sentBags: yarn.sentBags, sentLbs: yarn.sentLbs, usedLbs: yarn.usedLbs, remainingLbs: yarn.remainingLbs,
      pendingBeams: beams.map((b) => ({ id: b.id, beamNo: b.beamNo, beamLabel: text(b.beamNo), name: b.name, sentOn: b.statusDate })), pendingCount: beams.length,
    };
    if (search) {
      const s = search.trim().toLowerCase();
      if (!(String(o.challanNo) === s || o.vendorName.toLowerCase().includes(s) || (o.description || '').toLowerCase().includes(s) || beams.some((b) => b.name.toLowerCase().includes(s) || String(b.beamNo) === s))) continue;
    }
    out.push(item);
  }
  return { data: out, total: out.length };
}

async function list(req, { page, limit, search, vendorId, outwardId, dateFrom, dateTo }) {
  const where = { companyId: req.user.companyId };
  if (vendorId) where.vendorId = vendorId;
  if (outwardId) where.outwardId = outwardId;
  if (dateFrom || dateTo) where.inwardDate = { ...(dateFrom ? { [Op.gte]: dateFrom } : {}), ...(dateTo ? { [Op.lte]: dateTo } : {}) };
  if (search) {
    const like = { [Op.iLike]: `%${search.replace(/[\\%_]/g, '\\$&')}%` };
    const or = [{ dcNo: like }, { description: like }, { '$vendor.name$': like }];
    if (/^\d+$/.test(search)) or.push({ inwardNo: Number(search) }, { '$outward.challanNo$': Number(search) });
    where[Op.or] = or;
  }
  // the page is chosen on the one-to-one joins (so the search can look at the party and the challan), then loaded with its beams
  const belongs = [{ model: Vendor, as: 'vendor', attributes: [] }, { model: YarnOutward, as: 'outward', attributes: [], paranoid: false }];
  const { rows: idRows, count } = await YarnSizingInward.findAndCountAll({ where, include: belongs, attributes: ['id'], order: [['inwardDate', 'DESC'], ['inwardNo', 'DESC']], limit, offset: (page - 1) * limit, raw: true });
  const loaded = idRows.length ? await YarnSizingInward.findAll({ where: { id: idRows.map((r) => r.id) }, include: INCLUDE }) : [];
  const rows = idRows.map((r) => loaded.find((x) => x.id === r.id));
  const all = await YarnSizingInward.findAll({ where, include: [{ model: Vendor, as: 'vendor', attributes: [] }, { model: YarnOutward, as: 'outward', attributes: [], paranoid: false }], attributes: ['id', 'lbsUsed', 'cutConeKg', 'amount'], raw: true });
  const ids = all.map((a) => a.id);
  const [b] = ids.length ? await q('SELECT COUNT(*)::int AS beams, COALESCE(SUM(meters), 0)::float AS meters FROM yarn_sizing_inward_beams WHERE "inwardId" IN (:ids)', { ids }) : [{ beams: 0, meters: 0 }];
  const sum = (k) => n2(all.reduce((t, a) => t + Number(a[k]), 0));
  const inv = await invoicesOf(rows.map((r) => r.id));
  return { data: rows.map((r) => json(r, { purchaseInvoice: inv.get(r.id) || null })), page, limit, total: count, totals: { entries: count, beams: b.beams, meters: n2(b.meters), lbsUsed: sum('lbsUsed'), cutConeKg: sum('cutConeKg'), amount: sum('amount') } };
}

async function get(req, id) {
  const r = await findOr404(req, id);
  const yarn = await yarnOf(r.outwardId);
  return json(r, { sentLbs: yarn.sentLbs, remainingLbs: yarn.remainingLbs, purchaseInvoice: (await invoicesOf([id])).get(id) || null });
}

/** Puts the beams of a receipt back at sizing (only while they are still FULL: a beam that moved on cannot be undone). */
async function releaseBeams(inwardId, transaction) {
  const rows = await YarnSizingInwardBeam.findAll({ where: { inwardId }, include: [{ model: YarnBeam, as: 'beam', paranoid: false }], transaction });
  for (const r of rows) {
    if (r.beam.status !== 'FULL') throw AppError.rule('BEAM_MOVED_ON', `Beam ${r.beam.beamNo} is not full any more (it is ${r.beam.status.toLowerCase().replace('_', ' ')}): this receipt cannot be changed or deleted`, { beamNo: r.beam.beamNo, status: r.beam.status });
    await YarnBeam.update({ status: 'AT_SIZING', statusDate: r.prevStatusDate, meters: null }, { where: { id: r.beamId }, transaction });
  }
  await YarnSizingInwardBeam.destroy({ where: { inwardId }, transaction });
}

/** Receives the beams: each must be a beam of the challan still at sizing; AT_SIZING -> FULL dated like the receipt, with its meters. */
async function applyBeams(outward, inwardId, beams, date, transaction, excludeInwardId) {
  const pending = new Map((await pendingBeams(outward.id, excludeInwardId, transaction)).map((b) => [b.id, b]));
  const ids = beams.map((b) => b.beamId).sort();
  const locked = await YarnBeam.findAll({ where: { id: ids }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
  const byId = new Map(locked.map((b) => [b.id, b]));
  const rows = [];
  for (const [i, b] of beams.entries()) {
    const p = pending.get(b.beamId);
    const beam = byId.get(b.beamId);
    if (!p || !beam) throw AppError.rule('BEAM_NOT_ON_CHALLAN', 'This beam is not waiting at sizing on this challan (it may be received already)', { line: i + 1, beamId: b.beamId });
    if (beam.status !== 'AT_SIZING') throw AppError.rule('BEAM_NOT_AT_SIZING', `Beam ${beam.beamNo} is not at sizing`, { line: i + 1, beamId: b.beamId, beamNo: beam.beamNo, status: beam.status });
    if (String(beam.statusDate) > String(date)) throw AppError.rule('BEFORE_OUTWARD', `Beam ${beam.beamNo} went to sizing on ${beam.statusDate}: it cannot come back before that`, { line: i + 1, beamNo: beam.beamNo, sentOn: beam.statusDate });
    rows.push({ inwardId, beamId: b.beamId, meters: n2(b.meters), prevStatusDate: beam.statusDate });
  }
  for (const r of rows) await YarnBeam.update({ status: 'FULL', statusDate: date, meters: r.meters }, { where: { id: r.beamId }, transaction });
  await YarnSizingInwardBeam.bulkCreate(rows, { transaction });
}

/** The lbs of the receipt must fit in what the challan sent. */
async function checkYarn(outwardId, lbsUsed, excludeId, transaction) {
  // the same yarn must not be counted twice: once it is tagged to a Sizing Batch or sent back in a Sizing Return, this old receipt cannot use it
  const [tagged] = await q(`SELECT 1 AS x FROM yarn_outward_lines l
    WHERE l."outwardId" = :outwardId AND (EXISTS (SELECT 1 FROM sizing_batch_yarns y JOIN sizing_batches b ON b.id = y."batchId" AND b."deletedAt" IS NULL WHERE y."inwardId" = l."inwardId")
      OR EXISTS (SELECT 1 FROM sizing_return_yarns ry WHERE ry."inwardId" = l."inwardId")) LIMIT 1`, { outwardId }, transaction);
  if (tagged && lbsUsed > 0) throw AppError.rule('YARN_IN_NEW_SIZING', 'The yarn of this challan is already tagged to a Sizing Batch or a Sizing Return: it cannot be received here again', { field: 'lbsUsed' });
  const y = await yarnOf(outwardId, excludeId, transaction);
  if (lbsUsed > y.remainingLbs + 0.0001) throw AppError.rule('MORE_THAN_SENT', `The challan sent ${y.sentLbs} lbs and ${y.usedLbs} lbs are already used: only ${y.remainingLbs} lbs are left to use`, { field: 'lbsUsed', sentLbs: y.sentLbs, usedLbs: y.usedLbs, remainingLbs: y.remainingLbs });
}

const money = (lbsUsed, rate) => n2(Number(lbsUsed) * Number(rate));
const coneLbs = (kg) => n2(Number(kg) * KG_TO_LB);

async function create(req, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`sizing-inward:${companyId}`], transaction });
    const outward = await YarnOutward.findOne({ where: { id: data.outwardId, companyId, type: 'SIZING' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!outward) throw AppError.rule('UNKNOWN_CHALLAN', 'This sizing challan does not exist', { field: 'outwardId' });
    const date = data.inwardDate || today();
    if (String(date) < String(outward.outwardDate)) throw AppError.rule('BEFORE_OUTWARD', `The challan went out on ${outward.outwardDate}: the receipt cannot be dated before it`, { outwardDate: outward.outwardDate });
    await checkYarn(outward.id, data.lbsUsed, null, transaction);
    const inwardNo = ((await YarnSizingInward.max('inwardNo', { where: { companyId }, paranoid: false, transaction })) || 0) + 1;
    const row = await YarnSizingInward.create({
      companyId, inwardNo, inwardDate: date, outwardId: outward.id, vendorId: outward.vendorId, lbsUsed: data.lbsUsed, cutConeKg: data.cutConeKg || 0, cutConeLbs: coneLbs(data.cutConeKg || 0),
      ratePerLb: data.ratePerLb, amount: money(data.lbsUsed, data.ratePerLb), dcNo: data.dcNo || null, description: data.description || null, createdById: req.user.id,
    }, { transaction });
    await applyBeams(outward, row.id, data.beams, date, transaction, null);
    const out = json(await load(companyId, row.id, transaction));
    await audit.log(req, { action: 'YARN_SIZING_INWARD_CREATED', entityType: 'YarnSizingInward', entityId: row.id, after: out }, { transaction });
    return out;
  });
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`sizing-inward:${companyId}`], transaction });
    const row = await findOr404(req, id, transaction);
    const before = json(row);
    const invoice = (await invoicesOf([id], transaction)).get(id);
    if (invoice && Object.keys(changes).some((k) => !['dcNo', 'description'].includes(k))) throw onInvoice(invoice);
    // only text changed: nothing about the beams, the lbs or the money is touched
    if (Object.keys(changes).every((k) => ['dcNo', 'description'].includes(k))) {
      const set = {};
      for (const f of ['dcNo', 'description']) if (changes[f] !== undefined) set[f] = changes[f] === '' ? null : changes[f];
      await YarnSizingInward.update(set, { where: { id, companyId }, transaction });
      return json(await load(companyId, id, transaction), { purchaseInvoice: invoice || null });
    }
    const outward = await YarnOutward.findOne({ where: { id: row.outwardId }, paranoid: false, transaction });
    const date = changes.inwardDate || row.inwardDate;
    if (String(date) < String(outward.outwardDate)) throw AppError.rule('BEFORE_OUTWARD', `The challan went out on ${outward.outwardDate}: the receipt cannot be dated before it`, { outwardDate: outward.outwardDate });
    const lbsUsed = changes.lbsUsed !== undefined ? changes.lbsUsed : Number(row.lbsUsed);
    const kg = changes.cutConeKg !== undefined ? changes.cutConeKg : Number(row.cutConeKg);
    const rate = changes.ratePerLb !== undefined ? changes.ratePerLb : Number(row.ratePerLb);
    await checkYarn(outward.id, lbsUsed, id, transaction);
    // the beams (and their meters / date) are put back at sizing and received again
    const beams = changes.beams || row.beamRows.map((b) => ({ beamId: b.beamId, meters: Number(b.meters) }));
    await releaseBeams(id, transaction);
    await applyBeams(outward, id, beams, date, transaction, id);
    const set = { inwardDate: date, lbsUsed, cutConeKg: kg, cutConeLbs: coneLbs(kg), ratePerLb: rate, amount: money(lbsUsed, rate) };
    for (const f of ['dcNo', 'description']) if (changes[f] !== undefined) set[f] = changes[f] === '' ? null : changes[f];
    await YarnSizingInward.update(set, { where: { id, companyId }, transaction });
    const out = json(await load(companyId, id, transaction), { purchaseInvoice: invoice || null });
    await audit.log(req, { action: 'YARN_SIZING_INWARD_UPDATED', entityType: 'YarnSizingInward', entityId: id, before, after: out }, { transaction });
    return out;
  });
}

/** Deleting a receipt puts its beams back at sizing (with their old date) and gives the lbs back to the challan. */
async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(req, id, transaction);
    const invoice = (await invoicesOf([id], transaction)).get(id);
    if (invoice) throw onInvoice(invoice);
    const before = json(row);
    await releaseBeams(id, transaction);
    await YarnSizingInward.destroy({ where: { id, companyId: req.user.companyId }, transaction });
    await audit.log(req, { action: 'YARN_SIZING_INWARD_DELETED', entityType: 'YarnSizingInward', entityId: id, before }, { transaction });
    return { deleted: true, id };
  });
}

module.exports = { list, get, create, update, remove, challans, KG_TO_LB };
