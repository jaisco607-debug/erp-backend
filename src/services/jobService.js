// Step 5: cloth moving through departments (Singeing, Dyeing, Printing ... Folding).
// - Cloth leaves an SO card, or a department where it is COMPLETE, as a JOB with its own Job#.
//   One job can carry parts of several SO cards: you tick the rows (e.g. card 4740's 1500 m lot
//   and card 4739's 3000 m lot, both for BLACK) and they go together as one entry.
//   Another part of the same card (its 2000 m lot for RED) can go separately as its own job.
// - The receiving department picks the status from a dropdown: PENDING (default) -> PROCESSING
//   -> COMPLETE, or REJECTED when the cloth never came to it (a worker took it elsewhere).
//   Rejected cloth is back with the sender, who can send it again. Cloth that came straight from
//   an SO card cannot be rejected (owner's decision 2026-10-13).
// - The sender sees "Delivered to <department>".
// - Every job remembers which SO card and grey lot each meter belongs to, so each party gets
//   back exactly its own cloth at the end.
// - Departments type nothing: they tick rows, pick a department, a colour and a status.
const { Op, QueryTypes } = require('sequelize');
const { sequelize, Job, JobItem, SoCard, SoCardLot, GreyLot, Customer, Quality, Colour, Service, User } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const { companyServices, userServices } = require('./accessService');

const JOB = 'job_no';
const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const round = (n) => Math.round(n * 100) / 100;
const dept = (s) => (s ? { id: s.id, code: s.code, name: s.name, tracksColour: s.tracksColour } : null);

// ---------- who may do what ----------

async function departments(req, transaction) {
  return (await companyServices(req.user.companyId, transaction)).filter((s) => DEPARTMENT_KINDS.includes(s.kind));
}

/** Access level ('FULL' | 'VIEW' | null) of the signed-in person on a service of their company. */
async function accessTo(req, serviceId, transaction) {
  const have = await companyServices(req.user.companyId, transaction);
  if (!have.some((s) => s.id === serviceId)) return null;
  if (req.user.userType === 'CLIENT_ADMIN') return 'FULL';
  const g = (await userServices(req.user, transaction)).find((x) => x.service.id === serviceId);
  return g ? g.access : null;
}

async function soCardServiceId(transaction) {
  const s = await Service.findOne({ where: { code: 'SO_CARD' }, transaction });
  return s && s.id;
}

/** The "from" side: a department id, or null for the SO card desk. */
async function need(req, departmentId, level, transaction) {
  const serviceId = departmentId || (await soCardServiceId(transaction));
  const access = await accessTo(req, serviceId, transaction);
  if (!access || (level === 'FULL' && access !== 'FULL')) {
    throw AppError.forbidden(level === 'FULL' ? 'You need FULL access to this department' : 'You do not have this department');
  }
}

// ---------- what can be sent ----------

/**
 * Rows that can be ticked and sent.
 *  from the SO card desk (fromDepartmentId empty): each SO card lot with meters not yet sent
 *  from a department: each item of its COMPLETE jobs that has not been sent on yet
 */
async function available(req, fromDepartmentId, transaction) {
  const companyId = req.user.companyId;
  if (!fromDepartmentId) {
    const rows = await sequelize.query(`
      SELECT scl.id AS "soCardLotId", sc.id AS "soCardId", sc."cardNo", sc."idNo", sc."cardDate",
             cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
             q.name AS "quality", gl."lotNo", gl."isReprocess",
             scl.meters - COALESCE((SELECT SUM(ji.meters) FROM job_items ji JOIN jobs j ON j.id = ji."jobId"
                                    WHERE ji."soCardLotId" = scl.id AND ji."sourceJobItemId" IS NULL AND j.status <> 'REJECTED'), 0) AS "meters"
      FROM so_card_lots scl
      JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL
      JOIN customers cu ON cu.id = sc."customerId"
      JOIN grey_lots gl ON gl.id = scl."greyLotId"
      LEFT JOIN qualities q ON q.id = COALESCE(sc."qualityId", gl."qualityId")
      WHERE sc."companyId" = :companyId
      ORDER BY sc."cardNo" DESC, gl."lotNo"`, { replacements: { companyId }, type: QueryTypes.SELECT, transaction });
    return rows.filter((r) => Number(r.meters) > 0).map((r) => ({
      soCardLotId: r.soCardLotId,
      soCard: { id: r.soCardId, cardNo: r.cardNo, idNo: r.idNo, cardDate: r.cardDate },
      customer: { id: r.customerId, code: r.customerCode, name: r.customerName },
      quality: r.quality,
      lotNo: r.lotNo,
      isReprocess: r.isReprocess,
      meters: round(Number(r.meters)),
    }));
  }
  const rows = await sequelize.query(`
    SELECT ji.id AS "jobItemId", j."jobNo", j."jobDate", co.name AS "colour",
           sc.id AS "soCardId", sc."cardNo", sc."idNo", cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
           q.name AS "quality", gl."lotNo", gl."isReprocess", ji.meters
    FROM job_items ji
    JOIN jobs j ON j.id = ji."jobId"
    JOIN so_cards sc ON sc.id = ji."soCardId"
    JOIN customers cu ON cu.id = sc."customerId"
    JOIN so_card_lots scl ON scl.id = ji."soCardLotId"
    JOIN grey_lots gl ON gl.id = scl."greyLotId"
    LEFT JOIN qualities q ON q.id = COALESCE(sc."qualityId", gl."qualityId")
    LEFT JOIN colours co ON co.id = j."colourId"
    WHERE j."companyId" = :companyId AND j."departmentId" = :dep AND j.status = 'COMPLETE'
      AND NOT EXISTS (SELECT 1 FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId"
                      WHERE nx."sourceJobItemId" = ji.id AND nj.status <> 'REJECTED')
    ORDER BY j."jobNo" DESC, sc."cardNo"`, { replacements: { companyId, dep: fromDepartmentId }, type: QueryTypes.SELECT, transaction });
  return rows.map((r) => ({
    jobItemId: r.jobItemId,
    job: { jobNo: r.jobNo, jobDate: r.jobDate, colour: r.colour },
    soCard: { id: r.soCardId, cardNo: r.cardNo, idNo: r.idNo },
    customer: { id: r.customerId, code: r.customerCode, name: r.customerName },
    quality: r.quality,
    lotNo: r.lotNo,
    isReprocess: r.isReprocess,
    meters: round(Number(r.meters)),
  }));
}

/** Everything the "send" screen needs in one call. */
async function formData(req, { fromDepartmentId }) {
  await need(req, fromDepartmentId, 'VIEW');
  const companyId = req.user.companyId;
  const nextJobNo = await counters.peek(companyId, JOB, async () => ((await Job.max('jobNo', { where: { companyId } })) || 0) + 1);
  const colours = await Colour.findAll({ where: { companyId, isActive: true }, order: [['name', 'ASC']] });
  return {
    nextJobNo,
    departments: (await departments(req)).filter((d) => d.id !== fromDepartmentId).map(dept),
    colours: colours.map((c) => ({ id: c.id, name: c.name })),
    rows: await available(req, fromDepartmentId),
  };
}

// ---------- reading jobs ----------

const include = [
  { model: Service, as: 'department', attributes: ['id', 'code', 'name', 'tracksColour'] },
  { model: Service, as: 'fromDepartment', attributes: ['id', 'code', 'name', 'tracksColour'] },
  { model: Colour, as: 'colour', attributes: ['id', 'name'], paranoid: false },
  { model: User, as: 'statusBy', attributes: ['id', 'name'] },
  {
    model: JobItem, as: 'items',
    include: [
      {
        model: SoCard, as: 'soCard', attributes: ['id', 'cardNo', 'idNo', 'cardDate', 'qualityId'], paranoid: false,
        include: [
          { model: Customer, as: 'customer', attributes: ['id', 'code', 'name'], paranoid: false },
          { model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false },
        ],
      },
      {
        model: SoCardLot, as: 'soCardLot', attributes: ['id', 'greyLotId'],
        include: [{
          model: GreyLot, as: 'greyLot', attributes: ['id', 'lotNo', 'isReprocess'], paranoid: false,
          include: [{ model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false }],
        }],
      },
    ],
  },
];

const STATUS_TEXT = { PENDING: 'Pending', PROCESSING: 'Processing', COMPLETE: 'Complete', REJECTED: 'Rejected' };

function itemJSON(i) {
  const lot = i.soCardLot?.greyLot;
  return {
    id: i.id,
    soCard: { id: i.soCard.id, cardNo: i.soCard.cardNo, idNo: i.soCard.idNo },
    customer: { id: i.soCard.customer.id, code: i.soCard.customer.code, name: i.soCard.customer.name },
    quality: i.soCard.quality?.name || lot?.quality?.name || null,
    lotNo: lot?.lotNo,
    isReprocess: Boolean(lot?.isReprocess),
    meters: i.meters,
  };
}

function json(j) {
  const items = (j.items || []).map(itemJSON);
  const uniq = (xs) => [...new Set(xs)];
  return {
    id: j.id,
    jobNo: j.jobNo,
    jobDate: j.jobDate,
    department: dept(j.department),
    fromDepartment: j.fromDepartment ? dept(j.fromDepartment) : { id: null, code: 'SO_CARD', name: 'SO Card' },
    colour: j.colour ? { id: j.colour.id, name: j.colour.name } : null,
    status: j.status,
    statusText: STATUS_TEXT[j.status],
    // show "Reject" in the dropdown only when this is true
    canReject: j.status === 'PENDING' && Boolean(j.fromDepartmentId),
    // what the sending side shows
    sentText: j.status === 'REJECTED' ? `Rejected by ${j.department.name}` : `Delivered to ${j.department.name}`,
    statusBy: j.statusBy ? { id: j.statusBy.id, name: j.statusBy.name } : null,
    statusAt: j.statusAt,
    isReprocess: j.isReprocess,
    totalMeters: j.totalMeters,
    soNos: uniq(items.map((i) => i.soCard.cardNo)),
    customers: uniq(items.map((i) => `${i.customer.name} (${i.customer.code})`)),
    qualities: uniq(items.map((i) => i.quality).filter(Boolean)),
    // Chemical cost comes with the chemical step; 0 until then.
    chemicalAmount: 0,
    costPerMeter: 0,
    sentThrough: j.sentThrough,
    remarks: j.remarks,
    items,
    createdAt: j.createdAt,
  };
}

const load = async (id, transaction) => json(await Job.findByPk(id, { include, transaction }));

/**
 * A department's jobs.
 *   side=in   jobs that came to this department (its working list)
 *   side=out  jobs this department sent on (no departmentId = sent from the SO card desk)
 *   view=job  one row per job (Job Wise tab)    view=so  one row per SO card in each job (SO Wise tab)
 */
async function list(req, q) {
  const dep = q.departmentId || null;
  if (q.side === 'in' && !dep) throw AppError.rule('DEPARTMENT_REQUIRED', 'departmentId is required for side=in');
  await need(req, dep, 'VIEW');
  const where = { companyId: req.user.companyId };
  if (q.side === 'in') where.departmentId = dep;
  else where.fromDepartmentId = dep;
  if (q.status) where.status = q.status;
  if (q.isReprocess !== undefined) where.isReprocess = q.isReprocess;
  if (q.colourId) where.colourId = q.colourId;
  if (q.dateFrom || q.dateTo) {
    where.jobDate = {};
    if (q.dateFrom) where.jobDate[Op.gte] = q.dateFrom;
    if (q.dateTo) where.jobDate[Op.lte] = q.dateTo;
  }
  if (q.search && /^\d+$/.test(q.search)) {
    const n = Number(q.search);
    where[Op.or] = [{ jobNo: n }, { id: { [Op.in]: sequelize.literal(`(SELECT ji."jobId" FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" WHERE sc."companyId" = '${req.user.companyId}' AND sc."cardNo" = ${n})`) } }];
  }
  const { rows, count } = await Job.findAndCountAll({ where, order: [['jobNo', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit });
  const full = rows.length ? await Job.findAll({ where: { id: rows.map((r) => r.id) }, include, order: [['jobNo', 'DESC']] }) : [];
  const jobs = full.map(json);
  if (q.view !== 'so') return { data: jobs, page: q.page, limit: q.limit, total: count };

  // SO Wise: one row per SO card inside each job, meters added up per card
  const data = [];
  for (const j of jobs) {
    const byCard = new Map();
    for (const i of j.items) {
      if (!byCard.has(i.soCard.id)) byCard.set(i.soCard.id, { ...i, meters: 0, lotNos: [] });
      const r = byCard.get(i.soCard.id);
      r.meters = round(r.meters + i.meters);
      r.lotNos.push(i.lotNo);
      r.isReprocess = r.isReprocess || i.isReprocess;
    }
    for (const r of byCard.values()) {
      data.push({
        jobId: j.id, jobNo: j.jobNo, jobDate: j.jobDate, soCard: r.soCard, customer: r.customer, quality: r.quality,
        colour: j.colour, meters: r.meters, lotNos: r.lotNos, isReprocess: r.isReprocess,
        chemicalAmount: 0, costPerMeter: 0,
        status: j.status, statusText: j.statusText, sentText: j.sentText, department: j.department, fromDepartment: j.fromDepartment,
      });
    }
  }
  return { data, page: q.page, limit: q.limit, total: count };
}

async function findOr404(req, id, transaction) {
  const job = await Job.findOne({ where: { id, companyId: req.user.companyId }, lock: transaction ? transaction.LOCK.UPDATE : undefined, transaction });
  if (!job) throw AppError.notFound('Job');
  return job;
}

async function get(req, id) {
  const job = await findOr404(req, id);
  const a = await accessTo(req, job.departmentId);
  if (!a) await need(req, job.fromDepartmentId, 'VIEW');
  return load(id);
}

/** The whole road of one SO card: every job it went in, oldest first. */
async function soCardHistory(req, soCardId) {
  const card = await SoCard.findOne({ where: { id: soCardId, companyId: req.user.companyId }, paranoid: false });
  if (!card) throw AppError.notFound('SO card');
  const ids = (await JobItem.findAll({ where: { soCardId }, attributes: ['jobId'] })).map((i) => i.jobId);
  const jobs = ids.length ? await Job.findAll({ where: { id: ids }, include, order: [['createdAt', 'ASC']] }) : [];
  return {
    soCard: { id: card.id, cardNo: card.cardNo, idNo: card.idNo },
    jobs: jobs.map(json).map((j) => ({ ...j, items: j.items.filter((i) => i.soCard.id === soCardId) })),
  };
}

// ---------- sending ----------

/**
 * Send ticked rows to a department as one job.
 * items: [{ soCardLotId, meters? }] from the SO card desk (meters default to all that is left)
 *        [{ jobItemId }]            from a department (the whole row goes)
 */
async function create(req, { fromDepartmentId, departmentId, jobDate, colourId, sentThrough, remarks, items }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    fromDepartmentId = fromDepartmentId || null;
    await need(req, fromDepartmentId, 'FULL', transaction);
    const to = (await departments(req, transaction)).find((d) => d.id === departmentId);
    if (!to) throw AppError.rule('UNKNOWN_DEPARTMENT', 'Your company does not have this department');
    if (fromDepartmentId === departmentId) throw AppError.rule('SAME_DEPARTMENT', 'Cloth cannot be sent to the same department');
    if (fromDepartmentId && !(await departments(req, transaction)).some((d) => d.id === fromDepartmentId)) {
      throw AppError.rule('UNKNOWN_DEPARTMENT', 'Your company does not have this department');
    }
    if (colourId && !(await Colour.findOne({ where: { id: colourId, companyId }, transaction }))) throw AppError.rule('UNKNOWN_COLOUR', 'Colour not found');

    // lock what is being sent, then read what is left
    const lines = [];
    if (!fromDepartmentId) {
      const ids = items.map((i) => i.soCardLotId).filter(Boolean);
      if (ids.length !== items.length) throw AppError.rule('BAD_ROWS', 'Rows from the SO card desk need soCardLotId');
      await SoCardLot.findAll({ where: { id: ids.sort() }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
      const left = new Map((await available(req, null, transaction)).map((r) => [r.soCardLotId, r]));
      for (const i of items) {
        const r = left.get(i.soCardLotId);
        if (!r) throw AppError.rule('NOTHING_LEFT', 'This SO card row has nothing left to send', { soCardLotId: i.soCardLotId });
        const meters = i.meters === undefined ? r.meters : i.meters;
        if (meters > r.meters) throw AppError.rule('NOT_ENOUGH_METERS', `SO# ${r.soCard.cardNo} lot ${r.lotNo} has only ${r.meters} m left to send`, { soCardLotId: i.soCardLotId, meters: r.meters });
        lines.push({ soCardId: r.soCard.id, soCardLotId: i.soCardLotId, meters, isReprocess: r.isReprocess });
      }
    } else {
      const ids = items.map((i) => i.jobItemId).filter(Boolean);
      if (ids.length !== items.length) throw AppError.rule('BAD_ROWS', 'Rows from a department need jobItemId');
      await JobItem.findAll({ where: { id: ids.sort() }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
      const left = new Map((await available(req, fromDepartmentId, transaction)).map((r) => [r.jobItemId, r]));
      for (const i of items) {
        const r = left.get(i.jobItemId);
        if (!r) throw AppError.rule('NOTHING_LEFT', 'This row is not complete in your department or was already sent', { jobItemId: i.jobItemId });
        const src = await JobItem.findByPk(i.jobItemId, { transaction });
        lines.push({ soCardId: src.soCardId, soCardLotId: src.soCardLotId, sourceJobItemId: src.id, meters: r.meters, isReprocess: r.isReprocess });
      }
    }

    const jobNo = await counters.take(companyId, JOB, async () => ((await Job.max('jobNo', { where: { companyId }, transaction })) || 0) + 1, transaction);
    const job = await Job.create({
      companyId,
      jobNo,
      jobDate: jobDate || new Date().toISOString().slice(0, 10),
      departmentId,
      fromDepartmentId,
      colourId: colourId || null,
      totalMeters: round(lines.reduce((t, l) => t + l.meters, 0)),
      isReprocess: lines.some((l) => l.isReprocess),
      sentThrough: sentThrough || null,
      remarks: remarks || null,
      createdById: req.user.id,
    }, { transaction });
    for (const l of lines) {
      await JobItem.create({ jobId: job.id, soCardId: l.soCardId, soCardLotId: l.soCardLotId, sourceJobItemId: l.sourceJobItemId || null, meters: l.meters }, { transaction });
    }
    // cards that have left the SO desk can no longer change their lots or be cancelled
    await SoCard.update({ status: 'SENT', currentDepartmentId: departmentId }, { where: { id: [...new Set(lines.map((l) => l.soCardId))], status: 'NEW' }, transaction });

    const after = await load(job.id, transaction);
    await audit.log(req, { action: 'JOB_SENT', entityType: 'Job', entityId: job.id, after }, { transaction });
    return after;
  });
}

/**
 * The receiving department's dropdown. REJECTED is final (the cloth is back with the sender).
 * The status cannot change any more once the cloth has been sent on from this department.
 */
async function setStatus(req, id, status) {
  return sequelize.transaction(async (transaction) => {
    const job = await findOr404(req, id, transaction);
    if ((await accessTo(req, job.departmentId, transaction)) !== 'FULL') throw AppError.forbidden('Only the receiving department can change this status');
    if (job.status === 'REJECTED') throw AppError.rule('JOB_REJECTED', 'This job was rejected; the sender has to send it again');
    if (job.status === status) return load(id, transaction);
    const sentOn = await sequelize.query(`
      SELECT 1 FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" JOIN job_items ji ON ji.id = nx."sourceJobItemId"
      WHERE ji."jobId" = :id AND nj.status <> 'REJECTED' LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT, transaction });
    if (sentOn.length) throw AppError.rule('ALREADY_SENT_ON', 'This cloth has already been sent on to the next department');
    if (status === 'REJECTED' && !job.fromDepartmentId) throw AppError.rule('REJECT_NOT_ALLOWED', 'Cloth that came from an SO card cannot be rejected');
    if (status === 'REJECTED' && job.status !== 'PENDING') throw AppError.rule('CANNOT_REJECT', 'Only cloth that is still pending can be rejected');
    const before = job.status;
    job.status = status;
    job.statusById = req.user.id;
    job.statusAt = new Date();
    await job.save({ transaction });
    await audit.log(req, { action: 'JOB_STATUS_CHANGED', entityType: 'Job', entityId: id, before: { status: before }, after: { jobNo: job.jobNo, status } }, { transaction });
    return load(id, transaction);
  });
}

/** The sender can fix the colour / sent-through / remarks while the job is still pending. */
async function update(req, id, { colourId, sentThrough, remarks }) {
  return sequelize.transaction(async (transaction) => {
    const job = await findOr404(req, id, transaction);
    await need(req, job.fromDepartmentId, 'FULL', transaction);
    if (job.status !== 'PENDING') throw AppError.rule('JOB_STARTED', 'The department has already started this job');
    const before = await load(id, transaction);
    if (colourId !== undefined) {
      if (colourId && !(await Colour.findOne({ where: { id: colourId, companyId: req.user.companyId }, transaction }))) throw AppError.rule('UNKNOWN_COLOUR', 'Colour not found');
      job.colourId = colourId;
    }
    if (sentThrough !== undefined) job.sentThrough = sentThrough || null;
    if (remarks !== undefined) job.remarks = remarks || null;
    await job.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'JOB_UPDATED', entityType: 'Job', entityId: id, before, after }, { transaction });
    return after;
  });
}

module.exports = { formData, available, list, get, create, setStatus, update, soCardHistory };
