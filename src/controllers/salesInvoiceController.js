const salesInvoiceService = require('../services/salesInvoiceService');

exports.options = async (req, res) => res.json(salesInvoiceService.options());
exports.credit = async (req, res) => res.json(await salesInvoiceService.creditOf(req, req.params.id));
exports.gatePasses = async (req, res) => res.json(await salesInvoiceService.gatePasses(req, req.validatedQuery));
exports.list = async (req, res) => res.json(await salesInvoiceService.list(req, req.validatedQuery));
exports.get = async (req, res) => res.json(await salesInvoiceService.get(req, req.params.id));
exports.create = async (req, res) => res.status(201).json(await salesInvoiceService.create(req, req.body));
exports.update = async (req, res) => res.json(await salesInvoiceService.update(req, req.params.id, req.body));
exports.remove = async (req, res) => {
  await salesInvoiceService.remove(req, req.params.id);
  res.status(204).end();
};
exports.approve = async (req, res) => res.json(await salesInvoiceService.approve(req, req.params.id));
exports.unapprove = async (req, res) => res.json(await salesInvoiceService.unapprove(req, req.params.id, req.body));
exports.accountsEntry = async (req, res) => res.json(await salesInvoiceService.accountsEntry(req, req.params.id));
