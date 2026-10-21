const companyUserService = require('../services/companyUserService');

exports.serviceOptions = async (req, res) => {
  res.json(await companyUserService.serviceOptions(req));
};

exports.list = async (req, res) => {
  res.json(await companyUserService.list(req, req.validatedQuery));
};

exports.get = async (req, res) => {
  res.json(await companyUserService.get(req, req.params.id));
};

exports.create = async (req, res) => {
  res.status(201).json(await companyUserService.create(req, req.body));
};

exports.update = async (req, res) => {
  res.json(await companyUserService.update(req, req.params.id, req.body));
};

exports.resetPassword = async (req, res) => {
  await companyUserService.resetPassword(req, req.params.id, req.body);
  res.status(204).end();
};

exports.setServices = async (req, res) => {
  res.json(await companyUserService.setServices(req, req.params.id, req.body.services));
};
