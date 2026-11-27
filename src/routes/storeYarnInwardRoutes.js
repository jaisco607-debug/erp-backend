// Store Management > Yarn Inward (yarn bought from a vendor), /api/v1/store-yarn-inwards. Service YARN_STORE:
//   VIEW access  lists, details, stock, form data
//   FULL access  add, edit, delete drafts, approve, active toggle
//   client admin additionally: take an approval back, set where numbering continues
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const svc = require('../services/storeYarnInwardService');
const { Joi, uuidParam, paging } = require('../validators/common');
const { ymdDate } = require('../utils/dates');
const { REFS: R } = require('../config/limits');

const view = requireService('YARN_STORE', 'VIEW');
const full = requireService('YARN_STORE', 'FULL');
const admin = requireUserType('CLIENT_ADMIN');

const text = (max) => Joi.string().trim().max(max).allow('', null);
const date = ymdDate().messages({ 'string.pattern.base': 'date must look like 2026-10-13' });

const fields = {
  inwardNo: Joi.number().integer().min(1).max(99999999), // typed by hand; leave out for the automatic number
  inwardDate: date,
  vendorId: Joi.string().guid(),
  yarnName: Joi.string().trim().min(1).max(120), // typed: e.g. "22/s Cotton"
  brand: text(80),
  bags: Joi.number().integer().min(1).max(R.yarnBags), // every bag of the arrival weighs the same
  lbsPerBag: Joi.number().precision(2).positive().max(9999),
  ratePerLb: Joi.number().precision(4).positive().max(99999999).allow(null), // the vendor's rate per lb
  dcNo: text(50),
  remarks: text(300),
  poLineId: Joi.string().guid().allow(null, ''), poRateNote: text(300), // goods against a purchase order (optional)
};

const r = express.Router();
r.use(authenticate);
r.get('/form-data', view, async (req, res) => res.json(await svc.formData(req)));
r.get('/numbering', view, async (req, res) => res.json(await svc.nextNumbers(req)));
r.put('/numbering', admin, full, validate({ body: Joi.object({ nextInwardNo: Joi.number().integer().min(1).max(99999999).required() }) }), async (req, res) => res.json(await svc.setNextNumbers(req, req.body)));
const listQuery = { ...paging, search: Joi.string().trim().max(100), vendorId: Joi.string().guid(), dateFrom: date, dateTo: date };
r.get('/ledger', view, validate({ query: Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100000).default(200), inwardId: Joi.string().guid(), vendorId: Joi.string().guid(), departmentId: Joi.string().guid(), yarn: Joi.string().trim().max(100), dateFrom: date, dateTo: date }) }),
  async (req, res) => res.json(await svc.ledger(req, req.validatedQuery)));
r.get('/stock', view, validate({ query: Joi.object({ ...listQuery, showZero: Joi.boolean().default(false) }) }), async (req, res) => res.json(await svc.stock(req, req.validatedQuery)));
r.get('/', view, validate({ query: Joi.object({ ...listQuery, isActive: Joi.boolean(), isApproved: Joi.boolean() }) }), async (req, res) => res.json(await svc.list(req, req.validatedQuery)));
r.post('/', full, validate({
  body: Joi.object({ ...fields, inwardDate: date.required(), vendorId: fields.vendorId.required(), yarnName: fields.yarnName.required(), bags: fields.bags.required(), lbsPerBag: fields.lbsPerBag.required() }),
}), async (req, res) => res.status(201).json(await svc.create(req, req.body)));
r.get('/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await svc.get(req, req.params.id)));
r.patch('/:id', full, validate({ params: uuidParam, body: Joi.object(fields).min(1) }), async (req, res) => res.json(await svc.update(req, req.params.id, req.body)));
r.delete('/:id', full, validate({ params: uuidParam }), async (req, res) => { await svc.remove(req, req.params.id); res.status(204).end(); });
r.put('/:id/active', full, validate({ params: uuidParam, body: Joi.object({ isActive: Joi.boolean().required() }) }), async (req, res) => res.json(await svc.setActive(req, req.params.id, req.body.isActive)));
r.post('/:id/approve', full, validate({ params: uuidParam }), async (req, res) => res.json(await svc.setApproved(req, req.params.id, true)));
r.post('/:id/unapprove', admin, full, validate({ params: uuidParam }), async (req, res) => res.json(await svc.setApproved(req, req.params.id, false)));

module.exports = r;
