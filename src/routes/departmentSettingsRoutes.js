// /api/v1/department-settings  -  the client admin decides which departments may request chemicals from the Chemical Store.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const { Joi } = require('../validators/common');
const settings = require('../services/departmentSettingsService');

const router = express.Router();
router.use(authenticate, requireUserType('CLIENT_ADMIN'));
const code = Joi.string().trim().max(50).required();
const flag = Joi.boolean().required();

router.get('/', async (req, res) => res.json(await settings.list(req)));
router.put('/', validate({ body: Joi.object({ departments: Joi.array().items(Joi.object({ code, chemicalRequests: flag })).min(1).max(100).required() }) }),
  async (req, res) => res.json(await settings.setMany(req, req.body.departments)));
router.patch('/:code', validate({ params: Joi.object({ code }), body: Joi.object({ chemicalRequests: flag }) }),
  async (req, res) => res.json(await settings.setMany(req, [{ code: req.params.code, chemicalRequests: req.body.chemicalRequests }])));

module.exports = router;
