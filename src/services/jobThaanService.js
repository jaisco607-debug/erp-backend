// Thaans in the departments (owner 2026-11-23). A department cuts and joins the cloth to run it on its machines, so the thaans of a job change from department to department:
// 10 thaans of a lot are joined into 1 thaan in Stitching; the next department turns that 1 thaan into 5 thaans and writes their meters ... and so on until Folding grades the cloth.
//   INPUT   the thaans a department receives = the thaans the sending department made (its OUTPUT), else (cloth that came straight from the SO card) the thaans of the SO card line.
//   OUTPUT  the thaans the department makes from each cloth line (job item) of the job: typed by the department (thaan no 1..n and meters) after it accepted the job, until the cloth is sent on.
// The next department's job lines show these thaans (`thaans`, `thaanCount`); the meters of the job itself are not changed (the difference input - output is shown as `lossMeters`).
const crypto = require('crypto');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { soLabel } = require('../utils/soLabel');
const audit = require('./auditService');
const { deptByCode, need } = require('./machineService');

const n2 = (v) => Math.round(Number(v) * 100) / 100;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const MAX_THAANS = 500;

const thaanRows = (rows) => rows.map((t) => ({ thaanNo: t.thaanNo, meters: n2(t.meters) })).sort((a, b) => a.thaanNo - b.thaanNo);
const sumM = (list) => n2(list.reduce((t, x) => t + Number(x.meters || 0), 0));

/**
 * Every job item (id) -> { output: [thaans the item's own department made], from: { jobNo, department, jobItemId } | null, input: [thaans made by the nearest earlier department that wrote any] | null }.
 * The chain goes up through sourceJobItemId (department after department).
 */
async function chainsOf(itemIds, transaction) {
  const out = new Map(itemIds.map((id) => [id, { output: [], from: null, input: null, inputFull: null }]));
  if (!itemIds.length) return out;
  const own = await q('SELECT "jobItemId", "thaanNo", meters FROM job_item_thaans WHERE "jobItemId" IN (:ids)', { ids: itemIds }, transaction);
  for (const id of itemIds) out.get(id).output = thaanRows(own.filter((t) => t.jobItemId === id));
  const chain = await q(`WITH RECURSIVE chain AS (
      SELECT ji.id AS root, ji."sourceJobItemId" AS anc, 1 AS depth FROM job_items ji WHERE ji.id IN (:ids) AND ji."sourceJobItemId" IS NOT NULL
      UNION ALL
      SELECT c.root, ji."sourceJobItemId", c.depth + 1 FROM chain c JOIN job_items ji ON ji.id = c.anc WHERE ji."sourceJobItemId" IS NOT NULL AND c.depth < 30
    ) SELECT root, anc, depth FROM chain`, { ids: itemIds }, transaction);
  if (!chain.length) return out;
  const ancIds = [...new Set(chain.map((c) => c.anc))];
  const ancThaans = await q('SELECT id, "jobItemId", "thaanNo", meters FROM job_item_thaans WHERE "jobItemId" IN (:ids)', { ids: ancIds }, transaction);
  const info = await q(`SELECT ji.id, j."jobNo", s.name AS department FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN services s ON s.id = j."departmentId" WHERE ji.id IN (:ids)`, { ids: ancIds }, transaction);
  for (const id of itemIds) {
    const nearest = chain.filter((c) => c.root === id && ancThaans.some((t) => t.jobItemId === c.anc)).sort((a, b) => a.depth - b.depth)[0];
    if (!nearest) continue;
    const i = info.find((x) => x.id === nearest.anc);
    const theirs = ancThaans.filter((t) => t.jobItemId === nearest.anc);
    Object.assign(out.get(id), { input: thaanRows(theirs), inputFull: theirs.map((t) => ({ id: t.id, thaanNo: t.thaanNo, meters: n2(t.meters) })).sort((a, b) => a.thaanNo - b.thaanNo), from: { jobItemId: nearest.anc, jobNo: i ? i.jobNo : null, department: i ? i.department : null } });
  }
  return out;
}

/**
 * Puts the thaans of the departments on the job lines of a job list (the json of jobService): `thaans` / `thaanCount` become the thaans the department received when the earlier
 * department wrote its thaans; every line also has inputThaans / outputThaans (+ counts, meters, inputFrom) and the job has outputThaanCount. Changes the objects in place.
 */
async function overlay(jobs, transaction) {
  const items = jobs.flatMap((j) => j.items || []);
  if (!items.length) return jobs;
  const chains = await chainsOf(items.map((i) => i.id), transaction);
  for (const i of items) {
    const c = chains.get(i.id);
    const soThaans = i.thaans || [];
    const input = c.input || soThaans;
    Object.assign(i, {
      inputThaans: input, inputThaanCount: input.length, inputMeters: sumM(input), inputFrom: c.from,
      outputThaans: c.output, outputThaanCount: c.output.length, outputMeters: sumM(c.output), thaansRecorded: c.output.length > 0,
    });
    // what the department sees as the thaans of its cloth: the earlier department's thaans when it wrote them
    if (c.input) i.thaans = c.input.map((t) => ({ thaanNo: t.thaanNo, width: null, meters: t.meters }));
  }
  for (const j of jobs) {
    j.thaanCount = (j.items || []).reduce((t, i) => t + (i.thaans || []).length, 0);
    j.outputThaanCount = (j.items || []).reduce((t, i) => t + i.outputThaanCount, 0);
  }
  return jobs;
}

/**
 * The journey of cloth lines (job items): what the SO card had (thaans, meters) and, department after department up to the line itself, how many thaans each department received and how
 * many it made from them (`in` -> `out`, `converted` "10 -> 1"). `received` = the thaans the line's own department received (what the last earlier department made). `steps` ends with the line itself (`isCurrent`).
 * A department that wrote no thaans has `out: null` (its thaans stay those it received). Map: jobItemId -> { original, received, steps }.
 */
async function journeyOf(itemIds, transaction) {
  const res = new Map();
  if (!itemIds.length) return res;
  const chain = await q(`WITH RECURSIVE chain AS (
      SELECT ji.id AS root, ji.id AS node, 0 AS depth FROM job_items ji WHERE ji.id IN (:ids)
      UNION ALL
      SELECT c.root, ji."sourceJobItemId", c.depth + 1 FROM chain c JOIN job_items ji ON ji.id = c.node WHERE ji."sourceJobItemId" IS NOT NULL AND c.depth < 30
    ) SELECT root, node, depth FROM chain`, { ids: itemIds }, transaction);
  const nodeIds = [...new Set(chain.map((c) => c.node))];
  const info = await q(`SELECT ji.id, ji.meters::float AS meters, ji."soCardLotId", j."jobNo", j.status, svc_name(s.id, j."companyId", s.name) AS department
    FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN services s ON s.id = j."departmentId" WHERE ji.id IN (:ids)`, { ids: nodeIds }, transaction);
  const made = await q('SELECT "jobItemId", COUNT(*)::int AS n, SUM(meters)::float AS meters FROM job_item_thaans WHERE "jobItemId" IN (:ids) GROUP BY "jobItemId"', { ids: nodeIds }, transaction);
  const lotIds = [...new Set(info.map((i) => i.soCardLotId))];
  const so = lotIds.length ? await q('SELECT "soCardLotId", COUNT(DISTINCT "thaanId")::int AS n, SUM(meters)::float AS meters FROM so_card_lot_thaans WHERE "soCardLotId" IN (:ids) GROUP BY "soCardLotId"', { ids: lotIds }, transaction) : [];
  for (const id of itemIds) {
    const nodes = chain.filter((c) => c.root === id).sort((a, b) => b.depth - a.depth).map((c) => info.find((i) => i.id === c.node)).filter(Boolean);
    if (!nodes.length) continue;
    const s = so.find((x) => x.soCardLotId === nodes[0].soCardLotId);
    const original = { thaans: s ? s.n : null, meters: n2(s ? s.meters : nodes[0].meters) };
    let prev = { thaans: original.thaans, meters: original.meters };
    let received = { ...prev };
    const steps = nodes.map((node, idx) => {
      const m = made.find((x) => x.jobItemId === node.id);
      const isCurrent = idx === nodes.length - 1;
      if (isCurrent) received = { ...prev };
      const step = { jobItemId: node.id, jobNo: node.jobNo, department: node.department, status: node.status, isCurrent, in: { thaans: prev.thaans, meters: n2(node.meters) }, out: m ? { thaans: m.n, meters: n2(m.meters) } : null };
      step.converted = m && prev.thaans != null ? `${prev.thaans} -> ${m.n}` : null;
      if (m) prev = { thaans: m.n, meters: n2(m.meters) };
      return step;
    });
    res.set(id, { original, received, steps });
  }
  return res;
}

/** SO card: per lot and category what Folding graded: { a: { thaans, meters }, b, cp, total: { thaans, meters } } (a thaan graded in two categories counts in each). Map lotId -> object. */
async function gradeSplit(soCardId, transaction) {
  const rows = await q('SELECT "greyLotId" AS "lotId", "aMeters"::float AS a, "bMeters"::float AS b, "cpMeters"::float AS cp FROM folding_lines WHERE "soCardId" = :id', { id: soCardId }, transaction);
  const out = new Map();
  for (const r of rows) {
    const o = out.get(r.lotId) || { a: { thaans: 0, meters: 0 }, b: { thaans: 0, meters: 0 }, cp: { thaans: 0, meters: 0 }, total: { thaans: 0, meters: 0 } };
    for (const g of ['a', 'b', 'cp']) { if (r[g] > 0) { o[g].thaans += 1; o[g].meters = n2(o[g].meters + r[g]); } }
    if (r.a + r.b + r.cp > 0) { o.total.thaans += 1; o.total.meters = n2(o.total.meters + r.a + r.b + r.cp); }
    out.set(r.lotId, o);
  }
  return out;
}

const SENT_ON = `EXISTS (SELECT 1 FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" WHERE nx."sourceJobItemId" = ji.id AND nj.status <> 'REJECTED')`;

async function jobOf(req, dept, jobId, transaction) {
  const [j] = await q('SELECT id, "jobNo", status, "totalMeters" FROM jobs WHERE id = :jobId AND "companyId" = :companyId AND "departmentId" = :d', { jobId, companyId: req.user.companyId, d: dept.id }, transaction);
  if (!j) throw AppError.notFound('Job');
  return j;
}

/** GET /departments/:code/jobs/:jobId/thaans: per cloth line (SO card) the thaans that came and the thaans this department made. */
async function get(req, code, jobId, transaction) {
  const d = await deptByCode(req, code, transaction);
  await need(req, d, 'VIEW', transaction);
  const j = await jobOf(req, d, jobId, transaction);
  const rows = await q(`SELECT ji.id, ji."soCardId", ji."soCardLotId", ji.meters, sc."cardNo", sc."isGreyReturn", cu.name AS customer, cu.code AS "customerCode", gl."lotNo", ${SENT_ON} AS "sentOn"
    FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" JOIN customers cu ON cu.id = sc."customerId" JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId"
    WHERE ji."jobId" = :jobId ORDER BY sc."cardNo", gl."lotNo"`, { jobId }, transaction);
  const chains = await chainsOf(rows.map((r) => r.id), transaction);
  const parts = rows.length ? await q('SELECT p."soCardLotId", t."thaanNo", p.meters FROM so_card_lot_thaans p JOIN grey_lot_thaans t ON t.id = p."thaanId" WHERE p."soCardLotId" IN (:ids)', { ids: [...new Set(rows.map((r) => r.soCardLotId))] }, transaction) : [];
  const accepted = ['PENDING', 'PROCESSING', 'COMPLETE'].includes(j.status);
  const items = rows.map((r) => {
    const c = chains.get(r.id);
    const soThaans = thaanRows(parts.filter((p) => p.soCardLotId === r.soCardLotId));
    const input = c.input || soThaans;
    const inputMeters = input.length ? sumM(input) : n2(r.meters);
    const outputMeters = sumM(c.output);
    return {
      jobItemId: r.id, soCard: { id: r.soCardId, cardNo: r.cardNo, cardLabel: soLabel(r.cardNo, r.isGreyReturn) }, customer: { name: r.customer, code: r.customerCode }, lotNo: r.lotNo, meters: n2(r.meters),
      input: { source: c.input ? 'DEPARTMENT' : 'SO_CARD', from: c.from, thaans: input, count: input.length, meters: inputMeters },
      output: { thaans: c.output, count: c.output.length, meters: outputMeters, recorded: c.output.length > 0 },
      lossMeters: c.output.length ? n2(inputMeters - outputMeters) : null, sentOn: r.sentOn, canEdit: accepted && !r.sentOn,
    };
  });
  return { job: { id: j.id, jobNo: j.jobNo, status: j.status, totalMeters: n2(j.totalMeters) }, canEdit: items.some((i) => i.canEdit), items };
}

/** PUT /departments/:code/jobs/:jobId/thaans { items: [ { jobItemId, thaans: [meters, ...] } ] }: the thaans this department made (replaces the earlier list of that line; [] clears it). */
async function set(req, code, jobId, { items }) {
  await sequelize.transaction(async (transaction) => {
    const d = await deptByCode(req, code, transaction);
    await need(req, d, 'FULL', transaction);
    const j = await jobOf(req, d, jobId, transaction);
    if (['IN_WAY', 'QUEUE'].includes(j.status)) throw AppError.rule('JOB_NOT_ACCEPTED', 'Accept the job before entering its thaans');
    if (!['PENDING', 'PROCESSING', 'COMPLETE'].includes(j.status)) throw AppError.rule('JOB_CLOSED', `This job is ${j.status.toLowerCase()}`);
    for (const it of items) {
      const [row] = await q(`SELECT ji.id, ${SENT_ON} AS "sentOn" FROM job_items ji WHERE ji.id = :id AND ji."jobId" = :jobId FOR UPDATE OF ji`, { id: it.jobItemId, jobId }, transaction);
      if (!row) throw AppError.rule('UNKNOWN_ITEM', 'This cloth line is not in this job', { jobItemId: it.jobItemId });
      if (row.sentOn) throw AppError.rule('ALREADY_SENT_ON', 'This cloth has already been sent on to the next department', { jobItemId: it.jobItemId });
      // Folding / Packing may already work on these thaans (the cloth was sent on and came back): they cannot be written again
      const [used] = await q('SELECT 1 AS x FROM job_item_thaans t WHERE t."jobItemId" = :id AND (EXISTS (SELECT 1 FROM folding_lines fl WHERE fl."deptThaanId" = t.id) OR EXISTS (SELECT 1 FROM packing_list_lines pl WHERE pl."deptThaanId" = t.id)) LIMIT 1', { id: it.jobItemId }, transaction);
      if (used) throw AppError.rule('THAANS_GRADED', 'Folding has already graded these thaans: they cannot be changed', { jobItemId: it.jobItemId });
      const list = it.thaans.map((t) => n2(typeof t === 'object' ? t.meters : t));
      if (list.length > MAX_THAANS) throw AppError.rule('TOO_MANY_THAANS', `At most ${MAX_THAANS} thaans`, { jobItemId: it.jobItemId });
      if (list.some((m) => !(m > 0))) throw AppError.rule('BAD_METERS', 'Every thaan needs meters above 0', { jobItemId: it.jobItemId });
      const before = thaanRows(await q('SELECT "thaanNo", meters FROM job_item_thaans WHERE "jobItemId" = :id', { id: it.jobItemId }, transaction));
      await exec('DELETE FROM job_item_thaans WHERE "jobItemId" = :id', { id: it.jobItemId }, transaction);
      for (let i = 0; i < list.length; i += 1) {
        await exec('INSERT INTO job_item_thaans (id, "companyId", "jobId", "jobItemId", "thaanNo", meters, "createdById") VALUES (:id, :companyId, :jobId, :itemId, :no, :meters, :userId)',
          { id: crypto.randomUUID(), companyId: req.user.companyId, jobId, itemId: it.jobItemId, no: i + 1, meters: list[i], userId: req.user.id }, transaction);
      }
      await audit.log(req, { action: 'JOB_THAANS_SET', entityType: 'JobItem', entityId: it.jobItemId, before: { jobNo: j.jobNo, thaans: before }, after: { jobNo: j.jobNo, count: list.length, meters: n2(list.reduce((t, m) => t + m, 0)) } }, { transaction });
    }
  });
  return get(req, code, jobId);
}

module.exports = { overlay, chainsOf, journeyOf, gradeSplit, get, set };
