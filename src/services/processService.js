// The client admin's processes (owner 2026-11-16, changed 2026-11-17): Process Management > Settings > Processes.
//   The super admin switches Process Management on for a company and gives it a LIMIT (companies.processManagement / processLimit). With it ON the client admin adds his own processes here
//   (Dyeing, Stitching ... any name). A process he adds is a service of his company (services.companyId) and works exactly like the ones the super admin gave (menu, jobs, users, chemical access).
//   With it OFF the company has no Process Management at all: no tab, no processes (accessService.companyServices), and this screen is closed.
//   THE LIMIT counts every ACTIVE process the company can use: its own + the ones the super admin gave. The client admin chooses which of them stay active:
//     - an own process is active when services.isActive; an assigned one when company_services.isActive (the company's own switch, never on the shared platform row);
//     - an inactive process is hidden from the menus and cannot be given to users, nothing is deleted;
//     - switching ON or adding needs  active < limit; switching OFF is always allowed.
//   When the super admin lowers the limit below what is active nothing is switched off for him: `overLimit` is true until he switches enough off himself (he cannot add or switch on meanwhile).
const { Op } = require('sequelize');
const { sequelize, Company, Service, CompanyService, UserService, User } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const clean = (s) => String(s).trim().replace(/\s+/g, ' ');
const norm = (s) => clean(s).toLowerCase();

const json = (s, extra = {}) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, menuGroup: s.menuGroup, tracksColour: s.tracksColour, isActive: s.isActive, sortOrder: s.sortOrder, ...extra });

async function companyOf(req, transaction, lock = false) {
  const company = await Company.findByPk(req.user.companyId, { transaction, lock: lock ? transaction.LOCK.UPDATE : undefined });
  if (!company) throw AppError.notFound('Company');
  return company;
}

/** The screen is closed while the super admin has Process Management off for this company. */
function assertOn(company) {
  if (!company.processManagement) throw new AppError(403, 'PROCESS_MANAGEMENT_OFF', 'Process Management is not switched on for your company');
}

/** How many processes of the company are active now: its own and the assigned ones (a platform process the super admin switched off does not count). */
async function activeCount(companyId, transaction) {
  const [r] = await q(`SELECT count(*)::int AS n FROM company_services cs JOIN services s ON s.id = cs."serviceId"
    WHERE cs."companyId" = :companyId AND s.kind = 'PROCESS' AND s."isActive" AND cs."isActive"`, { companyId }, transaction);
  return r.n;
}

/** Where is this process used? (anything that makes deleting it unsafe). */
const USES = [
  ['jobs', 'jobs', '"departmentId" = :id OR "fromDepartmentId" = :id'],
  ['SO cards', 'so_cards', '"currentDepartmentId" = :id'],
  ['SO card moves', 'so_card_moves', '"fromDepartmentId" = :id OR "toDepartmentId" = :id'],
  ['chemical requests', 'chemical_requests', '"departmentId" = :id'],
  ['chemical returns', 'chemical_returns', '"departmentId" = :id'],
  ['store moves', 'store_moves', '"departmentId" = :id'],
];
async function usageOf(id, transaction) {
  const out = {};
  for (const [label, table, cond] of USES) {
    const [r] = await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${cond}`, { id }, transaction);
    if (r.n) out[label] = r.n;
  }
  return out;
}

/** The users who were given these processes. */
async function userCounts(ids, transaction) {
  if (!ids.length) return {};
  const rows = await q('SELECT "serviceId", count(*)::int AS n FROM user_services WHERE "serviceId" IN (:ids) GROUP BY "serviceId"', { ids }, transaction);
  return Object.fromEntries(rows.map((g) => [g.serviceId, g.n]));
}

/** GET /processes: the switch, the limit, how many are ACTIVE, and the list: own (editable) and assigned (given by the super admin: only the active switch is his). */
async function list(req) {
  const { companyId } = req.user;
  const company = await companyOf(req);
  assertOn(company);
  const own = await Service.findAll({ where: { companyId }, order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
  const assigned = await Service.findAll({
    where: { companyId: null, kind: 'PROCESS', isActive: true },
    include: [{ model: Company, as: 'companies', where: { id: companyId }, attributes: [], through: { attributes: [] }, required: true }],
    order: [['sortOrder', 'ASC'], ['name', 'ASC']],
  });
  const flags = assigned.length ? await q('SELECT "serviceId", "isActive" FROM company_services WHERE "companyId" = :companyId AND "serviceId" IN (:ids)', { companyId, ids: assigned.map((s) => s.id) }) : [];
  const on = Object.fromEntries(flags.map((f) => [f.serviceId, f.isActive]));
  const users = await userCounts([...own, ...assigned].map((s) => s.id));
  const used = await activeCount(companyId);
  const limit = company.processLimit;
  const row = async (s, extra = {}) => {
    const usage = await usageOf(s.id);
    return json(s, { userCount: users[s.id] || 0, usage, ...extra });
  };
  return {
    enabled: company.processManagement, limit, used, remaining: Math.max(0, limit - used), canAdd: company.processManagement && used < limit, overLimit: used > limit,
    data: await Promise.all(own.map(async (s) => row(s, { isOwn: true, canDelete: Object.keys(await usageOf(s.id)).length === 0 }))),
    assigned: await Promise.all(assigned.map((s) => row(s, { isOwn: false, isActive: on[s.id] !== false }))),
  };
}

const codeBase = (name) => {
  let c = String(name).toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!c) c = 'PROCESS';
  if (!/^[A-Z]/.test(c)) c = `P_${c}`;
  return c.slice(0, 34);
};

/** A code that is free inside this company and is not a code of a platform service that is not a process (SO_CARD, FOLDING, PACKING ...). */
async function freeCode(companyId, name, transaction) {
  const taken = new Set((await q('SELECT s.code FROM company_services cs JOIN services s ON s.id = cs."serviceId" WHERE cs."companyId" = :companyId', { companyId }, transaction)).map((s) => s.code));
  const reserved = new Set((await Service.findAll({ where: { companyId: null, kind: { [Op.ne]: 'PROCESS' } }, attributes: ['code'], transaction })).map((s) => s.code));
  const base = codeBase(name);
  let code = base;
  for (let i = 2; taken.has(code) || reserved.has(code); i += 1) code = `${base}_${i}`;
  return code;
}

async function assertNameFree(companyId, name, exceptId, transaction) {
  const all = await Service.findAll({ include: [{ model: Company, as: 'companies', where: { id: companyId }, attributes: [], through: { attributes: [] }, required: true }], where: { kind: 'PROCESS' }, transaction });
  if (all.some((s) => s.id !== exceptId && norm(s.name) === norm(name))) throw AppError.rule('PROCESS_NAME_TAKEN', `You already have a process called "${name}"`);
}

const limitError = (limit, used) => AppError.rule('PROCESS_LIMIT_REACHED', limit === 0
  ? 'The super admin has not given your company any process to use'
  : `Your limit is ${limit} active processes and ${used} are active. Switch one off first, or ask the super admin to raise the limit`, { limit, used });

/** POST /processes {name, tracksColour?}: adds one, while the active ones (own + assigned) are fewer than the limit. */
async function create(req, { name, tracksColour = true }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const company = await companyOf(req, transaction, true);
    assertOn(company);
    const used = await activeCount(companyId, transaction);
    if (used >= company.processLimit) throw limitError(company.processLimit, used);
    await assertNameFree(companyId, name, null, transaction);
    const code = await freeCode(companyId, name, transaction);
    const mine = await Service.max('sortOrder', { where: { companyId }, transaction });
    const service = await Service.create({ code, name: clean(name), kind: 'PROCESS', menuGroup: 'PROCESS', tracksColour, isActive: true, sortOrder: (mine || 190) + 10, companyId }, { transaction });
    await CompanyService.create({ companyId, serviceId: service.id, givenById: req.user.id }, { transaction });
    // the end of every process: Folding and Packing (idempotent)
    const ends = await Service.findAll({ where: { kind: ['FOLDING', 'PACKING'], isActive: true, companyId: null }, transaction });
    const have = new Set((await CompanyService.findAll({ where: { companyId, serviceId: ends.map((s) => s.id) }, transaction })).map((r) => r.serviceId));
    await CompanyService.bulkCreate(ends.filter((s) => !have.has(s.id)).map((s) => ({ companyId, serviceId: s.id, givenById: req.user.id })), { transaction });
    await audit.log(req, { action: 'PROCESS_CREATED', entityType: 'Service', entityId: service.id, after: json(service) }, { transaction });
    return json(service, { isOwn: true, userCount: 0, usage: {}, canDelete: true });
  });
}

/** One of the processes the company uses: its own, or a platform process the super admin gave it. */
async function processOr404(req, id, transaction) {
  const own = await Service.findOne({ where: { id, companyId: req.user.companyId }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (own) return { service: own, isOwn: true };
  const link = await CompanyService.findOne({ where: { companyId: req.user.companyId, serviceId: id }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  const platform = link && (await Service.findOne({ where: { id, companyId: null, kind: 'PROCESS' }, transaction }));
  if (!platform) throw AppError.notFound('Process');
  return { service: platform, isOwn: false, link };
}

/** PATCH /processes/:id. Own: {name?, isActive?, tracksColour?, sortOrder?}. Assigned (given by the super admin): ONLY {isActive}. The code never changes. */
async function update(req, id, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const company = await companyOf(req, transaction, true);
    assertOn(company);
    const { service: s, isOwn, link } = await processOr404(req, id, transaction);
    if (!isOwn && Object.keys(changes).some((k) => k !== 'isActive')) {
      throw AppError.rule('PROCESS_NOT_EDITABLE', 'This process was given by the super admin: you can only switch it on or off', { editable: ['isActive'] });
    }
    const was = isOwn ? s.isActive : link.isActive;
    // switching ON needs room under the limit (the count is taken BEFORE the change); switching OFF is always allowed
    if (changes.isActive === true && !was) {
      const used = await activeCount(companyId, transaction);
      if (used >= company.processLimit) throw limitError(company.processLimit, used);
    }
    const before = json(s, { isActive: was });
    if (isOwn) {
      if (changes.name !== undefined) { await assertNameFree(companyId, changes.name, id, transaction); s.name = clean(changes.name); }
      for (const f of ['isActive', 'tracksColour', 'sortOrder']) if (changes[f] !== undefined) s[f] = changes[f];
      await s.save({ transaction });
    } else if (changes.isActive !== undefined) {
      await CompanyService.update({ isActive: changes.isActive }, { where: { companyId, serviceId: id }, transaction });
    }
    const now = isOwn ? s.isActive : (changes.isActive !== undefined ? changes.isActive : link.isActive);
    await audit.log(req, { action: isOwn ? 'PROCESS_UPDATED' : 'PROCESS_ACTIVE_CHANGED', entityType: 'Service', entityId: id, before, after: json(s, { isActive: now }) }, { transaction });
    const used = await activeCount(companyId, transaction);
    return json(s, { isOwn, isActive: now, usage: await usageOf(id, transaction), userCount: (await userCounts([id], transaction))[id] || 0, limit: company.processLimit, used, overLimit: used > company.processLimit });
  });
}

/** DELETE /processes/:id: only his own process that nothing was ever done in. Otherwise switch it off (isActive false). A platform process cannot be deleted. */
async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    assertOn(await companyOf(req, transaction));
    const { service: s, isOwn } = await processOr404(req, id, transaction);
    if (!isOwn) throw AppError.notFound('Process');
    const usage = await usageOf(id, transaction);
    if (Object.keys(usage).length) throw AppError.rule('PROCESS_IN_USE', 'This process has work in it (jobs, SO cards or chemicals). Switch it off instead of deleting it', { usage });
    const userIds = (await User.findAll({ attributes: ['id'], where: { companyId: req.user.companyId }, transaction })).map((u) => u.id);
    await UserService.destroy({ where: { serviceId: id, userId: userIds }, transaction });
    await sequelize.query('DELETE FROM department_chemicals WHERE "departmentId" = :id', { replacements: { id }, transaction });
    await CompanyService.destroy({ where: { serviceId: id }, transaction });
    const before = json(s);
    await s.destroy({ transaction });
    await audit.log(req, { action: 'PROCESS_DELETED', entityType: 'Service', entityId: id, before, after: null }, { transaction });
    return { deleted: true, id };
  });
}

module.exports = { list, create, update, remove, activeCount };
