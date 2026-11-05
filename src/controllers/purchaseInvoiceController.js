const purchaseInvoiceService = require('../services/purchaseInvoiceService');

exports.options = async (req, res) => res.json(purchaseInvoiceService.options());
exports.credit = async (req, res) => res.json(await purchaseInvoiceService.creditOf(req, req.params.id));
exports.inwards = async (req, res) => res.json(await purchaseInvoiceService.inwards(req, req.validatedQuery));
exports.list = async (req, res) => res.json(await purchaseInvoiceService.list(req, req.validatedQuery));
exports.get = async (req, res) => res.json(await purchaseInvoiceService.get(req, req.params.id));
exports.create = async (req, res) => res.status(201).json(await purchaseInvoiceService.create(req, req.body));
exports.update = async (req, res) => res.json(await purchaseInvoiceService.update(req, req.params.id, req.body));
exports.remove = async (req, res) => {
  await purchaseInvoiceService.remove(req, req.params.id);
  res.status(204).end();
};
exports.approve = async (req, res) => res.json(await purchaseInvoiceService.approve(req, req.params.id));
exports.unapprove = async (req, res) => res.json(await purchaseInvoiceService.unapprove(req, req.params.id, req.body));
exports.accountsEntry = async (req, res) => res.json(await purchaseInvoiceService.accountsEntry(req, req.params.id));
