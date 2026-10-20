// Chemical returns: a department sends unused chemical (of a Received request) back to the Chemical Store.
//   department      store        status
//   Sent back       To receive   PENDING     department can still cancel it
//   Returned        Received     RECEIVED    store took it: stock goes UP at the rate it went out at,
//                                            and the Job / SO card chemical cost goes DOWN by the same value
//   Rejected        Rejected     REJECTED    store did not take it (with a reason)
const {
  sequelize, ChemicalRequest, ChemicalRequestLine, ChemicalReturn, ChemicalReturnLine, StoreItem, StoreMove, Job, Service, User,
} = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const m = require('./storeMasterService');
const batches = require('./batchService');
const { needDept, lineQty } = require('./chemicalRequestService');

const COUNTER = 'chemical_return_no';
const DEPT_TEXT = { PENDING: 'Sent back', RECEIVED: 'Returned', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
const STORE_TEXT = { PENDING: 'To receive', RECEIVED: 'Received', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
const TABS = { pending: ['PENDING'], received: ['RECEIVED'], closed: ['REJECTED', 'CANCELLED'] };

const person = (u) => (u ? { id: u.id, name: u.name } : null);
const include = () => [
  { model: ChemicalReturnLine, as: 'lines', include: [{ model: StoreItem, as: 'item', include: m.itemInclude.map((x) => ({ ...x })) }] },
  { model: ChemicalRequest, as: 'request', include: [{ model: Job, as: 'job' }] },
  { model: Service, as: 'department' },
  ...['created', 'received', 'closed'].map((w) => ({ model: User, as: `${w}By`, attributes: ['id', 'name'] })),
];

function json(x) {
  return {
    id: x.id,
    returnNo: x.returnNo,
    status: x.status,
    departmentStatusText: DEPT_TEXT[x.status],
    storeStatusText: STORE_TEXT[x.status],
    department: x.department ? { id: x.department.id, code: x.department.code, name: x.department.name } : null,
    request: x.request ? { id: x.request.id, reqNo: x.request.reqNo } : null,
    job: x.request && x.request.job ? { id: x.request.job.id, jobNo: x.request.job.jobNo } : null,
    notes: x.notes,
    rejectReason: x.rejectReason,
    totalValue: x.totalValue,
    lines: (x.lines || []).map((l) => ({
      id: l.id, requestLineId: l.requestLineId,
      item: { id: l.item.id, name: l.item.name, label: m.itemJSON(l.item).label, unit: l.item.unit },
      qty: l.qty, qtySplit: m.splitQty(l.qty, l.item.unit), rate: l.rate, value: l.value,
    })),
    createdBy: person(x.createdBy), createdAt: x.createdAt,
    receivedBy: person(x.receivedBy), receivedAt: x.receivedAt,
    closedBy: person(x.closedBy), closedAt: x.closedAt,
  };
}

const load = async (id, transaction) => json(await ChemicalReturn.findByPk(id, { include: include(), transaction }));

async function findOr404(req, id, where, transaction) {
  const x = await ChemicalReturn.findOne({ where: { id, companyId: req.user.companyId, ...where }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!x) throw AppError.notFound('Chemical return');
  return x;
}

async function list(req, where, q) {
  const all = { companyId: req.user.companyId, ...where };
  const w = { ...all, ...(q.tab && q.tab !== 'all' ? { status: TABS[q.tab] } : {}) };
  const { rows, count } = await ChemicalReturn.findAndCountAll({ where: w, include: include(), distinct: true, order: [['createdAt', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit });
  const by = Object.fromEntries((await ChemicalReturn.findAll({ where: all, attributes: ['status', [sequelize.fn('count', sequelize.col('id')), 'n']], group: ['status'], raw: true })).map((r) => [r.status, Number(r.n)]));
  const counts = Object.fromEntries(Object.entries(TABS).map(([t, sts]) => [t, sts.reduce((n, s2) => n + (by[s2] || 0), 0)]));
  return { data: rows.map(json), total: count, page: q.page, limit: q.limit, counts };
}

/* ---------------- department ---------------- */

async function deptList(req, code, q) {
  const d = await needDept(req, code, 'VIEW');
  return list(req, { departmentId: d.id, ...(q.requestId && { requestId: q.requestId }) }, q);
}

async function deptGet(req, code, id) {
  const d = await needDept(req, code, 'VIEW');
  await findOr404(req, id, { departmentId: d.id });
  return load(id);
}

async function create(req, code, { requestId, lines, notes }) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const companyId = req.user.companyId;
    const r = await ChemicalRequest.findOne({ where: { id: requestId, companyId, departmentId: d.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw AppError.notFound('Chemical request');
    if (r.status !== 'DELIVERED') throw AppError.rule('NOT_RECEIVED', 'Only chemicals you have received can be sent back');
    const rows = new Map((await ChemicalRequestLine.findAll({ where: { requestId }, include: [{ model: StoreItem, as: 'item' }], transaction })).map((l) => [l.id, l]));
    // qty already on its way back (pending returns)
    const waiting = await sequelize.query(
      `SELECT l."requestLineId" AS id, SUM(l.qty) AS q FROM chemical_return_lines l JOIN chemical_returns x ON x.id = l."returnId"
       WHERE x."requestId" = $1 AND x.status = 'PENDING' GROUP BY l."requestLineId"`,
      { bind: [requestId], type: sequelize.QueryTypes.SELECT, transaction },
    );
    const onWay = new Map(waiting.map((w) => [w.id, Number(w.q)]));
    if (new Set(lines.map((l) => l.requestLineId)).size !== lines.length) throw AppError.rule('DUPLICATE_ITEM', 'A chemical is twice in the list; put it once');
    const out = lines.map((l) => {
      const row = rows.get(l.requestLineId);
      if (!row || !(row.sentQty > 0)) throw AppError.rule('UNKNOWN_LINE', 'A line is not in this request');
      const qty = lineQty(l, row.item.unit);
      if (!(qty > 0)) throw AppError.rule('QTY_REQUIRED', `Enter the quantity of ${row.item.name}`);
      const can = m.round(row.sentQty - row.returnedQty - (onWay.get(row.id) || 0), 3);
      if (qty > can) throw AppError.rule('TOO_MUCH', `${row.item.name}: you can send back at most ${m.splitQty(Math.max(0, can), row.item.unit).text}`);
      return { requestLineId: row.id, itemId: row.itemId, qty, rate: row.rate || 0, value: m.round(qty * (row.rate || 0), 2) };
    });
    const returnNo = await counters.take(companyId, COUNTER, async () => ((await ChemicalReturn.max('returnNo', { where: { companyId }, transaction })) || 0) + 1, transaction);
    const x = await ChemicalReturn.create({
      companyId, returnNo, requestId, departmentId: d.id, notes: notes || null, createdById: req.user.id,
      totalValue: m.round(out.reduce((t, l) => t + l.value, 0), 2),
    }, { transaction });
    await ChemicalReturnLine.bulkCreate(out.map((l) => ({ ...l, returnId: x.id })), { transaction });
    const after = await load(x.id, transaction);
    await audit.log(req, { action: 'CHEMICAL_RETURN_CREATED', entityType: 'ChemicalReturn', entityId: x.id, after }, { transaction });
    return after;
  });
}

async function close(req, x, status, reason, transaction) {
  Object.assign(x, { status, rejectReason: reason || null, closedById: req.user.id, closedAt: new Date() });
  await x.save({ transaction });
  const after = await load(x.id, transaction);
  await audit.log(req, { action: `CHEMICAL_RETURN_${status}`, entityType: 'ChemicalReturn', entityId: x.id, after }, { transaction });
  return after;
}

async function cancel(req, code, id) {
  return sequelize.transaction(async (transaction) => {
    const d = await needDept(req, code, 'FULL', transaction);
    const x = await findOr404(req, id, { departmentId: d.id }, transaction);
    if (x.status !== 'PENDING') throw AppError.rule('NOT_PENDING', 'The store has already handled this return');
    return close(req, x, 'CANCELLED', null, transaction);
  });
}

/* ---------------- chemical store ---------------- */

const storeList = (req, q) => list(req, { ...(q.departmentId && { departmentId: q.departmentId }) }, q);

async function storeGet(req, id) {
  await findOr404(req, id, {});
  return load(id);
}

async function receive(req, id) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const x = await findOr404(req, id, {}, transaction);
    if (x.status !== 'PENDING') throw AppError.rule('NOT_PENDING', 'This return is already handled');
    const lines = await ChemicalReturnLine.findAll({ where: { returnId: id }, transaction });
    const items = new Map((await StoreItem.findAll({ where: { id: lines.map((l) => l.itemId) }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction })).map((i) => [i.id, i]));
    const reqLines = new Map((await ChemicalRequestLine.findAll({ where: { id: lines.map((l) => l.requestLineId) }, lock: transaction.LOCK.UPDATE, transaction })).map((l) => [l.id, l]));
    const r = await ChemicalRequest.findByPk(x.requestId, { lock: transaction.LOCK.UPDATE, transaction });
    const today = new Date().toISOString().slice(0, 10);
    let total = 0;
    for (const l of lines) {
      const item = items.get(l.itemId);
      // back into the batches it came from, at their rates (owner 2026-10-19)
      const back = await batches.returnLine(transaction, l.requestLineId, l.qty);
      if (back === null) {
        await batches.add(transaction, { companyId, store: 'CHEMICAL', itemId: item.id, source: 'RETURN', qty: l.qty, rate: l.rate, value: l.value, returnId: x.id });
      } else if (back !== Number(l.value)) {
        Object.assign(l, { value: back, rate: l.qty ? m.round(back / l.qty, 4) : 0 });
        await l.save({ transaction });
      }
      total = m.round(total + Number(l.value), 2);
      item.stockQty = m.round(item.stockQty + l.qty, 3);
      item.stockValue = m.round(item.stockValue + l.value, 2);
      await item.save({ transaction });
      const rl = reqLines.get(l.requestLineId);
      rl.returnedQty = m.round(rl.returnedQty + l.qty, 3);
      rl.returnedValue = m.round(rl.returnedValue + l.value, 2);
      await rl.save({ transaction });
      await StoreMove.create({ companyId, store: 'CHEMICAL', itemId: item.id, moveDate: today, kind: 'RETURN', qty: l.qty, value: l.value, departmentId: x.departmentId, requestId: x.requestId, returnId: x.id, createdById: req.user.id }, { transaction });
    }
    x.totalValue = total;
    r.returnedValue = m.round(r.returnedValue + x.totalValue, 2);
    await r.save({ transaction });
    Object.assign(x, { status: 'RECEIVED', receivedById: req.user.id, receivedAt: new Date() });
    await x.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'CHEMICAL_RETURN_RECEIVED', entityType: 'ChemicalReturn', entityId: id, after }, { transaction });
    return after;
  });
}

async function reject(req, id, { reason }) {
  return sequelize.transaction(async (transaction) => {
    const x = await findOr404(req, id, {}, transaction);
    if (x.status !== 'PENDING') throw AppError.rule('NOT_PENDING', 'This return is already handled');
    return close(req, x, 'REJECTED', reason, transaction);
  });
}

module.exports = { deptList, deptGet, create, cancel, storeList, storeGet, receive, reject };
