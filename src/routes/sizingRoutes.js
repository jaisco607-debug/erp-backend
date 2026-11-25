// /api/v1/sizing  -  Sizing Management (service SIZING): the Sizing Batch, its yarn tagged, its beam / cut cone receipts (GRN). Company people only.
// Reading: SIZING (VIEW is enough); changing: SIZING with FULL access.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const { Joi, uuidParam, paging } = require('../validators/common');
const batches = require('../services/sizingBatchService');
const contractsSvc = require('../services/yarnContractService');
const loomBeams = require('../services/loomBeamService');
const production = require('../services/weavingProductionService');
const { ymdDate } = require('../utils/dates');
const LIMITS = require('../config/limits');

const router = express.Router();
router.use(authenticate);
const view = requireService('SIZING', 'VIEW');
const full = requireService('SIZING', 'FULL');
const id = Joi.string().guid({ version: 'uuidv4' });
const ymd = ymdDate();
const limit = Joi.number().integer().min(1).max(500).default(50);

const yarnLine = { inwardId: id.required(), lbs: Joi.number().precision(2).positive().max(1000000000).required() };
const batchFields = {
  batchDate: ymd, setNo: Joi.string().trim().min(1).max(40), ends: Joi.number().integer().min(1).max(1000000), yarnCountId: id,
  qualityId: id.allow(null), // the quality of the batch, picked from the Quality master (Weaving > Masters > Quality)
  notes: Joi.string().trim().max(300).allow('', null),
  contractId: id.allow(null), // the overhead contract the batch is tagged to (optional)
  adjustmentLbs: Joi.number().precision(2).min(-batches.ADJ_LIMIT).max(batches.ADJ_LIMIT), // at most 10 lbs either way
  ratePerLb: Joi.number().precision(4).min(0).max(1000000000).allow(null),
  sizingLengthM: Joi.number().precision(2).min(0).max(1000000000).allow(null), // the length the sizing party says it sized (optional; empty = the length received)
};
const beamRow = Joi.object({ beamId: id.required(), lengthM: Joi.number().precision(2).positive().max(LIMITS.qty).required(), weightKg: Joi.number().precision(2).positive().max(100000).allow(null) });
const coneRow = Joi.object({ type: Joi.string().trim().min(1).max(40), kg: Joi.number().precision(2).positive().max(1000000).required(), cones: Joi.number().integer().min(0).max(10000000), bags: Joi.number().integer().min(0).max(10000000) });
const receiptFields = { receiptDate: ymd, refNo: Joi.string().trim().max(50).allow('', null), notes: Joi.string().trim().max(300).allow('', null), beams: Joi.array().max(200).items(beamRow), cutCones: Joi.array().max(50).items(coneRow) };

// ---- Sizing batch ----
router.get('/batches/form-data', view, async (req, res) => res.json(await batches.formData(req))); // the static paths before '/:id'
router.get('/batches', view, validate({ query: Joi.object({ ...paging, limit, search: Joi.string().trim().max(80), status: Joi.string().uppercase().valid('DRAFT', 'CONFIRMED'), vendorId: id, contractId: id, customerId: id, dateFrom: ymd, dateTo: ymd, withoutYarn: Joi.boolean() }) }),
  async (req, res) => res.json(await batches.list(req, req.validatedQuery)));
router.post('/batches', full, validate({ body: Joi.object({ ...batchFields, vendorId: id.required(), setNo: batchFields.setNo.required(), ends: batchFields.ends.required(), yarnCountId: id.required(), yarns: Joi.array().max(100).items(Joi.object(yarnLine)) }) }),
  async (req, res) => res.status(201).json(await batches.create(req, req.body)));
router.get('/batches/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await batches.get(req, req.params.id)));
router.patch('/batches/:id', full, validate({ params: uuidParam, body: Joi.object({ ...batchFields, vendorId: id }).min(1) }), async (req, res) => res.json(await batches.update(req, req.params.id, req.body)));
router.delete('/batches/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await batches.remove(req, req.params.id)));
router.post('/batches/:id/confirm', full, validate({ params: uuidParam }), async (req, res) => res.json(await batches.confirm(req, req.params.id)));
router.post('/batches/:id/reopen', full, validate({ params: uuidParam }), async (req, res) => res.json(await batches.reopen(req, req.params.id)));

// the overhead contracts to tag a batch to
router.get('/overhead-contracts', view, validate({ query: Joi.object({ customerId: id, search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await contractsSvc.overheadList(req, req.validatedQuery)));

// yarn tagged to a batch
router.get('/yarn-available', view, validate({ query: Joi.object({ vendorId: id.required(), batchId: id, contractId: id, search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await batches.yarnAvailable(req, req.validatedQuery)));
router.post('/batches/:id/yarns', full, validate({ params: uuidParam, body: Joi.object(yarnLine) }), async (req, res) => res.status(201).json(await batches.addYarn(req, req.params.id, req.body)));
router.patch('/batches/:id/yarns/:tagId', full, validate({ params: Joi.object({ id: id.required(), tagId: id.required() }), body: Joi.object({ lbs: yarnLine.lbs }) }), async (req, res) => res.json(await batches.updateYarn(req, req.params.id, req.params.tagId, req.body)));
router.delete('/batches/:id/yarns/:tagId', full, validate({ params: Joi.object({ id: id.required(), tagId: id.required() }) }), async (req, res) => res.json(await batches.removeYarn(req, req.params.id, req.params.tagId)));

// beams and cut cones coming back (GRN)
router.get('/pending-beams', view, validate({ query: Joi.object({ vendorId: id.required(), search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await batches.pendingBeams(req, req.validatedQuery)));
router.get('/receipts', view, validate({ query: Joi.object({ ...paging, limit, search: Joi.string().trim().max(80), vendorId: id, batchId: id, dateFrom: ymd, dateTo: ymd }) }), async (req, res) => res.json(await batches.listReceipts(req, req.validatedQuery)));
router.post('/batches/:id/receipts', full, validate({ params: uuidParam, body: Joi.object(receiptFields) }), async (req, res) => res.status(201).json(await batches.createReceipt(req, req.params.id, req.body)));
router.get('/receipts/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await batches.getReceipt(req, req.params.id)));
router.patch('/receipts/:id', full, validate({ params: uuidParam, body: Joi.object(receiptFields).min(1) }), async (req, res) => res.json(await batches.updateReceipt(req, req.params.id, req.body)));
router.delete('/receipts/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await batches.removeReceipt(req, req.params.id)));

// ---- Looms: beams put on a loom (Loom Beam Entry, one K-ID per entry) ----
const loomFields = { factor: Joi.number().valid(1, 2, 3), loomRpm: Joi.number().integer().min(1).max(5000).allow(null), loomPick: Joi.number().integer().min(1).max(1000).allow(null), reedSpace: Joi.number().precision(2).positive().max(9999).allow(null), startDate: ymd };
router.get('/loom-beams/form-data', view, async (req, res) => res.json(await loomBeams.formData(req)));
const pdfs = require('../services/loomStatusPdfService');
const sendPdf = (res, f) => { res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(f.buffer.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${f.fileName}"` }); res.end(f.buffer); };
router.get('/loom-beams/by-quality.pdf', view, validate({ query: Joi.object({ departmentId: id }) }), async (req, res) => sendPdf(res, await pdfs.byQualityPdf(req, req.validatedQuery)));
router.get('/loom-beams/quality-summary.pdf', view, validate({ query: Joi.object({ departmentId: id }) }), async (req, res) => sendPdf(res, await pdfs.qualitySummaryPdf(req, req.validatedQuery)));
router.get('/loom-beams/quality-summary', view, validate({ query: Joi.object({ departmentId: id }) }), async (req, res) => res.json(await loomBeams.qualitySummary(req, req.validatedQuery)));
router.get('/loom-beams/available-beams', view, validate({ query: Joi.object({ search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await loomBeams.availableBeams(req, req.validatedQuery)));
router.get('/loom-beams', view, validate({ query: Joi.object({ ...paging, limit, search: Joi.string().trim().max(80), status: Joi.string().uppercase().valid('ACTIVE', 'CUT_OFF', 'HALF_CUT', 'COMPLETED'), loomId: id, departmentId: id, confirmed: Joi.boolean(), dateFrom: ymd, dateTo: ymd }) }), async (req, res) => res.json(await loomBeams.list(req, req.validatedQuery)));
router.post('/loom-beams', full, validate({ body: Joi.object({ ...loomFields, loomId: id.required(), beamIds: Joi.array().items(id).min(0).max(loomBeams.MAX_BEAMS).default([]) }) }), async (req, res) => res.status(201).json(await loomBeams.create(req, req.body)));
router.get('/loom-beams/:id', view, validate({ params: uuidParam }), async (req, res) => res.json(await loomBeams.get(req, req.params.id)));
router.patch('/loom-beams/:id', full, validate({ params: uuidParam, body: Joi.object(loomFields).min(1) }), async (req, res) => res.json(await loomBeams.update(req, req.params.id, req.body)));
router.delete('/loom-beams/:id', full, validate({ params: uuidParam }), async (req, res) => res.json(await loomBeams.remove(req, req.params.id)));
router.post('/loom-beams/:id/beams', full, validate({ params: uuidParam, body: Joi.object({ beamIds: Joi.array().items(id).min(1).max(loomBeams.MAX_BEAMS).required() }) }), async (req, res) => res.json(await loomBeams.addBeams(req, req.params.id, req.body)));
router.delete('/loom-beams/:id/beams/:beamId', full, validate({ params: Joi.object({ id: id.required(), beamId: id.required() }) }), async (req, res) => res.json(await loomBeams.removeBeam(req, req.params.id, req.params.beamId)));
router.get('/loom-beams/:id/production', view, validate({ params: uuidParam }), async (req, res) => res.json(await production.entryRegister(req, req.params.id)));
router.post('/loom-beams/:id/confirm', full, validate({ params: uuidParam }), async (req, res) => res.json(await loomBeams.confirm(req, req.params.id)));
router.post('/loom-beams/:id/cut-off', full, validate({ params: uuidParam, body: Joi.object({ endDate: ymd }) }), async (req, res) => res.json(await loomBeams.cutOff(req, req.params.id, req.body)));
router.post('/loom-beams/:id/half-cut', full, validate({ params: uuidParam, body: Joi.object({ endDate: ymd, leftM: Joi.number().precision(2).positive().max(LIMITS.qty), beams: Joi.array().items(Joi.object({ beamId: id.required(), leftM: Joi.number().precision(2).positive().max(LIMITS.qty).required() })).max(loomBeams.MAX_BEAMS) }) }), async (req, res) => res.json(await loomBeams.halfCut(req, req.params.id, req.body)));
router.post('/loom-beams/:id/reopen', full, validate({ params: uuidParam }), async (req, res) => res.json(await loomBeams.reopen(req, req.params.id)));

module.exports = router;
