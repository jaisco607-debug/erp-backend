const auditQueryService = require('../services/auditQueryService');

exports.list = async (req, res) => {
  res.json(await auditQueryService.list(req.validatedQuery));
};
