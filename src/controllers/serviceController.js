const serviceCatalogService = require('../services/serviceCatalogService');

exports.list = async (req, res) => {
  res.json(await serviceCatalogService.list(req.validatedQuery));
};

exports.create = async (req, res) => {
  res.status(201).json(await serviceCatalogService.create(req, req.body));
};

exports.update = async (req, res) => {
  res.json(await serviceCatalogService.update(req, req.params.id, req.body));
};

exports.companies = async (req, res) => {
  res.json(await serviceCatalogService.companies(req.params.id));
};

exports.setCompanies = async (req, res) => {
  res.json(await serviceCatalogService.setCompanies(req, req.params.id, req.body.companyIds));
};

exports.companyOptions = async (req, res) => {
  res.json(await serviceCatalogService.companyOptions(req.params.id));
};

exports.addCompanies = async (req, res) => {
  res.json(await serviceCatalogService.addCompanies(req, req.params.id, req.body.companyIds));
};

exports.remove = async (req, res) => {
  res.json(await serviceCatalogService.remove(req, req.params.id));
};
