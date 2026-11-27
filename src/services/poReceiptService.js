// Goods received against a purchase order (owner plan N-D1): the ONE place the store inwards ask when a line names a PO line.
// A purchase without a PO never comes here (the callers return before any query), so the store works exactly as before.
// What is received is NOT stored anywhere: it is the sum of the inwards that point to the PO line, so an edit, a delete, an un-approve or a correction can never leave a wrong counter.
// Rules:
//   - the PO is of this store, of the same vendor, and the line is the same chemical / item / yarn / quality
//   - only an APPROVED order can be received (a draft, closed or cancelled one cannot; an inward already on a closed order may be corrected but not grown)
//   - everything received on a line (drafts included) may exceed the ordered quantity only by the company's tolerance (standard 5 %)
//   - the rate comes from the order when none is typed; a different rate needs a note
//   - the PO and its lines are locked (order first, then lines, by id), so two receipts at the same moment cannot both use the last quantity
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: 'SELECT', transaction });
const r3 = (x) => Math.round((x + Number.EPSILON) * 1000) / 1000;
const YARD = 0.9144;
const NONE = '00000000-0000-0000-0000-000000000000';
const label = (n) => `PO-${String(n).padStart(5, '0')}`;
const squeeze = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function toleranceOf(companyId, transaction) {
  const [r] = await q('SELECT "tolerancePercent"::float AS t FROM po_settings WHERE "companyId" = :companyId', { companyId }, transaction);
  return r ? r.t : 5;
}

const LINE_SQL = `SELECT l.id, l."orderId", l."itemId", l."yarnName", l.brand, l."qualityId", l.unit, l.qty::float AS qty, l.rate::float AS rate, o."poNo", o.store, o.status, o."vendorId",
    v.name AS "vendorName", it.name AS "itemName", qu.name AS "qualityName"
  FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l."orderId" AND o."deletedAt" IS NULL JOIN vendors v ON v.id = o."vendorId"
  LEFT JOIN store_items it ON it.id = l."itemId" LEFT JOIN qualities qu ON qu.id = l."qualityId"
  WHERE l."companyId" = :companyId AND l.id IN (:ids)`;

/** The PO lines with their order, locked inside the caller's transaction: the orders first, then the lines, both by id. */
async function lockedLines(companyId, ids, transaction) {
  const wanted = [...new Set(ids)];
  await q(`SELECT id FROM purchase_orders WHERE "companyId" = :companyId AND id IN (SELECT "orderId" FROM purchase_order_lines WHERE "companyId" = :companyId AND id IN (:ids)) ORDER BY id FOR UPDATE`, { companyId, ids: wanted }, transaction);
  await q('SELECT id FROM purchase_order_lines WHERE "companyId" = :companyId AND id IN (:ids) ORDER BY id FOR UPDATE', { companyId, ids: wanted }, transaction);
  const rows = await q(LINE_SQL, { companyId, ids: wanted }, transaction);
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * What has been received on these PO lines, in the unit of the line: Map poLineId -> { all, approved }.
 * `except` leaves one inward out (the one being saved again).
 */
async function receivedOf(lineIds, { transaction, except } = {}) {
  const out = new Map(lineIds.map((id) => [id, { all: 0, approved: 0 }]));
  if (!lineIds.length) return out;
  const rows = await q(`
    SELECT x.id, SUM(x.qty)::float AS "all", COALESCE(SUM(x.qty) FILTER (WHERE x.approved), 0)::float AS approved FROM (
      SELECT l."poLineId" AS id, l.qty, i."isApproved" AS approved FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" WHERE l."poLineId" IN (:ids) AND i.id <> :except
      UNION ALL
      SELECT y."poLineId", y."totalLbs", y."isApproved" FROM store_yarn_inwards y WHERE y."poLineId" IN (:ids) AND y."deletedAt" IS NULL AND y.id <> :except
      UNION ALL
      SELECT f."poLineId", CASE WHEN pl.unit = 'YARD' THEN f."inwardYards" ELSE f."inwardMeters" END, f."isApproved" FROM fabric_inwards f JOIN purchase_order_lines pl ON pl.id = f."poLineId"
        WHERE f."poLineId" IN (:ids) AND f."deletedAt" IS NULL AND f.id <> :except
    ) x GROUP BY x.id`, { ids: lineIds, except: except || NONE }, transaction);
  for (const r of rows) out.set(r.id, { all: r3(r.all), approved: r3(r.approved) });
  return out;
}

const notOpen = (po) => AppError.rule('PO_NOT_OPEN', po.status === 'DRAFT' ? `${label(po.poNo)} is not approved yet` : `${label(po.poNo)} is ${po.status.toLowerCase()}: goods cannot be received on it`, { poNo: po.poNo, status: po.status });

/** The order, store and vendor of one receipt line. */
function assertHeader(po, { store, vendorId }) {
  if (!po) throw AppError.rule('PO_LINE_NOT_FOUND', 'The purchase order line was not found', { field: 'poLineId' });
  if (po.store !== store) throw AppError.rule('PO_WRONG_STORE', `${label(po.poNo)} is an order of the ${po.store.toLowerCase()} store`, { field: 'poLineId' });
  if (!vendorId || po.vendorId !== vendorId) throw AppError.rule('PO_VENDOR_MISMATCH', `${label(po.poNo)} was ordered from ${po.vendorName}: the purchase must be from that vendor`, { field: 'vendorId', vendorId: po.vendorId });
}

/** Quantity: status and tolerance, with everything of this entry on the same line added up. `before` is what THIS entry already had on the line. */
async function assertQuantities(companyId, byLine, lines, { before = new Map(), except, transaction }) {
  const received = await receivedOf([...byLine.keys()], { transaction, except });
  const tolerance = await toleranceOf(companyId, transaction);
  for (const [lineId, qty] of byLine) {
    const po = lines.get(lineId);
    const had = before.get(lineId) || 0;
    if (po.status !== 'APPROVED' && !(had > 0 && qty <= had + 1e-6 && po.status === 'CLOSED')) throw notOpen(po);
    const max = r3(po.qty * (1 + tolerance / 100));
    const elsewhere = received.get(lineId).all;
    if (elsewhere + qty > max + 1e-6 && !(had > 0 && qty <= had + 1e-6)) {
      const what = po.itemName || po.yarnName || po.qualityName || 'this line';
      throw AppError.rule('PO_OVER_RECEIVED', `${label(po.poNo)}: ${what} was ordered ${po.qty} ${po.unit}; ${elsewhere} ${po.unit} already received, at most ${r3(Math.max(0, max - elsewhere))} ${po.unit} more (tolerance ${tolerance} %)`,
        { poNo: po.poNo, poLineId: lineId, ordered: po.qty, received: elsewhere, max, canReceive: r3(Math.max(0, max - elsewhere)), tolerancePercent: tolerance, trying: r3(qty), unit: po.unit });
    }
  }
}

/** A rate that is not the order's needs a note (it shows in the price difference report). */
function assertRate(po, rate, note, field, poRate = po.rate) {
  if (rate === null || rate === undefined) return null;
  if (Math.abs(rate - poRate) <= 0.00005) return null;
  if (!note || !String(note).trim()) {
    throw AppError.rule('PO_RATE_NOTE_REQUIRED', `${label(po.poNo)}: the rate ${rate} is not the order's rate ${Math.round(poRate * 10000) / 10000}; write why in the note`, { field, poRate: Math.round(poRate * 10000) / 10000, rate });
  }
  return String(note).trim().slice(0, 300);
}

/**
 * Chemical / General store inward. `input` are the lines as sent, `lines` the prepared lines (same order; they are completed here with poLineId, poRateNote and the rate of the order).
 * `oldLines` are the lines the entry has now (empty for a new one): a line sent without `poLineId` keeps the order it was on; `poLineId: null` takes it off.
 */
async function storeLines(req, store, { vendorId, input, lines, oldLines = [], inwardId }, transaction) {
  const { companyId } = req.user;
  const oldById = new Map(oldLines.map((l) => [l.id, l]));
  const oldWithPo = oldLines.filter((l) => l.poLineId);
  const used = new Set();
  lines.forEach((line, i) => {
    const sent = input[i] || {};
    let poLineId = sent.poLineId === '' ? null : sent.poLineId;
    let note = sent.poRateNote;
    if (sent.poLineId === undefined) {
      const same = (sent.lineId && oldById.get(sent.lineId)) || oldWithPo.find((o) => o.itemId === line.itemId && !used.has(o.id) && oldWithPo.filter((x) => x.itemId === line.itemId).length === 1);
      if (same && same.poLineId && same.itemId === line.itemId) { used.add(same.id); poLineId = same.poLineId; if (note === undefined) note = same.poRateNote; }
    }
    line.poLineId = poLineId || null;
    line.poRateNote = note || null;
  });
  const ids = lines.map((l) => l.poLineId).filter(Boolean);
  if (!ids.length) { lines.forEach((l) => { l.poRateNote = null; }); return; }
  const po = await lockedLines(companyId, ids, transaction);
  const before = new Map();
  for (const o of oldWithPo) before.set(o.poLineId, r3((before.get(o.poLineId) || 0) + Number(o.qty)));
  const byLine = new Map();
  lines.forEach((line, i) => {
    if (!line.poLineId) { line.poRateNote = null; return; }
    const p = po.get(line.poLineId);
    assertHeader(p, { store, vendorId });
    if (p.itemId !== line.itemId) throw AppError.rule('PO_ITEM_MISMATCH', `Line ${i + 1}: the order line is for ${p.itemName}`, { line: i + 1, field: 'itemId' });
    // no rate typed: the rate of the order
    if (line.rate === null || line.rate === undefined) { line.rate = p.rate; line.amount = Math.round((line.qty * p.rate + Number.EPSILON) * 100) / 100; }
    line.poRateNote = assertRate(p, line.rate, line.poRateNote, `lines.${i}.poRateNote`);
    byLine.set(line.poLineId, r3((byLine.get(line.poLineId) || 0) + line.qty));
  });
  await assertQuantities(companyId, byLine, po, { before, except: inwardId, transaction });
}

/** A header-only change of a store inward (the vendor): the lines that are on an order must still fit. */
async function storeHeader(req, store, { vendorId, oldLines }, transaction) {
  const ids = oldLines.map((l) => l.poLineId).filter(Boolean);
  if (!ids.length) return;
  const po = await lockedLines(req.user.companyId, ids, transaction);
  for (const id of ids) assertHeader(po.get(id), { store, vendorId });
}

/** A yarn inward (one yarn per entry). `entry` is the entry as it is going to be saved; `before` = { poLineId, qty } of the saved one. */
async function yarn(req, entry, { before, inwardId, note }, transaction) {
  if (!entry.poLineId) { entry.poRateNote = null; return; }
  const { companyId } = req.user;
  const po = await lockedLines(companyId, [entry.poLineId], transaction);
  const p = po.get(entry.poLineId);
  assertHeader(p, { store: 'YARN', vendorId: entry.vendorId });
  if (squeeze(p.yarnName) !== squeeze(entry.yarnName)) throw AppError.rule('PO_ITEM_MISMATCH', `The order line is for the yarn "${p.yarnName}"`, { field: 'yarnName' });
  if (p.brand && squeeze(p.brand) !== squeeze(entry.brand)) throw AppError.rule('PO_ITEM_MISMATCH', `The order line is for the brand "${p.brand}"`, { field: 'brand' });
  if (entry.ratePerLb === null || entry.ratePerLb === undefined) entry.ratePerLb = p.rate;
  entry.poRateNote = assertRate(p, Number(entry.ratePerLb), note, 'poRateNote');
  const qty = r3(entry.bags * entry.lbsPerBag);
  const had = before && before.poLineId === entry.poLineId ? new Map([[entry.poLineId, before.qty]]) : new Map();
  await assertQuantities(companyId, new Map([[entry.poLineId, qty]]), po, { before: had, except: inwardId, transaction });
}

/** The rate of an order line in the unit of a fabric inward's rate (per meter or per yard). */
const perUnit = (poRate, poUnit, unit) => (poUnit === unit ? poRate : poUnit === 'YARD' ? poRate / YARD : poRate * YARD);

/** Before a fabric inward is made or changed: the order line (locked), so its rate can be used when none is typed. */
async function fabricLine(req, poLineId, transaction) {
  const po = await lockedLines(req.user.companyId, [poLineId], transaction);
  return po.get(poLineId);
}

/** A fabric inward (one quality per entry). `entry` is the entry as it is going to be saved (quantities worked out). */
async function fabric(req, entry, p, { before, inwardId, note }, transaction) {
  assertHeader(p, { store: 'FABRIC', vendorId: entry.vendorId });
  if (p.qualityId !== entry.qualityId) throw AppError.rule('PO_ITEM_MISMATCH', `The order line is for the quality ${p.qualityName}`, { field: 'qualityId' });
  const rateUnit = entry.rateUnit || entry.unit;
  let kept = null;
  if (entry.rate !== null && entry.rate !== undefined) {
    // compared in the unit of the entry's rate, allowing the rounding of the conversion
    const expected = perUnit(p.rate, p.unit, rateUnit);
    kept = Math.abs(Number(entry.rate) - expected) <= (p.unit === rateUnit ? 0.00005 : 0.01) ? null : assertRate(p, Number(entry.rate), note, 'poRateNote', expected);
  }
  const qty = r3(Number(p.unit === 'YARD' ? entry.inwardYards : entry.inwardMeters));
  const had = before && before.poLineId === p.id ? new Map([[p.id, before.qty]]) : new Map();
  await assertQuantities(req.user.companyId, new Map([[p.id, qty]]), new Map([[p.id, p]]), { before: had, except: inwardId, transaction });
  return kept;
}

/** Adds `po` { orderId, poNo, label, rate, unit, ordered } to every object that has a poLineId (nothing is added to the others, and no query when none has). */
async function describe(companyId, objects, transaction) {
  const ids = [...new Set(objects.map((o) => o.poLineId).filter(Boolean))];
  if (!ids.length) return;
  const rows = await q(LINE_SQL, { companyId, ids }, transaction);
  const by = new Map(rows.map((r) => [r.id, r]));
  for (const o of objects) {
    const p = o.poLineId && by.get(o.poLineId);
    if (p) o.po = { orderId: p.orderId, poNo: p.poNo, label: label(p.poNo), lineId: p.id, rate: p.rate, unit: p.unit, ordered: p.qty };
  }
}

module.exports = { toleranceOf, lockedLines, receivedOf, storeLines, storeHeader, yarn, fabricLine, fabric, perUnit, describe, label };
