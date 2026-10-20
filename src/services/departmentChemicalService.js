// Department chemical access. The Chemical Store decides which chemicals each department sees;
// a department sees NO chemical until the store gives it some. Later the department can request
// only these chemicals.
//   store side:      list departments, see / set one department's chemicals (replace, add, remove)
//   department side: its own chemicals (with stock), nothing else
const { Op } = require('sequelize');
const { sequelize, DepartmentChemical, StoreItem, StoreCategory } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const { companyServices, userServices } = require('./accessService');
const m = require('./storeMasterService');

const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const deptJSON = (s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind });

async function departments(req, transaction) {
  return (await companyServices(req.user.companyId, transaction)).filter((s) => DEPARTMENT_KINDS.includes(s.kind));
}

async function departmentOr404(req, departmentId, transaction) {
  const d = (await departments(req, transaction)).find((s) => s.id === departmentId || s.code === String(departmentId).toUpperCase());
  if (!d) throw AppError.notFound('Department');
  return d;
}

const chemicals = (companyId, where = {}) => StoreItem.findAll({
  where: { companyId, store: 'CHEMICAL', ...where },
  include: m.itemInclude,
  order: [[{ model: StoreCategory, as: 'category' }, 'name', 'ASC'], ['name', 'ASC']],
});

/** Store screen: every department with how many chemicals it can see. */
async function list(req) {
  const depts = await departments(req);
  const counts = await DepartmentChemical.findAll({
    where: { companyId: req.user.companyId },
    attributes: ['departmentId', [sequelize.fn('count', sequelize.col('id')), 'n']],
    group: ['departmentId'],
    raw: true,
  });
  const n = Object.fromEntries(counts.map((c) => [c.departmentId, Number(c.n)]));
  return { data: depts.map((d) => ({ ...deptJSON(d), chemicalCount: n[d.id] || 0 })) };
}

/** Store screen for one department: ALL chemicals, each with allowed true/false, grouped by category. */
async function get(req, departmentId) {
  const d = await departmentOr404(req, departmentId);
  const [items, given] = await Promise.all([
    chemicals(req.user.companyId, { isActive: true }),
    DepartmentChemical.findAll({ where: { companyId: req.user.companyId, departmentId: d.id } }),
  ]);
  const allowed = new Set(given.map((g) => g.itemId));
  const groups = {};
  for (const i of items) {
    const key = i.category ? i.category.id : 'none';
    groups[key] ||= { category: i.category ? m.namedJSON(i.category) : null, items: [] };
    groups[key].items.push({ id: i.id, name: i.name, label: m.itemJSON(i).label, unit: i.unit, allowed: allowed.has(i.id) });
  }
  return {
    department: deptJSON(d),
    allowedCount: items.filter((i) => allowed.has(i.id)).length,
    totalCount: items.length,
    groups: Object.values(groups).map((g) => ({ ...g, allowedCount: g.items.filter((i) => i.allowed).length })),
  };
}

async function checkItems(req, itemIds, transaction) {
  const ids = [...new Set(itemIds)];
  if (!ids.length) return ids;
  const found = await StoreItem.count({ where: { id: ids, companyId: req.user.companyId, store: 'CHEMICAL' }, transaction });
  if (found !== ids.length) throw AppError.rule('UNKNOWN_ITEM', 'Some chemicals are not in the chemical store');
  return ids;
}

/**
 * Change one department's chemicals.
 *   { itemIds }        the whole new list (replaces; [] = sees nothing)
 *   { add, remove }    only the changes (e.g. ticking a whole category)
 */
async function set(req, departmentId, { itemIds, add, remove }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const d = await departmentOr404(req, departmentId, transaction);
    const before = (await DepartmentChemical.findAll({ where: { companyId, departmentId: d.id }, transaction })).map((g) => g.itemId);
    let next = new Set(before);
    if (itemIds) next = new Set(await checkItems(req, itemIds, transaction));
    for (const id of await checkItems(req, add || [], transaction)) next.add(id);
    for (const id of remove || []) next.delete(id);
    const toAdd = [...next].filter((id) => !before.includes(id));
    const toRemove = before.filter((id) => !next.has(id));
    if (toRemove.length) await DepartmentChemical.destroy({ where: { companyId, departmentId: d.id, itemId: toRemove }, transaction });
    if (toAdd.length) {
      await DepartmentChemical.bulkCreate(toAdd.map((itemId) => ({ companyId, departmentId: d.id, itemId, createdById: req.user.id })), { transaction });
    }
    await audit.log(req, {
      action: 'DEPARTMENT_CHEMICALS_SET', entityType: 'Service', entityId: d.id,
      before: { count: before.length }, after: { count: next.size, added: toAdd, removed: toRemove },
    }, { transaction });
    return { department: deptJSON(d), allowedCount: next.size, added: toAdd.length, removed: toRemove.length };
  });
}

/** May the signed-in person use this department's screens? (client admin, or any access to that service) */
async function canSeeDepartment(req, d) {
  if (req.user.userType === 'CLIENT_ADMIN') return true;
  return (await userServices(req.user)).some((g) => g.service.id === d.id);
}

/** Department screen: only the chemicals the store gave this department, with their stock. */
async function mine(req, code, { search, categoryId }) {
  const d = await departmentOr404(req, code);
  if (!(await canSeeDepartment(req, d))) throw AppError.forbidden('You do not have this department');
  const given = await DepartmentChemical.findAll({ where: { companyId: req.user.companyId, departmentId: d.id }, attributes: ['itemId'] });
  const where = { id: given.map((g) => g.itemId), isActive: true };
  if (search) where.name = { [Op.iLike]: `%${search}%` };
  if (categoryId) where.categoryId = categoryId;
  const items = given.length ? await chemicals(req.user.companyId, where) : [];
  return {
    department: deptJSON(d),
    data: items.map((i) => {
      const j = m.itemJSON(i);
      return { id: j.id, name: j.name, label: j.label, unit: j.unit, category: j.category, hasSubUnit: j.hasSubUnit, subUnit: j.subUnit, stockQty: j.stockQty, stock: j.stock };
    }),
  };
}

module.exports = { list, get, set, mine };
