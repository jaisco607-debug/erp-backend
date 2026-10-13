// Step 4: SO card (travel card).
// - A card takes meters from one grey lot, or from several lots of the same party
//   (e.g. 2000 m from a 4000 m lot + 1500 m from a 3000 m lot = one card of 3500 m).
// - Taking meters raises the lot's outward meters, so its balance in grey goes down (4000 -> 2000).
//   Nobody can take more than a lot's balance, even when two people save at the same moment
//   (the lots are locked while the card is saved).
// - Only approved, active lots can be used. New and re-process lots both work; a card with any
//   re-process lot is marked isReprocess.
// - Then the card is sent to a department (Singeing, Dyeing ...) through someone, and that
//   department accepts it. status: NEW -> SENT -> IN_DEPARTMENT (then it can be sent on again).
// - A card that has not been sent yet can be cancelled: its meters go back to the lots.
const { Op } = require('sequelize');
const { sequelize, SoCard, SoCardLot, SoCardMove, GreyLot, Customer, Quality, Service, User } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const { companyServices, userServices } = require('./accessService');

const CARD = 'so_card_no';
const ID = 'so_card_id_no';
const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const round = (n) => Math.round(n * 100) / 100;

const dept = (s) => (s ? { id: s.id, code: s.code, name: s.name } : null);
const person = (u) => (u ? { id: u.id, name: u.name } : null);

const include = [
  { model: Customer, as: 'customer', attributes: ['id', 'code', 'name'], paranoid: false },
  { model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false },
  { model: Service, as: 'currentDepartment', attributes: ['id', 'code', 'name'] },
  {
    model: SoCardLot, as: 'lots',
    include: [{
      model: GreyLot, as: 'greyLot', attributes: ['id', 'lotNo', 'typeNo', 'dcNo', 'isReprocess'], paranoid: false,
      include: [{ model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false }],
    }],
  },
  {
    model: SoCardMove, as: 'moves',
    include: [
      { model: Service, as: 'fromDepartment', attributes: ['id', 'code', 'name'] },
      { model: Service, as: 'toDepartment', attributes: ['id', 'code', 'name'] },
      { model: User, as: 'sentBy', attributes: ['id', 'name'] },
      { model: User, as: 'acceptedBy', attributes: ['id', 'name'] },
    ],
  },
];
const order = [[{ model: SoCardLot, as: 'lots' }, 'createdAt', 'ASC'], [{ model: SoCardMove, as: 'moves' }, 'sentAt', 'ASC']];

function moveJSON(m) {
  return {
    id: m.id,
    from: dept(m.fromDepartment),
    to: dept(m.toDepartment),
    sentThrough: m.sentThrough,
    remarks: m.remarks,
    sentBy: person(m.sentBy),
    sentAt: m.sentAt,
    acceptedBy: person(m.acceptedBy),
    acceptedAt: m.acceptedAt,
  };
}

function json(c) {
  const moves = (c.moves || []).map(moveJSON);
  return {
    id: c.id,
    cardNo: c.cardNo,
    idNo: c.idNo,
    cardDate: c.cardDate,
    quality: c.quality ? { id: c.quality.id, name: c.quality.name } : null,
    description: c.description,
    isConfirmed: c.isConfirmed,
    confirmedAt: c.confirmedAt,
    customer: c.customer ? { id: c.customer.id, code: c.customer.code, name: c.customer.name } : { id: c.customerId },
    totalMeters: c.totalMeters,
    totalPieces: c.totalPieces,
    isReprocess: c.isReprocess,
    status: c.status,
    currentDepartment: dept(c.currentDepartment),
    // ready-made line for the card view
    deliveryText: c.status === 'SENT' ? `Sent to ${c.currentDepartment?.name} (waiting for accept)`
      : c.status === 'IN_DEPARTMENT' ? `Delivered to ${c.currentDepartment?.name}`
        : 'Not sent to any department yet',
    lastMove: moves.length ? moves[moves.length - 1] : null,
    lots: (c.lots || []).map((l) => ({
      greyLotId: l.greyLotId,
      lotNo: l.greyLot?.lotNo,
      typeNo: l.greyLot?.typeNo,
      dcNo: l.greyLot?.dcNo,
      quality: l.greyLot?.quality ? { id: l.greyLot.quality.id, name: l.greyLot.quality.name } : null,
      isReprocess: l.greyLot?.isReprocess,
      meters: l.meters,
      pieces: l.pieces,
    })),
    moves,
    remarks: c.remarks,
    createdAt: c.createdAt,
  };
}

const load = async (id, transaction) => json(await SoCard.findByPk(id, { include, order, transaction }));

async function findOr404(req, id, transaction, lock = false) {
  const card = await SoCard.findOne({ where: { id, companyId: req.user.companyId }, lock: lock ? transaction.LOCK.UPDATE : undefined, transaction });
  if (!card) throw AppError.notFound('SO card');
  return card;
}

/** The departments this company can send cards to: its Process and Folding services. */
async function departments(req, transaction) {
  return (await companyServices(req.user.companyId, transaction))
    .filter((s) => DEPARTMENT_KINDS.includes(s.kind))
    .map(dept);
}

/** Grey lots that cloth can still be taken from (approved, active, balance left). */
async function availableLots(req, { customerId, search, limit }) {
  const where = {
    companyId: req.user.companyId,
    isApproved: true,
    isActive: true,
    [Op.and]: [sequelize.where(sequelize.col('inwardMeters'), Op.gt, sequelize.col('outwardMeters'))],
  };
  if (customerId) where.customerId = customerId;
  if (search && /^\d+$/.test(search)) where.lotNo = Number(search);
  const lots = await GreyLot.findAll({
    where,
    include: [
      { model: Customer, as: 'customer', attributes: ['id', 'code', 'name'], paranoid: false },
      { model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false },
    ],
    order: [['lotNo', 'ASC']],
    limit,
  });
  return {
    data: lots.map((l) => ({
      id: l.id, lotNo: l.lotNo, typeNo: l.typeNo, dcNo: l.dcNo, inwardDate: l.inwardDate,
      customer: { id: l.customer.id, code: l.customer.code, name: l.customer.name },
      quality: { id: l.quality.id, name: l.quality.name },
      inwardMeters: l.inwardMeters, pieces: l.pieces, outwardMeters: l.outwardMeters,
      balanceMeters: round(l.inwardMeters - l.outwardMeters), isReprocess: l.isReprocess,
    })),
  };
}

async function list(req, q) {
  const where = { companyId: req.user.companyId };
  if (q.customerId) where.customerId = q.customerId;
  if (q.status) where.status = q.status;
  if (q.departmentId) where.currentDepartmentId = q.departmentId;
  if (q.isReprocess !== undefined) where.isReprocess = q.isReprocess;
  if (q.isConfirmed !== undefined) where.isConfirmed = q.isConfirmed;
  if (q.dateFrom || q.dateTo) {
    where.cardDate = {};
    if (q.dateFrom) where.cardDate[Op.gte] = q.dateFrom;
    if (q.dateTo) where.cardDate[Op.lte] = q.dateTo;
  }
  if (q.search) {
    const ors = [{ '$customer.name$': { [Op.iLike]: `%${q.search}%` } }];
    if (/^\d+$/.test(q.search)) {
      ors.push({ cardNo: Number(q.search) }, { idNo: Number(q.search) });
      // cards that took cloth from this lot no
      ors.push({ id: { [Op.in]: sequelize.literal(`(SELECT scl."soCardId" FROM so_card_lots scl JOIN grey_lots gl ON gl.id = scl."greyLotId" WHERE gl."companyId" = '${req.user.companyId}' AND gl."lotNo" = ${Number(q.search)})`) } });
    }
    where[Op.or] = ors;
  }
  const { rows, count } = await SoCard.findAndCountAll({
    where,
    include: [{ model: Customer, as: 'customer', attributes: [], paranoid: false }],
    order: [['cardNo', 'DESC']],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    subQuery: false,
  });
  const ids = rows.map((r) => r.id);
  const full = ids.length ? await SoCard.findAll({ where: { id: ids }, include, order: [['cardNo', 'DESC'], ...order] }) : [];
  return { data: full.map(json), page: q.page, limit: q.limit, total: count };
}

async function get(req, id) {
  const card = await findOr404(req, id);
  return load(card.id);
}

async function create(req, { cardDate, lots, remarks, description, qualityId, departmentId, sentThrough }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    // lock the lots in a fixed order so two cards saved together cannot deadlock or overdraw
    const ids = lots.map((l) => l.greyLotId).sort();
    const found = await GreyLot.findAll({ where: { id: ids, companyId }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
    const byId = new Map(found.map((l) => [l.id, l]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw AppError.rule('UNKNOWN_LOT', 'Some lots were not found', { greyLotIds: missing });

    const customers = new Set(found.map((l) => l.customerId));
    if (customers.size > 1) throw AppError.rule('MIXED_CUSTOMERS', 'All lots on one SO card must belong to the same party');

    const short = [];
    for (const line of lots) {
      const lot = byId.get(line.greyLotId);
      if (!lot.isActive) throw AppError.rule('LOT_INACTIVE', `Lot ${lot.lotNo} is switched off`);
      if (!lot.isApproved) throw AppError.rule('LOT_NOT_APPROVED', `Lot ${lot.lotNo} is not approved yet`);
      const balance = round(lot.inwardMeters - lot.outwardMeters);
      if (line.meters > balance) short.push({ lotNo: lot.lotNo, balanceMeters: balance, asked: line.meters });
    }
    if (short.length) {
      throw AppError.rule('NOT_ENOUGH_METERS', `Lot ${short[0].lotNo} has only ${short[0].balanceMeters} m left`, { lots: short });
    }

    // Quality: as chosen, else the lots' quality when they all have the same one.
    if (qualityId) {
      if (!(await Quality.findOne({ where: { id: qualityId, companyId }, transaction }))) throw AppError.rule('UNKNOWN_QUALITY', 'Quality not found');
    } else {
      const qualities = new Set(found.map((l) => l.qualityId));
      qualityId = qualities.size === 1 ? found[0].qualityId : null;
    }
    if (departmentId && !(await departments(req, transaction)).some((d) => d.id === departmentId)) {
      throw AppError.rule('UNKNOWN_DEPARTMENT', 'Your company does not have this department');
    }

    const cardNo = await counters.take(companyId, CARD, async () => ((await SoCard.max('cardNo', { where: { companyId }, paranoid: false, transaction })) || 0) + 1, transaction);
    const idNo = await counters.take(companyId, ID, async () => ((await SoCard.max('idNo', { where: { companyId }, paranoid: false, transaction })) || 0) + 1, transaction);
    const card = await SoCard.create({
      companyId,
      cardNo,
      idNo,
      cardDate,
      qualityId,
      description: description || null,
      customerId: found[0].customerId,
      totalMeters: round(lots.reduce((t, l) => t + l.meters, 0)),
      totalPieces: lots.reduce((t, l) => t + (l.pieces || 0), 0),
      isReprocess: found.some((l) => l.isReprocess),
      remarks: remarks || null,
      createdById: req.user.id,
    }, { transaction });

    for (const line of lots) {
      await SoCardLot.create({ soCardId: card.id, greyLotId: line.greyLotId, meters: line.meters, pieces: line.pieces || 0 }, { transaction });
      const lot = byId.get(line.greyLotId);
      lot.outwardMeters = round(lot.outwardMeters + line.meters);
      await lot.save({ transaction });
    }

    await audit.log(req, { action: 'SO_CARD_CREATED', entityType: 'SoCard', entityId: card.id, after: await load(card.id, transaction) }, { transaction });
    // the same screen can send it straight away
    if (departmentId) await sendIn(req, card, { departmentId, sentThrough }, transaction);
    return load(card.id, transaction);
  });
}

async function update(req, id, { cardDate, remarks, description, qualityId, lots, departmentId, sentThrough }) {
  return sequelize.transaction(async (transaction) => {
    const card = await findOr404(req, id, transaction, true);
    const before = await load(card.id, transaction);
    const editsCard = [cardDate, remarks, description, qualityId, lots].some((v) => v !== undefined);
    if (cardDate !== undefined) card.cardDate = cardDate;
    if (editsCard && card.isConfirmed) throw AppError.rule('CARD_CONFIRMED', 'A confirmed card cannot be edited');
    if (remarks !== undefined) card.remarks = remarks === '' ? null : remarks;
    if (description !== undefined) card.description = description === '' ? null : description;
    if (qualityId !== undefined) {
      if (qualityId && !(await Quality.findOne({ where: { id: qualityId, companyId: req.user.companyId }, transaction }))) {
        throw AppError.rule('UNKNOWN_QUALITY', 'Quality not found');
      }
      card.qualityId = qualityId;
    }
    if (lots) await replaceLots(req, card, lots, qualityId !== undefined, transaction);
    await card.save({ transaction });
    // choosing the department from the edit screen sends the card there
    if (departmentId) await sendIn(req, card, { departmentId, sentThrough }, transaction);
    const after = await load(card.id, transaction);
    if (editsCard) await audit.log(req, { action: 'SO_CARD_UPDATED', entityType: 'SoCard', entityId: id, before, after }, { transaction });
    return after;
  });
}

/**
 * Change a card's lots/meters (only while it is NEW and not confirmed): old meters go back to
 * their lots, then the new ones are taken, all in one transaction.
 */
async function replaceLots(req, card, lots, qualityChosen, transaction) {
  if (card.status !== 'NEW') throw AppError.rule('CARD_SENT', 'Meters cannot change after the card is sent to a department');
  const companyId = req.user.companyId;
  const old = await SoCardLot.findAll({ where: { soCardId: card.id }, transaction });
  const ids = [...new Set([...old.map((l) => l.greyLotId), ...lots.map((l) => l.greyLotId)])].sort();
  const found = await GreyLot.findAll({ where: { id: ids, companyId }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, paranoid: false, transaction });
  const byId = new Map(found.map((l) => [l.id, l]));
  const missing = lots.map((l) => l.greyLotId).filter((i) => !byId.has(i) || byId.get(i).deletedAt);
  if (missing.length) throw AppError.rule('UNKNOWN_LOT', 'Some lots were not found', { greyLotIds: missing });
  for (const line of old) byId.get(line.greyLotId).outwardMeters = round(byId.get(line.greyLotId).outwardMeters - line.meters);

  const newLots = lots.map((l) => byId.get(l.greyLotId));
  if (new Set(newLots.map((l) => l.customerId)).size > 1) throw AppError.rule('MIXED_CUSTOMERS', 'All lots on one SO card must belong to the same party');
  const keep = new Set(old.map((l) => l.greyLotId));
  const short = [];
  for (const line of lots) {
    const lot = byId.get(line.greyLotId);
    if (!keep.has(lot.id)) {
      if (!lot.isActive) throw AppError.rule('LOT_INACTIVE', `Lot ${lot.lotNo} is switched off`);
      if (!lot.isApproved) throw AppError.rule('LOT_NOT_APPROVED', `Lot ${lot.lotNo} is not approved yet`);
    }
    const balance = round(lot.inwardMeters - lot.outwardMeters);
    if (line.meters > balance) short.push({ lotNo: lot.lotNo, balanceMeters: balance, asked: line.meters });
    lot.outwardMeters = round(lot.outwardMeters + line.meters);
  }
  if (short.length) throw AppError.rule('NOT_ENOUGH_METERS', `Lot ${short[0].lotNo} has only ${short[0].balanceMeters} m left`, { lots: short });
  for (const lot of found) if (lot.changed()) await lot.save({ transaction });

  await SoCardLot.destroy({ where: { soCardId: card.id }, transaction });
  for (const line of lots) {
    await SoCardLot.create({ soCardId: card.id, greyLotId: line.greyLotId, meters: line.meters, pieces: line.pieces || 0 }, { transaction });
  }
  card.customerId = newLots[0].customerId;
  card.totalMeters = round(lots.reduce((t, l) => t + l.meters, 0));
  card.totalPieces = lots.reduce((t, l) => t + (l.pieces || 0), 0);
  card.isReprocess = newLots.some((l) => l.isReprocess);
  if (!qualityChosen) {
    const q = new Set(newLots.map((l) => l.qualityId));
    card.qualityId = q.size === 1 ? newLots[0].qualityId : null;
  }
}

/** Cancel a card that has not been sent anywhere: its meters go back to the grey lots. */
async function cancel(req, id) {
  return sequelize.transaction(async (transaction) => {
    const card = await findOr404(req, id, transaction, true);
    if (card.status !== 'NEW') throw AppError.rule('CARD_SENT', 'This card has already been sent to a department');
    if (card.isConfirmed) throw AppError.rule('CARD_CONFIRMED', 'Take the confirmation off before cancelling');
    const before = await load(card.id, transaction);
    const lines = await SoCardLot.findAll({ where: { soCardId: id }, transaction });
    const lots = await GreyLot.findAll({ where: { id: lines.map((l) => l.greyLotId).sort() }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, paranoid: false, transaction });
    const byId = new Map(lots.map((l) => [l.id, l]));
    for (const line of lines) {
      const lot = byId.get(line.greyLotId);
      lot.outwardMeters = round(lot.outwardMeters - line.meters);
      await lot.save({ transaction });
    }
    await card.destroy({ transaction });
    await audit.log(req, { action: 'SO_CARD_CANCELLED', entityType: 'SoCard', entityId: id, before }, { transaction });
  });
}

/** Send the card to a department, through someone (driver, helper ...). */
async function send(req, id, data) {
  return sequelize.transaction(async (transaction) => {
    const card = await findOr404(req, id, transaction, true);
    await sendIn(req, card, data, transaction);
    return load(card.id, transaction);
  });
}

async function sendIn(req, card, { departmentId, sentThrough, remarks }, transaction) {
  const id = card.id;
  {
    if (card.status === 'SENT') throw AppError.rule('CARD_SENT', 'This card is already on its way to a department; it must be accepted first');
    const allowed = await departments(req, transaction);
    if (!allowed.some((d) => d.id === departmentId)) {
      throw AppError.rule('UNKNOWN_DEPARTMENT', 'Your company does not have this department');
    }
    if (card.currentDepartmentId === departmentId) throw AppError.rule('SAME_DEPARTMENT', 'The card is already in this department');

    await SoCardMove.create({
      soCardId: id,
      fromDepartmentId: card.currentDepartmentId,
      toDepartmentId: departmentId,
      sentThrough: sentThrough || null,
      remarks: remarks || null,
      sentById: req.user.id,
    }, { transaction });
    card.status = 'SENT';
    card.currentDepartmentId = departmentId;
    await card.save({ transaction });
    const after = await load(card.id, transaction);
    await audit.log(req, { action: 'SO_CARD_SENT', entityType: 'SoCard', entityId: id, after: { cardNo: card.cardNo, move: after.lastMove } }, { transaction });
  }
}

/** The receiving department accepts the card (client admin, or a user with FULL access to that department). */
async function accept(req, id) {
  return sequelize.transaction(async (transaction) => {
    const card = await findOr404(req, id, transaction, true);
    if (card.status !== 'SENT') throw AppError.rule('NOTHING_TO_ACCEPT', 'This card is not on its way to a department');
    const move = await SoCardMove.findOne({ where: { soCardId: id, acceptedAt: null }, lock: transaction.LOCK.UPDATE, transaction });

    if (req.user.userType !== 'CLIENT_ADMIN') {
      const grants = await userServices(req.user, transaction);
      if (!grants.some((g) => g.service.id === move.toDepartmentId && g.access === 'FULL')) {
        throw AppError.forbidden('Only the receiving department can accept this card');
      }
    }
    move.acceptedById = req.user.id;
    move.acceptedAt = new Date();
    await move.save({ transaction });
    card.status = 'IN_DEPARTMENT';
    await card.save({ transaction });
    const after = await load(card.id, transaction);
    await audit.log(req, { action: 'SO_CARD_ACCEPTED', entityType: 'SoCard', entityId: id, after: { cardNo: card.cardNo, move: after.lastMove } }, { transaction });
    return after;
  });
}

/** The Conf. toggle: a checker confirms the card is correct. Confirmed cards cannot be edited or cancelled. */
async function setConfirmed(req, id, isConfirmed) {
  return sequelize.transaction(async (transaction) => {
    const card = await findOr404(req, id, transaction, true);
    card.isConfirmed = isConfirmed;
    card.confirmedById = isConfirmed ? req.user.id : null;
    card.confirmedAt = isConfirmed ? new Date() : null;
    await card.save({ transaction });
    await audit.log(req, {
      action: isConfirmed ? 'SO_CARD_CONFIRMED' : 'SO_CARD_UNCONFIRMED', entityType: 'SoCard', entityId: id,
      after: { cardNo: card.cardNo, isConfirmed },
    }, { transaction });
    return load(card.id, transaction);
  });
}

/**
 * Everything the single SO card screen needs in one call: next SO#/ID#, departments,
 * and the grey lots that still have cloth, grouped by party (pick a party, tick its lots, type meters).
 */
async function formData(req) {
  const companyId = req.user.companyId;
  const nextCardNo = await counters.peek(companyId, CARD, async () => ((await SoCard.max('cardNo', { where: { companyId }, paranoid: false })) || 0) + 1);
  const nextIdNo = await counters.peek(companyId, ID, async () => ((await SoCard.max('idNo', { where: { companyId }, paranoid: false })) || 0) + 1);
  const lots = (await availableLots(req, { limit: 5000 })).data;
  const parties = new Map();
  for (const l of lots) {
    if (!parties.has(l.customer.id)) parties.set(l.customer.id, { ...l.customer, balanceMeters: 0, lots: [] });
    const p = parties.get(l.customer.id);
    p.lots.push(l);
    p.balanceMeters = round(p.balanceMeters + l.balanceMeters);
  }
  return {
    nextCardNo,
    nextIdNo,
    departments: await departments(req),
    customers: [...parties.values()].sort((a, b) => a.code - b.code),
  };
}

/** Client admin: where SO# / ID# continue (e.g. from the old system). Never back to a used number. */
async function setNumbering(req, { nextCardNo, nextIdNo }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    for (const [value, name, field] of [[nextCardNo, CARD, 'cardNo'], [nextIdNo, ID, 'idNo']]) {
      if (value === undefined) continue;
      const used = (await SoCard.max(field, { where: { companyId }, paranoid: false, transaction })) || 0;
      if (value <= used) throw AppError.rule('NUMBER_USED', `${field === 'cardNo' ? 'SO#' : 'ID#'} ${used} is already used; the next must be above it`);
      await counters.set(companyId, name, value, transaction);
    }
    await audit.log(req, { action: 'SO_CARD_NUMBERING_CHANGED', entityType: 'Company', entityId: companyId, after: { nextCardNo, nextIdNo } }, { transaction });
  }).then(async () => {
    const f = await formData(req);
    return { nextCardNo: f.nextCardNo, nextIdNo: f.nextIdNo };
  });
}

/** Cards waiting for a department to accept them (its "incoming" list). */
async function incoming(req, departmentId) {
  if (req.user.userType !== 'CLIENT_ADMIN') {
    const grants = await userServices(req.user);
    if (!grants.some((g) => g.service.id === departmentId)) throw AppError.forbidden('You do not have this department');
  }
  const cards = await SoCard.findAll({
    where: { companyId: req.user.companyId, status: 'SENT', currentDepartmentId: departmentId },
    include, order: [['cardNo', 'ASC'], ...order],
  });
  return { data: cards.map(json) };
}

module.exports = { departments, availableLots, list, get, create, update, cancel, send, accept, incoming, setConfirmed, formData, setNumbering };
