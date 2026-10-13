const companyService = require('../services/companyService');

exports.list = async (req, res) => {
  res.json(await companyService.list(req.validatedQuery));
};

exports.get = async (req, res) => {
  res.json(await companyService.details(req.params.id));
};

exports.create = async (req, res) => {
  res.status(201).json(await companyService.create(req, req.body));
};

exports.update = async (req, res) => {
  res.json(await companyService.update(req, req.params.id, req.body));
};

exports.setServices = async (req, res) => {
  res.json(await companyService.setServices(req, req.params.id, req.body.serviceIds));
};

exports.newCode = async (req, res) => {
  res.json(await companyService.newCode(req, req.params.id));
};

exports.toggleService = async (req, res) => {
  res.json(await companyService.toggleService(req, req.params.id, req.params.serviceId, req.body.enabled));
};

exports.remove = async (req, res) => {
  await companyService.remove(req, req.params.id);
  res.status(204).end();
};

exports.updateAdmin = async (req, res) => {
  res.json(await companyService.updateAdmin(req, req.params.id, req.params.userId, req.body));
};

exports.resetAdminPassword = async (req, res) => {
  await companyService.resetAdminPassword(req, req.params.id, req.params.userId, req.body.newPassword);
  res.status(204).end();
};
