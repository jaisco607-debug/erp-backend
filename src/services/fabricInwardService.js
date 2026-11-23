// Store Management > Fabric Inward: cloth BOUGHT from a vendor. It is the grey inward (greyLotService) with a vendor in place of the customer:
// when a customer's own cloth is spoilt in processing, new cloth is bought from a vendor, processed and given to the customer.
// - Every arrival is its own entry: inward no (00001) and Type# (0001) are given by the server, one after the other, per company.
// - The quantity is the list of thaans (length of each, in meters or yards, width optional) or a plain total + pieces.
// - An entry starts as a draft; APPROVED entries are the stock (the outward / stock management steps come next). Only the client admin can take an approval back.
// - Approved entries cannot be edited or deleted. Entries are deleted softly; their numbers are never reused.
const { Op } = require('sequelize');
const { sequelize, FabricInward, FabricInwardThaan, Vendor, Quality } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { round: r2 } = require('../utils/money');
const audit = require('./auditService');
const counters = require('./counterService');
const m = require('./storeMasterService');

const NO = 'fabric_inward_no';
const TYPE = 'fabric_type_no';
const YARD = 0.9144;
const toMeters = (qty, unit) => r2(unit === 'YARD' ? qty * YARD : qty);
const toYards = (meters) => r2(meters / YARD);
const noText = (n) => String(n).padStart(5, '0');
const typeText = (n) => String(n).padStart(4, '0');
const blank = (v) => (v === '' ? null : v);
const blanks = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, blank(v)]));
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const maxNo = (companyId, transaction) => FabricInward.max('inwardNo', { where: { companyId }, paranoid: false, transaction });
const maxType = async (companyId, transaction) => {
  const [row] = await sequelize.query(`SELECT max(("typeNo")::int) AS n FROM fabric_inwards WHERE "companyId" = $1 AND "typeNo" ~ '^[0-9]+$'`,
    { bind: [companyId], type: sequelize.QueryTypes.SELECT, transaction });
  return row.n || 0;
};

const include = [
  { model: Vendor, as: 'vendor', paranoid: false },
  { model: Quality, as: 'quality', attributes: ['id', 'name'], paranoid: false },
];
const fullInclude = [...include, { model: FabricInwardThaan, as: 'thaans' }];

function json(e, extra = {}) {
  const yd = (v) => (e.unit === 'YARD' ? v : null); // yards are shown only for cloth that came in yards
  const balance = r2(e.inwardMeters - e.outwardMeters);
  return {
    id: e.id,
    inwardNo: e.inwardNo,
    inwardText: noText(e.inwardNo),
    typeNo: e.typeNo,
    dcNo: e.dcNo,
    inwardDate: e.inwardDate,
    vendor: e.vendor ? { id: e.vendor.id, code: e.vendor.code, name: e.vendor.name, label: `${e.vendor.name} (${e.vendor.code})` } : { id: e.vendorId },
    quality: e.quality ? { id: e.quality.id, name: e.quality.name } : { id: e.qualityId },
    unit: e.unit,
    showYards: e.unit === 'YARD',
    inwardMeters: e.inwardMeters,
    inwardYards: yd(e.inwardYards),
    pieces: e.pieces,
    outwardMeters: e.outwardMeters,
    balanceMeters: balance,
    balanceYards: yd(toYards(balance)),
    // the rate (per meter or per yard), every thaan's amount and the total; the bill is made in Accounts > Purchase Invoice (kind FABRIC)
    rate: e.rate ?? null,
    rateUnit: e.rate == null ? null : e.rateUnit || e.unit,
    rateText: e.rate == null ? null : `per ${(e.rateUnit || e.unit) === 'YARD' ? 'yard' : 'meter'}`,
    hasRate: e.rate != null,
    amount: e.amount ?? null,
    purchaseInvoice: extra.purchaseInvoice || null,
    invoiced: Boolean(extra.purchaseInvoice),
    glm: e.glm,
    gsm: e.gsm,
    width: e.width ?? null,
    widths: [...new Set((e.thaans || []).map((t) => t.width ?? e.width).filter((w) => w != null))].sort((a, b) => a - b),
    partyRef: e.partyRef,
    vehicleNo: e.vehicleNo,
    remarks: e.remarks,
    isApproved: e.isApproved,
    statusText: e.isApproved ? 'APPROVED' : 'UN-APPROVED',
    approvedAt: e.approvedAt,
    isActive: e.isActive,
    createdAt: e.createdAt,
    ...(e.thaans && {
      thaans: [...e.thaans].sort((a, b) => a.thaanNo - b.thaanNo).map((t) => ({
        id: t.id, thaanNo: t.thaanNo, meters: t.meters, yards: yd(t.yards), width: t.width ?? e.width ?? null, status: t.status, takenMeters: t.takenMeters, freeMeters: r2(t.meters - t.takenMeters), amount: t.amount ?? null,
      })),
    }),
  };
}

async function findOr404(req, id, transaction, lock = false) {
  const e = await FabricInward.findOne({ where: { id, companyId: req.user.companyId }, lock: lock ? transaction.LOCK.UPDATE : undefined, transaction });
  if (!e) throw AppError.notFound('Fabric inward');
  return e;
}
const load = async (id, transaction) => json(await FabricInward.findByPk(id, { include: fullInclude, transaction }));

/** Quantity from the form: thaans [52.5, { length: 48, width: 58 } ...] in `unit`, or a plain total (inwardMeters / inwardYards) + pieces. */
function quantities(data, current = {}) {
  const unit = data.unit || current.unit || 'METER';
  if (data.thaans) {
    const thaans = data.thaans.map((item, i) => {
      const len = typeof item === 'object' ? item.length : item;
      const own = typeof item === 'object' ? item.width : undefined;
      return { thaanNo: i + 1, meters: toMeters(len, unit), yards: unit === 'YARD' ? r2(len) : toYards(len), width: own !== undefined ? own : data.width !== undefined ? data.width : (current.width ?? null) };
    });
    return { lot: { unit, pieces: thaans.length, inwardMeters: r2(thaans.reduce((t, x) => t + x.meters, 0)), inwardYards: r2(thaans.reduce((t, x) => t + x.yards, 0)) }, thaans };
  }
  const lot = { unit };
  if (unit === 'YARD' && data.inwardYards !== undefined) Object.assign(lot, { inwardYards: r2(data.inwardYards), inwardMeters: toMeters(data.inwardYards, 'YARD') });
  else if (data.inwardMeters !== undefined) Object.assign(lot, { inwardMeters: r2(data.inwardMeters), inwardYards: toYards(data.inwardMeters) });
  if (data.pieces !== undefined) lot.pieces = data.pieces;
  return { lot, thaans: null };
}
const QTY_FIELDS = ['unit', 'thaans', 'inwardMeters', 'inwardYards', 'pieces'];

async function checkLinks(req, data, transaction) {
  const companyId = req.user.companyId;
  if (data.vendorId) {
    const v = await Vendor.findOne({ where: { id: data.vendorId, companyId }, transaction });
    if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'Vendor not found');
    if (!v.isActive) throw AppError.rule('VENDOR_INACTIVE', 'This vendor is switched off');
  }
  if (data.qualityId) {
    const q = await Quality.findOne({ where: { id: data.qualityId, companyId }, transaction });
    if (!q) throw AppError.rule('UNKNOWN_QUALITY', 'Quality not found');
    if (!q.isActive) throw AppError.rule('QUALITY_INACTIVE', 'This quality is switched off');
  }
}

/** Quality typed by hand: the existing quality with that name (any letter case) is used, otherwise a new one is added. */
async function resolveQuality(req, data, transaction) {
  if (!data.qualityName) return;
  const name = data.qualityName.trim();
  let q = await Quality.findOne({ where: { companyId: req.user.companyId, [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), name.toLowerCase())] }, transaction });
  if (q && !q.isActive) throw AppError.rule('QUALITY_INACTIVE', 'This quality is switched off');
  if (!q) {
    q = await Quality.create({ companyId: req.user.companyId, name, createdById: req.user.id }, { transaction });
    await audit.log(req, { action: 'QUALITY_CREATED', entityType: 'Quality', entityId: q.id, after: { id: q.id, name, from: 'fabric inward' } }, { transaction });
  }
  data.qualityId = q.id;
  delete data.qualityName;
}

/** Number typed by hand: must be free (also not used by a deleted entry); the automatic number then continues after it. */
async function takeTypedNo(req, inwardNo, transaction, exceptId) {
  const companyId = req.user.companyId;
  const where = { companyId, inwardNo };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  if (await FabricInward.findOne({ where, paranoid: false, transaction })) throw AppError.rule('INWARD_NO_TAKEN', `Fabric inward ${noText(inwardNo)} already exists`);
  const next = await counters.peek(companyId, NO, async () => ((await maxNo(companyId, transaction)) || 0) + 1, transaction);
  if (inwardNo >= next) await counters.set(companyId, NO, inwardNo + 1, transaction);
}

/** The entry screen: next numbers and every dropdown. */
async function formData(req) {
  const companyId = req.user.companyId;
  const [numbers, vendors, qualities] = await Promise.all([
    nextNumbers(req),
    Vendor.findAll({ where: { companyId, isActive: true, module: 'MAIN' }, order: [['name', 'ASC']] }),
    Quality.findAll({ where: { companyId, isActive: true }, order: [['name', 'ASC']] }),
  ]);
  return { ...numbers, nextInwardText: noText(numbers.nextInwardNo), today: today(), units: ['METER', 'YARD'], rateUnits: ['METER', 'YARD'], vendors: vendors.map(m.vendorJSON), qualities: qualities.map((q) => ({ id: q.id, name: q.name })) };
}

function filters(req, q) {
  const where = { companyId: req.user.companyId };
  for (const f of ['isActive', 'isApproved', 'vendorId', 'qualityId']) if (q[f] !== undefined) where[f] = q[f];
  if (q.dateFrom || q.dateTo) {
    where.inwardDate = {};
    if (q.dateFrom) where.inwardDate[Op.gte] = q.dateFrom;
    if (q.dateTo) where.inwardDate[Op.lte] = q.dateTo;
  }
  if (q.search) {
    const s = `%${q.search}%`;
    const or = [{ dcNo: { [Op.iLike]: s } }, { typeNo: { [Op.iLike]: s } }, { partyRef: { [Op.iLike]: s } }, { '$vendor.name$': { [Op.iLike]: s } }, { '$quality.name$': { [Op.iLike]: s } }];
    if (/^\d+$/.test(q.search)) or.push({ inwardNo: Number(q.search) });
    where[Op.or] = or;
  }
  return where;
}

async function list(req, q) {
  const { rows, count } = await FabricInward.findAndCountAll({
    where: filters(req, q), include, order: [['inwardNo', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit, subQuery: false, distinct: true,
  });
  const inv = await invoicesOf(rows.map((r) => r.id));
  return { data: rows.map((r) => json(r, { purchaseInvoice: inv.get(r.id) })), page: q.page, limit: q.limit, total: count };
}

/** One entry with its thaans and everything issued out of it (to which customer, SO card, linked card). */
async function get(req, id) {
  const e = await findOr404(req, id);
  const issues = require('./fabricIssueService');
  return { ...(await load(e.id)), purchaseInvoice: (await invoicesOf([e.id])).get(e.id) || null, invoiced: (await invoicesOf([e.id])).has(e.id), issues: (await issues.list(req, { fabricInwardId: e.id, page: 1, limit: 200 })).data };
}

/** The amount of every thaan (its length in meters or yards, as the rate is, x the rate) and the total of the entry; empty when there is no rate. */
async function reprice(e, transaction) {
  const thaans = await FabricInwardThaan.findAll({ where: { inwardId: e.id }, transaction });
  const unit = e.rateUnit || e.unit;
  const len = (t) => (unit === 'YARD' ? t.yards : t.meters);
  if (e.rate == null) {
    for (const t of thaans) { t.amount = null; await t.save({ transaction }); }
    e.amount = null;
  } else if (thaans.length) {
    for (const t of thaans) { t.amount = r2(len(t) * e.rate); await t.save({ transaction }); }
    e.amount = r2(thaans.reduce((s, t) => s + t.amount, 0));
  } else {
    e.amount = r2((unit === 'YARD' ? e.inwardYards : e.inwardMeters) * e.rate);
  }
  await e.save({ transaction });
}

/** The purchase invoice each entry is on: Map(inwardId -> { id, voucherNo, voucherLabel, status }). */
async function invoicesOf(ids, transaction) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await sequelize.query('SELECT f."inwardId", p.id, p."voucherNo", p.status FROM purchase_invoice_fabric_inwards f JOIN purchase_invoices p ON p.id = f."invoiceId" WHERE f."inwardId" IN (:ids)', { replacements: { ids }, type: sequelize.QueryTypes.SELECT, transaction });
  for (const r of rows) map.set(r.inwardId, { id: r.id, voucherNo: r.voucherNo, voucherLabel: String(r.voucherNo).padStart(5, '0'), status: r.status });
  return map;
}

async function create(req, data) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    await resolveQuality(req, data, transaction);
    if (!data.qualityId) throw AppError.rule('QUALITY_REQUIRED', 'Pick or type the quality');
    await checkLinks(req, data, transaction);
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`fabric-inward-no:${companyId}`], transaction });
    if (data.inwardNo) await takeTypedNo(req, data.inwardNo, transaction);
    const inwardNo = data.inwardNo || await counters.take(companyId, NO, async () => ((await maxNo(companyId, transaction)) || 0) + 1, transaction);
    const typeNo = typeText(await counters.take(companyId, TYPE, async () => (await maxType(companyId, transaction)) + 1, transaction));
    const q = quantities(data);
    if (q.lot.inwardMeters === undefined || q.lot.pieces === undefined) throw AppError.rule('QTY_REQUIRED', 'Enter the thaans, or the total quantity and pieces');
    const rate = blank(data.rate);
    const e = await FabricInward.create({ ...blanks(without(data, [...QTY_FIELDS, 'inwardNo', 'rate', 'rateUnit'])), ...q.lot, rate: rate ?? null, rateUnit: rate == null ? null : data.rateUnit || q.lot.unit, companyId, inwardNo, typeNo, createdById: req.user.id }, { transaction });
    if (q.thaans) await FabricInwardThaan.bulkCreate(q.thaans.map((t) => ({ ...t, inwardId: e.id })), { transaction });
    await reprice(e, transaction);
    const after = await load(e.id, transaction);
    await audit.log(req, { action: 'FABRIC_INWARD_CREATED', entityType: 'FabricInward', entityId: e.id, after }, { transaction });
    return after;
  });
}

const EDITABLE = ['typeNo', 'dcNo', 'inwardDate', 'vendorId', 'qualityId', 'partyRef', 'glm', 'gsm', 'width', 'vehicleNo', 'remarks'];

async function update(req, id, changes) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, id, transaction, true);
    if (e.isApproved) throw AppError.rule('INWARD_APPROVED', 'An approved fabric inward cannot be edited');
    const q = QTY_FIELDS.some((f) => changes[f] !== undefined) ? quantities(changes, e) : null;
    if (q && q.lot.inwardMeters !== undefined && q.lot.inwardMeters < e.outwardMeters) throw AppError.rule('BELOW_OUTWARD', `${e.outwardMeters} m have already gone out of this entry`);
    await resolveQuality(req, changes, transaction);
    await checkLinks(req, changes, transaction);
    if (changes.typeNo !== undefined && changes.typeNo !== e.typeNo
      && (await FabricInward.findOne({ where: { companyId: req.user.companyId, typeNo: changes.typeNo, id: { [Op.ne]: e.id } }, paranoid: false, transaction }))) {
      throw AppError.rule('TYPE_NO_TAKEN', `Type# ${changes.typeNo} already exists`);
    }
    if (changes.inwardNo !== undefined && changes.inwardNo !== e.inwardNo) {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`fabric-inward-no:${req.user.companyId}`], transaction });
      await takeTypedNo(req, changes.inwardNo, transaction, e.id);
      e.inwardNo = changes.inwardNo;
    }
    if (q && !q.thaans && (await FabricInwardThaan.count({ where: { inwardId: e.id }, transaction })) > 0 && (changes.inwardMeters !== undefined || changes.inwardYards !== undefined || changes.pieces !== undefined)) {
      throw AppError.rule('INWARD_HAS_THAANS', 'This entry is made of thaans: send the thaans list again instead of a total');
    }
    const before = await load(e.id, transaction);
    const oldWidth = e.width ?? null;
    for (const f of EDITABLE) if (changes[f] !== undefined) e[f] = blank(changes[f]);
    if (q) {
      Object.assign(e, q.lot);
      if (q.thaans) {
        const old = await FabricInwardThaan.findAll({ where: { inwardId: e.id }, transaction });
        const oldByNo = new Map(old.map((o) => [o.thaanNo, o]));
        for (const t of q.thaans) if (changes.width === undefined && oldByNo.has(t.thaanNo) && typeof changes.thaans[t.thaanNo - 1] !== 'object') t.width = oldByNo.get(t.thaanNo).width ?? oldWidth;
        const byNo = new Map(q.thaans.map((t) => [t.thaanNo, t]));
        const locked = old.filter((x) => x.takenMeters > 0 || x.status !== 'IN_STOCK');
        for (const o of locked) {
          const n = byNo.get(o.thaanNo);
          if (!n || n.meters !== o.meters) throw AppError.rule('THAAN_TAKEN', `Thaan ${o.thaanNo} has gone out; it cannot be changed or removed`);
          n.keep = true;
        }
        await FabricInwardThaan.destroy({ where: { inwardId: e.id, ...(locked.length ? { id: { [Op.notIn]: locked.map((x) => x.id) } } : {}) }, transaction });
        await FabricInwardThaan.bulkCreate(q.thaans.filter((t) => !t.keep).map((t) => ({ ...t, inwardId: e.id })), { transaction });
      } else if (changes.unit && changes.inwardMeters === undefined && changes.inwardYards === undefined) {
        throw AppError.rule('QTY_REQUIRED', 'Send the quantity again when changing the unit');
      }
    }
    // the rate: a number sets it (the unit defaults to the entry's unit), null clears it
    if (changes.rate !== undefined) {
      e.rate = changes.rate;
      e.rateUnit = changes.rate === null ? null : changes.rateUnit || e.rateUnit || e.unit;
    } else if (changes.rateUnit !== undefined && e.rate != null) e.rateUnit = changes.rateUnit;
    await e.save({ transaction });
    await reprice(e, transaction);
    if (changes.width !== undefined && !(q && q.thaans)) {
      await sequelize.query(`UPDATE fabric_inward_thaans SET width = :width WHERE "inwardId" = :id AND "takenMeters" = 0 AND (width IS NULL OR width = :oldWidth)`,
        { replacements: { width: e.width, id: e.id, oldWidth: oldWidth == null ? -1 : oldWidth }, transaction });
    }
    const after = await load(e.id, transaction);
    await audit.log(req, { action: 'FABRIC_INWARD_UPDATED', entityType: 'FabricInward', entityId: id, before, after }, { transaction });
    return after;
  });
}

async function setActive(req, id, isActive) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, id, transaction, true);
    const before = e.isActive;
    e.isActive = isActive;
    await e.save({ transaction });
    await audit.log(req, { action: 'FABRIC_INWARD_ACTIVE_CHANGED', entityType: 'FabricInward', entityId: id, before: { inwardNo: e.inwardNo, isActive: before }, after: { inwardNo: e.inwardNo, isActive } }, { transaction });
    return load(e.id, transaction);
  });
}

/** Approve (FULL access): the cloth is now in stock. Taking the approval back is for the client admin (checked in the route), while nothing has gone out. */
async function setApproved(req, id, approved) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, id, transaction, true);
    if (approved && !e.isActive) throw AppError.rule('INWARD_INACTIVE', 'Switch the entry on before approving it');
    if (approved && e.rate == null) throw AppError.rule('RATE_REQUIRED', 'Enter the rate before approving the entry', { field: 'rate' });
    if (!approved && e.outwardMeters > 0) throw AppError.rule('INWARD_IN_USE', `${e.outwardMeters} m have already gone out of this entry`);
    if (!approved) {
      const inv = (await invoicesOf([e.id], transaction)).get(e.id);
      if (inv) throw AppError.rule('ON_PURCHASE_INVOICE', `This entry is on purchase invoice ${inv.voucherLabel}: delete that invoice first`, { invoiceId: inv.id, voucherNo: inv.voucherNo });
    }
    e.isApproved = approved;
    e.approvedById = approved ? req.user.id : null;
    e.approvedAt = approved ? new Date() : null;
    await e.save({ transaction });
    await audit.log(req, { action: approved ? 'FABRIC_INWARD_APPROVED' : 'FABRIC_INWARD_UNAPPROVED', entityType: 'FabricInward', entityId: id, after: { inwardNo: e.inwardNo, isApproved: approved } }, { transaction });
    return load(e.id, transaction);
  });
}

async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, id, transaction, true);
    if (e.isApproved) throw AppError.rule('INWARD_APPROVED', 'An approved fabric inward cannot be deleted');
    if (e.outwardMeters > 0) throw AppError.rule('INWARD_IN_USE', 'Cloth has already gone out of this entry');
    const before = await load(e.id, transaction);
    await e.destroy({ transaction });
    await audit.log(req, { action: 'FABRIC_INWARD_DELETED', entityType: 'FabricInward', entityId: id, before }, { transaction });
  });
}

async function nextNumbers(req) {
  const companyId = req.user.companyId;
  const nextInwardNo = await counters.peek(companyId, NO, async () => ((await maxNo(companyId)) || 0) + 1);
  const nextTypeNo = typeText(await counters.peek(companyId, TYPE, async () => (await maxType(companyId)) + 1));
  return { nextInwardNo, nextTypeNo };
}

/** Client admin: where the numbering continues (e.g. to carry on from the old system). Numbers can never go back to one already used. */
async function setNextNumbers(req, { nextInwardNo, nextTypeNo }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const before = await nextNumbers(req);
    if (nextInwardNo !== undefined) {
      const used = (await maxNo(companyId, transaction)) || 0;
      if (nextInwardNo <= used) throw AppError.rule('NUMBER_USED', `Fabric inward ${used} is already used; the next one must be above it`);
      await counters.set(companyId, NO, nextInwardNo, transaction);
    }
    if (nextTypeNo !== undefined) {
      const used = await maxType(companyId, transaction);
      if (nextTypeNo <= used) throw AppError.rule('NUMBER_USED', `Type ${typeText(used)} is already used; the next one must be above it`);
      await counters.set(companyId, TYPE, nextTypeNo, transaction);
    }
    const after = { nextInwardNo: nextInwardNo ?? before.nextInwardNo, nextTypeNo: nextTypeNo !== undefined ? typeText(nextTypeNo) : before.nextTypeNo };
    await audit.log(req, { action: 'FABRIC_NUMBERING_CHANGED', entityType: 'Company', entityId: companyId, before, after }, { transaction });
    return after;
  });
}

/**
 * Fabric stock: the APPROVED, switched-on entries with cloth still in the store (balance = inward - outward).
 *   data      one row per entry (vendor, quality, thaans, balance), newest first, paged
 *   byQuality the same cloth added up per quality
 *   totals    all of it
 * showZero=true also lists entries that are used up.
 */
async function stock(req, q) {
  const where = { ...filters(req, { ...q, isApproved: undefined, isActive: undefined }), isApproved: true, isActive: true };
  const all = await FabricInward.findAll({ where, include: fullInclude, order: [['inwardDate', 'DESC'], ['inwardNo', 'DESC']] });
  const rows = all.map((e) => {
    const j = json(e);
    const free = e.thaans.filter((t) => t.status === 'IN_STOCK' && r2(t.meters - t.takenMeters) > 0);
    const withFree = q.withThaans ? { thaans: j.thaans.filter((t) => free.some((f) => f.thaanNo === t.thaanNo)) } : {};
    const balanceValue = e.amount != null && e.inwardMeters > 0 ? r2((e.amount * j.balanceMeters) / e.inwardMeters) : null;
    return { ...j, balanceValue, freePieces: e.thaans.length ? free.length : Math.max(e.pieces, 0), freeThaanNos: free.map((t) => t.thaanNo).sort((a, b) => a - b), ...withFree };
  }).filter((r) => q.showZero || r.balanceMeters > 0);
  const sum = (list, f) => r2(list.reduce((t, x) => t + f(x), 0));
  const group = new Map();
  for (const r of rows) {
    const g = group.get(r.quality.id) || { quality: r.quality, entries: 0, inwardMeters: 0, outwardMeters: 0, balanceMeters: 0, balanceYards: 0 };
    g.entries += 1;
    g.inwardMeters = r2(g.inwardMeters + r.inwardMeters);
    g.outwardMeters = r2(g.outwardMeters + r.outwardMeters);
    g.balanceMeters = r2(g.balanceMeters + r.balanceMeters);
    g.balanceYards = toYards(g.balanceMeters);
    group.set(r.quality.id, g);
  }
  const start = (q.page - 1) * q.limit;
  return {
    totals: { entries: rows.length, inwardMeters: sum(rows, (r) => r.inwardMeters), outwardMeters: sum(rows, (r) => r.outwardMeters), balanceMeters: sum(rows, (r) => r.balanceMeters), balanceYards: toYards(sum(rows, (r) => r.balanceMeters)), balanceValue: sum(rows, (r) => r.balanceValue || 0) },
    byQuality: [...group.values()].sort((a, b) => a.quality.name.localeCompare(b.quality.name)),
    data: rows.slice(start, start + q.limit).map((r) => (q.withThaans ? r : without(r, ['thaans']))),
    page: q.page, limit: q.limit, total: rows.length,
  };
}

module.exports = { list, get, create, update, remove, setActive, setApproved, formData, nextNumbers, setNextNumbers, stock, YARD };
