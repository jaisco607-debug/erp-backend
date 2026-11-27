// /api/v1/audit-logs
//   a SUPER ADMIN (not inside a company) reads everything, with the old filters;
//   a CLIENT ADMIN (a super admin who opened the company is one for that request) reads the log of his own company only: a date range is needed (at most 92 days),
//   with filters, and sees one entry with its before and after.
//   GET /            list          GET /options  the filters           GET /:id  one entry
const express = require('express');
const Joi = require('joi');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const { ymdDate } = require('../utils/dates');
const v = require('../validators/auditValidator');
const c = require('../controllers/auditController');
const auditLogService = require('../services/auditLogService');

const router = express.Router();
router.use(authenticate);

const clientQuery = validate({
  query: Joi.object({
    from: ymdDate(), to: ymdDate(), userId: Joi.string().guid(), entityType: Joi.string().trim().max(60), action: Joi.string().trim().max(60),
    entityId: Joi.string().trim().max(64), search: Joi.string().trim().max(100), page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(200).default(50),
  }),
});
const superQuery = validate(v.list);

// the same address, two kinds of reader
router.get('/', requireUserType('SUPER_ADMIN', 'CLIENT_ADMIN'), (req, res, next) => (req.user.userType === 'SUPER_ADMIN' ? superQuery : clientQuery)(req, res, next),
  async (req, res) => (req.user.userType === 'SUPER_ADMIN' ? c.list(req, res) : res.json(await auditLogService.list(req, req.validatedQuery))));

// fixed paths before /:id
router.get('/options', requireUserType('CLIENT_ADMIN'), async (req, res) => res.json(await auditLogService.options(req)));
router.get('/:id', requireUserType('CLIENT_ADMIN'), validate({ params: Joi.object({ id: Joi.string().pattern(/^\d{1,18}$/).required().messages({ 'string.pattern.base': 'id must be a number' }) }) }), async (req, res) => res.json(await auditLogService.get(req, req.params.id)));

module.exports = router;
