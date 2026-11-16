// Weaving > Masters > Yarn Count: a unique name per company (see weavingNameMaster). A count used by an item card cannot be deleted.
const { YarnCount, YarnItem } = require('../models');
const { nameMaster } = require('./weavingNameMaster');

module.exports = nameMaster({
  Model: YarnCount,
  entity: 'YarnCount',
  label: 'yarn count',
  action: 'YARN_COUNT',
  inUse: (companyId, id, transaction) => YarnItem.count({ where: { companyId, yarnCountId: id }, transaction }),
});
