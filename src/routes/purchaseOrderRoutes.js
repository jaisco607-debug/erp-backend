// Purchase orders of the STORE only (owner plan N-D1). Each order belongs to one store: that store's service gives the right (VIEW reads, FULL writes).
// Approve is for the client admin only.
//   GET    /api/v1/purchase-orders                     GET /form-data?store=     GET /open-lines?store=&vendorId=     GET/PUT /settings
//   POST   /api/v1/purchase-orders                     GET/PATCH/DELETE /:id
//   POST   /api/v1/purchase-orders/:id/approve | /close | /cancel
const express = require('express');
const Joi = require('joi');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const validate = require('../middlewares/validate');
const { ymdDate } = require('../utils/dates');
const service = require('../services/purchaseOrderService');

const router = express.Router();
router.use(authenticate);
const admin = requireUserType('CLIENT_ADMIN');
const id = Joi.string().guid();
const idParam = Joi.object({ id: id.required() });
const opt = (s) => s.empty('');
const store = Joi.string().uppercase().valid('CHEMICAL', 'GENERAL', 'YARN', 'FABRIC');
const text = (max) => Joi.string().trim().max(max).allow('', null);
const line = Joi.object({
  itemId: id.allow(null, ''), yarnName: text(120), brand: text(80), qualityId: id.allow(null, ''), unit: Joi.string().uppercase().valid('METER', 'YARD'),
  qty: Joi.number().precision(3).positive().max(99999999).required(), rate: Joi.number().precision(4).positive().max(99999999).required(), note: text(200),
});
const lines = Joi.array().items(line).min(1).max(200);

router.get('/', validate({ query: Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(200).default(50), store: opt(store), status: opt(Joi.string().uppercase().valid('DRAFT', 'APPROVED', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  vendorId: opt(id), search: opt(Joi.string().trim().max(60)), dateFrom: opt(ymdDate()), dateTo: opt(ymdDate()) }) }), async (req, res) => res.json(await service.list(req, req.validatedQuery)));
// fixed paths before /:id
router.get('/form-data', validate({ query: Joi.object({ store: store.required() }) }), async (req, res) => res.json(await service.formData(req, req.validatedQuery)));
router.get('/open-lines', validate({ query: Joi.object({ store: store.required(), vendorId: opt(id), itemId: opt(id), qualityId: opt(id) }) }), async (req, res) => res.json(await service.openLines(req, req.validatedQuery)));
router.get('/settings', async (req, res) => res.json(await service.getSettings(req)));
router.put('/settings', admin, validate({ body: Joi.object({ tolerancePercent: Joi.number().precision(2).min(0).max(100).required() }) }), async (req, res) => res.json(await service.saveSettings(req, req.body)));
router.post('/', validate({ body: Joi.object({ store: store.required(), vendorId: id.required(), poDate: ymdDate(), expectedDate: ymdDate().allow(null, ''), notes: text(500), lines: lines.required() }) }),
  async (req, res) => res.status(201).json(await service.create(req, req.body)));
router.get('/:id', validate({ params: idParam }), async (req, res) => res.json(await service.get(req, req.params.id)));
router.patch('/:id', validate({ params: idParam, body: Joi.object({ vendorId: id, poDate: ymdDate(), expectedDate: ymdDate().allow(null, ''), notes: text(500), lines }).min(1) }), async (req, res) => res.json(await service.update(req, req.params.id, req.body)));
router.delete('/:id', validate({ params: idParam, body: Joi.object({ reason: text(300) }) }), async (req, res) => { await service.remove(req, req.params.id, req.body && req.body.reason); res.status(204).end(); });
router.post('/:id/approve', admin, validate({ params: idParam }), async (req, res) => res.json(await service.approve(req, req.params.id)));
router.post('/:id/close', validate({ params: idParam, body: Joi.object({ reason: text(300) }) }), async (req, res) => res.json(await service.close(req, req.params.id, req.body || {})));
router.post('/:id/cancel', validate({ params: idParam, body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required() }) }), async (req, res) => res.json(await service.cancel(req, req.params.id, req.body)));

module.exports = router;
