// Weaving > Masters > Brand: a unique name per company (see weavingNameMaster). A brand used by an item card cannot be deleted.
const { YarnBrand, YarnItem } = require('../models');
const { nameMaster } = require('./weavingNameMaster');

module.exports = nameMaster({
  Model: YarnBrand,
  entity: 'YarnBrand',
  label: 'brand',
  action: 'YARN_BRAND',
  inUse: (companyId, id, transaction) => YarnItem.count({ where: { companyId, brandId: id }, transaction }),
});
