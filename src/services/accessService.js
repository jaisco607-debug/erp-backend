// What a signed-in person may see: their company and their services with the access level.
// The login answer and /me both use this, so the frontend can open the right dashboard and menu.
const { Company, Service, UserService } = require('../models');

/** Active services a company has been given, in menu order. */
async function companyServices(companyId, transaction) {
  const company = await Company.findByPk(companyId, {
    include: [{ model: Service, as: 'services', where: { isActive: true }, required: false, through: { attributes: [] } }],
    order: [[{ model: Service, as: 'services' }, 'sortOrder', 'ASC']],
    transaction,
  });
  return company ? company.services : [];
}

const serviceJSON = (s, access) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, menuGroup: s.menuGroup, access });

/**
 * A user's own services: what the client admin gave them, but only while the company still has the
 * service and the service is switched on. In menu order.
 */
async function userServices(user, transaction) {
  const have = new Map((await companyServices(user.companyId, transaction)).map((s) => [s.id, s]));
  const grants = await UserService.findAll({ where: { userId: user.id }, transaction });
  return grants
    .filter((g) => have.has(g.serviceId))
    .map((g) => ({ service: have.get(g.serviceId), access: g.access }))
    .sort((a, b) => a.service.sortOrder - b.service.sortOrder);
}

/**
 * { user, company, services }
 *   SUPER_ADMIN   no company, no services (manages the platform)
 *   CLIENT_ADMIN  every service of the company, FULL
 *   USER          only the services the client admin gave them, VIEW or FULL
 */
async function profile(user, { transaction } = {}) {
  if (user.userType === 'SUPER_ADMIN') return { user: user.toSafeJSON(), company: null, services: [] };

  const company = user.company || (await Company.findByPk(user.companyId, { transaction }));
  let services = [];
  if (user.userType === 'CLIENT_ADMIN') {
    services = (await companyServices(user.companyId, transaction)).map((s) => serviceJSON(s, 'FULL'));
  } else {
    services = (await userServices(user, transaction)).map((g) => serviceJSON(g.service, g.access));
  }
  return {
    user: user.toSafeJSON(),
    company: { id: company.id, name: company.name, code: company.code },
    services,
  };
}

/**
 * The services of many users in a few queries (for lists): Map userId -> [{ id, code, name, kind, menuGroup, access }].
 *   CLIENT_ADMIN  every active service of the company (FULL)
 *   USER          what was given, but only while the company still has it and it is switched on
 *   SUPER_ADMIN   none
 * Services come in menu order.
 */
async function servicesOfUsers(users, transaction) {
  const out = new Map(users.map((u) => [u.id, []]));
  const have = new Map();
  for (const companyId of new Set(users.map((u) => u.companyId).filter(Boolean))) {
    have.set(companyId, await companyServices(companyId, transaction));
  }
  const ids = users.filter((u) => u.userType === 'USER').map((u) => u.id);
  const grants = ids.length ? await UserService.findAll({ where: { userId: ids }, transaction }) : [];
  for (const u of users) {
    const list = have.get(u.companyId) || [];
    if (u.userType === 'CLIENT_ADMIN') out.set(u.id, list.map((s) => serviceJSON(s, 'FULL')));
    if (u.userType === 'USER') {
      const given = new Map(grants.filter((g) => g.userId === u.id).map((g) => [g.serviceId, g.access]));
      out.set(u.id, list.filter((s) => given.has(s.id)).map((s) => serviceJSON(s, given.get(s.id))));
    }
  }
  return out;
}

module.exports = { profile, companyServices, userServices, servicesOfUsers };
