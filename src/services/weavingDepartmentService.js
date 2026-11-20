// Weaving > Masters > Department: a unique name per company (see weavingNameMaster). A department that has beams or looms cannot be deleted (switch it off instead).
const { WeavingDepartment, YarnBeam, sequelize } = require('../models');
const { nameMaster } = require('./weavingNameMaster');

module.exports = nameMaster({
  Model: WeavingDepartment,
  entity: 'WeavingDepartment',
  label: 'department',
  action: 'WEAVING_DEPARTMENT',
  usedBy: 'beam / loom',
  usedKey: 'beams',
  inUse: async (companyId, id, transaction) => {
    const beams = await YarnBeam.count({ where: { companyId, departmentId: id }, transaction });
    const [l] = await sequelize.query('SELECT COUNT(*)::int AS n FROM looms WHERE "companyId" = :companyId AND "departmentId" = :id AND "deletedAt" IS NULL', { replacements: { companyId, id }, type: sequelize.QueryTypes.SELECT, transaction });
    return beams + l.n;
  },
});
