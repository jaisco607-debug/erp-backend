// /api/v1/locks  -  edit locks: only the person who opened a record for editing may edit it (see lockService).
// Any signed-in person; whether they may edit the record is checked inside.
const express = require('express');
const { Joi } = require('../validators/common');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const locks = require('../services/lockService');

const router = express.Router();
router.use(authenticate);

const lockKey = Joi.object({ lockId: Joi.string().max(60).required() });
const target = { resourceType: Joi.string().valid(...locks.TYPES).required(), resourceId: Joi.string().trim().min(1).max(100).required() };

router.get('/', validate({ query: Joi.object(target) }), async (req, res) => res.json(await locks.current(req, req.validatedQuery)));
router.post('/', validate({ body: Joi.object({ ...target, tabId: Joi.string().trim().min(1).max(100).required() }) }), async (req, res) => res.json(await locks.acquire(req, req.body)));
router.put('/:lockId/heartbeat', validate({ params: lockKey }), async (req, res) => res.json(await locks.heartbeat(req, req.params.lockId)));
router.delete('/:lockId', validate({ params: lockKey }), async (req, res) => {
  await locks.release(req, req.params.lockId);
  res.status(204).end();
});

module.exports = router;
