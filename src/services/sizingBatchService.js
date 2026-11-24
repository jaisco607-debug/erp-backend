// Sizing Management > Sizing Batch (service SIZING). One batch = one set that a sizing party (our weaving vendor) sizes for us.
//   Yarn + empty beams go out on a SIZING yarn outward challan (Weaving). The yarn that went is TAGGED to the batch (weaving yarn inward entries, lbs of each).
//   The sized beams and the cut cones come back in RECEIPTS ("sized beam / cut cones inward", GRN#): every beam has its length (m); every cut cone row has a type, kgs, cones and bags.
//   A received beam goes AT_SIZING -> FULL (dated like the receipt, carrying its meters); deleting the receipt puts it back at sizing.
// Billing (Sizing party charges only for the yarn that went into the beams):
//   warp wt = yarn tagged - cut cones (lbs)      net warp wt = warp wt + adjustment (at most 10 lbs either way)      amount = net warp wt x rate per lb
// Actual count (English cotton count): ends x total beam length in yards / (840 x warp weight in lbs).  Checked on the screens of the old software (60/s: 6054 ends, 31,290 m, 3,774.9 lbs = 65.3/s).
// Confirm = approval: after it the batch is locked and its amount can go on a SIZING_BATCH purchase invoice in the accounts. Reopen puts it back to draft (not while invoiced).
// The sums are kept on the batch row and recalculated after every change (recalc), so lists and invoices read them directly.
const crypto = require('crypto');
const { sequelize, Vendor, YarnCount, WeavingQuality } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const counters = require('./counterService');

const KG_TO_LB = 2.20462262;
const M_TO_YD = 1.0936133;
const ADJ_LIMIT = 10;
const COUNT_WARNING_PERCENT = 10;
const CONE_TYPES = ['CutCone'];
const n2 = (v) => require('../utils/money').round(v);
const num = (v) => (v == null ? null : Number(v));
const label = (n) => String(n).padStart(5, '0');
const STATUS_TEXT = { DRAFT: 'Draft', CONFIRMED: 'Confirmed' };
const BEAM_TEXT = { EMPTY: 'Empty', FULL: 'Full', AT_LOOM: 'At loom', AT_SIZING: 'At sizing' };
const QT = sequelize.QueryTypes.SELECT;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QT, transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });

/** The number in a count name: "60/s CTN" -> 60, "22|s Cotton" -> 22 (null when there is none). */
const nominalOf = (name) => { const m = /(\d+(?:\.\d+)?)/.exec(name || ''); return m ? Number(m[1]) : null; };

// ---- the batch ----
const HEAD_SQL = `SELECT b.*, to_char(b."batchDate", 'YYYY-MM-DD') AS "batchDay", v.code AS "vendorCode", v.name AS "vendorName", yc.name AS "yarnCountName",
    p.id AS "invoiceId", p."voucherNo" AS "invoiceVoucherNo", p.status AS "invoiceStatus",
    wq.code AS "qualityCode", wq.name AS "qualityName",
    yct.code AS "contractCode", yct.status AS "contractStatus", cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
    -- the yarn really sent to the sizing party for the tagged yarn: per tagged entry the lbs of its SIZING challans to this party (yarn that came straight to the party counts as sent)
    (SELECT COALESCE(SUM(LEAST(y.lbs, CASE WHEN yi."directVendorId" = b."vendorId" THEN y.lbs ELSE COALESCE((SELECT SUM(l.lbs) FROM yarn_outward_lines l JOIN yarn_outwards o ON o.id = l."outwardId" AND o.type = 'SIZING' AND o."vendorId" = b."vendorId" AND o."deletedAt" IS NULL WHERE l."inwardId" = y."inwardId"), 0) END)), 0)
       FROM sizing_batch_yarns y JOIN yarn_inwards yi ON yi.id = y."inwardId" WHERE y."batchId" = b.id) AS "yarnIssuedLbs"
  FROM sizing_batches b JOIN vendors v ON v.id = b."vendorId" JOIN yarn_counts yc ON yc.id = b."yarnCountId"
  LEFT JOIN yarn_contracts yct ON yct.id = b."contractId" LEFT JOIN customers cu ON cu.id = yct."customerId" LEFT JOIN weaving_qualities wq ON wq.id = b."qualityId"
  LEFT JOIN purchase_invoice_sizing_batches pl ON pl."batchId" = b.id LEFT JOIN purchase_invoices p ON p.id = pl."invoiceId"`;

function headJson(b) {
  const nominal = nominalOf(b.yarnCountName);
  const actual = num(b.actualCount);
  const variance = nominal && actual ? Math.round(((actual - nominal) / nominal) * 1000) / 10 : null;
  const invoice = b.invoiceId ? { id: b.invoiceId, voucherNo: b.invoiceVoucherNo, voucherLabel: label(b.invoiceVoucherNo), status: b.invoiceStatus } : null;
  const draft = b.status === 'DRAFT';
  return {
    id: b.id, batchNo: b.batchNo, batchLabel: label(b.batchNo), batchDate: b.batchDay, setNo: b.setNo, ends: b.ends, notes: b.notes,
    // the quality from the Quality master (a batch made before the master has its old typed text in `quality` and no qualityId)
    qualityId: b.qualityId || null, qualityMaster: b.qualityId ? { id: b.qualityId, code: b.qualityCode, name: b.qualityName } : null, quality: b.qualityId ? b.qualityName : b.quality,
    party: { id: b.vendorId, code: b.vendorCode, name: b.vendorName }, vendorId: b.vendorId,
    yarnCountId: b.yarnCountId, yarnCount: { id: b.yarnCountId, name: b.yarnCountName },
    // the overhead contract the batch is tagged to (optional) and the customer of it ("on account")
    contractId: b.contractId || null,
    contract: b.contractId ? { id: b.contractId, code: b.contractCode, codeLabel: String(b.contractCode).padStart(4, '0'), status: b.contractStatus, customer: { id: b.customerId, code: b.customerCode, name: b.customerName } } : null,
    onAccount: b.customerId ? { id: b.customerId, code: b.customerCode, name: b.customerName } : null,
    status: b.status, statusText: STATUS_TEXT[b.status], confirmedAt: b.confirmedAt,
    // the pills on the screen
    yarnTaggedLbs: n2(b.yarnLbs), yarnLots: b.yarnLots, warpLengthM: n2(b.lengthM), beamCount: b.beamCount, coneKg: n2(b.coneKg), coneLbs: n2(b.coneLbs), warpWeightLbs: n2(b.warpWt),
    actualCount: actual, nominalCount: nominal, countVariancePercent: variance, countWarning: variance !== null && Math.abs(variance) > COUNT_WARNING_PERCENT,
    // billing: yarn issued (tagged) - cut cones = warp wt; + adjustment = net warp wt; x rate = amount
    billing: { yarnIssuedLbs: n2(b.yarnLbs), coneKg: n2(b.coneKg), coneLbs: n2(b.coneLbs), warpWt: n2(b.warpWt), adjustmentLbs: n2(b.adjustmentLbs), adjustmentLimitLbs: ADJ_LIMIT, netWarpWt: n2(b.netWarpWt), ratePerLb: num(b.ratePerLb), amount: n2(b.amount) },
    ratePerLb: num(b.ratePerLb), adjustmentLbs: n2(b.adjustmentLbs), amount: n2(b.amount),
    purchaseInvoice: invoice, invoiced: Boolean(invoice), billedAmount: invoice ? n2(b.amount) : 0,
    noYarnTagged: b.yarnLots === 0,
    // the list columns: yarn issued (sent to the party) next to yarn tagged (amber when they differ), sizing length (the party's figure, else what came in), to receive (closed sets only)
    yarnIssuedLbs: n2(b.yarnIssuedLbs), yarnMismatch: b.yarnLots > 0 && Math.abs(n2(b.yarnIssuedLbs) - n2(b.yarnLbs)) > 0.005,
    sizingLengthM: n2(b.sizingLengthM == null ? b.lengthM : b.sizingLengthM), sizingLengthEntered: b.sizingLengthM != null, receivedLengthM: n2(b.lengthM), beamsIn: b.beamCount,
    toReceiveM: b.status === 'CONFIRMED' ? n2((b.sizingLengthM == null ? Number(b.lengthM) : Number(b.sizingLengthM)) - Number(b.lengthM)) : 0,
    batchCode: String(b.batchNo).padStart(4, '0'), canBeamIn: draft,
    canEdit: draft, canConfirm: draft, canReopen: !draft && !invoice, canDelete: draft && b.beamCount === 0,
    canInvoice: !draft && !invoice && n2(b.amount) > 0,
    createdAt: b.createdAt,
  };
}

/** What a draft still needs before it can be confirmed. */
const readiness = (b) => ({ notes: Boolean(b.notes && b.notes.trim()), yarn: b.yarnLots > 0, beams: b.beamCount > 0, rate: b.ratePerLb !== null && b.ratePerLb !== undefined, weight: Number(b.netWarpWt) > 0 });

async function headOr404(companyId, id, transaction) {
  const [b] = await q(`${HEAD_SQL} WHERE b.id = :id AND b."companyId" = :companyId AND b."deletedAt" IS NULL`, { id, companyId }, transaction);
  if (!b) throw AppError.notFound('Sizing batch');
  return b;
}

/** Recalculates and saves the sums of a batch (yarn tagged, cut cones, beams, warp weight, net weight, amount, actual count). */
async function recalc(batchId, transaction) {
  const [b] = await q('SELECT ends, "adjustmentLbs", "ratePerLb" FROM sizing_batches WHERE id = :batchId', { batchId }, transaction);
  const [y] = await q('SELECT COALESCE(SUM(lbs), 0) AS lbs, COUNT(*)::int AS n FROM sizing_batch_yarns WHERE "batchId" = :batchId', { batchId }, transaction);
  const [c] = await q('SELECT COALESCE(SUM(c.kg), 0) AS kg, COALESCE(SUM(c.lbs), 0) AS lbs FROM sizing_receipt_cones c JOIN sizing_receipts r ON r.id = c."receiptId" WHERE r."batchId" = :batchId', { batchId }, transaction);
  const [m] = await q('SELECT COALESCE(SUM(rb."lengthM"), 0) AS len, COUNT(*)::int AS n FROM sizing_receipt_beams rb JOIN sizing_receipts r ON r.id = rb."receiptId" WHERE r."batchId" = :batchId', { batchId }, transaction);
  const warpWt = n2(Number(y.lbs) - Number(c.lbs));
  const net = n2(warpWt + Number(b.adjustmentLbs));
  const amount = b.ratePerLb === null ? 0 : n2(net * Number(b.ratePerLb));
  const len = Number(m.len);
  const actual = b.ends > 0 && warpWt > 0 && len > 0 ? Math.round(((b.ends * len * M_TO_YD) / (840 * warpWt)) * 10) / 10 : null;
  await exec(`UPDATE sizing_batches SET "yarnLbs" = :yarnLbs, "yarnLots" = :yarnLots, "coneKg" = :coneKg, "coneLbs" = :coneLbs, "lengthM" = :len, "beamCount" = :beams, "warpWt" = :warpWt,
    "netWarpWt" = :net, amount = :amount, "actualCount" = :actual, "updatedAt" = now() WHERE id = :batchId`,
  { yarnLbs: n2(y.lbs), yarnLots: y.n, coneKg: n2(c.kg), coneLbs: n2(c.lbs), len: n2(len), beams: m.n, warpWt, net, amount, actual, batchId }, transaction);
}

const sizeOf = (r) => ({ id: r.id, name: r.name });

async function yarnsOf(batchId, transaction) {
  const rows = await q(`SELECT y.id, y.lbs, i.id AS "inwardId", i.code, to_char(i."inwardDate", 'YYYY-MM-DD') AS "inwardDate", i."dcNo", i.bags, i."lbsPerBag", it."yarnCountId", yc.name AS "yarnCountName", br.name AS "brandName", it.packing, it.bags AS "itemBags", b."yarnCountId" AS "batchCountId"
    FROM sizing_batch_yarns y JOIN sizing_batches b ON b.id = y."batchId" JOIN yarn_inwards i ON i.id = y."inwardId" JOIN yarn_items it ON it.id = i."itemId" JOIN yarn_counts yc ON yc.id = it."yarnCountId" JOIN yarn_brands br ON br.id = it."brandId"
    WHERE y."batchId" = :batchId ORDER BY i."inwardDate", i.code`, { batchId }, transaction);
  return rows.map((r) => ({
    id: r.id, inwardId: r.inwardId, inwardCode: r.code, dcNo: r.dcNo, inwardDate: r.inwardDate, lbs: n2(r.lbs),
    yarnCount: sizeOf({ id: r.yarnCountId, name: r.yarnCountName }), name: `${r.yarnCountName} - ${r.brandName} - ${r.packing} - ${r.itemBags}`,
    countMismatch: r.yarnCountId !== r.batchCountId,
  }));
}

async function receiptsOf(where, replacements, transaction) {
  const rs = await q(`SELECT r.id, r."batchId", r."receiptNo", to_char(r."receiptDate", 'YYYY-MM-DD') AS "receiptDate", r."refNo", r.notes, r."createdAt"
    FROM sizing_receipts r WHERE ${where} ORDER BY r."receiptDate", r."receiptNo"`, replacements, transaction);
  if (!rs.length) return [];
  const ids = rs.map((r) => r.id);
  const beams = await q(`SELECT rb."receiptId", rb."beamId", rb."lengthM", rb."weightKg", b."beamNo", b.name, b.status FROM sizing_receipt_beams rb JOIN yarn_beams b ON b.id = rb."beamId" WHERE rb."receiptId" IN (:ids) ORDER BY b."beamNo"`, { ids }, transaction);
  const cones = await q('SELECT id, "receiptId", type, kg, lbs, cones, bags FROM sizing_receipt_cones WHERE "receiptId" IN (:ids) ORDER BY id', { ids }, transaction);
  return rs.map((r) => {
    const bs = beams.filter((b) => b.receiptId === r.id).map((b) => ({ id: b.beamId, beamNo: b.beamNo, beamLabel: label(b.beamNo), name: b.name, lengthM: n2(b.lengthM), weightKg: num(b.weightKg), status: b.status, statusText: BEAM_TEXT[b.status] }));
    const cs = cones.filter((c) => c.receiptId === r.id).map((c) => ({ id: c.id, type: c.type, kg: n2(c.kg), lbs: n2(c.lbs), cones: c.cones, bags: c.bags }));
    return { id: r.id, batchId: r.batchId, receiptNo: r.receiptNo, receiptLabel: label(r.receiptNo), inPassNo: r.receiptNo, inPassLabel: label(r.receiptNo), receiptDate: r.receiptDate, refNo: r.refNo, notes: r.notes, beams: bs, cutCones: cs,
      totalBeams: bs.length, lengthM: n2(bs.reduce((t, b) => t + b.lengthM, 0)), coneKg: n2(cs.reduce((t, c) => t + c.kg, 0)), coneLbs: n2(cs.reduce((t, c) => t + c.lbs, 0)), coneCones: cs.reduce((t, c) => t + c.cones, 0), coneBags: cs.reduce((t, c) => t + c.bags, 0), createdAt: r.createdAt };
  });
}

/** The whole batch: header, yarn tagged, receipts with their beams / cut cones, the beams received (flat) and the cut cones (flat). */
async function full(companyId, id, transaction) {
  const head = headJson(await headOr404(companyId, id, transaction));
  const yarns = await yarnsOf(id, transaction);
  const receipts = await receiptsOf('r."batchId" = :id', { id }, transaction);
  const beams = receipts.flatMap((r) => r.beams.map((b) => ({ ...b, receiptId: r.id, grnNo: r.receiptNo, grnLabel: r.receiptLabel, inPassNo: r.receiptNo, inPassLabel: r.receiptLabel, receiptDate: r.receiptDate })));
  const cutCones = receipts.flatMap((r) => r.cutCones.map((c) => ({ ...c, receiptId: r.id, grnNo: r.receiptNo, grnLabel: r.receiptLabel, inPassNo: r.receiptNo, inPassLabel: r.receiptLabel, receiptDate: r.receiptDate })));
  const b = (await q('SELECT notes, "yarnLots", "beamCount", "ratePerLb", "netWarpWt" FROM sizing_batches WHERE id = :id', { id }, transaction))[0];
  const ready = readiness(b);
  return { ...head, yarns, receipts, beams, cutCones, readiness: ready, canConfirm: head.status === 'DRAFT' && Object.values(ready).every(Boolean) };
}
const get = (req, id) => full(req.user.companyId, id);

// ---- list ----
async function list(req, { page, limit, search, status, vendorId, contractId, customerId, dateFrom, dateTo, withoutYarn }) {
  const r = { companyId: req.user.companyId };
  const f = [];
  if (vendorId) { f.push('b."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (dateFrom) { f.push('b."batchDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { f.push('b."batchDate" <= :dateTo'); r.dateTo = dateTo; }
  if (contractId) { f.push('b."contractId" = :contractId'); r.contractId = contractId; }
  if (customerId) { f.push('yct."customerId" = :customerId'); r.customerId = customerId; }
  if (withoutYarn) f.push('b."yarnLots" = 0');
  if (search) {
    r.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`; r.exact = String(Number(search) || '');
    f.push('(b."setNo" ILIKE :like OR v.name ILIKE :like OR cu.name ILIKE :like OR b.notes ILIKE :like OR b.quality ILIKE :like OR wq.name ILIKE :like OR yc.name ILIKE :like OR b."batchNo"::text = :exact OR yct.code::text = :exact)');
  }
  const where = `b."companyId" = :companyId AND b."deletedAt" IS NULL${f.length ? ` AND ${f.join(' AND ')}` : ''}`;
  const st = { ...r, status: status || null };
  const rows = await q(`${HEAD_SQL} WHERE ${where} AND (:status::text IS NULL OR b.status = :status) ORDER BY b."batchDate" DESC, b."batchNo" DESC LIMIT :limit OFFSET :offset`, { ...st, limit, offset: (page - 1) * limit });
  const [t] = await q(`SELECT COUNT(*)::int AS "all", COUNT(*) FILTER (WHERE b.status = 'DRAFT')::int AS drafts, COUNT(*) FILTER (WHERE b.status = 'CONFIRMED')::int AS confirmed, COUNT(*) FILTER (WHERE b."yarnLots" = 0)::int AS "withoutYarn",
    COUNT(*) FILTER (WHERE :status::text IS NULL OR b.status = :status)::int AS total,
    COALESCE(SUM(b."yarnLbs") FILTER (WHERE :status::text IS NULL OR b.status = :status), 0) AS yarn, COALESCE(SUM(b."warpWt") FILTER (WHERE :status::text IS NULL OR b.status = :status), 0) AS warp,
    COALESCE(SUM(b."coneLbs") FILTER (WHERE :status::text IS NULL OR b.status = :status), 0) AS cones, COALESCE(SUM(b."lengthM") FILTER (WHERE :status::text IS NULL OR b.status = :status), 0) AS len,
    COALESCE(SUM(b."beamCount") FILTER (WHERE :status::text IS NULL OR b.status = :status), 0)::int AS beams, COALESCE(SUM(b.amount) FILTER (WHERE :status::text IS NULL OR b.status = :status), 0) AS amount
    FROM sizing_batches b JOIN vendors v ON v.id = b."vendorId" JOIN yarn_counts yc ON yc.id = b."yarnCountId" LEFT JOIN yarn_contracts yct ON yct.id = b."contractId" LEFT JOIN customers cu ON cu.id = yct."customerId" LEFT JOIN weaving_qualities wq ON wq.id = b."qualityId" WHERE ${where}`, st);
  // the pills and the footer over every set of the filter: sizing length, received, to receive (closed sets), billed, yarn issued
  const every = (await q(`${HEAD_SQL} WHERE ${where} AND (:status::text IS NULL OR b.status = :status)`, st)).map(headJson);
  const sum = (k) => n2(every.reduce((s, b) => s + (Number(b[k]) || 0), 0));
  const extra = { sizingLengthM: sum('sizingLengthM'), receivedLengthM: sum('receivedLengthM'), toReceiveM: sum('toReceiveM'), billedAmount: sum('billedAmount'), yarnIssuedLbs: sum('yarnIssuedLbs'), coneKg: sum('coneKg'), withoutYarnShown: every.filter((b) => b.noYarnTagged).length };
  return { data: rows.map(headJson), page, limit, total: t.total, counts: { all: t.all, drafts: t.drafts, confirmed: t.confirmed, withoutYarn: t.withoutYarn },
    totals: { sets: t.total, ...extra, yarnTaggedLbs: n2(t.yarn), warpWeightLbs: n2(t.warp), coneLbs: n2(t.cones), lengthM: n2(t.len), beams: t.beams, amount: n2(t.amount) } };
}

/** Dropdown help for the form (the Sizing user may have no access to the weaving masters, so the lists come here). */
async function formData(req) {
  const { companyId } = req.user;
  const vendors = await Vendor.findAll({ where: { companyId, module: 'WEAVING', isActive: true }, order: [['name', 'ASC']], attributes: ['id', 'code', 'name'] });
  const counts = await YarnCount.findAll({ where: { companyId, isActive: true }, order: [['code', 'ASC']], attributes: ['id', 'code', 'name'] });
  const qualities = await WeavingQuality.findAll({ where: { companyId, isActive: true }, order: [['name', 'ASC']], attributes: ['id', 'code', 'name'] });
  return { date: today(), adjustmentLimitLbs: ADJ_LIMIT, coneTypes: CONE_TYPES, defaultConeType: CONE_TYPES[0], kgToLbs: KG_TO_LB,
    vendors: vendors.map((v) => ({ id: v.id, code: v.code, name: v.name })), qualities: qualities.map((w) => ({ id: w.id, code: w.code, name: w.name })), yarnCounts: counts.map((c) => ({ id: c.id, code: c.code, name: c.name })) };
}

// ---- checks ----
async function checkVendor(companyId, vendorId, keep, transaction) {
  const v = await Vendor.findOne({ where: { id: vendorId, companyId, module: 'WEAVING' }, transaction });
  if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'This sizing party does not exist', { field: 'vendorId' });
  if (!v.isActive && vendorId !== keep) throw AppError.rule('VENDOR_INACTIVE', 'This sizing party is switched off', { field: 'vendorId' });
}
async function checkCount(companyId, yarnCountId, keep, transaction) {
  const c = await YarnCount.findOne({ where: { id: yarnCountId, companyId }, transaction });
  if (!c) throw AppError.rule('UNKNOWN_YARN_COUNT', 'This yarn count does not exist', { field: 'yarnCountId' });
  if (!c.isActive && yarnCountId !== keep) throw AppError.rule('YARN_COUNT_INACTIVE', 'This yarn count is switched off', { field: 'yarnCountId' });
}
/** The contract of a batch: an OVERHEAD contract of this company; a closed one cannot be newly chosen (an unchanged one may stay). */
async function checkContract(companyId, contractId, keep, transaction) {
  const [c] = await q('SELECT id, status FROM yarn_contracts WHERE id = :contractId AND "companyId" = :companyId AND kind = \'OVERHEAD\' AND "deletedAt" IS NULL', { contractId, companyId }, transaction);
  if (!c) throw AppError.rule('UNKNOWN_CONTRACT', 'This overhead contract does not exist', { field: 'contractId' });
  if (c.status === 'CLOSED' && contractId !== keep) throw AppError.rule('CONTRACT_CLOSED', 'This contract is closed', { field: 'contractId' });
}
/** The quality of a batch: from the Quality master of this company, switched on (an unchanged one may stay). */
async function checkQuality(companyId, qualityId, keep, transaction) {
  const [w] = await q('SELECT "isActive" FROM weaving_qualities WHERE id = :qualityId AND "companyId" = :companyId AND "deletedAt" IS NULL', { qualityId, companyId }, transaction);
  if (!w) throw AppError.rule('UNKNOWN_QUALITY', 'This quality does not exist', { field: 'qualityId' });
  if (!w.isActive && qualityId !== keep) throw AppError.rule('QUALITY_INACTIVE', 'This quality is switched off', { field: 'qualityId' });
}
const lockBatch = async (companyId, id, transaction) => {
  const [b] = await q('SELECT * FROM sizing_batches WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL FOR UPDATE', { id, companyId }, transaction);
  if (!b) throw AppError.notFound('Sizing batch');
  return b;
};
const needDraft = (b) => {
  if (b.status !== 'DRAFT') throw AppError.rule('BATCH_CONFIRMED', 'This batch is confirmed: reopen it to change it');
};

// ---- yarn tagged ----
/** The yarn that went to this party on SIZING challans, per weaving yarn inward entry: sent, tagged to other batches of the party, available. `excludeBatchId` leaves the batch being edited out of "tagged". */
async function yarnPool(companyId, vendorId, { inwardIds, excludeBatchId = null, excludeReturnId = null, contractId = null } = {}, transaction) {
  const rows = await q(`SELECT i.id AS "inwardId", i.code, to_char(i."inwardDate", 'YYYY-MM-DD') AS "inwardDate", i."dcNo", it."yarnCountId", yc.name AS "yarnCountName", br.name AS "brandName", it.packing, it.bags AS "itemBags",
      sent.lbs AS sent, COALESCE(t.lbs, 0) AS tagged, COALESCE(rt.lbs, 0) AS returned, i."lbsPerBag" AS "lbsPerBag",
      EXISTS (SELECT 1 FROM yarn_outward_lines l2 JOIN yarn_sizing_inwards si ON si."outwardId" = l2."outwardId" AND si."deletedAt" IS NULL AND si."lbsUsed" > 0 WHERE l2."inwardId" = i.id) AS "oldUsed"
    FROM yarn_inwards i JOIN yarn_items it ON it.id = i."itemId" JOIN yarn_counts yc ON yc.id = it."yarnCountId" JOIN yarn_brands br ON br.id = it."brandId"
    JOIN (SELECT l."inwardId", SUM(l.lbs) AS lbs FROM yarn_outward_lines l JOIN yarn_outwards o ON o.id = l."outwardId" AND o.type = 'SIZING' AND o."deletedAt" IS NULL AND o."vendorId" = :vendorId GROUP BY 1) sent ON sent."inwardId" = i.id
    LEFT JOIN (SELECT y."inwardId", SUM(y.lbs) AS lbs FROM sizing_batch_yarns y JOIN sizing_batches b ON b.id = y."batchId" AND b."deletedAt" IS NULL AND b."vendorId" = :vendorId
      WHERE (:ex::uuid IS NULL OR y."batchId" <> :ex::uuid) GROUP BY 1) t ON t."inwardId" = i.id
    LEFT JOIN (SELECT ry."inwardId", SUM(ry.lbs) AS lbs FROM sizing_return_yarns ry JOIN sizing_returns sr ON sr.id = ry."returnId" AND sr."vendorId" = :vendorId WHERE (:exr::uuid IS NULL OR ry."returnId" <> :exr::uuid) GROUP BY 1) rt ON rt."inwardId" = i.id
    WHERE i."companyId" = :companyId AND i."deletedAt" IS NULL${inwardIds ? ' AND i.id IN (:inwardIds)' : ''}${contractId ? ' AND i."contractLineId" IN (SELECT id FROM yarn_contract_lines WHERE "contractId" = :contractId)' : ''} ORDER BY i."inwardDate" DESC, i.code DESC`,
  { companyId, vendorId, ex: excludeBatchId, exr: excludeReturnId, inwardIds, contractId }, transaction);
  return rows.map((r) => ({
    inwardId: r.inwardId, inwardCode: r.code, inwardDate: r.inwardDate, dcNo: r.dcNo, yarnCountId: r.yarnCountId, yarnCount: sizeOf({ id: r.yarnCountId, name: r.yarnCountName }),
    name: `${r.yarnCountName} - ${r.brandName} - ${r.packing} - ${r.itemBags}`, sentLbs: n2(r.sent), taggedLbs: n2(r.tagged), returnedLbs: n2(r.returned), lbsPerBag: Number(r.lbsPerBag), availableLbs: r.oldUsed ? 0 : n2(Number(r.sent) - Number(r.tagged) - Number(r.returned)), usedInOldSizingInward: Boolean(r.oldUsed),
  }));
}

/** GET /yarn-available?vendorId=&batchId= : the yarn sent to this sizing party that is not tagged to another batch yet (the DC / LOT picker). */
async function yarnAvailable(req, { vendorId, batchId, contractId, search }) {
  const companyId = req.user.companyId;
  await checkVendorExists(companyId, vendorId);
  let data = await yarnPool(companyId, vendorId, { excludeBatchId: batchId || null, contractId: contractId || null });
  if (batchId) {
    const here = new Map((await q('SELECT "inwardId", lbs FROM sizing_batch_yarns WHERE "batchId" = :batchId', { batchId })).map((r) => [r.inwardId, n2(r.lbs)]));
    data = data.map((d) => ({ ...d, taggedHereLbs: here.get(d.inwardId) || 0 }));
  }
  data = data.filter((d) => d.availableLbs > 0 || d.taggedHereLbs > 0);
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((d) => String(d.inwardCode) === s || (d.dcNo || '').toLowerCase().includes(s) || d.name.toLowerCase().includes(s));
  }
  return { data, total: data.length };
}
async function checkVendorExists(companyId, vendorId) {
  const v = await Vendor.findOne({ where: { id: vendorId, companyId, module: 'WEAVING' } });
  if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'This sizing party does not exist', { field: 'vendorId' });
}

async function tagYarn(companyId, batch, { inwardId, lbs }, transaction, existingId) {
  // one at a time per company: two people tagging the same yarn wait for each other (the pool is read after the lock)
  if (transaction) await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`sizing-yarn-pool:${companyId}`], transaction });
  const [p] = await yarnPool(companyId, batch.vendorId, { inwardIds: [inwardId], excludeBatchId: batch.id }, transaction);
  if (!p) throw AppError.rule('YARN_NOT_SENT', 'This yarn was not sent to this sizing party on a sizing challan', { field: 'inwardId', inwardId });
  if (Number(lbs) > p.availableLbs + 0.0001) throw AppError.rule('MORE_THAN_AVAILABLE', `${p.sentLbs} lbs of this yarn went to the party and ${p.taggedLbs} lbs are tagged to other batches: only ${p.availableLbs} lbs can be tagged`, { field: 'lbs', sentLbs: p.sentLbs, taggedLbs: p.taggedLbs, availableLbs: p.availableLbs });
  if (existingId) await exec('UPDATE sizing_batch_yarns SET lbs = :lbs WHERE id = :existingId', { lbs: n2(lbs), existingId }, transaction);
  else await exec('INSERT INTO sizing_batch_yarns (id, "companyId", "batchId", "inwardId", lbs) VALUES (:id, :companyId, :batchId, :inwardId, :lbs)', { id: crypto.randomUUID(), companyId, batchId: batch.id, inwardId, lbs: n2(lbs) }, transaction);
}

async function addYarn(req, id, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const b = await lockBatch(companyId, id, transaction);
    needDraft(b);
    const [dup] = await q('SELECT id FROM sizing_batch_yarns WHERE "batchId" = :id AND "inwardId" = :inwardId', { id, inwardId: data.inwardId }, transaction);
    if (dup) throw AppError.rule('ALREADY_TAGGED', 'This yarn is already tagged to the batch: change its lbs instead', { field: 'inwardId' });
    await tagYarn(companyId, b, data, transaction);
    await recalc(id, transaction);
    await audit.log(req, { action: 'SIZING_BATCH_YARN_TAGGED', entityType: 'SizingBatch', entityId: id, after: data }, { transaction });
    return full(companyId, id, transaction);
  });
}
async function updateYarn(req, id, tagId, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const b = await lockBatch(companyId, id, transaction);
    needDraft(b);
    const [t] = await q('SELECT * FROM sizing_batch_yarns WHERE id = :tagId AND "batchId" = :id', { tagId, id }, transaction);
    if (!t) throw AppError.notFound('Tagged yarn');
    await tagYarn(companyId, b, { inwardId: t.inwardId, lbs: data.lbs }, transaction, tagId);
    await recalc(id, transaction);
    await audit.log(req, { action: 'SIZING_BATCH_YARN_CHANGED', entityType: 'SizingBatch', entityId: id, before: { lbs: n2(t.lbs) }, after: { inwardId: t.inwardId, lbs: data.lbs } }, { transaction });
    return full(companyId, id, transaction);
  });
}
async function removeYarn(req, id, tagId) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const b = await lockBatch(companyId, id, transaction);
    needDraft(b);
    const [t] = await q('SELECT * FROM sizing_batch_yarns WHERE id = :tagId AND "batchId" = :id', { tagId, id }, transaction);
    if (!t) throw AppError.notFound('Tagged yarn');
    await exec('DELETE FROM sizing_batch_yarns WHERE id = :tagId', { tagId }, transaction);
    await recalc(id, transaction);
    await audit.log(req, { action: 'SIZING_BATCH_YARN_UNTAGGED', entityType: 'SizingBatch', entityId: id, before: { inwardId: t.inwardId, lbs: n2(t.lbs) } }, { transaction });
    return full(companyId, id, transaction);
  });
}

// ---- create / change / confirm / delete ----
async function create(req, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `sizing-batch:${companyId}` }, transaction);
    await checkVendor(companyId, data.vendorId, null, transaction);
    await checkCount(companyId, data.yarnCountId, null, transaction);
    if (data.contractId) await checkContract(companyId, data.contractId, null, transaction);
    if (data.qualityId) await checkQuality(companyId, data.qualityId, null, transaction);
    const [{ next }] = await q('SELECT COALESCE(MAX("batchNo"), 0) + 1 AS next FROM sizing_batches WHERE "companyId" = :companyId', { companyId }, transaction);
    const id = crypto.randomUUID();
    await exec(`INSERT INTO sizing_batches (id, "companyId", "batchNo", "batchDate", "vendorId", "setNo", ends, "yarnCountId", "contractId", "qualityId", notes, "adjustmentLbs", "ratePerLb", "sizingLengthM", "createdById")
      VALUES (:id, :companyId, :batchNo, :batchDate, :vendorId, :setNo, :ends, :yarnCountId, :contractId, :qualityId, :notes, :adjustmentLbs, :ratePerLb, :sizingLengthM, :createdById)`,
    { id, companyId, batchNo: Number(next), batchDate: data.batchDate || today(), vendorId: data.vendorId, setNo: data.setNo, ends: data.ends, yarnCountId: data.yarnCountId, contractId: data.contractId || null, qualityId: data.qualityId || null,
      notes: data.notes || null, adjustmentLbs: data.adjustmentLbs || 0, ratePerLb: data.ratePerLb === undefined ? null : data.ratePerLb, sizingLengthM: data.sizingLengthM == null ? null : data.sizingLengthM, createdById: req.user.id }, transaction);
    const [batch] = await q('SELECT * FROM sizing_batches WHERE id = :id', { id }, transaction);
    for (const y of data.yarns || []) {
      if ((data.yarns || []).filter((x) => x.inwardId === y.inwardId).length > 1) throw AppError.rule('ALREADY_TAGGED', 'The same yarn is listed twice', { field: 'yarns' });
      await tagYarn(companyId, batch, y, transaction);
    }
    await recalc(id, transaction);
    const out = await full(companyId, id, transaction);
    await audit.log(req, { action: 'SIZING_BATCH_CREATED', entityType: 'SizingBatch', entityId: id, after: { batchNo: out.batchNo, setNo: out.setNo, vendorId: out.vendorId, ends: out.ends } }, { transaction });
    return out;
  });
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const b = await lockBatch(companyId, id, transaction);
    needDraft(b);
    const before = headJson(await headOr404(companyId, id, transaction));
    const set = {};
    if (changes.vendorId && changes.vendorId !== b.vendorId) {
      const [{ n }] = await q('SELECT ((SELECT COUNT(*) FROM sizing_batch_yarns WHERE "batchId" = :id) + (SELECT COUNT(*) FROM sizing_receipts WHERE "batchId" = :id))::int AS n', { id }, transaction);
      if (n) throw AppError.rule('USED_IN_BATCH', 'Yarn is tagged or beams came in on this batch: the sizing party cannot be changed', { field: 'vendorId' });
      await checkVendor(companyId, changes.vendorId, b.vendorId, transaction);
      set.vendorId = changes.vendorId;
    }
    if (changes.yarnCountId && changes.yarnCountId !== b.yarnCountId) { await checkCount(companyId, changes.yarnCountId, b.yarnCountId, transaction); set.yarnCountId = changes.yarnCountId; }
    if (changes.contractId !== undefined) { if (changes.contractId) await checkContract(companyId, changes.contractId, b.contractId, transaction); set.contractId = changes.contractId; }
    if (changes.qualityId !== undefined) { if (changes.qualityId) await checkQuality(companyId, changes.qualityId, b.qualityId, transaction); set.qualityId = changes.qualityId; }
    for (const f of ['batchDate', 'setNo', 'ends', 'notes', 'adjustmentLbs', 'ratePerLb', 'sizingLengthM']) if (changes[f] !== undefined) set[f] = changes[f] === '' ? null : changes[f];
    const keys = Object.keys(set);
    if (keys.length) await exec(`UPDATE sizing_batches SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :id`, { ...set, id }, transaction);
    await recalc(id, transaction);
    const out = await full(companyId, id, transaction);
    await audit.log(req, { action: 'SIZING_BATCH_UPDATED', entityType: 'SizingBatch', entityId: id, before, after: { setNo: out.setNo, ends: out.ends, ratePerLb: out.ratePerLb, adjustmentLbs: out.adjustmentLbs, netWarpWt: out.billing.netWarpWt } }, { transaction });
    return out;
  });
}

async function confirm(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const b = await lockBatch(companyId, id, transaction);
    needDraft(b);
    const ready = readiness(b);
    const labels = { notes: 'notes', yarn: 'yarn tagged', beams: 'a beam received', rate: 'the rate per lb', weight: 'a net warp weight above 0' };
    const missing = Object.keys(ready).filter((k) => !ready[k]);
    if (missing.length) throw AppError.rule('NOT_READY', `The batch cannot be confirmed yet: it needs ${missing.map((k) => labels[k]).join(', ')}`, { missing, readiness: ready });
    await exec('UPDATE sizing_batches SET status = \'CONFIRMED\', "confirmedAt" = now(), "confirmedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'SIZING_BATCH_CONFIRMED', entityType: 'SizingBatch', entityId: id, after: { netWarpWt: n2(b.netWarpWt), amount: n2(b.amount) } }, { transaction });
    return full(companyId, id, transaction);
  });
}

async function reopen(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const b = await lockBatch(companyId, id, transaction);
    if (b.status === 'DRAFT') return full(companyId, id, transaction);
    const [inv] = await q('SELECT p."voucherNo" FROM purchase_invoice_sizing_batches l JOIN purchase_invoices p ON p.id = l."invoiceId" WHERE l."batchId" = :id', { id }, transaction);
    if (inv) throw AppError.rule('ON_PURCHASE_INVOICE', `This batch is on purchase invoice ${label(inv.voucherNo)}: delete that invoice first to reopen it`, { voucherNo: inv.voucherNo });
    await exec('UPDATE sizing_batches SET status = \'DRAFT\', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'SIZING_BATCH_REOPENED', entityType: 'SizingBatch', entityId: id }, { transaction });
    return full(companyId, id, transaction);
  });
}

async function remove(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const b = await lockBatch(companyId, id, transaction);
    needDraft(b);
    const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM sizing_receipts WHERE "batchId" = :id', { id }, transaction);
    if (n) throw AppError.rule('HAS_RECEIPTS', `${n} beam receipt${n === 1 ? '' : 's'} came in on this batch: delete ${n === 1 ? 'it' : 'them'} first`, { receipts: n });
    await exec('DELETE FROM sizing_batch_yarns WHERE "batchId" = :id', { id }, transaction);
    await exec('UPDATE sizing_batches SET "deletedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'SIZING_BATCH_DELETED', entityType: 'SizingBatch', entityId: id, before: { batchNo: b.batchNo, setNo: b.setNo } }, { transaction });
    return { deleted: true, id };
  });
}

// ---- beam receipts (GRN) ----
/** The sized beams that can come back from this party: beams AT_SIZING whose last sizing challan went to this party. */
async function pendingBeamRows(companyId, vendorId, transaction) {
  return q(`SELECT b.id, b."beamNo", b.name, to_char(b."statusDate", 'YYYY-MM-DD') AS "sentOn", b."weightKg", x."challanNo", x.id AS "outwardId"
    FROM yarn_beams b JOIN LATERAL (SELECT o.id, o."challanNo", o."vendorId" FROM yarn_outward_beams xb JOIN yarn_outwards o ON o.id = xb."outwardId" AND o.type = 'SIZING' AND o."deletedAt" IS NULL
      WHERE xb."beamId" = b.id ORDER BY o."outwardDate" DESC, o."challanNo" DESC LIMIT 1) x ON true
    WHERE b."companyId" = :companyId AND b.status = 'AT_SIZING' AND b."deletedAt" IS NULL AND x."vendorId" = :vendorId ORDER BY b."beamNo"`, { companyId, vendorId }, transaction);
}

/** GET /pending-beams?vendorId= : the beams waiting at this sizing party (the picker of the beam receipt). */
async function pendingBeams(req, { vendorId, search }) {
  await checkVendorExists(req.user.companyId, vendorId);
  let rows = await pendingBeamRows(req.user.companyId, vendorId);
  if (search) { const s = search.trim().toLowerCase(); rows = rows.filter((b) => b.name.toLowerCase().includes(s) || String(b.beamNo) === s); }
  return { data: rows.map((b) => ({ id: b.id, beamNo: b.beamNo, beamLabel: label(b.beamNo), name: b.name, sentOn: b.sentOn, weightKg: num(b.weightKg), challanNo: b.challanNo, challanText: label(b.challanNo) })), total: rows.length };
}

/** The next In Pass number of the company: one running number for the sized beam receipts and the sizing returns, never used again (even if the entry is deleted). */
async function nextInPass(companyId, transaction) {
  return counters.take(companyId, 'sizing_in_pass', async () => {
    const [r] = await q('SELECT GREATEST((SELECT COALESCE(MAX("receiptNo"), 0) FROM sizing_receipts WHERE "companyId" = :companyId), (SELECT COALESCE(MAX("inPassNo"), 0) FROM sizing_returns WHERE "companyId" = :companyId)) + 1 AS n', { companyId }, transaction);
    return Number(r.n);
  }, transaction);
}

/** A receipt's beams go back to sizing (only while they are still FULL: a beam that moved on cannot be undone); its beam and cone rows are deleted. */
async function releaseReceipt(receiptId, transaction) {
  const rows = await q('SELECT rb."beamId", rb."prevStatusDate", b."beamNo", b.status FROM sizing_receipt_beams rb JOIN yarn_beams b ON b.id = rb."beamId" WHERE rb."receiptId" = :receiptId', { receiptId }, transaction);
  for (const r of rows) {
    if (r.status !== 'FULL') throw AppError.rule('BEAM_MOVED_ON', `Beam ${r.beamNo} is not full any more (it is ${BEAM_TEXT[r.status].toLowerCase()}): this receipt cannot be changed or deleted`, { beamNo: r.beamNo, status: r.status });
    await exec('UPDATE yarn_beams SET status = \'AT_SIZING\', "statusDate" = :d, meters = NULL, "updatedAt" = now() WHERE id = :id', { d: r.prevStatusDate, id: r.beamId }, transaction);
  }
  await exec('DELETE FROM sizing_receipt_beams WHERE "receiptId" = :receiptId', { receiptId }, transaction);
  await exec('DELETE FROM sizing_receipt_cones WHERE "receiptId" = :receiptId', { receiptId }, transaction);
}

/** Receives the beams (AT_SIZING -> FULL, dated like the receipt, with their length) and saves the cut cones. */
async function applyReceipt(companyId, batch, receiptId, date, beams, cones, transaction) {
  const pending = new Map((await pendingBeamRows(companyId, batch.vendorId, transaction)).map((b) => [b.id, b]));
  const ids = beams.map((b) => b.beamId);
  if (new Set(ids).size !== ids.length) throw AppError.rule('DUPLICATE_BEAM', 'The same beam is listed twice', { field: 'beams' });
  if (ids.length) await q('SELECT id FROM yarn_beams WHERE id IN (:ids) ORDER BY id FOR UPDATE', { ids }, transaction);
  for (const [i, b] of beams.entries()) {
    const p = pending.get(b.beamId);
    if (!p) throw AppError.rule('BEAM_NOT_AT_PARTY', 'This beam is not waiting at this sizing party (it may be received already)', { line: i + 1, beamId: b.beamId });
    if (p.sentOn > date) throw AppError.rule('BEFORE_OUTWARD', `Beam ${p.beamNo} went to sizing on ${p.sentOn}: it cannot come back before that`, { line: i + 1, beamNo: p.beamNo, sentOn: p.sentOn });
    await exec('INSERT INTO sizing_receipt_beams (id, "receiptId", "beamId", "lengthM", "weightKg", "prevStatusDate") VALUES (:id, :receiptId, :beamId, :lengthM, :weightKg, :prev)',
      { id: crypto.randomUUID(), receiptId, beamId: b.beamId, lengthM: n2(b.lengthM), weightKg: b.weightKg == null ? null : n2(b.weightKg), prev: p.sentOn }, transaction);
    await exec('UPDATE yarn_beams SET status = \'FULL\', "statusDate" = :d, meters = :m, "updatedAt" = now() WHERE id = :id', { d: date, m: n2(b.lengthM), id: b.beamId }, transaction);
  }
  for (const c of cones) {
    await exec('INSERT INTO sizing_receipt_cones (id, "receiptId", type, kg, lbs, cones, bags) VALUES (:id, :receiptId, :type, :kg, :lbs, :cones, :bags)',
      { id: crypto.randomUUID(), receiptId, type: c.type || CONE_TYPES[0], kg: n2(c.kg), lbs: n2(Number(c.kg) * KG_TO_LB), cones: c.cones || 0, bags: c.bags || 0 }, transaction);
  }
}

const needSomething = (beams, cones) => {
  if (!beams.length && !cones.length) throw AppError.rule('NOTHING_RECEIVED', 'Add the beams or the cut cones that came in');
};

async function createReceipt(req, id, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `sizing-receipt:${companyId}` }, transaction);
    const b = await lockBatch(companyId, id, transaction);
    needDraft(b);
    const beams = data.beams || []; const cones = data.cutCones || [];
    needSomething(beams, cones);
    const date = data.receiptDate || today();
    // the In Pass number: a running number of the company that is never used again, even if the receipt is deleted
    const next = await nextInPass(companyId, transaction);
    const receiptId = crypto.randomUUID();
    await exec('INSERT INTO sizing_receipts (id, "companyId", "batchId", "receiptNo", "receiptDate", "refNo", notes, "createdById") VALUES (:receiptId, :companyId, :id, :no, :date, :refNo, :notes, :userId)',
      { receiptId, companyId, id, no: next, date, refNo: data.refNo || null, notes: data.notes || null, userId: req.user.id }, transaction);
    await applyReceipt(companyId, b, receiptId, date, beams, cones, transaction);
    await recalc(id, transaction);
    const [out] = await receiptsOf('r.id = :receiptId', { receiptId }, transaction);
    await audit.log(req, { action: 'SIZING_RECEIPT_CREATED', entityType: 'SizingBatch', entityId: id, after: { receiptNo: out.receiptNo, beams: out.totalBeams, lengthM: out.lengthM, coneKg: out.coneKg } }, { transaction });
    return { ...out, batch: await batchBrief(companyId, id, transaction) };
  });
}

async function batchBrief(companyId, id, transaction) {
  const h = headJson(await headOr404(companyId, id, transaction));
  return { id: h.id, batchNo: h.batchNo, batchLabel: h.batchLabel, setNo: h.setNo, ends: h.ends, status: h.status, party: h.party, yarnCount: h.yarnCount, warpLengthM: h.warpLengthM, beamCount: h.beamCount, actualCount: h.actualCount, billing: h.billing };
}

async function receiptOr404(companyId, receiptId, transaction) {
  const [r] = await q('SELECT * FROM sizing_receipts WHERE id = :receiptId AND "companyId" = :companyId', { receiptId, companyId }, transaction);
  if (!r) throw AppError.notFound('Beam receipt');
  return r;
}

async function updateReceipt(req, receiptId, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const r = await receiptOr404(companyId, receiptId, transaction);
    const b = await lockBatch(companyId, r.batchId, transaction);
    needDraft(b);
    const [current] = await receiptsOf('r.id = :receiptId', { receiptId }, transaction);
    const date = changes.receiptDate || current.receiptDate;
    const beams = changes.beams || current.beams.map((x) => ({ beamId: x.id, lengthM: x.lengthM, weightKg: x.weightKg }));
    const cones = changes.cutCones || current.cutCones.map((x) => ({ type: x.type, kg: x.kg, cones: x.cones, bags: x.bags }));
    needSomething(beams, cones);
    await releaseReceipt(receiptId, transaction);
    await applyReceipt(companyId, b, receiptId, date, beams, cones, transaction);
    const set = { receiptDate: date };
    for (const f of ['refNo', 'notes']) if (changes[f] !== undefined) set[f] = changes[f] === '' ? null : changes[f];
    await exec(`UPDATE sizing_receipts SET ${Object.keys(set).map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :receiptId`, { ...set, receiptId }, transaction);
    await recalc(r.batchId, transaction);
    const [out] = await receiptsOf('r.id = :receiptId', { receiptId }, transaction);
    await audit.log(req, { action: 'SIZING_RECEIPT_UPDATED', entityType: 'SizingBatch', entityId: r.batchId, before: { receiptNo: current.receiptNo, beams: current.totalBeams, lengthM: current.lengthM }, after: { receiptNo: out.receiptNo, beams: out.totalBeams, lengthM: out.lengthM } }, { transaction });
    return { ...out, batch: await batchBrief(companyId, r.batchId, transaction) };
  });
}

async function removeReceipt(req, receiptId) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const r = await receiptOr404(companyId, receiptId, transaction);
    const b = await lockBatch(companyId, r.batchId, transaction);
    needDraft(b);
    await releaseReceipt(receiptId, transaction);
    await exec('DELETE FROM sizing_receipts WHERE id = :receiptId', { receiptId }, transaction);
    await recalc(r.batchId, transaction);
    await audit.log(req, { action: 'SIZING_RECEIPT_DELETED', entityType: 'SizingBatch', entityId: r.batchId, before: { receiptNo: r.receiptNo } }, { transaction });
    return { deleted: true, id: receiptId };
  });
}

async function getReceipt(req, receiptId) {
  const r = await receiptOr404(req.user.companyId, receiptId);
  const [out] = await receiptsOf('r.id = :receiptId', { receiptId });
  return { ...out, batch: await batchBrief(req.user.companyId, r.batchId) };
}

/** The "Sized beam inward summary": every receipt with its batch, party, length, beams and cut cones. */
async function listReceipts(req, { page, limit, search, vendorId, batchId, dateFrom, dateTo }) {
  const r = { companyId: req.user.companyId };
  const f = ['r."companyId" = :companyId', 'b."deletedAt" IS NULL'];
  if (vendorId) { f.push('b."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (batchId) { f.push('r."batchId" = :batchId'); r.batchId = batchId; }
  if (dateFrom) { f.push('r."receiptDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { f.push('r."receiptDate" <= :dateTo'); r.dateTo = dateTo; }
  if (search) {
    r.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`; r.exact = String(Number(search) || '');
    f.push('(b."setNo" ILIKE :like OR v.name ILIKE :like OR r.notes ILIKE :like OR r."refNo" ILIKE :like OR yc.name ILIKE :like OR r."receiptNo"::text = :exact OR b."batchNo"::text = :exact)');
  }
  const from = `FROM sizing_receipts r JOIN sizing_batches b ON b.id = r."batchId" JOIN vendors v ON v.id = b."vendorId" JOIN yarn_counts yc ON yc.id = b."yarnCountId" WHERE ${f.join(' AND ')}`;
  const rows = await q(`SELECT r.id, r."receiptNo", to_char(r."receiptDate", 'YYYY-MM-DD') AS "receiptDate", r."refNo", r.notes, b.id AS "batchId", b."batchNo", b."setNo", b.ends, b.status, v.id AS "vendorId", v.name AS "vendorName", yc.name AS "yarnCountName",
      (SELECT COUNT(*)::int FROM sizing_receipt_beams x WHERE x."receiptId" = r.id) AS beams, (SELECT COALESCE(SUM(x."lengthM"), 0) FROM sizing_receipt_beams x WHERE x."receiptId" = r.id) AS len,
      (SELECT COALESCE(SUM(x.kg), 0) FROM sizing_receipt_cones x WHERE x."receiptId" = r.id) AS kg, (SELECT COALESCE(SUM(x.lbs), 0) FROM sizing_receipt_cones x WHERE x."receiptId" = r.id) AS lbs
    ${from} ORDER BY r."receiptDate" DESC, r."receiptNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  const [t] = await q(`SELECT COUNT(*)::int AS total, COALESCE((SELECT SUM(x."lengthM") FROM sizing_receipt_beams x JOIN sizing_receipts r2 ON r2.id = x."receiptId" JOIN sizing_batches b2 ON b2.id = r2."batchId" WHERE r2.id IN (SELECT r.id ${from})), 0) AS len,
    COALESCE((SELECT COUNT(*) FROM sizing_receipt_beams x WHERE x."receiptId" IN (SELECT r.id ${from})), 0)::int AS beams,
    COALESCE((SELECT SUM(x.kg) FROM sizing_receipt_cones x WHERE x."receiptId" IN (SELECT r.id ${from})), 0) AS kg ${from}`, r);
  return { data: rows.map((x) => ({ id: x.id, receiptNo: x.receiptNo, receiptLabel: label(x.receiptNo), inPassNo: x.receiptNo, inPassLabel: label(x.receiptNo), receiptDate: x.receiptDate, refNo: x.refNo, notes: x.notes,
    batch: { id: x.batchId, batchNo: x.batchNo, batchLabel: label(x.batchNo), setNo: x.setNo, status: x.status }, party: { id: x.vendorId, name: x.vendorName }, yarnCount: { name: x.yarnCountName }, ends: x.ends,
    lengthM: n2(x.len), beams: x.beams, coneKg: n2(x.kg), coneLbs: n2(x.lbs) })), page, limit, total: t.total, totals: { receipts: t.total, lengthM: n2(t.len), beams: t.beams, coneKg: n2(t.kg) } };
}

/** Used by the sizing challan (Weaving > Yarn outward): a challan whose yarn is tagged to a batch, or whose beams came back on a batch, cannot be changed or deleted. */
async function assertNoBatch(outwardId, action, transaction) {
  const [r] = await q(`SELECT (SELECT COUNT(*) FROM sizing_receipt_beams rb JOIN yarn_outward_beams xb ON xb."beamId" = rb."beamId" AND xb."outwardId" = :outwardId JOIN sizing_receipts s ON s.id = rb."receiptId" JOIN sizing_batches b ON b.id = s."batchId" AND b."deletedAt" IS NULL)::int
    + (SELECT COUNT(*) FROM sizing_batch_yarns y JOIN yarn_outward_lines l ON l."inwardId" = y."inwardId" AND l."outwardId" = :outwardId JOIN yarn_outwards o ON o.id = l."outwardId" JOIN sizing_batches b ON b.id = y."batchId" AND b."deletedAt" IS NULL AND b."vendorId" = o."vendorId")::int
    + (SELECT COUNT(*) FROM sizing_return_beams rb JOIN sizing_returns sr ON sr.id = rb."returnId" JOIN yarn_outward_beams xb ON xb."beamId" = rb."beamId" AND xb."outwardId" = :outwardId JOIN yarn_outwards oo ON oo.id = xb."outwardId" AND sr."returnDate" >= oo."outwardDate")::int
    + (SELECT COUNT(*) FROM sizing_return_yarns ry JOIN sizing_returns sr ON sr.id = ry."returnId" JOIN yarn_outward_lines l ON l."inwardId" = ry."inwardId" AND l."outwardId" = :outwardId JOIN yarn_outwards o ON o.id = l."outwardId" AND o."vendorId" = sr."vendorId" AND sr."returnDate" >= o."outwardDate")::int AS n`, { outwardId }, transaction);
  if (r.n) throw AppError.rule('HAS_SIZING_BATCH', `Yarn or beams of this challan are used in a sizing batch or came back on a sizing return: remove them from the batch / delete the return first to ${action}`, { uses: r.n });
}

module.exports = { yarnPool, pendingBeamRows, nextInPass, checkVendorExists, BEAM_TEXT, list, get, create, update, remove, confirm, reopen, formData, yarnAvailable, addYarn, updateYarn, removeYarn, pendingBeams,
  createReceipt, updateReceipt, removeReceipt, getReceipt, listReceipts, assertNoBatch, KG_TO_LB, ADJ_LIMIT };
