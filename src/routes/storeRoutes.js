// Step 7 routes.
//   /api/v1/vendors                        suppliers, one list for both stores
//   /api/v1/stores/chemical/...            Chemical Store   (service CHEMICAL_STORE)
//   /api/v1/stores/general/...             General Items Store (service GENERAL_STORE)
//   /api/v1/stores/chemical/cost/...       Store Reports (service STORE_REPORTS)
// VIEW access: lists, details, stock. FULL access: add, edit, delete drafts, approve.
// Taking an approval back: client admin only.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const AppError = require('../utils/AppError');
const v = require('../validators/storeValidator');
const c = require('../controllers/storeController');
const deptChem = require('../services/departmentChemicalService');
const { Joi } = require('../validators/common');
const { ymdDate } = require('../utils/dates');

const ymdDay = ymdDate();
const SERVICE = { chemical: 'CHEMICAL_STORE', general: 'GENERAL_STORE' };
const admin = requireUserType('CLIENT_ADMIN');

/** Access to the store named in the URL (chemical / general). */
const storeAccess = (level) => (req, res, next) => {
  const key = String(req.params.store).toLowerCase();
  if (!SERVICE[key]) return next(AppError.notFound('Store'));
  req.store = key.toUpperCase();
  return requireService(SERVICE[key], level)(req, res, next);
};
const view = storeAccess('VIEW');
const full = storeAccess('FULL');

/** Vendors: anyone with either store. */
const eitherStore = (level) => async (req, res, next) => {
  const tryOne = (code) => new Promise((resolve) => requireService(code, level)(req, res, (err) => resolve(!err)));
  if ((await tryOne('CHEMICAL_STORE')) || (await tryOne('GENERAL_STORE'))) return next();
  return next(AppError.forbidden('You do not have a store service'));
};

function crud(r, path, rules, ctl, viewMw, fullMw) {
  r.get(path, viewMw, validate(rules.list), ctl.list);
  r.post(path, fullMw, validate(rules.create), ctl.create);
  r.get(`${path}/:id`, viewMw, validate(rules.get), ctl.get);
  r.patch(`${path}/:id`, fullMw, validate(rules.update), ctl.update);
  r.delete(`${path}/:id`, fullMw, validate(rules.get), ctl.remove);
}

const vendors = express.Router();
vendors.use(authenticate);
vendors.get('/options', eitherStore('VIEW'), (req, res) => res.json({ statuses: v.VENDOR_STATUS, types: v.VENDOR_TYPES, payments: v.VENDOR_PAYMENT, provinces: ['Sindh', 'Punjab', 'Khyber Pakhtunkhwa', 'Balochistan', 'Islamabad', 'Gilgit-Baltistan', 'Azad Kashmir'] }));
vendors.get('/', eitherStore('VIEW'), validate(v.vendor.list), c.vendor.list);
vendors.post('/', eitherStore('FULL'), validate(v.vendor.create), c.vendor.create);
vendors.get('/:id', eitherStore('VIEW'), validate(v.vendor.get), c.vendor.get);
vendors.patch('/:id', eitherStore('FULL'), validate(v.vendor.update), c.vendor.update);
vendors.delete('/:id', eitherStore('FULL'), validate(v.vendor.get), c.vendor.remove);

const stores = express.Router();
stores.use(authenticate);
crud(stores, '/:store/categories', v.category, c.category, view, full);
crud(stores, '/:store/brands', v.brand, c.brand, view, full);
crud(stores, '/:store/items', v.item, c.item, view, full);
stores.get('/:store/items/:id/stock', view, validate(v.inward.get), c.itemStock);
stores.get('/:store/items/:id/moves', view, validate(v.moves), c.itemMoves);
// batches (owner 2026-10-19): stock rate by rate, last 5 purchases, where it was used
const inw = require('../services/storeInwardService');
const idP = Joi.object({ store: Joi.string(), id: Joi.string().guid().required() });
stores.get('/:store/items/:id/batches', view, validate({ params: idP }), async (req, res) => res.json(await inw.itemBatches(req, req.store, req.params.id)));
stores.get('/:store/items/:id/last-inwards', view, validate({ params: idP, query: Joi.object({ limit: Joi.number().integer().min(1).max(50).default(5) }) }),
  async (req, res) => res.json(await inw.lastInwards(req, req.store, req.params.id, req.validatedQuery.limit)));
stores.get('/:store/items/:id/usage', view, validate({ params: idP }), async (req, res) => res.json(await inw.itemUsage(req, req.store, req.params.id)));
stores.get('/:store/batches/:id/usage', view, validate({ params: idP }), async (req, res) => res.json(await inw.batchUsage(req, req.store, req.params.id)));
stores.get('/:store/stock', view, validate({ query: v.stock.query }), c.stock);

// bought stock sent back to the vendor (owner 2026-10-22)
stores.get('/:store/vendor-returns/returnable', view, validate(v.vendorReturn.returnable), c.vendorReturn.returnable);
stores.get('/:store/vendor-returns', view, validate(v.vendorReturn.list), c.vendorReturn.list);
stores.post('/:store/vendor-returns', full, validate(v.vendorReturn.create), c.vendorReturn.create);
stores.get('/:store/vendor-returns/:id', view, validate(v.vendorReturn.get), c.vendorReturn.get);
stores.post('/:store/vendor-returns/:id/cancel', full, validate(v.vendorReturn.cancel), c.vendorReturn.cancel);

// store reports and ledgers (owner 2026-10-22): the Store Reports service, every report has ?export=true for PDF / Excel
const storeReport = require('../services/storeReportService');
const reportQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100000).default(100), export: Joi.boolean().default(false),
  dateFrom: ymdDay, dateTo: ymdDay, date: ymdDay, itemId: Joi.string().guid(), categoryId: Joi.string().guid(), vendorId: Joi.string().guid(), departmentId: Joi.string().guid(),
  kind: Joi.string().valid('INWARD', 'INWARD_UNDO', 'INWARD_EDIT', 'ISSUE', 'RETURN', 'ADJUST', 'VENDOR_RETURN', 'VENDOR_RETURN_UNDO'), jobNo: Joi.number().integer().min(1), operator: Joi.string().trim().max(80),
  groupBy: Joi.string().valid('none', 'chemical', 'department', 'job', 'so_card'), showZero: Joi.boolean().default(false),
});
stores.get('/:store/reports/:name', (req, res, next) => (storeReport.REPORTS[req.params.name] ? next() : next(AppError.notFound('Report'))),
  (req, res, next) => (storeReport.CHEMICAL_ONLY.has(req.params.name) && req.params.store.toLowerCase() !== 'chemical' ? next(AppError.notFound('Report')) : next()),
  (req, res, next) => { req.store = String(req.params.store).toLowerCase(); return SERVICE[req.store] ? next() : next(AppError.notFound('Store')); },
  requireService('STORE_REPORTS', 'VIEW'), validate({ query: reportQuery }),
  async (req, res) => res.json(await storeReport.REPORTS[req.params.name](req, req.store.toUpperCase(), req.validatedQuery)));

// Chemical Store decides which chemicals each department sees (chemical store only)
const chemicalOnly = (req, res, next) => (String(req.params.store).toLowerCase() === 'chemical' ? next() : next(AppError.notFound('Page')));
const deptParam = Joi.object({ store: Joi.string(), departmentId: Joi.string().max(60).required() });
const ids = Joi.array().items(Joi.string().guid()).max(5000);
stores.get('/:store/department-access', chemicalOnly, view, async (req, res) => res.json(await deptChem.list(req)));
stores.get('/:store/department-access/:departmentId', chemicalOnly, view, validate({ params: deptParam }), async (req, res) => res.json(await deptChem.get(req, req.params.departmentId)));
stores.put('/:store/department-access/:departmentId', chemicalOnly, full, validate({ params: deptParam, body: Joi.object({ itemIds: ids, add: ids, remove: ids }).or('itemIds', 'add', 'remove') }),
  async (req, res) => res.json(await deptChem.set(req, req.params.departmentId, req.body)));

stores.get('/:store/inwards/form-data', view, c.inward.formData);
stores.get('/:store/inwards', view, validate(v.inward.list), c.inward.list);
stores.post('/:store/inwards', full, validate(v.inward.create), c.inward.create);
stores.get('/:store/inwards/:id', view, validate(v.inward.get), c.inward.get);
stores.patch('/:store/inwards/:id', full, validate(v.inward.update), c.inward.update);
stores.delete('/:store/inwards/:id', full, validate(v.inward.get), c.inward.remove);
stores.post('/:store/inwards/:id/approve', full, validate(v.inward.get), c.inward.approve);
stores.post('/:store/inwards/:id/correct', full, validate(v.inward.correct), c.inward.correct);
stores.post('/:store/inwards/:id/unapprove', admin, full, validate(v.inward.get), c.inward.unapprove);

// Chemical requests from departments (Step 8): Queue -> Process -> In-Way -> Delivered
const chem = require('../services/chemicalRequestService');
const reqParam = Joi.object({ store: Joi.string(), id: Joi.string().guid().required() });
const ymd = ymdDate();
const { paging } = require('../validators/common');
stores.get('/:store/requests', chemicalOnly, view, validate({ query: Joi.object({
  ...paging, tab: Joi.string().valid('all', 'queue', 'process', 'in_way', 'delivered', 'closed').default('all'), departmentId: Joi.string().guid(),
  reqNo: Joi.number().integer().min(1), jobNo: Joi.number().integer().min(1), soNo: Joi.number().integer().min(1), dateFrom: ymd, dateTo: ymd,
}) }), async (req, res) => res.json(await chem.storeList(req, req.validatedQuery)));
stores.get('/:store/requests/shortages', chemicalOnly, view, async (req, res) => res.json(await chem.shortages(req)));
stores.get('/:store/requests/:id', chemicalOnly, view, validate({ params: reqParam }), async (req, res) => res.json(await chem.storeGet(req, req.params.id)));
stores.post('/:store/requests/:id/accept', chemicalOnly, full, validate({ params: reqParam }), async (req, res) => res.json(await chem.accept(req, req.params.id)));
stores.post('/:store/requests/:id/reject', chemicalOnly, full, validate({ params: reqParam, body: Joi.object({ reason: Joi.string().trim().min(1).max(300).required() }) }),
  async (req, res) => res.json(await chem.reject(req, req.params.id, req.body)));
stores.post('/:store/requests/:id/send', chemicalOnly, full, validate({ params: reqParam, body: Joi.object({
  sentThrough: Joi.string().trim().max(120).allow('', null),
  lines: Joi.array().items(Joi.object({
    lineId: Joi.string().guid().required(),
    qty: Joi.number().precision(3).min(0).max(999999),
    qtyMain: Joi.number().integer().min(0).max(999999),
    qtySub: Joi.number().integer().min(0).max(99999),
    // which batches to give (owner 2026-10-19); none = oldest first
    batches: Joi.array().items(Joi.object({
      batchId: Joi.string().guid().required(),
      qty: Joi.number().precision(3).min(0).max(999999),
      qtyMain: Joi.number().integer().min(0).max(999999),
      qtySub: Joi.number().integer().min(0).max(99999),
    })).max(50),
  })).max(100),
}) }), async (req, res) => res.json(await chem.send(req, req.params.id, req.body)));
// chemical not in stock: offer an alternate, or say when it will come
const lineParam = Joi.object({ store: Joi.string(), id: Joi.string().guid().required(), lineId: Joi.string().guid().required() });
stores.post('/:store/requests/:id/lines/:lineId/alternate', chemicalOnly, full, validate({ params: lineParam, body: Joi.object({
  itemId: Joi.string().guid().required(),
  qty: Joi.number().precision(3).positive().max(999999),
  qtyMain: Joi.number().integer().min(0).max(999999),
  qtySub: Joi.number().integer().min(0).max(99999),
  note: Joi.string().trim().max(300).allow('', null),
}) }), async (req, res) => res.json(await chem.offerAlternate(req, req.params.id, req.params.lineId, req.body)));
stores.post('/:store/requests/:id/lines/:lineId/eta', chemicalOnly, full, validate({ params: lineParam, body: Joi.object({
  etaDate: ymd.allow(null), note: Joi.string().trim().max(300).allow('', null),
}).or('etaDate', 'note') }), async (req, res) => res.json(await chem.setEta(req, req.params.id, req.params.lineId, req.body)));
// chemicals sent back by departments
const ret = require('../services/chemicalReturnService');
stores.get('/:store/returns', chemicalOnly, view, validate({ query: Joi.object({ ...paging, tab: Joi.string().valid('all', 'pending', 'received', 'closed').default('all'), departmentId: Joi.string().guid() }) }),
  async (req, res) => res.json(await ret.storeList(req, req.validatedQuery)));
stores.get('/:store/returns/:id', chemicalOnly, view, validate({ params: reqParam }), async (req, res) => res.json(await ret.storeGet(req, req.params.id)));
stores.post('/:store/returns/:id/receive', chemicalOnly, full, validate({ params: reqParam }), async (req, res) => res.json(await ret.receive(req, req.params.id)));
stores.post('/:store/returns/:id/reject', chemicalOnly, full, validate({ params: reqParam, body: Joi.object({ reason: Joi.string().trim().min(1).max(300).required() }) }),
  async (req, res) => res.json(await ret.reject(req, req.params.id, req.body)));

// stock adjustments (both stores)
const adj = require('../services/storeAdjustmentService');
const { ADJUST_REASONS } = require('../models');
stores.get('/:store/adjustments', view, validate({ query: Joi.object({ ...paging, reason: Joi.string().valid(...ADJUST_REASONS), itemId: Joi.string().guid(), dateFrom: ymd, dateTo: ymd }) }),
  async (req, res) => res.json(await adj.list(req, req.store, req.validatedQuery)));
stores.get('/:store/adjustments/:id', view, validate({ params: reqParam }), async (req, res) => res.json(await adj.get(req, req.store, req.params.id)));
stores.post('/:store/adjustments', full, validate({ body: Joi.object({
  adjDate: ymd,
  reason: Joi.string().valid(...ADJUST_REASONS).required(),
  notes: Joi.string().trim().max(500).allow('', null),
  lines: Joi.array().items(Joi.object({
    itemId: Joi.string().guid().required(),
    mode: Joi.string().valid('COUNT', 'IN', 'OUT').required(),
    qty: Joi.number().precision(3).min(0).max(999999999),
    qtyMain: Joi.number().integer().min(0).max(999999999),
    qtySub: Joi.number().integer().min(0).max(99999),
    rate: Joi.number().precision(4).min(0).max(999999999),
    batchId: Joi.string().guid(),
  })).min(1).max(200).required(),
}) }), async (req, res) => res.status(201).json(await adj.create(req, req.store, req.body)));

// chemical cost per Job and per SO card: the Store Reports service (the super admin gives it separately)
const storeReports = requireService('STORE_REPORTS', 'VIEW');
const costQuery = Joi.object({ ...paging, dateFrom: ymd, dateTo: ymd, customerId: Joi.string().guid(), departmentId: Joi.string().guid() });
stores.get('/:store/cost/jobs', chemicalOnly, storeReports, validate({ query: costQuery }), async (req, res) => res.json(await chem.costReport(req, { ...req.validatedQuery, by: 'job' })));
stores.get('/:store/cost/so-cards', chemicalOnly, storeReports, validate({ query: costQuery }), async (req, res) => res.json(await chem.costReport(req, { ...req.validatedQuery, by: 'so-card' })));
stores.get('/:store/cost/jobs/:id', chemicalOnly, storeReports, validate({ params: reqParam }), async (req, res) => res.json(await chem.jobCost(req, req.params.id)));
stores.get('/:store/cost/so-cards/:id', chemicalOnly, storeReports, validate({ params: reqParam }), async (req, res) => res.json(await chem.soCardCost(req, req.params.id)));

module.exports = { vendors, stores };
