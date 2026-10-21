// Who may work in a company right now. A company's employees (USER) belong to its client admin: they can
// log in and use the system only while the company is switched on AND has at least one active client admin
// (not switched off, not deleted). When the super admin switches off or deletes the last client admin, every
// employee is locked out at once; switching the admin on again brings them back.
const { User } = require('../models');

async function hasActiveClientAdmin(companyId, transaction) {
  return (await User.count({ where: { companyId, userType: 'CLIENT_ADMIN', isActive: true }, transaction })) > 0;
}

/** What happens to the employees when the company's client admins change (shown to the super admin). */
async function adminEffect(companyId, transaction) {
  const activeAdmins = await User.count({ where: { companyId, userType: 'CLIENT_ADMIN', isActive: true }, transaction });
  const employees = await User.count({ where: { companyId, userType: 'USER' }, transaction });
  return { activeAdmins, employees, employeesBlocked: activeAdmins === 0 && employees > 0 };
}

module.exports = { hasActiveClientAdmin, adminEffect };
