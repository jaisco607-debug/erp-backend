// Deleted items (client admin only, with the Grey Store service):
//   GET  /api/v1/deleted-items?kind=lot&view=deleted|permanent&search=&page=&limit=
//   POST /api/v1/deleted-items/lot/:id/restore            revert: the lot comes back to Grey Inward
//   POST /api/v1/deleted-items/lot/:id/permanent-delete   body { lotNo } typed again: deleted for good, a copy stays in the archive, the number is free
const express = require('express');
const Joi = require('joi');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const service = require('../services/deletedItemService');

const router = express.Router();
router.use(authenticate, requireUserType('CLIENT_ADMIN'));

const idParam = Joi.object({ id: Joi.string().guid().required() });

router.get('/', requireService('GREY_STORE', 'VIEW'), validate({
  query: Joi.object({
    kind: Joi.string().valid('lot').default('lot'), view: Joi.string().valid('deleted', 'permanent').default('deleted'),
    search: Joi.string().trim().max(100).allow(''), page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(200).default(50),
  }),
}), async (req, res) => res.json(await service.list(req, req.validatedQuery)));

router.post('/lot/:id/restore', requireService('GREY_STORE', 'FULL'), validate({ params: idParam }), async (req, res) => res.json(await service.restoreLot(req, req.params.id)));

router.post('/lot/:id/permanent-delete', requireService('GREY_STORE', 'FULL'), validate({ params: idParam, body: Joi.object({ lotNo: Joi.number().integer().min(1).required() }) }),
  async (req, res) => res.json(await service.purgeLot(req, req.params.id, req.body)));

module.exports = router;
