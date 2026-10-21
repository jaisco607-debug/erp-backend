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
// - Thaan-wise (2026-10-15): a lot that has a thaan list gives thaans, whole (thaanNos) or part of
//   a thaan (thaans: [{thaanNo, meters}]); a fully taken thaan is SO_CARD in grey, a part-taken one
//   keeps its rest free. A lot without a thaan list still gives meters.
// - Several NEW cards can be sent to a department together: they go as ONE job (one Job#) that
//   shows all their SO numbers.
const { Op, QueryTypes } = require('sequelize');
const { sequelize, SoCard, SoCardLot, SoCardLotThaan, SoCardMove, GreyLot, GreyLotThaan, Customer, Quality, Service, User } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const { soLabel, parseCardSearch } = require('../utils/soLabel');
const { companyServices, userServices } = require('./accessService');

const CARD = 'so_card_no';
const ID = 'so_card_id_no';
// a fabric return grey has its own numbers (FR-1, FR-2 ...), the SO card numbers stay continuous
const CARD_FR = 'fabric_return_card_no';
const ID_FR = 'fabric_return_id_no';
const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const { round } = require('../utils/money');
const YARD = 0.9144;

const dept = (s) => (s ? { id: s.id, code: s.code, name: s.name } : null);
const person = (u) => (u ? { id: u.id, name: u.name } : null);

const include = [
  { model: Customer, as: 'customer', attributes: ['id', 'code', 'name'], paranoid: false },
  { model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false },
  { model: Service, as: 'currentDepartment', attributes: ['id', 'code', 'name'] },
  {
    model: SoCardLot, as: 'lots',
    include: [{
      model: GreyLot, as: 'greyLot', attributes: ['id', 'lotNo', 'typeNo', 'dcNo', 'inwardDate', 'isReprocess', 'unit', 'glm', 'gsm', 'inwardMeters', 'pieces'], paranoid: false,
      include: [{ model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false }],
    }, { model: SoCardLotThaan, as: 'thaanParts', include: [{ model: GreyLotThaan, as: 'thaan', attributes: ['thaanNo', 'meters', 'yards'] }] }],
  },
  { model: User, as: 'createdBy', attributes: ['id', 'name'] },
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

/**
 * Where the cloth of each card is NOW, from its jobs: the department of the newest job that is not rejected, and whether it still waits to be accepted.
 * (A card sent through the job flow keeps status SENT and its first department in the database; this is what the screens show.)
 */
async function positionsOf(cardIds, transaction) {
  const out = new Map();
  if (!cardIds.length) return out;
  const rows = await sequelize.query(`
    SELECT DISTINCT ON (ji."soCardId") ji."soCardId" AS id, s.id AS "deptId", s.code, s.name, j.status
    FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN services s ON s.id = j."departmentId"
    WHERE ji."soCardId" IN (:ids) AND j.status <> 'REJECTED'
    ORDER BY ji."soCardId", j."createdAt" DESC, j."jobNo" DESC`, { replacements: { ids: cardIds }, type: QueryTypes.SELECT, transaction });
  for (const r of rows) out.set(r.id, { department: { id: r.deptId, code: r.code, name: r.name }, waiting: ['IN_WAY', 'QUEUE'].includes(r.status) });
  return out;
}
const jsonMany = async (cards) => { const pos = await positionsOf(cards.map((c) => c.id)); return cards.map((c) => json(c, pos.get(c.id))); };

function json(c, position) {
  const here = position ? position.department : dept(c.currentDepartment);
  const waiting = c.status === 'SENT' && (position ? position.waiting : true);
  const moves = (c.moves || []).map(moveJSON);
  return {
    id: c.id,
    cardNo: c.cardNo,
    // what to show: "5" for an SO card, "FR-5" for a fabric return (the two series both start at 1)
    cardLabel: soLabel(c.cardNo, c.isGreyReturn),
    idNo: c.idNo,
    cardDate: c.cardDate,
    quality: c.quality ? { id: c.quality.id, name: c.quality.name } : null,
    description: c.description,
    deliveryDate: c.deliveryDate,
    article: c.article,
    instructions: c.instructions,
    isConfirmed: c.isConfirmed,
    confirmedAt: c.confirmedAt,
    customer: c.customer ? { id: c.customer.id, code: c.customer.code, name: c.customer.name } : { id: c.customerId },
    totalMeters: c.totalMeters,
    totalPieces: c.totalPieces,
    isReprocess: c.isReprocess,
    isGreyReturn: c.isGreyReturn,
    tagText: c.isGreyReturn ? 'Fabric return grey (not processed)' : null,
    status: c.status,
    currentDepartment: here,
    // ready-made line for the card view
    deliveryText: c.status === 'NEW' ? 'Not sent to any department yet'
      : waiting ? `Sent to ${here?.name} (waiting for accept)` : `Delivered to ${here?.name}`,
    lastMove: moves.length ? moves[moves.length - 1] : null,
    lots: (c.lots || []).map((l) => {
      const g = l.greyLot || {};
      const showYards = g.unit === 'YARD';
      const thaans = (l.thaanParts || []).map((p) => ({ thaanNo: p.thaan.thaanNo, thaanMeters: p.thaan.meters, meters: p.meters }))
        .sort((a, b) => a.thaanNo - b.thaanNo);
      return {
        id: l.id,
        greyLotId: l.greyLotId,
        lotNo: g.lotNo,
        typeNo: g.typeNo,
        dcNo: g.dcNo,
        inwardDate: g.inwardDate,
        quality: g.quality ? { id: g.quality.id, name: g.quality.name } : null,
        glm: g.glm ?? null,
        gsm: g.gsm ?? null,
        unit: g.unit || 'METER',
        showYards,
        isReprocess: g.isReprocess,
        lotInwardMeters: g.inwardMeters,
        lotPieces: g.pieces,
        // the lot when this card was made: gone out before, going on this card, left after
        outBefore: l.outBefore,
        balanceBefore: l.balanceBefore,
        balanceAfter: l.balanceBefore == null ? null : round(l.balanceBefore - l.meters),
        meters: l.meters,
        yards: showYards ? round(l.meters / YARD) : null,
        pieces: l.pieces,
        isThaanWise: thaans.length > 0,
        thaanNos: thaans.map((t) => t.thaanNo),
        // meters = taken on this card; thaanMeters = the thaan's full length; isPart when only part was taken
        thaans: thaans.map((t) => ({
          thaanNo: t.thaanNo, meters: t.meters, thaanMeters: t.thaanMeters, isPart: t.meters < t.thaanMeters,
          yards: showYards ? round(t.meters / YARD) : null,
        })),
      };
    }),
    totalYards: (c.lots || []).length && (c.lots || []).every((l) => l.greyLot?.unit === 'YARD') ? round(c.totalMeters / YARD) : null,
    createdBy: person(c.createdBy),
    moves,
    remarks: c.remarks,
    createdAt: c.createdAt,
  };
}

const load = async (id, transaction) => { const c = await SoCard.findByPk(id, { include, order, transaction }); return json(c, (await positionsOf([c.id], transaction)).get(c.id)); };

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

/**
 * Grey lots that cloth can still be taken from (approved, active, balance left).
 * With `mine` (the card being edited) the card's own meters count as free again, so the edit
 * form shows what the card can hold: each lot/thaan also says what is on this card now.
 */
async function availableLots(req, { customerId, search, limit }, mine) {
  const where = {
    companyId: req.user.companyId,
    isApproved: true,
    isActive: true,
    [Op.and]: [sequelize.where(sequelize.col('inwardMeters'), Op.gt, sequelize.col('outwardMeters'))],
  };
  if (customerId) where.customerId = customerId;
  if (search && /^\d+$/.test(search)) where.lotNo = Number(search);
  const include = [
    { model: Customer, as: 'customer', attributes: ['id', 'code', 'name'], paranoid: false },
    { model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false },
  ];
  const lots = await GreyLot.findAll({ where: mine ? { [Op.or]: [where, { id: [...mine.lotMeters.keys()] }] } : where, include, order: [['lotNo', 'ASC']], limit });
  const thaanRows = lots.length ? await GreyLotThaan.findAll({ where: { lotId: lots.map((l) => l.id) }, order: [['thaanNo', 'ASC']] }) : [];
  const thaansOf = new Map();
  for (const t of thaanRows) {
    if (!thaansOf.has(t.lotId)) thaansOf.set(t.lotId, []);
    thaansOf.get(t.lotId).push(t);
  }
  const onCard = (t) => (mine && mine.thaanMeters.get(t.id)) || 0;
  return {
    data: lots.map((l) => {
      const cardMeters = (mine && mine.lotMeters.get(l.id)) || 0;
      const out = round(l.outwardMeters - cardMeters);
      // a thaan can be ticked while some of it is free (or is on this card)
      const thaans = (thaansOf.get(l.id) || []).filter((t) => t.status !== 'RETURNED' && t.meters - t.takenMeters + onCard(t) > 0)
        .map((t) => {
          const free = round(t.meters - t.takenMeters + onCard(t));
          const row = { thaanNo: t.thaanNo, meters: free, thaanMeters: t.meters, takenMeters: round(t.takenMeters - onCard(t)), yards: l.unit === 'YARD' ? round(free / YARD) : null };
          if (mine) Object.assign(row, { onThisCard: onCard(t), selected: onCard(t) > 0 });
          return row;
        });
      const row = {
        id: l.id, lotNo: l.lotNo, typeNo: l.typeNo, dcNo: l.dcNo, inwardDate: l.inwardDate,
        customer: { id: l.customer.id, code: l.customer.code, name: l.customer.name },
        quality: { id: l.quality.id, name: l.quality.name },
        glm: l.glm, gsm: l.gsm, unit: l.unit, showYards: l.unit === 'YARD',
        inwardMeters: l.inwardMeters, pieces: l.pieces, outwardMeters: out,
        // already gone: on SO cards + given back to the party
        soCardMeters: round(out - l.returnedMeters), returnedMeters: l.returnedMeters,
        balanceMeters: round(l.inwardMeters - out),
        balanceYards: l.unit === 'YARD' ? round((l.inwardMeters - out) / YARD) : null,
        isReprocess: l.isReprocess,
        isThaanWise: thaansOf.has(l.id),
        // meters = what can be taken of the thaan (part of it may already be on another card)
        thaans,
        balancePieces: thaansOf.has(l.id) ? thaans.length : null,
      };
      if (mine) Object.assign(row, { onThisCard: cardMeters, selected: cardMeters > 0, isActive: l.isActive, isApproved: l.isApproved });
      return row;
    }),
  };
}

/**
 * Everything the edit screen needs: the card, whether (and what) it may change, and the party's
 * lots with this card's meters counted as free again (selected ones pre-ticked).
 */
async function editData(req, id) {
  const found = await findOr404(req, id);
  const card = await load(found.id);
  const lines = await SoCardLot.findAll({ where: { soCardId: found.id }, include: [{ model: SoCardLotThaan, as: 'thaanParts' }] });
  const mine = { lotMeters: new Map(), thaanMeters: new Map() };
  for (const l of lines) {
    mine.lotMeters.set(l.greyLotId, round((mine.lotMeters.get(l.greyLotId) || 0) + l.meters));
    for (const p of l.thaanParts || []) mine.thaanMeters.set(p.thaanId, round((mine.thaanMeters.get(p.thaanId) || 0) + p.meters));
  }
  const why = card.status !== 'NEW' ? 'CARD_SENT' : card.isConfirmed ? 'CARD_CONFIRMED' : null;
  const { data } = await availableLots(req, { customerId: found.customerId }, mine);
  return {
    card,
    canEdit: !why,
    // when canEdit is false: CARD_SENT (nothing but sending fields) or CARD_CONFIRMED (take confirmation off first)
    lockedReason: why,
    canChangeLots: !why,
    lots: data,
  };
}

async function list(req, q) {
  const where = { companyId: req.user.companyId };
  if (q.customerId) where.customerId = q.customerId;
  if (q.status) where.status = q.status;
  if (q.departmentId) where.currentDepartmentId = q.departmentId;
  if (q.isReprocess !== undefined) where.isReprocess = q.isReprocess;
  // a fabric return (grey, not processed) is not an SO card of the SO Card section: hidden unless asked for
  where.isGreyReturn = q.isGreyReturn === undefined ? false : q.isGreyReturn;
  if (q.isConfirmed !== undefined) where.isConfirmed = q.isConfirmed;
  if (q.dateFrom || q.dateTo) {
    where.cardDate = {};
    if (q.dateFrom) where.cardDate[Op.gte] = q.dateFrom;
    if (q.dateTo) where.cardDate[Op.lte] = q.dateTo;
  }
  if (q.search) {
    const ors = [{ '$customer.name$': { [Op.iLike]: `%${q.search}%` } }];
    const cs = parseCardSearch(q.search);
    if (cs && cs.grey) ors.push({ cardNo: cs.n, isGreyReturn: true });
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
  return { data: await jsonMany(full), page: q.page, limit: q.limit, total: count };
}

async function get(req, id) {
  const card = await findOr404(req, id);
  return load(card.id);
}

/**
 * A lot with a thaan list gives thaans:
 *   thaanNos: [1, 3]                              whole thaans (all that is still free of each)
 *   thaans: [{ thaanNo: 1, meters: 1000 }, ...]   part of a thaan (meters left out = all that is free)
 * -> line.parts [{ row, meters }], line.meters, line.pieces.  A lot without thaans gives meters as before.
 */
async function pickThaans(line, lot, transaction) {
  const rows = await GreyLotThaan.findAll({ where: { lotId: lot.id }, order: [['thaanNo', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
  const asked = line.thaans || (line.thaanNos && line.thaanNos.map((thaanNo) => ({ thaanNo })));
  if (!rows.length) {
    if (asked) throw AppError.rule('NO_THAANS', `Lot ${lot.lotNo} has no thaan list; send meters`);
    if (line.meters === undefined) throw AppError.rule('QTY_REQUIRED', `Enter the meters for lot ${lot.lotNo}`);
    return;
  }
  if (!asked) throw AppError.rule('PICK_THAANS', `Lot ${lot.lotNo} has a thaan list; tick its thaans`);
  const byNo = new Map(rows.map((r) => [r.thaanNo, r]));
  line.parts = asked.map((a) => {
    const row = byNo.get(a.thaanNo);
    if (!row) throw AppError.rule('UNKNOWN_THAAN', `Thaan ${a.thaanNo} is not in lot ${lot.lotNo}`);
    if (row.status === 'RETURNED') throw AppError.rule('THAAN_NOT_IN_STOCK', `Lot ${lot.lotNo} thaan ${row.thaanNo} is given back to the party`);
    const free = round(row.meters - row.takenMeters);
    if (free <= 0) throw AppError.rule('THAAN_NOT_IN_STOCK', `Lot ${lot.lotNo} thaan ${row.thaanNo} is already on an SO card`);
    const meters = a.meters === undefined ? free : a.meters;
    if (meters > free) throw AppError.rule('THAAN_SHORT', `Lot ${lot.lotNo} thaan ${row.thaanNo} has only ${free} m free`, { thaanNo: row.thaanNo, freeMeters: free });
    return { row, meters };
  });
  line.meters = round(line.parts.reduce((t, p) => t + p.meters, 0));
  line.pieces = line.parts.length;
}

/** Save one lot line of a card, note the lot's figures before, take the meters and the thaan meters. */
async function attachLine(card, line, lot, transaction) {
  const outBefore = lot.outwardMeters;
  const scl = await SoCardLot.create({
    soCardId: card.id, greyLotId: line.greyLotId, meters: line.meters, pieces: line.pieces || 0,
    outBefore, balanceBefore: round(lot.inwardMeters - outBefore),
  }, { transaction });
  lot.outwardMeters = round(outBefore + line.meters);
  for (const { row, meters } of line.parts || []) {
    await SoCardLotThaan.create({ soCardLotId: scl.id, thaanId: row.id, meters }, { transaction });
    row.takenMeters = round(row.takenMeters + meters);
    row.status = row.takenMeters >= row.meters ? 'SO_CARD' : 'IN_STOCK';
    await row.save({ transaction });
  }
}

/** Thaan meters of these card lines go back to the grey store. */
async function freeThaans(soCardLotIds, transaction) {
  if (!soCardLotIds.length) return;
  const parts = await SoCardLotThaan.findAll({ where: { soCardLotId: soCardLotIds }, transaction });
  for (const p of parts) {
    const row = await GreyLotThaan.findByPk(p.thaanId, { lock: transaction.LOCK.UPDATE, transaction });
    row.takenMeters = round(Math.max(0, row.takenMeters - p.meters));
    if (row.status === 'SO_CARD') row.status = 'IN_STOCK';
    row.soCardLotId = null;
    await row.save({ transaction });
  }
  await SoCardLotThaan.destroy({ where: { soCardLotId: soCardLotIds }, transaction });
}

// desk: who makes the card when it is not the SO card desk ('GREY_STORE' for a fabric return); see jobService.need
async function create(req, { cardDate, lots, remarks, description, qualityId, departmentId, sentThrough, deliveryDate, article, instructions, workInstructions, isGreyReturn, desk }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    // lock the lots in a fixed order so two cards saved together cannot deadlock or overdraw
    const ids = lots.map((l) => l.greyLotId).sort();
    const found = await GreyLot.findAll({ where: { id: ids, companyId }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
    const byId = new Map(found.map((l) => [l.id, l]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw AppError.rule('UNKNOWN_LOT', 'Some lots were not found', { greyLotIds: missing });

    // cloth cannot go on a card before it arrived
    const late = found.find((l) => cardDate && l.inwardDate && String(cardDate) < String(l.inwardDate).slice(0, 10));
    if (late) throw AppError.rule('CARD_BEFORE_LOT', `Lot ${late.lotNo} arrived on ${String(late.inwardDate).slice(0, 10)}: the card cannot be dated before that`);
    const customers = new Set(found.map((l) => l.customerId));
    if (customers.size > 1) throw AppError.rule('MIXED_CUSTOMERS', 'All lots on one SO card must belong to the same party');

    const short = [];
    for (const line of lots) {
      const lot = byId.get(line.greyLotId);
      if (!lot.isActive) throw AppError.rule('LOT_INACTIVE', `Lot ${lot.lotNo} is switched off`);
      if (!lot.isApproved) throw AppError.rule('LOT_NOT_APPROVED', `Lot ${lot.lotNo} is not approved yet`);
      await pickThaans(line, lot, transaction);
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

    // own number series: a fabric return takes FR-n, an SO card takes the next SO# (no gaps in either)
    const fr = Boolean(isGreyReturn);
    const cardNo = await counters.take(companyId, fr ? CARD_FR : CARD, async () => ((await SoCard.max('cardNo', { where: { companyId, isGreyReturn: fr }, paranoid: false, transaction })) || 0) + 1, transaction);
    const idNo = await counters.take(companyId, fr ? ID_FR : ID, async () => ((await SoCard.max('idNo', { where: { companyId, isGreyReturn: fr }, paranoid: false, transaction })) || 0) + 1, transaction);
    const card = await SoCard.create({
      companyId,
      cardNo,
      idNo,
      cardDate,
      qualityId,
      description: description || null,
      deliveryDate: deliveryDate || null,
      article: article || null,
      instructions: instructions || null,
      customerId: found[0].customerId,
      totalMeters: round(lots.reduce((t, l) => t + l.meters, 0)),
      totalPieces: lots.reduce((t, l) => t + (l.pieces || 0), 0),
      isReprocess: found.some((l) => l.isReprocess),
      isGreyReturn: Boolean(isGreyReturn),
      remarks: remarks || null,
      createdById: req.user.id,
    }, { transaction });

    for (const line of lots) {
      const lot = byId.get(line.greyLotId);
      await attachLine(card, line, lot, transaction);
      await lot.save({ transaction });
    }

    await audit.log(req, { action: 'SO_CARD_CREATED', entityType: 'SoCard', entityId: card.id, after: await load(card.id, transaction) }, { transaction });
    // the same screen can send it straight away
    if (departmentId) await sendIn(req, card, { departmentId, sentThrough, workInstructions, desk }, transaction);
    return load(card.id, transaction);
  });
}

async function update(req, id, { cardDate, remarks, description, qualityId, lots, departmentId, sentThrough, deliveryDate, article, instructions, workInstructions }) {
  return sequelize.transaction(async (transaction) => {
    const card = await findOr404(req, id, transaction, true);
    const before = await load(card.id, transaction);
    const editsCard = [cardDate, remarks, description, qualityId, lots, deliveryDate, article, instructions].some((v) => v !== undefined);
    if (cardDate !== undefined) {
      const [late] = await sequelize.query('SELECT gl."lotNo", gl."inwardDate" FROM so_card_lots l JOIN grey_lots gl ON gl.id = l."greyLotId" WHERE l."soCardId" = :id AND gl."inwardDate" > :d LIMIT 1', { replacements: { id: card.id, d: cardDate }, type: QueryTypes.SELECT, transaction });
      if (late) throw AppError.rule('CARD_BEFORE_LOT', `Lot ${late.lotNo} arrived on ${String(late.inwardDate).slice(0, 10)}: the card cannot be dated before that`);
      card.cardDate = cardDate;
    }
    if (editsCard && card.isConfirmed) throw AppError.rule('CARD_CONFIRMED', 'A confirmed card cannot be edited');
    if (remarks !== undefined) card.remarks = remarks === '' ? null : remarks;
    if (description !== undefined) card.description = description === '' ? null : description;
    if (deliveryDate !== undefined) card.deliveryDate = deliveryDate || null;
    if (article !== undefined) card.article = article || null;
    if (instructions !== undefined) card.instructions = instructions || null;
    if (qualityId !== undefined) {
      if (qualityId && !(await Quality.findOne({ where: { id: qualityId, companyId: req.user.companyId }, transaction }))) {
        throw AppError.rule('UNKNOWN_QUALITY', 'Quality not found');
      }
      card.qualityId = qualityId;
    }
    if (lots) await replaceLots(req, card, lots, qualityId !== undefined, transaction);
    await card.save({ transaction });
    // choosing the department from the edit screen sends the card there
    if (departmentId) await sendIn(req, card, { departmentId, sentThrough, workInstructions }, transaction);
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
  // the card's thaans go back to the grey store first, so they can be picked again
  await freeThaans(old.map((l) => l.id), transaction);

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
    await pickThaans(line, lot, transaction);
    const balance = round(lot.inwardMeters - lot.outwardMeters);
    if (line.meters > balance) short.push({ lotNo: lot.lotNo, balanceMeters: balance, asked: line.meters });
  }
  if (short.length) throw AppError.rule('NOT_ENOUGH_METERS', `Lot ${short[0].lotNo} has only ${short[0].balanceMeters} m left`, { lots: short });
  await SoCardLot.destroy({ where: { soCardId: card.id }, transaction });
  for (const line of lots) await attachLine(card, line, byId.get(line.greyLotId), transaction);
  for (const lot of found) if (lot.changed()) await lot.save({ transaction });
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
    await freeThaans(lines.map((l) => l.id), transaction);
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

async function sendIn(req, card, { departmentId, sentThrough, remarks, workInstructions, desk }, transaction) {
  const id = card.id;
  {
    if (card.status === 'NEW') {
      // First send from the SO card screen: the card's cloth goes to the department as a job,
      // so it shows in that department's incoming list.
      const jobService = require('./jobService');
      const rows = (await jobService.available(req, null, transaction)).filter((r) => r.soCard.id === id);
      if (rows.length) {
        await jobService.create(req, { departmentId, sentThrough, remarks, instructions: workInstructions, desk, items: rows.map((r) => ({ soCardLotId: r.soCardLotId })) }, transaction);
      }
    }
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

/**
 * Send several NEW cards to one department together: they go as ONE job (one Job#),
 * and the department sees all their SO numbers on it.
 */
async function sendMany(req, { soCardIds, departmentId, colourId, jobDate, sentThrough, remarks, workInstructions }) {
  return sequelize.transaction(async (transaction) => {
    const ids = [...new Set(soCardIds)].sort();
    const cards = await SoCard.findAll({ where: { id: ids, companyId: req.user.companyId }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
    if (cards.length !== ids.length) throw AppError.notFound('SO card');
    const sent = cards.find((c) => c.status !== 'NEW');
    if (sent) throw AppError.rule('CARD_SENT', `SO# ${sent.cardNo} has already been sent to a department`);
    const jobService = require('./jobService');
    const rows = (await jobService.available(req, null, transaction)).filter((r) => ids.includes(r.soCard.id));
    if (!rows.length) throw AppError.rule('NOTHING_LEFT', 'These SO cards have nothing left to send');
    const job = await jobService.create(req, { departmentId, colourId, jobDate, sentThrough, remarks, instructions: workInstructions, items: rows.map((r) => ({ soCardLotId: r.soCardLotId })) }, transaction);
    for (const card of cards) {
      await SoCardMove.create({
        soCardId: card.id, fromDepartmentId: null, toDepartmentId: departmentId,
        sentThrough: sentThrough || null, remarks: remarks || null, sentById: req.user.id,
      }, { transaction });
      card.status = 'SENT';
      card.currentDepartmentId = departmentId;
      await card.save({ transaction });
    }
    await audit.log(req, { action: 'SO_CARDS_SENT', entityType: 'Job', entityId: job.id, after: { jobNo: job.jobNo, soNos: job.soNos } }, { transaction });
    return { job, soCards: await Promise.all(cards.sort((a, b) => a.cardNo - b.cardNo).map((c) => load(c.id, transaction))) };
  });
}

/** The receiving department accepts the card (client admin, or a user with FULL access to that department). */
async function accept(req, id) {
  return sequelize.transaction(async (transaction) => {
    const card = await findOr404(req, id, transaction, true);
    if (card.status !== 'SENT') throw AppError.rule('NOTHING_TO_ACCEPT', 'This card is not on its way to a department');
    const move = await SoCardMove.findOne({ where: { soCardId: id, acceptedAt: null }, lock: transaction.LOCK.UPDATE, transaction });
    // a card sent through the job flow has no move: its department accepts the job (PUT /departments/:code/jobs/:id/status)
    if (!move) throw AppError.rule('ACCEPT_ON_JOB', 'This card was sent as a job: the department accepts it on its job, not on the SO card');

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
  const nextCardNo = await counters.peek(companyId, CARD, async () => ((await SoCard.max('cardNo', { where: { companyId, isGreyReturn: false }, paranoid: false })) || 0) + 1);
  const nextIdNo = await counters.peek(companyId, ID, async () => ((await SoCard.max('idNo', { where: { companyId, isGreyReturn: false }, paranoid: false })) || 0) + 1);
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
      const used = (await SoCard.max(field, { where: { companyId, isGreyReturn: false }, paranoid: false, transaction })) || 0;
      if (value <= used) throw AppError.rule('NUMBER_USED', `${field === 'cardNo' ? 'SO#' : 'ID#'} ${used} is already used; the next must be above it`);
      await counters.set(companyId, name, value, transaction);
    }
    await audit.log(req, { action: 'SO_CARD_NUMBERING_CHANGED', entityType: 'Company', entityId: companyId, after: { nextCardNo, nextIdNo } }, { transaction });
  }).then(async () => {
    const f = await formData(req);
    return { nextCardNo: f.nextCardNo, nextIdNo: f.nextIdNo };
  });
}

/** Cards waiting for a department to accept them (its "incoming" list). Fabric returns come as jobs, not here. */
async function incoming(req, departmentId) {
  if (req.user.userType !== 'CLIENT_ADMIN') {
    const grants = await userServices(req.user);
    if (!grants.some((g) => g.service.id === departmentId)) throw AppError.forbidden('You do not have this department');
  }
  const cards = await SoCard.findAll({
    where: { companyId: req.user.companyId, status: 'SENT', currentDepartmentId: departmentId, isGreyReturn: false,
      // only cards with a move waiting to be accepted: cards sent through the job flow are accepted on their job
      id: { [Op.in]: sequelize.literal('(SELECT "soCardId" FROM so_card_moves WHERE "acceptedAt" IS NULL)') } },
    include, order: [['cardNo', 'ASC'], ...order],
  });
  return { data: await jsonMany(cards) };
}

/** The number the next fabric return will get: FR-<nextCardNo>. */
async function nextFabricReturnNo(req) {
  const companyId = req.user.companyId;
  const nextCardNo = await counters.peek(companyId, CARD_FR, async () => ((await SoCard.max('cardNo', { where: { companyId, isGreyReturn: true }, paranoid: false })) || 0) + 1);
  return { nextCardNo, nextCardLabel: soLabel(nextCardNo, true) };
}

module.exports = { nextFabricReturnNo, departments, availableLots, editData, list, get, create, update, cancel, send, sendMany, accept, incoming, setConfirmed, formData, setNumbering };
