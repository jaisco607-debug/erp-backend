// Step 3: grey (fabric) inward. Cloth that arrives from a party is entered here and gets a lot number.
// - Every arrival is its own lot: if a party sends 5000 m in three parts (2000, 1500, 1500) on different
//   days, that is three lots. partyRef can hold the party's own order/reference to link them.
// - Cloth that comes back for re-processing is entered here too, with isReprocess = true
//   (optionally pointing to the earlier lot with reprocessOfLotId).
// - Lot no and Type no are given by the server, one after the other, per company.
// - Once approved a lot cannot be edited; only the client admin can take the approval back.
// - Lots are never deleted: switch them off with the active toggle.
const { Op } = require('sequelize');
const { sequelize, GreyLot, Customer, Quality } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');

const LOT = 'grey_lot_no';
const TYPE = 'grey_type_no';
const TYPE_DIGITS = 4; // Type# shows as 0612

const blank = (v) => (v === '' ? null : v);
const blanks = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, blank(v)]));
const typeText = (n) => String(n).padStart(TYPE_DIGITS, '0');

const maxLot = (companyId, transaction) => GreyLot.max('lotNo', { where: { companyId }, paranoid: false, transaction });
const maxType = async (companyId, transaction) => {
  const [row] = await sequelize.query(
    `SELECT max(("typeNo")::int) AS n FROM grey_lots WHERE "companyId" = $1 AND "typeNo" ~ '^[0-9]+$'`,
    { bind: [companyId], type: sequelize.QueryTypes.SELECT, transaction },
  );
  return row.n || 0;
};

const include = [
  { model: Customer, as: 'customer', attributes: ['id', 'code', 'name'], paranoid: false },
  { model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false },
  { model: GreyLot, as: 'reprocessOf', attributes: ['id', 'lotNo'], paranoid: false },
];

function json(l) {
  return {
    id: l.id,
    lotNo: l.lotNo,
    typeNo: l.typeNo,
    dcNo: l.dcNo,
    inwardDate: l.inwardDate,
    customer: l.customer ? { id: l.customer.id, code: l.customer.code, name: l.customer.name } : { id: l.customerId },
    quality: l.quality ? { id: l.quality.id, name: l.quality.name } : { id: l.qualityId },
    inwardMeters: l.inwardMeters,
    pieces: l.pieces,
    outwardMeters: l.outwardMeters,
    balanceMeters: Math.round((l.inwardMeters - l.outwardMeters) * 100) / 100,
    partyRef: l.partyRef,
    vehicleNo: l.vehicleNo,
    remarks: l.remarks,
    isReprocess: l.isReprocess,
    reprocessOf: l.reprocessOf ? { id: l.reprocessOf.id, lotNo: l.reprocessOf.lotNo } : null,
    isApproved: l.isApproved,
    approvedAt: l.approvedAt,
    isActive: l.isActive,
    createdAt: l.createdAt,
  };
}

async function findOr404(req, id, transaction, lock = false) {
  const lot = await GreyLot.findOne({
    where: { id, companyId: req.user.companyId },
    lock: lock ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });
  if (!lot) throw AppError.notFound('Lot');
  return lot;
}

const load = async (id, transaction) => json(await GreyLot.findByPk(id, { include, transaction }));

/** The customer, quality and earlier lot must belong to the same company (and be switched on). */
async function checkLinks(req, data, transaction) {
  const companyId = req.user.companyId;
  if (data.customerId) {
    const c = await Customer.findOne({ where: { id: data.customerId, companyId }, transaction });
    if (!c) throw AppError.rule('UNKNOWN_CUSTOMER', 'Customer not found');
    if (!c.isActive) throw AppError.rule('CUSTOMER_INACTIVE', 'This customer is switched off');
  }
  if (data.qualityId) {
    const q = await Quality.findOne({ where: { id: data.qualityId, companyId }, transaction });
    if (!q) throw AppError.rule('UNKNOWN_QUALITY', 'Quality not found');
    if (!q.isActive) throw AppError.rule('QUALITY_INACTIVE', 'This quality is switched off');
  }
  if (data.reprocessOfLotId) {
    if (!(await GreyLot.findOne({ where: { id: data.reprocessOfLotId, companyId }, transaction }))) {
      throw AppError.rule('UNKNOWN_LOT', 'The earlier lot was not found');
    }
  }
}

async function list(req, q) {
  const where = { companyId: req.user.companyId };
  for (const f of ['isActive', 'isApproved', 'isReprocess', 'customerId', 'qualityId']) if (q[f] !== undefined) where[f] = q[f];
  if (q.dateFrom || q.dateTo) {
    where.inwardDate = {};
    if (q.dateFrom) where.inwardDate[Op.gte] = q.dateFrom;
    if (q.dateTo) where.inwardDate[Op.lte] = q.dateTo;
  }
  if (q.search) {
    const s = `%${q.search}%`;
    const or = [
      { dcNo: { [Op.iLike]: s } }, { typeNo: { [Op.iLike]: s } }, { partyRef: { [Op.iLike]: s } },
      { '$customer.name$': { [Op.iLike]: s } }, { '$quality.name$': { [Op.iLike]: s } },
    ];
    if (/^\d+$/.test(q.search)) or.push({ lotNo: Number(q.search) });
    where[Op.or] = or;
  }
  const { rows, count } = await GreyLot.findAndCountAll({
    where, include, order: [['lotNo', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit, subQuery: false, distinct: true,
  });
  return { data: rows.map(json), page: q.page, limit: q.limit, total: count };
}

async function get(req, id) {
  const lot = await findOr404(req, id);
  return load(lot.id);
}

async function create(req, data) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    if (data.reprocessOfLotId) data.isReprocess = true;
    await checkLinks(req, data, transaction);
    const lotNo = await counters.take(companyId, LOT, async () => ((await maxLot(companyId, transaction)) || 0) + 1, transaction);
    const typeNo = typeText(await counters.take(companyId, TYPE, async () => (await maxType(companyId, transaction)) + 1, transaction));
    const lot = await GreyLot.create({ ...blanks(data), companyId, lotNo, typeNo, createdById: req.user.id }, { transaction });
    const after = await load(lot.id, transaction);
    await audit.log(req, { action: 'GREY_LOT_CREATED', entityType: 'GreyLot', entityId: lot.id, after }, { transaction });
    return after;
  });
}

const EDITABLE = ['dcNo', 'inwardDate', 'customerId', 'qualityId', 'inwardMeters', 'pieces', 'partyRef', 'vehicleNo', 'remarks', 'isReprocess', 'reprocessOfLotId'];

async function update(req, id, changes) {
  return sequelize.transaction(async (transaction) => {
    const lot = await findOr404(req, id, transaction, true);
    if (lot.isApproved) throw AppError.rule('LOT_APPROVED', 'An approved lot cannot be edited');
    if (changes.reprocessOfLotId === lot.id) throw AppError.rule('UNKNOWN_LOT', 'A lot cannot point to itself');
    if (changes.inwardMeters !== undefined && changes.inwardMeters < lot.outwardMeters) {
      throw AppError.rule('BELOW_OUTWARD', `${lot.outwardMeters} m have already gone out of this lot`);
    }
    if (changes.customerId && changes.customerId !== lot.customerId && lot.outwardMeters > 0) {
      throw AppError.rule('LOT_IN_USE', 'Cloth has already gone out of this lot on an SO card; the party cannot change');
    }
    await checkLinks(req, changes, transaction);
    const before = await load(lot.id, transaction);
    for (const f of EDITABLE) if (changes[f] !== undefined) lot[f] = blank(changes[f]);
    if (changes.reprocessOfLotId) lot.isReprocess = true;
    if (changes.isReprocess === false) lot.reprocessOfLotId = null;
    await lot.save({ transaction });
    const after = await load(lot.id, transaction);
    await audit.log(req, { action: 'GREY_LOT_UPDATED', entityType: 'GreyLot', entityId: id, before, after }, { transaction });
    return after;
  });
}

/** The active toggle. */
async function setActive(req, id, isActive) {
  return sequelize.transaction(async (transaction) => {
    const lot = await findOr404(req, id, transaction, true);
    const before = lot.isActive;
    lot.isActive = isActive;
    await lot.save({ transaction });
    await audit.log(req, {
      action: 'GREY_LOT_ACTIVE_CHANGED', entityType: 'GreyLot', entityId: id,
      before: { lotNo: lot.lotNo, isActive: before }, after: { lotNo: lot.lotNo, isActive },
    }, { transaction });
    return load(lot.id, transaction);
  });
}

/** Approve (FULL access) or take the approval back (client admin only, checked in the route). */
async function setApproved(req, id, approved) {
  return sequelize.transaction(async (transaction) => {
    const lot = await findOr404(req, id, transaction, true);
    if (approved && !lot.isActive) throw AppError.rule('LOT_INACTIVE', 'Switch the lot on before approving it');
    lot.isApproved = approved;
    lot.approvedById = approved ? req.user.id : null;
    lot.approvedAt = approved ? new Date() : null;
    await lot.save({ transaction });
    await audit.log(req, {
      action: approved ? 'GREY_LOT_APPROVED' : 'GREY_LOT_UNAPPROVED', entityType: 'GreyLot', entityId: id,
      after: { lotNo: lot.lotNo, isApproved: approved },
    }, { transaction });
    return load(lot.id, transaction);
  });
}

/**
 * Delete: the lot leaves the list but stays in the database, and its number is never reused.
 * Approved lots and lots that cloth has already gone out of cannot be deleted.
 */
async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    const lot = await findOr404(req, id, transaction, true);
    if (lot.isApproved) throw AppError.rule('LOT_APPROVED', 'An approved lot cannot be deleted');
    if (lot.outwardMeters > 0) throw AppError.rule('LOT_IN_USE', 'Cloth has already gone out of this lot');
    const before = await load(lot.id, transaction);
    await lot.destroy({ transaction });
    await audit.log(req, { action: 'GREY_LOT_DELETED', entityType: 'GreyLot', entityId: id, before }, { transaction });
  });
}

/** What the next lot will get (for the form header). */
async function nextNumbers(req) {
  const companyId = req.user.companyId;
  const nextLotNo = await counters.peek(companyId, LOT, async () => ((await maxLot(companyId)) || 0) + 1);
  const nextTypeNo = typeText(await counters.peek(companyId, TYPE, async () => (await maxType(companyId)) + 1));
  return { nextLotNo, nextTypeNo };
}

/**
 * Client admin sets where numbering continues, e.g. to carry on from the old system (next lot 2437).
 * Numbers can never go back to one that is already used.
 */
async function setNextNumbers(req, { nextLotNo, nextTypeNo }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const before = await nextNumbers(req);
    if (nextLotNo !== undefined) {
      const used = (await maxLot(companyId, transaction)) || 0;
      if (nextLotNo <= used) throw AppError.rule('NUMBER_USED', `Lot ${used} is already used; next lot must be above it`);
      await counters.set(companyId, LOT, nextLotNo, transaction);
    }
    if (nextTypeNo !== undefined) {
      const used = await maxType(companyId, transaction);
      if (nextTypeNo <= used) throw AppError.rule('NUMBER_USED', `Type ${typeText(used)} is already used; next type must be above it`);
      await counters.set(companyId, TYPE, nextTypeNo, transaction);
    }
    const after = {
      nextLotNo: nextLotNo ?? before.nextLotNo,
      nextTypeNo: nextTypeNo !== undefined ? typeText(nextTypeNo) : before.nextTypeNo,
    };
    await audit.log(req, { action: 'GREY_NUMBERING_CHANGED', entityType: 'Company', entityId: companyId, before, after }, { transaction });
    return after;
  });
}

module.exports = { list, get, create, update, remove, setActive, setApproved, nextNumbers, setNextNumbers };
