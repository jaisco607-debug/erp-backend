// The super admin's READ-ONLY view of everybody who can log in: who the client admins are, who their
// employees are and which services each employee has. The super admin cannot create, edit, switch off or
// reset an employee (that is the client admin's job). Client admins are managed from the company
// (/v1/companies/:id/admins ...) and super admins from /v1/super-admins.
const { Op } = require('sequelize');
const { sequelize, User, Company } = require('../models');
const AppError = require('../utils/AppError');
const { servicesOfUsers } = require('./accessService');

const companyInclude = [{ model: Company, as: 'company', attributes: ['id', 'name', 'code', 'isActive'], paranoid: false }];

const companyJSON = (c) => (c ? { id: c.id, name: c.name, code: c.code, isActive: c.isActive } : null);

/** number of employees (USER) per company, for the client admin rows */
async function employeeCounts(companyIds) {
  if (!companyIds.length) return new Map();
  const rows = await sequelize.query(
    `SELECT "companyId", count(*)::int AS n FROM users WHERE "userType" = 'USER' AND "deletedAt" IS NULL AND "companyId" IN (:ids) GROUP BY "companyId"`,
    { replacements: { ids: companyIds }, type: sequelize.QueryTypes.SELECT },
  );
  return new Map(rows.map((r) => [r.companyId, r.n]));
}

function rowJSON(u, services, employees) {
  const mine = services.get(u.id) || [];
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, userType: u.userType, isActive: u.isActive,
    company: companyJSON(u.company),
    // employees only: how many services were given to them
    serviceCount: u.userType === 'USER' ? mine.length : null,
    // client admins only: how many employees depend on them
    employeeCount: u.userType === 'CLIENT_ADMIN' ? (employees.get(u.companyId) || 0) : null,
    lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
  };
}

async function summary() {
  const rows = await sequelize.query(
    'SELECT "userType", "isActive", count(*)::int AS n FROM users WHERE "deletedAt" IS NULL GROUP BY 1, 2',
    { type: sequelize.QueryTypes.SELECT },
  );
  const s = { total: 0, superAdmins: 0, clientAdmins: 0, users: 0, active: 0, inactive: 0 };
  for (const r of rows) {
    s.total += r.n;
    s[{ SUPER_ADMIN: 'superAdmins', CLIENT_ADMIN: 'clientAdmins', USER: 'users' }[r.userType]] += r.n;
    s[r.isActive ? 'active' : 'inactive'] += r.n;
  }
  return s;
}

async function list({ page, limit, search, companyId, userType, isActive }) {
  const where = {};
  if (companyId) where.companyId = companyId;
  if (userType) where.userType = userType;
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { email: { [Op.iLike]: `%${search}%` } }, { phone: { [Op.iLike]: `%${search}%` } }];
  const { rows, count } = await User.findAndCountAll({ where, include: companyInclude, order: [['createdAt', 'DESC']], limit, offset: (page - 1) * limit, distinct: true });
  const services = await servicesOfUsers(rows);
  const employees = await employeeCounts([...new Set(rows.filter((u) => u.userType === 'CLIENT_ADMIN').map((u) => u.companyId))]);
  return { data: rows.map((u) => rowJSON(u, services, employees)), page, limit, total: count, summary: await summary() };
}

/**
 * One person with the services they have. A client admin also shows the company's employees, each with
 * their own services, so the super admin sees who works under that client admin and with what access.
 */
async function get(id) {
  const user = await User.findByPk(id, { include: companyInclude });
  if (!user) throw AppError.notFound('User');
  const people = [user];
  let employeesList = [];
  if (user.userType === 'CLIENT_ADMIN') {
    employeesList = await User.findAll({ where: { companyId: user.companyId, userType: 'USER' }, include: companyInclude, order: [['createdAt', 'ASC']] });
    people.push(...employeesList);
  }
  const services = await servicesOfUsers(people);
  const employees = await employeeCounts(user.companyId ? [user.companyId] : []);
  return {
    ...rowJSON(user, services, employees),
    services: services.get(user.id),
    ...(user.userType === 'CLIENT_ADMIN' && {
      employees: employeesList.map((e) => ({ ...rowJSON(e, services, employees), services: services.get(e.id) })),
    }),
  };
}

module.exports = { list, get };
