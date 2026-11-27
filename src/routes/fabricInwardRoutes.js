// Store Management > Fabric Inward (cloth bought from a vendor), /api/v1/fabric-inwards. Service FABRIC_STORE:
//   VIEW access  lists, details, stock, form data
//   FULL access  add, edit, delete drafts, approve, active toggle
//   client admin additionally: take an approval back, set where numbering continues
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const requireAnyService = require('../middlewares/requireAnyService');
const issues = require('../services/fabricIssueService');
const svc = require('../services/fabricInwardService');
const { Joi, uuidParam, paging } = require('../validators/common');
const { ymdDate } = require('../utils/dates');
const { REFS: R } = require('../config/limits');

const view = requireService('FABRIC_STORE', 'VIEW');
const full = requireService('FABRIC_STORE', 'FULL');
const admin = requireUserType('CLIENT_ADMIN');
// the SO card desk picks store cloth and issues it, so it needs the stock and the issue with the SO Card service too
const deskView = requireAnyService(['FABRIC_STORE', 'SO_CARD'], 'VIEW');
const deskFull = requireAnyService(['FABRIC_STORE', 'SO_CARD'], 'FULL');

const text = (max) => Joi.string().trim().max(max).allow('', null);
const meters = Joi.number().precision(2).positive().max(R.meters);
const width = Joi.number().precision(2).positive().max(9999);
const date = ymdDate().messages({ 'string.pattern.base': 'date must look like 2026-10-13' });

const fields = {
  dcNo: text(50),
  inwardDate: date,
  vendorId: Joi.string().guid(),
  qualityId: Joi.string().guid(),
  qualityName: Joi.string().trim().min(2).max(150), // typed by hand instead of qualityId
  inwardNo: Joi.number().integer().min(1).max(99999999), // typed by hand; leave out for the automatic number
  unit: Joi.string().uppercase().valid('METER', 'YARD'),
  // length of every thaan in `unit`: a number, or { length, width } when the thaan has its own width
  thaans: Joi.array().items(Joi.alternatives().try(meters, Joi.object({ length: meters.required(), width: width.allow(null) }))).min(1).max(2000),
  width: width.allow(null),
  inwardMeters: meters,
  inwardYards: meters,
  pieces: Joi.number().integer().min(0).max(1000000),
  glm: Joi.number().precision(2).positive().max(99999).allow(null),
  gsm: Joi.number().precision(2).positive().max(99999).allow(null),
  partyRef: text(80),
  vehicleNo: text(30),
  remarks: text(500),
  // the rate per meter or per yard (the unit defaults to the entry's unit); null clears it. Every thaan's amount = its length x the rate
  rate: Joi.number().precision(4).positive().max(99999999).allow(null),
  rateUnit: Joi.string().uppercase().valid('METER', 'YARD'),
  poLineId: Joi.string().guid().allow(null, ''), poRateNote: text(300), // goods against a purchase order (optional)
};

const r = express.Router();
r.use(authenticate);
r.get('/form-data', view, async (req, res) => res.json(await svc.formData(req)));
r.get('/numbering', view, async (req, res) => res.json(await svc.nextNumbers(req)));
r.put('/numbering', admin, full, validate({ body: Joi.object({ nextInwardNo: Joi.number().integer().min(1).max(99999999), nextTypeNo: Joi.number().integer().min(1).max(99999999) }).min(1) }),
  async (req, res) => res.json(await svc.setNextNumbers(req, req.body)));
const listQuery = { ...paging, search: Joi.string().trim().max(100), vendorId: Joi.string().guid(), qualityId: Joi.string().guid(), dateFrom: date, dateTo: date };
r.get('/stock', deskView, validate({ query: Joi.object({ ...listQuery, showZero: Joi.boolean().default(false), withThaans: Joi.boolean().default(false) }) }), async (req, res) => res.json(await svc.stock(req, req.validatedQuery)));
// issue to an SO card (Fabric Issue): before '/:id' on purpose
const issueQuery = {
  ...paging, search: Joi.string().trim().max(100), customerId: Joi.string().guid(), fabricInwardId: Joi.string().guid(), vendorId: Joi.string().guid(), qualityId: Joi.string().guid(),
  linkedSoCardId: Joi.string().guid(), linked: Joi.boolean(), dateFrom: date, dateTo: date, status: Joi.string().uppercase().valid('ISSUED', 'RETURNED'),
};
r.get('/link-cards', deskView, validate({ query: Joi.object({ customerId: Joi.string().guid(), search: Joi.string().trim().max(20), limit: Joi.number().integer().min(1).max(200).default(50) }) }), async (req, res) => res.json(await issues.linkCards(req, req.validatedQuery)));
r.get('/issues', view, validate({ query: Joi.object({ ...issueQuery, groupBy: Joi.string().valid('customer', 'vendor', 'quality', 'linkedCard') }) }), async (req, res) => res.json(await issues.list(req, req.validatedQuery)));
r.post('/issues', deskFull, validate({ body: Joi.object({
  fabricInwardId: Joi.string().guid().required(), issueDate: date, customerId: Joi.string().guid(), linkedSoCardId: Joi.string().guid().allow(null),
  thaanNos: Joi.array().items(Joi.number().integer().min(1)).min(1).max(2000).unique(), meters, pieces: Joi.number().integer().min(0).max(1000000), remarks: text(300),
}).xor('thaanNos', 'meters').or('customerId', 'linkedSoCardId') }), async (req, res) => res.status(201).json(await issues.issue(req, { ...req.body, linkedSoCardId: req.body.linkedSoCardId || undefined })));
r.patch('/issues/:id', deskFull, validate({ params: uuidParam, body: Joi.object({
  fabricInwardId: Joi.string().guid(), issueDate: date, customerId: Joi.string().guid(), linkedSoCardId: Joi.string().guid().allow(null),
  thaanNos: Joi.array().items(Joi.number().integer().min(1)).min(1).max(2000).unique(), meters, pieces: Joi.number().integer().min(0).max(1000000), remarks: text(300),
}).oxor('thaanNos', 'meters').min(1) }), async (req, res) => res.json(await issues.edit(req, req.params.id, req.body)));
r.get('/issues/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await issues.get(req, req.params.id)));
r.post('/issues/:id/cancel', full, validate({ params: uuidParam }), async (req, res) => res.json(await issues.cancel(req, req.params.id)));
r.get('/ledger', view, validate({ query: Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100000).default(200), fabricInwardId: Joi.string().guid(), vendorId: Joi.string().guid(), qualityId: Joi.string().guid(), customerId: Joi.string().guid(), dateFrom: date, dateTo: date }) }),
  async (req, res) => res.json(await issues.ledger(req, req.validatedQuery)));
r.get('/', view, validate({ query: Joi.object({ ...listQuery, isActive: Joi.boolean(), isApproved: Joi.boolean() }) }), async (req, res) => res.json(await svc.list(req, req.validatedQuery)));
r.post('/', full, validate({
  body: Joi.object({ ...fields, inwardDate: date.required(), vendorId: fields.vendorId.required(), unit: fields.unit.default('METER') }).xor('qualityId', 'qualityName'),
}), async (req, res) => res.status(201).json(await svc.create(req, req.body)));
r.get('/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await svc.get(req, req.params.id)));
r.patch('/:id', full, validate({ params: uuidParam, body: Joi.object({ ...fields, typeNo: Joi.string().trim().min(1).max(20) }).oxor('qualityId', 'qualityName').min(1) }),
  async (req, res) => res.json(await svc.update(req, req.params.id, req.body)));
r.delete('/:id', full, validate({ params: uuidParam }), async (req, res) => { await svc.remove(req, req.params.id); res.status(204).end(); });
r.put('/:id/active', full, validate({ params: uuidParam, body: Joi.object({ isActive: Joi.boolean().required() }) }), async (req, res) => res.json(await svc.setActive(req, req.params.id, req.body.isActive)));
r.post('/:id/approve', full, validate({ params: uuidParam }), async (req, res) => res.json(await svc.setApproved(req, req.params.id, true)));
r.post('/:id/unapprove', admin, full, validate({ params: uuidParam }), async (req, res) => res.json(await svc.setApproved(req, req.params.id, false)));

module.exports = r;
