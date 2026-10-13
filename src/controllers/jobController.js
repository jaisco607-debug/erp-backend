const jobService = require('../services/jobService');

exports.formData = async (req, res) => res.json(await jobService.formData(req, req.validatedQuery));
exports.list = async (req, res) => res.json(await jobService.list(req, req.validatedQuery));
exports.get = async (req, res) => res.json(await jobService.get(req, req.params.id));
exports.create = async (req, res) => res.status(201).json(await jobService.create(req, req.body));
exports.setStatus = async (req, res) => res.json(await jobService.setStatus(req, req.params.id, req.body.status));
exports.update = async (req, res) => res.json(await jobService.update(req, req.params.id, req.body));
exports.history = async (req, res) => res.json(await jobService.soCardHistory(req, req.params.id));
