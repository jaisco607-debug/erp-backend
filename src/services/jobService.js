// Step 5: cloth moving through departments (Singeing, Dyeing, Printing ... Folding).
// - Cloth leaves an SO card, or a department where it is COMPLETE, as a JOB with its own Job#.
//   One job can carry parts of several SO cards: you tick the rows (e.g. card 4740's 1500 m lot
//   and card 4739's 3000 m lot, both for BLACK) and they go together as one entry.
//   Another part of the same card (its 2000 m lot for RED) can go separately as its own job.
// - Status (owner, 2026-10-17): IN_WAY (sent) -> QUEUE (receiving department pressed Receive)
//   -> PENDING (pressed Accept) -> PROCESSING -> COMPLETE, or REJECTED (from In-Way / Queue / Pending)
//   with a reason: the cloth is back with the sender, who may work on it again and send it to any
//   department. Cloth that came straight from an SO card cannot be rejected (owner, 2026-10-13).
// - Once a department sends cloth on, that entry leaves its working list (kept in the database).
// - Colour: given per SO card by a colour department (Dyeing); later departments copy it.
// - Chemical cost travels with the cloth: earlier departments' cost + this department's cost.
// - The sender sees "Delivered to <department>".
// - Every job remembers which SO card and grey lot each meter belongs to, so each party gets
//   back exactly its own cloth at the end.
// - Departments type nothing: they tick rows, pick a department, a colour and a status.
const { Op, QueryTypes } = require('sequelize');
const { sequelize, Job, JobItem, SoCard, SoCardLot, SoCardLotThaan, GreyLotThaan, GreyLot, Customer, Quality, Colour, Service, User } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const counters = require('./counterService');
const { soLabel, parseCardSearch } = require('../utils/soLabel');
const { companyServices, userServices } = require('./accessService');

const JOB = 'job_no';
const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING', 'PACKING'];
const { round } = require('../utils/money');
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

async function soCardServiceId(transaction, code = 'SO_CARD') {
  const s = await Service.findOne({ where: { code }, transaction });
  return s && s.id;
}

/**
 * The "from" side: a department id, or null for the SO card desk. A fabric return (owner 2026-10-20) is sent by
 * the Grey Store, not the SO card desk: it passes desk = 'GREY_STORE' and needs FULL access to the Grey Store.
 */
async function need(req, departmentId, level, transaction, desk = 'SO_CARD') {
  const serviceId = departmentId || (await soCardServiceId(transaction, desk));
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
      SELECT scl.id AS "soCardLotId", sc.id AS "soCardId", sc."cardNo", sc."idNo", sc."isGreyReturn", sc."cardDate",
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
      soCard: { id: r.soCardId, cardNo: r.cardNo, cardLabel: soLabel(r.cardNo, r.isGreyReturn), idNo: r.idNo, isGreyReturn: Boolean(r.isGreyReturn), cardDate: r.cardDate },
      customer: { id: r.customerId, code: r.customerCode, name: r.customerName },
      quality: r.quality,
      lotNo: r.lotNo,
      isReprocess: r.isReprocess,
      meters: round(Number(r.meters)),
    }));
  }
  const rows = await sequelize.query(`
    SELECT ji.id AS "jobItemId", j.id AS "jobId", j."jobNo", j."jobDate", COALESCE(ic.name, co.name) AS "colour",
           sc.id AS "soCardId", sc."cardNo", sc."idNo", sc."isGreyReturn", cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
           q.name AS "quality", gl."lotNo", gl."isReprocess", ji.meters
    FROM job_items ji
    JOIN jobs j ON j.id = ji."jobId"
    JOIN so_cards sc ON sc.id = ji."soCardId"
    JOIN customers cu ON cu.id = sc."customerId"
    JOIN so_card_lots scl ON scl.id = ji."soCardLotId"
    JOIN grey_lots gl ON gl.id = scl."greyLotId"
    LEFT JOIN qualities q ON q.id = COALESCE(sc."qualityId", gl."qualityId")
    LEFT JOIN colours co ON co.id = j."colourId"
    LEFT JOIN colours ic ON ic.id = ji."colourId"
    WHERE j."companyId" = :companyId AND j."departmentId" = :dep AND j.status = 'COMPLETE'
      AND NOT EXISTS (SELECT 1 FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId"
                      WHERE nx."sourceJobItemId" = ji.id AND nj.status <> 'REJECTED')
    ORDER BY j."jobNo" DESC, sc."cardNo"`, { replacements: { companyId, dep: fromDepartmentId }, type: QueryTypes.SELECT, transaction });
  return rows.map((r) => ({
    jobItemId: r.jobItemId,
    job: { id: r.jobId, jobNo: r.jobNo, jobDate: r.jobDate, colour: r.colour },
    colour: r.colour,
    soCard: { id: r.soCardId, cardNo: r.cardNo, cardLabel: soLabel(r.cardNo, r.isGreyReturn), idNo: r.idNo, isGreyReturn: r.isGreyReturn },
    customer: { id: r.customerId, code: r.customerCode, name: r.customerName },
    quality: r.quality,
    lotNo: r.lotNo,
    isReprocess: r.isReprocess,
    meters: round(Number(r.meters)),
  }));
}

/** Everything the "send" screen needs in one call. */
async function formData(req, { fromDepartmentId, jobId, soCardId }) {
  await need(req, fromDepartmentId, 'VIEW');
  const companyId = req.user.companyId;
  const nextJobNo = await counters.peek(companyId, JOB, async () => ((await Job.max('jobNo', { where: { companyId } })) || 0) + 1);
  const colours = await Colour.findAll({ where: { companyId, isActive: true }, order: [['name', 'ASC']] });
  return {
    nextJobNo,
    departments: (await departments(req)).filter((d) => d.id !== fromDepartmentId).map(dept),
    colours: colours.map((c) => ({ id: c.id, name: c.name })),
    // the colour is given only by Dyeing; other departments just show the colour the cloth has
    canSetColour: Boolean(fromDepartmentId) && (await departments(req)).some((d) => d.id === fromDepartmentId && COLOUR_DEPARTMENTS.includes(d.code)),
    // opened from one job / SO card row: only that row is ticked
    rows: (await available(req, fromDepartmentId)).map((r) => ({
      ...r,
      selected: Boolean((jobId || soCardId) && (!jobId || r.job?.id === jobId) && (!soCardId || r.soCard.id === soCardId)),
    })),
  };
}

// ---------- reading jobs ----------

const include = [
  { model: Service, as: 'department', attributes: ['id', 'code', 'name', 'kind', 'tracksColour'] },
  { model: Service, as: 'fromDepartment', attributes: ['id', 'code', 'name', 'kind', 'tracksColour'] },
  { model: Colour, as: 'colour', attributes: ['id', 'name'], paranoid: false },
  { model: User, as: 'statusBy', attributes: ['id', 'name'] },
  { model: User, as: 'receivedBy', attributes: ['id', 'name'] },
  { model: User, as: 'acceptedBy', attributes: ['id', 'name'] },
  { model: User, as: 'rejectAnswerBy', attributes: ['id', 'name'] },
  { model: User, as: 'operatorSetBy', attributes: ['id', 'name'] },
  {
    model: JobItem, as: 'items',
    include: [
      { model: Colour, as: 'colour', attributes: ['id', 'name'], paranoid: false },
      { model: User, as: 'colourSetBy', attributes: ['id', 'name'] },
      {
        model: SoCard, as: 'soCard', attributes: ['id', 'cardNo', 'idNo', 'cardDate', 'qualityId', 'isGreyReturn'], paranoid: false,
        include: [
          { model: Customer, as: 'customer', attributes: ['id', 'code', 'name'], paranoid: false },
          { model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false },
        ],
      },
      {
        model: SoCardLot, as: 'soCardLot', attributes: ['id', 'greyLotId'],
        include: [{ model: SoCardLotThaan, as: 'thaanParts', include: [{ model: GreyLotThaan, as: 'thaan', attributes: ['id', 'thaanNo'] }] }, {
          model: GreyLot, as: 'greyLot', attributes: ['id', 'lotNo', 'isReprocess'], paranoid: false,
          include: [{ model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false }],
        }],
      },
    ],
  },
];

const STATUS_TEXT = { IN_WAY: 'In-Way', QUEUE: 'Queue', PENDING: 'Pending', PROCESSING: 'Processing', COMPLETE: 'Complete', REJECTED: 'Rejected' };

function itemJSON(i) {
  const lot = i.soCardLot?.greyLot;
  return {
    id: i.id,
    soCard: { id: i.soCard.id, cardNo: i.soCard.cardNo, cardLabel: soLabel(i.soCard.cardNo, i.soCard.isGreyReturn), idNo: i.soCard.idNo, isGreyReturn: Boolean(i.soCard.isGreyReturn) },
    customer: { id: i.soCard.customer.id, code: i.soCard.customer.code, name: i.soCard.customer.name },
    quality: i.soCard.quality?.name || lot?.quality?.name || null,
    lotNo: lot?.lotNo,
    isReprocess: Boolean(lot?.isReprocess),
    meters: i.meters,
    // thaans of this SO card line (thaan no + meters)
    thaans: (i.soCardLot?.thaanParts || []).map((t) => ({ thaanNo: t.thaan?.thaanNo, meters: t.meters })).sort((a, b) => a.thaanNo - b.thaanNo),
    colour: i.colour ? { id: i.colour.id, name: i.colour.name } : null,
    colourSetBy: i.colourSetBy ? { id: i.colourSetBy.id, name: i.colourSetBy.name } : null,
    colourSetAt: i.colourSetAt,
  };
}

const REJECTABLE = ['IN_WAY', 'QUEUE', 'PENDING'];
// departments that give the cloth its colour (owner: Dyeing)
const COLOUR_DEPARTMENTS = require('../utils/colourDepartments');
function sentTextOf(j) {
  if (j.status === 'REJECTED') return `Rejected by ${j.department.name}`;
  if (j.status === 'IN_WAY') return `In-Way to ${j.department.name}`;
  if (j.status === 'QUEUE') return `In queue at ${j.department.name}`;
  return `Delivered to ${j.department.name}`;
}
/** One colour for the whole job when all its SO cards have the same colour. */
function jobColour(j, items) {
  const names = [...new Map(items.filter((i) => i.colour).map((i) => [i.colour.id, i.colour])).values()];
  if (names.length === 1 && items.every((i) => i.colour)) return names[0];
  if (!names.length && j.colour) return { id: j.colour.id, name: j.colour.name };
  return null;
}

/** The distinct SO cards of a job's items, ordered by number. */
const soCardsOf = (items) => [...new Map(items.map((i) => [i.soCard.id, i.soCard])).values()].sort((x, y) => Number(x.isGreyReturn) - Number(y.isGreyReturn) || x.cardNo - y.cardNo);

function json(j) {
  const items = (j.items || []).map(itemJSON);
  const uniq = (xs) => [...new Set(xs)];
  return {
    id: j.id,
    jobNo: j.jobNo,
    jobDate: j.jobDate,
    department: dept(j.department),
    // same as department, clearer names for screens: where the cloth went / came from
    toDepartment: dept(j.department),
    toDepartmentName: j.department.name,
    fromDepartment: j.fromDepartment ? dept(j.fromDepartment) : { id: null, code: 'SO_CARD', name: 'SO Card' },
    fromDepartmentName: j.fromDepartment ? j.fromDepartment.name : 'SO Card',
    sentAt: j.createdAt,
    colour: jobColour(j, items),
    colours: [...new Set(items.map((i) => i.colour && i.colour.name).filter(Boolean))],
    status: j.status,
    statusText: STATUS_TEXT[j.status],
    // show "Reject" in the dropdown only when this is true
    canReject: REJECTABLE.includes(j.status) && Boolean(j.fromDepartmentId) && j.department.kind !== 'PACKING',
    // buttons of the receiving department
    canSetColour: COLOUR_DEPARTMENTS.includes(j.department.code) && !['IN_WAY', 'QUEUE', 'REJECTED'].includes(j.status),
    canReceive: j.status === 'IN_WAY',
    canAccept: j.status === 'QUEUE',
    receivedBy: j.receivedBy ? { id: j.receivedBy.id, name: j.receivedBy.name } : null,
    receivedAt: j.receivedAt,
    acceptedBy: j.acceptedBy ? { id: j.acceptedBy.id, name: j.acceptedBy.name } : null,
    acceptedAt: j.acceptedAt,
    // a rejected job can be taken back (PENDING / PROCESSING / COMPLETE) when the cloth arrives after all
    canUndoReject: j.status === 'REJECTED',
    // what the sending side shows
    sentText: sentTextOf(j),
    // typed by the receiving department
    operatorName: j.operatorName,
    operatorSetBy: j.operatorSetBy ? { id: j.operatorSetBy.id, name: j.operatorSetBy.name } : null,
    operatorSetAt: j.operatorSetAt,
    // the day the operator processed the cloth (typed by the receiving department)
    processDate: j.processDate,
    statusBy: j.statusBy ? { id: j.statusBy.id, name: j.statusBy.name } : null,
    statusAt: j.statusAt,
    isRejected: j.status === 'REJECTED',
    rejectReason: j.status === 'REJECTED' ? j.rejectReason : null,
    rejectedAt: j.status === 'REJECTED' ? j.statusAt : null,
    rejectedBy: j.status === 'REJECTED' && j.statusBy ? { id: j.statusBy.id, name: j.statusBy.name } : null,
    // the sender's answer to a rejection: ACCEPTED (valid) or DISPUTED (not valid, back to this department)
    rejectAnswer: j.rejectAnswer || null,
    canAnswerReject: j.status === 'REJECTED' && !j.rejectAnswer,
    // message for the department that rejected, when the sender did not accept its reason
    rejectionRejected: j.rejectAnswer === 'DISPUTED' ? {
      yourReason: j.disputedRejectReason, reason: j.rejectAnswerReason, at: j.rejectAnswerAt,
      by: j.rejectAnswerBy ? { id: j.rejectAnswerBy.id, name: j.rejectAnswerBy.name } : null,
      department: j.fromDepartment ? j.fromDepartment.name : null,
    } : null,
    isReprocess: j.isReprocess,
    isRework: j.isRework,
    // fabric return grey: not processed, goes Grey Store -> Folding -> Packing
    isGreyReturn: items.some((i) => i.soCard.isGreyReturn),
    totalMeters: j.totalMeters,
    thaanCount: items.reduce((t, i) => t + i.thaans.length, 0),
    // the SO cards of the job, smallest number first (a job holds only one kind: SO cards or a fabric return)
    soNos: soCardsOf(items).map((c) => c.cardNo),
    // what to show: "5" for an SO card, "FR-5" for a fabric return (the numbers of the two series can be the same)
    soLabels: soCardsOf(items).map((c) => c.cardLabel),
    customers: uniq(items.map((i) => `${i.customer.name} (${i.customer.code})`)),
    qualities: uniq(items.map((i) => i.quality).filter(Boolean)),
    // chemical columns are filled in the list (chemicalCount, chemicalAmount, costPerMeter ...)
    chemicalAmount: 0,
    costPerMeter: 0,
    sentThrough: j.sentThrough,
    remarks: j.remarks,
    // what the department must do with this cloth (typed by the sender)
    instructions: j.instructions,
    items,
    createdAt: j.createdAt,
  };
}

const load = async (id, transaction) => json(await Job.findByPk(id, { include, transaction }));

/**
 * Chemicals of these jobs, for the list columns. Counts what left the Chemical Store
 * (In-Way + Received) minus what came back. soCardId: only that SO card's part of each job
 * (a "whole job" request is shared by meters, like the cost screens).
 */
async function chemicalsOf(jobs) {
  const ids = jobs.map((j) => j.id);
  const out = new Map(ids.map((id) => [id, { lines: [], pending: 0 }]));
  if (!ids.length) return out;
  const lines = await sequelize.query(
    `SELECT r."jobId", r."soCardId", r.id AS "requestId", l."itemId",
            (l."sentQty" - l."returnedQty")::float AS qty, (l.value - l."returnedValue")::float AS value
       FROM chemical_requests r JOIN chemical_request_lines l ON l."requestId" = r.id
      WHERE r."jobId" = ANY($1::uuid[]) AND r.status IN ('IN_WAY', 'DELIVERED') AND l."sentQty" > 0`,
    { bind: [ids], type: sequelize.QueryTypes.SELECT },
  );
  for (const l of lines) out.get(l.jobId).lines.push(l);
  const open = await sequelize.query(
    `SELECT "jobId", count(*)::int AS n FROM chemical_requests WHERE "jobId" = ANY($1::uuid[]) AND status IN ('PENDING', 'ACCEPTED') GROUP BY "jobId"`,
    { bind: [ids], type: sequelize.QueryTypes.SELECT },
  );
  for (const o of open) out.get(o.jobId).pending = o.n;
  return out;
}

/**
 * Chemical cost the cloth picked up in earlier departments, per job item: for every item before
 * it on the cloth's road, that job's cost for the SO card, shared by meters.
 */
async function previousCosts(itemIds) {
  const out = new Map(itemIds.map((id) => [id, 0]));
  if (!itemIds.length) return out;
  const up = await sequelize.query(`
    WITH RECURSIVE up AS (
      SELECT ji.id AS start, ji."sourceJobItemId" AS anc FROM job_items ji WHERE ji.id = ANY($1::uuid[]) AND ji."sourceJobItemId" IS NOT NULL
      UNION -- UNION (not ALL): a repeated row ends the walk, so a damaged chain can never loop forever
      SELECT up.start, p."sourceJobItemId" FROM up JOIN job_items p ON p.id = up.anc WHERE p."sourceJobItemId" IS NOT NULL)
    SELECT up.start, a.id, a."jobId", a."soCardId", a.meters::float AS meters, s.meters::float AS "startMeters" FROM up JOIN job_items a ON a.id = up.anc JOIN job_items s ON s.id = up.start`,
  { bind: [itemIds], type: QueryTypes.SELECT });
  if (!up.length) return out;
  const jobIds = [...new Set(up.map((a) => a.jobId))];
  const chem = await chemicalsOf(jobIds.map((id) => ({ id })));
  const all = await JobItem.findAll({ where: { jobId: jobIds }, attributes: ['jobId', 'soCardId', 'meters'] });
  const meters = (jid, card) => all.filter((i) => i.jobId === jid && (!card || i.soCardId === card)).reduce((t, i) => t + i.meters, 0);
  for (const a of up) {
    const total = meters(a.jobId);
    const cardM = meters(a.jobId, a.soCardId);
    const cardCost = chemicalCols(chem.get(a.jobId), cardM, { id: a.soCardId, share: total ? cardM / total : 0 }).chemicalAmount;
    // an earlier item that was split (Folding sends in parts) passes on its cost in proportion: each part only carries its own share
    const part = a.meters > 0 ? Math.min(1, a.startMeters / a.meters) : 1;
    out.set(a.start, out.get(a.start) + (cardM ? cardCost * (a.meters / cardM) * part : 0));
  }
  return out;
}

/** The first Job# of each item's road (the job that took it from the SO card). */
async function firstJobs(itemIds) {
  const out = new Map();
  if (!itemIds.length) return out;
  const rows = await sequelize.query(`
    WITH RECURSIVE up AS (
      SELECT ji.id AS start, ji.id AS cur, ji."sourceJobItemId" AS src, ji."jobId" FROM job_items ji WHERE ji.id = ANY($1::uuid[])
      UNION -- UNION (not ALL): a repeated row ends the walk, so a damaged chain can never loop forever
      SELECT up.start, p.id, p."sourceJobItemId", p."jobId" FROM up JOIN job_items p ON p.id = up.src)
    SELECT up.start, j."jobNo" FROM up JOIN jobs j ON j.id = up."jobId" WHERE up.src IS NULL`,
  { bind: [itemIds], type: QueryTypes.SELECT });
  for (const r of rows) out.set(r.start, r.jobNo);
  return out;
}

/**
 * The cloth's road before each job (oldest first): department, Job#, operator, process date, when sent.
 * from = the job the cloth came straight from.
 */
async function trailsOf(jobs) {
  const out = new Map(jobs.map((j) => [j.id, []]));
  if (!jobs.length) return out;
  const rows = await sequelize.query(`
    WITH RECURSIVE up AS (
      SELECT ji."jobId" AS start, ji."sourceJobItemId" AS anc, 1 AS depth FROM job_items ji WHERE ji."jobId" = ANY($1::uuid[]) AND ji."sourceJobItemId" IS NOT NULL
      UNION -- UNION (not ALL): a repeated row ends the walk, so a damaged chain can never loop forever
      SELECT up.start, p."sourceJobItemId", up.depth + 1 FROM up JOIN job_items p ON p.id = up.anc WHERE p."sourceJobItemId" IS NOT NULL)
    SELECT up.start, j.id, j."jobNo", s.name AS department, j."operatorName", j."processDate", j."createdAt" AS "sentAt", MIN(up.depth) AS depth
    FROM up JOIN job_items a ON a.id = up.anc JOIN jobs j ON j.id = a."jobId" JOIN services s ON s.id = j."departmentId"
    GROUP BY up.start, j.id, s.name ORDER BY j."createdAt"`, { bind: [jobs.map((j) => j.id)], type: QueryTypes.SELECT });
  for (const r of rows) out.get(r.start).push({ jobId: r.id, department: r.department, jobNo: r.jobNo, operatorName: r.operatorName, processDate: r.processDate, sentAt: r.sentAt, depth: r.depth });
  return out;
}
function trailCols(j, trail) {
  const from = trail.filter((t) => t.depth === 1);
  const last = from[from.length - 1] || null;
  return {
    fromOperatorName: last ? last.operatorName : null,
    fromProcessDate: last ? last.processDate : null,
    sentAt: j.sentAt,
    // the whole road, oldest first, this department last
    trail: [
      ...trail.map(({ depth, ...t }) => t),
      { jobId: j.id, department: j.department.name, jobNo: j.jobNo, operatorName: j.operatorName, processDate: j.processDate, sentAt: j.sentAt },
    ],
  };
}

/** Where each item of these jobs went next: sent on, or sent and rejected back (with the reason). */
async function nextOf(jobIds) {
  const out = new Map();
  if (!jobIds.length) return out;
  const rows = await sequelize.query(`
    SELECT ji.id AS "itemId", nj.id AS "jobId", nj."jobNo", nj.status, nj."rejectReason", nj."rejectAnswer", nj."statusAt", s.name AS department, u.name AS "rejectedBy"
    FROM job_items ji JOIN job_items nx ON nx."sourceJobItemId" = ji.id JOIN jobs nj ON nj.id = nx."jobId"
    JOIN services s ON s.id = nj."departmentId" LEFT JOIN users u ON u.id = nj."statusById"
    WHERE ji."jobId" = ANY($1::uuid[]) ORDER BY nj."createdAt"`, { bind: [jobIds], type: QueryTypes.SELECT });
  for (const r of rows) {
    const o = out.get(r.itemId) || { sentTo: null, rejectedBack: null };
    if (r.status !== 'REJECTED') o.sentTo = { jobId: r.jobId, jobNo: r.jobNo, department: r.department, status: r.status };
    else o.rejectedBack = { jobId: r.jobId, jobNo: r.jobNo, department: r.department, reason: r.rejectReason, at: r.statusAt, by: r.rejectedBy, answer: r.rejectAnswer, canAnswer: !r.rejectAnswer };
    out.set(r.itemId, o);
  }
  // rejected earlier but sent again since: no longer "rejected back"
  for (const o of out.values()) if (o.sentTo && o.rejectedBack) o.rejectedBack = null;
  return out;
}

/** Item-level columns for a row: sent on? rejected back? earlier cost. */
function flowCols(items, next, prev) {
  const n = items.map((i) => next.get(i.id) || {});
  const rejected = n.map((x) => x.rejectedBack).filter(Boolean);
  return {
    // every item has gone to the next department (the row leaves the working list)
    sentOn: items.length > 0 && n.every((x) => x.sentTo),
    sentTo: [...new Map(n.filter((x) => x.sentTo).map((x) => [x.sentTo.jobId, x.sentTo])).values()],
    // the next department rejected it: it is back here, with the reason
    rejectedBack: rejected.length ? rejected[rejected.length - 1] : null,
    previousChemicalAmount: round(items.reduce((t, i) => t + (prev.get(i.id) || 0), 0)),
  };
}

/** chemicalCount / chemicalAmount / costPerMeter for one row (a whole job, or one SO card of it). */
function chemicalCols(c, meters, card) {
  const items = new Set();
  const reqs = new Set();
  let amount = 0;
  for (const l of c.lines) {
    const f = !card ? 1 : (l.soCardId ? (l.soCardId === card.id ? 1 : 0) : card.share);
    if (!f) continue;
    amount += l.value * f;
    reqs.add(l.requestId);
    if (l.qty * f > 0) items.add(l.itemId);
  }
  amount = round(amount);
  return {
    chemicalCount: items.size,
    chemicalAmount: amount,
    costPerMeter: meters ? round(amount / meters, 4) : 0,
    chemicalRequests: reqs.size,
    // requests still waiting at the store (Pending / Accepted), not in the cost yet
    pendingChemicalRequests: c.pending,
  };
}

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
  if (q.soNo) where.id = { [Op.in]: sequelize.literal(`(SELECT ji."jobId" FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" WHERE sc."companyId" = '${req.user.companyId}' AND sc."cardNo" = ${Number(q.soNo)})`) };
  // side=in: show=active (default) hides jobs whose cloth has all gone to the next department,
  // and rejected jobs the sender has already sent again (all kept in the database; show=sent lists them)
  const allSent = (dep2) => sequelize.literal(`(SELECT j2.id FROM jobs j2 WHERE j2."departmentId" = ${sequelize.escape(dep2)} AND EXISTS (SELECT 1 FROM job_items a WHERE a."jobId" = j2.id)
    AND NOT EXISTS (SELECT 1 FROM job_items a WHERE a."jobId" = j2.id AND NOT EXISTS (
      SELECT 1 FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" WHERE nx."sourceJobItemId" = a.id AND nj.status <> 'REJECTED'))
    UNION
    -- a job this department rejected, which the sender has since sent again (here or anywhere else)
    SELECT j3.id FROM jobs j3 WHERE j3."departmentId" = ${sequelize.escape(dep2)} AND j3.status = 'REJECTED'
      AND NOT EXISTS (SELECT 1 FROM job_items a WHERE a."jobId" = j3.id AND (a."sourceJobItemId" IS NULL OR NOT EXISTS (
        SELECT 1 FROM job_items o JOIN jobs oj ON oj.id = o."jobId" WHERE o."sourceJobItemId" = a."sourceJobItemId" AND o.id <> a.id AND oj.status <> 'REJECTED'))))`);
  const and = [];
  // the SO card desk's sent list: a fabric return is sent by the Grey Store, not by the SO card desk
  if (q.side === 'out' && !dep) and.push({ id: { [Op.notIn]: sequelize.literal('(SELECT ji."jobId" FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" WHERE sc."isGreyReturn")') } });
  if (q.side === 'in' && (q.show || 'active') === 'active') and.push({ id: { [Op.notIn]: allSent(dep) } });
  if (q.side === 'in' && q.show === 'sent') and.push({ id: { [Op.in]: allSent(dep) } });
  if (and.length) where[Op.and] = and;
  // "5" finds Job# 5 and SO# 5 (and FR-5); "FR-5" finds only the fabric return
  const cardSearch = q.search ? parseCardSearch(q.search) : null;
  if (cardSearch) {
    const n = cardSearch.n;
    where[Op.or] = [...(cardSearch.grey ? [] : [{ jobNo: n }]), { id: { [Op.in]: sequelize.literal(`(SELECT ji."jobId" FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" WHERE sc."companyId" = '${req.user.companyId}' AND sc."cardNo" = ${n}${cardSearch.grey ? ' AND sc."isGreyReturn"' : ''})`) } }];
  }
  const { rows, count } = await Job.findAndCountAll({ where, order: [['jobNo', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit });
  const full = rows.length ? await Job.findAll({ where: { id: rows.map((r) => r.id) }, include, order: [['jobNo', 'DESC']] }) : [];
  const chem = await chemicalsOf(full);
  const next = await nextOf(full.map((j) => j.id));
  const prev = await previousCosts(full.flatMap((j) => j.items.map((i) => i.id)));
  const first = await firstJobs(full.flatMap((j) => j.items.map((i) => i.id)));
  const trails = await trailsOf(full);
  const firstNos = (items) => [...new Set(items.map((i) => first.get(i.id)).filter(Boolean))].sort((a, b) => a - b);
  const withTotals = (row, meters) => ({
    ...row,
    totalChemicalAmount: round(row.previousChemicalAmount + row.chemicalAmount),
    totalCostPerMeter: meters ? round((row.previousChemicalAmount + row.chemicalAmount) / meters, 4) : 0,
  });
  const jobs = full.map((j) => {
    const x = json(j);
    x.items = x.items.map((i) => ({ ...i, ...(next.get(i.id) || { sentTo: null, rejectedBack: null }), previousChemicalAmount: round(prev.get(i.id) || 0), firstJobNo: first.get(i.id) || null }));
    // the Job# the cloth got when it first left the SO card (stays the same in every department)
    const flow = flowCols(x.items, next, prev);
    // operator name + date stay editable from Accept until the cloth is sent on
    const canEditOperator = !['IN_WAY', 'QUEUE', 'REJECTED'].includes(j.status) && !x.items.some((i) => i.sentTo);
    return withTotals({ ...x, ...trailCols(x, trails.get(j.id) || []), canEditOperator, firstJobNos: firstNos(x.items), ...chemicalCols(chem.get(j.id), j.totalMeters), ...flow }, j.totalMeters);
  });
  if (q.view !== 'so') return { data: jobs, page: q.page, limit: q.limit, total: count };

  // SO Wise: one row per SO card inside each job, meters added up per card
  const data = [];
  for (const j of jobs) {
    const byCard = new Map();
    for (const i of j.items) {
      if (!byCard.has(i.soCard.id)) byCard.set(i.soCard.id, { ...i, meters: 0, lotNos: [], thaans: [], parts: [] });
      const r = byCard.get(i.soCard.id);
      r.parts.push(i);
      r.thaans.push(...i.thaans);
      r.meters = round(r.meters + i.meters);
      r.lotNos.push(i.lotNo);
      r.isReprocess = r.isReprocess || i.isReprocess;
    }
    for (const r of [...byCard.values()].sort((a, b) => a.soCard.cardNo - b.soCard.cardNo)) {
      data.push(withTotals({
        ...flowCols(r.parts, next, prev),
        firstJobNos: firstNos(r.parts),
        thaans: r.thaans, thaanCount: r.thaans.length, itemIds: r.parts.map((i) => i.id),
        colourSetBy: r.colourSetBy, colourSetAt: r.colourSetAt,
        isGreyReturn: Boolean(r.soCard.isGreyReturn),
        jobId: j.id, jobNo: j.jobNo, jobDate: j.jobDate, soCard: r.soCard, customer: r.customer, quality: r.quality,
        colour: r.colour || null, meters: r.meters, lotNos: r.lotNos, isReprocess: r.isReprocess, isRework: j.isRework,
        ...chemicalCols(chem.get(j.id), r.meters, { id: r.soCard.id, share: j.totalMeters ? r.meters / j.totalMeters : 0 }),
        status: j.status, statusText: j.statusText, sentText: j.sentText, canReject: j.canReject, canUndoReject: j.canUndoReject, isRejected: j.isRejected, rejectReason: j.rejectReason, rejectedAt: j.rejectedAt, rejectedBy: j.rejectedBy,
        department: j.department, fromDepartment: j.fromDepartment,
        toDepartment: j.toDepartment, toDepartmentName: j.toDepartmentName, fromDepartmentName: j.fromDepartmentName,
        sentThrough: j.sentThrough, sentAt: j.sentAt, instructions: j.instructions, operatorName: j.operatorName, processDate: j.processDate, canEditOperator: j.canEditOperator, soNos: j.soNos, soLabels: j.soLabels,
        fromOperatorName: j.fromOperatorName, fromProcessDate: j.fromProcessDate, trail: j.trail,
        canReceive: j.canReceive, canAccept: j.canAccept, receivedBy: j.receivedBy, receivedAt: j.receivedAt, acceptedBy: j.acceptedBy, acceptedAt: j.acceptedAt,
      }, r.meters));
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
  // an employee sees the road of a card only when their own department (or the SO card desk / Grey Store) had the card
  if (req.user.userType !== 'CLIENT_ADMIN') {
    const mine = new Set((await userServices(req.user)).map((g) => g.service.id));
    const desks = await Service.findAll({ where: { code: ['SO_CARD', 'GREY_STORE'] }, attributes: ['id'] });
    const ok = desks.some((d) => mine.has(d.id)) || jobs.some((j) => mine.has(j.departmentId) || (j.fromDepartmentId && mine.has(j.fromDepartmentId)));
    if (!ok) throw AppError.forbidden('Your department never had this SO card');
  }
  return {
    soCard: { id: card.id, cardNo: card.cardNo, cardLabel: soLabel(card.cardNo, card.isGreyReturn), idNo: card.idNo },
    jobs: jobs.map(json).map((j) => ({ ...j, items: j.items.filter((i) => i.soCard.id === soCardId) })),
  };
}

// ---------- sending ----------

/**
 * Send ticked rows to a department as one job.
 * items: [{ soCardLotId, meters? }] from the SO card desk (meters default to all that is left)
 *        [{ jobItemId }]            from a department (the whole row goes)
 */
async function create(req, { fromDepartmentId, departmentId, jobDate, colourId, sentThrough, remarks, instructions, items, partial, desk }, outerTransaction) {
  const run = (fn) => (outerTransaction ? fn(outerTransaction) : sequelize.transaction(fn));
  return run(async (transaction) => {
    const companyId = req.user.companyId;
    fromDepartmentId = fromDepartmentId || null;
    await need(req, fromDepartmentId, 'FULL', transaction, desk);
    const to = (await departments(req, transaction)).find((d) => d.id === departmentId);
    if (!to) throw AppError.rule('UNKNOWN_DEPARTMENT', 'Your company does not have this department');
    if (fromDepartmentId === departmentId) throw AppError.rule('SAME_DEPARTMENT', 'Cloth cannot be sent to the same department');
    if (fromDepartmentId && !(await departments(req, transaction)).some((d) => d.id === fromDepartmentId)) {
      throw AppError.rule('UNKNOWN_DEPARTMENT', 'Your company does not have this department');
    }
    // Packing (owner, 2026-10-17): cloth comes only from Folding; Packing sends nothing on
    const from = fromDepartmentId && (await departments(req, transaction)).find((d) => d.id === fromDepartmentId);
    if (to.kind === 'PACKING' && (!from || from.kind !== 'FOLDING')) throw AppError.rule('PACKING_ONLY_FROM_FOLDING', 'Only Folding can send cloth to Packing');
    if (from && from.kind === 'PACKING') throw AppError.rule('PACKING_CANNOT_SEND', 'Packing does not send cloth to departments');
    if (colourId && from && !COLOUR_DEPARTMENTS.includes(from.code)) throw AppError.rule('COLOUR_ONLY_DYEING', 'Only Dyeing gives the colour');
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
        if (meters > r.meters) throw AppError.rule('NOT_ENOUGH_METERS', `SO# ${r.soCard.cardLabel} lot ${r.lotNo} has only ${r.meters} m left to send`, { soCardLotId: i.soCardLotId, meters: r.meters });
        lines.push({ soCardId: r.soCard.id, soCardLotId: i.soCardLotId, meters, isReprocess: r.isReprocess });
      }
    } else if (partial) {
      // Folding -> Packing: given meters of items (the rest stays in Folding); checked by the caller
      for (const i of items) {
        const src = await JobItem.findByPk(i.jobItemId, { transaction });
        const sj = src && await Job.findByPk(src.jobId, { transaction });
        if (!sj || sj.departmentId !== fromDepartmentId || sj.companyId !== companyId) throw AppError.rule('NOTHING_LEFT', 'This row is not in your department');
        lines.push({ soCardId: src.soCardId, soCardLotId: src.soCardLotId, sourceJobItemId: src.id, meters: round(i.meters), isReprocess: false, colourId: src.colourId });
      }
    } else {
      const ids = items.map((i) => i.jobItemId).filter(Boolean);
      if (ids.length !== items.length) throw AppError.rule('BAD_ROWS', 'Rows from a department need jobItemId');
      await JobItem.findAll({ where: { id: ids.sort() }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
      const left = new Map((await available(req, fromDepartmentId, transaction)).map((r) => [r.jobItemId, r]));
      for (const i of items) {
        const r = left.get(i.jobItemId);
        if (!r) throw AppError.rule('NOTHING_LEFT', 'This row is not complete in your department or was already sent', { jobItemId: i.jobItemId });
        // fabric return grey was not processed: it only goes on to Packing (owner 2026-10-19)
        if (r.soCard.isGreyReturn && to.kind !== 'PACKING') throw AppError.rule('GREY_RETURN_ONLY_PACKING', `${r.soCard.cardLabel} is a fabric return (not processed); it can only go to Packing`, { soCardId: r.soCard.id });
        const src = await JobItem.findByPk(i.jobItemId, { transaction });
        // owner 2026-10-19: the sending job must have its operator and process date
        const sj = await Job.findByPk(src.jobId, { attributes: ['jobNo', 'operatorName', 'processDate'], transaction });
        if (!sj.operatorName || !sj.processDate) throw AppError.rule('OPERATOR_REQUIRED', `Job# ${sj.jobNo}: enter the operator name and process date before sending`, { jobNo: sj.jobNo });
        lines.push({ soCardId: src.soCardId, soCardLotId: src.soCardLotId, sourceJobItemId: src.id, meters: r.meters, isReprocess: r.isReprocess, colourId: src.colourId });
      }
    }

    // a typed job date cannot be before the SO card it is cut from
    if (jobDate) {
      const [early] = await sequelize.query('SELECT "cardNo", "cardDate" FROM so_cards WHERE id IN (:ids) AND "cardDate" > :d LIMIT 1', { replacements: { ids: [...new Set(lines.map((l) => l.soCardId))], d: jobDate }, type: QueryTypes.SELECT, transaction });
      if (early) throw AppError.rule('JOB_BEFORE_CARD', `SO card ${early.cardNo} is dated ${String(early.cardDate).slice(0, 10)}: the job cannot be dated before that`);
    }
    const jobNo = await counters.take(companyId, JOB, async () => ((await Job.max('jobNo', { where: { companyId }, transaction })) || 0) + 1, transaction);
    const job = await Job.create({
      companyId,
      jobNo,
      jobDate: jobDate || today(),
      departmentId,
      fromDepartmentId,
      colourId: colourId || null,
      totalMeters: round(lines.reduce((t, l) => t + l.meters, 0)),
      isReprocess: lines.some((l) => l.isReprocess),
      // RE-WORK: sent back from Folding for re-processing, and it stays RE-WORK through every
      // department it then passes (Bleaching, Dyeing ... back to Folding)
      isRework: Boolean(fromDepartmentId) && to.kind !== 'PACKING' && (
        (await departments(req, transaction)).some((d) => d.id === fromDepartmentId && d.kind === 'FOLDING')
        || (await Job.count({ where: { id: (await JobItem.findAll({ where: { id: lines.map((l) => l.sourceJobItemId) }, attributes: ['jobId'], transaction })).map((x) => x.jobId), isRework: true }, transaction })) > 0),
      sentThrough: sentThrough || null,
      remarks: remarks || null,
      instructions: instructions || null,
      createdById: req.user.id,
    }, { transaction });
    for (const l of lines) {
      // the colour travels with the cloth (or the sender picks one)
      await JobItem.create({ jobId: job.id, soCardId: l.soCardId, soCardLotId: l.soCardLotId, sourceJobItemId: l.sourceJobItemId || null, meters: l.meters, colourId: colourId || l.colourId || null }, { transaction });
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
async function setStatus(req, id, status, reason) {
  return sequelize.transaction(async (transaction) => {
    const job = await findOr404(req, id, transaction);
    if ((await accessTo(req, job.departmentId, transaction)) !== 'FULL') throw AppError.forbidden('Only the receiving department can change this status');
    if (job.status === 'REJECTED' && status === 'REJECTED') throw AppError.rule('JOB_REJECTED', 'This job is already rejected');
    if (job.status === 'REJECTED') {
      // The cloth turned up after all: the receiver takes the reject back, unless the sender
      // has meanwhile sent the same cloth again in another job.
      const resent = await sequelize.query(`
        SELECT 1 FROM job_items ji JOIN job_items other ON other."sourceJobItemId" = ji."sourceJobItemId" AND other.id <> ji.id
        JOIN jobs oj ON oj.id = other."jobId"
        WHERE ji."jobId" = :id AND oj.status <> 'REJECTED' LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT, transaction });
      if (resent.length) throw AppError.rule('ALREADY_RESENT', 'The sender has already sent this cloth again in another job');
    }
    if (job.status === status) return load(id, transaction);
    const sentOn = await sequelize.query(`
      SELECT 1 FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" JOIN job_items ji ON ji.id = nx."sourceJobItemId"
      WHERE ji."jobId" = :id AND nj.status <> 'REJECTED' LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT, transaction });
    if (sentOn.length) throw AppError.rule('ALREADY_SENT_ON', 'This cloth has already been sent on to the next department');
    if (status === 'REJECTED' && !job.fromDepartmentId) throw AppError.rule('REJECT_NOT_ALLOWED', 'Cloth that came from an SO card cannot be rejected');
    if (status === 'REJECTED' && job.rejectAnswer === 'DISPUTED') throw AppError.rule('REJECT_DISPUTED', 'The sender did not accept your earlier rejection; this cloth cannot be rejected again');
    if (status === 'REJECTED' && !REJECTABLE.includes(job.status)) throw AppError.rule('CANNOT_REJECT', 'Cloth already in processing cannot be rejected');
    // processed cloth (chemicals were asked for on this job) cannot be sent back: its chemical cost would drop out of the cloth's trail
    if (status === 'REJECTED' && (await sequelize.query('SELECT 1 FROM chemical_requests WHERE "jobId" = :id LIMIT 1', { replacements: { id }, type: QueryTypes.SELECT, transaction })).length) throw AppError.rule('CANNOT_REJECT', 'Chemicals were already requested for this job, so it cannot be rejected');
    if (status === 'IN_WAY') throw AppError.rule('BAD_STATUS', 'In-Way is set only when cloth is sent');
    if ((await Service.findByPk(job.departmentId, { attributes: ['kind'], transaction })).kind === 'PACKING' && !['QUEUE', 'PENDING'].includes(status)) throw AppError.rule('PACKING_ACCEPT_ONLY', 'Packing only receives and accepts cloth');
    if (status === 'QUEUE' && job.status !== 'IN_WAY' && job.status !== 'REJECTED') throw AppError.rule('BAD_STATUS', 'This cloth is already received');
    const before = job.status;
    const now = new Date();
    // Receive (In-Way -> Queue) and Accept (Queue -> Pending); a later status fills both in
    if (status !== 'REJECTED' && !job.receivedAt) Object.assign(job, { receivedById: req.user.id, receivedAt: now });
    if (!['REJECTED', 'QUEUE'].includes(status) && !job.acceptedAt) Object.assign(job, { acceptedById: req.user.id, acceptedAt: now });
    job.status = status;
    job.rejectReason = status === 'REJECTED' ? reason || null : null;
    job.statusById = req.user.id;
    job.statusAt = new Date();
    await job.save({ transaction });
    await audit.log(req, { action: 'JOB_STATUS_CHANGED', entityType: 'Job', entityId: id, before: { status: before }, after: { jobNo: job.jobNo, status, reason: job.rejectReason } }, { transaction });
    return load(id, transaction);
  });
}

/**
 * The sender answers a rejection. ACCEPT: the reason is valid, the cloth stays with the sender.
 * DISPUTE (reason required): not valid, the job goes back to the rejecting department as Queue,
 * leaves the sender's list, and that department sees the sender's reason (rejectionRejected).
 */
async function answerReject(req, id, { decision, reason }) {
  return sequelize.transaction(async (transaction) => {
    const job = await findOr404(req, id, transaction);
    if (!job.fromDepartmentId || (await accessTo(req, job.fromDepartmentId, transaction)) !== 'FULL') throw AppError.forbidden('Only the sending department can answer this rejection');
    if (job.status !== 'REJECTED') throw AppError.rule('NOT_REJECTED', 'This job is not rejected');
    if (job.rejectAnswer) throw AppError.rule('ALREADY_ANSWERED', 'This rejection is already answered');
    const resent = await sequelize.query(`
      SELECT 1 FROM job_items ji JOIN job_items other ON other."sourceJobItemId" = ji."sourceJobItemId" AND other.id <> ji.id
      JOIN jobs oj ON oj.id = other."jobId"
      WHERE ji."jobId" = :id AND oj.status <> 'REJECTED' LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT, transaction });
    if (resent.length) throw AppError.rule('ALREADY_RESENT', 'You have already sent this cloth again in another job');
    if (decision === 'DISPUTE' && !reason) throw AppError.rule('REASON_REQUIRED', 'Give the reason why the rejection is not valid');
    const now = new Date();
    Object.assign(job, { rejectAnswer: decision === 'ACCEPT' ? 'ACCEPTED' : 'DISPUTED', rejectAnswerReason: reason || null, rejectAnswerById: req.user.id, rejectAnswerAt: now });
    if (decision === 'DISPUTE') {
      Object.assign(job, { disputedRejectReason: job.rejectReason, rejectReason: null, status: 'QUEUE', statusById: req.user.id, statusAt: now });
      if (!job.receivedAt) Object.assign(job, { receivedById: req.user.id, receivedAt: now });
    }
    await job.save({ transaction });
    await audit.log(req, { action: decision === 'ACCEPT' ? 'JOB_REJECT_ACCEPTED' : 'JOB_REJECT_DISPUTED', entityType: 'Job', entityId: id, before: { status: 'REJECTED' }, after: { jobNo: job.jobNo, status: job.status, reason: reason || null } }, { transaction });
    return load(id, transaction);
  });
}

/** The receiving department types who works on the job (the SO card desk does not know the operator). */
async function setOperator(req, id, data) {
  const { operatorName, processDate } = typeof data === 'object' && data !== null ? data : { operatorName: data };
  return sequelize.transaction(async (transaction) => {
    const job = await findOr404(req, id, transaction);
    if ((await accessTo(req, job.departmentId, transaction)) !== 'FULL') throw AppError.forbidden('Only the receiving department can set the operator');
    const sentOn = await sequelize.query(`
      SELECT 1 FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" JOIN job_items ji ON ji.id = nx."sourceJobItemId"
      WHERE ji."jobId" = :id AND nj.status <> 'REJECTED' LIMIT 1`, { replacements: { id }, type: QueryTypes.SELECT, transaction });
    if (sentOn.length) throw AppError.rule('ALREADY_SENT_ON', 'This cloth has already been sent on; the operator and date cannot change');
    const before = { operatorName: job.operatorName, processDate: job.processDate };
    if (operatorName !== undefined) job.operatorName = operatorName || null;
    if (processDate !== undefined) job.processDate = processDate || null;
    job.operatorSetById = req.user.id;
    job.operatorSetAt = new Date();
    await job.save({ transaction });
    await audit.log(req, { action: 'JOB_OPERATOR_SET', entityType: 'Job', entityId: id, before, after: { jobNo: job.jobNo, operatorName: job.operatorName, processDate: job.processDate } }, { transaction });
    return load(id, transaction);
  });
}

/** The sender can fix the colour / sent-through / remarks while the job is still pending. */
async function update(req, id, { colourId, sentThrough, remarks, instructions }) {
  return sequelize.transaction(async (transaction) => {
    const job = await findOr404(req, id, transaction);
    await need(req, job.fromDepartmentId, 'FULL', transaction);
    if (!['IN_WAY', 'QUEUE'].includes(job.status)) throw AppError.rule('JOB_STARTED', 'The department has already accepted this job');
    const before = await load(id, transaction);
    if (colourId !== undefined) {
      const from = job.fromDepartmentId && (await departments(req, transaction)).find((d) => d.id === job.fromDepartmentId);
      if (from && !COLOUR_DEPARTMENTS.includes(from.code) && colourId !== job.colourId) throw AppError.rule('COLOUR_ONLY_DYEING', 'Only Dyeing gives the colour');
      if (colourId && !(await Colour.findOne({ where: { id: colourId, companyId: req.user.companyId }, transaction }))) throw AppError.rule('UNKNOWN_COLOUR', 'Colour not found');
      job.colourId = colourId;
    }
    if (sentThrough !== undefined) job.sentThrough = sentThrough || null;
    if (remarks !== undefined) job.remarks = remarks || null;
    if (instructions !== undefined) job.instructions = instructions || null;
    await job.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'JOB_UPDATED', entityType: 'Job', entityId: id, before, after }, { transaction });
    return after;
  });
}

/**
 * A colour department (Dyeing: tracksColour) gives the cloth its colour, for the whole job or one
 * SO card of it. Cloth already sent on from here gets the same colour in the later departments.
 */
async function setColour(req, id, { colourId, soCardId }) {
  return sequelize.transaction(async (transaction) => {
    const job = await findOr404(req, id, transaction);
    if ((await accessTo(req, job.departmentId, transaction)) !== 'FULL') throw AppError.forbidden('Only the department that has this cloth can give the colour');
    const d = (await departments(req, transaction)).find((x) => x.id === job.departmentId);
    if (!d || !COLOUR_DEPARTMENTS.includes(d.code)) throw AppError.rule('NO_COLOUR_HERE', `${d ? d.name : 'This department'} does not give colours; Dyeing does`);
    if (['IN_WAY', 'QUEUE', 'REJECTED'].includes(job.status)) throw AppError.rule('NOT_ACCEPTED', 'Accept the cloth first');
    if (colourId && !(await Colour.findOne({ where: { id: colourId, companyId: req.user.companyId }, transaction }))) throw AppError.rule('UNKNOWN_COLOUR', 'Colour not found');
    const items = await JobItem.findAll({ where: { jobId: id, ...(soCardId && { soCardId }) }, transaction });
    if (!items.length) throw AppError.rule('SO_NOT_IN_JOB', 'This SO card is not in this job');
    const before = await load(id, transaction);
    await sequelize.query(`
      WITH RECURSIVE down AS (
        SELECT id FROM job_items WHERE id = ANY($1::uuid[])
        UNION SELECT c.id FROM job_items c JOIN down ON c."sourceJobItemId" = down.id)
      UPDATE job_items SET "colourId" = $2, "colourSetById" = $3, "colourSetAt" = now() WHERE id IN (SELECT id FROM down)`,
    { bind: [items.map((i) => i.id), colourId || null, req.user.id], transaction });
    if (!soCardId) {
      job.colourId = colourId || null;
      await job.save({ transaction });
    }
    const after = await load(id, transaction);
    await audit.log(req, { action: 'JOB_COLOUR_SET', entityType: 'Job', entityId: id, before: { colours: before.colours }, after: { jobNo: job.jobNo, soCardId: soCardId || null, colours: after.colours } }, { transaction });
    return after;
  });
}

module.exports = { chemicalsOf, chemicalCols, previousCosts, answerReject, setColour, formData, available, list, get, create, setStatus, setOperator, update, soCardHistory };
