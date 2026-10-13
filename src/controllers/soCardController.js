const soCardService = require('../services/soCardService');

exports.departments = async (req, res) => res.json({ data: await soCardService.departments(req) });
exports.availableLots = async (req, res) => res.json(await soCardService.availableLots(req, req.validatedQuery));
exports.list = async (req, res) => res.json(await soCardService.list(req, req.validatedQuery));
exports.get = async (req, res) => res.json(await soCardService.get(req, req.params.id));
exports.create = async (req, res) => res.status(201).json(await soCardService.create(req, req.body));
exports.update = async (req, res) => res.json(await soCardService.update(req, req.params.id, req.body));
exports.cancel = async (req, res) => {
  await soCardService.cancel(req, req.params.id);
  res.status(204).end();
};
exports.send = async (req, res) => res.json(await soCardService.send(req, req.params.id, req.body));
exports.accept = async (req, res) => res.json(await soCardService.accept(req, req.params.id));
exports.incoming = async (req, res) => res.json(await soCardService.incoming(req, req.validatedQuery.departmentId));
exports.setConfirmed = async (req, res) => res.json(await soCardService.setConfirmed(req, req.params.id, req.body.isConfirmed));
exports.formData = async (req, res) => res.json(await soCardService.formData(req));
exports.setNumbering = async (req, res) => res.json(await soCardService.setNumbering(req, req.body));
