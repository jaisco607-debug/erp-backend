// /api/v1/weaving  -  the Weaving module. Masters: Yarn Count, Brand, Item Card, Customers, Vendors. Then Yarn Inward.
// Reading: WEAVING_MASTERS (VIEW is enough); changing: WEAVING_MASTERS with FULL access. Company people only.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const { Joi, uuidParam, paging } = require('../validators/common');
const yarnCounts = require('../services/yarnCountService');
const yarnBrands = require('../services/yarnBrandService');
const weavingDepartments = require('../services/weavingDepartmentService');
const weavingQualities = require('../services/weavingQualityService');
const yarnItems = require('../services/yarnItemService');
const { PACKINGS, BAGS } = require('../models/YarnItem');
const gv = require('../validators/greyValidator');
const gc = require('../controllers/greyController');
const sv = require('../validators/storeValidator');
const sc = require('../controllers/storeController');
const inwards = require('../services/yarnInwardService');
const yarnContracts = require('../services/yarnContractService');
const sizingReturns = require('../services/sizingReturnService');
const looms = require('../services/loomService');
const sizingBatches = require('../services/sizingBatchService');
const yarnStock = require('../services/yarnStockService');
const outwards = require('../services/yarnOutwardService');
const sales = require('../services/yarnSaleService');
const beams = require('../services/yarnBeamService');
const beamStock = require('../services/yarnBeamStockService');
const sizingInwards = require('../services/yarnSizingInwardService');
const { STATUSES: BEAM_STATUSES } = require('../models/YarnBeam');
const { ymdDate } = require('../utils/dates');

const router = express.Router();
router.use(authenticate);
const view = requireService('WEAVING_MASTERS', 'VIEW');
const full = requireService('WEAVING_MASTERS', 'FULL');

// the name: any text (22|s, 22|s Cotton, a brand ...), extra spaces are squeezed, 1 to 80 characters
const name = Joi.string().trim().min(1).max(80);
const listQuery = { ...paging, limit: Joi.number().integer().min(1).max(500).default(100), search: Joi.string().trim().max(80), isActive: Joi.boolean() };

/** Yarn Count and Brand are the same kind of master: a unique name. */
function nameRoutes(path, svc) {
  router.get(path, view, validate({ query: Joi.object(listQuery) }), async (req, res) => res.json(await svc.list(req, req.validatedQuery)));
  router.post(path, full, validate({ body: Joi.object({ name: name.required(), isActive: Joi.boolean() }) }), async (req, res) => res.status(201).json(await svc.create(req, req.body)));
  router.get(`${path}/:id`, view, validate({ params: uuidParam }), async (req, res) => res.json(await svc.get(req, req.params.id)));
  router.patch(`${path}/:id`, full, validate({ params: uuidParam, body: Joi.object({ name, isActive: Joi.boolean() }).min(1) }), async (req, res) => res.json(await svc.update(req, req.params.id, req.body)));
  router.delete(`${path}/:id`, full, validate({ params: uuidParam }), async (req, res) => res.json(await svc.remove(req, req.params.id)));
}
nameRoutes('/yarn-counts', yarnCounts);
nameRoutes('/brands', yarnBrands);
nameRoutes('/qualities', weavingQualities); // Masters > Quality: the qualities picked on the sizing batch
nameRoutes('/departments', weavingDepartments); // Masters > Department: the departments the beams belong to

// ---- Item Card: yarn count + brand + packing + bags ----
const id = Joi.string().guid({ version: 'uuidv4' });
router.get('/item-cards/options', view, (req, res) => res.json(yarnItems.options())); // before '/:id'
router.get('/item-cards', view, validate({ query: Joi.object({ ...listQuery, yarnCountId: id, brandId: id }) }), async (req, res) => res.json(await yarnItems.list(req, req.validatedQuery)));
router.post('/item-cards', full, validate({ body: Joi.object({ yarnCountId: id.required(), brandId: id.required(), packing: Joi.number().valid(...PACKINGS), bags: Joi.number().valid(...BAGS), isActive: Joi.boolean() }) }),
  async (req, res) => res.status(201).json(await yarnItems.create(req, req.body)));
router.get('/item-cards/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await yarnItems.get(req, req.params.id)));
router.patch('/item-cards/:id', full, validate({ params: uuidParam, body: Joi.object({ yarnCountId: id, brandId: id, packing: Joi.number().valid(...PACKINGS), bags: Joi.number().valid(...BAGS), isActive: Joi.boolean() }).min(1) }),
  async (req, res) => res.json(await yarnItems.update(req, req.params.id, req.body)));
router.delete('/item-cards/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await yarnItems.remove(req, req.params.id)));

// ---- Customers and Vendors: the same tables and forms as the Grey Store and the stores, but the weaving module's OWN list ----
const PROVINCES = ['Sindh', 'Punjab', 'Khyber Pakhtunkhwa', 'Balochistan', 'Islamabad', 'Gilgit-Baltistan', 'Azad Kashmir'];
// the weaving module has its OWN customers and vendors (module WEAVING): the lists start empty and are not the Grey Store / store lists
const weavingList = (req, res, next) => { req.partyModule = 'WEAVING'; next(); };
function partyRoutes(path, rules, ctl, optionsBody) {
  router.use(path, weavingList);
  router.get(`${path}/options`, view, (req, res) => res.json(optionsBody)); // before '/:id'
  router.get(path, view, validate(rules.list), ctl.list);
  router.post(path, full, validate(rules.create), ctl.create);
  router.get(`${path}/:id`, view, validate(rules.get), ctl.get);
  router.patch(`${path}/:id`, full, validate(rules.update), ctl.update);
  router.delete(`${path}/:id`, full, validate(rules.get), ctl.remove);
}
partyRoutes('/customers', gv.customer, gc.customer, { statuses: gv.CUSTOMER_STATUS, types: gv.CUSTOMER_TYPES, payments: gv.CUSTOMER_PAYMENT, provinces: PROVINCES });
partyRoutes('/vendors', sv.vendor, sc.vendor, { statuses: sv.VENDOR_STATUS, types: sv.VENDOR_TYPES, payments: sv.VENDOR_PAYMENT, provinces: PROVINCES });

// ---- Yarn Inward: a vendor (purchase yarn) or a customer (overhead yarn), one item card, bags x lbs per bag, rate per lb ----
const ymd = ymdDate();
const entry = {
  purpose: Joi.string().uppercase().valid('WEFT', 'WARP', 'BOTH'), // what the yarn is for: weft, warp or both (default BOTH on a new entry)
  contractLineId: id.allow(null), // the contract line the yarn counts against: required for a customer (overhead) entry, optional for a vendor entry
  directVendorId: id.allow(null), // yarn the supplier delivered straight to this sizing party (never came to our factory); null = it came to the factory
  inwardDate: ymd, dcNo: Joi.string().trim().max(50).allow('', null), remarks: Joi.string().trim().max(300).allow('', null),
  bags: Joi.number().integer().min(1).max(1000000), lbsPerBag: Joi.number().precision(2).positive().max(1000000), ratePerLb: Joi.number().precision(4).min(0).max(1000000000).allow(null),
};
router.get('/yarn-inwards/form-data', view, async (req, res) => res.json(await inwards.formData(req))); // before '/:id'
router.get('/yarn-inwards', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(50), search: Joi.string().trim().max(80),
  type: Joi.string().uppercase().valid('PURCHASE', 'OVERHEAD'), purpose: Joi.string().uppercase().valid('WEFT', 'WARP', 'BOTH'), usableFor: Joi.string().uppercase().valid('WEFT', 'WARP'), contractId: id, contractLineId: id, noContract: Joi.boolean(), customerId: id, vendorId: id, itemId: id, dateFrom: ymd, dateTo: ymd }) }), async (req, res) => res.json(await inwards.list(req, req.validatedQuery)));
router.post('/yarn-inwards', full, validate({ body: Joi.object({ ...entry, bags: entry.bags.required(), lbsPerBag: entry.lbsPerBag.required(), itemId: id.required(), customerId: id, vendorId: id }).xor('customerId', 'vendorId') }),
  async (req, res) => res.status(201).json(await inwards.create(req, req.body)));
router.get('/yarn-inwards/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await inwards.get(req, req.params.id)));
router.patch('/yarn-inwards/:id', full, validate({ params: uuidParam, body: Joi.object({ ...entry, itemId: id, customerId: id, vendorId: id }).min(1).oxor('customerId', 'vendorId') }),
  async (req, res) => res.json(await inwards.update(req, req.params.id, req.body)));
router.delete('/yarn-inwards/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await inwards.remove(req, req.params.id)));

// ---- Masters > Loom: a loom no and the department it belongs to (Masters > Department: e.g. Sulzer, Airjet) ----
router.get('/looms', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(100), search: Joi.string().trim().max(80), departmentId: id, isActive: Joi.boolean(), running: Joi.boolean() }) }), async (req, res) => res.json(await looms.list(req, req.validatedQuery)));
router.post('/looms', full, validate({ body: Joi.object({ loomNo: Joi.string().trim().min(1).max(20).required(), loomType: Joi.string().trim().max(20).allow('', null), departmentId: id.required(), isActive: Joi.boolean() }) }), async (req, res) => res.status(201).json(await looms.create(req, req.body)));
router.get('/looms/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await looms.get(req, req.params.id)));
router.patch('/looms/:id', full, validate({ params: uuidParam, body: Joi.object({ loomNo: Joi.string().trim().min(1).max(20), loomType: Joi.string().trim().max(20).allow('', null), departmentId: id, isActive: Joi.boolean() }).min(1) }), async (req, res) => res.json(await looms.update(req, req.params.id, req.body)));
router.delete('/looms/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await looms.remove(req, req.params.id)));

// ---- Sizing Return: yarn and / or empty beams sent to a sizing party are called back WITHOUT sizing (an In Pass); beams go back to Empty, the yarn back into the stock ----
const returnYarn = Joi.object({ inwardId: id.required(), bags: Joi.number().integer().min(1).max(1000000).required() });
const returnFields = { returnDate: ymd, refNo: Joi.string().trim().max(50).allow('', null), notes: Joi.string().trim().max(300).allow('', null), beamIds: Joi.array().items(id).max(200), yarns: Joi.array().items(returnYarn).max(100) };
router.get('/sizing-returns/pending-beams', view, validate({ query: Joi.object({ vendorId: id.required(), search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await sizingBatches.pendingBeams(req, req.validatedQuery))); // the beams waiting at that sizing party
router.get('/sizing-returns/yarn-available', view, validate({ query: Joi.object({ vendorId: id.required(), returnId: id, search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await sizingReturns.yarnAvailable(req, req.validatedQuery)));
router.get('/sizing-returns', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(50), search: Joi.string().trim().max(80), vendorId: id, dateFrom: ymd, dateTo: ymd }) }), async (req, res) => res.json(await sizingReturns.list(req, req.validatedQuery)));
router.post('/sizing-returns', full, validate({ body: Joi.object({ ...returnFields, vendorId: id.required() }) }), async (req, res) => res.status(201).json(await sizingReturns.create(req, req.body)));
router.get('/sizing-returns/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await sizingReturns.get(req, req.params.id)));
router.patch('/sizing-returns/:id', full, validate({ params: uuidParam, body: Joi.object(returnFields).min(1) }), async (req, res) => res.json(await sizingReturns.update(req, req.params.id, req.body)));
router.delete('/sizing-returns/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await sizingReturns.remove(req, req.params.id)));

// ---- Yarn Contracts: PURCHASE (with a vendor) and OVERHEAD (with a customer); lines = yarn counts; yarn inward entries count against the lines ----
const contractLine = {
  yarnCountId: id, bags: Joi.number().integer().min(1).max(1000000), bagWeight: Joi.number().precision(2).positive().max(1000000),
  lbs: Joi.number().precision(2).positive().max(1000000000), ratePerLb: Joi.number().precision(4).min(0).max(1000000000).allow(null),
};
const contractHead = {
  contractDate: ymd, deliveryDate: ymd.allow(null), termsDays: Joi.number().integer().min(0).max(3650), notes: Joi.string().trim().max(300).allow('', null), taxPercent: Joi.number().precision(2).min(0).max(100),
};
const contractId = Joi.object({ id: id.required() });
const lineParams = Joi.object({ id: id.required(), lineId: id.required() });
router.get('/yarn-contracts/form-data', view, async (req, res) => res.json(await yarnContracts.formData(req))); // the static paths before '/:id'
router.get('/yarn-contracts/open-lines', view, validate({ query: Joi.object({ vendorId: id, customerId: id, yarnCountId: id, itemId: id }).xor('vendorId', 'customerId') }), async (req, res) => res.json(await yarnContracts.openLines(req, req.validatedQuery)));
router.get('/yarn-contracts', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(50), search: Joi.string().trim().max(80),
  kind: Joi.string().uppercase().valid(...yarnContracts.KINDS), status: Joi.string().uppercase().valid('OPEN', 'CLOSED'), vendorId: id, customerId: id, dateFrom: ymd, dateTo: ymd }) }), async (req, res) => res.json(await yarnContracts.list(req, req.validatedQuery)));
router.post('/yarn-contracts', full, validate({ body: Joi.object({ kind: Joi.string().uppercase().valid(...yarnContracts.KINDS).required(), vendorId: id, customerId: id, ...contractHead,
  lines: Joi.array().min(1).max(200).items(Joi.object({ ...contractLine, yarnCountId: id.required() })).required() }).oxor('vendorId', 'customerId') }), async (req, res) => res.status(201).json(await yarnContracts.create(req, req.body)));
router.get('/yarn-contracts/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await yarnContracts.get(req, req.params.id)));
router.patch('/yarn-contracts/:id', full, validate({ params: uuidParam, body: Joi.object({ vendorId: id, customerId: id, ...contractHead }).min(1).oxor('vendorId', 'customerId') }), async (req, res) => res.json(await yarnContracts.update(req, req.params.id, req.body)));
router.post('/yarn-contracts/:id/close', full, validate({ params: contractId }), async (req, res) => res.json(await yarnContracts.close(req, req.params.id)));
router.post('/yarn-contracts/:id/activate', full, validate({ params: contractId }), async (req, res) => res.json(await yarnContracts.activate(req, req.params.id)));
router.delete('/yarn-contracts/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await yarnContracts.remove(req, req.params.id)));
router.post('/yarn-contracts/:id/lines', full, validate({ params: contractId, body: Joi.object({ ...contractLine, yarnCountId: id.required() }) }), async (req, res) => res.status(201).json(await yarnContracts.addLine(req, req.params.id, req.body)));
router.patch('/yarn-contracts/:id/lines/:lineId', full, validate({ params: lineParams, body: Joi.object(contractLine).min(1) }), async (req, res) => res.json(await yarnContracts.updateLine(req, req.params.id, req.params.lineId, req.body)));
router.delete('/yarn-contracts/:id/lines/:lineId', full, validate({ params: lineParams }), async (req, res) => res.json(await yarnContracts.removeLine(req, req.params.id, req.params.lineId)));
router.post('/yarn-contracts/:id/lines/:lineId/close', full, validate({ params: lineParams }), async (req, res) => res.json(await yarnContracts.closeLine(req, req.params.id, req.params.lineId)));
router.post('/yarn-contracts/:id/lines/:lineId/activate', full, validate({ params: lineParams }), async (req, res) => res.json(await yarnContracts.activateLine(req, req.params.id, req.params.lineId)));

// ---- Yarn Stock: per item card and lbs per bag, inward - outward = balance ----
router.get('/yarn-stock', view, validate({ query: Joi.object({ search: Joi.string().trim().max(80), yarnCountId: id, brandId: id, itemId: id, type: Joi.string().uppercase().valid('PURCHASE', 'OVERHEAD'), dateTo: ymd, showZero: Joi.boolean() }) }),
  async (req, res) => res.json(await yarnStock.list(req, req.validatedQuery)));

// ---- Yarn Outward > Weft: a delivery challan that takes yarn out of the stock (any bags of any stock entry) and sends it to the weft ----
const outLine = Joi.object({ inwardId: id.required(), bags: Joi.number().integer().min(1).max(1000000).required() });
const outLines = Joi.array().items(outLine).min(1).max(200).unique('inwardId');
const outFields = { outwardDate: ymd, department: Joi.string().trim().max(50).allow('', null), description: Joi.string().trim().max(300).allow('', null) };
router.get('/yarn-weft/stock-entries', view, validate({ query: Joi.object({ search: Joi.string().trim().max(80), itemId: id, vendorId: id, customerId: id, type: Joi.string().uppercase().valid('PURCHASE', 'OVERHEAD') }) }),
  async (req, res) => res.json(await outwards.stockEntries(req, req.validatedQuery))); // before '/:id'
router.get('/yarn-weft', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(50), search: Joi.string().trim().max(80), dateFrom: ymd, dateTo: ymd, department: Joi.string().trim().max(50) }) }),
  async (req, res) => res.json(await outwards.list(req, 'WEFT', req.validatedQuery)));
router.post('/yarn-weft', full, validate({ body: Joi.object({ ...outFields, lines: outLines.required() }) }), async (req, res) => res.status(201).json(await outwards.create(req, 'WEFT', req.body)));
router.get('/yarn-weft/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.get(req, 'WEFT', req.params.id)));
router.patch('/yarn-weft/:id', full, validate({ params: uuidParam, body: Joi.object({ ...outFields, lines: outLines }).min(1) }), async (req, res) => res.json(await outwards.update(req, 'WEFT', req.params.id, req.body)));
router.delete('/yarn-weft/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.remove(req, 'WEFT', req.params.id)));

// ---- Yarn Outward > Return: yarn given back to its vendor / customer (all of it or some bags); challan + gate pass ----
const retFields = { outwardDate: ymd, description: Joi.string().trim().max(300).allow('', null) };
router.get('/yarn-returns/stock-entries', view, validate({ query: Joi.object({ search: Joi.string().trim().max(80), itemId: id, vendorId: id, customerId: id, type: Joi.string().uppercase().valid('PURCHASE', 'OVERHEAD') }) }),
  async (req, res) => res.json(await outwards.stockEntries(req, req.validatedQuery)));
router.get('/yarn-returns', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(50), search: Joi.string().trim().max(80), dateFrom: ymd, dateTo: ymd, vendorId: id, customerId: id }) }),
  async (req, res) => res.json(await outwards.list(req, 'RETURN', req.validatedQuery)));
router.post('/yarn-returns', full, validate({ body: Joi.object({ ...retFields, vendorId: id, customerId: id, lines: outLines.required() }).xor('vendorId', 'customerId') }), async (req, res) => res.status(201).json(await outwards.create(req, 'RETURN', req.body)));
router.get('/yarn-returns/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.get(req, 'RETURN', req.params.id)));
router.get('/yarn-returns/:id/gate-pass', view, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.gatePass(req, 'RETURN', req.params.id)));
router.patch('/yarn-returns/:id', full, validate({ params: uuidParam, body: Joi.object({ ...retFields, lines: outLines }).min(1) }), async (req, res) => res.json(await outwards.update(req, 'RETURN', req.params.id, req.body)));
router.delete('/yarn-returns/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.remove(req, 'RETURN', req.params.id)));

// ---- Yarn Outward > Sale: purchased yarn sold as it is. A delivery challan + gate pass only: the sales INVOICE is made in the accounts (Sales Invoice), or by "Generate invoice" ----
const accFull = requireService('ACC_SALES', 'FULL'); // generating the invoice makes an accounting document (and the default accounts): the accounting right is needed
const saleLine = Joi.object({ inwardId: id.required(), bags: Joi.number().integer().min(1).max(1000000).required(), ratePerLb: Joi.number().precision(4).positive().max(1000000000).required() });
const saleLines = Joi.array().items(saleLine).min(1).max(200).unique('inwardId');
const saleFields = { outwardDate: ymd, description: Joi.string().trim().max(300).allow('', null) };
router.get('/yarn-sales/options', view, (req, res) => res.json(sales.options())); // before '/:id'
router.get('/yarn-sales/credit/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await sales.creditOf(req, req.params.id)));
// only OUR purchased yarn can be sold: the customers' own (overhead) yarn is not in this list
router.get('/yarn-sales/stock-entries', view, validate({ query: Joi.object({ search: Joi.string().trim().max(80), itemId: id, vendorId: id }) }),
  async (req, res) => res.json(await outwards.stockEntries(req, { ...req.validatedQuery, type: 'PURCHASE' })));
router.get('/yarn-sales', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(50), search: Joi.string().trim().max(80), dateFrom: ymd, dateTo: ymd, customerId: id, invoiced: Joi.boolean() }) }),
  async (req, res) => res.json(await sales.list(req, req.validatedQuery)));
router.post('/yarn-sales', full, validate({ body: Joi.object({ ...saleFields, customerId: id.required(), lines: saleLines.required() }) }), async (req, res) => res.status(201).json(await sales.create(req, req.body)));
router.get('/yarn-sales/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await sales.get(req, req.params.id)));
router.patch('/yarn-sales/:id', full, validate({ params: uuidParam, body: Joi.object({ ...saleFields, lines: saleLines }).min(1) }), async (req, res) => res.json(await sales.update(req, req.params.id, req.body)));
router.delete('/yarn-sales/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await sales.remove(req, req.params.id)));
router.post('/yarn-sales/:id/generate-invoice', accFull, validate({ params: uuidParam, body: Joi.object({ taxRate: Joi.number().precision(2).min(0).max(100), invoiceDate: ymd, dueDate: ymd.allow(null, '') }) }),
  async (req, res) => res.status(201).json(await sales.generateInvoice(req, req.params.id, req.body)));
router.get('/yarn-sales/:id/gate-pass', view, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.gatePass(req, 'SALE', req.params.id)));

// ---- Beam master: add / change / delete the beams (number, name, date) ----
const beamNo = Joi.number().integer().min(1).max(99999999);
const beamName = Joi.string().trim().min(1).max(80);
const beamStatus = Joi.string().uppercase().valid(...BEAM_STATUSES);
const beamWeight = Joi.number().precision(2).positive().max(99999999).allow(null); // kg, null clears it
const beamDepartment = Joi.string().guid({ version: 'uuidv4' }).allow(null); // a department of Masters > Department, null clears it
router.get('/beams/next', view, async (req, res) => res.json(await beams.next(req))); // before '/:id'
router.get('/beams', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(100), search: Joi.string().trim().max(80), isActive: Joi.boolean(), status: beamStatus, departmentId: id, noDepartment: Joi.boolean(), dateFrom: ymd, dateTo: ymd }) }),
  async (req, res) => res.json(await beams.list(req, req.validatedQuery)));
router.post('/beams', full, validate({ body: Joi.object({ beamNo, name: beamName.required(), beamDate: ymd, status: beamStatus, statusDate: ymd, isActive: Joi.boolean(), weightKg: beamWeight, departmentId: beamDepartment }) }), async (req, res) => res.status(201).json(await beams.create(req, req.body)));
router.get('/beams/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await beams.get(req, req.params.id)));
router.patch('/beams/:id', full, validate({ params: uuidParam, body: Joi.object({ beamNo, name: beamName, beamDate: ymd, status: beamStatus, statusDate: ymd, isActive: Joi.boolean(), weightKg: beamWeight, departmentId: beamDepartment }).min(1) }), async (req, res) => res.json(await beams.update(req, req.params.id, req.body)));
router.delete('/beams/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await beams.remove(req, req.params.id)));

// ---- Beam stock: how many beams are empty / full / at loom / at sizing, and which ones ----
router.get('/beam-stock', view, async (req, res) => res.json(await beamStock.summary(req)));
router.get('/beam-stock/:status', view, validate({ params: Joi.object({ status: beamStatus.required() }), query: Joi.object({ search: Joi.string().trim().max(80), departmentId: id, noDepartment: Joi.boolean() }) }),
  async (req, res) => res.json(await beamStock.details(req, req.params.status, req.validatedQuery)));

// ---- Yarn Outward > Sizing: yarn bags AND empty beams to a sizing party (our vendor, we pay for the work), one challan, one gate pass ----
const sizeLine = Joi.object({ inwardId: id.required(), bags: Joi.number().integer().min(1).max(1000000).required() });
const sizeLines = Joi.array().items(sizeLine).max(200).unique('inwardId'); // may be empty when only beams go
const sizeBeams = Joi.array().items(id).max(200).unique();
const sizeFields = { outwardDate: ymd, description: Joi.string().trim().max(300).allow('', null) };
router.get('/yarn-sizing/stock-entries', view, validate({ query: Joi.object({ sizingVendorId: id.required(), search: Joi.string().trim().max(80), itemId: id, vendorId: id, type: Joi.string().uppercase().valid('PURCHASE', 'OVERHEAD') }) }),
  async (req, res) => res.json(await outwards.stockEntries(req, req.validatedQuery))); // before '/:id'
router.get('/yarn-sizing/beams', view, validate({ query: Joi.object({ search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await beamStock.details(req, 'EMPTY', req.validatedQuery))); // the empty beams that can go
router.get('/yarn-sizing', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(50), search: Joi.string().trim().max(80), dateFrom: ymd, dateTo: ymd, vendorId: id }) }),
  async (req, res) => res.json(await outwards.list(req, 'SIZING', req.validatedQuery)));
router.post('/yarn-sizing', full, validate({ body: Joi.object({ ...sizeFields, vendorId: id.required(), lines: sizeLines.default([]), beamIds: sizeBeams.default([]) }) }), async (req, res) => res.status(201).json(await outwards.create(req, 'SIZING', req.body)));
router.get('/yarn-sizing/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.get(req, 'SIZING', req.params.id)));
router.get('/yarn-sizing/:id/gate-pass', view, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.gatePass(req, 'SIZING', req.params.id)));
router.patch('/yarn-sizing/:id', full, validate({ params: uuidParam, body: Joi.object({ ...sizeFields, lines: sizeLines, beamIds: sizeBeams }).min(1) }), async (req, res) => res.json(await outwards.update(req, 'SIZING', req.params.id, req.body)));
router.delete('/yarn-sizing/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await outwards.remove(req, 'SIZING', req.params.id)));

// ---- Sizing Inward: the sized beams come back from the sizing party (meters on every beam, lbs used, cut cone, the sizing charge) ----
const szBeam = Joi.object({ beamId: id.required(), meters: Joi.number().precision(2).positive().max(100000000).required() });
const szBeams = Joi.array().items(szBeam).min(1).max(200).unique('beamId');
const szFields = {
  inwardDate: ymd, dcNo: Joi.string().trim().max(50).allow('', null), description: Joi.string().trim().max(300).allow('', null),
  lbsUsed: Joi.number().precision(2).min(0).max(1000000000), cutConeKg: Joi.number().precision(2).min(0).max(1000000000), ratePerLb: Joi.number().precision(4).min(0).max(1000000000),
};
router.get('/sizing-inwards/challans', view, validate({ query: Joi.object({ vendorId: id, search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await sizingInwards.challans(req, req.validatedQuery))); // before '/:id'
router.get('/sizing-inwards', view, validate({ query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(50), search: Joi.string().trim().max(80), vendorId: id, outwardId: id, dateFrom: ymd, dateTo: ymd }) }),
  async (req, res) => res.json(await sizingInwards.list(req, req.validatedQuery)));
router.post('/sizing-inwards', full, validate({ body: Joi.object({ ...szFields, outwardId: id.required(), lbsUsed: szFields.lbsUsed.required(), ratePerLb: szFields.ratePerLb.required(), beams: szBeams.required() }) }),
  async (req, res) => res.status(201).json(await sizingInwards.create(req, req.body)));
router.get('/sizing-inwards/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await sizingInwards.get(req, req.params.id)));
router.patch('/sizing-inwards/:id', full, validate({ params: uuidParam, body: Joi.object({ ...szFields, beams: szBeams }).min(1) }), async (req, res) => res.json(await sizingInwards.update(req, req.params.id, req.body)));
router.delete('/sizing-inwards/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await sizingInwards.remove(req, req.params.id)));

module.exports = router;
