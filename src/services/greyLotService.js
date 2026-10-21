// Step 3: grey (fabric) inward. Cloth that arrives from a party is entered here and gets a lot number.
// - Every arrival is its own lot: if a party sends 5000 m in three parts (2000, 1500, 1500) on different
//   days, that is three lots. partyRef can hold the party's own order/reference to link them.
// - Cloth that comes back for re-processing is entered here too, with isReprocess = true
//   (optionally pointing to the earlier lot with reprocessOfLotId).
// - Lot no and Type no are given by the server, one after the other, per company.
// - Once approved a lot cannot be edited; only the client admin can take the approval back.
// - Lots are never deleted: switch them off with the active toggle.
const { Op } = require('sequelize');
const { sequelize, GreyLot, GreyLotThaan, GreyReturn, Customer, Quality } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const counters = require('./counterService');

const LOT = 'grey_lot_no';
const TYPE = 'grey_type_no';
const TYPE_DIGITS = 4; // Type# shows as 0612

const RETURN = 'grey_return_no';
const YARD = 0.9144; // 1 yard = 0.9144 meter
const { round: r2 } = require('../utils/money');
const toMeters = (qty, unit) => r2(unit === 'YARD' ? qty * YARD : qty);
const toYards = (meters) => r2(meters / YARD);

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
  // yards are shown only for cloth that came in yards; meter lots show meters only
  const yd = (v) => (l.unit === 'YARD' ? v : null);
  return {
    id: l.id,
    lotNo: l.lotNo,
    typeNo: l.typeNo,
    dcNo: l.dcNo,
    inwardDate: l.inwardDate,
    customer: l.customer ? { id: l.customer.id, code: l.customer.code, name: l.customer.name } : { id: l.customerId },
    quality: l.quality ? { id: l.quality.id, name: l.quality.name } : { id: l.qualityId },
    unit: l.unit,
    inwardMeters: l.inwardMeters,
    showYards: l.unit === 'YARD',
    inwardYards: yd(l.inwardYards),
    pieces: l.pieces,
    outwardMeters: l.outwardMeters,
    balanceMeters: r2(l.inwardMeters - l.outwardMeters),
    balanceYards: yd(toYards(l.inwardMeters - l.outwardMeters)),
    soCardMeters: r2(l.outwardMeters - l.returnedMeters),
    returnedMeters: l.returnedMeters,
    returnedYards: yd(toYards(l.returnedMeters)),
    returnedPieces: l.returnedPieces,
    partyRef: l.partyRef,
    glm: l.glm,
    gsm: l.gsm,
    vehicleNo: l.vehicleNo,
    remarks: l.remarks,
    isReprocess: l.isReprocess,
    reprocessOf: l.reprocessOf ? { id: l.reprocessOf.id, lotNo: l.reprocessOf.lotNo } : null,
    isApproved: l.isApproved,
    approvedAt: l.approvedAt,
    isActive: l.isActive,
    createdAt: l.createdAt,
    ...(l.thaans && {
      thaans: [...l.thaans].sort((a, b) => a.thaanNo - b.thaanNo).map((t) => ({ id: t.id, thaanNo: t.thaanNo, meters: t.meters, yards: yd(t.yards), status: t.status, takenMeters: t.takenMeters, freeMeters: t.status === 'RETURNED' ? 0 : r2(t.meters - t.takenMeters) })),
    }),
    ...(l.returns && {
      returns: [...l.returns].sort((a, b) => a.returnNo - b.returnNo).map((r) => ({
        id: r.id, returnNo: r.returnNo, returnDate: r.returnDate, pieces: r.pieces, meters: r.meters, yards: yd(r.yards), vehicleNo: r.vehicleNo, remarks: r.remarks,
      })),
    }),
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

const fullInclude = [...include, { model: GreyLotThaan, as: 'thaans' }, { model: GreyReturn, as: 'returns' }];
/**
 * Fabric returns (grey cloth going back to the party through Folding and Packing) are not on SO cards:
 * soCardMeters leaves them out and they are shown as fabricReturnMeters.
 */
async function attachFabricReturn(items, transaction) {
  if (!items.length) return items;
  const rows = await sequelize.query(
    `SELECT l."greyLotId" AS id, SUM(l.meters)::float AS meters FROM so_card_lots l JOIN so_cards s ON s.id = l."soCardId" AND s."deletedAt" IS NULL
      WHERE s."isGreyReturn" AND l."greyLotId" IN (:ids) GROUP BY l."greyLotId"`,
    { replacements: { ids: items.map((i) => i.id) }, type: sequelize.QueryTypes.SELECT, transaction },
  );
  const by = new Map(rows.map((r) => [r.id, r.meters]));
  return items.map((i) => {
    const fr = r2(by.get(i.id) || 0);
    return { ...i, soCardMeters: r2(i.soCardMeters - fr), fabricReturnMeters: fr };
  });
}

const load = async (id, transaction) => (await attachFabricReturn([json(await GreyLot.findByPk(id, { include: fullInclude, transaction }))], transaction))[0];

/**
 * Quantity of a lot from the form:
 *   thaans: [52.5, 48, 50.25 ...]  length of every thaan, in `unit`  (pieces and total are worked out)
 *   or a plain total: inwardMeters (unit METER) / inwardYards (unit YARD) + pieces, for lots without a thaan list
 * Returns the lot fields and the thaan rows, both in meters and yards.
 */
function quantities(data, current = {}) {
  const unit = data.unit || current.unit || 'METER';
  if (data.thaans) {
    const thaans = data.thaans.map((len, i) => ({ thaanNo: i + 1, meters: toMeters(len, unit), yards: unit === 'YARD' ? r2(len) : toYards(len) }));
    return {
      lot: { unit, pieces: thaans.length, inwardMeters: r2(thaans.reduce((t, x) => t + x.meters, 0)), inwardYards: r2(thaans.reduce((t, x) => t + x.yards, 0)) },
      thaans,
    };
  }
  const lot = { unit };
  if (unit === 'YARD' && data.inwardYards !== undefined) Object.assign(lot, { inwardYards: r2(data.inwardYards), inwardMeters: toMeters(data.inwardYards, 'YARD') });
  else if (data.inwardMeters !== undefined) Object.assign(lot, { inwardMeters: r2(data.inwardMeters), inwardYards: toYards(data.inwardMeters) });
  if (data.pieces !== undefined) lot.pieces = data.pieces;
  return { lot, thaans: null };
}
const QTY_FIELDS = ['unit', 'thaans', 'inwardMeters', 'inwardYards', 'pieces'];
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

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

/**
 * Quality typed by hand (qualityName) instead of picked from the dropdown: the existing quality
 * with that name is used (any letter case), otherwise a new one is added to the list.
 */
async function resolveQuality(req, data, transaction) {
  if (!data.qualityName) return;
  const name = data.qualityName.trim();
  let q = await Quality.findOne({ where: { companyId: req.user.companyId, [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), name.toLowerCase())] }, transaction });
  if (q && !q.isActive) throw AppError.rule('QUALITY_INACTIVE', 'This quality is switched off');
  if (!q) {
    q = await Quality.create({ companyId: req.user.companyId, name, createdById: req.user.id }, { transaction });
    await audit.log(req, { action: 'QUALITY_CREATED', entityType: 'Quality', entityId: q.id, after: { id: q.id, name, from: 'grey inward' } }, { transaction });
  }
  data.qualityId = q.id;
  delete data.qualityName;
}

/** Lot# typed by hand: must be free (also not used by a deleted lot); the auto number then continues after it. */
async function takeTypedLotNo(req, lotNo, transaction, exceptId) {
  const companyId = req.user.companyId;
  const where = { companyId, lotNo };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  if (await GreyLot.findOne({ where, paranoid: false, transaction })) throw AppError.rule('LOT_NO_TAKEN', `Lot ${lotNo} already exists`);
  const next = await counters.peek(companyId, LOT, async () => ((await maxLot(companyId, transaction)) || 0) + 1, transaction);
  if (lotNo >= next) await counters.set(companyId, LOT, lotNo + 1, transaction);
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
  return { data: await attachFabricReturn(rows.map(json)), page: q.page, limit: q.limit, total: count };
}

async function get(req, id) {
  const lot = await findOr404(req, id);
  return load(lot.id);
}

async function create(req, data) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    if (data.reprocessOfLotId) data.isReprocess = true;
    await resolveQuality(req, data, transaction);
    if (!data.qualityId) throw AppError.rule('QUALITY_REQUIRED', 'Pick or type the quality');
    await checkLinks(req, data, transaction);
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`grey-lot-no:${companyId}`], transaction });
    if (data.lotNo) await takeTypedLotNo(req, data.lotNo, transaction);
    const lotNo = data.lotNo || await counters.take(companyId, LOT, async () => ((await maxLot(companyId, transaction)) || 0) + 1, transaction);
    const typeNo = typeText(await counters.take(companyId, TYPE, async () => (await maxType(companyId, transaction)) + 1, transaction));
    const q = quantities(data);
    if (q.lot.inwardMeters === undefined || q.lot.pieces === undefined) throw AppError.rule('QTY_REQUIRED', 'Enter the thaans, or the total quantity and pieces');
    const lot = await GreyLot.create({ ...blanks(without(data, [...QTY_FIELDS, 'lotNo'])), ...q.lot, companyId, lotNo, typeNo, createdById: req.user.id }, { transaction });
    if (q.thaans) await GreyLotThaan.bulkCreate(q.thaans.map((t) => ({ ...t, lotId: lot.id })), { transaction });
    const after = await load(lot.id, transaction);
    await audit.log(req, { action: 'GREY_LOT_CREATED', entityType: 'GreyLot', entityId: lot.id, after }, { transaction });
    return after;
  });
}

const EDITABLE = ['typeNo', 'dcNo', 'inwardDate', 'customerId', 'qualityId', 'partyRef', 'glm', 'gsm', 'vehicleNo', 'remarks', 'isReprocess', 'reprocessOfLotId'];

async function update(req, id, changes) {
  return sequelize.transaction(async (transaction) => {
    const lot = await findOr404(req, id, transaction, true);
    if (lot.isApproved) throw AppError.rule('LOT_APPROVED', 'An approved lot cannot be edited');
    if (changes.reprocessOfLotId === lot.id) throw AppError.rule('UNKNOWN_LOT', 'A lot cannot point to itself');
    const q = QTY_FIELDS.some((f) => changes[f] !== undefined) ? quantities(changes, lot) : null;
    if (q && q.lot.inwardMeters !== undefined && q.lot.inwardMeters < lot.outwardMeters) {
      throw AppError.rule('BELOW_OUTWARD', `${lot.outwardMeters} m have already gone out of this lot`);
    }
    if (changes.customerId && changes.customerId !== lot.customerId && lot.outwardMeters > 0) {
      throw AppError.rule('LOT_IN_USE', 'Cloth has already gone out of this lot on an SO card; the party cannot change');
    }
    await resolveQuality(req, changes, transaction);
    await checkLinks(req, changes, transaction);
    if (changes.typeNo !== undefined && changes.typeNo !== lot.typeNo
      && (await GreyLot.findOne({ where: { companyId: req.user.companyId, typeNo: changes.typeNo, id: { [Op.ne]: lot.id } }, paranoid: false, transaction }))) {
      throw AppError.rule('TYPE_NO_TAKEN', `Type# ${changes.typeNo} already exists`);
    }
    if (changes.lotNo !== undefined && changes.lotNo !== lot.lotNo) {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`grey-lot-no:${req.user.companyId}`], transaction });
      await takeTypedLotNo(req, changes.lotNo, transaction, lot.id);
    }
    // a lot made of thaans keeps its total equal to its thaans: change the thaans, not a plain total
    if (q && !q.thaans && (await GreyLotThaan.count({ where: { lotId: lot.id }, transaction })) > 0 && (changes.inwardMeters !== undefined || changes.inwardYards !== undefined || changes.pieces !== undefined)) {
      throw AppError.rule('LOT_HAS_THAANS', 'This lot is made of thaans: send the thaans list again instead of a total');
    }
    const before = await load(lot.id, transaction);
    if (changes.lotNo !== undefined) lot.lotNo = changes.lotNo;
    for (const f of EDITABLE) if (changes[f] !== undefined) lot[f] = blank(changes[f]);
    if (q) {
      Object.assign(lot, q.lot);
      if (q.thaans) {
        // thaans given back or put on an SO card must stay as they are (same number and length)
        const old = await GreyLotThaan.findAll({ where: { lotId: lot.id }, transaction });
        const byNo = new Map(q.thaans.map((t) => [t.thaanNo, t]));
        for (const o of old.filter((x) => x.status !== 'IN_STOCK' || x.takenMeters > 0)) {
          const n = byNo.get(o.thaanNo);
          if (!n || n.meters !== o.meters) {
            if (o.status !== 'RETURNED') throw AppError.rule('THAAN_ON_SO_CARD', `Thaan ${o.thaanNo} is on an SO card; it cannot be changed or removed`);
            throw AppError.rule('THAAN_RETURNED', `Thaan ${o.thaanNo} was given back; it cannot be changed or removed`);
          }
          n.keep = true;
        }
        // locked thaans stay as they are (SO cards point at them); the others are written again
        const locked = old.filter((x) => x.status !== 'IN_STOCK' || x.takenMeters > 0).map((x) => x.id);
        await GreyLotThaan.destroy({ where: { lotId: lot.id, ...(locked.length ? { id: { [Op.notIn]: locked } } : {}) }, transaction });
        await GreyLotThaan.bulkCreate(q.thaans.filter((t) => !t.keep).map((t) => ({ ...t, lotId: lot.id })), { transaction });
      } else if (changes.unit && changes.inwardMeters === undefined && changes.inwardYards === undefined) {
        throw AppError.rule('QTY_REQUIRED', 'Send the quantity again when changing the unit');
      }
    }
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

/**
 * Cloth given back to the party without processing (e.g. 100 thaan came, party wants 50 back).
 *   thaanNos: [51, 52 ...]   for lots entered thaan-wise
 *   or meters (+ pieces)      for lots without a thaan list
 * The cloth leaves the lot balance (it can no longer go on an SO card) and is counted as returned.
 */
async function giveBack(req, id, { thaanNos, meters, pieces, returnDate, vehicleNo, remarks }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const lot = await findOr404(req, id, transaction, true);
    const balance = r2(lot.inwardMeters - lot.outwardMeters);
    let rows = [];
    if (thaanNos) {
      rows = await GreyLotThaan.findAll({ where: { lotId: id, thaanNo: thaanNos }, lock: transaction.LOCK.UPDATE, transaction });
      if (rows.length !== new Set(thaanNos).size) throw AppError.rule('UNKNOWN_THAAN', 'Some thaan numbers are not in this lot');
      const gone = rows.find((t) => t.status !== 'IN_STOCK' || t.takenMeters > 0);
      if (gone && gone.status !== 'RETURNED') throw AppError.rule('THAAN_ON_SO_CARD', `Thaan ${gone.thaanNo} is on an SO card`);
      if (gone) throw AppError.rule('THAAN_RETURNED', `Thaan ${gone.thaanNo} was already given back`);
      meters = r2(rows.reduce((t, x) => t + x.meters, 0));
      pieces = rows.length;
    } else {
      if (await GreyLotThaan.count({ where: { lotId: id }, transaction })) throw AppError.rule('PICK_THAANS', 'This lot has a thaan list; pick the thaans to give back');
      pieces = pieces || 0;
    }
    if (meters > balance) throw AppError.rule('NOT_ENOUGH_METERS', `Only ${balance} m of this lot are still in the store`, { balanceMeters: balance });
    const returnNo = await counters.take(companyId, RETURN, async () => ((await GreyReturn.max('returnNo', { where: { companyId }, transaction })) || 0) + 1, transaction);
    const ret = await GreyReturn.create({
      companyId, lotId: id, returnNo, returnDate: returnDate || today(), pieces, meters, yards: toYards(meters),
      vehicleNo: vehicleNo || null, remarks: remarks || null, createdById: req.user.id,
    }, { transaction });
    for (const t of rows) Object.assign(t, { status: 'RETURNED', returnId: ret.id });
    for (const t of rows) await t.save({ transaction });
    lot.outwardMeters = r2(lot.outwardMeters + meters);
    lot.returnedMeters = r2(lot.returnedMeters + meters);
    lot.returnedPieces += pieces;
    await lot.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'GREY_RETURNED', entityType: 'GreyLot', entityId: id, after: { lotNo: lot.lotNo, returnNo, pieces, meters, thaanNos: thaanNos || null } }, { transaction });
    return after;
  });
}

/** Client admin: take a "given back" entry back (it was entered by mistake). */
async function undoGiveBack(req, id, returnId) {
  return sequelize.transaction(async (transaction) => {
    const lot = await findOr404(req, id, transaction, true);
    const ret = await GreyReturn.findOne({ where: { id: returnId, lotId: id }, transaction });
    if (!ret) throw AppError.notFound('Return');
    await GreyLotThaan.update({ status: 'IN_STOCK', returnId: null }, { where: { returnId }, transaction });
    lot.outwardMeters = r2(lot.outwardMeters - ret.meters);
    lot.returnedMeters = r2(lot.returnedMeters - ret.meters);
    lot.returnedPieces -= ret.pieces;
    await lot.save({ transaction });
    await ret.destroy({ transaction });
    await audit.log(req, { action: 'GREY_RETURN_UNDONE', entityType: 'GreyLot', entityId: id, before: { returnNo: ret.returnNo, pieces: ret.pieces, meters: ret.meters } }, { transaction });
    return load(id, transaction);
  });
}

module.exports = { list, get, create, update, remove, setActive, setApproved, nextNumbers, setNextNumbers, giveBack, undoGiveBack, YARD };
