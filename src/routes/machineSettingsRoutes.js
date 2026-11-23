// /api/v1/machine-settings  -  Settings > Machines (client admin only): which process departments have machines, the prefix of their machine names, add / switch off / delete machines.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const { Joi } = require('../validators/common');
const machines = require('../services/machineService');

const router = express.Router();
router.use(authenticate, requireUserType('CLIENT_ADMIN'));
const code = Joi.string().trim().max(50).required();
const idParam = Joi.object({ id: Joi.string().guid().required() });

router.get('/', async (req, res) => res.json(await machines.settings(req)));
router.patch('/machines/:id', validate({ params: idParam, body: Joi.object({ name: Joi.string().trim().max(20), isActive: Joi.boolean(), notes: Joi.string().trim().max(200).allow('', null) }).min(1) }), async (req, res) => res.json(await machines.updateMachine(req, req.params.id, req.body)));
router.delete('/machines/:id', validate({ params: idParam }), async (req, res) => res.json(await machines.removeMachine(req, req.params.id)));
router.patch('/:code', validate({ params: Joi.object({ code }), body: Joi.object({ machinesEnabled: Joi.boolean(), prefix: Joi.string().trim().max(8) }).min(1) }),
  async (req, res) => { await machines.setDepartment(req, req.params.code, req.body); res.json(await machines.settings(req)); });
router.get('/:code/machines', validate({ params: Joi.object({ code }) }), async (req, res) => res.json(await machines.listMachines(req, req.params.code)));
router.post('/:code/machines', validate({ params: Joi.object({ code }), body: Joi.object({ count: Joi.number().integer().min(1).max(100).default(1), notes: Joi.string().trim().max(200).allow('', null) }) }),
  async (req, res) => res.status(201).json(await machines.addMachines(req, req.params.code, req.body)));

module.exports = router;
