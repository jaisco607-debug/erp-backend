// Sizing Management > Sizing Return. Yarn and / or empty beams that went to a sizing party on a sizing challan are called back WITHOUT being sized:
//   some of the beams or all, some bags of yarn or all, only yarn, only beams (6 beams + 20 bags sent: 2 beams and 10 bags can come back).
// Every return is an IN PASS (the same running In Pass number as the sized beam receipts of the sizing batch; never used again).
//   beams   at the sizing party (AT_SIZING) -> EMPTY, dated like the return; deleting the return puts them back at sizing
//   yarn    bags of a weaving yarn inward entry go back into the yarn stock (the stock and the balance of the entry count them in again); lbs = bags x the lbs per bag of the entry
// The yarn that can come back = what went to the party - what is tagged to its sizing batches - what already came back.
const crypto = require('crypto');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const { usedBags } = require('./yarnUsage');
const batches = require('./sizingBatchService');

const n2 = (v) => Math.round(Number(v) * 100) / 100;
const label = (n) => String(n).padStart(5, '0');
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });


// ---- the record badges ----
const challanText = (n) => String(n).padStart(5, '0');
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

/**
 * For the sizing challans of a page: what of them came back through sizing returns (computed on read, one grouped set of queries for the whole page).
 *   beams  a returned beam counts against the LATEST sizing challan of that beam (same party) dated on or before the return.
 *   yarn   FIFO: the bags a party returned of one yarn inward entry are given to the challans that sent that entry to the party OLDEST FIRST (returns in the order of their date and In Pass no),
 *          never more than the bags a challan sent. A return that spills over two challans touches both.
 * Map outwardId -> { returnedBags, returnedBeams, returnCount, hasReturn, lineBags: Map(lineId -> bags), beamIds: Set(beamId) }.
 */
async function challanInfo(outwardIds, transaction) {
  const map = new Map(outwardIds.map((id) => [id, { returnedBags: 0, returnedBeams: 0, returnCount: 0, hasReturn: false, lineBags: new Map(), beamIds: new Set(), returns: new Set() }]));
  if (!outwardIds.length) return map;
  // beams
  const beams = await q(`SELECT rb."beamId", sr.id AS "returnId", o.id AS "outwardId" FROM sizing_return_beams rb JOIN sizing_returns sr ON sr.id = rb."returnId"
    JOIN LATERAL (SELECT o2.id FROM yarn_outward_beams xb JOIN yarn_outwards o2 ON o2.id = xb."outwardId" AND o2.type = 'SIZING' AND o2."deletedAt" IS NULL AND o2."vendorId" = sr."vendorId"
      WHERE xb."beamId" = rb."beamId" AND o2."outwardDate" <= sr."returnDate" ORDER BY o2."outwardDate" DESC, o2."challanNo" DESC LIMIT 1) o ON true WHERE o.id IN (:ids)`, { ids: outwardIds }, transaction);
  for (const b of beams) { const m = map.get(b.outwardId); m.beamIds.add(b.beamId); m.returns.add(b.returnId); }
  // yarn: the (entry, party) pairs of these challans, all their challan lines (oldest first) and all their returned bags (in order)
  const pairs = await q(`SELECT DISTINCT l."inwardId", o."vendorId" FROM yarn_outward_lines l JOIN yarn_outwards o ON o.id = l."outwardId" WHERE o.id IN (:ids) AND o.type = 'SIZING' AND o."deletedAt" IS NULL`, { ids: outwardIds }, transaction);
  if (pairs.length) {
    const inwardIds = [...new Set(pairs.map((p) => p.inwardId))];
    const lines = await q(`SELECT l.id, l."inwardId", l.bags, o.id AS "outwardId", o."vendorId" FROM yarn_outward_lines l JOIN yarn_outwards o ON o.id = l."outwardId" AND o.type = 'SIZING' AND o."deletedAt" IS NULL
      WHERE l."inwardId" IN (:inwardIds) ORDER BY o."outwardDate", o."challanNo"`, { inwardIds }, transaction);
    const rets = await q(`SELECT ry."returnId", ry."inwardId", ry.bags, sr."vendorId" FROM sizing_return_yarns ry JOIN sizing_returns sr ON sr.id = ry."returnId" WHERE ry."inwardId" IN (:inwardIds) ORDER BY sr."returnDate", sr."inPassNo"`, { inwardIds }, transaction);
    const left = new Map(lines.map((l) => [l.id, l.bags]));
    for (const r of rets) {
      let todo = r.bags;
      for (const l of lines) {
        if (todo <= 0) break;
        if (l.inwardId !== r.inwardId || l.vendorId !== r.vendorId) continue;
        const take = Math.min(todo, left.get(l.id));
        if (take <= 0) continue;
        left.set(l.id, left.get(l.id) - take); todo -= take;
        const m = map.get(l.outwardId);
        if (m) { m.lineBags.set(l.id, (m.lineBags.get(l.id) || 0) + take); m.returns.add(r.returnId); }
      }
    }
  }
  for (const m of map.values()) {
    m.returnedBags = [...m.lineBags.values()].reduce((t, v) => t + v, 0);
    m.returnedBeams = m.beamIds.size;
    m.returnCount = m.returns.size;
    m.hasReturn = m.returnCount > 0;
  }
  return map;
}

/**
 * For the returns of a page: what of them went out again on a NEW sizing challan (any party) dated after the return (the same day only if the challan was made after the return).
 *   beams  a returned beam on such a challan;   yarn  the bags of the same entry on such challans, never more than the bags of the return line.
 * Map returnId -> { sentAgainBags, sentAgainBeams, sentAgain, challans, lineBags: Map(lineId -> bags), beamIds: Set }.
 */
async function sentAgainInfo(returnIds, transaction) {
  const map = new Map(returnIds.map((id) => [id, { sentAgainBags: 0, sentAgainBeams: 0, sentAgain: false, challans: new Map(), lineBags: new Map(), beamIds: new Set() }]));
  if (!returnIds.length) return map;
  const later = '(o."outwardDate" > sr."returnDate" OR (o."outwardDate" = sr."returnDate" AND o."createdAt" > sr."createdAt"))';
  const beams = await q(`SELECT rb."returnId", rb."beamId", o.id, o."challanNo", to_char(o."outwardDate", 'YYYY-MM-DD') AS "outwardDate" FROM sizing_return_beams rb JOIN sizing_returns sr ON sr.id = rb."returnId"
    JOIN yarn_outward_beams xb ON xb."beamId" = rb."beamId" JOIN yarn_outwards o ON o.id = xb."outwardId" AND o.type = 'SIZING' AND o."deletedAt" IS NULL AND ${later} WHERE rb."returnId" IN (:ids)`, { ids: returnIds }, transaction);
  for (const b of beams) { const m = map.get(b.returnId); m.beamIds.add(b.beamId); m.challans.set(b.id, { id: b.id, challanNo: b.challanNo, challanText: challanText(b.challanNo), outwardDate: b.outwardDate }); }
  const yarn = await q(`SELECT ry.id AS "lineId", ry."returnId", ry.bags AS "retBags", l.bags, o.id, o."challanNo", to_char(o."outwardDate", 'YYYY-MM-DD') AS "outwardDate" FROM sizing_return_yarns ry JOIN sizing_returns sr ON sr.id = ry."returnId"
    JOIN yarn_outward_lines l ON l."inwardId" = ry."inwardId" JOIN yarn_outwards o ON o.id = l."outwardId" AND o.type = 'SIZING' AND o."deletedAt" IS NULL AND ${later} WHERE ry."returnId" IN (:ids)`, { ids: returnIds }, transaction);
  for (const y of yarn) {
    const m = map.get(y.returnId);
    m.lineBags.set(y.lineId, Math.min(y.retBags, (m.lineBags.get(y.lineId) || 0) + y.bags));
    m.challans.set(y.id, { id: y.id, challanNo: y.challanNo, challanText: challanText(y.challanNo), outwardDate: y.outwardDate });
  }
  for (const m of map.values()) {
    m.sentAgainBags = [...m.lineBags.values()].reduce((t, v) => t + v, 0);
    m.sentAgainBeams = m.beamIds.size;
    m.sentAgain = m.sentAgainBags > 0 || m.sentAgainBeams > 0;
  }
  return map;
}

async function itemsOf(where, replacements, transaction) {
  const rs = await q(`SELECT r.id, r."inPassNo", to_char(r."returnDate", 'YYYY-MM-DD') AS "returnDate", r."refNo", r.notes, r."vendorId", v.code AS "vendorCode", v.name AS "vendorName", r."createdAt"
    FROM sizing_returns r JOIN vendors v ON v.id = r."vendorId" WHERE ${where} ORDER BY r."returnDate" DESC, r."inPassNo" DESC`, replacements, transaction);
  if (!rs.length) return [];
  const ids = rs.map((r) => r.id);
  const beams = await q('SELECT x."returnId", b.id, b."beamNo", b.name, b.status FROM sizing_return_beams x JOIN yarn_beams b ON b.id = x."beamId" WHERE x."returnId" IN (:ids) ORDER BY b."beamNo"', { ids }, transaction);
  const yarns = await q(`SELECT y.id, y."returnId", y."inwardId", y.bags, y.lbs, i.code, i."dcNo", i."lbsPerBag", to_char(i."inwardDate", 'YYYY-MM-DD') AS "inwardDate", yc.id AS "yarnCountId", yc.name AS "yarnCountName", br.name AS "brandName", it.packing, it.bags AS "itemBags"
    FROM sizing_return_yarns y JOIN yarn_inwards i ON i.id = y."inwardId" JOIN yarn_items it ON it.id = i."itemId" JOIN yarn_counts yc ON yc.id = it."yarnCountId" JOIN yarn_brands br ON br.id = it."brandId"
    WHERE y."returnId" IN (:ids) ORDER BY i.code`, { ids }, transaction);
  const again = await sentAgainInfo(ids, transaction);
  return rs.map((r) => {
    const sa = again.get(r.id);
    const bs = beams.filter((b) => b.returnId === r.id).map((b) => ({ id: b.id, beamNo: b.beamNo, beamLabel: label(b.beamNo), name: b.name, status: b.status, statusText: batches.BEAM_TEXT[b.status], sentAgain: sa.beamIds.has(b.id) }));
    const ys = yarns.filter((y) => y.returnId === r.id).map((y) => ({ id: y.id, inwardId: y.inwardId, inwardCode: y.code, dcNo: y.dcNo, inwardDate: y.inwardDate, yarnCount: { id: y.yarnCountId, name: y.yarnCountName },
      name: `${y.yarnCountName} - ${y.brandName} - ${y.packing} - ${y.itemBags}`, bags: y.bags, lbsPerBag: Number(y.lbsPerBag), lbs: n2(y.lbs), sentAgainBags: sa.lineBags.get(y.id) || 0 }));
    return { id: r.id, inPassNo: r.inPassNo, inPassLabel: label(r.inPassNo), returnDate: r.returnDate, refNo: r.refNo, notes: r.notes, party: { id: r.vendorId, code: r.vendorCode, name: r.vendorName },
      beams: bs, yarns: ys, totalBeams: bs.length, totalBags: ys.reduce((t, y) => t + y.bags, 0), totalLbs: n2(ys.reduce((t, y) => t + y.lbs, 0)),
      kind: bs.length && ys.length ? 'BOTH' : bs.length ? 'BEAMS' : 'YARN', createdAt: r.createdAt,
      // went out again on a new sizing challan after the return (computed on read)
      sentAgainBags: sa.sentAgainBags, sentAgainBeams: sa.sentAgainBeams, sentAgain: sa.sentAgain, sentAgainChallans: [...sa.challans.values()].sort((a, b) => a.outwardDate.localeCompare(b.outwardDate) || a.challanNo - b.challanNo) };
  });
}

async function get(req, id) {
  const [r] = await itemsOf('r.id = :id AND r."companyId" = :companyId', { id, companyId: req.user.companyId });
  if (!r) throw AppError.notFound('Sizing return');
  return r;
}

async function list(req, { page, limit, search, vendorId, dateFrom, dateTo }) {
  const r = { companyId: req.user.companyId };
  const f = ['r."companyId" = :companyId'];
  if (vendorId) { f.push('r."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (dateFrom) { f.push('r."returnDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { f.push('r."returnDate" <= :dateTo'); r.dateTo = dateTo; }
  if (search) {
    r.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`; r.exact = String(Number(search) || '');
    f.push(`(v.name ILIKE :like OR r.notes ILIKE :like OR r."refNo" ILIKE :like OR r."inPassNo"::text = :exact OR EXISTS (SELECT 1 FROM sizing_return_beams x JOIN yarn_beams b ON b.id = x."beamId" WHERE x."returnId" = r.id AND (b.name ILIKE :like OR b."beamNo"::text = :exact))
      OR EXISTS (SELECT 1 FROM sizing_return_yarns y JOIN yarn_inwards i ON i.id = y."inwardId" WHERE y."returnId" = r.id AND (i."dcNo" ILIKE :like OR i.code::text = :exact)))`);
  }
  const from = `FROM sizing_returns r JOIN vendors v ON v.id = r."vendorId" WHERE ${f.join(' AND ')}`;
  const ids = (await q(`SELECT r.id ${from} ORDER BY r."returnDate" DESC, r."inPassNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit })).map((x) => x.id);
  const data = ids.length ? (await itemsOf('r.id IN (:ids)', { ids })) : [];
  const [t] = await q(`SELECT COUNT(*)::int AS total, (SELECT COUNT(*) FROM sizing_return_beams WHERE "returnId" IN (SELECT r.id ${from}))::int AS beams,
    (SELECT COALESCE(SUM(bags), 0) FROM sizing_return_yarns WHERE "returnId" IN (SELECT r.id ${from}))::int AS bags, (SELECT COALESCE(SUM(lbs), 0) FROM sizing_return_yarns WHERE "returnId" IN (SELECT r.id ${from})) AS lbs ${from}`, r);
  return { data, page, limit, total: t.total, totals: { returns: t.total, beams: t.beams, bags: t.bags, lbs: n2(t.lbs) } };
}

/** GET /return-yarn?vendorId=&returnId= : the yarn that can come back from this party (not tagged to a batch, not returned yet), in bags. `returnId` = the return being changed (its own bags count as free). */
async function yarnAvailable(req, { vendorId, returnId, search }) {
  const companyId = req.user.companyId;
  await batches.checkVendorExists(companyId, vendorId);
  let data = await batches.yarnPool(companyId, vendorId, { excludeReturnId: returnId || null });
  data = data.map((d) => ({ ...d, availableBags: Math.floor(d.availableLbs / d.lbsPerBag + 1e-6) })).filter((d) => d.availableBags > 0);
  if (search) { const s = search.trim().toLowerCase(); data = data.filter((d) => String(d.inwardCode) === s || (d.dcNo || '').toLowerCase().includes(s) || d.name.toLowerCase().includes(s)); }
  return { data, total: data.length };
}

/** The beams go back to sizing (only while they are still EMPTY: a beam that moved on cannot be undone); the rows are deleted. Returns the inward ids of the yarn rows. */
async function release(returnId, transaction) {
  const rows = await q('SELECT x."beamId", x."prevStatusDate", b."beamNo", b.status FROM sizing_return_beams x JOIN yarn_beams b ON b.id = x."beamId" WHERE x."returnId" = :returnId', { returnId }, transaction);
  for (const r of rows) {
    if (r.status !== 'EMPTY') throw AppError.rule('BEAM_MOVED_ON', `Beam ${r.beamNo} is not empty any more (it is ${batches.BEAM_TEXT[r.status].toLowerCase()}): this return cannot be changed or deleted`, { beamNo: r.beamNo, status: r.status });
    await exec('UPDATE yarn_beams SET status = \'AT_SIZING\', "statusDate" = :d, "updatedAt" = now() WHERE id = :id', { d: r.prevStatusDate, id: r.beamId }, transaction);
  }
  const yarn = await q('SELECT "inwardId" FROM sizing_return_yarns WHERE "returnId" = :returnId', { returnId }, transaction);
  await exec('DELETE FROM sizing_return_beams WHERE "returnId" = :returnId', { returnId }, transaction);
  await exec('DELETE FROM sizing_return_yarns WHERE "returnId" = :returnId', { returnId }, transaction);
  return yarn.map((y) => y.inwardId);
}

/** Takes the beams back (AT_SIZING -> EMPTY, dated like the return) and the yarn bags (checked against what can come back). */
async function apply(companyId, vendorId, returnId, date, beamIds, lines, transaction) {
  const pending = new Map((await batches.pendingBeamRows(companyId, vendorId, transaction)).map((b) => [b.id, b]));
  if (new Set(beamIds).size !== beamIds.length) throw AppError.rule('DUPLICATE_BEAM', 'The same beam is listed twice', { field: 'beamIds' });
  if (beamIds.length) await q('SELECT id FROM yarn_beams WHERE id IN (:ids) ORDER BY id FOR UPDATE', { ids: beamIds }, transaction);
  for (const [i, id] of beamIds.entries()) {
    const p = pending.get(id);
    if (!p) throw AppError.rule('BEAM_NOT_AT_PARTY', 'This beam is not waiting at this sizing party (it may be received or returned already)', { line: i + 1, beamId: id });
    if (p.sentOn > date) throw AppError.rule('BEFORE_OUTWARD', `Beam ${p.beamNo} went to sizing on ${p.sentOn}: it cannot come back before that`, { line: i + 1, beamNo: p.beamNo, sentOn: p.sentOn });
    await exec('INSERT INTO sizing_return_beams (id, "returnId", "beamId", "prevStatusDate") VALUES (:id, :returnId, :beamId, :prev)', { id: crypto.randomUUID(), returnId, beamId: id, prev: p.sentOn }, transaction);
    await exec('UPDATE yarn_beams SET status = \'EMPTY\', "statusDate" = :d, meters = NULL, "updatedAt" = now() WHERE id = :id', { d: date, id }, transaction);
  }
  const inwardIds = lines.map((l) => l.inwardId);
  if (new Set(inwardIds).size !== inwardIds.length) throw AppError.rule('DUPLICATE_YARN', 'The same yarn is listed twice', { field: 'yarns' });
  const pool = new Map((await batches.yarnPool(companyId, vendorId, { inwardIds: inwardIds.length ? inwardIds : ['00000000-0000-4000-8000-000000000000'], excludeReturnId: returnId }, transaction)).map((p) => [p.inwardId, p]));
  for (const [i, l] of lines.entries()) {
    const p = pool.get(l.inwardId);
    if (!p) throw AppError.rule('YARN_NOT_SENT', 'This yarn was not sent to this sizing party on a sizing challan', { line: i + 1, inwardId: l.inwardId });
    const lbs = n2(l.bags * p.lbsPerBag);
    if (lbs > p.availableLbs + 0.01) {
      const freeBags = Math.floor(p.availableLbs / p.lbsPerBag + 1e-6);
      throw AppError.rule('MORE_THAN_AVAILABLE', `${p.sentLbs} lbs of this yarn went to the party, ${p.taggedLbs} lbs are tagged to batches and ${p.returnedLbs} lbs came back already: only ${freeBags} bag${freeBags === 1 ? '' : 's'} can come back`, { line: i + 1, availableBags: freeBags, sentLbs: p.sentLbs, taggedLbs: p.taggedLbs, returnedLbs: p.returnedLbs });
    }
    await exec('INSERT INTO sizing_return_yarns (id, "returnId", "inwardId", bags, lbs) VALUES (:id, :returnId, :inwardId, :bags, :lbs)', { id: crypto.randomUUID(), returnId, inwardId: l.inwardId, bags: l.bags, lbs }, transaction);
  }
}

/** After the yarn of a return was taken out of the stock again (change / delete), no entry may have more bags out than it ever had. */
async function checkStock(inwardIds, transaction) {
  const ids = [...new Set(inwardIds)];
  if (!ids.length) return;
  const used = await usedBags(ids, { transaction });
  const rows = await q('SELECT id, code, bags FROM yarn_inwards WHERE id IN (:ids)', { ids }, transaction);
  for (const r of rows) {
    if (r.bags - (used.get(r.id) || 0) < 0) throw AppError.rule('YARN_ALREADY_USED', `Yarn inward entry ${r.code} was sent out again after it came back: this return cannot be changed or deleted`, { inwardCode: r.code });
  }
}

const needSomething = (beamIds, lines) => {
  if (!beamIds.length && !lines.length) throw AppError.rule('NOTHING_RETURNED', 'Choose the beams or the yarn that come back');
};

async function create(req, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `sizing-return:${companyId}` }, transaction);
    await batches.checkVendorExists(companyId, data.vendorId);
    const beamIds = data.beamIds || []; const lines = data.yarns || [];
    needSomething(beamIds, lines);
    const date = data.returnDate || today();
    const no = await batches.nextInPass(companyId, transaction);
    const id = crypto.randomUUID();
    await exec('INSERT INTO sizing_returns (id, "companyId", "inPassNo", "returnDate", "vendorId", "refNo", notes, "createdById") VALUES (:id, :companyId, :no, :date, :vendorId, :refNo, :notes, :userId)',
      { id, companyId, no, date, vendorId: data.vendorId, refNo: data.refNo || null, notes: data.notes || null, userId: req.user.id }, transaction);
    await apply(companyId, data.vendorId, id, date, beamIds, lines, transaction);
    const out = (await itemsOf('r.id = :id', { id }, transaction))[0];
    await audit.log(req, { action: 'SIZING_RETURN_CREATED', entityType: 'SizingReturn', entityId: id, after: { inPassNo: out.inPassNo, vendorId: out.party.id, beams: out.totalBeams, bags: out.totalBags, lbs: out.totalLbs } }, { transaction });
    return out;
  });
}

async function lockReturn(companyId, id, transaction) {
  const [r] = await q('SELECT * FROM sizing_returns WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Sizing return');
  return r;
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const r = await lockReturn(companyId, id, transaction);
    const [current] = await itemsOf('r.id = :id', { id }, transaction);
    const date = changes.returnDate || current.returnDate;
    const beamIds = changes.beamIds || current.beams.map((b) => b.id);
    const lines = changes.yarns || current.yarns.map((y) => ({ inwardId: y.inwardId, bags: y.bags }));
    needSomething(beamIds, lines);
    const oldInwards = await release(id, transaction);
    await apply(companyId, r.vendorId, id, date, beamIds, lines, transaction);
    await checkStock([...oldInwards.filter((i) => !lines.some((l) => l.inwardId === i)), ...lines.map((l) => l.inwardId)], transaction);
    const set = { returnDate: date };
    for (const f of ['refNo', 'notes']) if (changes[f] !== undefined) set[f] = changes[f] === '' ? null : changes[f];
    await exec(`UPDATE sizing_returns SET ${Object.keys(set).map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :id`, { ...set, id }, transaction);
    const out = (await itemsOf('r.id = :id', { id }, transaction))[0];
    await audit.log(req, { action: 'SIZING_RETURN_UPDATED', entityType: 'SizingReturn', entityId: id, before: { inPassNo: current.inPassNo, beams: current.totalBeams, bags: current.totalBags }, after: { inPassNo: out.inPassNo, beams: out.totalBeams, bags: out.totalBags } }, { transaction });
    return out;
  });
}

async function remove(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const r = await lockReturn(companyId, id, transaction);
    const oldInwards = await release(id, transaction);
    await checkStock(oldInwards, transaction);
    await exec('DELETE FROM sizing_returns WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'SIZING_RETURN_DELETED', entityType: 'SizingReturn', entityId: id, before: { inPassNo: r.inPassNo } }, { transaction });
    return { deleted: true, id };
  });
}

module.exports = { list, get, create, update, remove, yarnAvailable, challanInfo };
