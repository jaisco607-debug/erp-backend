// Purchase Invoice (accounting chunk 3, owner 2026-10-28): the mirror of the Sales Invoice.
// An invoice is for ONE vendor and is made of that vendor's APPROVED store inwards (the chemical and general store purchases: what the vendor
// delivered and what it costs, with the sales tax). We owe the vendor, so the entry is the other way round from a sale:
//   UNAPPROVED  saved; may be changed or deleted; no accounting entry
//   APPROVED    posted:  Debit Purchases (gross)  /  Debit Input Sales Tax (tax)  /  Credit Accounts Payable (net, with the vendor named)
//   un-approve  posts the reverse entry (nothing is erased) and the invoice may be changed again
// Amounts always follow the store inwards and are worked out again on every save / approve. An inward on an invoice cannot be corrected or
// un-approved in the store until the invoice is un-approved or deleted (storeInwardService checks it).
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const credit = require('./creditService');
const { round } = require('../utils/money');
const { today } = require('../utils/dates');

const SOURCE = 'PURCHASE_INVOICE';
const STORE_TEXT = { CHEMICAL: 'Chemical Store', GENERAL: 'General Store' };
const STATUS_TEXT = { UNAPPROVED: 'Un-approved', APPROVED: 'Approved' };
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const label = (n) => String(n).padStart(5, '0');
const lockPurchases = (companyId, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `purchases:${companyId}` }, transaction });

/** The store inwards with what they cost; `invoiceId` is the purchase invoice an inward is already on. */
const INWARD_SQL = `
  SELECT i.id AS "inwardId", i.store, i."idNo", i."ipNo", to_char(i."inwardDate", 'YYYY-MM-DD') AS "inwardDate", i."billType", i."vendorId", i."grnNo", i."dcNo", i.notes,
    i."isApproved", i.amount::float AS amount, i."salesTax"::float AS "salesTax", i."gstPercent"::float AS "gstPercent",
    (SELECT string_agg(it.name, ', ' ORDER BY l."sortOrder") FROM store_inward_lines l JOIN store_items it ON it.id = l."itemId" WHERE l."inwardId" = i.id) AS items,
    (SELECT pl."invoiceId" FROM purchase_invoice_lines pl WHERE pl."inwardId" = i.id) AS "invoiceId",
    (SELECT p."voucherNo" FROM purchase_invoice_lines pl JOIN purchase_invoices p ON p.id = pl."invoiceId" WHERE pl."inwardId" = i.id) AS "invoiceVoucherNo"
  FROM store_inwards i WHERE i."companyId" = :companyId`;

const inwardLine = (r) => ({
  inwardId: r.inwardId, store: r.store, storeText: STORE_TEXT[r.store], idNo: r.idNo, idLabel: label(r.idNo), ipNo: r.ipNo, ipLabel: r.ipNo ? label(r.ipNo) : null,
  inwardDate: r.inwardDate, billType: r.billType, grnNo: r.grnNo, dcNo: r.dcNo, notes: r.notes, items: r.items, gstPercent: r.gstPercent,
  amount: r.amount, salesTax: r.salesTax, net: round(r.amount + r.salesTax, 2),
});

/** GET /purchase-invoices/inwards?vendorId= : the approved purchases of this vendor that can still be put on an invoice. */
async function inwards(req, { vendorId, store, search, invoiceId, limit }) {
  const rows = await q(`${INWARD_SQL} AND i."vendorId" = :vendorId AND i."isApproved" ${store ? 'AND i.store = :store' : ''} ORDER BY i."inwardDate" DESC, i."idNo" DESC`,
    { companyId: req.user.companyId, vendorId, store });
  let data = rows.filter((r) => !r.invoiceId || r.invoiceId === invoiceId);
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((r) => [r.idNo, r.ipNo].some((n) => String(n) === s) || [r.grnNo, r.dcNo, r.notes, r.items].some((t) => (t || '').toLowerCase().includes(s)));
  }
  const total = data.length;
  return { data: data.slice(0, limit).map((r) => ({ ...inwardLine(r), canBill: r.amount + r.salesTax > 0, blockedReason: r.amount + r.salesTax > 0 ? null : 'The purchase has no amount' })), total };
}

/** The lines of an invoice from the chosen inwards; every rule about an inward is checked here. */
async function buildLines(req, vendorId, inwardIds, invoiceId, transaction) {
  const ids = [...new Set(inwardIds)];
  const rows = await q(`${INWARD_SQL} AND i.id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction);
  if (rows.length !== ids.length) throw AppError.notFound('Purchase entry');
  for (const r of rows) {
    const name = `Purchase ${label(r.ipNo || r.idNo)} (${STORE_TEXT[r.store]})`;
    if (!r.isApproved) throw AppError.rule('INWARD_NOT_APPROVED', `${name} is not approved in the store yet`);
    if (r.vendorId !== vendorId) throw AppError.rule('INWARD_OTHER_VENDOR', `${name} belongs to another vendor; one invoice is for one vendor`);
    if (r.invoiceId && r.invoiceId !== invoiceId) throw AppError.rule('INWARD_TAKEN', `${name} is already on purchase invoice ${label(r.invoiceVoucherNo)}`);
    if (!(r.amount + r.salesTax > 0)) throw AppError.rule('NO_AMOUNT', `${name} has no amount, so there is nothing to bill`);
  }
  return rows.sort((a, b) => (a.inwardDate < b.inwardDate ? -1 : a.inwardDate > b.inwardDate ? 1 : a.idNo - b.idNo));
}

/** The weaving yarn inward entries bought from a vendor (PURCHASE yarn) with what they cost; `invoiceId` is the purchase invoice an entry is already on. */
const YARN_SQL = `
  SELECT y.id AS "inwardId", y.code, to_char(y."inwardDate", 'YYYY-MM-DD') AS "inwardDate", y."vendorId", y."dcNo", y.remarks, y.bags, y."lbsPerBag"::float AS "lbsPerBag", y."totalLbs"::float AS lbs,
    y."ratePerLb"::float AS rate, COALESCE(y.amount, 0)::float AS amount, yc.name || ' - ' || yb.name || ' - ' || it.packing || ' - ' || it.bags AS item,
    (SELECT pl."invoiceId" FROM purchase_invoice_yarn_inwards pl WHERE pl."inwardId" = y.id) AS "invoiceId",
    (SELECT p."voucherNo" FROM purchase_invoice_yarn_inwards pl JOIN purchase_invoices p ON p.id = pl."invoiceId" WHERE pl."inwardId" = y.id) AS "invoiceVoucherNo"
  FROM yarn_inwards y JOIN yarn_items it ON it.id = y."itemId" JOIN yarn_counts yc ON yc.id = it."yarnCountId" JOIN yarn_brands yb ON yb.id = it."brandId"
  WHERE y."companyId" = :companyId AND y."deletedAt" IS NULL AND y."vendorId" IS NOT NULL`;
const yarnLine = (r) => ({
  inwardId: r.inwardId, inwardCode: r.code, inwardLabel: label(r.code), inwardDate: r.inwardDate, dcNo: r.dcNo, remarks: r.remarks, item: r.item,
  bags: r.bags, lbsPerBag: r.lbsPerBag, lbs: r.lbs, ratePerLb: r.rate, amount: r.amount, salesTax: r.salesTax || 0, net: round(r.amount + (r.salesTax || 0), 2),
});

/** GET /purchase-invoices/yarn-inwards?vendorId= : the yarn bought from this vendor (weaving yarn inward) that can still be put on an invoice. */
async function yarnInwards(req, { vendorId, search, invoiceId, limit }) {
  const rows = await q(`${YARN_SQL} AND y."vendorId" = :vendorId ORDER BY y."inwardDate" DESC, y.code DESC`, { companyId: req.user.companyId, vendorId });
  let data = rows.filter((r) => !r.invoiceId || r.invoiceId === invoiceId);
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((r) => String(r.code) === s || [r.dcNo, r.remarks, r.item].some((t) => (t || '').toLowerCase().includes(s)));
  }
  return { data: data.slice(0, limit).map((r) => ({ ...yarnLine(r), canBill: r.amount > 0, blockedReason: r.amount > 0 ? null : 'The purchase has no amount' })), total: data.length };
}

/** The lines of a YARN invoice from the chosen yarn inward entries; every rule about an entry is checked here. */
async function buildYarn(req, vendorId, inwardIds, invoiceId, transaction) {
  const ids = [...new Set(inwardIds)];
  const rows = await q(`${YARN_SQL} AND y.id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction);
  if (rows.length !== ids.length) throw AppError.notFound('Yarn inward entry');
  for (const r of rows) {
    const name = `Yarn inward ${label(r.code)}`;
    if (r.vendorId !== vendorId) throw AppError.rule('INWARD_OTHER_VENDOR', `${name} belongs to another vendor; one invoice is for one vendor`);
    if (r.invoiceId && r.invoiceId !== invoiceId) throw AppError.rule('INWARD_TAKEN', `${name} is already on purchase invoice ${label(r.invoiceVoucherNo)}`);
    if (!(r.amount > 0)) throw AppError.rule('NO_AMOUNT', `${name} has no amount, so there is nothing to bill`);
  }
  return rows.sort((a, b) => a.code - b.code).map((r) => ({ ...r, salesTax: 0 }));
}

async function writeYarnLines(invoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM purchase_invoice_yarn_inwards WHERE "invoiceId" = :invoiceId', { replacements: { invoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query('INSERT INTO purchase_invoice_yarn_inwards ("invoiceId", "companyId", "lineNo", "inwardId", amount, "salesTax") VALUES (:invoiceId, :companyId, :lineNo, :inwardId, :amount, :salesTax)',
      { replacements: { invoiceId, companyId, lineNo, inwardId: l.inwardId, amount: l.amount, salesTax: l.salesTax }, transaction });
  }
}

/** The SIZING receipts (weaving sizing inward) of a vendor with what the sizing costs; `invoiceId` is the purchase invoice a receipt is already on. */
const SIZING_SQL = `
  SELECT s.id AS "inwardId", s."inwardNo", to_char(s."inwardDate", 'YYYY-MM-DD') AS "inwardDate", s."vendorId", s."dcNo", s.description, o."challanNo",
    s."lbsUsed"::float AS "lbsUsed", s."cutConeKg"::float AS "cutConeKg", s."ratePerLb"::float AS rate, s.amount::float AS amount,
    (SELECT COUNT(*)::int FROM yarn_sizing_inward_beams b WHERE b."inwardId" = s.id) AS beams, (SELECT COALESCE(SUM(b.meters), 0)::float FROM yarn_sizing_inward_beams b WHERE b."inwardId" = s.id) AS meters,
    (SELECT pl."invoiceId" FROM purchase_invoice_sizing_inwards pl WHERE pl."inwardId" = s.id) AS "invoiceId",
    (SELECT p."voucherNo" FROM purchase_invoice_sizing_inwards pl JOIN purchase_invoices p ON p.id = pl."invoiceId" WHERE pl."inwardId" = s.id) AS "invoiceVoucherNo"
  FROM yarn_sizing_inwards s JOIN yarn_outwards o ON o.id = s."outwardId"
  WHERE s."companyId" = :companyId AND s."deletedAt" IS NULL`;
const sizingLine = (r) => ({
  inwardId: r.inwardId, inwardNo: r.inwardNo, inwardLabel: label(r.inwardNo), inwardDate: r.inwardDate, dcNo: r.dcNo, description: r.description, challanNo: r.challanNo, challanText: r.challanNo ? label(r.challanNo) : null,
  beams: r.beams, meters: r.meters, lbsUsed: r.lbsUsed, cutConeKg: r.cutConeKg, ratePerLb: r.rate, amount: r.amount, salesTax: r.salesTax || 0, net: round(r.amount + (r.salesTax || 0), 2),
});

/** GET /purchase-invoices/sizing-inwards?vendorId= : the sizing receipts of this vendor (the sizing party) that can still be put on an invoice. */
async function sizingInwards(req, { vendorId, search, invoiceId, limit }) {
  const rows = await q(`${SIZING_SQL} AND s."vendorId" = :vendorId ORDER BY s."inwardDate" DESC, s."inwardNo" DESC`, { companyId: req.user.companyId, vendorId });
  let data = rows.filter((r) => !r.invoiceId || r.invoiceId === invoiceId);
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((r) => String(r.inwardNo) === s || String(r.challanNo) === s || [r.dcNo, r.description].some((t) => (t || '').toLowerCase().includes(s)));
  }
  return { data: data.slice(0, limit).map((r) => ({ ...sizingLine(r), canBill: r.amount > 0, blockedReason: r.amount > 0 ? null : 'The sizing receipt has no amount' })), total: data.length };
}

/** The lines of a SIZING invoice from the chosen receipts; every rule about a receipt is checked here. */
async function buildSizing(req, vendorId, inwardIds, invoiceId, transaction) {
  const ids = [...new Set(inwardIds)];
  const rows = await q(`${SIZING_SQL} AND s.id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction);
  if (rows.length !== ids.length) throw AppError.notFound('Sizing receipt');
  for (const r of rows) {
    const name = `Sizing receipt ${label(r.inwardNo)}`;
    if (r.vendorId !== vendorId) throw AppError.rule('INWARD_OTHER_VENDOR', `${name} belongs to another vendor; one invoice is for one vendor`);
    if (r.invoiceId && r.invoiceId !== invoiceId) throw AppError.rule('INWARD_TAKEN', `${name} is already on purchase invoice ${label(r.invoiceVoucherNo)}`);
    if (!(r.amount > 0)) throw AppError.rule('NO_AMOUNT', `${name} has no amount, so there is nothing to bill`);
  }
  return rows.sort((a, b) => a.inwardNo - b.inwardNo).map((r) => ({ ...r, salesTax: 0 }));
}

async function writeSizingLines(invoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM purchase_invoice_sizing_inwards WHERE "invoiceId" = :invoiceId', { replacements: { invoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query('INSERT INTO purchase_invoice_sizing_inwards ("invoiceId", "companyId", "lineNo", "inwardId", amount, "salesTax") VALUES (:invoiceId, :companyId, :lineNo, :inwardId, :amount, :salesTax)',
      { replacements: { invoiceId, companyId, lineNo, inwardId: l.inwardId, amount: l.amount, salesTax: l.salesTax }, transaction });
  }
}

/** The FABRIC inward entries (store cloth bought from a vendor) with what they cost; `invoiceId` is the purchase invoice an entry is already on. */
const FABRIC_SQL = `
  SELECT f.id AS "inwardId", f."inwardNo", f."typeNo", to_char(f."inwardDate", 'YYYY-MM-DD') AS "inwardDate", f."vendorId", f."dcNo", f."isApproved", f.unit, f.pieces,
    f."inwardMeters"::float AS meters, f."inwardYards"::float AS yards, f.rate::float AS rate, f."rateUnit", COALESCE(f.amount, 0)::float AS amount, ql.name AS quality,
    (SELECT pl."invoiceId" FROM purchase_invoice_fabric_inwards pl WHERE pl."inwardId" = f.id) AS "invoiceId",
    (SELECT p."voucherNo" FROM purchase_invoice_fabric_inwards pl JOIN purchase_invoices p ON p.id = pl."invoiceId" WHERE pl."inwardId" = f.id) AS "invoiceVoucherNo"
  FROM fabric_inwards f JOIN qualities ql ON ql.id = f."qualityId" WHERE f."companyId" = :companyId AND f."deletedAt" IS NULL`;
const fabricLine = (r) => ({
  inwardId: r.inwardId, inwardNo: r.inwardNo, inwardLabel: label(r.inwardNo), typeNo: r.typeNo, inwardDate: r.inwardDate, dcNo: r.dcNo, quality: r.quality, pieces: r.pieces,
  meters: r.meters, yards: r.unit === 'YARD' ? r.yards : null, unit: r.unit, rate: r.rate, rateUnit: r.rate == null ? null : r.rateUnit || r.unit, rateText: r.rate == null ? null : `per ${(r.rateUnit || r.unit) === 'YARD' ? 'yard' : 'meter'}`,
  amount: r.amount, salesTax: r.salesTax || 0, net: round(r.amount + (r.salesTax || 0), 2),
});

/** GET /purchase-invoices/fabric-inwards?vendorId= : the approved fabric inwards of this vendor that can still be put on a fabric invoice. */
async function fabricInwards(req, { vendorId, search, invoiceId, limit }) {
  const rows = await q(`${FABRIC_SQL} AND f."vendorId" = :vendorId AND f."isApproved" ORDER BY f."inwardDate" DESC, f."inwardNo" DESC`, { companyId: req.user.companyId, vendorId });
  let data = rows.filter((r) => !r.invoiceId || r.invoiceId === invoiceId);
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((r) => String(r.inwardNo) === s || [r.dcNo, r.quality, r.typeNo].some((t) => (t || '').toLowerCase().includes(s)));
  }
  return { data: data.slice(0, limit).map((r) => ({ ...fabricLine(r), canBill: r.amount > 0, blockedReason: r.amount > 0 ? null : 'The fabric inward has no rate: give its rate in the store first' })), total: data.length };
}

/** The lines of a FABRIC invoice from the chosen fabric inwards; every rule about an entry is checked here. */
async function buildFabric(req, vendorId, inwardIds, invoiceId, transaction) {
  const ids = [...new Set(inwardIds)];
  const rows = await q(`${FABRIC_SQL} AND f.id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction);
  if (rows.length !== ids.length) throw AppError.notFound('Fabric inward');
  for (const r of rows) {
    const name = `Fabric inward ${label(r.inwardNo)}`;
    if (!r.isApproved) throw AppError.rule('INWARD_NOT_APPROVED', `${name} is not approved in the store yet`);
    if (r.vendorId !== vendorId) throw AppError.rule('INWARD_OTHER_VENDOR', `${name} belongs to another vendor; one invoice is for one vendor`);
    if (r.invoiceId && r.invoiceId !== invoiceId) throw AppError.rule('INWARD_TAKEN', `${name} is already on purchase invoice ${label(r.invoiceVoucherNo)}`);
    if (!(r.amount > 0)) throw AppError.rule('NO_AMOUNT', `${name} has no amount (no rate), so there is nothing to bill`);
  }
  return rows.sort((a, b) => a.inwardNo - b.inwardNo).map((r) => ({ ...r, salesTax: 0 }));
}

async function writeFabricLines(invoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM purchase_invoice_fabric_inwards WHERE "invoiceId" = :invoiceId', { replacements: { invoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query('INSERT INTO purchase_invoice_fabric_inwards ("invoiceId", "companyId", "lineNo", "inwardId", amount, "salesTax") VALUES (:invoiceId, :companyId, :lineNo, :inwardId, :amount, :salesTax)',
      { replacements: { invoiceId, companyId, lineNo, inwardId: l.inwardId, amount: l.amount, salesTax: l.salesTax }, transaction });
  }
}

/** The confirmed SIZING BATCHES (Sizing Management) with what the sizing costs; "inwardId" is the batch id (the generic invoice code calls every source row an inward); `invoiceId` is the purchase invoice a batch is already on. */
const SIZING_BATCH_SQL = `
  SELECT s.id AS "inwardId", s."batchNo", to_char(s."batchDate", 'YYYY-MM-DD') AS "batchDate", s."vendorId", s."setNo", s.ends, s.status, yc.name AS "yarnCount", s."netWarpWt"::float AS "netWarpWt", s."ratePerLb"::float AS rate, s.amount::float AS amount,
    (SELECT pl."invoiceId" FROM purchase_invoice_sizing_batches pl WHERE pl."batchId" = s.id) AS "invoiceId",
    (SELECT p."voucherNo" FROM purchase_invoice_sizing_batches pl JOIN purchase_invoices p ON p.id = pl."invoiceId" WHERE pl."batchId" = s.id) AS "invoiceVoucherNo"
  FROM sizing_batches s JOIN yarn_counts yc ON yc.id = s."yarnCountId" WHERE s."companyId" = :companyId AND s."deletedAt" IS NULL`;
const sizingBatchLine = (r) => ({
  inwardId: r.inwardId, batchId: r.inwardId, batchNo: r.batchNo, batchLabel: label(r.batchNo), batchDate: r.batchDate, setNo: r.setNo, ends: r.ends, yarnCount: r.yarnCount, title: `Sizing batch ${label(r.batchNo)} - Set ${r.setNo}`,
  netWarpWt: r.netWarpWt, ratePerLb: r.rate, amount: r.amount, salesTax: r.salesTax || 0, net: round(r.amount + (r.salesTax || 0), 2),
});

/** GET /purchase-invoices/sizing-batches?vendorId= : the confirmed sizing batches of this sizing party that can still be put on an invoice. */
async function sizingBatches(req, { vendorId, search, invoiceId, limit }) {
  const rows = await q(`${SIZING_BATCH_SQL} AND s."vendorId" = :vendorId AND s.status = 'CONFIRMED' ORDER BY s."batchDate" DESC, s."batchNo" DESC`, { companyId: req.user.companyId, vendorId });
  let data = rows.filter((r) => !r.invoiceId || r.invoiceId === invoiceId);
  if (search) {
    const t = search.trim().toLowerCase();
    data = data.filter((r) => String(r.batchNo) === t || [r.setNo, r.yarnCount].some((x) => (x || '').toLowerCase().includes(t)));
  }
  return { data: data.slice(0, limit).map((r) => ({ ...sizingBatchLine(r), canBill: r.amount > 0, blockedReason: r.amount > 0 ? null : 'The batch has no amount' })), total: data.length };
}

/** The lines of a SIZING_BATCH invoice from the chosen batches; every rule about a batch is checked here. */
async function buildSizingBatch(req, vendorId, batchIds, invoiceId, transaction) {
  const ids = [...new Set(batchIds)];
  const rows = await q(`${SIZING_BATCH_SQL} AND s.id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction);
  if (rows.length !== ids.length) throw AppError.notFound('Sizing batch');
  for (const r of rows) {
    const name = `Sizing batch ${label(r.batchNo)}`;
    if (r.status !== 'CONFIRMED') throw AppError.rule('BATCH_NOT_CONFIRMED', `${name} is not confirmed yet`);
    if (r.vendorId !== vendorId) throw AppError.rule('BATCH_OTHER_VENDOR', `${name} belongs to another sizing party; one invoice is for one vendor`);
    if (r.invoiceId && r.invoiceId !== invoiceId) throw AppError.rule('BATCH_TAKEN', `${name} is already on purchase invoice ${label(r.invoiceVoucherNo)}`);
    if (!(r.amount > 0)) throw AppError.rule('NO_AMOUNT', `${name} has no amount, so there is nothing to bill`);
  }
  return rows.sort((a, b) => a.batchNo - b.batchNo).map((r) => ({ ...r, salesTax: 0 }));
}

async function writeSizingBatchLines(invoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM purchase_invoice_sizing_batches WHERE "invoiceId" = :invoiceId', { replacements: { invoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query('INSERT INTO purchase_invoice_sizing_batches ("invoiceId", "companyId", "lineNo", "batchId", amount, "salesTax") VALUES (:invoiceId, :companyId, :lineNo, :batchId, :amount, :salesTax)',
      { replacements: { invoiceId, companyId, lineNo, batchId: l.inwardId, amount: l.amount, salesTax: l.salesTax }, transaction });
  }
}

/** The STORE YARN inward entries (Store > Yarn Inward: yarn bought from a vendor for processing) with what they cost; `invoiceId` is the purchase invoice an entry is already on. */
const STORE_YARN_SQL = `
  SELECT s.id AS "inwardId", s."inwardNo", to_char(s."inwardDate", 'YYYY-MM-DD') AS "inwardDate", s."vendorId", s."dcNo", s."isApproved", s."yarnName", s.brand, s.bags, s."lbsPerBag"::float AS "lbsPerBag",
    s."totalLbs"::float AS lbs, s."ratePerLb"::float AS rate, COALESCE(s.amount, 0)::float AS amount,
    (SELECT pl."invoiceId" FROM purchase_invoice_store_yarn_inwards pl WHERE pl."inwardId" = s.id) AS "invoiceId",
    (SELECT p."voucherNo" FROM purchase_invoice_store_yarn_inwards pl JOIN purchase_invoices p ON p.id = pl."invoiceId" WHERE pl."inwardId" = s.id) AS "invoiceVoucherNo"
  FROM store_yarn_inwards s WHERE s."companyId" = :companyId AND s."deletedAt" IS NULL`;
const storeYarnLine = (r) => ({
  inwardId: r.inwardId, inwardNo: r.inwardNo, inwardLabel: label(r.inwardNo), inwardDate: r.inwardDate, dcNo: r.dcNo, yarnName: r.yarnName, brand: r.brand, title: r.brand ? `${r.yarnName} - ${r.brand}` : r.yarnName,
  bags: r.bags, lbsPerBag: r.lbsPerBag, lbs: r.lbs, ratePerLb: r.rate, amount: r.amount, salesTax: r.salesTax || 0, net: round(r.amount + (r.salesTax || 0), 2),
});

/** GET /purchase-invoices/store-yarn-inwards?vendorId= : the approved yarn inwards of this vendor that can still be put on a store yarn invoice. */
async function storeYarnInwards(req, { vendorId, search, invoiceId, limit }) {
  const rows = await q(`${STORE_YARN_SQL} AND s."vendorId" = :vendorId AND s."isApproved" ORDER BY s."inwardDate" DESC, s."inwardNo" DESC`, { companyId: req.user.companyId, vendorId });
  let data = rows.filter((r) => !r.invoiceId || r.invoiceId === invoiceId);
  if (search) {
    const t = search.trim().toLowerCase();
    data = data.filter((r) => String(r.inwardNo) === t || [r.dcNo, r.yarnName, r.brand].some((x) => (x || '').toLowerCase().includes(t)));
  }
  return { data: data.slice(0, limit).map((r) => ({ ...storeYarnLine(r), canBill: r.amount > 0, blockedReason: r.amount > 0 ? null : 'The yarn inward has no rate: give its rate per lb in the store first' })), total: data.length };
}

/** The lines of a STORE YARN invoice from the chosen yarn inwards; every rule about an entry is checked here. */
async function buildStoreYarn(req, vendorId, inwardIds, invoiceId, transaction) {
  const ids = [...new Set(inwardIds)];
  const rows = await q(`${STORE_YARN_SQL} AND s.id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction);
  if (rows.length !== ids.length) throw AppError.notFound('Yarn inward');
  for (const r of rows) {
    const name = `Yarn inward ${label(r.inwardNo)}`;
    if (!r.isApproved) throw AppError.rule('INWARD_NOT_APPROVED', `${name} is not approved in the store yet`);
    if (r.vendorId !== vendorId) throw AppError.rule('INWARD_OTHER_VENDOR', `${name} belongs to another vendor; one invoice is for one vendor`);
    if (r.invoiceId && r.invoiceId !== invoiceId) throw AppError.rule('INWARD_TAKEN', `${name} is already on purchase invoice ${label(r.invoiceVoucherNo)}`);
    if (!(r.amount > 0)) throw AppError.rule('NO_AMOUNT', `${name} has no amount (no rate), so there is nothing to bill`);
  }
  return rows.sort((a, b) => a.inwardNo - b.inwardNo).map((r) => ({ ...r, salesTax: 0 }));
}

async function writeStoreYarnLines(invoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM purchase_invoice_store_yarn_inwards WHERE "invoiceId" = :invoiceId', { replacements: { invoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query('INSERT INTO purchase_invoice_store_yarn_inwards ("invoiceId", "companyId", "lineNo", "inwardId", amount, "salesTax") VALUES (:invoiceId, :companyId, :lineNo, :inwardId, :amount, :salesTax)',
      { replacements: { invoiceId, companyId, lineNo, inwardId: l.inwardId, amount: l.amount, salesTax: l.salesTax }, transaction });
  }
}

// the five kinds of purchase invoice: STORE (chemical / general store inwards), YARN (weaving yarn inward entries), SIZING (weaving sizing receipts), FABRIC (store fabric inwards),
// STORE_YARN (store yarn inwards: yarn bought from a vendor for processing)
const KIND_OF = (d) => (d.yarnInwardIds ? 'YARN' : d.sizingInwardIds ? 'SIZING' : d.fabricInwardIds ? 'FABRIC' : d.storeYarnInwardIds ? 'STORE_YARN' : d.sizingBatchIds ? 'SIZING_BATCH' : 'STORE');
const IDS_KEY = { STORE: 'inwardIds', YARN: 'yarnInwardIds', SIZING: 'sizingInwardIds', FABRIC: 'fabricInwardIds', STORE_YARN: 'storeYarnInwardIds', SIZING_BATCH: 'sizingBatchIds' };
const KIND_TEXT = { STORE: 'Store', YARN: 'Yarn', SIZING: 'Sizing', FABRIC: 'Fabric', STORE_YARN: 'Store Yarn', SIZING_BATCH: 'Sizing Batch' };
const NARRATION = { STORE: 'Purchase invoice', YARN: 'Yarn purchase invoice', SIZING: 'Sizing purchase invoice', FABRIC: 'Fabric purchase invoice', STORE_YARN: 'Yarn purchase invoice', SIZING_BATCH: 'Sizing batch purchase invoice' };
const EXPENSE_ROLE = { STORE: 'PURCHASES', YARN: 'PURCHASES', SIZING: 'SIZING_CHARGES', FABRIC: 'PURCHASES', STORE_YARN: 'PURCHASES', SIZING_BATCH: 'SIZING_CHARGES' }; // the account the invoice debits
const STORED_IDS_SQL = {
  STORE: 'SELECT "inwardId" FROM purchase_invoice_lines WHERE "invoiceId" = :id',
  YARN: 'SELECT "inwardId" FROM purchase_invoice_yarn_inwards WHERE "invoiceId" = :id',
  SIZING: 'SELECT "inwardId" FROM purchase_invoice_sizing_inwards WHERE "invoiceId" = :id',
  FABRIC: 'SELECT "inwardId" FROM purchase_invoice_fabric_inwards WHERE "invoiceId" = :id',
  STORE_YARN: 'SELECT "inwardId" FROM purchase_invoice_store_yarn_inwards WHERE "invoiceId" = :id',
  SIZING_BATCH: 'SELECT "batchId" AS "inwardId" FROM purchase_invoice_sizing_batches WHERE "invoiceId" = :id',
};
const buildFor = (kind, ...a) => ({ STORE: buildLines, YARN: buildYarn, SIZING: buildSizing, FABRIC: buildFabric, STORE_YARN: buildStoreYarn, SIZING_BATCH: buildSizingBatch })[kind](...a);
const writeFor = (kind, ...a) => ({ STORE: writeLines, YARN: writeYarnLines, SIZING: writeSizingLines, FABRIC: writeFabricLines, STORE_YARN: writeStoreYarnLines, SIZING_BATCH: writeSizingBatchLines })[kind](...a);

/**
 * The tax of the lines (owner 2026-10-28): the sales tax is chosen on the invoice (taxRate %). It is worked out on every purchase that carries no tax of its own
 * (every new store inward); an older inward that still has its own GST keeps it, so a purchase is never taxed twice.
 */
function priced(rows, taxRate) {
  const rate = Number(taxRate) || 0;
  return rows.map((r) => ({ ...r, salesTax: r.salesTax > 0 ? r.salesTax : round((r.amount * rate) / 100, 2) }));
}

// others (owner 2026-10-28): an amount taken off the bill (goods damaged / short), with a note. It is not taxed; it cannot be more than gross + tax.
function totalsOf(lines, othersAmount = 0) {
  const gross = round(lines.reduce((t, l) => t + l.amount, 0), 2);
  const tax = round(lines.reduce((t, l) => t + l.salesTax, 0), 2);
  const others = round(Number(othersAmount) || 0, 2);
  if (others > round(gross + tax, 2)) throw AppError.rule('OTHERS_MORE_THAN_BILL', `Others (${others}) cannot be more than the bill (${round(gross + tax, 2)})`, { others, bill: round(gross + tax, 2) });
  return { gross, tax, others, net: round(gross + tax - others, 2) };
}

async function writeLines(invoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM purchase_invoice_lines WHERE "invoiceId" = :invoiceId', { replacements: { invoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query(`INSERT INTO purchase_invoice_lines ("invoiceId", "companyId", "lineNo", "inwardId", store, amount, "salesTax")
      VALUES (:invoiceId, :companyId, :lineNo, :inwardId, :store, :amount, :salesTax)`,
    { replacements: { ...l, invoiceId, companyId, lineNo }, transaction }); // the inward row has its own "invoiceId": ours must win
  }
}

const COLS = `p.id, p.kind, p."voucherNo", p."billNo", to_char(p."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", to_char(p."dueDate", 'YYYY-MM-DD') AS "storedDue",
  to_char(COALESCE(p."dueDate", p."invoiceDate" + v."creditDays"), 'YYYY-MM-DD') AS "dueDate", p.notes, p."billDetails",
  p."taxRate"::float AS "taxRate", p."othersAmount"::float AS others, p."othersNote", p."grossAmount"::float AS gross, p."taxAmount"::float AS tax, p."netAmount"::float AS net, p."paidAmount"::float AS paid, p.status, p."approvedAt", p."createdAt", p."updatedAt",
  v.id AS "vendorId", v.code AS "vendorCode", v.name AS "vendorName", v.ntn AS "vendorNtn", v.address AS "vendorAddress", v.city AS "vendorCity",
  ((SELECT count(*) FROM purchase_invoice_lines l WHERE l."invoiceId" = p.id) + (SELECT count(*) FROM purchase_invoice_yarn_inwards l WHERE l."invoiceId" = p.id) + (SELECT count(*) FROM purchase_invoice_sizing_inwards l WHERE l."invoiceId" = p.id) + (SELECT count(*) FROM purchase_invoice_fabric_inwards l WHERE l."invoiceId" = p.id) + (SELECT count(*) FROM purchase_invoice_store_yarn_inwards l WHERE l."invoiceId" = p.id) + (SELECT count(*) FROM purchase_invoice_sizing_batches l WHERE l."invoiceId" = p.id))::int AS "inwardCount", ab.name AS "approvedByName"`;
const FROM = `FROM purchase_invoices p JOIN vendors v ON v.id = p."vendorId" LEFT JOIN users ab ON ab.id = p."approvedById"`;

function invoiceJson(r) {
  return {
    id: r.id, kind: r.kind, kindText: KIND_TEXT[r.kind], voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), billNo: r.billNo, invoiceDate: r.invoiceDate, dueDate: r.dueDate,
    isOverdue: r.status === 'APPROVED' && r.net - r.paid > 0 && r.dueDate < today(),
    vendor: { id: r.vendorId, code: r.vendorCode, name: r.vendorName, ntn: r.vendorNtn, address: r.vendorAddress, city: r.vendorCity },
    notes: r.notes, billDetails: r.billDetails, inwardCount: r.inwardCount,
    taxRate: r.taxRate, othersAmount: r.others, othersNote: r.othersNote, othersEffect: 'DEDUCT', gross: r.gross, tax: r.tax, net: r.net, paid: r.paid, balance: round(r.net - r.paid),
    paymentStatus: r.paid <= 0 ? 'UNPAID' : r.paid >= r.net ? 'PAID' : 'PARTIAL',
    status: r.status, statusText: STATUS_TEXT[r.status], approvedAt: r.approvedAt, approvedBy: r.approvedAt ? { name: r.approvedByName } : null,
    canEdit: r.status === 'UNAPPROVED', canDelete: r.status === 'UNAPPROVED', canApprove: r.status === 'UNAPPROVED', canUnapprove: r.status === 'APPROVED' && r.paid === 0,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, lock = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE p.id = :id AND p."companyId" = :companyId${lock ? ' FOR UPDATE OF p' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Purchase invoice');
  return r;
}

async function get(req, id, transaction) {
  const inv = invoiceJson(await load(req, id, transaction));
  inv.creditWarning = await credit.warning(req, 'VENDOR', inv.vendor.id, { status: inv.status, net: inv.net }, transaction); // we owe the vendor more than his credit limit, or null
  if (inv.kind === 'YARN') {
    // the lines of a yarn invoice are yarn inward entries: the amounts are the ones saved on the invoice, the descriptions come from the entry
    const yarn = await q('SELECT "inwardId", "lineNo", amount::float AS amount, "salesTax"::float AS "salesTax" FROM purchase_invoice_yarn_inwards WHERE "invoiceId" = :id ORDER BY "lineNo"', { id }, transaction);
    const live = yarn.length ? await q(`${YARN_SQL} AND y.id IN (:ids)`, { companyId: req.user.companyId, ids: yarn.map((s) => s.inwardId) }, transaction) : [];
    inv.lines = yarn.map((s) => ({ lineNo: s.lineNo, ...yarnLine({ ...(live.find((x) => x.inwardId === s.inwardId) || {}), amount: s.amount, salesTax: s.salesTax }) }));
  } else if (inv.kind === 'SIZING_BATCH') {
    // the lines of a sizing batch invoice are confirmed sizing batches: the amounts are the ones saved on the invoice
    const sb = await q('SELECT "batchId" AS "inwardId", "lineNo", amount::float AS amount, "salesTax"::float AS "salesTax" FROM purchase_invoice_sizing_batches WHERE "invoiceId" = :id ORDER BY "lineNo"', { id }, transaction);
    const live = sb.length ? await q(`${SIZING_BATCH_SQL} AND s.id IN (:ids)`, { companyId: req.user.companyId, ids: sb.map((s) => s.inwardId) }, transaction) : [];
    inv.lines = sb.map((s) => ({ lineNo: s.lineNo, ...sizingBatchLine({ ...(live.find((x) => x.inwardId === s.inwardId) || {}), amount: s.amount, salesTax: s.salesTax }) }));
  } else if (inv.kind === 'STORE_YARN') {
    // the lines of a store yarn invoice are store yarn inwards: the amounts are the ones saved on the invoice
    const sy = await q('SELECT "inwardId", "lineNo", amount::float AS amount, "salesTax"::float AS "salesTax" FROM purchase_invoice_store_yarn_inwards WHERE "invoiceId" = :id ORDER BY "lineNo"', { id }, transaction);
    const live = sy.length ? await q(`${STORE_YARN_SQL} AND s.id IN (:ids)`, { companyId: req.user.companyId, ids: sy.map((s) => s.inwardId) }, transaction) : [];
    inv.lines = sy.map((s) => ({ lineNo: s.lineNo, ...storeYarnLine({ ...(live.find((x) => x.inwardId === s.inwardId) || {}), amount: s.amount, salesTax: s.salesTax }) }));
  } else if (inv.kind === 'FABRIC') {
    // the lines of a fabric invoice are store fabric inwards: the amounts are the ones saved on the invoice
    const fb = await q('SELECT "inwardId", "lineNo", amount::float AS amount, "salesTax"::float AS "salesTax" FROM purchase_invoice_fabric_inwards WHERE "invoiceId" = :id ORDER BY "lineNo"', { id }, transaction);
    const live = fb.length ? await q(`${FABRIC_SQL} AND f.id IN (:ids)`, { companyId: req.user.companyId, ids: fb.map((s) => s.inwardId) }, transaction) : [];
    inv.lines = fb.map((s) => ({ lineNo: s.lineNo, ...fabricLine({ ...(live.find((x) => x.inwardId === s.inwardId) || {}), amount: s.amount, salesTax: s.salesTax }) }));
  } else if (inv.kind === 'SIZING') {
    // the lines of a sizing invoice are sizing receipts: the amounts are the ones saved on the invoice
    const sz = await q('SELECT "inwardId", "lineNo", amount::float AS amount, "salesTax"::float AS "salesTax" FROM purchase_invoice_sizing_inwards WHERE "invoiceId" = :id ORDER BY "lineNo"', { id }, transaction);
    const live = sz.length ? await q(`${SIZING_SQL} AND s.id IN (:ids)`, { companyId: req.user.companyId, ids: sz.map((s) => s.inwardId) }, transaction) : [];
    inv.lines = sz.map((s) => ({ lineNo: s.lineNo, ...sizingLine({ ...(live.find((x) => x.inwardId === s.inwardId) || {}), amount: s.amount, salesTax: s.salesTax }) }));
  } else {
    const stored = await q('SELECT "inwardId", "lineNo", amount::float AS amount, "salesTax"::float AS "salesTax" FROM purchase_invoice_lines WHERE "invoiceId" = :id ORDER BY "lineNo"', { id }, transaction);
    const live = stored.length ? await q(`${INWARD_SQL} AND i.id IN (:ids)`, { companyId: req.user.companyId, ids: stored.map((s) => s.inwardId) }, transaction) : [];
    inv.lines = stored.map((s) => {
      const r = live.find((x) => x.inwardId === s.inwardId) || {};
      // the amounts are the ones saved on the invoice; the descriptions come from the store entry
      return { lineNo: s.lineNo, ...inwardLine({ ...r, amount: s.amount, salesTax: s.salesTax }) };
    });
  }
  // the money paid against the invoice: the confirmed payment vouchers (the "Payments" tab)
  inv.payments = (await q(`SELECT pv.id AS "voucherId", pv."voucherNo", to_char(pv."voucherDate", 'YYYY-MM-DD') AS "voucherDate", pv."paymentMode", pv."chequeNo", l.amount::float AS amount
    FROM payment_voucher_lines l JOIN payment_vouchers pv ON pv.id = l."voucherId" WHERE l."purchaseInvoiceId" = :id AND pv.status = 'CONFIRMED' ORDER BY pv."voucherDate", pv."voucherNo"`, { id }, transaction))
    .map((p) => ({ ...p, voucherType: 'PAYMENT', voucherLabel: label(p.voucherNo) }));
  // money settled by a contra voucher (a customer pays this vendor's bill directly) is also a payment of the bill
  const contra = (await q(`SELECT cv.id AS "voucherId", cv."voucherNo", to_char(cv."voucherDate", 'YYYY-MM-DD') AS "voucherDate", 'CONTRA' AS "paymentMode", NULL AS "chequeNo", l.amount::float AS amount
    FROM contra_voucher_lines l JOIN contra_vouchers cv ON cv.id = l."voucherId" WHERE l."purchaseInvoiceId" = :id AND cv.status = 'CONFIRMED'`, { id }, transaction))
    .map((p) => ({ ...p, voucherType: 'CONTRA', voucherLabel: label(p.voucherNo) }));
  inv.payments = [...inv.payments, ...contra].sort((a, b) => (a.voucherDate < b.voucherDate ? -1 : a.voucherDate > b.voucherDate ? 1 : a.voucherNo - b.voucherNo));
  return inv;
}

function options() {
  return { statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), stores: Object.entries(STORE_TEXT).map(([code, text]) => ({ code, text })), taxRates: [0, 5, 10, 15, 17, 18], defaultTaxRate: 0 };
}

async function list(req, { page, limit, status, kind, dateFrom, dateTo, vendorId, search }) {
  const where = ['p."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('p.status = :status'); r.status = status; }
  if (kind) { where.push('p.kind = :kind'); r.kind = kind; }
  if (dateFrom) { where.push('p."invoiceDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('p."invoiceDate" <= :dateTo'); r.dateTo = dateTo; }
  if (vendorId) { where.push('p."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR p."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(v.name ILIKE :like OR v.ntn ILIKE :like OR p."billNo" ILIKE :like OR p."billDetails" ILIKE :like OR p.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS invoices, COALESCE(SUM(p."grossAmount"), 0)::float AS amount, COALESCE(SUM(p."taxAmount"), 0)::float AS tax,
      COALESCE(SUM(p."netAmount"), 0)::float AS net, COALESCE(SUM(p."paidAmount"), 0)::float AS paid FROM purchase_invoices p JOIN vendors v ON v.id = p."vendorId" WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY p."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return {
    data: rows.map(invoiceJson), page, limit, total: sum.invoices,
    summary: { invoices: sum.invoices, amount: round(sum.amount), tax: round(sum.tax), net: round(sum.net), paid: round(sum.paid), balance: round(sum.net - sum.paid) },
  };
}

async function vendorOr404(req, vendorId, transaction) {
  const [v] = await q('SELECT id, name FROM vendors WHERE id = :id AND "companyId" = :companyId', { id: vendorId, companyId: req.user.companyId }, transaction);
  if (!v) throw AppError.notFound('Vendor');
  return v;
}

async function checkBillNo(companyId, vendorId, billNo, exceptId, transaction) {
  if (!billNo) return;
  const [dup] = await q(`SELECT "voucherNo" FROM purchase_invoices WHERE "companyId" = :companyId AND "vendorId" = :vendorId AND lower("billNo") = lower(:billNo) AND id <> :exceptId`,
    { companyId, vendorId, billNo, exceptId: exceptId || '00000000-0000-0000-0000-000000000000' }, transaction);
  if (dup) throw AppError.rule('BILL_NO_TAKEN', `This vendor's bill ${billNo} is already entered (purchase invoice ${label(dup.voucherNo)})`);
}

const nextVoucherNo = async (companyId, transaction) => ((await q('SELECT MAX("voucherNo") AS m FROM purchase_invoices WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    await vendorOr404(req, data.vendorId, transaction);
    const taxRate = data.taxRate ?? 0;
    const kind = KIND_OF(data); // STORE: store inwards, YARN: weaving yarn inward entries, SIZING: weaving sizing receipts
    const lines = priced(await buildFor(kind, req, data.vendorId, data[IDS_KEY[kind]], null, transaction), taxRate);
    const totals = totalsOf(lines, data.othersAmount);
    const billNo = data.billNo ? data.billNo.trim() : null;
    await checkBillNo(companyId, data.vendorId, billNo, null, transaction);
    const invoiceDate = data.invoiceDate || today();
    const dueDate = data.dueDate || (await credit.defaultDueDate(companyId, 'VENDOR', data.vendorId, invoiceDate, transaction));
    if (dueDate && dueDate < invoiceDate) throw AppError.rule('DUE_BEFORE_DATE', 'The due date cannot be before the invoice date');
    const voucherNo = await nextVoucherNo(companyId, transaction);
    // the three default accounts exist from the first invoice on (found if the company has them, made if not); a draft posts nothing to them
    await accounts.ensureDefault(req, EXPENSE_ROLE[kind], transaction);
    await accounts.ensureDefault(req, 'INPUT_TAX', transaction);
    await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    const [{ id: newId }] = await q(`INSERT INTO purchase_invoices ("companyId", kind, "voucherNo", "invoiceDate", "dueDate", "vendorId", "billNo", notes, "billDetails", "taxRate", "othersAmount", "othersNote", "grossAmount", "taxAmount", "netAmount", "createdById", "updatedById")
      VALUES (:companyId, :kind, :voucherNo, :invoiceDate, :dueDate, :vendorId, :billNo, :notes, :billDetails, :taxRate, :others, :othersNote, :gross, :tax, :net, :userId, :userId) RETURNING id`,
    { companyId, kind, voucherNo, invoiceDate, dueDate, vendorId: data.vendorId, billNo, notes: data.notes || null, billDetails: data.billDetails || null, taxRate, othersNote: data.othersNote || null, ...totals, userId: req.user.id }, transaction);
    await writeFor(kind, newId, companyId, lines, transaction);
    await audit.log(req, { action: 'PURCHASE_INVOICE_CREATED', entityType: 'PurchaseInvoice', entityId: newId, after: { voucherNo, billNo, vendorId: data.vendorId, inwards: lines.length, ...totals } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('INVOICE_APPROVED', 'An approved invoice cannot be changed. Un-approve it first');
    const kind = cur.kind;
    if (['STORE', 'YARN', 'SIZING', 'FABRIC', 'STORE_YARN', 'SIZING_BATCH'].some((k) => k !== kind && changes[IDS_KEY[k]])) throw AppError.rule('WRONG_INVOICE_KIND', `This is a ${KIND_TEXT[kind].toLowerCase()} invoice: it is made of ${{ STORE: 'store purchases', YARN: 'yarn inward entries', SIZING: 'sizing receipts', FABRIC: 'fabric inwards', STORE_YARN: 'store yarn inwards', SIZING_BATCH: 'sizing batches' }[kind]}, not of the other kind`);
    const vendorId = changes.vendorId ?? cur.vendorId;
    const newIds = changes[IDS_KEY[kind]];
    if (changes.vendorId && changes.vendorId !== cur.vendorId) {
      await vendorOr404(req, vendorId, transaction);
      if (!newIds) throw AppError.rule('INWARDS_REQUIRED', 'The vendor changed: choose the purchases of the new vendor');
    }
    const ids = newIds || (await q(STORED_IDS_SQL[kind], { id }, transaction)).map((l) => l.inwardId);
    const taxRate = changes.taxRate ?? cur.taxRate;
    const lines = priced(await buildFor(kind, req, vendorId, ids, id, transaction), taxRate);
    const totals = totalsOf(lines, changes.othersAmount ?? cur.others);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    const billNo = changes.billNo === undefined ? cur.billNo : (changes.billNo ? changes.billNo.trim() : null);
    await checkBillNo(companyId, vendorId, billNo, id, transaction);
    const invoiceDate = changes.invoiceDate || cur.invoiceDate;
    // a typed due date wins; an empty one (or a new date / vendor without one) is worked out again from the vendor's credit days; otherwise it stays
    const redo = changes.dueDate === undefined ? Boolean(changes.invoiceDate || changes.vendorId) : !changes.dueDate;
    const dueDate = changes.dueDate || (redo ? await credit.defaultDueDate(companyId, 'VENDOR', vendorId, invoiceDate, transaction) : cur.storedDue);
    if (dueDate && dueDate < invoiceDate) throw AppError.rule('DUE_BEFORE_DATE', 'The due date cannot be before the invoice date');
    await writeFor(kind, id, companyId, lines, transaction);
    await sequelize.query(`UPDATE purchase_invoices SET "vendorId" = :vendorId, "billNo" = :billNo, "invoiceDate" = :invoiceDate, "dueDate" = :dueDate, notes = :notes, "billDetails" = :billDetails, "taxRate" = :taxRate, "othersAmount" = :others, "othersNote" = :othersNote,
        "grossAmount" = :gross, "taxAmount" = :tax, "netAmount" = :net, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, vendorId, billNo, invoiceDate, dueDate, notes: pick('notes', cur.notes), billDetails: pick('billDetails', cur.billDetails), taxRate, othersNote: pick('othersNote', cur.othersNote), ...totals, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PURCHASE_INVOICE_UPDATED', entityType: 'PurchaseInvoice', entityId: id, before: { gross: cur.gross, tax: cur.tax, net: cur.net, billNo: cur.billNo }, after: { billNo, inwards: lines.length, ...totals } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('INVOICE_APPROVED', 'An approved invoice cannot be deleted. Un-approve it first');
    await sequelize.query('DELETE FROM purchase_invoices WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'PURCHASE_INVOICE_DELETED', entityType: 'PurchaseInvoice', entityId: id, before: { voucherNo: cur.voucherNo, billNo: cur.billNo, net: cur.net } }, { transaction });
  });
}

/** Posts the accounting entry: Debit Purchases and Input Sales Tax, Credit Accounts Payable (the vendor named on the line). */
async function approve(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('ALREADY_APPROVED', 'This invoice is already approved');
    const kind = cur.kind;
    const ids = (await q(STORED_IDS_SQL[kind], { id }, transaction)).map((l) => l.inwardId);
    if (!ids.length) throw AppError.rule('NO_LINES', 'The invoice has no purchases');
    const lines = priced(await buildFor(kind, req, cur.vendorId, ids, id, transaction), cur.taxRate);
    const totals = totalsOf(lines, cur.others);
    if (!(totals.net > 0)) throw AppError.rule('NOTHING_TO_BILL', 'The invoice amount is zero');
    await writeFor(kind, id, companyId, lines, transaction);

    const purchases = await accounts.ensureDefault(req, EXPENSE_ROLE[kind], transaction);
    const payable = await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    const taxAccount = totals.tax > 0 ? await accounts.ensureDefault(req, 'INPUT_TAX', transaction) : null;
    const narration = `${NARRATION[kind]} ${label(cur.voucherNo)} - ${cur.vendorName}${cur.billNo ? ` (bill ${cur.billNo})` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.invoiceDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [
        { accountId: purchases, debit: totals.gross, narration },
        // an amount taken off the bill (goods damaged / short): credited to the purchases account on its own line, with the reason
        ...(totals.others > 0 ? [{ accountId: purchases, credit: totals.others, narration: `${narration}: others${cur.othersNote ? ` - ${cur.othersNote}` : ''}` }] : []),
        ...(taxAccount ? [{ accountId: taxAccount, debit: totals.tax, narration: `${narration} (sales tax)` }] : []),
        { accountId: payable, credit: totals.net, partyType: 'VENDOR', partyId: cur.vendorId, narration },
      ],
    }, transaction);
    await sequelize.query(`UPDATE purchase_invoices SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = :userId, "grossAmount" = :gross, "taxAmount" = :tax, "netAmount" = :net,
      "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id, ...totals }, transaction });
    await audit.log(req, { action: 'PURCHASE_INVOICE_APPROVED', entityType: 'PurchaseInvoice', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, ...totals } }, { transaction });
  });
  return get(req, id);
}

/** Takes the invoice back to un-approved: the entry is reversed (both stay in the books) and the invoice may be changed again. */
async function unapprove(req, id, { reason } = {}) {
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'APPROVED') throw AppError.rule('NOT_APPROVED', 'This invoice is not approved');
    if (cur.paid > 0) throw AppError.rule('HAS_PAYMENTS', 'Money was paid against this invoice; it cannot be un-approved');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`,
      { companyId: req.user.companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this invoice was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `purchase invoice ${label(cur.voucherNo)} un-approved` }, transaction); // dated like the entry it reverses
    await sequelize.query(`UPDATE purchase_invoices SET status = 'UNAPPROVED', "approvedAt" = NULL, "approvedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PURCHASE_INVOICE_UNAPPROVED', entityType: 'PurchaseInvoice', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

/** The "Accounts" button: the entries of the invoice. `current` is the live posting (null while un-approved). */
async function accountsEntry(req, id) {
  const inv = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { invoiceId: id, invoiceLabel: label(inv.voucherNo), status: inv.status, posted: Boolean(current), current, entries };
}

const creditOf = (req, vendorId) => credit.publicStatus(req, 'VENDOR', vendorId);

module.exports = { creditOf, options, inwards, yarnInwards, sizingInwards, fabricInwards, storeYarnInwards, sizingBatches, list, get, create, update, remove, approve, unapprove, accountsEntry };
