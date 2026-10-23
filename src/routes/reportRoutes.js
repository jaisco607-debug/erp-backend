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

const hub = require('../services/reportHubService');
const ledgers2 = require('../services/reportLedger2Service');
const more = require('../services/reportMoreService');
const ledgers = require('../services/reportLedgerService');

const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const id = Joi.string().guid();
const opt = (schema) => schema.empty('');
const query = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100000).default(50),
  export: Joi.boolean().default(false), all: Joi.boolean().default(false),
  dateFrom: opt(day), dateTo: opt(day), customerId: opt(id), qualityId: opt(id), departmentId: opt(id), fromDepartmentId: opt(id), itemId: opt(id),
  soNo: opt(Joi.number().integer().min(1)), jobNo: opt(Joi.number().integer().min(1)),
  status: opt(Joi.string().trim().max(20)), operator: opt(Joi.string().trim().max(80)), operatorName: opt(Joi.string().trim().max(80)), search: opt(Joi.string().trim().max(40)),
  stock: opt(Joi.string().trim().max(20)), by: opt(Joi.string().trim().max(30)), tab: opt(Joi.string().trim().max(30)),
  gatePass: opt(Joi.string().trim().lowercase().valid('yes', 'no', 'all')), grade: opt(Joi.string().trim().uppercase().valid('A', 'B', 'CP', 'ALL')),
  isGreyReturn: opt(Joi.boolean()), onlyProcess: opt(Joi.boolean()),
  groupBy: opt(Joi.string().valid('none', 'chemical', 'department', 'job', 'so_card', 'party', 'party_department', 'detail')),
  store: opt(Joi.string().valid('chemical', 'general')), view: opt(Joi.string().valid('lists', 'lines')),
});

const GROUPS = { chemical: 'chemical', department: 'department', dept: 'department', job: 'job', so_card: 'so_card', socard: 'so_card', so: 'so_card', party: 'party', customer: 'party',
  party_department: 'party_department', partydepartment: 'party_department', detail: 'detail', none: 'none' };
const EXPORT_CAP = 20000;

/** The tab's own names (all, operatorName, by, tab, grade ALL ...) turned into the names the services know. */
function normalise(v) {
  const f = { ...v };
  f.export = Boolean(v.export || v.all);
  if (f.operatorName && !f.operator) f.operator = f.operatorName;
  if (!f.groupBy && f.by) f.groupBy = GROUPS[String(f.by).toLowerCase().replace(/[-\s]/g, '_')];
  if (/^process$/i.test(f.tab || '')) f.onlyProcess = true;
  if (f.gatePass === 'all') delete f.gatePass;
  if (f.grade === 'ALL') delete f.grade;
  if (v.all && f.limit > EXPORT_CAP) f.limit = EXPORT_CAP;
  return f;
}
// The service of the report: a person with it (or with the data service) opens the report.
const needs = (reportCode) => (req, res, next) => { req.reportCode = reportCode; next(); };
const capped = (out, v) => {
  if (v.all) for (const sec of out.sections || []) sec.rows = sec.rows.slice(0, EXPORT_CAP);
  return out;
};
const run = (reportCode, fn, extra = {}) => [needs(reportCode), validate({ query }), async (req, res) => res.json(capped(await fn(req, { ...normalise(req.validatedQuery), ...extra }), req.validatedQuery))];

router.get('/', needs(null), async (req, res) => res.json(await hub.index(req)));
router.get('/overview', ...run('REPORT_OVERVIEW', hub.overview));

router.get('/grey/parties', ...run('REPORT_GREY', reports.greyParties));
router.get('/grey/lots', ...run('REPORT_GREY', reports.greyLots));
router.get('/grey/returns', ...run('REPORT_GREY', hub.greyReturns));
router.get('/so-cards', ...run('REPORT_SO_CARDS', reports.soCards));
router.get('/so-cards/lots', ...run('REPORT_SO_CARDS', hub.soCardLots));
router.get('/so-cards/movement', ...run('REPORT_SO_CARDS', reports.soCardMovement));
router.get('/so-cards/:id', needs('REPORT_SO_CARDS'), validate({ params: Joi.object({ id: id.required() }) }), async (req, res) => res.json(await reports.soCardDetail(req, req.params.id)));
router.get('/departments', ...run('REPORT_DEPARTMENTS', reports.departmentSummary));
router.get('/departments/summary', ...run('REPORT_DEPARTMENTS', reports.departmentSummary));
router.get('/departments/jobs', ...run('REPORT_DEPARTMENTS', (req, f) => reports.departmentJobs(req, f)));
router.get('/departments/operators', ...run('REPORT_DEPARTMENTS', reports.operators));
router.get('/departments/:code/jobs', needs('REPORT_DEPARTMENTS'), validate({ params: Joi.object({ code: Joi.string().max(50).required() }), query }),
  async (req, res) => res.json(await reports.departmentJobs(req, normalise(req.validatedQuery), req.params.code)));
router.get('/operators', ...run('REPORT_DEPARTMENTS', reports.operators));
router.get('/chemical-cost', ...run('REPORT_CHEMICAL_COST', reports.chemicalUsage));
router.get('/chemicals/usage', ...run('REPORT_CHEMICAL_COST', reports.chemicalUsage));
router.get('/chemicals/stock', ...run('REPORT_CHEMICAL_COST', reports.chemicalStock));
router.get('/chemicals/purchases', ...run('REPORT_CHEMICAL_COST', reports.chemicalPurchases));
router.get('/ledger', ...run('REPORT_GREY', ledgers.ledger));
router.get('/daily-stock', ...run('REPORT_GREY', ledgers.dailyStock));
router.get('/quality-wise', ...run('REPORT_SO_CARDS', more.qualityWise));
router.get('/party-cost', ...run('REPORT_SO_CARDS', more.partyCost));
router.get('/grade-summary', ...run('REPORT_PACKING', more.gradeSummary));
router.get('/ageing', ...run('REPORT_ACTIVE_FABRIC', more.ageing));
router.get('/pending-jobs', ...run('REPORT_DEPARTMENTS', more.pendingJobs));
router.get('/delivery-due', ...run('REPORT_SO_CARDS', more.deliveryDue));
router.get('/rework-jobs', ...run('REPORT_DEPARTMENTS', more.reworkJobs));
router.get('/departments-daily', ...run('REPORT_DEPARTMENTS', more.departmentDaily));
router.get('/ledgers/lot', ...run('REPORT_GREY', ledgers2.lotLedger));
router.get('/ledgers/so-card', ...run('REPORT_SO_CARDS', ledgers2.soCardLedger));
router.get('/ledgers/department', ...run('REPORT_DEPARTMENTS', ledgers2.departmentLedger));
router.get('/ledgers/operator', ...run('REPORT_DEPARTMENTS', ledgers2.operatorLedger));
router.get('/ledgers/cost', ...run('REPORT_CHEMICAL_COST', ledgers2.costLedger));
router.get('/ledgers/party', ...run('REPORT_GREY', ledgers2.partyLedger));
router.get('/audit-check', ...run('REPORT_OVERVIEW', ledgers2.auditCheck));
router.get('/folding', ...run('REPORT_FOLDING', reports.folding));
router.get('/active-fabric', ...run('REPORT_ACTIVE_FABRIC', reports.clothInProcess));
router.get('/cloth-now', ...run('REPORT_ACTIVE_FABRIC', reports.clothInProcess));
router.get('/packing-lists', ...run('REPORT_PACKING', reports.packingLists));
router.get('/packing-lists/lines', ...run('REPORT_PACKING', reports.packingLists, { view: 'lines' }));
router.get('/gate-passes', ...run('REPORT_GATE_PASSES', reports.gatePasses));

module.exports = router;
