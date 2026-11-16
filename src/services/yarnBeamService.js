// Weaving > Masters > Beam. Add / change / delete the beams of the company. A beam has a number (typed, or the next free one), a name and a date (default today).
// The beam number is unique among the company's beams (a deleted beam frees its number for typing; the automatic number never goes back).
const { Op } = require('sequelize');
const { sequelize, YarnBeam } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const { STATUS_TEXT } = require('../models/YarnBeam');

const json = (b) => ({ id: b.id, beamNo: b.beamNo, beamLabel: String(b.beamNo).padStart(5, '0'), name: b.name, beamDate: b.beamDate, status: b.status, statusText: STATUS_TEXT[b.status], statusDate: b.statusDate, meters: b.meters == null ? null : Number(b.meters), isActive: b.isActive, createdAt: b.createdAt });
const clean = (s) => String(s).trim().replace(/\s+/g, ' ');
const noTaken = (n) => AppError.rule('BEAM_NO_TAKEN', `Beam number ${n} is already used`, { field: 'beamNo' });

/** The live (not deleted) sizing challan a beam is at (sent, not received yet), or null. */
async function challanOf(id, transaction) {
  const [r] = await sequelize.query('SELECT o.id, o."challanNo" FROM yarn_outward_beams x JOIN yarn_outwards o ON o.id = x."outwardId" AND o."deletedAt" IS NULL WHERE x."beamId" = :id AND NOT EXISTS (SELECT 1 FROM yarn_sizing_inward_beams ib JOIN yarn_sizing_inwards i ON i.id = ib."inwardId" AND i."deletedAt" IS NULL WHERE ib."beamId" = x."beamId" AND i."outwardId" = x."outwardId") LIMIT 1', { replacements: { id }, type: sequelize.QueryTypes.SELECT, transaction });
  return r || null;
}
const onChallan = (c) => AppError.rule('BEAM_ON_CHALLAN', `This beam is on sizing challan ${String(c.challanNo).padStart(5, '0')}: change or delete that challan to move the beam`, { outwardId: c.id, challanNo: c.challanNo });

async function findOr404(req, id, transaction) {
  const row = await YarnBeam.findOne({ where: { id, companyId: req.user.companyId }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!row) throw AppError.notFound('Beam');
  return row;
}

const nextNo = async (companyId, transaction) => ((await YarnBeam.max('beamNo', { where: { companyId }, paranoid: false, transaction })) || 0) + 1;

/** The number the form can start with. */
async function next(req) {
  return { beamNo: await nextNo(req.user.companyId), date: today() };
}

async function list(req, { page, limit, search, isActive, status, dateFrom, dateTo }) {
  const where = { companyId: req.user.companyId };
  if (status) where.status = status;
  if (isActive !== undefined) where.isActive = isActive;
  if (dateFrom || dateTo) where.beamDate = { ...(dateFrom ? { [Op.gte]: dateFrom } : {}), ...(dateTo ? { [Op.lte]: dateTo } : {}) };
  if (search) {
    const or = [{ name: { [Op.iLike]: `%${search.replace(/[\\%_]/g, '\\$&')}%` } }];
    if (/^\d+$/.test(search)) or.push({ beamNo: Number(search) });
    where[Op.or] = or;
  }
  const { rows, count } = await YarnBeam.findAndCountAll({ where, order: [['beamNo', 'ASC']], limit, offset: (page - 1) * limit });
  return { data: rows.map(json), page, limit, total: count };
}

const get = async (req, id) => json(await findOr404(req, id));

// The place of a beam cannot be dated before the beam itself.
function checkStatusDate(beamDate, statusDate) {
  if (String(statusDate) < String(beamDate)) throw AppError.rule('STATUS_BEFORE_BEAM', `The date cannot be before the beam's own date (${beamDate})`, { field: 'statusDate', beamDate });
}

async function create(req, { beamNo, name, beamDate, status = 'EMPTY', statusDate, isActive = true }) {
  const { companyId } = req.user;
  try {
    return await sequelize.transaction(async (transaction) => {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`yarn-beam:${companyId}`], transaction });
      const no = beamNo || (await nextNo(companyId, transaction));
      if (beamNo && (await YarnBeam.findOne({ where: { companyId, beamNo }, transaction }))) throw noTaken(beamNo);
      const date = beamDate || today();
      const since = statusDate || date;
      checkStatusDate(date, since);
      const row = await YarnBeam.create({ companyId, beamNo: no, name: clean(name), beamDate: date, status, statusDate: since, isActive, createdById: req.user.id }, { transaction });
      await audit.log(req, { action: 'YARN_BEAM_CREATED', entityType: 'YarnBeam', entityId: row.id, after: json(row) }, { transaction });
      return json(row);
    });
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') throw noTaken(beamNo);
    throw e;
  }
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  try {
    return await sequelize.transaction(async (transaction) => {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`yarn-beam:${companyId}`], transaction });
      const row = await findOr404(req, id, transaction);
      const before = json(row);
      if ((changes.status !== undefined && changes.status !== row.status) || changes.statusDate !== undefined) { const c = await challanOf(id, transaction); if (c) throw onChallan(c); }
      if (changes.beamNo !== undefined && changes.beamNo !== row.beamNo) {
        if (await YarnBeam.findOne({ where: { companyId, beamNo: changes.beamNo, id: { [Op.ne]: id } }, transaction })) throw noTaken(changes.beamNo);
        row.beamNo = changes.beamNo;
      }
      if (changes.name !== undefined) row.name = clean(changes.name);
      // a beam that has not moved since it was made keeps its place dated like the beam
      if (changes.beamDate !== undefined) { if (String(row.statusDate) === String(row.beamDate)) row.statusDate = changes.beamDate; row.beamDate = changes.beamDate; }
      // a new place without a date is since today; the same place keeps its date unless one is sent
      if (changes.status !== undefined && changes.status !== row.status) { row.status = changes.status; row.statusDate = changes.statusDate || today(); } else if (changes.statusDate !== undefined) row.statusDate = changes.statusDate;
      checkStatusDate(row.beamDate, row.statusDate);
      if (changes.isActive !== undefined) row.isActive = changes.isActive;
      await row.save({ transaction });
      await audit.log(req, { action: 'YARN_BEAM_UPDATED', entityType: 'YarnBeam', entityId: id, before, after: json(row) }, { transaction });
      return json(row);
    });
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') throw noTaken(changes.beamNo);
    throw e;
  }
}

/** Hidden from the lists and dropdowns, kept in the database (later records that used the beam still show it). */
async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(req, id, transaction);
    const challan = await challanOf(id, transaction);
    if (challan) throw onChallan(challan);
    const before = json(row);
    await row.destroy({ transaction });
    await audit.log(req, { action: 'YARN_BEAM_DELETED', entityType: 'YarnBeam', entityId: id, before }, { transaction });
    return { deleted: true, id };
  });
}

module.exports = { list, get, create, update, remove, next };
