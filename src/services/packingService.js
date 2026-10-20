// Packing (owner, 2026-10-17). Cloth reaches Packing only from Folding; Packing only presses Receive
// and Accept (jobService). On an SO card that has arrived, Packing makes packing lists: thaan by
// thaan for every lot of the card, the meters and category (A / B / CP) of each, a rate per
// category, and the amounts. A list stays DRAFT (editable) until it is finalized; a thaan can be on
// one list only. The frontend turns a list into a PDF.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const { companyServices, userServices } = require('./accessService');

const COUNTER = 'packing_list_no';
const GRADES = ['A', 'B', 'CP'];
const GRADE_TEXT = { A: 'A', B: 'B', CP: 'Cut Piece' };
const round = (n) => Math.round(n * 100) / 100;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });

async function packingDept(req, code, level, transaction) {
  const s = (await companyServices(req.user.companyId, transaction)).find((x) => x.code === String(code).toUpperCase());
  if (!s) throw AppError.notFound('Department');
  if (s.kind !== 'PACKING') throw AppError.rule('NOT_PACKING', `${s.name} is not the packing department`);
  if (req.user.userType !== 'CLIENT_ADMIN') {
    const g = (await userServices(req.user, transaction)).find((x) => x.service.id === s.id);
    if (!g || (level === 'FULL' && g.access !== 'FULL')) throw AppError.forbidden(level === 'FULL' ? 'You need FULL access to Packing' : 'You do not have Packing');
  }
  return s;
}

/** SO card header + how much cloth: on the card, sent by Folding, accepted here, already packed. */
async function cardInfo(req, depId, soCardIds, transaction) {
  if (!soCardIds.length) return new Map();
  const rows = await q(`
    SELECT sc.id, sc."cardNo", sc."idNo", sc."cardDate", sc."isGreyReturn", cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
      COALESCE(q1.name, (SELECT MAX(q2.name) FROM so_card_lots l JOIN grey_lots g ON g.id = l."greyLotId" JOIN qualities q2 ON q2.id = g."qualityId" WHERE l."soCardId" = sc.id)) AS quality,
      (SELECT COALESCE(SUM(l.meters), 0)::float FROM so_card_lots l WHERE l."soCardId" = sc.id) AS "cardMeters",
      (SELECT string_agg(DISTINCT c.name, ', ') FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN colours c ON c.id = ji."colourId"
        WHERE ji."soCardId" = sc.id AND j."departmentId" = :dep AND j.status <> 'REJECTED') AS colour,
      (SELECT COALESCE(SUM(ji.meters), 0)::float FROM job_items ji JOIN jobs j ON j.id = ji."jobId"
        WHERE ji."soCardId" = sc.id AND j."departmentId" = :dep AND j.status <> 'REJECTED') AS "sentMeters",
      (SELECT COALESCE(SUM(ji.meters), 0)::float FROM job_items ji JOIN jobs j ON j.id = ji."jobId"
        WHERE ji."soCardId" = sc.id AND j."departmentId" = :dep AND j.status NOT IN ('REJECTED', 'IN_WAY', 'QUEUE')) AS "receivedMeters",
      (SELECT COALESCE(SUM(pl.meters), 0)::float FROM packing_list_lines pl JOIN packing_lists p ON p.id = pl."packingListId" WHERE p."soCardId" = sc.id) AS "packedMeters",
      (SELECT count(*)::int FROM packing_lists p WHERE p."soCardId" = sc.id) AS "listCount"
    FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" LEFT JOIN qualities q1 ON q1.id = sc."qualityId"
    WHERE sc."companyId" = :companyId AND sc.id IN (:ids)`, { companyId: req.user.companyId, dep: depId, ids: soCardIds }, transaction);
  // what Folding graded for this card (A / B / CP meters), from the Folding jobs that sent it here
  const fold = await q(`
    SELECT fe."soCardId", SUM(fe."aMeters")::float AS a, SUM(fe."bMeters")::float AS b, SUM(fe."cpMeters")::float AS cp
    FROM folding_entries fe WHERE fe."soCardId" IN (:ids) AND fe."jobId" IN (
      SELECT DISTINCT src."jobId" FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN job_items src ON src.id = ji."sourceJobItemId"
      WHERE j."departmentId" = :dep AND j.status <> 'REJECTED' AND ji."soCardId" IN (:ids))
    GROUP BY fe."soCardId"`, { dep: depId, ids: soCardIds }, transaction);
  const out = new Map();
  for (const r of rows) {
    const f = fold.find((x) => x.soCardId === r.id) || { a: 0, b: 0, cp: 0 };
    out.set(r.id, {
      soCard: { id: r.id, cardNo: r.cardNo, idNo: r.idNo, cardDate: r.cardDate },
      customer: { id: r.customerId, code: r.customerCode, name: r.customerName },
      quality: r.quality, colour: r.colour,
      // fabric return grey: this cloth was not processed (rates are usually 0)
      isGreyReturn: r.isGreyReturn, tagText: r.isGreyReturn ? 'Fabric return grey (not processed)' : null,
      cloth: {
        soCardMeters: round(r.cardMeters), // what the SO card had
        fromFoldingMeters: round(r.sentMeters), // what Folding sent here (In-Way included)
        receivedMeters: round(r.receivedMeters), // accepted here
        packedMeters: round(r.packedMeters), // on packing lists already
        leftToPack: round(r.receivedMeters - r.packedMeters),
      },
      folding: { a: round(f.a), b: round(f.b), cp: round(f.cp), total: round(f.a + f.b + f.cp) },
      listCount: r.listCount,
    });
  }
  return out;
}

/** SO cards that reached Packing, with their cloth numbers. tab=open (something left to pack) | all */
async function soCards(req, code, query) {
  const d = await packingDept(req, code, 'VIEW');
  const ids = (await q(`SELECT DISTINCT ji."soCardId" AS id FROM job_items ji JOIN jobs j ON j.id = ji."jobId"
    WHERE j."companyId" = :companyId AND j."departmentId" = :dep AND j.status <> 'REJECTED'`, { companyId: req.user.companyId, dep: d.id })).map((r) => r.id);
  let list = [...(await cardInfo(req, d.id, ids)).values()];
  if (query.search && /^\d+$/.test(query.search)) list = list.filter((r) => r.soCard.cardNo === Number(query.search));
  if (query.tab === 'open') list = list.filter((r) => r.cloth.leftToPack > 0 || r.cloth.fromFoldingMeters > r.cloth.receivedMeters);
  list.sort((a, b) => b.soCard.cardNo - a.soCard.cardNo);
  return { data: list.slice((query.page - 1) * query.limit, query.page * query.limit), total: list.length, page: query.page, limit: query.limit };
}

/** Everything the packing list screen needs for one SO card: lots, their thaans (Folding's grade prefilled). */
async function form(req, code, soCardId, exceptListId) {
  const d = await packingDept(req, code, 'VIEW');
  const info = (await cardInfo(req, d.id, [soCardId])).get(soCardId);
  if (!info) throw AppError.notFound('SO card');
  const lots = await q(`
    SELECT gl.id, gl."lotNo", SUM(l.meters)::float AS meters FROM so_card_lots l JOIN grey_lots gl ON gl.id = l."greyLotId"
    WHERE l."soCardId" = :id GROUP BY gl.id ORDER BY gl."lotNo"`, { id: soCardId });
  const thaans = await q(`
    SELECT gl.id AS "lotId", t.id AS "thaanId", t."thaanNo", p.meters::float AS meters
    FROM so_card_lots l JOIN grey_lots gl ON gl.id = l."greyLotId" JOIN so_card_lot_thaans p ON p."soCardLotId" = l.id JOIN grey_lot_thaans t ON t.id = p."thaanId"
    WHERE l."soCardId" = :id ORDER BY t."thaanNo"`, { id: soCardId });
  // what Folding sent to Packing, per lot / thaan and category
  const fold = await q(`
    SELECT "greyLotId" AS "lotId", "thaanId", SUM("sentA")::float AS a, SUM("sentB")::float AS b, SUM("sentCP")::float AS cp
    FROM folding_lines WHERE "soCardId" = :id GROUP BY "greyLotId", "thaanId"`, { id: soCardId });
  // already on other packing lists, per lot / thaan and category
  const packed = await q(`
    SELECT x."greyLotId" AS "lotId", x."thaanId", x.grade, SUM(x.meters)::float AS meters, MIN(pk."listNo") AS "listNo"
    FROM packing_list_lines x JOIN packing_lists pk ON pk.id = x."packingListId"
    WHERE pk."soCardId" = :id AND pk.id <> :except GROUP BY x."greyLotId", x."thaanId", x.grade`,
  { id: soCardId, except: exceptListId || '00000000-0000-0000-0000-000000000000' });
  const lineOf = (lotId, thaanId, thaanNo, meters) => {
    const f = fold.find((x) => x.lotId === lotId && (x.thaanId || null) === thaanId) || { a: 0, b: 0, cp: 0 };
    const folding = { a: round(f.a), b: round(f.b), cp: round(f.cp) };
    // suggested packing lines: one per category Folding sent, minus what is already packed
    const suggested = [];
    for (const g of GRADES) {
      const done = packed.filter((x) => x.lotId === lotId && (x.thaanId || null) === thaanId && x.grade === g).reduce((t, x) => t + x.meters, 0);
      const left = round(folding[g.toLowerCase()] - done);
      if (left > 0) suggested.push({ grade: g, gradeText: GRADE_TEXT[g], meters: left });
    }
    const onLists = packed.filter((x) => x.lotId === lotId && (x.thaanId || null) === thaanId);
    return {
      thaanId, thaanNo, meters, folding, foldingTotal: round(folding.a + folding.b + folding.cp),
      suggestedLines: suggested,
      packed: onLists.map((x) => ({ grade: x.grade, meters: round(x.meters), listNo: x.listNo })),
      alreadyPacked: !suggested.length && onLists.length > 0,
    };
  };
  return {
    ...info,
    lots: lots.map((l) => {
      const ts = thaans.filter((t) => t.lotId === l.id);
      return {
        id: l.id, lotNo: l.lotNo, meters: round(l.meters), hasThaans: ts.length > 0, thaanCount: ts.length,
        thaans: ts.length ? ts.map((t) => lineOf(l.id, t.thaanId, t.thaanNo, t.meters)) : [lineOf(l.id, null, null, round(l.meters))],
      };
    }),
    grades: GRADES.map((g) => ({ value: g, text: GRADE_TEXT[g] })),
  };
}

function summary(lines, rates) {
  const s = {};
  for (const g of GRADES) {
    const ls = lines.filter((l) => l.grade === g);
    const meters = round(ls.reduce((t, l) => t + l.meters, 0));
    s[g] = { gradeText: GRADE_TEXT[g], thaans: ls.length, meters, rate: rates[g], amount: round(meters * rates[g]) };
  }
  s.total = {
    thaans: lines.length,
    meters: round(GRADES.reduce((t, g) => t + s[g].meters, 0)),
    amount: round(GRADES.reduce((t, g) => t + s[g].amount, 0)),
  };
  return s;
}

async function load(req, depId, id, transaction) {
  const [p] = await q(`
    SELECT p.*, cb.name AS "createdByName", ub.name AS "updatedByName", fb.name AS "finalizedByName"
    FROM packing_lists p LEFT JOIN users cb ON cb.id = p."createdById" LEFT JOIN users ub ON ub.id = p."updatedById" LEFT JOIN users fb ON fb.id = p."finalizedById"
    WHERE p.id = :id AND p."companyId" = :companyId`, { id, companyId: req.user.companyId }, transaction);
  if (!p) throw AppError.notFound('Packing list');
  const lines = (await q(`SELECT pl.*, pl.meters::float AS meters, gl."lotNo" FROM packing_list_lines pl JOIN grey_lots gl ON gl.id = pl."greyLotId"
    WHERE pl."packingListId" = :id ORDER BY pl."lineNo"`, { id }, transaction));
  const info = (await cardInfo(req, depId, [p.soCardId], transaction)).get(p.soCardId);
  const rates = { A: Number(p.rateA), B: Number(p.rateB), CP: Number(p.rateCP) };
  const lots = [];
  for (const l of lines) {
    let lot = lots.find((x) => x.id === l.greyLotId);
    if (!lot) lots.push(lot = { id: l.greyLotId, lotNo: l.lotNo, thaans: [] });
    lot.thaans.push({ lineNo: l.lineNo, thaanId: l.thaanId, thaanNo: l.thaanNo, grade: l.grade, gradeText: GRADE_TEXT[l.grade], meters: l.meters, rate: rates[l.grade], amount: round(l.meters * rates[l.grade]) });
  }
  for (const lot of lots) lot.summary = summary(lot.thaans, rates);
  return {
    id: p.id, listNo: p.listNo, listDate: p.listDate, status: p.status, statusText: p.status === 'FINAL' ? 'Final' : 'Draft',
    canEdit: p.status === 'DRAFT',
    ...info,
    description: p.description, madeFor: p.madeFor, ctnQty: p.ctnQty,
    netWeight: p.netWeight === null ? null : Number(p.netWeight), grossWeight: p.grossWeight === null ? null : Number(p.grossWeight), remarks: p.remarks,
    rates,
    lots,
    summary: summary(lines, rates),
    createdBy: p.createdById ? { id: p.createdById, name: p.createdByName } : null, createdAt: p.createdAt,
    updatedBy: p.updatedById ? { id: p.updatedById, name: p.updatedByName } : null, updatedAt: p.updatedAt,
    finalizedBy: p.finalizedById ? { id: p.finalizedById, name: p.finalizedByName } : null, finalizedAt: p.finalizedAt,
  };
}

/** Checks the lines against the card's lots / thaans; returns rows ready to insert. */
async function checkLines(req, soCardId, lines, listId, transaction) {
  const lots = await q(`SELECT DISTINCT "greyLotId" AS id FROM so_card_lots WHERE "soCardId" = :id`, { id: soCardId }, transaction);
  const lotIds = new Set(lots.map((l) => l.id));
  const thaans = await q(`
    SELECT t.id, t."thaanNo", l."greyLotId" FROM so_card_lots l JOIN so_card_lot_thaans p ON p."soCardLotId" = l.id JOIN grey_lot_thaans t ON t.id = p."thaanId"
    WHERE l."soCardId" = :id`, { id: soCardId }, transaction);
  const packed = new Set((await q(`SELECT x."thaanId", x.grade FROM packing_list_lines x JOIN packing_lists p ON p.id = x."packingListId"
    WHERE p."soCardId" = :id AND p.id <> :listId AND x."thaanId" IS NOT NULL`, { id: soCardId, listId: listId || '00000000-0000-0000-0000-000000000000' }, transaction)).map((r) => `${r.thaanId}:${r.grade}`));
  const seen = new Set();
  const autoNo = new Map();
  return lines.map((l, i) => {
    if (!lotIds.has(l.greyLotId)) throw AppError.rule('UNKNOWN_LOT', 'This lot is not on the SO card', { line: i + 1 });
    let thaanNo = l.thaanNo;
    if (l.thaanId) {
      const t = thaans.find((x) => x.id === l.thaanId && x.greyLotId === l.greyLotId);
      if (!t) throw AppError.rule('UNKNOWN_THAAN', 'This thaan is not in this lot of the SO card', { line: i + 1 });
      // a thaan can be on the list once per category (A part, B part, CP part)
      const key = `${t.id}:${l.grade}`;
      if (seen.has(key)) throw AppError.rule('DUPLICATE_THAAN', `Thaan ${t.thaanNo} ${GRADE_TEXT[l.grade]} is given twice`, { line: i + 1 });
      if (packed.has(key)) throw AppError.rule('THAAN_ALREADY_PACKED', `Thaan ${t.thaanNo} ${GRADE_TEXT[l.grade]} is already on another packing list`, { line: i + 1 });
      seen.add(key);
      thaanNo = t.thaanNo;
    } else if (thaans.some((x) => x.greyLotId === l.greyLotId)) {
      throw AppError.rule('THAAN_REQUIRED', 'This lot has thaans: choose the thaan', { line: i + 1 });
    }
    if (!thaanNo) thaanNo = (autoNo.get(l.greyLotId) || 0) + 1;
    autoNo.set(l.greyLotId, Math.max(autoNo.get(l.greyLotId) || 0, thaanNo));
    return { lineNo: i + 1, greyLotId: l.greyLotId, thaanId: l.thaanId || null, thaanNo, grade: l.grade, meters: l.meters };
  });
}

async function writeLines(listId, rows, transaction) {
  await sequelize.query('DELETE FROM packing_list_lines WHERE "packingListId" = :listId', { replacements: { listId }, transaction });
  for (const r of rows) {
    await sequelize.query(`INSERT INTO packing_list_lines (id, "packingListId", "lineNo", "greyLotId", "thaanId", "thaanNo", grade, meters)
      VALUES (gen_random_uuid(), :listId, :lineNo, :greyLotId, :thaanId, :thaanNo, :grade, :meters)`, { replacements: { listId, ...r }, transaction });
  }
}

const HEAD = ['description', 'madeFor', 'ctnQty', 'netWeight', 'grossWeight', 'remarks'];

async function create(req, code, data) {
  return sequelize.transaction(async (transaction) => {
    const d = await packingDept(req, code, 'FULL', transaction);
    await sequelize.query('SELECT id FROM so_cards WHERE id = :id FOR UPDATE', { replacements: { id: data.soCardId }, transaction });
    const info = (await cardInfo(req, d.id, [data.soCardId], transaction)).get(data.soCardId);
    if (!info) throw AppError.notFound('SO card');
    if (info.cloth.receivedMeters <= 0) throw AppError.rule('NOTHING_RECEIVED', 'Accept the cloth of this SO card from Folding first');
    const rows = await checkLines(req, data.soCardId, data.lines, null, transaction);
    const companyId = req.user.companyId;
    const listNo = await counters.take(companyId, COUNTER, async () => ((await q('SELECT MAX("listNo") AS m FROM packing_lists WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1, transaction);
    const [{ id }] = await q(`INSERT INTO packing_lists (id, "companyId", "listNo", "soCardId", "listDate", description, "madeFor", "ctnQty", "netWeight", "grossWeight", remarks, "rateA", "rateB", "rateCP", "createdById", "updatedById")
      VALUES (gen_random_uuid(), :companyId, :listNo, :soCardId, :listDate, :description, :madeFor, :ctnQty, :netWeight, :grossWeight, :remarks, :rateA, :rateB, :rateCP, :userId, :userId) RETURNING id`, {
      companyId, listNo, soCardId: data.soCardId, listDate: data.listDate || new Date().toISOString().slice(0, 10),
      ...Object.fromEntries(HEAD.map((k) => [k, data[k] ?? null])),
      rateA: data.rateA || 0, rateB: data.rateB || 0, rateCP: data.rateCP || 0, userId: req.user.id,
    }, transaction);
    await writeLines(id, rows, transaction);
    const after = await load(req, d.id, id, transaction);
    await audit.log(req, { action: 'PACKING_LIST_CREATED', entityType: 'PackingList', entityId: id, after: { listNo, soNo: info.soCard.cardNo, summary: after.summary } }, { transaction });
    return after;
  });
}

async function draftOr409(req, id, transaction) {
  const [p] = await q('SELECT * FROM packing_lists WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId: req.user.companyId }, transaction);
  if (!p) throw AppError.notFound('Packing list');
  return p;
}

async function update(req, code, id, data) {
  return sequelize.transaction(async (transaction) => {
    const d = await packingDept(req, code, 'FULL', transaction);
    const p = await draftOr409(req, id, transaction);
    if (p.status !== 'DRAFT') throw AppError.rule('LIST_FINAL', 'This packing list is final; reopen it first');
    const before = await load(req, d.id, id, transaction);
    const set = {};
    for (const k of [...HEAD, 'listDate', 'rateA', 'rateB', 'rateCP']) if (data[k] !== undefined) set[k] = data[k];
    if (Object.keys(set).length) {
      await sequelize.query(`UPDATE packing_lists SET ${Object.keys(set).map((k) => `"${k}" = :${k}`).join(', ')}, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
        { replacements: { ...set, userId: req.user.id, id }, transaction });
    }
    if (data.lines) {
      await writeLines(id, await checkLines(req, p.soCardId, data.lines, id, transaction), transaction);
      await sequelize.query('UPDATE packing_lists SET "updatedById" = :userId, "updatedAt" = now() WHERE id = :id', { replacements: { userId: req.user.id, id }, transaction });
    }
    const after = await load(req, d.id, id, transaction);
    await audit.log(req, { action: 'PACKING_LIST_UPDATED', entityType: 'PackingList', entityId: id, before: { lots: before.lots, rates: before.rates }, after: { lots: after.lots, rates: after.rates } }, { transaction });
    return after;
  });
}

/** Final = locked (ready for the PDF). Reopen = back to Draft. */
async function setFinal(req, code, id, final) {
  return sequelize.transaction(async (transaction) => {
    const d = await packingDept(req, code, 'FULL', transaction);
    const p = await draftOr409(req, id, transaction);
    if (final && p.status === 'FINAL') throw AppError.rule('LIST_FINAL', 'Already final');
    if (!final && p.status === 'DRAFT') throw AppError.rule('LIST_DRAFT', 'This packing list is not final');
    if (final && !(await q('SELECT 1 FROM packing_list_lines WHERE "packingListId" = :id LIMIT 1', { id }, transaction)).length) throw AppError.rule('NO_LINES', 'Add thaans first');
    await sequelize.query(`UPDATE packing_lists SET status = :s, "finalizedById" = :by, "finalizedAt" = :at, "updatedAt" = now() WHERE id = :id`,
      { replacements: { s: final ? 'FINAL' : 'DRAFT', by: final ? req.user.id : null, at: final ? new Date() : null, id }, transaction });
    await audit.log(req, { action: final ? 'PACKING_LIST_FINALIZED' : 'PACKING_LIST_REOPENED', entityType: 'PackingList', entityId: id, after: { listNo: p.listNo } }, { transaction });
    return load(req, d.id, id, transaction);
  });
}

async function remove(req, code, id) {
  return sequelize.transaction(async (transaction) => {
    await packingDept(req, code, 'FULL', transaction);
    const p = await draftOr409(req, id, transaction);
    if (p.status !== 'DRAFT') throw AppError.rule('LIST_FINAL', 'A final packing list cannot be deleted; reopen it first');
    await sequelize.query('DELETE FROM packing_lists WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'PACKING_LIST_DELETED', entityType: 'PackingList', entityId: id, before: { listNo: p.listNo, soCardId: p.soCardId } }, { transaction });
    return { deleted: true, id };
  });
}

async function get(req, code, id) {
  const d = await packingDept(req, code, 'VIEW');
  return load(req, d.id, id);
}

async function list(req, code, query) {
  const d = await packingDept(req, code, 'VIEW');
  const where = ['p."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (query.soCardId) { where.push('p."soCardId" = :soCardId'); r.soCardId = query.soCardId; }
  if (query.status) { where.push('p.status = :status'); r.status = query.status; }
  if (query.dateFrom) { where.push('p."listDate" >= :dateFrom'); r.dateFrom = query.dateFrom; }
  if (query.dateTo) { where.push('p."listDate" <= :dateTo'); r.dateTo = query.dateTo; }
  if (query.search && /^\d+$/.test(query.search)) { where.push('(p."listNo" = :n OR sc."cardNo" = :n)'); r.n = Number(query.search); }
  const ids = await q(`SELECT p.id FROM packing_lists p JOIN so_cards sc ON sc.id = p."soCardId" WHERE ${where.join(' AND ')} ORDER BY p."listNo" DESC`, r);
  const page = ids.slice((query.page - 1) * query.limit, query.page * query.limit);
  const data = [];
  for (const { id } of page) {
    const x = await load(req, d.id, id);
    delete x.lots;
    data.push(x);
  }
  return { data, total: ids.length, page: query.page, limit: query.limit };
}

/**
 * Gate pass of a packing list (owner 2026-10-19). Before it is saved, the form comes pre-filled
 * (today's date, the list's maker as operator, `saved: false`). Lots show only thaan numbers.
 */
const GATE_COPIES = ['Packing', 'Company guard', 'Driver'];

async function gatePassOf(req, code, listId, transaction) {
  const d = await packingDept(req, code, 'VIEW', transaction);
  const list = await load(req, d.id, listId, transaction);
  const [g] = await q(`SELECT g.*, ub.name AS "updatedByName" FROM gate_passes g LEFT JOIN users ub ON ub.id = g."updatedById" WHERE g."packingListId" = :listId`, { listId }, transaction);
  const lots = list.lots.map((l) => {
    const nos = [...new Set(l.thaans.map((t) => t.thaanNo).filter((n) => n !== null && n !== undefined))].sort((a, b) => a - b);
    return { lotNo: l.lotNo, thaanNos: nos, thaanCount: nos.length };
  });
  return {
    saved: Boolean(g),
    // only a final list can get a gate pass
    canSave: list.status === 'FINAL',
    id: g ? g.id : null,
    gatePassNo: g ? g.gatePassNo : null,
    passDate: g ? g.passDate : new Date().toISOString().slice(0, 10),
    packingList: { id: list.id, listNo: list.listNo, status: list.status, statusText: list.statusText },
    soCard: list.soCard,
    // the client named on the grey inward
    customer: list.customer,
    quality: list.quality, colour: list.colour,
    isGreyReturn: list.isGreyReturn, tagText: list.tagText,
    lots,
    totalThaans: lots.reduce((t, l) => t + l.thaanCount, 0),
    operatorName: g ? g.operatorName : (list.createdBy ? list.createdBy.name : null),
    driverName: g ? g.driverName : null,
    vehicleNo: g ? g.vehicleNo : null,
    destination: g ? g.destination : null,
    remarks: g ? g.remarks : null,
    // 3 copies of the same pass
    copies: GATE_COPIES,
    updatedAt: g ? g.updatedAt : null, updatedBy: g && g.updatedById ? { id: g.updatedById, name: g.updatedByName } : null,
  };
}

const GATE_FIELDS = ['passDate', 'operatorName', 'driverName', 'vehicleNo', 'destination', 'remarks'];

async function saveGatePass(req, code, listId, data) {
  return sequelize.transaction(async (transaction) => {
    await packingDept(req, code, 'FULL', transaction);
    const companyId = req.user.companyId;
    const p = await draftOr409(req, listId, transaction);
    // owner 2026-10-19: only a FINAL packing list gets a gate pass
    if (p.status !== 'FINAL') throw AppError.rule('LIST_NOT_FINAL', 'Make the packing list Final first; a gate pass is only for a final list');
    if (!(await q('SELECT 1 FROM packing_list_lines WHERE "packingListId" = :listId LIMIT 1', { listId }, transaction)).length) throw AppError.rule('NO_LINES', 'The packing list has no thaans');
    const [old] = await q('SELECT * FROM gate_passes WHERE "packingListId" = :listId FOR UPDATE', { listId }, transaction);
    const v = Object.fromEntries(GATE_FIELDS.map((k) => [k, data[k] === undefined ? (old ? old[k] : null) : (data[k] === '' ? null : data[k])]));
    if (!v.passDate) v.passDate = new Date().toISOString().slice(0, 10);
    let id;
    if (old) {
      id = old.id;
      await sequelize.query(`UPDATE gate_passes SET "passDate" = :passDate, "operatorName" = :operatorName, "driverName" = :driverName, "vehicleNo" = :vehicleNo,
        destination = :destination, remarks = :remarks, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { ...v, userId: req.user.id, id }, transaction });
    } else {
      const no = await counters.take(companyId, 'gate_pass_no', async () => ((await q('SELECT MAX("gatePassNo") AS m FROM gate_passes WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1, transaction);
      if (!v.operatorName) {
        const [u] = await q('SELECT name FROM users WHERE id = :id', { id: p.createdById }, transaction);
        v.operatorName = u ? u.name : null;
      }
      [{ id }] = await q(`INSERT INTO gate_passes (id, "companyId", "gatePassNo", "packingListId", "passDate", "operatorName", "driverName", "vehicleNo", destination, remarks, "createdById", "updatedById")
        VALUES (gen_random_uuid(), :companyId, :no, :listId, :passDate, :operatorName, :driverName, :vehicleNo, :destination, :remarks, :userId, :userId) RETURNING id`,
      { companyId, no, listId, ...v, userId: req.user.id }, transaction);
    }
    const after = await gatePassOf(req, code, listId, transaction);
    await audit.log(req, { action: old ? 'GATE_PASS_UPDATED' : 'GATE_PASS_CREATED', entityType: 'GatePass', entityId: id, before: old ? Object.fromEntries(GATE_FIELDS.map((k) => [k, old[k]])) : undefined, after: { gatePassNo: after.gatePassNo, listNo: after.packingList.listNo, driverName: after.driverName, vehicleNo: after.vehicleNo, destination: after.destination } }, { transaction });
    return after;
  });
}

async function listGatePasses(req, code, query) {
  const d = await packingDept(req, code, 'VIEW');
  const where = ['g."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (query.dateFrom) { where.push('g."passDate" >= :dateFrom'); r.dateFrom = query.dateFrom; }
  if (query.dateTo) { where.push('g."passDate" <= :dateTo'); r.dateTo = query.dateTo; }
  if (query.search) {
    r.like = `%${query.search}%`;
    where.push(`(g."vehicleNo" ILIKE :like OR g."driverName" ILIKE :like OR g.destination ILIKE :like${/^\d+$/.test(query.search) ? ' OR g."gatePassNo" = :n OR p."listNo" = :n OR sc."cardNo" = :n' : ''})`);
    if (/^\d+$/.test(query.search)) r.n = Number(query.search);
  }
  const ids = await q(`SELECT g."packingListId" AS id FROM gate_passes g JOIN packing_lists p ON p.id = g."packingListId" JOIN so_cards sc ON sc.id = p."soCardId"
    WHERE ${where.join(' AND ')} ORDER BY g."gatePassNo" DESC`, r);
  const data = [];
  for (const { id } of ids.slice((query.page - 1) * query.limit, query.page * query.limit)) data.push(await gatePassOf(req, code, id));
  return { data, total: ids.length, page: query.page, limit: query.limit };
}

module.exports = { gatePassOf, saveGatePass, listGatePasses, soCards, form, list, get, create, update, setFinal, remove };
