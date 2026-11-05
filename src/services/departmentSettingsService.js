// Department settings of the client admin (owner 2026-11-15): which departments (Dyeing, Stitching ... ) may request chemicals from the Chemical Store.
//   The super admin gives the company the Chemical Store; the client admin then decides, department by department, whether it can ask for chemicals.
//   A department without it has no chemical request / return screens and sees no chemical field on its jobs, SO cards or Folding (the routes under /departments/:code hide them).
//   The switch only counts while the company has the Chemical Store; departments that already requested chemicals keep it ON until the client admin switches it off.
const { CompanyService, DepartmentChemical, Service, sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const { companyServices } = require('./accessService');

const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const STORE_CODE = 'CHEMICAL_STORE';

const hasStore = (services) => services.some((s) => s.code === STORE_CODE);
const flagOf = (s) => !s.CompanyService || s.CompanyService.chemicalRequests !== false;

/** Map(serviceId -> true) of the departments of the company that may request chemicals now (the store is given AND the switch is on). */
async function enabledDepartments(companyId, transaction) {
  const services = await companyServices(companyId, transaction);
  const store = hasStore(services);
  return new Map(services.filter((s) => DEPARTMENT_KINDS.includes(s.kind)).map((s) => [s.id, store && flagOf(s)]));
}

async function chemicalEnabled(companyId, serviceId, transaction) {
  return Boolean((await enabledDepartments(companyId, transaction)).get(serviceId));
}

/** GET /department-settings: the departments with their chemical request switch. */
async function list(req) {
  const { companyId } = req.user;
  const services = await companyServices(companyId);
  const store = hasStore(services);
  const given = await DepartmentChemical.findAll({ where: { companyId }, attributes: ['departmentId', [sequelize.fn('count', sequelize.col('id')), 'n']], group: ['departmentId'], raw: true });
  const n = Object.fromEntries(given.map((g) => [g.departmentId, Number(g.n)]));
  return {
    chemicalStore: store,
    data: services.filter((s) => DEPARTMENT_KINDS.includes(s.kind)).map((s) => ({
      id: s.id, code: s.code, name: s.name, kind: s.kind,
      chemicalRequests: flagOf(s), chemicalEnabled: store && flagOf(s), chemicalCount: n[s.id] || 0,
    })),
  };
}

/** PATCH /department-settings/:code {chemicalRequests} and PUT /department-settings {departments:[{code, chemicalRequests}]}: client admin only (checked in the route). */
async function setMany(req, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const services = await companyServices(companyId, transaction);
    if (!hasStore(services)) throw AppError.rule('NO_CHEMICAL_STORE', 'Your company does not have the Chemical Store (the super admin gives it), so there is nothing to switch');
    for (const c of changes) {
      const s = services.find((x) => DEPARTMENT_KINDS.includes(x.kind) && (x.code === String(c.code).toUpperCase() || x.id === c.code));
      if (!s) throw AppError.notFound('Department');
      if (flagOf(s) === c.chemicalRequests) continue;
      await CompanyService.update({ chemicalRequests: c.chemicalRequests }, { where: { companyId, serviceId: s.id }, transaction });
      await audit.log(req, { action: 'DEPARTMENT_CHEMICAL_REQUESTS_CHANGED', entityType: 'Service', entityId: s.id, before: { department: s.name, chemicalRequests: flagOf(s) }, after: { chemicalRequests: c.chemicalRequests } }, { transaction });
    }
  });
  return list(req);
}

module.exports = { list, setMany, enabledDepartments, chemicalEnabled, hasStore, flagOf, DEPARTMENT_KINDS };
