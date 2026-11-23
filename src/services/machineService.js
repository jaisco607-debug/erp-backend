// Process Management > Machines (service of the department; the client admin sets them up in Settings > Machines).
//   Settings (client admin): which process departments have machines (ON / OFF), the prefix of their machine names, add / switch off / delete machines.
//   Machine name = PREFIX-NN (prefix = letters of the department, unique in the company; NN = a running number of the department), so no two machines of a company ever share a name.
//   Work (department people): a job that is accepted is assigned to a machine ("run"): operator name, meters that came (in), meters made (out), RUNNING -> DONE.
//   A machine runs one job at a time; a job may be split on several machines (meters of each); a machine may run several jobs one after the other.
//   Reports: the machines of a department (free / running / off), who runs what, and the cloth processed per machine and per operator.
const crypto = require('crypto');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { soLabel } = require('../utils/soLabel');
const audit = require('./auditService');
const { companyServices, userServices } = require('./accessService');

const n2 = (v) => Math.round(Number(v) * 100) / 100;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad = (n) => String(n).padStart(2, '0');
const PREFIX_RE = /^[A-Z][A-Z0-9]{1,5}$/;

// ---- departments and access ----
const processDepartments = async (req, transaction) => (await companyServices(req.user.companyId, transaction)).filter((s) => s.kind === 'PROCESS');

async function deptByCode(req, code, transaction) {
  const d = (await processDepartments(req, transaction)).find((x) => x.code === String(code).toUpperCase() || x.id === code);
  if (!d) throw AppError.notFound('Department');
  return d;
}

/** 'FULL' | 'VIEW' | null: what the signed-in person may do in a department of his company. */
async function accessTo(req, serviceId, transaction) {
  if (req.user.userType === 'CLIENT_ADMIN') return 'FULL';
  const g = (await userServices(req.user, transaction)).find((x) => x.service.id === serviceId);
  return g ? g.access : null;
}
async function need(req, dept, level, transaction) {
  const a = await accessTo(req, dept.id, transaction);
  if (!a || (level === 'FULL' && a !== 'FULL')) throw AppError.forbidden(level === 'FULL' ? 'You need FULL access to this department' : 'You do not have this department');
}

async function flagsOf(companyId, transaction) {
  const rows = await q('SELECT "serviceId", machines, "machinePrefix" FROM company_services WHERE "companyId" = :companyId', { companyId }, transaction);
  return new Map(rows.map((r) => [r.serviceId, { enabled: r.machines, prefix: r.machinePrefix }]));
}

// ---- the prefix of the machine names ----
/** DYEING -> DYE, STITCHING -> STI: the first letters of the name; longer / the initials / a number when another department of the company already has it. */
function suggestPrefix(name, taken) {
  const words = String(name || '').toUpperCase().normalize('NFKD').replace(/[^A-Z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const first = (words[0] || 'DEP').replace(/[^A-Z]/g, '') || 'DEP';
  const tries = [];
  for (let len = Math.min(3, first.length); len <= Math.min(6, first.length); len += 1) tries.push(first.slice(0, len));
  if (words.length > 1) tries.push(words.map((w) => w[0]).join('').slice(0, 6));
  for (const t of tries) if (PREFIX_RE.test(t) && !taken.has(t)) return t;
  const base = (tries[0] || 'DEP').slice(0, 4).padEnd(2, 'X');
  for (let i = 2; i < 100; i += 1) { const c = `${base}${i}`; if (PREFIX_RE.test(c) && !taken.has(c)) return c; }
  return `D${crypto.randomInt(1000, 99999)}`;
}
const takenPrefixes = (flags, exceptId) => new Set([...flags.entries()].filter(([id, f]) => id !== exceptId && f.prefix).map(([, f]) => f.prefix));

// ---- machines with their state ----
async function soLabelsOf(jobIds) {
  if (!jobIds.length) return new Map();
  const rows = await q('SELECT DISTINCT ji."jobId", sc."cardNo", sc."isGreyReturn" FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" WHERE ji."jobId" IN (:jobIds) ORDER BY sc."cardNo"', { jobIds });
  const by = new Map();
  for (const r of rows) by.set(r.jobId, [...(by.get(r.jobId) || []), soLabel(r.cardNo, r.isGreyReturn)]);
  return by;
}
const runJSON = (r, labels) => ({
  id: r.id, machine: { id: r.machineId, name: r.machineName }, job: { id: r.jobId, jobNo: r.jobNo, status: r.jobStatus }, soLabels: labels ? labels.get(r.jobId) || [] : undefined,
  operatorName: r.operatorName, inMeters: n2(r.inMeters), outMeters: r.outMeters == null ? null : n2(r.outMeters), lossMeters: r.status === 'DONE' && r.outMeters != null ? n2(r.inMeters - r.outMeters) : null,
  status: r.status, statusText: r.status === 'RUNNING' ? 'Running' : 'Done', runDate: r.runDate, startedAt: r.startedAt, finishedAt: r.finishedAt, notes: r.notes,
});
const RUN_SQL = `SELECT r.*, to_char(r."runDate", 'YYYY-MM-DD') AS "runDay", m.name AS "machineName", j."jobNo", j.status AS "jobStatus" FROM machine_runs r JOIN machines m ON m.id = r."machineId" JOIN jobs j ON j.id = r."jobId"`;
const withDay = (r) => ({ ...r, runDate: r.runDay });

/** The machines of a department: state (FREE / RUNNING / DISABLED), what runs on each, and what it processed in the dates asked (all time when none). */
async function machinesOf(companyId, departmentId, { dateFrom, dateTo } = {}) {
  const ms = await q('SELECT id, number, name, notes, "isActive", "createdAt" FROM machines WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "deletedAt" IS NULL ORDER BY number', { companyId, departmentId });
  if (!ms.length) return [];
  const rep = { ids: ms.map((m) => m.id), from: dateFrom || null, to: dateTo || null };
  const running = await q(`${RUN_SQL} WHERE r."machineId" IN (:ids) AND r.status = 'RUNNING'`, rep);
  const labels = await soLabelsOf([...new Set(running.map((r) => r.jobId))]);
  const stats = await q(`SELECT "machineId", COUNT(*)::int AS runs, COALESCE(SUM("inMeters"), 0) AS "inMeters", COALESCE(SUM("outMeters"), 0) AS "outMeters", COUNT(DISTINCT lower(trim("operatorName")))::int AS operators
    FROM machine_runs WHERE "machineId" IN (:ids) AND (:from::date IS NULL OR "runDate" >= :from::date) AND (:to::date IS NULL OR "runDate" <= :to::date) GROUP BY "machineId"`, rep);
  const todayStats = await q('SELECT "machineId", COALESCE(SUM("inMeters"), 0) AS "inMeters" FROM machine_runs WHERE "machineId" IN (:ids) AND "runDate" = :today GROUP BY "machineId"', { ids: rep.ids, today: today() });
  return ms.map((m) => {
    const run = running.find((r) => r.machineId === m.id);
    const s = stats.find((x) => x.machineId === m.id);
    const t = todayStats.find((x) => x.machineId === m.id);
    return {
      id: m.id, number: m.number, name: m.name, notes: m.notes, isActive: m.isActive, state: !m.isActive ? 'DISABLED' : run ? 'RUNNING' : 'FREE', stateText: !m.isActive ? 'Switched off' : run ? 'Running' : 'Free',
      current: run ? { ...runJSON(withDay(run), labels), minutesRunning: Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 60000)) } : null,
      totals: { runs: s ? s.runs : 0, inMeters: s ? n2(s.inMeters) : 0, outMeters: s ? n2(s.outMeters) : 0, operators: s ? s.operators : 0 }, todayInMeters: t ? n2(t.inMeters) : 0,
      canDisable: !run, canDelete: !run, canRename: true,
    };
  });
}
const countsOf = (list) => ({ total: list.length, active: list.filter((m) => m.isActive).length, free: list.filter((m) => m.state === 'FREE').length, running: list.filter((m) => m.state === 'RUNNING').length, disabled: list.filter((m) => !m.isActive).length });

// ---- Settings > Machines (client admin) ----
/** GET /machine-settings: every process department with its machines switch, prefix and counts. */
async function settings(req) {
  const { companyId } = req.user;
  const depts = await processDepartments(req);
  const flags = await flagsOf(companyId);
  const out = [];
  for (const d of depts) {
    const f = flags.get(d.id) || { enabled: false, prefix: null };
    const [c] = await q(`SELECT COUNT(*) FILTER (WHERE "deletedAt" IS NULL)::int AS n, COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND "isActive")::int AS active,
        COUNT(*)::int AS "ever", (SELECT COUNT(*)::int FROM machine_runs r WHERE r."departmentId" = :d AND r.status = 'RUNNING') AS running
      FROM machines WHERE "companyId" = :companyId AND "departmentId" = :d`, { companyId, d: d.id });
    out.push({
      id: d.id, code: d.code, name: d.name, machinesEnabled: f.enabled, prefix: f.prefix, suggestedPrefix: f.prefix || suggestPrefix(d.name, takenPrefixes(flags, d.id)),
      machineCount: c.n, activeCount: c.active, runningCount: c.running, freeCount: Math.max(0, c.active - c.running),
      canChangePrefix: true, canDisable: c.running === 0,
    });
  }
  return { data: out };
}

/** PATCH /machine-settings/:code { machinesEnabled?, prefix? }. */
async function setDepartment(req, code, { machinesEnabled, prefix }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const d = await deptByCode(req, code, transaction);
    const flags = await flagsOf(companyId, transaction);
    const f = flags.get(d.id) || { enabled: false, prefix: null };
    const before = { machinesEnabled: f.enabled, prefix: f.prefix };
    let nextPrefix = f.prefix;
    if (prefix !== undefined) {
      const p = String(prefix).trim().toUpperCase();
      if (!PREFIX_RE.test(p)) throw AppError.rule('BAD_PREFIX', 'The prefix is 2 to 6 letters or numbers and starts with a letter', { field: 'prefix' });
      if (p !== f.prefix) {
        if (takenPrefixes(flags, d.id).has(p)) throw AppError.rule('PREFIX_TAKEN', `The prefix ${p} is used by another department`, { field: 'prefix' });
        nextPrefix = p;
      }
    }
    let enabled = f.enabled;
    if (machinesEnabled !== undefined) {
      if (machinesEnabled === false && f.enabled) {
        const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM machine_runs WHERE "departmentId" = :d AND status = 'RUNNING'`, { d: d.id }, transaction);
        if (n) throw AppError.rule('MACHINES_RUNNING', `${n} machine(s) are running: finish their work before switching the machines off`, { running: n });
      }
      enabled = machinesEnabled;
    }
    if (enabled && !nextPrefix) nextPrefix = suggestPrefix(d.name, takenPrefixes(flags, d.id));
    await exec('UPDATE company_services SET machines = :enabled, "machinePrefix" = :prefix WHERE "companyId" = :companyId AND "serviceId" = :d', { enabled, prefix: nextPrefix, companyId, d: d.id }, transaction);
    // a new prefix renames the machines of the department (DYE-03 -> DYG-03): the history keeps pointing at the same machines
    if (f.prefix && nextPrefix !== f.prefix) await exec("UPDATE machines SET name = :prefix || substring(name from position('-' in name)), \"updatedAt\" = now() WHERE \"companyId\" = :companyId AND \"departmentId\" = :d", { prefix: nextPrefix, companyId, d: d.id }, transaction);
    await audit.log(req, { action: 'DEPARTMENT_MACHINES_SET', entityType: 'Service', entityId: d.id, before: { department: d.name, ...before }, after: { machinesEnabled: enabled, prefix: nextPrefix } }, { transaction });
  });
}

/** GET /machine-settings/:code/machines. */
async function listMachines(req, code) {
  const d = await deptByCode(req, code);
  const flags = await flagsOf(req.user.companyId);
  const f = flags.get(d.id) || { enabled: false, prefix: null };
  const machines = await machinesOf(req.user.companyId, d.id);
  return { department: { id: d.id, code: d.code, name: d.name }, machinesEnabled: f.enabled, prefix: f.prefix, counts: countsOf(machines), data: machines };
}

/** POST /machine-settings/:code/machines { count } adds machines PREFIX-01, PREFIX-02 ... (the next numbers of the department). */
async function addMachines(req, code, { count = 1, notes }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const d = await deptByCode(req, code, transaction);
    await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `machines:${companyId}` }, transaction);
    const f = (await flagsOf(companyId, transaction)).get(d.id) || {};
    if (!f.enabled || !f.prefix) throw AppError.rule('MACHINES_OFF', 'Switch the machines of this department on first', { code: d.code });
    const [{ last }] = await q('SELECT COALESCE(MAX(number), 0) AS last FROM machines WHERE "companyId" = :companyId AND "departmentId" = :d', { companyId, d: d.id }, transaction);
    const names = [];
    for (let i = 1; i <= count; i += 1) {
      const number = Number(last) + i; const name = `${f.prefix}-${pad(number)}`;
      await exec('INSERT INTO machines (id, "companyId", "departmentId", number, name, notes, "createdById") VALUES (:id, :companyId, :d, :number, :name, :notes, :userId)', { id: crypto.randomUUID(), companyId, d: d.id, number, name, notes: notes || null, userId: req.user.id }, transaction);
      names.push(name);
    }
    await audit.log(req, { action: 'MACHINES_ADDED', entityType: 'Machine', entityId: d.id, after: { department: d.name, names } }, { transaction });
  });
  return listMachines(req, code);
}

async function machineOr404(req, id, transaction) {
  const [m] = await q('SELECT id, "departmentId", name, "isActive" FROM machines WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL', { id, companyId: req.user.companyId }, transaction);
  if (!m) throw AppError.notFound('Machine');
  return m;
}

/** PATCH /machine-settings/machines/:id { isActive?, notes? } */
async function updateMachine(req, id, { name, isActive, notes }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const m = await machineOr404(req, id, transaction);
    const set = {};
    if (name !== undefined) {
      const f = (await flagsOf(companyId, transaction)).get(m.departmentId) || {};
      const n = String(name).trim().toUpperCase();
      if (!f.prefix || !new RegExp(`^${f.prefix}-[A-Z0-9]{1,10}$`).test(n)) throw AppError.rule('BAD_NAME', `The name of a machine of this department is ${f.prefix || 'PREFIX'}- and 1 to 10 letters or numbers (e.g. ${f.prefix || 'DYE'}-07)`, { field: 'name' });
      if (n !== m.name) {
        const [dup] = await q('SELECT id FROM machines WHERE "companyId" = :companyId AND lower(name) = lower(:n) AND id <> :id', { companyId, n, id }, transaction);
        if (dup) throw AppError.rule('NAME_TAKEN', `${n} already exists`, { field: 'name' });
        set.name = n;
      }
    }
    if (isActive !== undefined && isActive !== m.isActive) {
      if (isActive === false) {
        const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM machine_runs WHERE "machineId" = :id AND status = 'RUNNING'`, { id }, transaction);
        if (n) throw AppError.rule('MACHINE_RUNNING', `${m.name} is running a job: finish it before switching the machine off`);
      }
      set.isActive = isActive;
    }
    if (notes !== undefined) set.notes = notes || null;
    const keys = Object.keys(set);
    if (keys.length) {
      await exec(`UPDATE machines SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :id`, { ...set, id }, transaction);
      await audit.log(req, { action: 'MACHINE_UPDATED', entityType: 'Machine', entityId: id, before: { name: m.name, isActive: m.isActive }, after: { name: m.name, ...set } }, { transaction });
    }
    return void companyId;
  }).then(async () => {
    const [m] = await q('SELECT "departmentId" FROM machines WHERE id = :id', { id });
    const d = (await processDepartments(req)).find((x) => x.id === m.departmentId);
    return listMachines(req, d.code);
  });
}

/** DELETE /machine-settings/machines/:id: the machine leaves the lists; its earlier runs stay in the reports under its name. Not while it is running a job. */
async function removeMachine(req, id) {
  const m = await sequelize.transaction(async (transaction) => {
    const x = await machineOr404(req, id, transaction);
    const [{ n }] = await q("SELECT COUNT(*)::int AS n FROM machine_runs WHERE \"machineId\" = :id AND status = 'RUNNING'", { id }, transaction);
    if (n) throw AppError.rule('MACHINE_RUNNING', `${x.name} is running a job: finish it before deleting the machine`);
    const [{ runs }] = await q('SELECT COUNT(*)::int AS runs FROM machine_runs WHERE "machineId" = :id', { id }, transaction);
    await exec('UPDATE machines SET "deletedAt" = now(), "isActive" = false, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'MACHINE_DELETED', entityType: 'Machine', entityId: id, before: { name: x.name, runs } }, { transaction });
    return x;
  });
  const d = (await processDepartments(req)).find((x) => x.id === m.departmentId);
  return listMachines(req, d.code);
}

// ---- the department: its machines, the work on them ----
/** GET /departments/:code/machines: the board of the department (free / running / off), with who runs what. */
async function overview(req, code, { dateFrom, dateTo } = {}) {
  const { companyId } = req.user;
  const d = await deptByCode(req, code);
  await need(req, d, 'VIEW');
  const f = (await flagsOf(companyId)).get(d.id) || { enabled: false, prefix: null };
  const machines = f.enabled ? await machinesOf(companyId, d.id, { dateFrom, dateTo }) : [];
  const working = machines.filter((m) => m.current).map((m) => ({ machine: m.name, operatorName: m.current.operatorName, jobNo: m.current.job.jobNo, soLabels: m.current.soLabels, inMeters: m.current.inMeters }));
  return {
    department: { id: d.id, code: d.code, name: d.name }, enabled: f.enabled, prefix: f.prefix, counts: countsOf(machines), operatorsWorking: [...new Set(working.map((w) => w.operatorName.toLowerCase()))].length,
    working, machines,
  };
}

async function jobOf(req, dept, jobId, transaction, lock = false) {
  const [j] = await q(`SELECT id, "jobNo", status, "totalMeters", "operatorName", "processDate", "departmentId" FROM jobs WHERE id = :jobId AND "companyId" = :companyId AND "departmentId" = :d${lock ? ' FOR UPDATE' : ''}`, { jobId, companyId: req.user.companyId, d: dept.id }, transaction);
  if (!j) throw AppError.notFound('Job');
  return j;
}
const sentOn = async (jobId, transaction) => (await q(`SELECT 1 FROM job_items nx JOIN jobs nj ON nj.id = nx."jobId" JOIN job_items ji ON ji.id = nx."sourceJobItemId" WHERE ji."jobId" = :jobId AND nj.status <> 'REJECTED' LIMIT 1`, { jobId }, transaction)).length > 0;

/** GET /departments/:code/jobs/:jobId/machines: the runs of a job and how much cloth is still to be put on a machine. */
async function jobRuns(req, code, jobId, transaction) {
  const d = await deptByCode(req, code, transaction);
  await need(req, d, 'VIEW', transaction);
  const j = await jobOf(req, d, jobId, transaction);
  const f = (await flagsOf(req.user.companyId, transaction)).get(d.id) || { enabled: false };
  const runs = await q(`${RUN_SQL} WHERE r."jobId" = :jobId ORDER BY r."startedAt"`, { jobId }, transaction);
  const assigned = n2(runs.reduce((t, r) => t + Number(r.inMeters), 0));
  const made = n2(runs.filter((r) => r.status === 'DONE').reduce((t, r) => t + Number(r.outMeters || 0), 0));
  const labels = await soLabelsOf([jobId]);
  const sent = await sentOn(jobId, transaction);
  const open = runs.filter((r) => r.status === 'RUNNING').length;
  return {
    enabled: f.enabled, job: { id: j.id, jobNo: j.jobNo, status: j.status, totalMeters: n2(j.totalMeters), soLabels: labels.get(jobId) || [] },
    assignedMeters: assigned, remainingMeters: Math.max(0, n2(j.totalMeters - assigned)), madeMeters: made, runningRuns: open,
    canAssign: f.enabled && ['PENDING', 'PROCESSING'].includes(j.status) && !sent && n2(j.totalMeters - assigned) > 0, sentOn: sent,
    runs: runs.map((r) => runJSON(withDay(r))),
  };
}

/** POST /departments/:code/jobs/:jobId/machines { machineId, operatorName, meters?, notes? }: put the job (or `meters` of it) on a machine. */
async function assign(req, code, jobId, { machineId, operatorName, meters, notes }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const d = await deptByCode(req, code, transaction);
    await need(req, d, 'FULL', transaction);
    const f = (await flagsOf(companyId, transaction)).get(d.id) || { enabled: false };
    if (!f.enabled) throw AppError.rule('MACHINES_OFF', 'This department does not use machines (the client admin switches them on in Settings > Machines)');
    const j = await jobOf(req, d, jobId, transaction, true);
    if (['IN_WAY', 'QUEUE'].includes(j.status)) throw AppError.rule('JOB_NOT_ACCEPTED', 'Accept the job before putting it on a machine');
    if (!['PENDING', 'PROCESSING'].includes(j.status)) throw AppError.rule('JOB_CLOSED', `This job is ${j.status.toLowerCase()}: it cannot be put on a machine`);
    if (await sentOn(jobId, transaction)) throw AppError.rule('ALREADY_SENT_ON', 'This cloth has already been sent on to the next department');
    const [m] = await q('SELECT id, name, "isActive" FROM machines WHERE id = :machineId AND "companyId" = :companyId AND "departmentId" = :d AND "deletedAt" IS NULL FOR UPDATE', { machineId, companyId, d: d.id }, transaction);
    if (!m) throw AppError.rule('UNKNOWN_MACHINE', 'This machine does not belong to this department', { field: 'machineId' });
    if (!m.isActive) throw AppError.rule('MACHINE_OFF', `${m.name} is switched off`, { field: 'machineId' });
    const [busy] = await q(`${RUN_SQL} WHERE r."machineId" = :machineId AND r.status = 'RUNNING'`, { machineId }, transaction);
    if (busy) throw AppError.rule('MACHINE_BUSY', `${m.name} is running Job# ${busy.jobNo} (${busy.operatorName})`, { jobNo: busy.jobNo, operatorName: busy.operatorName, runId: busy.id });
    const [{ used }] = await q('SELECT COALESCE(SUM("inMeters"), 0) AS used FROM machine_runs WHERE "jobId" = :jobId', { jobId }, transaction);
    const left = n2(Number(j.totalMeters) - Number(used));
    if (left <= 0) throw AppError.rule('NOTHING_LEFT', 'All the cloth of this job is already on machines', { totalMeters: n2(j.totalMeters) });
    const inMeters = meters === undefined ? left : n2(meters);
    if (inMeters > left + 0.005) throw AppError.rule('OVER_ASSIGNED', `Only ${left} m of this job are not on a machine yet`, { remainingMeters: left });
    const name = String(operatorName).trim();
    const id = crypto.randomUUID();
    await exec(`INSERT INTO machine_runs (id, "companyId", "departmentId", "jobId", "machineId", "operatorName", "inMeters", "runDate", notes, "startedById")
      VALUES (:id, :companyId, :d, :jobId, :machineId, :name, :inMeters, :runDate, :notes, :userId)`, { id, companyId, d: d.id, jobId, machineId, name, inMeters, runDate: today(), notes: notes || null, userId: req.user.id }, transaction);
    // on a machine = processing; the job keeps the first operator (and the day) when none was typed yet
    if (j.status === 'PENDING') await exec('UPDATE jobs SET status = \'PROCESSING\', "statusById" = :userId, "statusAt" = now() WHERE id = :jobId', { userId: req.user.id, jobId }, transaction);
    if (!j.operatorName) await exec('UPDATE jobs SET "operatorName" = :name, "operatorSetById" = :userId, "operatorSetAt" = now(), "processDate" = COALESCE("processDate", :day) WHERE id = :jobId', { name, userId: req.user.id, day: today(), jobId }, transaction);
    await audit.log(req, { action: 'MACHINE_JOB_STARTED', entityType: 'MachineRun', entityId: id, after: { jobNo: j.jobNo, machine: m.name, operatorName: name, inMeters } }, { transaction });
  });
  return jobRuns(req, code, jobId);
}

async function runOr404(req, d, runId, transaction) {
  const [r] = await q(`${RUN_SQL} WHERE r.id = :runId AND r."companyId" = :companyId AND r."departmentId" = :d FOR UPDATE OF r`, { runId, companyId: req.user.companyId, d: d.id }, transaction);
  if (!r) throw AppError.notFound('Machine run');
  return r;
}

/** POST /departments/:code/machine-runs/:runId/finish { outMeters, notes? }: the machine is free again; outMeters = the cloth made. */
async function finish(req, code, runId, { outMeters, operatorName, notes }) {
  const jobId = await sequelize.transaction(async (transaction) => {
    const d = await deptByCode(req, code, transaction);
    await need(req, d, 'FULL', transaction);
    const r = await runOr404(req, d, runId, transaction);
    if (r.status !== 'RUNNING') throw AppError.rule('RUN_DONE', 'This run is already finished');
    if (await sentOn(r.jobId, transaction)) throw AppError.rule('ALREADY_SENT_ON', 'This cloth has already been sent on to the next department');
    await exec(`UPDATE machine_runs SET status = 'DONE', "outMeters" = :outMeters, "finishedAt" = now(), "finishedById" = :userId, "operatorName" = COALESCE(:name, "operatorName"), notes = COALESCE(:notes, notes), "updatedAt" = now() WHERE id = :runId`,
      { outMeters: n2(outMeters), userId: req.user.id, name: operatorName ? String(operatorName).trim() : null, notes: notes || null, runId }, transaction);
    await audit.log(req, { action: 'MACHINE_JOB_FINISHED', entityType: 'MachineRun', entityId: runId, after: { jobNo: r.jobNo, machine: r.machineName, inMeters: n2(r.inMeters), outMeters: n2(outMeters) } }, { transaction });
    return r.jobId;
  });
  return jobRuns(req, code, jobId);
}

/** PATCH /departments/:code/machine-runs/:runId { operatorName?, inMeters?, outMeters?, notes? }: correct a run until the cloth is sent on. */
async function updateRun(req, code, runId, changes) {
  const jobId = await sequelize.transaction(async (transaction) => {
    const d = await deptByCode(req, code, transaction);
    await need(req, d, 'FULL', transaction);
    const r = await runOr404(req, d, runId, transaction);
    if (await sentOn(r.jobId, transaction)) throw AppError.rule('ALREADY_SENT_ON', 'This cloth has already been sent on to the next department');
    const set = {};
    if (changes.operatorName !== undefined) set.operatorName = String(changes.operatorName).trim();
    if (changes.notes !== undefined) set.notes = changes.notes || null;
    if (changes.inMeters !== undefined) {
      const [j] = await q('SELECT "totalMeters" FROM jobs WHERE id = :jobId', { jobId: r.jobId }, transaction);
      const [{ others }] = await q('SELECT COALESCE(SUM("inMeters"), 0) AS others FROM machine_runs WHERE "jobId" = :jobId AND id <> :runId', { jobId: r.jobId, runId }, transaction);
      const left = n2(Number(j.totalMeters) - Number(others));
      if (changes.inMeters > left + 0.005) throw AppError.rule('OVER_ASSIGNED', `Only ${left} m of this job can be on this machine`, { remainingMeters: left });
      set.inMeters = n2(changes.inMeters);
    }
    if (changes.outMeters !== undefined) {
      if (r.status !== 'DONE') throw AppError.rule('RUN_RUNNING', 'Finish the run to enter the cloth made');
      set.outMeters = n2(changes.outMeters);
    }
    const keys = Object.keys(set);
    if (keys.length) {
      await exec(`UPDATE machine_runs SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :runId`, { ...set, runId }, transaction);
      await audit.log(req, { action: 'MACHINE_RUN_UPDATED', entityType: 'MachineRun', entityId: runId, before: { jobNo: r.jobNo, machine: r.machineName, operatorName: r.operatorName, inMeters: n2(r.inMeters), outMeters: r.outMeters }, after: set }, { transaction });
    }
    return r.jobId;
  });
  return jobRuns(req, code, jobId);
}

/** DELETE /departments/:code/machine-runs/:runId: the run was entered by mistake. */
async function removeRun(req, code, runId) {
  const jobId = await sequelize.transaction(async (transaction) => {
    const d = await deptByCode(req, code, transaction);
    await need(req, d, 'FULL', transaction);
    const r = await runOr404(req, d, runId, transaction);
    if (await sentOn(r.jobId, transaction)) throw AppError.rule('ALREADY_SENT_ON', 'This cloth has already been sent on to the next department');
    await exec('DELETE FROM machine_runs WHERE id = :runId', { runId }, transaction);
    await audit.log(req, { action: 'MACHINE_RUN_DELETED', entityType: 'MachineRun', entityId: runId, before: { jobNo: r.jobNo, machine: r.machineName, operatorName: r.operatorName, inMeters: n2(r.inMeters), outMeters: r.outMeters } }, { transaction });
    return r.jobId;
  });
  return jobRuns(req, code, jobId);
}

/** GET /departments/:code/machine-report?dateFrom&dateTo&machineId&operator: the cloth processed per machine and per operator. */
async function report(req, code, { dateFrom, dateTo, machineId, operator } = {}) {
  const { companyId } = req.user;
  const d = await deptByCode(req, code);
  await need(req, d, 'VIEW');
  const rows = await q(`${RUN_SQL} WHERE r."companyId" = :companyId AND r."departmentId" = :d AND (:from::date IS NULL OR r."runDate" >= :from::date) AND (:to::date IS NULL OR r."runDate" <= :to::date)
      AND (:machineId::uuid IS NULL OR r."machineId" = :machineId::uuid) AND (:op::text IS NULL OR lower(trim(r."operatorName")) = lower(trim(:op::text))) ORDER BY r."startedAt" DESC`,
  { companyId, d: d.id, from: dateFrom || null, to: dateTo || null, machineId: machineId || null, op: operator || null });
  const labels = await soLabelsOf([...new Set(rows.map((r) => r.jobId))]);
  const runs = rows.map((r) => runJSON(withDay(r), labels));
  const group = (keyOf, labelOf) => {
    const m = new Map();
    for (const r of runs) {
      const k = keyOf(r); const g = m.get(k) || { key: k, name: labelOf(r), runs: 0, jobs: new Set(), inMeters: 0, outMeters: 0, running: 0, others: new Set() };
      g.runs += 1; g.jobs.add(r.job.id); g.inMeters += r.inMeters; g.outMeters += r.outMeters || 0; if (r.status === 'RUNNING') g.running += 1;
      g.others.add(keyOf === opKey ? r.machine.name : r.operatorName);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ key: g.key, name: g.name, runs: g.runs, jobs: g.jobs.size, running: g.running, inMeters: n2(g.inMeters), outMeters: n2(g.outMeters), lossMeters: n2(g.inMeters - g.outMeters), [keyOf === opKey ? 'machines' : 'operators']: [...g.others].sort() }))
      .sort((a, b) => b.inMeters - a.inMeters);
  };
  const opKey = (r) => r.operatorName.trim().toLowerCase();
  const byOperator = group(opKey, (r) => r.operatorName.trim());
  const byMachine = group((r) => r.machine.id, (r) => r.machine.name);
  const finished = runs.filter((r) => r.status === 'DONE');
  const totals = { runs: runs.length, jobs: new Set(runs.map((r) => r.job.id)).size, inMeters: n2(runs.reduce((t, r) => t + r.inMeters, 0)), outMeters: n2(finished.reduce((t, r) => t + (r.outMeters || 0), 0)),
    lossMeters: n2(finished.reduce((t, r) => t + (r.lossMeters || 0), 0)), running: runs.length - finished.length };
  return { department: { id: d.id, code: d.code, name: d.name }, dateFrom: dateFrom || null, dateTo: dateTo || null, totals, byMachine, byOperator, runs: runs.slice(0, 500), runCount: runs.length };
}

/** GET /departments/:code/machine-operators: the operator names used before (for the suggestions of the name box). */
async function operators(req, code) {
  const d = await deptByCode(req, code);
  await need(req, d, 'VIEW');
  const rows = await q(`SELECT name FROM (SELECT trim("operatorName") AS name, MAX("startedAt") AS at FROM machine_runs WHERE "departmentId" = :d GROUP BY trim("operatorName")
      UNION ALL SELECT trim("operatorName"), MAX("operatorSetAt") FROM jobs WHERE "departmentId" = :d AND "operatorName" IS NOT NULL GROUP BY trim("operatorName")) x
    GROUP BY name ORDER BY MAX(at) DESC NULLS LAST LIMIT 50`, { d: d.id });
  return { data: rows.map((r) => r.name) };
}

// ---- for the job lists ----
/** The runs of many jobs in one query: Map(jobId -> [short run]); the job lists show the machine and the operator next to the job. */
async function runsOfJobs(jobIds, transaction) {
  if (!jobIds.length) return new Map();
  const rows = await q(`${RUN_SQL} WHERE r."jobId" IN (:jobIds) ORDER BY r."startedAt"`, { jobIds }, transaction);
  const by = new Map();
  for (const r of rows) by.set(r.jobId, [...(by.get(r.jobId) || []), { id: r.id, machine: { id: r.machineId, name: r.machineName }, operatorName: r.operatorName, inMeters: n2(r.inMeters), outMeters: r.outMeters == null ? null : n2(r.outMeters), status: r.status }]);
  return by;
}
/** True when the job has a run that is still RUNNING (the job cannot be completed then). */
async function hasOpenRun(jobId, transaction) {
  return (await q(`SELECT 1 FROM machine_runs WHERE "jobId" = :jobId AND status = 'RUNNING' LIMIT 1`, { jobId }, transaction)).length > 0;
}

module.exports = { deptByCode, need, settings, setDepartment, listMachines, addMachines, updateMachine, removeMachine, overview, jobRuns, assign, finish, updateRun, removeRun, report, operators, runsOfJobs, hasOpenRun, suggestPrefix };
