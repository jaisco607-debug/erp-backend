// Step 8: department chemical requests.
// A department asks the Chemical Store for chemicals for one of its Jobs (optionally one SO card of it):
//   department      store            status
//   Pending         Queue            PENDING     department sent it; it can still edit or cancel it
//   Accepted        Process          ACCEPTED    store accepted it (or REJECTED with a reason)
//   In-Way          In-Way           IN_WAY      store sent it: stock goes OUT now, at the store average rate
//   Received        Delivered        DELIVERED   department marked it received
// Only chemicals the store gave the department can be asked for. Only Jobs that are in this
// department and accepted there (PROCESSING / COMPLETE) can get chemicals. A Job or SO card may
// get many requests; their sent value is its chemical cost.
const { Op } = require('sequelize');
const {
  sequelize, ChemicalRequest, ChemicalRequestLine, DepartmentChemical, StoreItem, StoreCategory, StoreMove,
  Job, JobItem, SoCard, Customer, Service, User,
} = require('../models');
const AppError = require('../utils/AppError');
const { today, dayStart, dayEnd } = require('../utils/dates');
const audit = require('./auditService');
const { soLabel, parseCardSearch } = require('../utils/soLabel');
const counters = require('./counterService');
const { companyServices, userServices } = require('./accessService');
const m = require('./storeMasterService');
const batches = require('./batchService');

const COUNTER = 'chemical_request_no';
const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const JOB_OK = ['PROCESSING', 'COMPLETE'];
// the same status, as each side calls it
const DEPT_TEXT = { PENDING: 'Pending', ACCEPTED: 'Accepted', IN_WAY: 'In-Way', DELIVERED: 'Received', CANCELLED: 'Cancelled', REJECTED: 'Rejected' };
const STORE_TEXT = { PENDING: 'Queue', ACCEPTED: 'Process', IN_WAY: 'In-Way', DELIVERED: 'Delivered', CANCELLED: 'Cancelled', REJECTED: 'Rejected' };
const DEPT_TABS = { pending: ['PENDING'], accepted: ['ACCEPTED'], in_way: ['IN_WAY'], received: ['DELIVERED'], closed: ['CANCELLED', 'REJECTED'] };
const STORE_TABS = { queue: ['PENDING'], process: ['ACCEPTED'], in_way: ['IN_WAY'], delivered: ['DELIVERED'], closed: ['CANCELLED', 'REJECTED'] };

const itemBrief = (i) => (i ? { id: i.id, name: i.name, label: m.itemJSON(i).label, unit: i.unit } : null);
const OPEN = ['PENDING', 'ACCEPTED'];
// chemical cost after returns
const net = (r) => m.round(r.totalValue - (r.returnedValue || 0), 2);
const person = (u) => (u ? { id: u.id, name: u.name } : null);
const dept = (s) => (s ? { id: s.id, code: s.code, name: s.name } : null);

const include = [
  { model: ChemicalRequestLine, as: 'lines', include: [
    { model: StoreItem, as: 'item', include: m.itemInclude },
    // fresh copies: sequelize changes include objects it is given
    { model: StoreItem, as: 'altItem', include: m.itemInclude.map((x) => ({ ...x })) },
    { model: StoreItem, as: 'orig', include: m.itemInclude.map((x) => ({ ...x })) },
    ...['altOffered', 'altDecided', 'eta'].map((w) => ({ model: User, as: `${w}By`, attributes: ['id', 'name'] })),
  ] },
  { model: Service, as: 'department' },
  { model: Job, as: 'job', include: [{ model: JobItem, as: 'items', include: [{ model: SoCard, as: 'soCard', include: [{ model: Customer, as: 'customer', paranoid: false }] }] }] },
  { model: SoCard, as: 'soCard' },
  ...['requested', 'accepted', 'sent', 'received', 'closed'].map((w) => ({ model: User, as: `${w}By`, attributes: ['id', 'name'] })),
];

function json(r) {
  const cards = new Map();
  for (const i of (r.job && r.job.items) || []) cards.set(i.soCard.id, i.soCard);
  const open = OPEN.includes(r.status);
  const lines = [...(r.lines || [])].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => ({
    id: l.id,
    item: itemBrief(l.item),
    // not enough in the store right now (only while the store has not sent it)
    inStock: !open || l.item.stockQty >= l.qty,
    shortQty: open && l.item.stockQty < l.qty ? m.round(l.qty - Math.max(0, l.item.stockQty), 3) : 0,
    shortSplit: open && l.item.stockQty < l.qty ? m.splitQty(m.round(l.qty - Math.max(0, l.item.stockQty), 3), l.item.unit) : null,
    originalItem: itemBrief(l.orig),
    alternate: l.altStatus ? {
      status: l.altStatus, item: itemBrief(l.altItem), qty: l.altQty, qtySplit: m.splitQty(l.altQty, l.altItem.unit),
      stockSplit: m.splitQty(l.altItem.stockQty, l.altItem.unit), note: l.altNote,
      offeredBy: person(l.altOfferedBy), offeredAt: l.altOfferedAt, decidedBy: person(l.altDecidedBy), decidedAt: l.altDecidedAt,
    } : null,
    eta: l.etaDate || l.etaNote ? { date: l.etaDate, note: l.etaNote, by: person(l.etaBy), at: l.etaAt } : null,
    qty: l.qty,
    qtySplit: m.splitQty(l.qty, l.item.unit),
    sentQty: l.sentQty,
    returnedQty: l.returnedQty,
    returnedValue: l.returnedValue, // money value of what was sent back (the store cost report needs it)
    returnedSplit: l.returnedQty ? m.splitQty(l.returnedQty, l.item.unit) : null,
    // what can still be sent back to the store
    returnableQty: r.status === 'DELIVERED' && l.sentQty ? m.round(l.sentQty - l.returnedQty, 3) : 0,
    sentSplit: l.sentQty == null ? null : m.splitQty(l.sentQty, l.item.unit),
    rate: l.rate,
    value: l.value,
    stock: l.item.stockQty,
    stockSplit: m.splitQty(l.item.stockQty, l.item.unit),
  }));
  return {
    id: r.id,
    reqNo: r.reqNo,
    status: r.status,
    departmentStatusText: DEPT_TEXT[r.status],
    storeStatusText: STORE_TEXT[r.status],
    department: dept(r.department),
    job: r.job ? { id: r.job.id, jobNo: r.job.jobNo, status: r.job.status } : null,
    soNos: [...cards.values()].map((c) => c.cardNo).sort((a, b) => a - b),
    soLabels: [...cards.values()].sort((a, b) => a.cardNo - b.cardNo).map((c) => soLabel(c.cardNo, c.isGreyReturn)),
    customers: [...new Set([...cards.values()].map((c) => (c.customer ? c.customer.name : null)).filter(Boolean))],
    soCard: r.soCard ? { id: r.soCard.id, cardNo: r.soCard.cardNo, cardLabel: soLabel(r.soCard.cardNo, r.soCard.isGreyReturn) } : null,
    notes: r.notes,
    rejectReason: r.rejectReason,
    sentThrough: r.sentThrough,
    totalValue: r.totalValue,
    returnedValue: r.returnedValue,
    netValue: net(r),
    lineCount: lines.length,
    shortCount: lines.filter((l) => !l.inStock).length,
    // the store offered an alternate chemical; the department must say yes or no
    waitingForDepartment: lines.some((l) => l.alternate && l.alternate.status === 'OFFERED'),
    lines,
    // who did what, when (both sides see this)
    requestedBy: person(r.requestedBy), requestedAt: r.requestedAt,
    acceptedBy: person(r.acceptedBy), acceptedAt: r.acceptedAt,
    sentBy: person(r.sentBy), sentAt: r.sentAt,
    receivedBy: person(r.receivedBy), receivedAt: r.receivedAt,
    closedBy: person(r.closedBy), closedAt: r.closedAt,
  };
}

/** The request, with the batches each line was sent from and (while open) the batches in stock to pick. */
async function load(id, transaction) {
  const r = await ChemicalRequest.findByPk(id, { include, transaction });
  const out = json(r);
  const issued = await batches.issuesOf(out.lines.map((l) => l.id), transaction);
  const open = OPEN.includes(r.status) ? await batches.inStock([...new Set(out.lines.map((l) => l.item.id))], transaction) : new Map();
  for (const l of out.lines) {
    // e.g. 20 KG @ 40 + 35 KG @ 45 = 55 KG, Rs 2375
    l.issuedBatches = issued.get(l.id) || [];
    l.mixedRates = new Set(l.issuedBatches.map((b) => b.rate)).size > 1;
    if (OPEN.includes(r.status)) l.stockBatches = open.get(l.item.id) || [];
  }
  return out;
}

/* ---------------- access ---------------- */

async function departmentByCode(req, code, transaction) {
  const d = (await companyServices(req.user.companyId, transaction)).find((s) => DEPARTMENT_KINDS.includes(s.kind) && s.code === String(code).toUpperCase());
  if (!d) throw AppError.notFound('Department');
  return d;
}

/** 'FULL' | 'VIEW' | null on one service (client admin: FULL on everything the company has). */
async function level(req, serviceId, transaction) {
  if (req.user.userType === 'CLIENT_ADMIN') return 'FULL';
  const g = (await userServices(req.user, transaction)).find((x) => x.service.id === serviceId);
  return g ? g.access : null;
}

async function needDept(req, code, want, transaction) {
  const d = await departmentByCode(req, code, transaction);
  const l = await level(req, d.id, transaction);
  if (!l || (want === 'FULL' && l !== 'FULL')) throw AppError.forbidden(want === 'FULL' ? 'You need FULL access to this department' : 'You do not have this department');
  return d;
}

/* ---------------- shared ---------------- */

function lineQty(l, unit) {
  if (l.qty !== undefined && l.qty !== null) return l.qty;
  const sub = l.qtySub || 0;
  if (sub && !m.SUB_UNITS[unit]) throw AppError.rule('NO_SUB_UNIT', `${unit} has no small unit; enter the quantity in ${unit}`);
  if (sub >= 1000) throw AppError.rule('SUB_TOO_BIG', `Enter less than 1000 ${m.SUB_UNITS[unit]}; 1000 ${m.SUB_UNITS[unit]} = 1 ${unit}`);
  return m.round((l.qtyMain || 0) + sub / 1000, 3);
}

async function findOr404(req, id, where, transaction) {
  const r = await ChemicalRequest.findOne({ where: { id, companyId: req.user.companyId, ...where }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!r) throw AppError.notFound('Chemical request');
  return r;
}

/** Checks the job / SO card / chemicals and returns the lines to save. */
async function prepare(req, d, { jobId, soCardId, lines }, transaction) {
  const out = {};
  if (jobId !== undefined) {
    const job = await Job.findOne({ where: { id: jobId, companyId: req.user.companyId }, include: [{ model: JobItem, as: 'items' }], transaction });
    if (!job || job.departmentId !== d.id) throw AppError.rule('UNKNOWN_JOB', 'This job is not in your department');
    if (!JOB_OK.includes(job.status)) throw AppError.rule('JOB_NOT_ACCEPTED', 'Accept the job (Processing) before asking for chemicals');
    out.jobId = job.id;
    out.job = job;
  }
  if (soCardId !== undefined) out.soCardId = soCardId || null;
  if (lines) {
    const given = new Set((await DepartmentChemical.findAll({ where: { companyId: req.user.companyId, departmentId: d.id }, transaction })).map((g) => g.itemId));
    const ids = [...new Set(lines.map((l) => l.itemId))];
    if (ids.length !== lines.length) throw AppError.rule('DUPLICATE_ITEM', 'A chemical is twice in the list; put it once');
    const items = await StoreItem.findAll({ where: { id: ids, companyId: req.user.companyId, store: 'CHEMICAL' }, transaction });
    const byId = new Map(items.map((i) => [i.id, i]));
    out.lines = lines.map((l, i) => {
      const item = byId.get(l.itemId);
      if (!item || !given.has(l.itemId)) throw AppError.rule('CHEMICAL_NOT_GIVEN', 'This chemical is not given to your department');
      if (!item.isActive) throw AppError.rule('ITEM_INACTIVE', `${item.name} is switched off`);
      const qty = lineQty(l, item.unit);
      if (!(qty > 0)) throw AppError.rule('QTY_REQUIRED', `Enter the quantity of ${item.name}`);
      return { itemId: item.id, qty, sortOrder: i };
    });
  }
  return out;
}

async function checkCard(out, job, transaction) {
  if (!out.soCardId) return;
  const items = job.items || (await JobItem.findAll({ where: { jobId: job.id }, transaction }));
  if (!items.some((i) => i.soCardId === out.soCardId)) throw AppError.rule('SO_NOT_IN_JOB', 'This SO card is not in this job');
}

const tabWhere = (tabs, tab) => (tab && tab !== 'all' ? { status: tabs[tab] } : {});

async function listWhere(req, q, base, tabs) {
  const where = { companyId: req.user.companyId, ...base, ...tabWhere(tabs, q.tab) };
  if (q.reqNo) where.reqNo = q.reqNo;
  if (q.dateFrom || q.dateTo) where.requestedAt = { ...(q.dateFrom && { [Op.gte]: dayStart(q.dateFrom) }), ...(q.dateTo && { [Op.lte]: dayEnd(q.dateTo) }) };
  const and = [];
  if (q.jobNo) and.push({ jobId: { [Op.in]: sequelize.literal(`(SELECT id FROM jobs WHERE "companyId" = ${sequelize.escape(req.user.companyId)} AND "jobNo" = ${Number(q.jobNo)})`) } });
  if (q.soNo) {
    and.push({ jobId: { [Op.in]: sequelize.literal(`(SELECT ji."jobId" FROM job_items ji JOIN so_cards s ON s.id = ji."soCardId" WHERE s."companyId" = ${sequelize.escape(req.user.companyId)} AND s."cardNo" = ${Number(q.soNo)})`) } });
  }
  if (and.length) where[Op.and] = and;
  return where;
}

async function page(where, q, counts) {
  const { rows, count } = await ChemicalRequest.findAndCountAll({
    where, include, distinct: true, order: [['requestedAt', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(json), total: count, page: q.page, limit: q.limit, counts };
}

async function countsBy(where, tabs) {
  const rows = await ChemicalRequest.findAll({ where, attributes: ['status', [sequelize.fn('count', sequelize.col('id')), 'n']], group: ['status'], raw: true });
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return Object.fromEntries(Object.entries(tabs).map(([tab, sts]) => [tab, sts.reduce((t, s) => t + (by[s] || 0), 0)]));
}

/* ---------------- department side ---------------- */

/** What the request form needs: the department's accepted jobs (with SO#s) and its chemicals. */
async function formData(req, code) {
  const d = await needDept(req, code, 'VIEW');
  const companyId = req.user.companyId;
  const [jobs, given] = await Promise.all([
    Job.findAll({
      where: { companyId, departmentId: d.id, status: JOB_OK },
      include: [{ model: JobItem, as: 'items', include: [{ model: SoCard, as: 'soCard', include: [{ model: Customer, as: 'customer', paranoid: false }] }] }],
      order: [['jobNo', 'DESC']],
      limit: 300,
    }),
    DepartmentChemical.findAll({ where: { companyId, departmentId: d.id }, attributes: ['itemId'] }),
  ]);
  const items = given.length ? await StoreItem.findAll({
    where: { id: given.map((g) => g.itemId), isActive: true },
    include: m.itemInclude,
    order: [[{ model: StoreCategory, as: 'category' }, 'name', 'ASC'], ['name', 'ASC']],
  }) : [];
  return {
    department: dept(d),
    jobs: jobs.map((j) => {
      const cards = new Map();
      for (const i of j.items) {
        const c = cards.get(i.soCard.id) || { id: i.soCard.id, cardNo: i.soCard.cardNo, cardLabel: soLabel(i.soCard.cardNo, i.soCard.isGreyReturn), customer: i.soCard.customer ? i.soCard.customer.name : null, meters: 0 };
        c.meters = m.round(c.meters + i.meters, 2);
        cards.set(c.id, c);
      }
      return { id: j.id, jobNo: j.jobNo, jobDate: j.jobDate, status: j.status, totalMeters: j.totalMeters, soCards: [...cards.values()].sort((a, b) => a.cardNo - b.cardNo) };
    }),
    chemicals: items.map((i) => {
      const j = m.itemJSON(i);
      return { id: j.id, name: j.name, label: j.label, unit: j.unit, category: j.category, hasSubUnit: j.hasSubUnit, subUnit: j.subUnit, stock: j.stock, stockQty: j.stockQty, inStock: j.stockQty > 0 };
    }),
  };
}

async function deptList(req, code, q) {
  const d = await needDept(req, code, 'VIEW');
  const where = await listWhere(req, q, { departmentId: d.id }, DEPT_TABS);
  return page(where, q, await countsBy({ companyId: req.user.companyId, departmentId: d.id }, DEPT_TABS));
}

async function deptGet(req, code, id) {
  const d = await needDept(req, code, 'VIEW');
  await findOr404(req, id, { departmentId: d.id });
  return load(id);
}

async function create(req, code, data) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const out = await prepare(req, d, data, transaction);
    await checkCard(out, out.job, transaction);
    const companyId = req.user.companyId;
    const reqNo = await counters.take(companyId, COUNTER, async () => ((await ChemicalRequest.max('reqNo', { where: { companyId }, transaction })) || 0) + 1, transaction);
    const r = await ChemicalRequest.create({
      companyId, reqNo, departmentId: d.id, jobId: out.jobId, soCardId: out.soCardId || null, notes: data.notes || null,
      requestedById: req.user.id, requestedAt: new Date(),
    }, { transaction });
    await ChemicalRequestLine.bulkCreate(out.lines.map((l) => ({ ...l, requestId: r.id })), { transaction });
    const after = await load(r.id, transaction);
    await audit.log(req, { action: 'CHEMICAL_REQUEST_CREATED', entityType: 'ChemicalRequest', entityId: r.id, after }, { transaction });
    return after;
  });
}

/** Edit while still Pending (not accepted by the store yet). */
async function update(req, code, id, data) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const r = await findOr404(req, id, { departmentId: d.id }, transaction);
    if (r.status !== 'PENDING') throw AppError.rule('NOT_PENDING', 'The store has already taken this request; it cannot be changed');
    const before = await load(id, transaction);
    const out = await prepare(req, d, data, transaction);
    const job = out.job || (await Job.findByPk(r.jobId, { include: [{ model: JobItem, as: 'items' }], transaction }));
    if (out.jobId) r.jobId = out.jobId;
    if (out.soCardId !== undefined) r.soCardId = out.soCardId;
    else if (out.jobId) r.soCardId = null;
    await checkCard({ soCardId: r.soCardId }, job, transaction);
    if (data.notes !== undefined) r.notes = data.notes || null;
    if (out.lines) {
      await ChemicalRequestLine.destroy({ where: { requestId: id }, transaction });
      await ChemicalRequestLine.bulkCreate(out.lines.map((l) => ({ ...l, requestId: id })), { transaction });
    }
    await r.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'CHEMICAL_REQUEST_UPDATED', entityType: 'ChemicalRequest', entityId: id, before, after }, { transaction });
    return after;
  });
}

async function closeAs(req, r, status, reason, transaction) {
  const before = r.status;
  Object.assign(r, { status, closedById: req.user.id, closedAt: new Date(), rejectReason: reason || null });
  await r.save({ transaction });
  const after = await load(r.id, transaction);
  await audit.log(req, { action: `CHEMICAL_REQUEST_${status}`, entityType: 'ChemicalRequest', entityId: r.id, before: { status: before }, after }, { transaction });
  return after;
}

async function cancel(req, code, id) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const r = await findOr404(req, id, { departmentId: d.id }, transaction);
    if (r.status !== 'PENDING') throw AppError.rule('NOT_PENDING', 'The store has already taken this request; ask the store');
    return closeAs(req, r, 'CANCELLED', null, transaction);
  });
}

async function receive(req, code, id) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const r = await findOr404(req, id, { departmentId: d.id }, transaction);
    if (r.status !== 'IN_WAY') throw AppError.rule('NOT_IN_WAY', 'Only a request on its way can be marked received');
    Object.assign(r, { status: 'DELIVERED', receivedById: req.user.id, receivedAt: new Date() });
    await r.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'CHEMICAL_REQUEST_RECEIVED', entityType: 'ChemicalRequest', entityId: id, after }, { transaction });
    return after;
  });
}

/* ---------------- chemical store side ---------------- */

async function storeList(req, q) {
  const base = {};
  if (q.departmentId) base.departmentId = q.departmentId;
  const where = await listWhere(req, q, base, STORE_TABS);
  return page(where, q, await countsBy({ companyId: req.user.companyId }, STORE_TABS));
}

async function storeGet(req, id) {
  await findOr404(req, id, {});
  return load(id);
}

async function accept(req, id) {
  return sequelize.transaction(async (transaction) => {
    const r = await findOr404(req, id, {}, transaction);
    if (r.status !== 'PENDING') throw AppError.rule('NOT_IN_QUEUE', 'Only a request in the Queue can be accepted');
    Object.assign(r, { status: 'ACCEPTED', acceptedById: req.user.id, acceptedAt: new Date() });
    await r.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'CHEMICAL_REQUEST_ACCEPTED', entityType: 'ChemicalRequest', entityId: id, after }, { transaction });
    return after;
  });
}

async function reject(req, id, { reason }) {
  return sequelize.transaction(async (transaction) => {
    const r = await findOr404(req, id, {}, transaction);
    if (!['PENDING', 'ACCEPTED'].includes(r.status)) throw AppError.rule('ALREADY_SENT', 'A sent request cannot be rejected');
    return closeAs(req, r, 'REJECTED', reason, transaction);
  });
}

/**
 * Store sends the chemicals. Each line may be sent in a different qty (0 = not sent).
 * Stock goes out now at the store average rate; that value is the chemical cost of the Job / SO card.
 */
async function send(req, id, { lines = [], sentThrough }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const r = await findOr404(req, id, {}, transaction);
    if (r.status === 'PENDING') throw AppError.rule('NOT_ACCEPTED', 'Accept the request first');
    if (r.status !== 'ACCEPTED') throw AppError.rule('ALREADY_SENT', 'This request is not in Process');
    const rows0 = await ChemicalRequestLine.findAll({ where: { requestId: id, altStatus: 'OFFERED' }, transaction });
    if (rows0.length) throw AppError.rule('WAITING_DEPARTMENT', 'The department has not answered the alternate chemical yet');
    const rows = await ChemicalRequestLine.findAll({ where: { requestId: id }, transaction });
    const items = new Map((await StoreItem.findAll({ where: { id: rows.map((l) => l.itemId) }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction })).map((i) => [i.id, i]));
    const change = new Map(lines.map((l) => [l.lineId, l]));
    for (const lid of change.keys()) if (!rows.some((l) => l.id === lid)) throw AppError.rule('UNKNOWN_LINE', 'A line is not in this request');
    const short = [];
    const over = [];
    let total = 0;
    const parts = new Map();
    for (const l of rows) {
      const item = items.get(l.itemId);
      const c = change.get(l.id);
      // the store picks batches (qty = their sum), or gives the qty from the oldest batches first
      const picks = c && c.batches && c.batches.length ? c.batches.map((b) => ({ batchId: b.batchId, qty: lineQty(b, item.unit) })) : null;
      const qty = picks ? m.round(picks.reduce((t, p) => t + p.qty, 0), 3) : (c && (c.qty !== undefined || c.qtyMain !== undefined || c.qtySub !== undefined) ? lineQty(c, item.unit) : l.qty);
      // the store may send less, never more than the department asked for (the job pays for what is sent)
      if (qty > l.qty + 0.0005) over.push({ lineId: l.id, item: item.name, asked: m.splitQty(l.qty, item.unit).text, sending: m.splitQty(qty, item.unit).text });
      if (qty > item.stockQty + 1e-9) { short.push({ item: item.name, stock: m.splitQty(item.stockQty, item.unit).text, asked: m.splitQty(qty, item.unit).text }); continue; }
      let value = 0;
      if (qty > 0) {
        const got = await batches.take(transaction, item, qty, picks);
        parts.set(l.id, got);
        value = m.round(got.reduce((t, p) => t + p.value, 0), 2);
      }
      const rate = qty > 0 ? m.round(value / qty, 4) : 0;
      item.stockQty = m.round(item.stockQty - qty, 3);
      item.stockValue = item.stockQty === 0 ? 0 : Math.max(0, m.round(item.stockValue - value, 2));
      Object.assign(l, { sentQty: qty, rate, value });
      total = m.round(total + value, 2);
      if (qty > 0) {
        await StoreMove.create({ companyId, store: 'CHEMICAL', itemId: item.id, moveDate: today(), kind: 'ISSUE', qty: -qty, value: -value, departmentId: r.departmentId, requestId: id, createdById: req.user.id }, { transaction });
      }
    }
    if (short.length) throw AppError.rule('NOT_ENOUGH_STOCK', `Not enough ${short[0].item}: ${short[0].stock} in stock, ${short[0].asked} asked`, { lines: short });
    if (over.length) throw AppError.rule('MORE_THAN_REQUESTED', `${over[0].item}: ${over[0].sending} is more than the ${over[0].asked} asked for`, { lines: over });
    if (!rows.some((l) => l.sentQty > 0)) throw AppError.rule('NOTHING_TO_SEND', 'Send at least one chemical');
    for (const l of rows) await l.save({ transaction });
    for (const [lineId, got] of parts) await batches.recordIssue(transaction, { companyId, requestId: id, requestLineId: lineId, itemId: rows.find((l) => l.id === lineId).itemId }, got);
    for (const i of items.values()) await i.save({ transaction });
    Object.assign(r, { status: 'IN_WAY', sentById: req.user.id, sentAt: new Date(), sentThrough: sentThrough || null, totalValue: total });
    await r.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'CHEMICAL_REQUEST_SENT', entityType: 'ChemicalRequest', entityId: id, after }, { transaction });
    return after;
  });
}

/* ---------------- chemical not in stock ---------------- */

async function openLine(req, id, lineId, where, transaction) {
  const r = await findOr404(req, id, where, transaction);
  if (!OPEN.includes(r.status)) throw AppError.rule('NOT_OPEN', 'This request is already sent or closed');
  const l = await ChemicalRequestLine.findOne({ where: { id: lineId, requestId: id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!l) throw AppError.rule('UNKNOWN_LINE', 'A line is not in this request');
  return { r, l };
}

/** Store: "we do not have it, we can give this one instead". */
async function offerAlternate(req, id, lineId, data) {
  return sequelize.transaction(async (transaction) => {
    const { l } = await openLine(req, id, lineId, {}, transaction);
    if (l.altStatus === 'OFFERED') throw AppError.rule('ALREADY_OFFERED', 'An alternate is already waiting for the department');
    const alt = await StoreItem.findOne({ where: { id: data.itemId, companyId: req.user.companyId, store: 'CHEMICAL' }, transaction });
    if (!alt || !alt.isActive) throw AppError.rule('UNKNOWN_ITEM', 'Pick a chemical of the chemical store');
    if (alt.id === l.itemId) throw AppError.rule('SAME_ITEM', 'The alternate must be a different chemical');
    const others = await ChemicalRequestLine.count({ where: { requestId: id, itemId: alt.id }, transaction });
    if (others) throw AppError.rule('DUPLICATE_ITEM', `${alt.name} is already in this request`);
    const qty = lineQty(data, alt.unit);
    if (!(qty > 0)) throw AppError.rule('QTY_REQUIRED', `Enter the quantity of ${alt.name}`);
    Object.assign(l, { altItemId: alt.id, altQty: qty, altStatus: 'OFFERED', altNote: data.note || null, altOfferedById: req.user.id, altOfferedAt: new Date(), altDecidedById: null, altDecidedAt: null });
    await l.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'CHEMICAL_ALTERNATE_OFFERED', entityType: 'ChemicalRequest', entityId: id, after }, { transaction });
    return after;
  });
}

/** Store: "it is not in stock; it will come on this date". */
async function setEta(req, id, lineId, data) {
  return sequelize.transaction(async (transaction) => {
    const { l } = await openLine(req, id, lineId, {}, transaction);
    Object.assign(l, { etaDate: data.etaDate || null, etaNote: data.note || null, etaById: req.user.id, etaAt: new Date() });
    await l.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'CHEMICAL_ETA_SET', entityType: 'ChemicalRequest', entityId: id, after }, { transaction });
    return after;
  });
}

/** Department: yes (the line becomes the alternate chemical) or no (keeps the first chemical). */
async function answerAlternate(req, code, id, lineId, { accept }) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const { l } = await openLine(req, id, lineId, { departmentId: d.id }, transaction);
    if (l.altStatus !== 'OFFERED') throw AppError.rule('NO_ALTERNATE', 'The store has not offered an alternate for this chemical');
    if (accept) {
      Object.assign(l, { originalItemId: l.originalItemId || l.itemId, itemId: l.altItemId, qty: l.altQty, etaDate: null, etaNote: null, etaById: null, etaAt: null });
    }
    Object.assign(l, { altStatus: accept ? 'ACCEPTED' : 'DECLINED', altDecidedById: req.user.id, altDecidedAt: new Date() });
    await l.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: accept ? 'CHEMICAL_ALTERNATE_ACCEPTED' : 'CHEMICAL_ALTERNATE_DECLINED', entityType: 'ChemicalRequest', entityId: id, after }, { transaction });
    return after;
  });
}

/** Store: chemicals departments are asking for (Queue + Process) that the store does not have enough of. */
async function shortages(req) {
  const rows = await ChemicalRequestLine.findAll({
    include: [
      { model: ChemicalRequest, as: 'request', required: true, where: { companyId: req.user.companyId, status: OPEN }, include: [{ model: Service, as: 'department' }] },
      { model: StoreItem, as: 'item', include: m.itemInclude },
    ],
  });
  const by = new Map();
  for (const l of rows) {
    const t = by.get(l.itemId) || { item: itemBrief(l.item), stock: l.item.stockQty, demand: 0, requests: [] };
    t.demand = m.round(t.demand + l.qty, 3);
    t.requests.push({ id: l.request.id, reqNo: l.request.reqNo, department: dept(l.request.department), qty: l.qty, qtySplit: m.splitQty(l.qty, l.item.unit), eta: l.etaDate, alternateStatus: l.altStatus });
    by.set(l.itemId, t);
  }
  const data = [...by.values()].filter((t) => t.demand > t.stock).map((t) => ({
    ...t,
    stockSplit: m.splitQty(t.stock, t.item.unit),
    demandSplit: m.splitQty(t.demand, t.item.unit),
    shortQty: m.round(t.demand - Math.max(0, t.stock), 3),
    shortSplit: m.splitQty(m.round(t.demand - Math.max(0, t.stock), 3), t.item.unit),
  })).sort((a, b) => a.item.label.localeCompare(b.item.label));
  return { data, total: data.length };
}

/* ---------------- costing ---------------- */

/**
 * Chemical cost of requests that left the store (In-Way + Delivered).
 * A request for one SO card goes to that card; a request for the whole job is shared between the
 * job's SO cards by their meters in the job.
 */
async function costOf(req, jobIds) {
  const reqs = await ChemicalRequest.findAll({
    where: { companyId: req.user.companyId, jobId: jobIds, status: ['IN_WAY', 'DELIVERED'] },
    include: [{ model: ChemicalRequestLine, as: 'lines', include: [{ model: StoreItem, as: 'item', include: m.itemInclude }] }, { model: Service, as: 'department' }],
    order: [['sentAt', 'ASC']],
  });
  return reqs;
}

/** Rate parts of a sent line after returns: [{ rate, qty, value }] (one part when sent before batches). */
function partsOf(l, issued, f = 1) {
  const got = issued.get(l.id);
  if (!got || !got.length) return [{ rate: l.rate, qty: m.round((l.sentQty - l.returnedQty) * f, 3), value: m.round((l.value - l.returnedValue) * f, 2) }];
  return got.map((b) => ({ rate: b.rate, qty: m.round((b.qty - b.returnedQty) * f, 3), value: m.round((b.qty - b.returnedQty) * b.rate * f, 2) }));
}

function chemicalTotals(lines) {
  const by = new Map();
  for (const { item, qty, value, parts } of lines) {
    const t = by.get(item.id) || { item: { id: item.id, name: item.name, label: m.itemJSON(item).label, unit: item.unit }, qty: 0, value: 0, rates: new Map() };
    t.qty = m.round(t.qty + qty, 3);
    t.value = m.round(t.value + value, 2);
    for (const p of parts || []) {
      const x = t.rates.get(p.rate) || { rate: p.rate, qty: 0, value: 0 };
      x.qty = m.round(x.qty + p.qty, 3);
      x.value = m.round(x.value + p.value, 2);
      t.rates.set(p.rate, x);
    }
    by.set(item.id, t);
  }
  return [...by.values()].map(({ rates, ...t }) => {
    // same chemical at different rates: 20 KG @ 40 = 800, 35 KG @ 45 = 1575
    const byRate = [...rates.values()].filter((x) => x.qty > 0).map((x) => ({ ...x, qtySplit: m.splitQty(x.qty, t.item.unit) })).sort((a, b) => a.rate - b.rate);
    return { ...t, qtySplit: m.splitQty(t.qty, t.item.unit), avgRate: t.qty ? m.round(t.value / t.qty, 4) : 0, byRate, mixedRates: byRate.length > 1 };
  }).sort((a, b) => b.value - a.value);
}

async function jobCost(req, jobId) {
  const job = await Job.findOne({ where: { id: jobId, companyId: req.user.companyId } });
  if (!job) throw AppError.notFound('Job');
  const reqs = await costOf(req, [job.id]);
  const issued = await batches.issuesOf(reqs.flatMap((r) => r.lines.map((l) => l.id)));
  const lines = reqs.flatMap((r) => r.lines.filter((l) => l.sentQty > 0).map((l) => ({ item: l.item, qty: m.round(l.sentQty - l.returnedQty, 3), value: m.round(l.value - l.returnedValue, 2), parts: partsOf(l, issued) })));
  return {
    job: { id: job.id, jobNo: job.jobNo },
    totalValue: m.round(reqs.reduce((t, r) => t + net(r), 0), 2),
    chemicals: chemicalTotals(lines),
    requests: reqs.map((r) => ({ id: r.id, reqNo: r.reqNo, department: dept(r.department), status: r.status, sentAt: r.sentAt, soCardId: r.soCardId, totalValue: r.totalValue, returnedValue: r.returnedValue, netValue: net(r) })),
  };
}

/** departmentId: only that department's jobs (department screens). */
async function soCardCost(req, soCardId, departmentId) {
  const card = await SoCard.findOne({ where: { id: soCardId, companyId: req.user.companyId } });
  if (!card) throw AppError.notFound('SO card');
  const mine = await JobItem.findAll({ where: { soCardId: card.id }, attributes: ['jobId'], include: departmentId ? [{ model: Job, as: 'job', attributes: [], where: { departmentId } }] : [] });
  const jobIds = [...new Set(mine.map((i) => i.jobId))];
  if (departmentId && !jobIds.length) throw AppError.notFound('SO card');
  if (!jobIds.length) return { soCard: { id: card.id, cardNo: card.cardNo, cardLabel: soLabel(card.cardNo, card.isGreyReturn) }, totalValue: 0, chemicals: [], byJob: [] };
  const all = await JobItem.findAll({ where: { jobId: jobIds } });
  const share = {};
  for (const jid of jobIds) {
    const items = all.filter((i) => i.jobId === jid);
    const total = items.reduce((t, i) => t + i.meters, 0);
    const minePart = items.filter((i) => i.soCardId === card.id).reduce((t, i) => t + i.meters, 0);
    share[jid] = total ? minePart / total : 0;
  }
  const reqs = await costOf(req, jobIds);
  const issued = await batches.issuesOf(reqs.flatMap((r) => r.lines.map((l) => l.id)));
  const lines = [];
  const byJob = {};
  const jobs = new Map((await Job.findAll({ where: { id: jobIds } })).map((j) => [j.id, j]));
  for (const r of reqs) {
    if (r.soCardId && r.soCardId !== card.id) continue;
    const f = r.soCardId ? 1 : share[r.jobId];
    for (const l of r.lines) if (l.sentQty > 0) lines.push({ item: l.item, qty: m.round((l.sentQty - l.returnedQty) * f, 3), value: m.round((l.value - l.returnedValue) * f, 2), parts: partsOf(l, issued, f) });
    const b = byJob[r.jobId] || { job: { id: r.jobId, jobNo: jobs.get(r.jobId).jobNo }, department: dept(r.department), sharePercent: m.round(share[r.jobId] * 100, 2), value: 0, requests: 0 };
    b.value = m.round(b.value + net(r) * f, 2);
    b.requests += 1;
    byJob[r.jobId] = b;
  }
  const chemicals = chemicalTotals(lines);
  return {
    soCard: { id: card.id, cardNo: card.cardNo, cardLabel: soLabel(card.cardNo, card.isGreyReturn) },
    totalValue: m.round(chemicals.reduce((t, c) => t + c.value, 0), 2),
    chemicals,
    byJob: Object.values(byJob),
  };
}

/**
 * Cost report: every Job (by: 'job') or every SO card (by: 'so-card') that got chemicals,
 * for chemicals sent between dateFrom and dateTo. Filters: customerId, departmentId.
 */
async function costReport(req, q) {
  const where = { companyId: req.user.companyId, status: ['IN_WAY', 'DELIVERED'] };
  if (q.departmentId) where.departmentId = q.departmentId;
  if (q.dateFrom || q.dateTo) where.sentAt = { ...(q.dateFrom && { [Op.gte]: dayStart(q.dateFrom) }), ...(q.dateTo && { [Op.lte]: dayEnd(q.dateTo) }) };
  const reqs = await ChemicalRequest.findAll({
    where,
    include: [
      { model: Service, as: 'department' },
      { model: Job, as: 'job', include: [{ model: JobItem, as: 'items', include: [{ model: SoCard, as: 'soCard', include: [{ model: Customer, as: 'customer', paranoid: false }] }] }] },
    ],
    order: [['sentAt', 'ASC']],
  });
  const rows = new Map();
  const add = (key, make, value, r) => {
    const row = rows.get(key) || { ...make(), value: 0, requests: 0, jobs: new Set(), departments: new Map(), lastSentAt: null };
    row.value += value;
    row.requests += 1;
    row.jobs.add(r.job.jobNo);
    row.departments.set(r.department.id, r.department.name);
    row.lastSentAt = r.sentAt;
    rows.set(key, row);
  };
  for (const r of reqs) {
    const items = r.job.items;
    if (q.by === 'job') {
      const cards = [...new Map(items.map((i) => [i.soCard.id, i.soCard])).values()];
      if (q.customerId && !cards.some((c) => c.customerId === q.customerId)) continue;
      add(r.jobId, () => ({
        job: { id: r.job.id, jobNo: r.job.jobNo, jobDate: r.job.jobDate, status: r.job.status },
        soNos: cards.map((c) => c.cardNo).sort((a, b) => a - b),
        customers: [...new Set(cards.map((c) => (c.customer ? c.customer.name : null)).filter(Boolean))],
      }), net(r), r);
    } else {
      const total = items.reduce((t, i) => t + i.meters, 0);
      const parts = new Map();
      for (const i of items) {
        const p = parts.get(i.soCard.id) || { card: i.soCard, meters: 0 };
        p.meters += i.meters;
        parts.set(i.soCard.id, p);
      }
      for (const { card, meters } of parts.values()) {
        if (r.soCardId && r.soCardId !== card.id) continue;
        if (q.customerId && card.customerId !== q.customerId) continue;
        const f = r.soCardId ? 1 : (total ? meters / total : 0);
        add(card.id, () => ({
          soCard: { id: card.id, cardNo: card.cardNo, cardLabel: soLabel(card.cardNo, card.isGreyReturn), cardDate: card.cardDate },
          customer: card.customer ? { id: card.customer.id, name: card.customer.name } : null,
        }), net(r) * f, r);
      }
    }
  }
  const all = [...rows.values()].map((row) => ({
    ...row,
    value: m.round(row.value, 2),
    jobs: undefined,
    jobNos: [...row.jobs].sort((a, b) => a - b),
    departments: [...row.departments.values()],
  })).sort((a, b) => (b.job ? b.job.jobNo - a.job.jobNo : b.soCard.cardNo - a.soCard.cardNo));
  const totalValue = m.round(all.reduce((t, x) => t + x.value, 0), 2);
  return { data: all.slice((q.page - 1) * q.limit, q.page * q.limit), total: all.length, page: q.page, limit: q.limit, totalValue };
}

module.exports = {
  costReport,
  formData, deptList, deptGet, create, update, cancel, receive,
  storeList, storeGet, accept, reject, send,
  offerAlternate, setEta, answerAlternate, shortages,
  jobCost, soCardCost, needDept, lineQty,
};
