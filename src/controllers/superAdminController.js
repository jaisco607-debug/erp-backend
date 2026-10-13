const superAdminService = require('../services/superAdminService');
const loginCodeService = require('../services/loginCodeService');

exports.list = async (req, res) => {
  res.json(await superAdminService.list(req.validatedQuery));
};

exports.create = async (req, res) => {
  res.status(201).json(await superAdminService.create(req, req.body));
};

exports.update = async (req, res) => {
  res.json(await superAdminService.update(req, req.params.id, req.body));
};

exports.resetPassword = async (req, res) => {
  await superAdminService.resetPassword(req, req.params.id, req.body);
  res.status(204).end();
};

exports.loginCode = async (req, res) => {
  res.json({ code: await loginCodeService.superAdminCode() });
};

exports.newLoginCode = async (req, res) => {
  res.json(await loginCodeService.newSuperAdminCode(req));
};
