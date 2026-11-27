// Store Management > Yarn Outward (yarn given to a department), /api/v1/store-yarn-outwards. Service YARN_STORE:
//   VIEW access  lists, details, summary, form data
//   FULL access  give yarn to a department, take an outward back
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const svc = require('../services/storeYarnOutwardService');
const { Joi, uuidParam, paging } = require('../validators/common');
const { ymdDate } = require('../utils/dates');

const view = requireService('YARN_STORE', 'VIEW');
const full = requireService('YARN_STORE', 'FULL');
const text = (max) => Joi.string().trim().max(max).allow('', null);
const date = ymdDate().messages({ 'string.pattern.base': 'date must look like 2026-10-13' });

const yreq = require('../services/yarnRequestService');
const { REFS: R } = require('../config/limits');

const r = express.Router();
r.use(authenticate);
// the requests of the departments (Queue -> Process -> In-Way -> Delivered): the Yarn Store accepts, rejects and sends them
const reqList = Joi.object({
  ...paging, tab: Joi.string().valid('all', 'queue', 'process', 'in_way', 'delivered', 'closed').default('all'), departmentId: Joi.string().guid(),
  reqNo: Joi.number().integer().min(1), jobNo: Joi.number().integer().min(1), soNo: Joi.number().integer().min(1), dateFrom: date, dateTo: date,
});
r.get('/requests', view, validate({ query: reqList }), async (req, res) => res.json(await yreq.storeList(req, req.validatedQuery)));
r.get('/requests/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await yreq.storeGet(req, req.params.id)));
r.post('/requests/:id/accept', full, validate({ params: uuidParam }), async (req, res) => res.json(await yreq.accept(req, req.params.id)));
r.post('/requests/:id/reject', full, validate({ params: uuidParam, body: Joi.object({ reason: Joi.string().trim().min(1).max(300).required() }) }), async (req, res) => res.json(await yreq.reject(req, req.params.id, req.body)));
r.post('/requests/:id/send', full, validate({ params: uuidParam, body: Joi.object({
  sentThrough: text(120),
  lines: Joi.array().items(Joi.object({
    lineId: Joi.string().guid().required(), bags: Joi.number().integer().min(0).max(R.yarnBags),
    allocations: Joi.array().items(Joi.object({ inwardId: Joi.string().guid().required(), bags: Joi.number().integer().min(1).max(R.yarnBags).required() })).min(1).max(50),
  }).oxor('bags', 'allocations')).max(100),
}) }), async (req, res) => res.json(await yreq.send(req, req.params.id, req.body)));
r.get('/form-data', view, async (req, res) => res.json(await svc.formData(req)));
const filters = { search: Joi.string().trim().max(100), departmentId: Joi.string().guid(), inwardId: Joi.string().guid(), dateFrom: date, dateTo: date };
r.get('/summary', view, validate({ query: Joi.object({ ...filters, groupBy: Joi.string().valid('department', 'yarn').default('department') }) }), async (req, res) => res.json(await svc.summary(req, req.validatedQuery)));
r.get('/', view, validate({ query: Joi.object({ ...paging, ...filters }) }), async (req, res) => res.json(await svc.list(req, req.validatedQuery)));
r.post('/', full, validate({ body: Joi.object({
  outwardDate: date, departmentId: Joi.string().guid().required(), dcNo: text(50), sentThrough: text(120), remarks: text(300),
  lines: Joi.array().items(Joi.object({ inwardId: Joi.string().guid().required(), bags: Joi.number().integer().min(1).max(R.yarnBags).required() })).min(1).max(100).unique('inwardId').required(),
}) }), async (req, res) => res.status(201).json(await svc.create(req, req.body)));
r.get('/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await svc.get(req, req.params.id)));
r.post('/:id/cancel', full, validate({ params: uuidParam }), async (req, res) => res.json(await svc.cancel(req, req.params.id)));

module.exports = r;
