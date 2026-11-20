// Weaving > Masters > Quality: a unique name per company (see weavingNameMaster). A quality used by a sizing batch cannot be deleted (switch it off); it can always be renamed.
const { WeavingQuality, sequelize } = require('../models');
const { nameMaster } = require('./weavingNameMaster');

module.exports = nameMaster({
  Model: WeavingQuality,
  entity: 'WeavingQuality',
  label: 'quality',
  action: 'WEAVING_QUALITY',
  usedBy: 'sizing set',
  usedKey: 'sizingBatches',
  inUse: async (companyId, id, transaction) => {
    const [r] = await sequelize.query('SELECT COUNT(*)::int AS n FROM sizing_batches WHERE "companyId" = :companyId AND "qualityId" = :id AND "deletedAt" IS NULL', { replacements: { companyId, id }, type: sequelize.QueryTypes.SELECT, transaction });
    return r.n;
  },
});
