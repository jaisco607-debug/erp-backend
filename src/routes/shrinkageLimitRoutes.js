// The shrinkage the owner expects (owner plan N-B4): GET (anyone who has the departments reports) and PUT (client admin only).
//   GET /api/v1/shrinkage-limits   the departments, the qualities and the limits set
//   PUT /api/v1/shrinkage-limits   { items: [{ departmentId, qualityId (or null = the whole department), limitPercent (0 to 100, or null to remove) }] }
const express = require('express');
const Joi = require('joi');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const validate = require('../middlewares/validate');
const service = require('../services/shrinkageService');

const router = express.Router();
router.use(authenticate);

router.get('/', requireService('REPORT_DEPARTMENTS', 'VIEW'), async (req, res) => res.json(await service.getLimits(req)));
router.put('/', requireUserType('CLIENT_ADMIN'), validate({
  body: Joi.object({
    items: Joi.array().min(1).max(500).items(Joi.object({
      departmentId: Joi.string().guid().required(), qualityId: Joi.string().guid().allow(null).default(null), limitPercent: Joi.number().min(0).max(100).custom((v, h) => (Math.abs(Math.round(v * 100) - v * 100) > 1e-6 ? h.message('limitPercent can have at most 2 decimals') : v)).allow(null).required(),
    })).required(),
  }),
}), async (req, res) => res.json(await service.saveLimits(req, req.body)));

module.exports = router;
