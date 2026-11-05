// Payroll masters (service PAYROLL_EMPLOYEES): employee groups, departments (with the approved head-count), designations, shifts, holidays and banks.
// Everything belongs to one company; another company's rows are "not found". One small generic CRUD (list / get / create / update / delete) driven by a
// description of each master, so every master behaves the same way: unique names (NAME_TAKEN), audit log, delete only when nothing uses it.
//   The four default groups (Factory, Outlet, Head Office, Admin) are made for a company the first time its payroll masters are used (systemKey):
//   they can be renamed and switched off but never deleted; a group of the company's own can be deleted when nothing uses it.
//   The employees count in the `usage` of the group, department, designation, shift and bank (a master with employees is never deleted); payrolls will be added later.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const attendanceRefresh = require('./attendanceRefresh');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const quote = (c) => `"${c}"`;
const round2 = (n) => Math.round(n * 100) / 100;

/** The four default groups of a company, made once (the unique index on systemKey makes a second call, or a race, harmless). */
async function ensureGroups(companyId, transaction) {
  await run(`INSERT INTO payroll_groups (id, "companyId", name, "systemKey", "sortOrder")
    SELECT gen_random_uuid(), :companyId, v.name, v.key, v.sort
    FROM (VALUES ('Factory', 'FACTORY', 10), ('Outlet', 'OUTLET', 20), ('Head Office', 'HEAD_OFFICE', 30), ('Admin', 'ADMIN', 40)) AS v(name, key, sort)
    WHERE NOT EXISTS (SELECT 1 FROM payroll_groups g WHERE g."companyId" = :companyId AND g."systemKey" = v.key) ON CONFLICT DO NOTHING`, { companyId }, transaction);
}

// ---- shifts ----
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const spanMinutes = (start, end) => (minutes(end) > minutes(start) ? minutes(end) - minutes(start) : 24 * 60 - minutes(start) + minutes(end));
const hhmm = (v) => String(v).slice(0, 5);

function checkShift(data, current) {
  const m = {
    startTime: hhmm(data.startTime !== undefined ? data.startTime : current.startTime),
    endTime: hhmm(data.endTime !== undefined ? data.endTime : current.endTime),
    dutyHours: Number(data.dutyHours !== undefined ? data.dutyHours : current.dutyHours),
    isNight: data.isNight !== undefined ? data.isNight : current.isNight,
  };
  if (m.startTime === m.endTime) throw AppError.rule('SHIFT_TIMES', 'The shift cannot start and end at the same time');
  if (minutes(m.endTime) < minutes(m.startTime) && !m.isNight) throw AppError.rule('SHIFT_CROSSES_MIDNIGHT', 'This shift ends after midnight: mark it as a night shift');
  const span = spanMinutes(m.startTime, m.endTime) / 60;
  if (m.dutyHours > span + 1e-9) throw AppError.rule('DUTY_MORE_THAN_SHIFT', `The duty hours (${m.dutyHours}) cannot be more than the length of the shift (${round2(span)} hours)`, { spanHours: round2(span) });
}

const weekdayOf = (ymd) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${ymd}T00:00:00Z`).getUTCDay()];

// ---- the description of each master ----
const KINDS = {
  groups: {
    table: 'payroll_groups', label: 'Group', entity: 'PayrollGroup',
    from: 'payroll_groups t',
    select: `t.id, t.name, t."systemKey", t."isActive", t."sortOrder", t."createdAt", t."updatedAt",
      (SELECT count(*)::int FROM payroll_departments d WHERE d."groupId" = t.id) AS departments,
      (SELECT count(*)::int FROM payroll_holiday_groups h WHERE h."groupId" = t.id) AS holidays,
      (SELECT count(*)::int FROM payroll_employees e WHERE e."groupId" = t.id) AS employees`,
    order: 't."sortOrder", lower(t.name)',
    search: ['t.name'],
    columns: ['name', 'isActive', 'sortOrder'],
    beforeAll: ensureGroups,
    beforeCreate: async (companyId, values, tx) => { values.sortOrder = ((await q('SELECT COALESCE(MAX("sortOrder"), 0) AS m FROM payroll_groups WHERE "companyId" = :companyId', { companyId }, tx))[0].m || 0) + 10; },
    usage: (r) => ({ departments: r.departments, holidays: r.holidays, employees: r.employees }), // payrolls are added here with that table
    protect: (r) => (r.systemKey ? ['DEFAULT_GROUP', 'The four default groups cannot be deleted: switch the group off instead'] : null),
    taken: (v) => `A group called "${v.name}" already exists`,
    json: (r) => ({
      id: r.id, name: r.name, isDefault: Boolean(r.systemKey), systemKey: r.systemKey, isActive: r.isActive, sortOrder: r.sortOrder, departments: r.departments, holidays: r.holidays, employees: r.employees,
      canDelete: !r.systemKey && r.departments === 0 && r.holidays === 0 && r.employees === 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }),
  },
  departments: {
    table: 'payroll_departments', label: 'Department', entity: 'PayrollDepartment',
    from: 'payroll_departments t JOIN payroll_groups g ON g.id = t."groupId"',
    select: `t.id, t.name, t.fte, t."isActive", t."createdAt", t."updatedAt", g.id AS "groupId", g.name AS "groupName",
      (SELECT count(*)::int FROM payroll_employees e WHERE e."departmentId" = t.id AND NOT e."isClosed") AS employees, (SELECT count(*)::int FROM payroll_employees e WHERE e."departmentId" = t.id) AS "employeesAll"`,
    order: 'g."sortOrder", lower(g.name), lower(t.name)',
    search: ['t.name', 'g.name'],
    filters: (f) => (f.groupId ? { sql: ['t."groupId" = :groupId'], repl: { groupId: f.groupId } } : { sql: [], repl: {} }),
    columns: ['groupId', 'name', 'fte', 'isActive'],
    check: async (req, data, current, tx) => {
      if (data.groupId === undefined || (current && data.groupId === current.groupId)) return;
      if (current && (await q('SELECT 1 FROM payroll_employees WHERE "departmentId" = :id LIMIT 1', { id: current.id }, tx)).length) {
        throw AppError.rule('DEPARTMENT_HAS_EMPLOYEES', 'This department has employees: it cannot move to another group');
      }
      const [g] = await q('SELECT id, "isActive" FROM payroll_groups WHERE id = :id AND "companyId" = :companyId', { id: data.groupId, companyId: req.user.companyId }, tx);
      if (!g) throw AppError.notFound('Group');
      if (!g.isActive) throw AppError.rule('GROUP_INACTIVE', 'This group is switched off');
    },
    usage: (r) => ({ employees: r.employeesAll }),
    taken: (v) => `"${v.name}" already exists in this group`,
    // vacancy = the approved head-count less the working employees (closed ones do not count); the joining application will also count its drafts
    json: (r) => ({
      id: r.id, name: r.name, fte: r.fte, employees: r.employees, vacancy: Math.max(0, r.fte - r.employees), isActive: r.isActive, group: { id: r.groupId, name: r.groupName },
      canDelete: r.employeesAll === 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }),
  },
  designations: {
    table: 'payroll_designations', label: 'Designation', entity: 'PayrollDesignation',
    from: 'payroll_designations t',
    select: `t.id, t.name, t."isActive", t."createdAt", t."updatedAt", (SELECT count(*)::int FROM payroll_employees e WHERE e."designationId" = t.id) AS employees`,
    order: 'lower(t.name)', search: ['t.name'], columns: ['name', 'isActive'],
    usage: (r) => ({ employees: r.employees }),
    taken: (v) => `A designation called "${v.name}" already exists`,
    json: (r) => ({ id: r.id, name: r.name, employees: r.employees, isActive: r.isActive, canDelete: r.employees === 0, createdAt: r.createdAt, updatedAt: r.updatedAt }),
  },
  banks: {
    table: 'payroll_banks', label: 'Bank', entity: 'PayrollBank',
    from: 'payroll_banks t',
    select: `t.id, t.name, t."shortName", t."bankCode", t."isActive", t."createdAt", t."updatedAt", (SELECT count(*)::int FROM payroll_employees e WHERE e."bankId" = t.id) AS employees`,
    order: 'lower(t.name)', search: ['t.name', 't."shortName"', 't."bankCode"'], columns: ['name', 'shortName', 'bankCode', 'isActive'],
    normalize: (v) => { for (const k of ['shortName', 'bankCode']) if (v[k] === '') v[k] = null; },
    usage: (r) => ({ employees: r.employees }),
    taken: (v) => `A bank called "${v.name}" already exists`,
    json: (r) => ({ id: r.id, name: r.name, shortName: r.shortName, bankCode: r.bankCode, employees: r.employees, isActive: r.isActive, canDelete: r.employees === 0, createdAt: r.createdAt, updatedAt: r.updatedAt }),
  },
  shifts: {
    table: 'payroll_shifts', label: 'Shift', entity: 'PayrollShift', attendance: 'shift',
    from: 'payroll_shifts t',
    select: `t.id, t.code, t.name, to_char(t."startTime", 'HH24:MI') AS "startTime", to_char(t."endTime", 'HH24:MI') AS "endTime", t."dutyHours"::float AS "dutyHours", t."isNight", t."isActive", t."createdAt", t."updatedAt", (SELECT count(*)::int FROM payroll_employees e WHERE e."shiftId" = t.id) AS employees`,
    order: 't."startTime", lower(t.code)', search: ['t.code', 't.name'], columns: ['code', 'name', 'startTime', 'endTime', 'dutyHours', 'isNight', 'isActive'],
    normalize: (v) => { if (v.name === '') v.name = null; },
    check: async (req, data, current) => checkShift(data, current || {}),
    usage: (r) => ({ employees: r.employees }),
    taken: (v) => `Shift code "${v.code}" already exists`,
    json: (r) => ({
      id: r.id, code: r.code, name: r.name, startTime: r.startTime, endTime: r.endTime, dutyHours: r.dutyHours, isNight: r.isNight, isActive: r.isActive,
      spanHours: round2(spanMinutes(r.startTime, r.endTime) / 60), crossesMidnight: minutes(r.endTime) < minutes(r.startTime),
      label: `${r.code} (${r.startTime}-${r.endTime}, ${r.dutyHours} hrs)`, employees: r.employees, canDelete: r.employees === 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }),
  },
  holidays: {
    table: 'payroll_holidays', label: 'Holiday', entity: 'PayrollHoliday', attendance: 'holiday',
    from: 'payroll_holidays t',
    select: `t.id, to_char(t."holidayDate", 'YYYY-MM-DD') AS date, t.name, t."appliesToAll", t."createdAt", t."updatedAt"`,
    order: 't."holidayDate", lower(t.name)', search: ['t.name'], columns: ['holidayDate', 'name', 'appliesToAll'],
    beforeAll: ensureGroups,
    filters: (f) => {
      const sql = [];
      const repl = {};
      if (f.dateFrom) { sql.push('t."holidayDate" >= :dateFrom'); repl.dateFrom = f.dateFrom; }
      if (f.dateTo) { sql.push('t."holidayDate" <= :dateTo'); repl.dateTo = f.dateTo; }
      if (f.year) { sql.push('EXTRACT(YEAR FROM t."holidayDate") = :year'); repl.year = f.year; }
      // the holidays that count for one group: those for every group and those that name it
      if (f.groupId) { sql.push('(t."appliesToAll" OR EXISTS (SELECT 1 FROM payroll_holiday_groups hg WHERE hg."holidayId" = t.id AND hg."groupId" = :groupId))'); repl.groupId = f.groupId; }
      return { sql, repl };
    },
    check: async (req, data, current, tx) => {
      const all = data.appliesToAll !== undefined ? data.appliesToAll : current ? current.appliesToAll : true;
      const ids = data.groupIds;
      if (all && ids && ids.length) throw AppError.rule('GROUPS_NOT_ALLOWED', 'Choose either every group or a list of groups, not both');
      if (!all) {
        const have = ids !== undefined ? ids.length : current ? (await q('SELECT count(*)::int AS n FROM payroll_holiday_groups WHERE "holidayId" = :id', { id: current.id }, tx))[0].n : 0;
        if (!have) throw AppError.rule('GROUPS_REQUIRED', 'Choose the groups this holiday is for');
      }
      if (ids && ids.length) {
        const found = await q('SELECT id FROM payroll_groups WHERE "companyId" = :companyId AND id IN (:ids)', { companyId: req.user.companyId, ids }, tx);
        if (found.length !== ids.length) throw AppError.notFound('Group');
      }
    },
    afterWrite: async (req, id, data, current, values, tx) => {
      const all = values.appliesToAll !== undefined ? values.appliesToAll : current ? current.appliesToAll : true;
      if (all) await run('DELETE FROM payroll_holiday_groups WHERE "holidayId" = :id', { id }, tx);
      else if (data.groupIds !== undefined) {
        await run('DELETE FROM payroll_holiday_groups WHERE "holidayId" = :id', { id }, tx);
        for (const groupId of data.groupIds) await run('INSERT INTO payroll_holiday_groups ("holidayId", "groupId") VALUES (:id, :groupId)', { id, groupId }, tx);
      }
    },
    decorate: async (rows, tx) => {
      const links = rows.length ? await q(`SELECT hg."holidayId", g.id, g.name FROM payroll_holiday_groups hg JOIN payroll_groups g ON g.id = hg."groupId" WHERE hg."holidayId" IN (:ids) ORDER BY g."sortOrder", g.name`, { ids: rows.map((r) => r.id) }, tx) : [];
      for (const r of rows) r.groups = links.filter((l) => l.holidayId === r.id).map((l) => ({ id: l.id, name: l.name }));
    },
    rawSelect: `t.*, to_char(t."holidayDate", 'YYYY-MM-DD') AS "dateText"`,
    usage: () => ({}),
    taken: (v, cur) => `"${v.name}" is already a holiday on ${v.holidayDate || (cur && cur.dateText)}`,
    json: (r) => ({
      id: r.id, date: r.date, weekday: weekdayOf(r.date), name: r.name, appliesToAll: r.appliesToAll, groups: r.appliesToAll ? [] : r.groups,
      canDelete: true, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }),
  },
};

function pickColumns(cfg, data) {
  const values = {};
  for (const c of cfg.columns) if (data[c] !== undefined) values[c] = data[c];
  if (cfg.normalize) cfg.normalize(values);
  return values;
}

/** A unique index was hit: answer NAME_TAKEN, never a raw database error. */
function mapTaken(cfg, values, current) {
  return (err) => {
    if (err && err.name === 'SequelizeUniqueConstraintError') throw AppError.rule('NAME_TAKEN', cfg.taken({ ...(current || {}), ...values }, current));
    throw err;
  };
}

function makeCrud(cfg) {
  const loadOne = async (companyId, id, tx) => {
    const [row] = await q(`SELECT ${cfg.select} FROM ${cfg.from} WHERE t.id = :id AND t."companyId" = :companyId`, { id, companyId }, tx);
    if (!row) throw AppError.notFound(cfg.label);
    if (cfg.decorate) await cfg.decorate([row], tx);
    return row;
  };

  async function list(req, query = {}) {
    const { companyId } = req.user;
    if (cfg.beforeAll) await cfg.beforeAll(companyId);
    const where = ['t."companyId" = :companyId'];
    const repl = { companyId };
    if (query.isActive !== undefined) { where.push('t."isActive" = :isActive'); repl.isActive = query.isActive; }
    if (query.search) { repl.like = `%${query.search}%`; where.push(`(${cfg.search.map((c) => `${c} ILIKE :like`).join(' OR ')})`); }
    if (cfg.filters) { const f = cfg.filters(query); where.push(...f.sql); Object.assign(repl, f.repl); }
    const limit = query.limit || 100;
    const page = query.page || 1;
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${cfg.from} WHERE ${where.join(' AND ')}`, repl);
    const rows = await q(`SELECT ${cfg.select} FROM ${cfg.from} WHERE ${where.join(' AND ')} ORDER BY ${cfg.order} LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
    if (cfg.decorate) await cfg.decorate(rows);
    return { data: rows.map(cfg.json), page, limit, total: n };
  }

  async function get(req, id, tx) {
    if (cfg.beforeAll) await cfg.beforeAll(req.user.companyId, tx);
    return cfg.json(await loadOne(req.user.companyId, id, tx));
  }

  async function create(req, data) {
    const { companyId } = req.user;
    let created;
    const id = await sequelize.transaction(async (transaction) => {
      if (cfg.beforeAll) await cfg.beforeAll(companyId, transaction);
      const values = pickColumns(cfg, data);
      if (cfg.check) await cfg.check(req, data, null, transaction);
      if (cfg.beforeCreate) await cfg.beforeCreate(companyId, values, transaction);
      const cols = Object.keys(values);
      const [row] = await q(`INSERT INTO ${cfg.table} ("companyId", ${cols.map(quote).join(', ')}) VALUES (:companyId, ${cols.map((c) => `:${c}`).join(', ')}) RETURNING id`,
        { companyId, ...values }, transaction).catch(mapTaken(cfg, values, null));
      if (cfg.afterWrite) await cfg.afterWrite(req, row.id, data, null, values, transaction);
      created = cfg.json(await loadOne(companyId, row.id, transaction));
      await audit.log(req, { action: `${cfg.entity.toUpperCase()}_CREATED`, entityType: cfg.entity, entityId: row.id, after: created }, { transaction });
      return row.id;
    });
    if (cfg.attendance) await attendanceRefresh.masterChanged(companyId, cfg.attendance, null, created);
    return get(req, id);
  }

  async function update(req, id, changes) {
    const { companyId } = req.user;
    let was;
    let now;
    await sequelize.transaction(async (transaction) => {
      const [current] = await q(`SELECT ${cfg.rawSelect || 't.*'} FROM ${cfg.table} t WHERE t.id = :id AND t."companyId" = :companyId FOR UPDATE`, { id, companyId }, transaction);
      if (!current) throw AppError.notFound(cfg.label);
      const before = cfg.json(await loadOne(companyId, id, transaction));
      was = before;
      const values = pickColumns(cfg, changes);
      if (cfg.check) await cfg.check(req, changes, current, transaction);
      const cols = Object.keys(values);
      if (cols.length) {
        await run(`UPDATE ${cfg.table} SET ${cols.map((c) => `${quote(c)} = :${c}`).join(', ')}, "updatedAt" = now() WHERE id = :id AND "companyId" = :companyId`,
          { id, companyId, ...values }, transaction).catch(mapTaken(cfg, values, current));
      }
      if (cfg.afterWrite) await cfg.afterWrite(req, id, changes, current, values, transaction);
      now = cfg.json(await loadOne(companyId, id, transaction));
      await audit.log(req, { action: `${cfg.entity.toUpperCase()}_UPDATED`, entityType: cfg.entity, entityId: id, before, after: now }, { transaction });
    });
    if (cfg.attendance) await attendanceRefresh.masterChanged(companyId, cfg.attendance, was, now);
    return get(req, id);
  }

  async function remove(req, id) {
    const { companyId } = req.user;
    let gone;
    await sequelize.transaction(async (transaction) => {
      const [current] = await q(`SELECT t.id FROM ${cfg.table} t WHERE t.id = :id AND t."companyId" = :companyId FOR UPDATE`, { id, companyId }, transaction);
      if (!current) throw AppError.notFound(cfg.label);
      const row = await loadOne(companyId, id, transaction);
      const blocked = cfg.protect && cfg.protect(row);
      if (blocked) throw AppError.rule(blocked[0], blocked[1]);
      const usage = cfg.usage(row);
      const used = Object.entries(usage).filter(([, n]) => n > 0);
      if (used.length) throw AppError.rule('IN_USE', `This ${cfg.label.toLowerCase()} is used by ${used.map(([k, n]) => `${n} ${k}`).join(' and ')} and cannot be deleted`, usage);
      const before = cfg.json(row);
      gone = before;
      await run(`DELETE FROM ${cfg.table} WHERE id = :id AND "companyId" = :companyId`, { id, companyId }, transaction);
      await audit.log(req, { action: `${cfg.entity.toUpperCase()}_DELETED`, entityType: cfg.entity, entityId: id, before }, { transaction });
    });
    if (cfg.attendance) await attendanceRefresh.masterChanged(companyId, cfg.attendance, gone, null);
  }

  return { list, get, create, update, remove };
}

const masters = Object.fromEntries(Object.entries(KINDS).map(([k, cfg]) => [k, makeCrud(cfg)]));

/** One answer with every active master for the dropdowns of the payroll screens (a single request instead of five). */
async function options(req) {
  const { companyId } = req.user;
  await ensureGroups(companyId);
  const [groups, departments, designations, shifts, banks] = await Promise.all([
    masters.groups.list(req, { isActive: true, limit: 500 }),
    masters.departments.list(req, { isActive: true, limit: 500 }),
    masters.designations.list(req, { isActive: true, limit: 500 }),
    masters.shifts.list(req, { isActive: true, limit: 500 }),
    masters.banks.list(req, { isActive: true, limit: 500 }),
  ]);
  return {
    groups: groups.data.map((g) => ({ id: g.id, name: g.name, isDefault: g.isDefault })),
    departments: departments.data.map((d) => ({ id: d.id, name: d.name, groupId: d.group.id, fte: d.fte })),
    designations: designations.data.map((d) => ({ id: d.id, name: d.name })),
    shifts: shifts.data.map((s) => ({ id: s.id, code: s.code, label: s.label, startTime: s.startTime, endTime: s.endTime, dutyHours: s.dutyHours, isNight: s.isNight })),
    banks: banks.data.map((b) => ({ id: b.id, name: b.name, shortName: b.shortName, bankCode: b.bankCode })),
  };
}

module.exports = { masters, options, ensureGroups, spanMinutes, minutes };
