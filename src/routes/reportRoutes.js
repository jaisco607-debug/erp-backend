// /api/v1/reports  -  read-only reports of the whole system (owner 2026-10-20).
// Every report group is its own service (REPORT_GREY, REPORT_SO_CARDS ...), given by the super admin;
// the client admin passes them on to users (VIEW is enough). GET /reports lists only the allowed ones. Every list report answers
// { report, title, filters, columns, rows, totals, page, limit, total }; all=true sends every row
// (for PDF / Excel downloads, made by the frontend).
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const { Joi } = require('../validators/common');
const { ymdDate } = require('../utils/dates');
const r = require('../services/reportService');

const router = express.Router();
router.use(authenticate);

const day = ymdDate().messages({ 'string.pattern.base': 'date looks like 2026-10-20' });
const id = Joi.string().guid();
const base = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(50),
  all: Joi.boolean().default(false),
  dateFrom: day,
  dateTo: day,
  customerId: id,
};
const query = (extra = {}) => ({ query: Joi.object({ ...base, ...extra }) });
const search = Joi.string().trim().max(40);
const jobStatus = Joi.string().uppercase().valid('IN_WAY', 'QUEUE', 'PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED');

const get = (service, path, rules, fn) => router.get(path, requireService(service, 'VIEW'), validate(rules), async (req, res) => res.json(await fn(req, req.validatedQuery || {})));

router.get('/', async (req, res) => res.json(await r.catalog(req)));
get('REPORT_OVERVIEW', '/overview', { query: Joi.object({ dateFrom: day, dateTo: day }) }, r.overview);

get('REPORT_GREY', '/grey/parties', query(), r.greyParties);
get('REPORT_GREY', '/grey/lots', query({ qualityId: id, stock: Joi.string().valid('all', 'in-stock', 'finished').default('all'), search }), r.greyLots);
get('REPORT_GREY', '/grey/returns', query(), r.greyReturns);

get('REPORT_SO_CARDS', '/so-cards', query({ isGreyReturn: Joi.boolean(), departmentId: id, status: Joi.string().uppercase().valid('NEW', 'SENT', 'IN_DEPARTMENT'), search }), r.soCards);
get('REPORT_SO_CARDS', '/so-cards/lots', query({ isGreyReturn: Joi.boolean(), soCardId: id, search }), r.soCardLots);
router.get('/so-cards/:id', requireService('REPORT_SO_CARDS', 'VIEW'), validate({ params: Joi.object({ id: id.required() }) }), async (req, res) => res.json(await r.soCardDetail(req, req.params.id)));

get('REPORT_DEPARTMENTS', '/departments', query({ departmentId: id }), r.departments);
get('REPORT_DEPARTMENTS', '/departments/jobs', query({ departmentId: id, fromDepartmentId: id, soCardId: id, status: jobStatus, operatorName: Joi.string().trim().max(80), search }), r.departmentJobs);
get('REPORT_DEPARTMENTS', '/departments/operators', query({ departmentId: id, operatorName: Joi.string().trim().max(80) }), r.operators);

get('REPORT_CHEMICAL_COST', '/chemical-cost', query({
  by: Joi.string().valid('so-card', 'lot', 'thaan', 'chemical', 'item').default('so-card'),
  departmentId: id, soCardId: id, itemId: id,
}), r.chemicalCost);

get('REPORT_FOLDING', '/folding', query({
  by: Joi.string().valid('row', 'party', 'from-department').default('row'),
  fromDepartmentId: id, tab: Joi.string().valid('all', 'open', 'closed').default('all'), search,
}), r.foldingReport);

get('REPORT_ACTIVE_FABRIC', '/active-fabric', { query: Joi.object({
  page: base.page, limit: base.limit, all: base.all, customerId: id, departmentId: id,
  by: Joi.string().valid('party', 'so-card', 'department', 'detail').default('party'),
}) }, r.activeFabric);

const packing = { soCardId: id, status: Joi.string().uppercase().valid('DRAFT', 'FINAL'), search };
get('REPORT_PACKING', '/packing-lists', query({ ...packing, gatePass: Joi.string().valid('all', 'yes', 'no').default('all') }), r.packingLists);
get('REPORT_PACKING', '/packing-lists/lines', query({ ...packing, grade: Joi.string().uppercase().valid('A', 'B', 'CP') }), r.packingLines);
get('REPORT_GATE_PASSES', '/gate-passes', query({ search }), r.gatePasses);

module.exports = router;
