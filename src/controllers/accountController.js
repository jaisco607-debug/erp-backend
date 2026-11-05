const accountService = require('../services/accountService');
const templateService = require('../services/accountTemplateService');
const issueService = require('../services/accountIssueService');

exports.options = async (req, res) => res.json(accountService.options());
exports.issues = async (req, res) => res.json(await issueService.list(req));
exports.presets = async (req, res) => res.json(accountService.presets());
exports.templates = async (req, res) => res.json(templateService.list());
exports.applyTemplate = async (req, res) => res.json(await templateService.apply(req, req.body));
exports.nextCode = async (req, res) => res.json(await accountService.nextCode(req, req.validatedQuery));
exports.list = async (req, res) => res.json(await accountService.list(req, req.validatedQuery));
exports.tree = async (req, res) => res.json(await accountService.tree(req, req.validatedQuery));
exports.get = async (req, res) => res.json(await accountService.get(req, req.params.id));
exports.create = async (req, res) => res.status(201).json(await accountService.create(req, req.body));
exports.update = async (req, res) => res.json(await accountService.update(req, req.params.id, req.body));
exports.remove = async (req, res) => {
  await accountService.remove(req, req.params.id);
  res.status(204).end();
};
