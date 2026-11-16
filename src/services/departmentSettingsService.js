// Department settings of the client admin (owner 2026-11-15): which departments (Dyeing, Stitching ... ) may request chemicals from the Chemical Store,
// and (owner 2026-11-28) which may request yarn from the Yarn Store (chemicalRequests is ON until switched off; yarnRequests is OFF until switched on).
//   The super admin gives the company the Chemical Store; the client admin then decides, department by department, whether it can ask for chemicals.
//   A department without it has no chemical request / return screens and sees no chemical field on its jobs, SO cards or Folding (the routes under /departments/:code hide them).
//   The switch only counts while the company has the Chemical Store; departments that already requested chemicals keep it ON until the client admin switches it off.
const { CompanyService, DepartmentChemical, Service, sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const { companyServices } = require('./accessService');

const DEPARTMENT_KINDS = ['PROCESS', 'FOLDING'];
const STORE_CODE = 'CHEMICAL_STORE';
const YARN_STORE_CODE = 'YARN_STORE';

const hasStore = (services) => services.some((s) => s.code === STORE_CODE);
const flagOf = (s) => !s.CompanyService || s.CompanyService.chemicalRequests !== false;
const hasYarnStore = (services) => services.some((s) => s.code === YARN_STORE_CODE);
const yarnFlagOf = (s) => Boolean(s.CompanyService && s.CompanyService.yarnRequests === true);

/** May this department request yarn now? (the Yarn Store is given AND the client admin switched the department on) */
async function yarnEnabled(companyId, serviceId, transaction) {
  const services = await companyServices(companyId, transaction);
  const s = services.find((x) => x.id === serviceId && DEPARTMENT_KINDS.includes(x.kind));
  return Boolean(s && hasYarnStore(services) && yarnFlagOf(s));
}

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
  const yarn = hasYarnStore(services);
  const asked = Object.fromEntries((await sequelize.query('SELECT "departmentId", count(*)::int AS n FROM yarn_requests WHERE "companyId" = :companyId GROUP BY "departmentId"', { replacements: { companyId }, type: sequelize.QueryTypes.SELECT })).map((g) => [g.departmentId, g.n]));
  return {
    chemicalStore: store,
    yarnStore: yarn,
    data: services.filter((s) => DEPARTMENT_KINDS.includes(s.kind)).map((s) => ({
      id: s.id, code: s.code, name: s.name, kind: s.kind,
      chemicalRequests: flagOf(s), chemicalEnabled: store && flagOf(s), chemicalCount: n[s.id] || 0,
      yarnRequests: yarnFlagOf(s), yarnEnabled: yarn && yarnFlagOf(s), yarnRequestCount: asked[s.id] || 0,
    })),
  };
}

/** PATCH /department-settings/:code {chemicalRequests} and PUT /department-settings {departments:[{code, chemicalRequests}]}: client admin only (checked in the route). */
async function setMany(req, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const services = await companyServices(companyId, transaction);
    if (changes.some((c) => c.chemicalRequests !== undefined) && !hasStore(services)) throw AppError.rule('NO_CHEMICAL_STORE', 'Your company does not have the Chemical Store (the super admin gives it), so there is nothing to switch');
    if (changes.some((c) => c.yarnRequests !== undefined) && !hasYarnStore(services)) throw AppError.rule('NO_YARN_STORE', 'Your company does not have the Yarn Store (the super admin gives it), so there is nothing to switch');
    for (const c of changes) {
      const s = services.find((x) => DEPARTMENT_KINDS.includes(x.kind) && (x.code === String(c.code).toUpperCase() || x.id === c.code));
      if (!s) throw AppError.notFound('Department');
      if (c.chemicalRequests !== undefined && flagOf(s) !== c.chemicalRequests) {
        await CompanyService.update({ chemicalRequests: c.chemicalRequests }, { where: { companyId, serviceId: s.id }, transaction });
        await audit.log(req, { action: 'DEPARTMENT_CHEMICAL_REQUESTS_CHANGED', entityType: 'Service', entityId: s.id, before: { department: s.name, chemicalRequests: flagOf(s) }, after: { chemicalRequests: c.chemicalRequests } }, { transaction });
      }
      if (c.yarnRequests !== undefined && yarnFlagOf(s) !== c.yarnRequests) {
        await CompanyService.update({ yarnRequests: c.yarnRequests }, { where: { companyId, serviceId: s.id }, transaction });
        await audit.log(req, { action: 'DEPARTMENT_YARN_REQUESTS_CHANGED', entityType: 'Service', entityId: s.id, before: { department: s.name, yarnRequests: yarnFlagOf(s) }, after: { yarnRequests: c.yarnRequests } }, { transaction });
      }
    }
  });
  return list(req);
}

module.exports = { list, setMany, enabledDepartments, chemicalEnabled, yarnEnabled, hasStore, hasYarnStore, flagOf, yarnFlagOf, DEPARTMENT_KINDS };
