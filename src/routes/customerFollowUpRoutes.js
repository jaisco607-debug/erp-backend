// The credit follow-up notes of a customer (owner plan N-C2): who spoke to him, what he promised, until when. Text only: nothing is sent.
//   GET  /api/v1/customers/:id/follow-ups
//   POST /api/v1/customers/:id/follow-ups   { date?, note, promisedDate?, promisedAmount? }
// Accounting people: Reports, Sales Invoice or Receipts service (VIEW reads, FULL adds).
const express = require('express');
const Joi = require('joi');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const validate = require('../middlewares/validate');
const AppError = require('../utils/AppError');
const { ymdDate } = require('../utils/dates');
const { REFS: R } = require('../config/limits');
const service = require('../services/receivableAgeingService');

const router = express.Router({ mergeParams: true });
router.use(authenticate);

const eitherAccounting = (level) => async (req, res, next) => {
  const tryOne = (code) => new Promise((resolve) => requireService(code, level)(req, res, (err) => resolve(!err)));
  for (const code of ['ACC_REPORTS', 'ACC_SALES', 'ACC_RECEIPTS']) if (await tryOne(code)) return next();
  return next(AppError.forbidden('You do not have an accounting service'));
};
const params = Joi.object({ id: Joi.string().guid().required() });

router.get('/', eitherAccounting('VIEW'), validate({ params }), async (req, res) => res.json(await service.listFollowUps(req, req.params.id)));
router.post('/', eitherAccounting('FULL'), validate({
  params,
  body: Joi.object({
    date: ymdDate(), note: Joi.string().trim().min(2).max(1000).required(), promisedDate: ymdDate().allow(null), promisedAmount: Joi.number().precision(2).min(0).max(R.voucherAmount).allow(null),
  }),
}), async (req, res) => res.status(201).json(await service.addFollowUp(req, req.params.id, req.body)));

module.exports = router;
