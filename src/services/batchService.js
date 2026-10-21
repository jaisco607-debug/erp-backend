// Stock by batch (owner 2026-10-19). Every approved purchase line is a batch with its own rate
// (sulphur 20 kg at 40 + 100 kg at 45 = 120 kg, average 44.17). store_items.stockQty / stockValue
// stay the totals of the batches. Stock goes out batch by batch: the batches the store picks, or the
// oldest first. Each Job / SO card then costs the real rate of each batch it got.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const m = require('./storeMasterService');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const SOURCE_TEXT = { OPENING: 'Old stock', INWARD: 'Purchase', RETURN: 'Returned by department', ADJUST: 'Stock adjustment' };

/** New batch; the caller has already changed the item totals. */
async function add(transaction, { companyId, store, itemId, source, qty, rate, value, inDate, inwardId, inwardLineId, vendorId, returnId, adjustmentId }) {
  const [b] = await q(`
    INSERT INTO store_batches ("companyId", store, "itemId", source, "inwardId", "inwardLineId", "vendorId", "returnId", "adjustmentId", "inDate", rate, "qtyIn", "qtyLeft", "valueLeft")
    VALUES (:companyId, :store, :itemId, :source, :inwardId, :inwardLineId, :vendorId, :returnId, :adjustmentId, :inDate, :rate, :qty, :qty, :value) RETURNING id`,
  { companyId, store, itemId, source, inwardId: inwardId || null, inwardLineId: inwardLineId || null, vendorId: vendorId || null, returnId: returnId || null,
    adjustmentId: adjustmentId || null, inDate: inDate || today(), rate: m.round(rate || 0, 4), qty, value: m.round(value, 2) }, transaction);
  return b.id;
}

/** Puts qty back into a batch (a department returned it). */
async function putBack(transaction, batchId, qty, value) {
  await sequelize.query(`UPDATE store_batches SET "qtyLeft" = "qtyLeft" + :qty, "valueLeft" = "valueLeft" + :value WHERE id = :batchId`,
    { replacements: { batchId, qty, value: m.round(value, 2) }, transaction });
}

/**
 * Takes qty of an item out of its batches. picks = [{ batchId, qty }] chosen by the store, or
 * none = oldest first. Returns [{ batchId, qty, rate, value }]. The caller changes the item totals.
 */
async function take(transaction, item, qty, picks) {
  const batches = await q(`SELECT id, rate::float, "qtyLeft"::float AS "qtyLeft", "valueLeft"::float AS "valueLeft" FROM store_batches
    WHERE "itemId" = :itemId AND "qtyLeft" > 0 ORDER BY "inDate", "createdAt" FOR UPDATE`, { itemId: item.id }, transaction);
  const byId = new Map(batches.map((b) => [b.id, b]));
  let want;
  if (picks && picks.length) {
    want = picks.filter((p) => p.qty > 0).map((p) => {
      const b = byId.get(p.batchId);
      if (!b) throw AppError.rule('UNKNOWN_BATCH', `${item.name}: this batch is not in stock`, { batchId: p.batchId });
      if (p.qty > b.qtyLeft + 1e-9) throw AppError.rule('BATCH_SHORT', `${item.name}: the batch at Rs ${b.rate} has only ${m.splitQty(b.qtyLeft, item.unit).text}`, { batchId: b.id, qtyLeft: b.qtyLeft });
      return { b, qty: p.qty };
    });
    if (new Set(want.map((w) => w.b.id)).size !== want.length) throw AppError.rule('DUPLICATE_BATCH', `${item.name}: a batch is given twice`);
  } else {
    want = [];
    let left = qty;
    for (const b of batches) {
      if (left <= 1e-9) break;
      const n = m.round(Math.min(left, b.qtyLeft), 3);
      want.push({ b, qty: n });
      left = m.round(left - n, 3);
    }
    if (left > 1e-9) throw AppError.rule('NOT_ENOUGH_STOCK', `Not enough ${item.name}: ${m.splitQty(item.stockQty, item.unit).text} in stock`);
  }
  const out = [];
  for (const { b, qty: n } of want) {
    const all = Math.abs(n - b.qtyLeft) < 1e-9;
    const value = all ? m.round(b.valueLeft, 2) : m.round(n * b.rate, 2);
    await sequelize.query(`UPDATE store_batches SET "qtyLeft" = :ql, "valueLeft" = :vl WHERE id = :id`,
      { replacements: { id: b.id, ql: all ? 0 : m.round(b.qtyLeft - n, 3), vl: all ? 0 : Math.max(0, m.round(b.valueLeft - value, 2)) }, transaction });
    out.push({ batchId: b.id, qty: n, rate: b.rate, value });
  }
  return out;
}

/** Batches of items still in stock, oldest first: { itemId: [batch] }. */
async function inStock(itemIds, transaction) {
  const map = new Map(itemIds.map((id) => [id, []]));
  if (!itemIds.length) return map;
  const rows = await q(`
    SELECT b.*, b.rate::float AS rate, b."qtyIn"::float AS "qtyIn", b."qtyLeft"::float AS "qtyLeft", b."valueLeft"::float AS "valueLeft",
           v.name AS "vendorName", i."ipNo", i."dcNo", it.unit
    FROM store_batches b JOIN store_items it ON it.id = b."itemId"
    LEFT JOIN vendors v ON v.id = b."vendorId" LEFT JOIN store_inwards i ON i.id = b."inwardId"
    WHERE b."itemId" IN (:itemIds) AND b."qtyLeft" > 0 ORDER BY b."inDate", b."createdAt"`, { itemIds }, transaction);
  for (const r of rows) map.get(r.itemId).push(json(r));
  return map;
}

function json(r) {
  return {
    batchId: r.id, source: r.source, sourceText: SOURCE_TEXT[r.source], inDate: r.inDate,
    vendor: r.vendorId ? { id: r.vendorId, name: r.vendorName } : null, ipNo: r.ipNo || null, dcNo: r.dcNo || null,
    rate: r.rate, qtyIn: r.qtyIn, qtyLeft: r.qtyLeft, qtyLeftSplit: m.splitQty(r.qtyLeft, r.unit), valueLeft: r.valueLeft,
    // e.g. "100 KG @ Rs 45 (ABC Chemicals, 19 Oct)"
    label: `${m.splitQty(r.qtyLeft, r.unit).text} @ Rs ${r.rate}${r.vendorName ? ` (${r.vendorName})` : ''}`,
  };
}

/** What the batches of an item hold: total, average and each batch. */
async function summary(item, transaction) {
  const batches = (await inStock([item.id], transaction)).get(item.id);
  return {
    totalQty: item.stockQty, totalSplit: m.splitQty(item.stockQty, item.unit), totalValue: item.stockValue, avgRate: m.avgRate(item),
    batchCount: batches.length, batches,
  };
}

/** Record which batches a request line was sent from. */
async function recordIssue(transaction, { companyId, requestId, requestLineId, itemId }, parts) {
  for (const p of parts) {
    await sequelize.query(`INSERT INTO chemical_issue_batches ("companyId", "requestId", "requestLineId", "batchId", "itemId", qty, rate, value)
      VALUES (:companyId, :requestId, :requestLineId, :batchId, :itemId, :qty, :rate, :value)`,
    { replacements: { companyId, requestId, requestLineId, itemId, ...p }, transaction });
  }
}

/** Issue parts of request lines: { lineId: [{ batchId, inDate, vendor, rate, qty, value, returnedQty }] }. */
async function issuesOf(lineIds, transaction) {
  const map = new Map();
  if (!lineIds.length) return map;
  const rows = await q(`
    SELECT x.id, x."requestLineId", x."batchId", x.qty::float AS qty, x.rate::float AS rate, x.value::float AS value, x."returnedQty"::float AS "returnedQty",
           b."inDate", b.source, v.id AS "vendorId", v.name AS "vendorName", i."ipNo", it.unit
    FROM chemical_issue_batches x JOIN store_batches b ON b.id = x."batchId" JOIN store_items it ON it.id = x."itemId"
    LEFT JOIN vendors v ON v.id = b."vendorId" LEFT JOIN store_inwards i ON i.id = b."inwardId"
    WHERE x."requestLineId" IN (:lineIds) ORDER BY b."inDate", b."createdAt"`, { lineIds }, transaction);
  for (const r of rows) {
    if (!map.has(r.requestLineId)) map.set(r.requestLineId, []);
    map.get(r.requestLineId).push({
      issueId: r.id, batchId: r.batchId, inDate: r.inDate, sourceText: SOURCE_TEXT[r.source], ipNo: r.ipNo,
      vendor: r.vendorId ? { id: r.vendorId, name: r.vendorName } : null,
      qty: r.qty, qtySplit: m.splitQty(r.qty, r.unit), rate: r.rate, value: r.value, returnedQty: r.returnedQty,
    });
  }
  return map;
}

/**
 * A returned qty of a request line goes back to the batches it came from (newest issue first),
 * at their rates. Returns the value that came back.
 */
async function returnLine(transaction, requestLineId, qty) {
  const parts = await q(`SELECT x.id, x."batchId", x.rate::float AS rate, x.qty::float AS qty, x.value::float AS value, x."returnedQty"::float AS "returnedQty"
    FROM chemical_issue_batches x JOIN store_batches b ON b.id = x."batchId"
    WHERE x."requestLineId" = :requestLineId ORDER BY b."inDate" DESC, b."createdAt" DESC FOR UPDATE OF x`, { requestLineId }, transaction);
  if (!parts.length) return null; // sent before batches existed: the caller uses the line rate
  let left = qty; let value = 0;
  for (const p of parts) {
    if (left <= 1e-9) break;
    const n = m.round(Math.min(left, p.qty - p.returnedQty), 3);
    if (n <= 0) continue;
    const v = m.round(n * p.rate, 2);
    await sequelize.query(`UPDATE chemical_issue_batches SET "returnedQty" = "returnedQty" + :n WHERE id = :id`, { replacements: { id: p.id, n }, transaction });
    await putBack(transaction, p.batchId, n, v);
    value = m.round(value + v, 2);
    left = m.round(left - n, 3);
  }
  return value;
}

/**
 * Where a batch (or every batch of an item) went: department, request, Job#, SO#, lots, thaans, meters.
 */
async function usage(where, replacements, transaction) {
  const rows = await q(`
    SELECT x.id, x."batchId", x.qty::float AS qty, x.rate::float AS rate, x.value::float AS value, x."returnedQty"::float AS "returnedQty",
           r.id AS "requestId", r."reqNo", r."sentAt", r."jobId", r."soCardId", s.name AS department, s.code AS "departmentCode",
           j."jobNo", it.unit, b."inDate", b.rate::float AS "batchRate"
    FROM chemical_issue_batches x
    JOIN chemical_requests r ON r.id = x."requestId"
    JOIN services s ON s.id = r."departmentId"
    JOIN store_items it ON it.id = x."itemId"
    JOIN store_batches b ON b.id = x."batchId"
    LEFT JOIN jobs j ON j.id = r."jobId"
    WHERE ${where} ORDER BY r."sentAt" DESC`, replacements, transaction);
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter(Boolean))];
  const cloth = jobIds.length ? await q(`
    SELECT ji."jobId", ji."soCardId", sc."cardNo", sc."isGreyReturn", gl."lotNo", ji.meters::float AS meters,
           (SELECT count(*)::int FROM so_card_lot_thaans p WHERE p."soCardLotId" = scl.id) AS thaans
    FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId"
    WHERE ji."jobId" IN (:jobIds)`, { jobIds }, transaction) : [];
  return rows.map((r) => {
    const mine = cloth.filter((c) => c.jobId === r.jobId && (!r.soCardId || c.soCardId === r.soCardId));
    return {
      issueId: r.id, batchId: r.batchId, batchDate: r.inDate, batchRate: r.batchRate,
      date: r.sentAt, department: { code: r.departmentCode, name: r.department },
      request: { id: r.requestId, reqNo: r.reqNo }, jobNo: r.jobNo,
      soNos: [...new Set(mine.map((c) => c.cardNo))].sort((a, b) => a - b),
      soLabels: [...new Map(mine.map((c) => [`${c.isGreyReturn}${c.cardNo}`, c])).values()].sort((a, b) => a.cardNo - b.cardNo).map((c) => (c.isGreyReturn ? `FR-${c.cardNo}` : String(c.cardNo))),
      lotNos: [...new Set(mine.map((c) => c.lotNo))].sort((a, b) => a - b),
      thaans: mine.reduce((t, c) => t + c.thaans, 0),
      meters: m.round(mine.reduce((t, c) => t + c.meters, 0), 2),
      qty: r.qty, qtySplit: m.splitQty(r.qty, r.unit), returnedQty: r.returnedQty, netQty: m.round(r.qty - r.returnedQty, 3),
      rate: r.rate, value: r.value, netValue: m.round((r.qty - r.returnedQty) * r.rate, 2),
    };
  });
}

/** The last purchases of an item (newest first), for the inward screen. */
async function lastInwards(itemId, limit, transaction) {
  const rows = await q(`
    SELECT i.id AS "inwardId", i."ipNo", i."idNo", i."inwardDate", i."dcNo", v.id AS "vendorId", v.name AS "vendorName",
           l.qty::float AS qty, l.rate::float AS rate, l.amount::float AS amount, it.unit
    FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" AND i."isApproved" JOIN store_items it ON it.id = l."itemId"
    LEFT JOIN vendors v ON v.id = i."vendorId"
    WHERE l."itemId" = :itemId ORDER BY i."inwardDate" DESC, i."approvedAt" DESC LIMIT :limit`, { itemId, limit }, transaction);
  return rows.map((r) => ({
    inwardId: r.inwardId, ipNo: r.ipNo, idText: String(r.idNo).padStart(5, '0'), date: r.inwardDate, dcNo: r.dcNo,
    vendor: r.vendorId ? { id: r.vendorId, name: r.vendorName } : null,
    qty: r.qty, qtySplit: m.splitQty(r.qty, r.unit), rate: r.rate, amount: r.amount,
  }));
}

module.exports = { add, take, putBack, inStock, summary, recordIssue, issuesOf, returnLine, usage, lastInwards, SOURCE_TEXT };
