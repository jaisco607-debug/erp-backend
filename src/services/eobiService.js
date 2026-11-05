// EOBI contribution lists (Reports > Employees Contribution; service PAYROLL_REPORTS to change, any payroll service to read).
//   Every employee on a list pays the SAME fixed amounts, set by the EOBI rate of the month: a wage, the employer's % of it and the employee's % of it (wage 40,700, employer 5 % = 2,035,
//   employee 1 % = 407). A rate holds from its month until the next rate. The government asks for EOBI for some of the employees, not all: the list of a month holds exactly those.
//   A list belongs to a PROVIDER (an EOBI registration) and a month; each employee sits under a LOCATION (an office / branch code of the provider), and a voucher is paid per location.
//   An employee is on one list a month. The list can be copied from the month before (leavers are left out), employees can be added by name, ID or CNIC, and a sheet with Employee IDs
//   or CNICs (and optionally a location) makes a list in one go.
//   The employee share is deducted on the payslip from the list (payrollRunService reads `eobiShares`); the list shows what the payslips deduct against what the list asks.
//   Once a location has a CONFIRMED EOBI voucher its rows are locked until the voucher is moved back to draft.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { rupees } = require('../utils/payrollEngine');
const accountService = require('./accountService');
const audit = require('./auditService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const lock = (companyId, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `eobi:${companyId}` }, transaction });
const pad5 = (n) => String(n).padStart(5, '0');
const money = (c) => fromCents(c);
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const START = '2000-01'; // the rate that holds "from the start"
const thousands = (cents) => (Number(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const plain = (n) => String(Number(n));

// ---- masters: providers and locations ----

async function providers(req) {
  const { companyId } = req.user;
  const rows = await q(`SELECT p.id, p.name, p.code, p."isActive", (SELECT count(*)::int FROM eobi_lists l WHERE l."providerId" = p.id) AS lists FROM eobi_providers p WHERE p."companyId" = :companyId ORDER BY lower(p.name)`, { companyId });
  const locs = await q(`SELECT l.id, l."providerId", l.name, l.code, l."isActive", (SELECT count(*)::int FROM eobi_list_rows r WHERE r."locationId" = l.id) AS employees FROM eobi_locations l WHERE l."companyId" = :companyId ORDER BY lower(l.name)`, { companyId });
  return { data: rows.map((p) => ({ id: p.id, name: p.name, code: p.code, isActive: p.isActive, lists: p.lists, canDelete: p.lists === 0 && !locs.some((l) => l.providerId === p.id && l.employees > 0),
    locations: locs.filter((l) => l.providerId === p.id).map((l) => ({ id: l.id, name: l.name, code: l.code, isActive: l.isActive, employees: l.employees, canDelete: l.employees === 0 })) })) };
}

const taken = (what) => (e) => { if (e && e.name === 'SequelizeUniqueConstraintError') throw AppError.rule('NAME_TAKEN', `${what} with this name already exists`); throw e; };

async function createProvider(req, data) {
  const [row] = await q('INSERT INTO eobi_providers ("companyId", name, code) VALUES (:companyId, :name, :code) RETURNING id', { companyId: req.user.companyId, name: data.name, code: data.code || null }).catch(taken('A provider'));
  await audit.log(req, { action: 'EOBI_PROVIDER_CREATED', entityType: 'EobiProvider', entityId: row.id, after: { name: data.name } });
  return (await providers(req)).data.find((p) => p.id === row.id);
}

async function providerOr404(companyId, id, transaction) {
  const [p] = await q('SELECT id, name, code, "isActive" FROM eobi_providers WHERE id = :id AND "companyId" = :companyId', { id, companyId }, transaction);
  if (!p) throw AppError.notFound('Provider');
  return p;
}

async function updateProvider(req, id, c) {
  await providerOr404(req.user.companyId, id);
  const sets = [];
  const repl = { id, companyId: req.user.companyId };
  for (const k of ['name', 'code', 'isActive']) if (c[k] !== undefined) { sets.push(`"${k}" = :${k}`); repl[k] = c[k] === '' ? null : c[k]; }
  await run(`UPDATE eobi_providers SET ${sets.join(', ')}, "updatedAt" = now() WHERE id = :id AND "companyId" = :companyId`, repl).catch(taken('A provider'));
  await audit.log(req, { action: 'EOBI_PROVIDER_UPDATED', entityType: 'EobiProvider', entityId: id, after: c });
  return (await providers(req)).data.find((p) => p.id === id);
}

async function removeProvider(req, id) {
  const p = (await providers(req)).data.find((x) => x.id === id);
  if (!p) throw AppError.notFound('Provider');
  if (!p.canDelete) throw AppError.rule('IN_USE', 'This provider has lists: it cannot be deleted (switch it off instead)');
  await run('DELETE FROM eobi_locations WHERE "providerId" = :id', { id });
  await run('DELETE FROM eobi_providers WHERE id = :id', { id });
  await audit.log(req, { action: 'EOBI_PROVIDER_DELETED', entityType: 'EobiProvider', entityId: id, before: { name: p.name } });
}

async function createLocation(req, data) {
  const { companyId } = req.user;
  await providerOr404(companyId, data.providerId);
  const [row] = await q('INSERT INTO eobi_locations ("companyId", "providerId", name, code) VALUES (:companyId, :providerId, :name, :code) RETURNING id', { companyId, providerId: data.providerId, name: data.name, code: data.code || null }).catch(taken('A location'));
  await audit.log(req, { action: 'EOBI_LOCATION_CREATED', entityType: 'EobiLocation', entityId: row.id, after: { name: data.name } });
  return (await providers(req)).data.flatMap((p) => p.locations.map((l) => ({ ...l, providerId: p.id }))).find((l) => l.id === row.id);
}

async function updateLocation(req, id, c) {
  const { companyId } = req.user;
  const [l] = await q('SELECT id FROM eobi_locations WHERE id = :id AND "companyId" = :companyId', { id, companyId });
  if (!l) throw AppError.notFound('Location');
  const sets = [];
  const repl = { id, companyId };
  for (const k of ['name', 'code', 'isActive']) if (c[k] !== undefined) { sets.push(`"${k}" = :${k}`); repl[k] = c[k] === '' ? null : c[k]; }
  await run(`UPDATE eobi_locations SET ${sets.join(', ')}, "updatedAt" = now() WHERE id = :id AND "companyId" = :companyId`, repl).catch(taken('A location'));
  await audit.log(req, { action: 'EOBI_LOCATION_UPDATED', entityType: 'EobiLocation', entityId: id, after: c });
  return (await providers(req)).data.flatMap((p) => p.locations.map((x) => ({ ...x, providerId: p.id }))).find((x) => x.id === id);
}

async function removeLocation(req, id) {
  const { companyId } = req.user;
  const [l] = await q(`SELECT l.id, l.name, (SELECT count(*)::int FROM eobi_list_rows r WHERE r."locationId" = l.id) + (SELECT count(*)::int FROM eobi_vouchers v WHERE v."locationId" = l.id) AS used
    FROM eobi_locations l WHERE l.id = :id AND l."companyId" = :companyId`, { id, companyId });
  if (!l) throw AppError.notFound('Location');
  if (l.used) throw AppError.rule('IN_USE', 'This location is on a list or a voucher: it cannot be deleted (switch it off instead)');
  await run('DELETE FROM eobi_locations WHERE id = :id', { id });
  await audit.log(req, { action: 'EOBI_LOCATION_DELETED', entityType: 'EobiLocation', entityId: id, before: { name: l.name } });
}

// ---- the rates ----

const RATE_SELECT = `id, to_char(month, 'YYYY-MM') AS month, wage::text AS wage, "employerPercent"::float AS "employerPercent", "employeePercent"::float AS "employeePercent"`;

/** The two shares of one employee under a rate, in cents (whole rupees, half up). */
function sharesOf(rate) {
  const wage = toCents(rate.wage);
  const of = (pct) => rupees(wage * BigInt(Math.round(pct * 1000)), 100000n);
  return { wage, employer: of(rate.employerPercent), employee: of(rate.employeePercent) };
}

function rateJson(r) {
  const s = sharesOf(r);
  return {
    id: r.id, month: r.month, monthLabel: r.month === START ? 'start' : monthLabel(r.month), isStart: r.month === START, wage: money(s.wage), employerPercent: r.employerPercent, employeePercent: r.employeePercent,
    employer: money(s.employer), employee: money(s.employee), perEmployee: money(s.employer + s.employee),
  };
}

async function effectiveRate(companyId, month, transaction) {
  const [r] = await q(`SELECT ${RATE_SELECT} FROM eobi_rates WHERE "companyId" = :companyId AND month <= :first ORDER BY month DESC LIMIT 1`, { companyId, first: `${month}-01` }, transaction);
  return r || null;
}

function rateLine(r, month) {
  const s = sharesOf(r);
  return `EOBI rate for ${monthLabel(month)}: wage ${thousands(s.wage)} · employer ${plain(r.employerPercent)}% = ${thousands(s.employer)} · employee ${plain(r.employeePercent)}% = ${thousands(s.employee)}`;
}

/** The rates, newest first. With `month` the one in effect for it is marked ("this month"). */
async function listRates(req, { month }) {
  const rows = await q(`SELECT ${RATE_SELECT} FROM eobi_rates WHERE "companyId" = :companyId ORDER BY month DESC`, { companyId: req.user.companyId });
  const eff = month ? await effectiveRate(req.user.companyId, month) : null;
  return { month: month || null, data: rows.map((r) => ({ ...rateJson(r), inEffect: Boolean(eff && eff.id === r.id) })), line: eff ? rateLine(eff, month) : null };
}

/** "Save EOBI rate": a rate from a month (the same month again changes that rate). `recalculate` also works the lists of that month out again at the new rate. */
async function saveRate(req, data) {
  const { companyId } = req.user;
  let recalculated = 0;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const first = `${data.month}-01`;
    const [before] = await q('SELECT id, wage::text AS wage, "employerPercent"::float AS "employerPercent", "employeePercent"::float AS "employeePercent" FROM eobi_rates WHERE "companyId" = :companyId AND month = :first', { companyId, first }, transaction);
    await run(`INSERT INTO eobi_rates ("companyId", month, wage, "employerPercent", "employeePercent") VALUES (:companyId, :first, :wage, :employerPercent, :employeePercent)
      ON CONFLICT ("companyId", month) DO UPDATE SET wage = EXCLUDED.wage, "employerPercent" = EXCLUDED."employerPercent", "employeePercent" = EXCLUDED."employeePercent", "updatedAt" = now()`,
    { companyId, first, wage: String(data.wage), employerPercent: data.employerPercent, employeePercent: data.employeePercent }, transaction);
    if (data.recalculate) {
      const lists = await q('SELECT id FROM eobi_lists WHERE "companyId" = :companyId AND month = :first', { companyId, first }, transaction);
      for (const l of lists) recalculated += (await recalcRows(companyId, l.id, data.month, transaction)).updated;
    }
    await audit.log(req, { action: before ? 'EOBI_RATE_CHANGED' : 'EOBI_RATE_CREATED', entityType: 'EobiRate', entityId: null, before: before || null, after: { month: data.month, wage: data.wage, employerPercent: data.employerPercent, employeePercent: data.employeePercent, recalculated } }, { transaction });
  });
  return { ...(await listRates(req, { month: data.month })), recalculated };
}

async function removeRate(req, id) {
  const { companyId } = req.user;
  const [r] = await q('SELECT id, to_char(month, \'YYYY-MM\') AS month FROM eobi_rates WHERE id = :id AND "companyId" = :companyId', { id, companyId });
  if (!r) throw AppError.notFound('EOBI rate');
  await run('DELETE FROM eobi_rates WHERE id = :id', { id });
  await audit.log(req, { action: 'EOBI_RATE_DELETED', entityType: 'EobiRate', entityId: id, before: { month: r.month } });
}

// ---- lists ----

async function listOr404(companyId, id, transaction) {
  const [l] = await q(`SELECT l.id, l."providerId", to_char(l.month, 'YYYY-MM') AS month FROM eobi_lists l WHERE l.id = :id AND l."companyId" = :companyId`, { id, companyId }, transaction);
  if (!l) throw AppError.notFound('EOBI list');
  return l;
}

/** The locations of a list that have a confirmed voucher: their rows are locked. */
async function lockedLocations(companyId, providerId, month, transaction) {
  const rows = await q(`SELECT "locationId" FROM eobi_vouchers WHERE "companyId" = :companyId AND "providerId" = :providerId AND month = :first AND status = 'CONFIRMED'`, { companyId, providerId, first: `${month}-01` }, transaction);
  return new Set(rows.map((r) => r.locationId));
}

const ROW_COLS = `r.id, r."locationId", loc.name AS "locationName", r.wage::text AS wage, r."employerAmount"::text AS employer, r."employeeAmount"::text AS "employeeShare", r.source,
  e.id AS "employeeId", e.code, e.name, e.cnic, e."isClosed", d.name AS department, s.amt AS deducted, s.status AS "slipStatus", s.id AS "slipId"`;
const ROW_FROM = `eobi_list_rows r JOIN payroll_employees e ON e.id = r."employeeId" LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN eobi_locations loc ON loc.id = r."locationId"
  LEFT JOIN LATERAL (SELECT sl."eobiAmount"::text AS amt, sl.status, sl.id FROM payroll_slips sl JOIN payroll_runs pr ON pr.id = sl."runId"
    WHERE sl."employeeId" = r."employeeId" AND pr.month = r.month AND sl.status <> 'SUSPENDED' ORDER BY sl."updatedAt" DESC LIMIT 1) s ON true`;

function rowJson(r, locked) {
  const deducted = r.deducted == null ? 0n : toCents(r.deducted);
  const share = toCents(r.employeeShare);
  return {
    id: r.id, employee: { id: r.employeeId, code: r.code, label: pad5(r.code), name: r.name, cnic: r.cnic, department: r.department, isClosed: r.isClosed },
    location: r.locationId ? { id: r.locationId, name: r.locationName } : null, wage: money(toCents(r.wage)), employer: money(toCents(r.employer)), employeeShare: money(share), total: money(toCents(r.employer) + share),
    deducted: money(deducted), deductedStatus: r.slipStatus ? r.slipStatus.toLowerCase() : null, slipId: r.slipId || null, differs: deducted !== share, locked, source: r.source,
  };
}

/** The screen of one provider and month: the rate, the cards, the rows, the vouchers by location, and (when there is no list yet) what a copy would bring. */
async function view(req, { providerId, month, search, locationId, page = 1, limit = 500 }) {
  const { companyId } = req.user;
  const provider = await providerOr404(companyId, providerId);
  const first = `${month}-01`;
  const rate = await effectiveRate(companyId, month);
  const out = { provider: { id: provider.id, name: provider.name, code: provider.code }, month, monthLabel: monthLabel(month), rate: rate ? { ...rateJson(rate), line: rateLine(rate, month) } : null, list: null };
  const [list] = await q('SELECT id FROM eobi_lists WHERE "providerId" = :providerId AND month = :first', { providerId, first });
  if (!list) {
    const [prev] = await q(`SELECT to_char(l.month, 'YYYY-MM') AS month, (SELECT count(*)::int FROM eobi_list_rows r WHERE r."listId" = l.id) AS employees FROM eobi_lists l WHERE l."providerId" = :providerId AND l.month < :first ORDER BY l.month DESC LIMIT 1`, { providerId, first });
    out.copyFrom = prev ? { month: prev.month, monthLabel: monthLabel(prev.month), employees: prev.employees } : null;
    return out;
  }
  out.list = { id: list.id };
  const locked = await lockedLocations(companyId, providerId, month);
  const where = ['r."listId" = :listId'];
  const repl = { listId: list.id };
  if (locationId === 'none') where.push('r."locationId" IS NULL');
  else if (locationId) { where.push('r."locationId" = :locationId'); repl.locationId = locationId; }
  if (search) {
    repl.like = `%${search}%`;
    const digits = search.replace(/\D/g, '');
    const numeric = /^\d+$/.test(search) && search.length <= 8 ? ' OR e.code = :n' : '';
    if (numeric) repl.n = Number(search);
    if (digits.length >= 3) repl.digits = `%${digits}%`;
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like OR d.name ILIKE :like${repl.digits ? ' OR replace(e.cnic, \'-\', \'\') LIKE :digits' : ''}${numeric})`);
  }
  const w = where.join(' AND ');
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${ROW_FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${ROW_COLS} FROM ${ROW_FROM} WHERE ${w} ORDER BY e.code LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  out.rows = rows.map((r) => rowJson(r, r.locationId ? locked.has(r.locationId) : false));
  out.page = page; out.limit = limit; out.total = n;

  const all = await q(`SELECT ${ROW_COLS} FROM ${ROW_FROM} WHERE r."listId" = :listId`, { listId: list.id });
  let employer = 0n; let share = 0n; let deducted = 0n; let differ = 0; let without = 0;
  const by = new Map();
  for (const r of all) {
    const j = rowJson(r, false);
    employer += toCents(j.employer); share += toCents(j.employeeShare); deducted += toCents(j.deducted);
    if (j.differs) differ += 1;
    if (!r.locationId) without += 1;
    const key = r.locationId || 'none';
    const b = by.get(key) || { locationId: r.locationId || null, name: r.locationName || '(not set)', employees: 0, employer: 0n, employeeShare: 0n };
    b.employees += 1; b.employer += toCents(j.employer); b.employeeShare += toCents(j.employeeShare);
    by.set(key, b);
  }
  const vouchers = await q(`SELECT v.id, v."voucherNo", v."locationId", v.status FROM eobi_vouchers v WHERE v."companyId" = :companyId AND v."providerId" = :providerId AND v.month = :first`, { companyId, providerId, first });
  out.cards = { employees: all.length, withoutLocation: without, employer: money(employer), employeeShare: money(share), deducted: money(deducted), differ, totalPayable: money(employer + share) };
  out.byLocation = [...by.values()].sort((a, b) => (a.locationId ? 0 : 1) - (b.locationId ? 0 : 1) || a.name.localeCompare(b.name)).map((b) => {
    const v = vouchers.find((x) => x.locationId === b.locationId);
    return { locationId: b.locationId, name: b.name, employees: b.employees, employer: money(b.employer), employeeShare: money(b.employeeShare), total: money(b.employer + b.employeeShare),
      voucher: v ? { id: v.id, label: `EOV-${pad5(v.voucherNo)}`, status: v.status } : null, locked: b.locationId ? locked.has(b.locationId) : false, canVoucher: Boolean(b.locationId) && !v, hint: b.locationId ? null : 'assign a location first' };
  });
  const [{ m }] = await q(`SELECT count(*)::int AS m FROM payroll_employees e WHERE e."companyId" = :companyId AND NOT e."isClosed" AND NOT EXISTS (SELECT 1 FROM eobi_list_rows r WHERE r."employeeId" = e.id AND r.month = :first)`, { companyId, first });
  out.notOnAnyList = m;
  return out;
}

/** Works the amounts of the unlocked rows of a list out again at the rate in effect for its month. */
async function recalcRows(companyId, listId, month, transaction) {
  const rate = await effectiveRate(companyId, month, transaction);
  if (!rate) throw AppError.rule('NO_EOBI_RATE', `There is no EOBI rate for ${monthLabel(month)}: save a rate from this month or an earlier one first`);
  const list = await listOr404(companyId, listId, transaction);
  const locked = [...(await lockedLocations(companyId, list.providerId, month, transaction))];
  const s = sharesOf(rate);
  const repl = { listId, wage: money(s.wage), employer: money(s.employer), employee: money(s.employee) };
  const lockSql = locked.length ? ' AND ("locationId" IS NULL OR "locationId" NOT IN (:locked))' : '';
  if (locked.length) repl.locked = locked;
  const done = await q(`UPDATE eobi_list_rows SET wage = :wage, "employerAmount" = :employer, "employeeAmount" = :employee, "updatedAt" = now() WHERE "listId" = :listId${lockSql} RETURNING id`, repl, transaction);
  return { updated: done.length, locked: locked.length };
}

async function recalculate(req, listId) {
  const { companyId } = req.user;
  let r;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const list = await listOr404(companyId, listId, transaction);
    r = await recalcRows(companyId, listId, list.month, transaction);
    await audit.log(req, { action: 'EOBI_LIST_RECALCULATED', entityType: 'EobiList', entityId: listId, after: r }, { transaction });
  });
  return r;
}

/** Makes the list of a month: a copy of the month before (or the one named), or an empty one. */
async function createList(req, { providerId, month, mode = 'COPY', copyFromMonth }) {
  const { companyId } = req.user;
  const first = `${month}-01`;
  let result = {};
  const id = await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    await providerOr404(companyId, providerId, transaction);
    if ((await q('SELECT 1 FROM eobi_lists WHERE "providerId" = :providerId AND month = :first', { providerId, first }, transaction)).length) throw AppError.rule('LIST_EXISTS', `There is already a list for ${monthLabel(month)}`);
    const [row] = await q('INSERT INTO eobi_lists ("companyId", "providerId", month, "createdById") VALUES (:companyId, :providerId, :first, :userId) RETURNING id', { companyId, providerId, first, userId: req.user.id }, transaction);
    result = { copied: 0, skippedLeavers: [], skippedOtherList: [] };
    if (mode === 'COPY') {
      const [src] = copyFromMonth
        ? await q('SELECT id, to_char(month, \'YYYY-MM\') AS month FROM eobi_lists WHERE "providerId" = :providerId AND month = :m', { providerId, m: `${copyFromMonth}-01` }, transaction)
        : await q('SELECT id, to_char(month, \'YYYY-MM\') AS month FROM eobi_lists WHERE "providerId" = :providerId AND month < :first ORDER BY month DESC LIMIT 1', { providerId, first }, transaction);
      if (!src) throw AppError.rule('NO_PREVIOUS_LIST', 'There is no earlier list to copy: create an empty one');
      const rate = await effectiveRate(companyId, month, transaction);
      const prev = await q('SELECT r."employeeId", r."locationId", e.code, e.name, e."isClosed" FROM eobi_list_rows r JOIN payroll_employees e ON e.id = r."employeeId" WHERE r."listId" = :id ORDER BY e.code', { id: src.id }, transaction);
      if (prev.length && !rate) throw AppError.rule('NO_EOBI_RATE', `There is no EOBI rate for ${monthLabel(month)}: save a rate from this month or an earlier one first`);
      const busy = new Set((await q('SELECT "employeeId" FROM eobi_list_rows WHERE "companyId" = :companyId AND month = :first', { companyId, first }, transaction)).map((r) => r.employeeId));
      const s = rate ? sharesOf(rate) : null;
      for (const p of prev) {
        if (p.isClosed) { result.skippedLeavers.push({ code: p.code, name: p.name }); continue; }
        if (busy.has(p.employeeId)) { result.skippedOtherList.push({ code: p.code, name: p.name }); continue; }
        await run(`INSERT INTO eobi_list_rows ("companyId", "listId", month, "employeeId", "locationId", wage, "employerAmount", "employeeAmount", source) VALUES (:companyId, :listId, :first, :employeeId, :locationId, :wage, :employer, :employee, 'COPY')`,
          { companyId, listId: row.id, first, employeeId: p.employeeId, locationId: p.locationId, wage: money(s.wage), employer: money(s.employer), employee: money(s.employee) }, transaction);
        result.copied += 1;
      }
      result.copiedFrom = src.month;
    }
    await audit.log(req, { action: 'EOBI_LIST_CREATED', entityType: 'EobiList', entityId: row.id, after: { month, mode, copied: result.copied, skippedLeavers: result.skippedLeavers.length, skippedOtherList: result.skippedOtherList.length } }, { transaction });
    return row.id;
  });
  return { ...(await view(req, { providerId, month })), listId: id, ...result };
}

async function removeList(req, listId) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const list = await listOr404(companyId, listId, transaction);
    if ((await lockedLocations(companyId, list.providerId, list.month, transaction)).size) throw AppError.rule('LIST_HAS_VOUCHER', 'A location of this list has a confirmed EOBI voucher: move the voucher to draft first');
    await run('DELETE FROM eobi_vouchers WHERE "companyId" = :companyId AND "providerId" = :providerId AND month = :first', { companyId, providerId: list.providerId, first: `${list.month}-01` }, transaction);
    await run('DELETE FROM eobi_lists WHERE id = :listId', { listId }, transaction);
    await audit.log(req, { action: 'EOBI_LIST_DELETED', entityType: 'EobiList', entityId: listId, before: { month: list.month } }, { transaction });
  });
}

/** Employees who are not on any EOBI list this month (the "Add employees" box), found by name, ID or CNIC. */
async function candidates(req, listId, { search, limit = 100 }) {
  const { companyId } = req.user;
  const list = await listOr404(companyId, listId);
  const repl = { companyId, first: `${list.month}-01`, limit };
  const where = ['e."companyId" = :companyId', 'NOT e."isClosed"', 'NOT EXISTS (SELECT 1 FROM eobi_list_rows r WHERE r."employeeId" = e.id AND r.month = :first)'];
  if (search) {
    repl.like = `%${search}%`;
    const digits = search.replace(/\D/g, '');
    const numeric = /^\d+$/.test(search) && search.length <= 8 ? ' OR e.code = :n' : '';
    if (numeric) repl.n = Number(search);
    if (digits.length >= 3) repl.digits = `%${digits}%`;
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like${repl.digits ? ' OR replace(e.cnic, \'-\', \'\') LIKE :digits' : ''}${numeric})`);
  }
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM payroll_employees e WHERE ${where.join(' AND ')}`, repl);
  const rows = await q(`SELECT e.id, e.code, e.name, e.cnic, d.name AS department FROM payroll_employees e LEFT JOIN payroll_departments d ON d.id = e."departmentId" WHERE ${where.join(' AND ')} ORDER BY e.name, e.code LIMIT :limit`, repl);
  return { total: n, data: rows.map((e) => ({ id: e.id, code: e.code, label: pad5(e.code), name: e.name, cnic: e.cnic, department: e.department })) };
}

async function checkLocation(companyId, list, locationId, locked, transaction) {
  if (!locationId) return null;
  const [l] = await q('SELECT id, name, "isActive" FROM eobi_locations WHERE id = :id AND "companyId" = :companyId AND "providerId" = :providerId', { id: locationId, companyId, providerId: list.providerId }, transaction);
  if (!l) throw AppError.notFound('Location');
  if (!l.isActive) throw AppError.rule('LOCATION_INACTIVE', `${l.name} is switched off`);
  if (locked.has(locationId)) throw AppError.rule('LOCATION_LOCKED', `${l.name} has a confirmed EOBI voucher this month: move it to draft first`);
  return l;
}

/** Adds employees by id. Those who cannot be added are listed with the reason (already on this list, on another provider's list, left the company). */
async function addRows(req, listId, { employeeIds, locationId }) {
  const { companyId } = req.user;
  let out;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const list = await listOr404(companyId, listId, transaction);
    const first = `${list.month}-01`;
    const locked = await lockedLocations(companyId, list.providerId, list.month, transaction);
    await checkLocation(companyId, list, locationId, locked, transaction);
    const rate = await effectiveRate(companyId, list.month, transaction);
    if (!rate) throw AppError.rule('NO_EOBI_RATE', `There is no EOBI rate for ${monthLabel(list.month)}: save a rate from this month or an earlier one first`);
    out = await insertEmployees(companyId, list, first, rate, employeeIds.map((id) => ({ employeeId: id, locationId: locationId || null })), 'MANUAL', transaction);
    await audit.log(req, { action: 'EOBI_LIST_EMPLOYEES_ADDED', entityType: 'EobiList', entityId: listId, after: { added: out.added, skipped: out.skipped.length } }, { transaction });
  });
  return out;
}

async function insertEmployees(companyId, list, first, rate, items, source, transaction) {
  const s = sharesOf(rate);
  const emps = await q('SELECT id, code, name, "isClosed" FROM payroll_employees WHERE "companyId" = :companyId AND id IN (:ids)', { companyId, ids: items.map((i) => i.employeeId) }, transaction);
  const byId = new Map(emps.map((e) => [e.id, e]));
  const on = await q(`SELECT r."employeeId", r."listId", p.name AS provider FROM eobi_list_rows r JOIN eobi_lists l ON l.id = r."listId" JOIN eobi_providers p ON p.id = l."providerId"
    WHERE r."companyId" = :companyId AND r.month = :first AND r."employeeId" IN (:ids)`, { companyId, first, ids: items.map((i) => i.employeeId) }, transaction);
  const onBy = new Map(on.map((r) => [r.employeeId, r]));
  const skipped = [];
  let added = 0;
  for (const it of items) {
    const e = byId.get(it.employeeId);
    if (!e) throw AppError.notFound('Employee');
    const was = onBy.get(it.employeeId);
    if (e.isClosed) { skipped.push({ code: e.code, name: e.name, reason: 'EMPLOYEE_CLOSED' }); continue; }
    if (was) { skipped.push({ code: e.code, name: e.name, reason: was.listId === list.id ? 'ALREADY_ON_LIST' : 'ON_OTHER_LIST', provider: was.listId === list.id ? undefined : was.provider }); continue; }
    await run(`INSERT INTO eobi_list_rows ("companyId", "listId", month, "employeeId", "locationId", wage, "employerAmount", "employeeAmount", source) VALUES (:companyId, :listId, :first, :employeeId, :locationId, :wage, :employer, :employee, :source)`,
      { companyId, listId: list.id, first, employeeId: it.employeeId, locationId: it.locationId, wage: money(s.wage), employer: money(s.employer), employee: money(s.employee), source }, transaction);
    added += 1;
  }
  return { added, skipped };
}

async function removeRows(req, listId, { rowIds }) {
  const { companyId } = req.user;
  let n = 0;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const list = await listOr404(companyId, listId, transaction);
    const locked = await lockedLocations(companyId, list.providerId, list.month, transaction);
    const rows = await q('SELECT id, "locationId" FROM eobi_list_rows WHERE "listId" = :listId AND id IN (:rowIds)', { listId, rowIds }, transaction);
    if (rows.length !== new Set(rowIds).size) throw AppError.notFound('List row');
    if (rows.some((r) => r.locationId && locked.has(r.locationId))) throw AppError.rule('ROW_LOCKED', 'A ticked employee is under a location with a confirmed EOBI voucher: move the voucher to draft first');
    await run('DELETE FROM eobi_list_rows WHERE "listId" = :listId AND id IN (:rowIds)', { listId, rowIds }, transaction);
    n = rows.length;
    await audit.log(req, { action: 'EOBI_LIST_EMPLOYEES_REMOVED', entityType: 'EobiList', entityId: listId, after: { removed: n } }, { transaction });
  });
  return { removed: n };
}

/** "Save locations" / "set for ticked": gives rows a location (or none). */
async function setLocations(req, listId, { items }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const list = await listOr404(companyId, listId, transaction);
    const locked = await lockedLocations(companyId, list.providerId, list.month, transaction);
    const rows = await q('SELECT id, "locationId" FROM eobi_list_rows WHERE "listId" = :listId AND id IN (:ids)', { listId, ids: items.map((i) => i.rowId) }, transaction);
    if (rows.length !== new Set(items.map((i) => i.rowId)).size) throw AppError.notFound('List row');
    const checked = new Set();
    for (const it of items) {
      const row = rows.find((r) => r.id === it.rowId);
      if (row.locationId && locked.has(row.locationId) && row.locationId !== (it.locationId || null)) throw AppError.rule('ROW_LOCKED', 'An employee is under a location with a confirmed EOBI voucher: move the voucher to draft first');
      if (it.locationId && !checked.has(it.locationId)) { if (row.locationId !== it.locationId) await checkLocation(companyId, list, it.locationId, locked, transaction); checked.add(it.locationId); }
      await run('UPDATE eobi_list_rows SET "locationId" = :locationId, "updatedAt" = now() WHERE id = :id', { id: it.rowId, locationId: it.locationId || null }, transaction);
    }
    await audit.log(req, { action: 'EOBI_LIST_LOCATIONS_SET', entityType: 'EobiList', entityId: listId, after: { rows: items.length } }, { transaction });
  });
  return { updated: items.length };
}

// ---- import from a sheet ----

const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/**
 * A sheet (the frontend reads the Excel / CSV and sends the rows): each row has an `employeeId` (the Employee ID of the Employee Master) or a `cnic`, and optionally a `location` (by name).
 * Everything that can be added is added; the rest is reported with its reason. `dryRun` only reports.
 */
async function importRows(req, listId, { rows, locationId, dryRun }) {
  const { companyId } = req.user;
  let report;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const list = await listOr404(companyId, listId, transaction);
    const first = `${list.month}-01`;
    const locked = await lockedLocations(companyId, list.providerId, list.month, transaction);
    const defaultLocation = await checkLocation(companyId, list, locationId, locked, transaction);
    const rate = await effectiveRate(companyId, list.month, transaction);
    if (!rate && !dryRun) throw AppError.rule('NO_EOBI_RATE', `There is no EOBI rate for ${monthLabel(list.month)}: save a rate from this month or an earlier one first`);
    const locs = await q('SELECT id, name, "isActive" FROM eobi_locations WHERE "companyId" = :companyId AND "providerId" = :providerId', { companyId, providerId: list.providerId }, transaction);
    const codes = rows.map((r) => (/^\d{1,8}$/.test(String(r.employeeId == null ? '' : r.employeeId).trim()) ? Number(String(r.employeeId).trim()) : null)).filter((c) => c);
    const cnics = rows.map((r) => digitsOf(r.cnic)).filter((c) => c.length === 13);
    const emps = codes.length || cnics.length
      ? await q(`SELECT id, code, name, "isClosed", replace(cnic, '-', '') AS cnic FROM payroll_employees WHERE "companyId" = :companyId AND (code IN (:codes) OR replace(cnic, '-', '') IN (:cnics))`,
        { companyId, codes: codes.length ? codes : [0], cnics: cnics.length ? cnics : ['-'] }, transaction)
      : [];
    const byCode = new Map(emps.map((e) => [e.code, e]));
    const byCnic = new Map(emps.filter((e) => e.cnic).map((e) => [e.cnic, e]));
    const on = await q(`SELECT r."employeeId", r."listId", p.name AS provider FROM eobi_list_rows r JOIN eobi_lists l ON l.id = r."listId" JOIN eobi_providers p ON p.id = l."providerId" WHERE r."companyId" = :companyId AND r.month = :first`, { companyId, first }, transaction);
    const onBy = new Map(on.map((r) => [r.employeeId, r]));
    const seen = new Set();
    const results = [];
    const toAdd = [];
    rows.forEach((raw, i) => {
      const idText = String(raw.employeeId == null ? '' : raw.employeeId).trim();
      const cnic = digitsOf(raw.cnic);
      const res = { row: i + 1, employeeId: idText || null, cnic: raw.cnic == null || raw.cnic === '' ? null : String(raw.cnic), location: raw.location == null || raw.location === '' ? null : String(raw.location).trim() };
      let e = null;
      if (idText && /^\d{1,8}$/.test(idText)) e = byCode.get(Number(idText)) || null;
      if (!e && cnic.length === 13) e = byCnic.get(cnic) || null;
      if (!idText && !cnic) res.status = 'NO_ID';
      else if (!e) res.status = 'NOT_FOUND';
      else {
        res.employee = { code: e.code, name: e.name };
        const loc = res.location ? locs.find((l) => l.name.toLowerCase() === res.location.toLowerCase()) : null;
        if (seen.has(e.id)) res.status = 'DUPLICATE_IN_FILE';
        else if (e.isClosed) res.status = 'EMPLOYEE_CLOSED';
        else if (onBy.get(e.id) && onBy.get(e.id).listId === list.id) res.status = 'ALREADY_ON_LIST';
        else if (onBy.get(e.id)) { res.status = 'ON_OTHER_LIST'; res.provider = onBy.get(e.id).provider; }
        else if (res.location && (!loc || !loc.isActive)) res.status = 'UNKNOWN_LOCATION';
        else if (loc && locked.has(loc.id)) res.status = 'LOCATION_LOCKED';
        else { res.status = 'ADDED'; seen.add(e.id); toAdd.push({ employeeId: e.id, locationId: loc ? loc.id : defaultLocation ? defaultLocation.id : null }); }
      }
      results.push(res);
    });
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    if (!dryRun && toAdd.length) await insertEmployees(companyId, list, first, rate, toAdd, 'EXCEL', transaction);
    report = { dryRun: Boolean(dryRun), total: rows.length, added: counts.ADDED || 0, notAdded: rows.length - (counts.ADDED || 0), counts, results: results.slice(0, 1000) };
    if (!dryRun) await audit.log(req, { action: 'EOBI_LIST_IMPORTED', entityType: 'EobiList', entityId: listId, after: { total: rows.length, added: report.added, counts } }, { transaction });
  });
  return report;
}

// ---- the summary of a year ----

async function summary(req, { providerId, year }) {
  const { companyId } = req.user;
  const provider = await providerOr404(companyId, providerId);
  const y = year || Number(today().slice(0, 4));
  const rows = await q(`SELECT to_char(r.month, 'YYYY-MM') AS month, count(*)::int AS employees, COALESCE(SUM(r."employerAmount"), 0)::text AS employer, COALESCE(SUM(r."employeeAmount"), 0)::text AS share,
      COALESCE(SUM(s.amt::numeric), 0)::text AS deducted
    FROM eobi_list_rows r JOIN eobi_lists l ON l.id = r."listId"
    LEFT JOIN LATERAL (SELECT sl."eobiAmount"::text AS amt FROM payroll_slips sl JOIN payroll_runs pr ON pr.id = sl."runId" WHERE sl."employeeId" = r."employeeId" AND pr.month = r.month AND sl.status <> 'SUSPENDED' ORDER BY sl."updatedAt" DESC LIMIT 1) s ON true
    WHERE l."providerId" = :providerId AND EXTRACT(YEAR FROM r.month) = :year GROUP BY 1 ORDER BY 1`, { providerId, year: y });
  const vouchers = await q(`SELECT to_char(month, 'YYYY-MM') AS month, count(*)::int AS vouchers, count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed, COALESCE(SUM(amount) FILTER (WHERE status = 'CONFIRMED'), 0)::text AS paid
    FROM eobi_vouchers WHERE "providerId" = :providerId AND EXTRACT(YEAR FROM month) = :year GROUP BY 1`, { providerId, year: y });
  const months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  const data = months.map((m) => {
    const r = rows.find((x) => x.month === m);
    const v = vouchers.find((x) => x.month === m);
    const employer = r ? toCents(r.employer) : 0n;
    const share = r ? toCents(r.share) : 0n;
    return { month: m, monthLabel: monthLabel(m), hasList: Boolean(r), employees: r ? r.employees : 0, employer: money(employer), employeeShare: money(share), totalPayable: money(employer + share), deducted: money(r ? toCents(r.deducted) : 0n),
      vouchers: v ? v.vouchers : 0, confirmedVouchers: v ? v.confirmed : 0, paid: money(v ? toCents(v.paid) : 0n) };
  });
  const sum = (k) => money(data.reduce((t, d) => t + toCents(d[k]), 0n));
  return { provider: { id: provider.id, name: provider.name }, year: y, data, totals: { employer: sum('employer'), employeeShare: sum('employeeShare'), totalPayable: sum('totalPayable'), deducted: sum('deducted'), paid: sum('paid') } };
}

/** For the payroll: the employee share (cents) of each of these employees on a list of the month; an employee on no list is missing from the map. */
async function eobiShares(companyId, employeeIds, month, transaction) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const rows = await q('SELECT "employeeId", "employeeAmount"::text AS amount FROM eobi_list_rows WHERE "companyId" = :companyId AND month = :first AND "employeeId" IN (:employeeIds)', { companyId, first: `${month}-01`, employeeIds }, transaction);
  for (const r of rows) out.set(r.employeeId, toCents(r.amount));
  return out;
}

module.exports = {
  providers, createProvider, updateProvider, removeProvider, createLocation, updateLocation, removeLocation, listRates, saveRate, removeRate, view, createList, removeList, recalculate, candidates, addRows, removeRows,
  setLocations, importRows, summary, eobiShares, effectiveRate, sharesOf, lockedLocations, monthLabel, listOr404, providerOr404,
};
