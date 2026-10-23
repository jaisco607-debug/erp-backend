// Reports (owner 2026-10-20). Read only. Every report has the same answer shape (see reportService)
// so the frontend builds one screen and one PDF / Excel export for all of them.
//   ?export=true returns every row (no paging) for the download.
// Access: the service of the data (Grey Store, SO Card, Chemical Store, Folding, Packing), or the
// departments the person has (a department person sees only his departments).
const express = require('express');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const { Joi } = require('../validators/common');
const reports = require('../services/reportService');

const router = express.Router();
router.use(authenticate);

const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const id = Joi.string().guid();
const query = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100000).default(50),
  export: Joi.boolean().default(false),
  dateFrom: day, dateTo: day, customerId: id, departmentId: id, itemId: id,
  soNo: Joi.number().integer().min(1), jobNo: Joi.number().integer().min(1),
  status: Joi.string().trim().max(20), operator: Joi.string().trim().max(80), search: Joi.string().trim().max(40),
  isGreyReturn: Joi.boolean(), onlyProcess: Joi.boolean(),
  groupBy: Joi.string().valid('none', 'chemical', 'department', 'job', 'so_card', 'party', 'party_department', 'detail'),
  store: Joi.string().valid('chemical', 'general'), view: Joi.string().valid('lists', 'lines'),
});
const run = (fn) => [validate({ query }), async (req, res) => res.json(await fn(req, req.validatedQuery))];

router.get('/grey/parties', ...run(reports.greyParties));
router.get('/grey/lots', ...run(reports.greyLots));
router.get('/so-cards', ...run(reports.soCards));
router.get('/so-cards/movement', ...run(reports.soCardMovement));
router.get('/so-cards/:id', validate({ params: Joi.object({ id: id.required() }) }), async (req, res) => res.json(await reports.soCardDetail(req, req.params.id)));
router.get('/departments/summary', ...run(reports.departmentSummary));
router.get('/departments/jobs', ...run((req, f) => reports.departmentJobs(req, f)));
router.get('/departments/:code/jobs', validate({ params: Joi.object({ code: Joi.string().max(50).required() }), query }),
  async (req, res) => res.json(await reports.departmentJobs(req, req.validatedQuery, req.params.code)));
router.get('/operators', ...run(reports.operators));
router.get('/chemicals/usage', ...run(reports.chemicalUsage));
router.get('/chemicals/stock', ...run(reports.chemicalStock));
router.get('/chemicals/purchases', ...run(reports.chemicalPurchases));
router.get('/folding', ...run(reports.folding));
router.get('/cloth-now', ...run(reports.clothInProcess));
router.get('/packing-lists', ...run(reports.packingLists));
router.get('/gate-passes', ...run(reports.gatePasses));

module.exports = router;
