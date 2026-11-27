// What a department charges per meter (owner plan N-C1): used by the SO card margin. Accounting service (ACC_REPORTS): VIEW reads, FULL changes.
//   GET    /api/v1/process-rates              the departments with their rates and the rate of today
//   PUT    /api/v1/process-rates              { departmentId, ratePerMeter, effectiveFrom }  adds the rate from that day (the same day again changes it)
//   DELETE /api/v1/process-rates/:id
const express = require('express');
const Joi = require('joi');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const validate = require('../middlewares/validate');
const { ymdDate } = require('../utils/dates');
const service = require('../services/processRateService');

const router = express.Router();
router.use(authenticate);

router.get('/', requireService('ACC_REPORTS', 'VIEW'), async (req, res) => res.json(await service.list(req)));
router.put('/', requireService('ACC_REPORTS', 'FULL'), validate({
  body: Joi.object({ departmentId: Joi.string().guid().required(), ratePerMeter: Joi.number().precision(4).min(0).max(1000000).required(), effectiveFrom: ymdDate().required() }),
}), async (req, res) => res.json(await service.save(req, req.body)));
router.delete('/:id', requireService('ACC_REPORTS', 'FULL'), validate({ params: Joi.object({ id: Joi.string().guid().required() }) }), async (req, res) => res.json(await service.remove(req, req.params.id)));

module.exports = router;
