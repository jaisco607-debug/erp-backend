// Folding (v3, owner 2026-10-19). Ready cloth arrives in the Folding department as jobs. One row =
// one SO card inside one job. Inside the row the cloth is shown lot by lot, thaan by thaan (a lot
// entered in meters only has one line for the whole lot). For every line the folder splits the
// meters into A, B and CP (cut piece):
//   received = meters of the thaan that came      folded = A + B + CP
//   diff     = folded - received (+ cloth grew in processing, - it shrank)
// Graded meters go to Packing with "Send to Packing" (only what was not sent yet). What is not
// graded / not sent stays in Folding and is shown as "left in Folding" per thaan, so it can be
// graded and sent later. When nothing more will come out of a row (shrinkage, all sent), the
// folder closes the row: "all sent, keep nothing in Folding".
// Cloth can still go back to a department for RE-WORK through the normal send screen.
const { QueryTypes } = require('sequelize');
const { sequelize, FoldingEntry, Job } = require('../models');
const jobCost = require('./jobService');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const { soLabel, parseCardSearch } = require('../utils/soLabel');
const { companyServices, userServices } = require('./accessService');

const { round } = require('../utils/money');
const num = (v) => round(Number(v || 0));
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const NO_THAAN = '00000000-0000-0000-0000-000000000000';

async function foldingDept(req, code, transaction) {
  const s = (await companyServices(req.user.companyId, transaction)).find((x) => x.code === String(code).toUpperCase());
  if (!s) throw AppError.notFound('Department');
  if (s.kind !== 'FOLDING') throw AppError.rule('NOT_FOLDING', `${s.name} is not a folding department`);
  return s;
}

async function need(req, serviceId, level, transaction) {
  if (req.user.userType === 'CLIENT_ADMIN') return;
  const g = (await userServices(req.user, transaction)).find((x) => x.service.id === serviceId);
  if (!g || (level === 'FULL' && g.access !== 'FULL')) throw AppError.forbidden(level === 'FULL' ? 'You need FULL access to Folding' : 'You do not have Folding');
}

const ROWS_SQL = `
  SELECT j.id AS "jobId", j."jobNo", j."jobDate", j.status, j."isRework",
         COALESCE((SELECT string_agg(DISTINCT c2.name, ', ') FROM job_items x JOIN colours c2 ON c2.id = x."colourId" WHERE x."jobId" = j.id AND x."soCardId" = sc.id), co.name) AS colour,
         sc.id AS "soCardId", sc."cardNo", sc."idNo", sc."isGreyReturn",
         cu.id AS "customerId", cu.code AS "customerCode", cu.name AS "customerName",
         MAX(q.name) AS quality, BOOL_OR(gl."isReprocess") AS "isReprocess",
         SUM(ji.meters)::float AS "soQnty",
         -- sent back to a department for RE-WORK (not Packing)
         (SELECT string_agg(DISTINCT s.name, ', ') FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" JOIN services s ON s.id = nj."departmentId"
           WHERE nj.status <> 'REJECTED' AND s.kind <> 'PACKING' AND nx."sourceJobItemId" IN (SELECT x.id FROM job_items x WHERE x."jobId" = j.id AND x."soCardId" = sc.id)) AS "sentBackTo",
         fe.id AS "entryId", fe."pageNo", fe."isConfirmed", fe."isClosed", fe."closeNote", fe."closedAt", cb.name AS "closedByName", fe."closedById"
  FROM jobs j
  JOIN job_items ji ON ji."jobId" = j.id
  JOIN so_cards sc ON sc.id = ji."soCardId"
  JOIN customers cu ON cu.id = sc."customerId"
  JOIN so_card_lots scl ON scl.id = ji."soCardLotId"
  JOIN grey_lots gl ON gl.id = scl."greyLotId"
  LEFT JOIN qualities q ON q.id = COALESCE(sc."qualityId", gl."qualityId")
  LEFT JOIN colours co ON co.id = j."colourId"
  LEFT JOIN folding_entries fe ON fe."jobId" = j.id AND fe."soCardId" = sc.id
  LEFT JOIN users cb ON cb.id = fe."closedById"
  WHERE j."companyId" = :companyId AND j."departmentId" = :dep AND j.status <> 'REJECTED' %EXTRA%
  GROUP BY j.id, co.name, sc.id, cu.id, fe.id, cb.name`;

const sum3 = (x) => round(x.a + x.b + x.cp);

/** Builds the rows: lots -> lines (thaans) with received / A / B / CP / sent / left, plus cost. */
async function rows(req, depId, extra, replacements, transaction) {
  const base = await q(ROWS_SQL.replace('%EXTRA%', extra), { companyId: req.user.companyId, dep: depId, ...replacements }, transaction);
  if (!base.length) return [];
  const jobIds = [...new Set(base.map((r) => r.jobId))];
  const items = await q(`
    SELECT ji.id, ji."jobId", ji."soCardId", ji."soCardLotId", ji.meters::float AS meters, gl.id AS "lotId", gl."lotNo"
    FROM job_items ji JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId"
    WHERE ji."jobId" IN (:jobIds)`, { jobIds }, transaction);
  const thaans = await q(`
    SELECT ji."jobId", ji."soCardId", gl.id AS "lotId", t.id AS "thaanId", t."thaanNo", p.meters::float AS meters
    FROM job_items ji JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId"
    JOIN so_card_lot_thaans p ON p."soCardLotId" = scl.id JOIN grey_lot_thaans t ON t.id = p."thaanId"
    WHERE ji."jobId" IN (:jobIds)`, { jobIds }, transaction);
  const graded = await q(`SELECT * FROM folding_lines WHERE "jobId" IN (:jobIds)`, { jobIds }, transaction);
  const chem = await jobCost.chemicalsOf(jobIds.map((id) => ({ id })));
  const prev = await jobCost.previousCosts(items.map((i) => i.id));

  return base.map((r) => {
    const mine = items.filter((i) => i.jobId === r.jobId && i.soCardId === r.soCardId);
    const jobM = items.filter((i) => i.jobId === r.jobId).reduce((t, i) => t + i.meters, 0);
    const cardM = mine.reduce((t, i) => t + i.meters, 0);
    const here = jobCost.chemicalCols(chem.get(r.jobId), cardM, { id: r.soCardId, share: jobM ? cardM / jobM : 0 }).chemicalAmount;
    const before = round(mine.reduce((t, i) => t + (prev.get(i.id) || 0), 0));
    const totalCost = round(before + here);
    const perMeter = cardM ? totalCost / cardM : 0;

    const closed = Boolean(r.isClosed);
    const lots = [];
    for (const lotId of [...new Set(mine.map((i) => i.lotId))]) {
      const lotItems = mine.filter((i) => i.lotId === lotId);
      const lotThaans = [...new Map(thaans.filter((t) => t.jobId === r.jobId && t.soCardId === r.soCardId && t.lotId === lotId).map((t) => [t.thaanId, t])).values()]
        .sort((a, b) => a.thaanNo - b.thaanNo);
      const src = lotThaans.length
        ? lotThaans.map((t) => ({ thaanId: t.thaanId, thaanNo: t.thaanNo, received: num(t.meters) }))
        : [{ thaanId: null, thaanNo: null, received: num(lotItems.reduce((t, i) => t + i.meters, 0)) }];
      const lines = src.map((s) => {
        const g = graded.find((x) => x.jobId === r.jobId && x.soCardId === r.soCardId && x.greyLotId === lotId && (x.thaanId || null) === s.thaanId) || {};
        const grade = { a: num(g.aMeters), b: num(g.bMeters), cp: num(g.cpMeters) };
        const sent = { a: num(g.sentA), b: num(g.sentB), cp: num(g.sentCP) };
        const folded = sum3(grade);
        const inFolding = { a: round(grade.a - sent.a), b: round(grade.b - sent.b), cp: round(grade.cp - sent.cp) };
        return {
          thaanId: s.thaanId, thaanNo: s.thaanNo, label: s.thaanId ? `Thaan ${s.thaanNo}` : 'Whole lot',
          received: s.received, ...grade, folded,
          // gain / loss is known only when the whole thaan is graded or the row is closed;
          // cloth still waiting in Folding is not a loss (owner 2026-10-19)
          diff: folded && (closed || folded >= s.received) ? round(folded - s.received) : 0,
          notGraded: Math.max(0, round(s.received - folded)),
          // still to be graded and sent: the grade boxes are for this batch only
          remaining: Math.max(0, round(s.received - sent.a - sent.b - sent.cp)),
          isGraded: folded > 0,
          sent: { ...sent, total: sum3(sent) },
          // graded but not sent to Packing yet
          inFolding: { ...inFolding, total: sum3(inFolding) },
          cost: round(perMeter * s.received),
        };
      });
      const t = (f) => round(lines.reduce((x, l) => x + f(l), 0));
      lots.push({
        lotId, lotNo: lotItems[0].lotNo, hasThaans: lotThaans.length > 0, thaanCount: lotThaans.length,
        jobItemIds: lotItems.map((i) => i.id),
        received: t((l) => l.received), a: t((l) => l.a), b: t((l) => l.b), cp: t((l) => l.cp), folded: t((l) => l.folded),
        sent: t((l) => l.sent.total), inFolding: t((l) => l.inFolding.total), notGraded: t((l) => l.notGraded),
        lines,
      });
    }
    lots.sort((a, b) => a.lotNo - b.lotNo);
    const all = lots.flatMap((l) => l.lines);
    const t = (f) => round(all.reduce((x, l) => x + f(l), 0));
    const totals = {
      received: t((l) => l.received), a: t((l) => l.a), b: t((l) => l.b), cp: t((l) => l.cp), folded: t((l) => l.folded),
      sentA: t((l) => l.sent.a), sentB: t((l) => l.sent.b), sentCP: t((l) => l.sent.cp), sent: t((l) => l.sent.total),
      inFolding: t((l) => l.inFolding.total), notGraded: t((l) => l.notGraded),
    };
    totals.diff = t((l) => l.diff);
    const accepted = !['IN_WAY', 'QUEUE'].includes(r.status);
    // cloth still in Folding: graded-not-sent, plus not graded yet unless the row is closed
    const leftInFolding = round(totals.inFolding + (closed ? 0 : totals.notGraded));
    return {
      jobId: r.jobId, jobNo: r.jobNo, jobDate: r.jobDate, jobStatus: r.status,
      pageNo: r.pageNo || '0',
      soCard: { id: r.soCardId, cardNo: r.cardNo, cardLabel: soLabel(r.cardNo, r.isGreyReturn), idNo: r.idNo },
      customer: { id: r.customerId, code: r.customerCode, name: r.customerName },
      quality: r.quality, colour: r.colour,
      isReprocess: r.isReprocess, isRework: r.isRework,
      // unprocessed cloth going back to the party: no grading, only Send to Packing
      isGreyReturn: Boolean(r.isGreyReturn), tagText: r.isGreyReturn ? 'Fabric return grey (not processed)' : null,
      lots, totals,
      leftInFolding,
      isClosed: closed, closeNote: r.closeNote || null, closedAt: r.closedAt || null,
      closedBy: r.closedById ? { id: r.closedById, name: r.closedByName } : null,
      cost: { previousChemicalAmount: before, foldingChemicalAmount: here, totalCost, costPerMeter: round(perMeter, 4) },
      categoryCost: { a: round(perMeter * totals.a), b: round(perMeter * totals.b), cp: round(perMeter * totals.cp) },
      sentForRework: Boolean(r.sentBackTo), sentBackTo: r.sentBackTo || null,
      isConfirmed: Boolean(r.isConfirmed),
      canGrade: accepted && !closed && !r.sentBackTo && !r.isGreyReturn,
      canSendPacking: accepted && (r.isGreyReturn ? round(totals.received - totals.sent) > 0 : totals.inFolding > 0),
      canClose: accepted && !closed,
      // old field names (summary list): soQnty = received meters
      soQnty: num(r.soQnty), stock: { a: totals.a, b: totals.b, cp: totals.cp, total: totals.folded },
    };
  });
}

/** The Folding list. tab=all | open (cloth still in Folding) | draft (not confirmed). */
async function list(req, code, query) {
  const d = await foldingDept(req, code);
  await need(req, d.id, 'VIEW');
  let all = await rows(req, d.id, '', {});
  const draftCount = all.filter((r) => !r.isConfirmed).length;
  const openCount = all.filter((r) => r.leftInFolding > 0).length;
  if (query.tab === 'draft') all = all.filter((r) => !r.isConfirmed);
  if (query.tab === 'open') all = all.filter((r) => r.leftInFolding > 0);
  const cs = query.search ? parseCardSearch(query.search) : null;
  if (cs) all = all.filter((r) => (!cs.grey && r.jobNo === cs.n) || (r.soCard.cardNo === cs.n && (!cs.grey || r.isGreyReturn)));
  if (query.dateFrom) all = all.filter((r) => r.jobDate >= query.dateFrom);
  if (query.dateTo) all = all.filter((r) => r.jobDate <= query.dateTo);
  all.sort((x, y) => y.jobNo - x.jobNo || y.soCard.cardNo - x.soCard.cardNo);
  const total = all.length;
  const data = all.slice((query.page - 1) * query.limit, query.page * query.limit);
  return { data, draftCount, openCount, page: query.page, limit: query.limit, total };
}

async function findRow(req, depId, jobId, soCardId, transaction) {
  const [row] = await rows(req, depId, 'AND j.id = :jobId AND sc.id = :soCardId', { jobId, soCardId }, transaction);
  if (!row) throw AppError.notFound('Folding row');
  return row;
}

async function get(req, code, jobId, soCardId) {
  const d = await foldingDept(req, code);
  await need(req, d.id, 'VIEW');
  return findRow(req, d.id, jobId, soCardId);
}

async function entryOf(req, jobId, soCardId, transaction) {
  const [entry] = await FoldingEntry.findOrCreate({ where: { jobId, soCardId }, defaults: { companyId: req.user.companyId, createdById: req.user.id }, transaction });
  return entry;
}

/** Page no only (the grading goes through saveGrades). */
async function save(req, code, jobId, soCardId, { pageNo }) {
  return sequelize.transaction(async (transaction) => {
    const d = await foldingDept(req, code, transaction);
    await need(req, d.id, 'FULL', transaction);
    await findRow(req, d.id, jobId, soCardId, transaction);
    const entry = await entryOf(req, jobId, soCardId, transaction);
    entry.pageNo = pageNo || null;
    await entry.save({ transaction });
    return findRow(req, d.id, jobId, soCardId, transaction);
  });
}

/**
 * Split thaans into A / B / CP. lines: [{ greyLotId, thaanId (null = whole lot without thaans), a, b, cp }].
 * a / b / cp are THIS BATCH only (not sent to Packing yet); what was already sent is added on top
 * (owner 2026-10-19: after sending 4700 of 5000, the folder grades only the 300 left).
 */
async function saveGrades(req, code, jobId, soCardId, { pageNo, lines }) {
  return sequelize.transaction(async (transaction) => {
    const d = await foldingDept(req, code, transaction);
    await need(req, d.id, 'FULL', transaction);
    await Job.findOne({ where: { id: jobId, companyId: req.user.companyId }, lock: transaction.LOCK.UPDATE, transaction });
    const before = await findRow(req, d.id, jobId, soCardId, transaction);
    if (!['PENDING', 'PROCESSING', 'COMPLETE'].includes(before.jobStatus)) throw AppError.rule('NOT_ACCEPTED', 'Accept the cloth first');
    if (before.isClosed) throw AppError.rule('ROW_CLOSED', 'This row is closed; open it again to change the grading');
    if (before.isGreyReturn) throw AppError.rule('GREY_RETURN_NO_GRADING', 'This cloth is a fabric return (not processed); send it to Packing as it is');
    if (before.sentForRework) throw AppError.rule('SENT_FOR_REWORK', 'This cloth was sent back for re-work');
    const seen = new Set();
    for (const l of lines) {
      const lot = before.lots.find((x) => x.lotId === l.greyLotId);
      const line = lot && lot.lines.find((x) => x.thaanId === (l.thaanId || null));
      if (!line) throw AppError.rule('UNKNOWN_THAAN', 'This thaan / lot is not in this SO card');
      const key = `${l.greyLotId}:${l.thaanId || ''}`;
      if (seen.has(key)) throw AppError.rule('DUPLICATE_THAAN', `${line.label} of lot ${lot.lotNo} is given twice`);
      seen.add(key);
      const a = round(line.sent.a + (l.a ?? line.inFolding.a));
      const b = round(line.sent.b + (l.b ?? line.inFolding.b));
      const cp = round(line.sent.cp + (l.cp ?? line.inFolding.cp));
      await sequelize.query(`
        INSERT INTO folding_lines (id, "companyId", "jobId", "soCardId", "greyLotId", "thaanId", "aMeters", "bMeters", "cpMeters", "updatedById")
        VALUES (gen_random_uuid(), :companyId, :jobId, :soCardId, :lotId, :thaanId, :a, :b, :cp, :userId)
        ON CONFLICT ("jobId", "soCardId", "greyLotId", COALESCE("thaanId", '${NO_THAAN}'))
        DO UPDATE SET "aMeters" = EXCLUDED."aMeters", "bMeters" = EXCLUDED."bMeters", "cpMeters" = EXCLUDED."cpMeters", "updatedById" = EXCLUDED."updatedById", "updatedAt" = now()`,
      { replacements: { companyId: req.user.companyId, jobId, soCardId, lotId: l.greyLotId, thaanId: l.thaanId || null, a, b, cp, userId: req.user.id }, transaction });
    }
    const entry = await entryOf(req, jobId, soCardId, transaction);
    const after0 = await findRow(req, d.id, jobId, soCardId, transaction);
    Object.assign(entry, { aMeters: after0.totals.a, bMeters: after0.totals.b, cpMeters: after0.totals.cp });
    if (pageNo !== undefined) entry.pageNo = pageNo || null;
    await entry.save({ transaction });
    const after = await findRow(req, d.id, jobId, soCardId, transaction);
    await audit.log(req, { action: 'FOLDING_GRADED', entityType: 'FoldingEntry', entityId: entry.id, before: { totals: before.totals }, after: { jobNo: after.jobNo, soNo: after.soCard.cardNo, totals: after.totals, lines } }, { transaction });
    return after;
  });
}

/**
 * Sends everything graded and not sent yet to Packing (one new Packing job).
 * keepRemaining=false closes the row: the cloth that was not graded is not kept in Folding.
 */
async function sendToPacking(req, code, jobId, soCardId, { keepRemaining = true, closeNote, sentThrough, remarks, jobDate }) {
  return sequelize.transaction(async (transaction) => {
    const d = await foldingDept(req, code, transaction);
    await need(req, d.id, 'FULL', transaction);
    await Job.findOne({ where: { id: jobId, companyId: req.user.companyId }, lock: transaction.LOCK.UPDATE, transaction });
    let row = await findRow(req, d.id, jobId, soCardId, transaction);
    if (row.isGreyReturn && row.canSendPacking) {
      // not processed: every thaan goes as it is (shown as A, no grading)
      for (const lot of row.lots) {
        for (const l of lot.lines) {
          if (l.folded > 0) continue;
          await sequelize.query(`
            INSERT INTO folding_lines (id, "companyId", "jobId", "soCardId", "greyLotId", "thaanId", "aMeters", "bMeters", "cpMeters", "updatedById")
            VALUES (gen_random_uuid(), :companyId, :jobId, :soCardId, :lotId, :thaanId, :a, 0, 0, :userId)
            ON CONFLICT ("jobId", "soCardId", "greyLotId", COALESCE("thaanId", '${NO_THAAN}')) DO UPDATE SET "aMeters" = EXCLUDED."aMeters", "updatedAt" = now()`,
          { replacements: { companyId: req.user.companyId, jobId, soCardId, lotId: lot.lotId, thaanId: l.thaanId, a: l.received, userId: req.user.id }, transaction });
        }
      }
      row = await findRow(req, d.id, jobId, soCardId, transaction);
    }
    if (!row.canSendPacking) throw AppError.rule('NOTHING_TO_SEND', 'Grade the thaans first; nothing graded is waiting to be sent');
    const packing = (await companyServices(req.user.companyId, transaction)).find((s) => s.kind === 'PACKING');
    if (!packing) throw AppError.rule('NO_PACKING', 'Your company does not have the Packing department');
    // meters per job item (lot) of this SO card
    const items = [];
    for (const lot of row.lots) {
      if (lot.inFolding <= 0) continue;
      items.push({ jobItemId: lot.jobItemIds[0], meters: lot.inFolding });
    }
    const job = await jobCost.create(req, {
      fromDepartmentId: d.id, departmentId: packing.id, jobDate, sentThrough, remarks, items, partial: true,
    }, transaction);
    await sequelize.query(`UPDATE folding_lines SET "sentA" = "aMeters", "sentB" = "bMeters", "sentCP" = "cpMeters", "updatedAt" = now()
      WHERE "jobId" = :jobId AND "soCardId" = :soCardId`, { replacements: { jobId, soCardId }, transaction });
    if (!keepRemaining) {
      const entry = await entryOf(req, jobId, soCardId, transaction);
      Object.assign(entry, { isClosed: true, closeNote: closeNote || null, closedById: req.user.id, closedAt: new Date() });
      await entry.save({ transaction });
    }
    const after = await findRow(req, d.id, jobId, soCardId, transaction);
    await audit.log(req, { action: 'FOLDING_SENT_TO_PACKING', entityType: 'Job', entityId: job.id, after: { packingJobNo: job.jobNo, soNo: row.soCard.cardNo, a: row.totals.a - row.totals.sentA, b: row.totals.b - row.totals.sentB, cp: row.totals.cp - row.totals.sentCP, keepRemaining } }, { transaction });
    return { packingJob: { id: job.id, jobNo: job.jobNo, totalMeters: job.totalMeters }, row: after };
  });
}

/** Close (keep nothing more in Folding) or open the row again. */
async function setClosed(req, code, jobId, soCardId, { isClosed, closeNote }) {
  return sequelize.transaction(async (transaction) => {
    const d = await foldingDept(req, code, transaction);
    await need(req, d.id, 'FULL', transaction);
    const row = await findRow(req, d.id, jobId, soCardId, transaction);
    if (['IN_WAY', 'QUEUE'].includes(row.jobStatus)) throw AppError.rule('NOT_ACCEPTED', 'Accept the cloth first');
    const entry = await entryOf(req, jobId, soCardId, transaction);
    Object.assign(entry, isClosed
      ? { isClosed: true, closeNote: closeNote || null, closedById: req.user.id, closedAt: new Date() }
      : { isClosed: false, closeNote: null, closedById: null, closedAt: null });
    await entry.save({ transaction });
    await audit.log(req, { action: isClosed ? 'FOLDING_CLOSED' : 'FOLDING_REOPENED', entityType: 'FoldingEntry', entityId: entry.id, after: { jobNo: row.jobNo, soNo: row.soCard.cardNo, leftInFolding: row.leftInFolding, closeNote: closeNote || null } }, { transaction });
    return findRow(req, d.id, jobId, soCardId, transaction);
  });
}

/** The Conf. toggle (kept from v1). */
async function setConfirmed(req, code, jobId, soCardId, isConfirmed) {
  return sequelize.transaction(async (transaction) => {
    const d = await foldingDept(req, code, transaction);
    await need(req, d.id, 'FULL', transaction);
    const row = await findRow(req, d.id, jobId, soCardId, transaction);
    if (isConfirmed && row.totals.folded <= 0) throw AppError.rule('NOTHING_GRADED', 'Grade the thaans before confirming');
    const entry = await entryOf(req, jobId, soCardId, transaction);
    Object.assign(entry, { isConfirmed, confirmedById: isConfirmed ? req.user.id : null, confirmedAt: isConfirmed ? new Date() : null });
    await entry.save({ transaction });
    await audit.log(req, { action: isConfirmed ? 'FOLDING_CONFIRMED' : 'FOLDING_UNCONFIRMED', entityType: 'FoldingEntry', entityId: entry.id, after: { jobNo: row.jobNo, soNo: row.soCard.cardNo } }, { transaction });
    return findRow(req, d.id, jobId, soCardId, transaction);
  });
}

module.exports = { rows, list, get, save, saveGrades, sendToPacking, setClosed, setConfirmed };
