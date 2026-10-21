// /api/v1/admin/users  -  the super admin's READ-ONLY view of people: client admins, their employees and the
// services each has. Nothing here creates or changes a user: employees belong to their client admin.
//   client admins: /v1/companies/:id/admins ...      super admins: /v1/super-admins ...
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const { Joi, uuidParam } = require('../validators/common');
const adminUsers = require('../services/adminUserService');

const router = express.Router();
router.use(authenticate, requireUserType('SUPER_ADMIN'));

router.get('/', validate({ query: Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().max(100),
  companyId: Joi.string().guid(),
  userType: Joi.string().uppercase().valid('SUPER_ADMIN', 'CLIENT_ADMIN', 'USER'),
  isActive: Joi.boolean(),
}) }), async (req, res) => res.json(await adminUsers.list(req.validatedQuery)));

router.get('/:id', validate({ params: uuidParam }), async (req, res) => res.json(await adminUsers.get(req.params.id)));

module.exports = router;
