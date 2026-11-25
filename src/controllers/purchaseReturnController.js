const purchaseReturnService = require('../services/purchaseReturnService');

exports.vendorReturns = async (req, res) => res.json(await purchaseReturnService.vendorReturnsOf(req, req.validatedQuery));
exports.list = async (req, res) => res.json(await purchaseReturnService.list(req, req.validatedQuery));
exports.get = async (req, res) => res.json(await purchaseReturnService.get(req, req.params.id));
exports.create = async (req, res) => res.status(201).json(await purchaseReturnService.create(req, req.body));
exports.update = async (req, res) => res.json(await purchaseReturnService.update(req, req.params.id, req.body));
exports.remove = async (req, res) => {
  await purchaseReturnService.remove(req, req.params.id);
  res.status(204).end();
};
exports.approve = async (req, res) => res.json(await purchaseReturnService.approve(req, req.params.id));
exports.unapprove = async (req, res) => res.json(await purchaseReturnService.unapprove(req, req.params.id, req.body));
exports.accountsEntry = async (req, res) => res.json(await purchaseReturnService.accountsEntry(req, req.params.id));
