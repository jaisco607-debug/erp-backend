// Payroll policy (service PAYROLL_EMPLOYEES to change, any payroll service to read): the rules of a group.
//   late limit, half-day limit, how many lates cost half a day, the weekly off day, the overtime factor and the leave rules.
// A policy is a VERSION that holds from a month until the next version of the same group. A month with no version before it uses DEFAULTS.
// `effectivePolicy` is what the payroll will call when it is created: it copies the answer onto the payroll, so a later change never reaches an old month.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const { ensureGroups } = require('./payrollMasterService');
const attendanceRefresh = require('./attendanceRefresh');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });

const FIELDS = ['lateLimitMinutes', 'halfDayLimitMinutes', 'latesPerHalfDay', 'weeklyOffDay', 'overtimeFactor', 'leaveEarnedPerMonth', 'maxLeavePerYear', 'monthsBeforeLeave'];
// used for a month that has no policy yet (from the demo payroll sheet: late 15 min, half-day 120 min, 3 lates = half a day, Sunday off, overtime x1, 2 leaves a month up to 24 a year after 6 months)
const DEFAULTS = { lateLimitMinutes: 15, halfDayLimitMinutes: 120, latesPerHalfDay: 3, weeklyOffDay: 'SUNDAY', overtimeFactor: 1, leaveEarnedPerMonth: 2, maxLeavePerYear: 24, monthsBeforeLeave: 6 };

const SELECT = `p.id, p."groupId", g.name AS "groupName", to_char(p."effectiveFrom", 'YYYY-MM') AS "effectiveFrom", p."lateLimitMinutes", p."halfDayLimitMinutes", p."latesPerHalfDay",
  p."weeklyOffDay", p."overtimeFactor"::float AS "overtimeFactor", p."leaveEarnedPerMonth"::float AS "leaveEarnedPerMonth", p."maxLeavePerYear"::float AS "maxLeavePerYear",
  p."monthsBeforeLeave", p."createdAt", p."updatedAt"`;
const FROM = 'payroll_policies p JOIN payroll_groups g ON g.id = p."groupId"';

const cap = (d) => (d ? d[0] + d.slice(1).toLowerCase() : null);
/** The one-line summary the payroll sheet shows next to its POLICY button. */
function summary(p) {
  const late = p.latesPerHalfDay > 0 ? `${p.latesPerHalfDay} lates = half a day` : 'lates not penalised';
  return `Late ${p.lateLimitMinutes}m, half-day ${p.halfDayLimitMinutes}m, ${late}, off ${p.weeklyOffDay ? cap(p.weeklyOffDay) : 'none'}, overtime x${p.overtimeFactor}, leave ${p.leaveEarnedPerMonth}/mo, max ${p.maxLeavePerYear}/yr, after ${p.monthsBeforeLeave} mo`;
}

const rules = (p) => Object.fromEntries(FIELDS.map((f) => [f, p[f]]));
function json(r) {
  return { id: r.id, source: 'POLICY', group: { id: r.groupId, name: r.groupName }, effectiveFrom: r.effectiveFrom, ...rules(r), summary: summary(r), createdAt: r.createdAt, updatedAt: r.updatedAt };
}
const defaultJson = (group, month) => ({ id: null, source: 'DEFAULT', group: { id: group.id, name: group.name }, effectiveFrom: null, ...DEFAULTS, summary: summary(DEFAULTS), month });

const firstDay = (month) => `${month}-01`;
const thisMonth = () => today().slice(0, 7);

function check(p) {
  if (!(p.halfDayLimitMinutes > p.lateLimitMinutes)) throw AppError.rule('HALF_DAY_NOT_MORE_THAN_LATE', 'The half-day limit must be more than the late limit', { lateLimitMinutes: p.lateLimitMinutes, halfDayLimitMinutes: p.halfDayLimitMinutes });
}

async function groupOr404(companyId, groupId, transaction) {
  const [g] = await q('SELECT id, name FROM payroll_groups WHERE id = :groupId AND "companyId" = :companyId', { groupId, companyId }, transaction);
  if (!g) throw AppError.notFound('Group');
  return g;
}

/** The policy of a group in force for a month (YYYY-MM): the latest version that starts on or before it, else the defaults. */
async function effectivePolicy(companyId, groupId, month, transaction) {
  const group = await groupOr404(companyId, groupId, transaction);
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE p."companyId" = :companyId AND p."groupId" = :groupId AND p."effectiveFrom" <= :first ORDER BY p."effectiveFrom" DESC LIMIT 1`,
    { companyId, groupId, first: firstDay(month) }, transaction);
  return r ? { ...json(r), month } : defaultJson(group, month);
}

async function effective(req, { groupId, month }) {
  return effectivePolicy(req.user.companyId, groupId, month || thisMonth());
}

/** The policy in force for every active group in one call: the table of the policy screen and the POLICY button. */
async function byGroup(req, { month } = {}) {
  const { companyId } = req.user;
  const m = month || thisMonth();
  await ensureGroups(companyId);
  const groups = await q('SELECT id, name, "systemKey" FROM payroll_groups WHERE "companyId" = :companyId AND "isActive" ORDER BY "sortOrder", lower(name)', { companyId });
  const rows = await q(`SELECT DISTINCT ON (p."groupId") ${SELECT} FROM ${FROM} WHERE p."companyId" = :companyId AND p."effectiveFrom" <= :first ORDER BY p."groupId", p."effectiveFrom" DESC`, { companyId, first: firstDay(m) });
  const by = new Map(rows.map((r) => [r.groupId, r]));
  return {
    month: m, defaults: { ...DEFAULTS, summary: summary(DEFAULTS) },
    data: groups.map((g) => ({ group: { id: g.id, name: g.name, isDefault: Boolean(g.systemKey) }, policy: by.has(g.id) ? { ...json(by.get(g.id)), month: m } : defaultJson(g, m) })),
  };
}

async function list(req, { groupId, page = 1, limit = 100 } = {}) {
  const { companyId } = req.user;
  const where = ['p."companyId" = :companyId'];
  const repl = { companyId };
  if (groupId) { where.push('p."groupId" = :groupId'); repl.groupId = groupId; }
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${FROM} WHERE ${where.join(' AND ')}`, repl);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY g."sortOrder", lower(g.name), p."effectiveFrom" DESC LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  return { data: rows.map(json), page, limit, total: n };
}

async function loadOne(companyId, id, transaction) {
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE p.id = :id AND p."companyId" = :companyId`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Policy');
  return r;
}

const get = async (req, id) => json(await loadOne(req.user.companyId, id));

/** A new version from a month. Every rule not sent is taken from the policy in force that month (or the defaults), so the screen sends only what changes. */
async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await ensureGroups(companyId, transaction);
    const base = await effectivePolicy(companyId, data.groupId, data.effectiveFrom, transaction);
    const values = Object.fromEntries(FIELDS.map((f) => [f, data[f] !== undefined ? data[f] : base[f]]));
    check(values);
    if ((await q('SELECT 1 FROM payroll_policies WHERE "companyId" = :companyId AND "groupId" = :groupId AND "effectiveFrom" = :first', { companyId, groupId: data.groupId, first: firstDay(data.effectiveFrom) }, transaction)).length) {
      throw AppError.rule('POLICY_EXISTS', `This group already has a policy from ${data.effectiveFrom}: change that one`);
    }
    const [row] = await q(`INSERT INTO payroll_policies ("companyId", "groupId", "effectiveFrom", "createdById", "updatedById", ${FIELDS.map((f) => `"${f}"`).join(', ')})
      VALUES (:companyId, :groupId, :first, :userId, :userId, ${FIELDS.map((f) => `:${f}`).join(', ')}) RETURNING id`,
    { companyId, groupId: data.groupId, first: firstDay(data.effectiveFrom), userId: req.user.id, ...values }, transaction);
    await audit.log(req, { action: 'PAYROLL_POLICY_CREATED', entityType: 'PayrollPolicy', entityId: row.id, after: { groupId: data.groupId, effectiveFrom: data.effectiveFrom, ...values } }, { transaction });
    return row.id;
  });
  await attendanceRefresh.policyChanged(companyId, data.groupId, data.effectiveFrom);
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  let was;
  await sequelize.transaction(async (transaction) => {
    const [cur] = await q('SELECT * FROM payroll_policies WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
    if (!cur) throw AppError.notFound('Policy');
    const before = json(await loadOne(companyId, id, transaction));
    was = before;
    const values = {};
    for (const f of FIELDS) if (changes[f] !== undefined) values[f] = changes[f];
    check({ ...rules(before), ...values });
    const cols = Object.keys(values);
    await run(`UPDATE payroll_policies SET ${cols.map((c) => `"${c}" = :${c}`).join(', ')}, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id, ...values }, transaction);
    await audit.log(req, { action: 'PAYROLL_POLICY_UPDATED', entityType: 'PayrollPolicy', entityId: id, before, after: json(await loadOne(companyId, id, transaction)) }, { transaction });
  });
  await attendanceRefresh.policyChanged(companyId, was.group.id, was.effectiveFrom);
  return get(req, id);
}

/** Deleting a version is safe for old payrolls (they hold their own copy): the months it covered fall back to the version before it, or the defaults. */
async function remove(req, id) {
  const { companyId } = req.user;
  let was;
  await sequelize.transaction(async (transaction) => {
    const before = json(await loadOne(companyId, id, transaction));
    was = before;
    await run('DELETE FROM payroll_policies WHERE id = :id AND "companyId" = :companyId', { id, companyId }, transaction);
    await audit.log(req, { action: 'PAYROLL_POLICY_DELETED', entityType: 'PayrollPolicy', entityId: id, before }, { transaction });
  });
  await attendanceRefresh.policyChanged(companyId, was.group.id, was.effectiveFrom);
}

module.exports = { list, get, create, update, remove, effective, effectivePolicy, byGroup, DEFAULTS, FIELDS, summary };
