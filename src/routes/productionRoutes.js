// /api/v1/production  -  Weaving Production Control (service WEAVING_PRODUCTION): the production register of each Weaving department:
// the weavers of the day and their looms, the units per loom and shift, the 15 day periods, CSV uploads. Company people only.
// Reading: WEAVING_PRODUCTION (VIEW is enough); changing: WEAVING_PRODUCTION with FULL access.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const { Joi, uuidParam } = require('../validators/common');
const svc = require('../services/weavingProductionService');
const billing = require('../services/weavingBillingService');
const efficiency = require('../services/weavingEfficiencyService');
const billSvc = require('../services/weavingBillService');
const { ymdDate } = require('../utils/dates');
const { REFS: R } = require('../config/limits');

const router = express.Router();
router.use(authenticate);
const view = requireService('WEAVING_PRODUCTION', 'VIEW');
const full = requireService('WEAVING_PRODUCTION', 'FULL');
const id = Joi.string().guid({ version: 'uuidv4' });
const ymd = ymdDate();
const shift = Joi.string().uppercase().valid(...svc.SHIFTS);
const dept = { departmentId: id.required() };
const sendCsv = (res, f) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${f.fileName}"` }); res.send(f.text); };
const upload = { departmentId: id.required(), date: ymd, csv: Joi.string().max(900000), rows: Joi.array().items(Joi.object().unknown(true)).max(5000) };
const uploadSchema = Joi.object(upload).xor('csv', 'rows');

router.get('/form-data', view, async (req, res) => res.json(await svc.formData(req)));

// ---- periods (15 days) and the day register ----
router.get('/periods', view, validate({ query: Joi.object({ ...dept, limit: Joi.number().integer().min(1).max(120).default(36) }) }), async (req, res) => res.json(await svc.periods(req, req.validatedQuery)));
router.get('/period', view, validate({ query: Joi.object({ ...dept, from: ymd.required() }) }), async (req, res) => res.json(await svc.period(req, req.validatedQuery)));
router.get('/day', view, validate({ query: Joi.object({ ...dept, date: ymd.required() }) }), async (req, res) => res.json(await svc.day(req, req.validatedQuery)));
router.get('/day/check', view, validate({ query: Joi.object({ ...dept, date: ymd.required() }) }), async (req, res) => res.json(await svc.check(req, req.validatedQuery)));
router.get('/day/csv', view, validate({ query: Joi.object({ ...dept, date: ymd.required() }) }), async (req, res) => sendCsv(res, await svc.dayCsv(req, req.validatedQuery)));
router.put('/day', full, validate({ body: Joi.object({ ...dept, date: ymd.required(), rows: Joi.array().items(Joi.object({ loomId: id.required(), shift: shift.required(), units: Joi.number().precision(2).min(0).max(R.unitsPerShift).allow(null) })).min(1).max(1000).required() }) }), async (req, res) => res.json(await svc.saveDay(req, req.body)));
router.post('/day/clear', full, validate({ body: Joi.object({ ...dept, date: ymd.required(), loomIds: Joi.array().items(id).min(1).max(500).required(), shift }) }), async (req, res) => res.json(await svc.clearDay(req, req.body)));
router.get('/units/sample.csv', view, async (req, res) => sendCsv(res, svc.sampleUnits()));
router.post('/units/import', full, validate({ body: uploadSchema }), async (req, res) => {
  const { departmentId, ...input } = req.body;
  res.json(await svc.importUnits(req, { departmentId, input }));
});

// ---- weaver wise & attendance billing (a 15 day period), the loom policy ----
const sendFile = (res, f, type) => { res.set({ 'Content-Type': type, 'Content-Length': String(f.buffer.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${f.fileName}"` }); res.end(f.buffer); };
const periodQ = Joi.object({ ...dept, from: ymd.required() });
router.get('/billing/weavers', view, validate({ query: periodQ }), async (req, res) => res.json(await billing.sheet(req, req.validatedQuery)));
router.get('/billing/weavers.pdf', view, validate({ query: periodQ }), async (req, res) => sendFile(res, await billing.pdf(req, req.validatedQuery), 'application/pdf'));
router.get('/billing/weavers.xlsx', view, validate({ query: periodQ }), async (req, res) => sendFile(res, await billing.xlsx(req, req.validatedQuery), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
router.get('/billing/weavers/:employeeId', view, validate({ params: Joi.object({ employeeId: id.required() }), query: periodQ }), async (req, res) => res.json(await billing.attendance(req, { ...req.validatedQuery, employeeId: req.params.employeeId })));
// ---- production bill / wages ----
router.get('/bill', view, validate({ query: periodQ }), async (req, res) => res.json(await billSvc.bill(req, req.validatedQuery)));
router.get('/bill.pdf', view, validate({ query: periodQ }), async (req, res) => sendFile(res, await billSvc.pdf(req, req.validatedQuery), 'application/pdf'));
router.get('/bill.xlsx', view, validate({ query: periodQ }), async (req, res) => sendFile(res, await billSvc.xlsx(req, req.validatedQuery), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
router.get('/bill/stoppage', view, validate({ query: periodQ }), async (req, res) => res.json(await billSvc.stoppageDetail(req, req.validatedQuery)));
router.get('/bill/stoppage.xlsx', view, validate({ query: periodQ }), async (req, res) => sendFile(res, await billSvc.stoppageXlsx(req, req.validatedQuery), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));

// ---- depart wise & efficiency report ----
router.get('/efficiency', view, validate({ query: periodQ }), async (req, res) => res.json(await efficiency.report(req, req.validatedQuery)));
router.get('/efficiency.pdf', view, validate({ query: periodQ }), async (req, res) => sendFile(res, await efficiency.pdf(req, req.validatedQuery), 'application/pdf'));
router.get('/efficiency.xlsx', view, validate({ query: periodQ }), async (req, res) => sendFile(res, await efficiency.xlsx(req, req.validatedQuery), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
router.get('/efficiency/basis', view, validate({ query: Joi.object({ ...dept }) }), async (req, res) => res.json(await efficiency.getBasis(req, req.validatedQuery)));
router.put('/efficiency/basis', full, validate({ body: Joi.object({ ...dept, blocks: Joi.array().max(30).items(Joi.object({ from: Joi.number().integer().min(0).max(1000000).required(), to: Joi.number().integer().min(0).max(1000000).required() })), minRunUnits: Joi.number().precision(2).min(0).max(99999), defaultRpm: Joi.number().integer().min(1).max(5000) }) }), async (req, res) => res.json(await efficiency.setBasis(req, req.body)));
router.get('/policy', view, validate({ query: Joi.object({ ...dept }) }), async (req, res) => res.json(await billing.getPolicy(req, req.validatedQuery)));
router.put('/policy', full, validate({ body: Joi.object({ ...dept, ranges: Joi.array().max(20).items(Joi.object({ from: Joi.number().integer().min(0).max(1000000).required(), to: Joi.number().integer().min(0).max(1000000).required(), loomsPerWeaver: Joi.number().integer().min(1).max(50).required() })), otherLooms: Joi.number().integer().min(1).max(50), stopBelowUnits: Joi.number().precision(2).min(0).max(99999), ratePerDay: Joi.number().precision(4).min(0).max(1000000).allow(null), rates: Joi.object().pattern(Joi.string().max(20), Joi.number().precision(4).min(0).max(1000000).allow(null)), ratesFrom: ymd }) }), async (req, res) => res.json(await billing.setPolicy(req, req.body)));

// ---- the weavers (attendance of the looms) ----
router.get('/weavers', view, validate({ query: Joi.object({ ...dept, date: ymd.required() }) }), async (req, res) => res.json(await svc.weavers(req, req.validatedQuery)));
router.get('/weavers/employees', view, validate({ query: Joi.object({ ...dept, date: ymd.required(), search: Joi.string().trim().max(80) }) }), async (req, res) => res.json(await svc.employees(req, req.validatedQuery)));
router.get('/weavers/sample.csv', view, async (req, res) => sendCsv(res, svc.sampleWeavers()));
router.post('/weavers', full, validate({ body: Joi.object({ ...dept, date: ymd.required(), shift: shift.required(), employeeIds: Joi.array().items(id).min(1).max(200).required() }) }), async (req, res) => res.status(201).json(await svc.addWeavers(req, req.body)));
router.post('/weavers/copy', full, validate({ body: Joi.object({ ...dept, fromDate: ymd.required(), toDate: ymd.required() }) }), async (req, res) => res.json(await svc.copyWeavers(req, req.body)));
router.post('/weavers/import', full, validate({ body: uploadSchema }), async (req, res) => {
  const { departmentId, ...input } = req.body;
  res.json(await svc.importWeavers(req, { departmentId, input }));
});
router.post('/weavers/remove', full, validate({ body: Joi.object({ ids: Joi.array().items(id).min(1).max(500).required() }) }), async (req, res) => res.json(await svc.removeWeavers(req, req.body)));
router.put('/weavers/:id/looms', full, validate({ params: uuidParam, body: Joi.object({ loomIds: Joi.array().items(id).max(200).required(), move: Joi.boolean().default(false) }) }), async (req, res) => res.json(await svc.setLooms(req, req.params.id, req.body)));

module.exports = router;
