// /api/v1/processes  -  the client admin's own processes (Process Management > Settings > Processes).
// Only a client admin of a company the super admin switched Process Management on for (and within the limit the super admin gave).
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const { Joi, uuidParam } = require('../validators/common');
const processes = require('../services/processService');

const router = express.Router();
router.use(authenticate, requireUserType('CLIENT_ADMIN'));

const name = Joi.string().trim().min(2).max(120);

router.get('/', async (req, res) => res.json(await processes.list(req)));
router.post('/', validate({ body: Joi.object({ name: name.required(), tracksColour: Joi.boolean() }) }), async (req, res) => res.status(201).json(await processes.create(req, req.body)));
router.patch('/:id', validate({
  params: uuidParam,
  body: Joi.object({ code: Joi.string(), name: Joi.string().trim().min(1).max(120), isActive: Joi.boolean(), tracksColour: Joi.boolean(), sortOrder: Joi.number().integer().min(0).max(100000) }).min(1),
}), async (req, res) => res.json(await processes.update(req, req.params.id, req.body)));
router.delete('/:id', validate({ params: uuidParam }), async (req, res) => res.json(await processes.remove(req, req.params.id)));

module.exports = router;
