// Fabric inspection (owner plan N-B1). Its own service INSPECTION: VIEW reads, FULL inspects. The client admin keeps the settings and the defect list, and reopens.
//   GET/PUT  /api/v1/inspection/settings
//   GET/POST /api/v1/inspection/defect-types      PATCH/DELETE /:id      POST /defect-types/standard (the usual textile defects)
//   GET      /api/v1/inspections                  GET /thaans?lotNo=     POST /        GET/PATCH/DELETE /:id
//   PUT      /api/v1/inspections/:id/defects      POST /:id/finish       POST /:id/reopen
const express = require('express');
const Joi = require('joi');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const validate = require('../middlewares/validate');
const { ymdDate } = require('../utils/dates');
const { GRADES } = require('../utils/fourPoint');
const service = require('../services/inspectionService');

const view = requireService('INSPECTION', 'VIEW');
const full = requireService('INSPECTION', 'FULL');
const admin = requireUserType('CLIENT_ADMIN');
const id = Joi.string().guid();
const idParam = Joi.object({ id: id.required() });
const reason = Joi.string().trim().min(5).max(300).required();
const width = Joi.number().precision(2).positive().max(500);

/* ---------------- settings and defect types ---------------- */
const setup = express.Router();
setup.use(authenticate);
setup.get('/settings', view, async (req, res) => res.json(await service.getSettings(req)));
setup.put('/settings', admin, full, validate({
  body: Joi.object({
    pointTable: Joi.array().min(1).max(10).items(Joi.object({ key: Joi.string().trim().pattern(/^[A-Z0-9_]{1,10}$/).required(), label: Joi.string().trim().min(1).max(60).required(), points: Joi.number().integer().min(1).max(10).required() })),
    gradeLimits: Joi.array().length(3).items(Joi.object({ grade: Joi.string().valid('A', 'B', 'C').required(), maxPoints: Joi.number().precision(2).min(0).max(1000).required() })),
    basis: Joi.string().valid('METER', 'SQ_YARD'),
    maxPointsPerMeter: Joi.number().integer().min(1).max(100).allow(null),
  }).min(1),
}), async (req, res) => res.json(await service.saveSettings(req, req.body)));

const typeFields = { code: Joi.string().trim().min(1).max(10), name: Joi.string().trim().min(2).max(80), fixedPoints: Joi.number().integer().min(1).max(10).allow(null) };
setup.get('/defect-types', view, validate({ query: Joi.object({ all: Joi.boolean() }) }), async (req, res) => res.json(await service.listDefectTypes(req, req.validatedQuery)));
setup.post('/defect-types/standard', admin, full, async (req, res) => res.json(await service.loadStandardDefects(req)));
setup.post('/defect-types', admin, full, validate({ body: Joi.object({ ...typeFields, code: typeFields.code.required(), name: typeFields.name.required() }) }), async (req, res) => res.status(201).json(await service.createDefectType(req, req.body)));
setup.patch('/defect-types/:id', admin, full, validate({ params: idParam, body: Joi.object({ ...typeFields, isActive: Joi.boolean() }).min(1) }), async (req, res) => res.json(await service.updateDefectType(req, req.params.id, req.body)));
setup.delete('/defect-types/:id', admin, full, validate({ params: idParam }), async (req, res) => { await service.removeDefectType(req, req.params.id); res.status(204).end(); });

/* ---------------- inspections ---------------- */
const router = express.Router();
router.use(authenticate);
const opt = (s) => s.empty('');
router.get('/', view, validate({
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(200).default(50), search: opt(Joi.string().trim().max(60)), status: opt(Joi.string().valid('DRAFT', 'FINISHED')),
    grade: opt(Joi.string().valid(...GRADES)), lotNo: opt(Joi.number().integer().min(1)), thaanNo: opt(Joi.number().integer().min(1)), customerId: opt(id), qualityId: opt(id), departmentId: opt(id),
    source: opt(Joi.string().valid('GREY', 'DEPARTMENT')), dateFrom: opt(ymdDate()), dateTo: opt(ymdDate()),
  }),
}), async (req, res) => res.json(await service.list(req, req.validatedQuery)));
// the fixed path before /:id
router.get('/thaans', view, validate({ query: Joi.object({ lotNo: Joi.number().integer().min(1).required(), source: opt(Joi.string().valid('GREY', 'DEPARTMENT')) }) }), async (req, res) => res.json(await service.thaanPicker(req, req.validatedQuery)));
router.post('/', full, validate({
  body: Joi.object({ source: Joi.string().valid('GREY', 'DEPARTMENT').required(), thaanId: id.required(), inspectionDate: ymdDate(), widthInches: width.allow(null), remarks: Joi.string().trim().max(500).allow('', null) }),
}), async (req, res) => res.status(201).json(await service.create(req, req.body)));
router.get('/:id', view, validate({ params: idParam }), async (req, res) => res.json(await service.get(req, req.params.id)));
router.patch('/:id', full, validate({ params: idParam, body: Joi.object({ inspectionDate: ymdDate(), widthInches: width.allow(null), remarks: Joi.string().trim().max(500).allow('', null) }).min(1) }),
  async (req, res) => res.json(await service.update(req, req.params.id, req.body)));
router.put('/:id/defects', full, validate({
  params: idParam,
  body: Joi.object({ defects: Joi.array().max(300).items(Joi.object({ defectTypeId: id.required(), atMeter: Joi.number().precision(2).min(0).max(100000).required(), sizeClass: Joi.string().trim().max(10).required(), note: Joi.string().trim().max(200).allow('', null) })).required() }),
}), async (req, res) => res.json(await service.setDefects(req, req.params.id, req.body)));
router.post('/:id/finish', full, validate({ params: idParam }), async (req, res) => res.json(await service.finish(req, req.params.id)));
router.post('/:id/reopen', admin, full, validate({ params: idParam, body: Joi.object({ reason }) }), async (req, res) => res.json(await service.reopen(req, req.params.id, req.body)));
router.delete('/:id', full, validate({ params: idParam, body: Joi.object({ reason }) }), async (req, res) => { await service.remove(req, req.params.id, req.body.reason); res.status(204).end(); });

module.exports = { setup, router };
