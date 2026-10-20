// /api/v1/departments  -  the same job APIs as /v1/jobs, but addressed by department code
// (DYEING, PRINTING, SINGEING ...) so each department screen has its own simple URLs.
// Access is checked in jobService exactly as for /v1/jobs.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const { Joi } = require('../validators/common');
const v = require('../validators/jobValidator');
const jobService = require('../services/jobService');
const foldingService = require('../services/foldingService');
const packingService = require('../services/packingService');
const { paging } = require('../validators/common');
const { companyServices } = require('../services/accessService');
const AppError = require('../utils/AppError');
const deptChem = require('../services/departmentChemicalService');

const router = express.Router();
router.use(authenticate, requireUserType('CLIENT_ADMIN', 'USER'));

/** :code -> the company's department service (404 when the company does not have it). */
async function byCode(req, code) {
  const s = (await companyServices(req.user.companyId)).find((x) => ['PROCESS', 'FOLDING', 'PACKING'].includes(x.kind) && x.code === String(code).toUpperCase());
  if (!s) throw AppError.notFound('Department');
  return s;
}

const listQuery = v.list.query.fork(['departmentId', 'side'], (k) => k.forbidden());

router.get('/', async (req, res) => {
  const list = (await companyServices(req.user.companyId)).filter((s) => ['PROCESS', 'FOLDING', 'PACKING'].includes(s.kind));
  res.json(list.map((s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, tracksColour: s.tracksColour })));
});

// only the chemicals the Chemical Store gave this department
router.get('/:code/chemicals', validate({ query: Joi.object({ search: Joi.string().trim().max(100), categoryId: Joi.string().guid() }) }), async (req, res) => {
  res.json(await deptChem.mine(req, req.params.code, req.validatedQuery));
});

router.get('/:code/incoming', validate({ query: listQuery }), async (req, res) => {
  const d = await byCode(req, req.params.code);
  res.json(await jobService.list(req, { ...req.validatedQuery, departmentId: d.id, side: 'in' }));
});

router.get('/:code/sent', validate({ query: listQuery }), async (req, res) => {
  const d = await byCode(req, req.params.code);
  res.json(await jobService.list(req, { ...req.validatedQuery, departmentId: d.id, side: 'out' }));
});

router.get('/:code/rejected', validate({ query: listQuery }), async (req, res) => {
  const d = await byCode(req, req.params.code);
  res.json(await jobService.list(req, { ...req.validatedQuery, departmentId: d.id, side: 'out', status: 'REJECTED' }));
});

router.get('/:code/send-form', validate({ query: Joi.object({ jobId: Joi.string().guid(), soCardId: Joi.string().guid() }) }), async (req, res) => {
  const d = await byCode(req, req.params.code);
  res.json(await jobService.formData(req, { fromDepartmentId: d.id, ...req.validatedQuery }));
});

const sendBody = Joi.object({
  toDepartmentCode: Joi.string().trim().max(50).required(),
  colourId: Joi.string().guid().allow(null),
  jobDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  sentThrough: Joi.string().trim().max(120).allow('', null),
  remarks: Joi.string().trim().max(500).allow('', null),
  instructions: Joi.string().trim().max(1000).allow('', null),
  items: Joi.array().items(Joi.object({ jobItemId: Joi.string().guid().required() })).min(1).max(100).required(),
});
router.post('/:code/send', validate({ body: sendBody }), async (req, res) => {
  const from = await byCode(req, req.params.code);
  const to = await byCode(req, req.body.toDepartmentCode);
  const { toDepartmentCode, ...rest } = req.body;
  res.status(201).json(await jobService.create(req, { ...rest, fromDepartmentId: from.id, departmentId: to.id }));
});

// ---- Status of a job that came to this department (dropdown), and Reject ----
const jobKey = Joi.object({ code: Joi.string().max(50).required(), jobId: Joi.string().guid().required() });
async function ownJob(req) {
  const d = await byCode(req, req.params.code);
  const job = await jobService.get(req, req.params.jobId);
  if (job.department.id !== d.id) throw AppError.rule('JOB_WRONG_DEPARTMENT', `This job was sent to ${job.department.name}, not to ${d.name}`);
}
router.get('/:code/jobs/:jobId', validate({ params: jobKey }), async (req, res) => {
  await byCode(req, req.params.code);
  res.json(await jobService.get(req, req.params.jobId));
});
router.put('/:code/jobs/:jobId/status', validate({
  params: jobKey,
  body: Joi.object({ status: Joi.string().uppercase().valid('QUEUE', 'PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED').required(), reason: Joi.string().trim().max(300).allow('', null) }),
}), async (req, res) => {
  await ownJob(req);
  res.json(await jobService.setStatus(req, req.params.jobId, req.body.status, req.body.reason));
});
// In-Way -> Receive -> Queue -> Accept -> Pending
router.post('/:code/jobs/:jobId/receive', validate({ params: jobKey }), async (req, res) => {
  await ownJob(req);
  res.json(await jobService.setStatus(req, req.params.jobId, 'QUEUE'));
});
router.post('/:code/jobs/:jobId/accept', validate({ params: jobKey }), async (req, res) => {
  await ownJob(req);
  res.json(await jobService.setStatus(req, req.params.jobId, 'PENDING'));
});
// colour (Dyeing): whole job, or one SO card of it
router.put('/:code/jobs/:jobId/colour', validate({
  params: jobKey,
  body: Joi.object({ colourId: Joi.string().guid().allow(null).required(), soCardId: Joi.string().guid() }),
}), async (req, res) => {
  await ownJob(req);
  res.json(await jobService.setColour(req, req.params.jobId, req.body));
});
router.put('/:code/jobs/:jobId/operator', validate({
  params: jobKey,
  body: Joi.object({ operatorName: Joi.string().trim().max(80).allow('', null), processDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null) }).min(1),
}), async (req, res) => {
  await ownJob(req);
  res.json(await jobService.setOperator(req, req.params.jobId, req.body));
});
router.post('/:code/jobs/:jobId/reject', validate({
  params: jobKey,
  body: Joi.object({ reason: Joi.string().trim().max(300).allow('', null), remarks: Joi.string().trim().max(300).allow('', null) }),
}), async (req, res) => {
  await ownJob(req);
  res.json(await jobService.setStatus(req, req.params.jobId, 'REJECTED', req.body.reason || req.body.remarks));
});

// the sender answers a rejection: ACCEPT (valid) or DISPUTE (not valid, with reason)
router.post('/:code/jobs/:jobId/reject-answer', validate({
  params: jobKey,
  body: Joi.object({ decision: Joi.string().valid('ACCEPT', 'DISPUTE').required(), reason: Joi.string().trim().max(300).allow('', null) }),
}), async (req, res) => {
  const d = await byCode(req, req.params.code);
  const job = await jobService.get(req, req.params.jobId);
  if (!job.fromDepartment || job.fromDepartment.id !== d.id) throw AppError.rule('JOB_WRONG_DEPARTMENT', `This job was not sent by ${d.name}`);
  res.json(await jobService.answerReject(req, req.params.jobId, req.body));
});

// ---- Folding department (kind FOLDING) ----
const foldingKey = { code: Joi.string().max(50).required(), jobId: Joi.string().guid().required(), soCardId: Joi.string().guid().required() };
const ymd = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
router.get('/:code/folding', validate({
  query: Joi.object({ ...paging, tab: Joi.string().valid('all', 'open', 'draft').default('all'), search: Joi.string().trim().max(20), dateFrom: ymd, dateTo: ymd }),
}), async (req, res) => res.json(await foldingService.list(req, req.params.code, req.validatedQuery)));

const meters = Joi.number().precision(2).min(0).max(99999999);
router.get('/:code/folding/:jobId/:soCardId', validate({ params: Joi.object(foldingKey) }),
  async (req, res) => res.json(await foldingService.get(req, req.params.code, req.params.jobId, req.params.soCardId)));
// page no only
router.put('/:code/folding/:jobId/:soCardId', validate({
  params: Joi.object(foldingKey),
  body: Joi.object({ pageNo: Joi.string().trim().max(30).allow('', null).required() }),
}), async (req, res) => res.json(await foldingService.save(req, req.params.code, req.params.jobId, req.params.soCardId, req.body)));
// split thaans into A / B / CP
router.put('/:code/folding/:jobId/:soCardId/grades', validate({
  params: Joi.object(foldingKey),
  body: Joi.object({
    pageNo: Joi.string().trim().max(30).allow('', null),
    lines: Joi.array().min(1).max(1000).items(Joi.object({
      greyLotId: Joi.string().guid().required(), thaanId: Joi.string().guid().allow(null), a: meters, b: meters, cp: meters,
    })).required(),
  }),
}), async (req, res) => res.json(await foldingService.saveGrades(req, req.params.code, req.params.jobId, req.params.soCardId, req.body)));
router.post('/:code/folding/:jobId/:soCardId/send-packing', validate({
  params: Joi.object(foldingKey),
  body: Joi.object({
    keepRemaining: Joi.boolean().default(true), closeNote: Joi.string().trim().max(300).allow('', null),
    sentThrough: Joi.string().trim().max(120).allow('', null), remarks: Joi.string().trim().max(500).allow('', null), jobDate: ymd,
  }),
}), async (req, res) => res.status(201).json(await foldingService.sendToPacking(req, req.params.code, req.params.jobId, req.params.soCardId, req.body)));
router.put('/:code/folding/:jobId/:soCardId/close', validate({
  params: Joi.object(foldingKey),
  body: Joi.object({ isClosed: Joi.boolean().required(), closeNote: Joi.string().trim().max(300).allow('', null) }),
}), async (req, res) => res.json(await foldingService.setClosed(req, req.params.code, req.params.jobId, req.params.soCardId, req.body)));
router.put('/:code/folding/:jobId/:soCardId/confirm', validate({
  params: Joi.object(foldingKey),
  body: Joi.object({ isConfirmed: Joi.boolean().required() }),
}), async (req, res) => res.json(await foldingService.setConfirmed(req, req.params.code, req.params.jobId, req.params.soCardId, req.body.isConfirmed)));

// ---- Chemical requests to the Chemical Store (Step 8) ----
const chem = require('../services/chemicalRequestService');
const reqKey = Joi.object({ code: Joi.string().max(50).required(), id: Joi.string().guid().required() });
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const chemLine = Joi.object({
  itemId: Joi.string().guid().required(),
  qty: Joi.number().precision(3).positive().max(999999),
  qtyMain: Joi.number().integer().min(0).max(999999),
  qtySub: Joi.number().integer().min(0).max(99999),
});
const reqBody = {
  jobId: Joi.string().guid(),
  soCardId: Joi.string().guid().allow(null, ''),
  notes: Joi.string().trim().max(500).allow('', null),
  lines: Joi.array().items(chemLine).min(1).max(100),
};
const reqList = Joi.object({
  ...paging, tab: Joi.string().valid('all', 'pending', 'accepted', 'in_way', 'received', 'closed').default('all'),
  reqNo: Joi.number().integer().min(1), jobNo: Joi.number().integer().min(1), soNo: Joi.number().integer().min(1), dateFrom: date, dateTo: date,
});
router.get('/:code/chemical-requests/form-data', async (req, res) => res.json(await chem.formData(req, req.params.code)));
router.get('/:code/chemical-requests', validate({ query: reqList }), async (req, res) => res.json(await chem.deptList(req, req.params.code, req.validatedQuery)));
router.post('/:code/chemical-requests', validate({ body: Joi.object({ ...reqBody, jobId: reqBody.jobId.required(), lines: reqBody.lines.required() }) }),
  async (req, res) => res.status(201).json(await chem.create(req, req.params.code, req.body)));
router.get('/:code/chemical-requests/:id', validate({ params: reqKey }), async (req, res) => res.json(await chem.deptGet(req, req.params.code, req.params.id)));
router.patch('/:code/chemical-requests/:id', validate({ params: reqKey, body: Joi.object(reqBody).min(1) }), async (req, res) => res.json(await chem.update(req, req.params.code, req.params.id, req.body)));
router.post('/:code/chemical-requests/:id/cancel', validate({ params: reqKey }), async (req, res) => res.json(await chem.cancel(req, req.params.code, req.params.id)));
router.post('/:code/chemical-requests/:id/receive', validate({ params: reqKey }), async (req, res) => res.json(await chem.receive(req, req.params.code, req.params.id)));
// the store offered an alternate chemical: yes / no
router.post('/:code/chemical-requests/:id/lines/:lineId/alternate', validate({
  params: Joi.object({ code: Joi.string().max(50).required(), id: Joi.string().guid().required(), lineId: Joi.string().guid().required() }),
  body: Joi.object({ accept: Joi.boolean().required() }),
}), async (req, res) => res.json(await chem.answerAlternate(req, req.params.code, req.params.id, req.params.lineId, req.body)));
// unused chemical sent back to the store
const ret = require('../services/chemicalReturnService');
router.get('/:code/chemical-returns', validate({ query: Joi.object({ ...paging, tab: Joi.string().valid('all', 'pending', 'received', 'closed').default('all'), requestId: Joi.string().guid() }) }),
  async (req, res) => res.json(await ret.deptList(req, req.params.code, req.validatedQuery)));
router.post('/:code/chemical-returns', validate({ body: Joi.object({
  requestId: Joi.string().guid().required(),
  notes: Joi.string().trim().max(500).allow('', null),
  lines: Joi.array().items(Joi.object({
    requestLineId: Joi.string().guid().required(),
    qty: Joi.number().precision(3).positive().max(999999),
    qtyMain: Joi.number().integer().min(0).max(999999),
    qtySub: Joi.number().integer().min(0).max(99999),
  })).min(1).max(100).required(),
}) }), async (req, res) => res.status(201).json(await ret.create(req, req.params.code, req.body)));
router.get('/:code/chemical-returns/:id', validate({ params: reqKey }), async (req, res) => res.json(await ret.deptGet(req, req.params.code, req.params.id)));
router.post('/:code/chemical-returns/:id/cancel', validate({ params: reqKey }), async (req, res) => res.json(await ret.cancel(req, req.params.code, req.params.id)));

// chemical cost reports of this department (only its own jobs)
const costQuery = Joi.object({ ...paging, dateFrom: date, dateTo: date, customerId: Joi.string().guid() });
router.get('/:code/chemical-cost/jobs', validate({ query: costQuery }), async (req, res) => {
  const d = await chem.needDept(req, req.params.code, 'VIEW');
  res.json(await chem.costReport(req, { ...req.validatedQuery, departmentId: d.id, by: 'job' }));
});
router.get('/:code/chemical-cost/so-cards', validate({ query: costQuery }), async (req, res) => {
  const d = await chem.needDept(req, req.params.code, 'VIEW');
  res.json(await chem.costReport(req, { ...req.validatedQuery, departmentId: d.id, by: 'so-card' }));
});
router.get('/:code/so-cards/:soCardId/chemical-cost', validate({ params: Joi.object({ code: Joi.string().max(50).required(), soCardId: Joi.string().guid().required() }) }), async (req, res) => {
  const d = await chem.needDept(req, req.params.code, 'VIEW');
  res.json(await chem.soCardCost(req, req.params.soCardId, d.id));
});
// chemical cost of one of this department's jobs
router.get('/:code/jobs/:jobId/chemical-cost', validate({ params: jobKey }), async (req, res) => {
  await chem.needDept(req, req.params.code, 'VIEW');
  await ownJob(req);
  res.json(await chem.jobCost(req, req.params.jobId));
});

// ---- Packing department (kind PACKING): packing lists per SO card ----
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const money = Joi.number().precision(2).min(0).max(9999999);
const packingHead = {
  listDate: day, description: Joi.string().trim().max(300).allow('', null), madeFor: Joi.string().trim().max(120).allow('', null),
  ctnQty: Joi.number().integer().min(0).max(9999999).allow(null), netWeight: money.allow(null), grossWeight: money.allow(null),
  remarks: Joi.string().trim().max(500).allow('', null), rateA: money, rateB: money, rateCP: money,
};
const packingLines = Joi.array().min(1).max(2000).items(Joi.object({
  greyLotId: Joi.string().guid().required(), thaanId: Joi.string().guid().allow(null),
  thaanNo: Joi.number().integer().min(1).max(99999), grade: Joi.string().valid('A', 'B', 'CP').required(),
  meters: Joi.number().precision(2).greater(0).max(99999999).required(),
}));
const listKey = Joi.object({ code: Joi.string().max(50).required(), id: Joi.string().guid().required() });
router.get('/:code/packing/so-cards', validate({ query: Joi.object({ ...paging, tab: Joi.string().valid('open', 'all').default('open'), search: Joi.string().trim().max(20) }) }),
  async (req, res) => res.json(await packingService.soCards(req, req.params.code, req.validatedQuery)));
router.get('/:code/packing/so-cards/:soCardId/form', validate({ params: Joi.object({ code: Joi.string().max(50).required(), soCardId: Joi.string().guid().required() }), query: Joi.object({ exceptListId: Joi.string().guid() }) }),
  async (req, res) => res.json(await packingService.form(req, req.params.code, req.params.soCardId, req.validatedQuery.exceptListId)));
router.get('/:code/packing-lists', validate({ query: Joi.object({ ...paging, soCardId: Joi.string().guid(), status: Joi.string().valid('DRAFT', 'FINAL'), search: Joi.string().trim().max(20), dateFrom: day, dateTo: day }) }),
  async (req, res) => res.json(await packingService.list(req, req.params.code, req.validatedQuery)));
router.post('/:code/packing-lists', validate({ body: Joi.object({ soCardId: Joi.string().guid().required(), ...packingHead, lines: packingLines.required() }) }),
  async (req, res) => res.status(201).json(await packingService.create(req, req.params.code, req.body)));
router.get('/:code/packing-lists/:id', validate({ params: listKey }), async (req, res) => res.json(await packingService.get(req, req.params.code, req.params.id)));
router.put('/:code/packing-lists/:id', validate({ params: listKey, body: Joi.object({ ...packingHead, lines: packingLines }).min(1) }),
  async (req, res) => res.json(await packingService.update(req, req.params.code, req.params.id, req.body)));
router.post('/:code/packing-lists/:id/final', validate({ params: listKey }), async (req, res) => res.json(await packingService.setFinal(req, req.params.code, req.params.id, true)));
router.post('/:code/packing-lists/:id/reopen', validate({ params: listKey }), async (req, res) => res.json(await packingService.setFinal(req, req.params.code, req.params.id, false)));
// gate pass of a packing list (owner 2026-10-19)
router.get('/:code/gate-passes', validate({ query: Joi.object({ ...paging, search: Joi.string().trim().max(40), dateFrom: day, dateTo: day }) }),
  async (req, res) => res.json(await packingService.listGatePasses(req, req.params.code, req.validatedQuery)));
router.get('/:code/packing-lists/:id/gate-pass', validate({ params: listKey }), async (req, res) => res.json(await packingService.gatePassOf(req, req.params.code, req.params.id)));
router.put('/:code/packing-lists/:id/gate-pass', validate({ params: listKey, body: Joi.object({
  passDate: day, operatorName: Joi.string().trim().max(120).allow('', null), driverName: Joi.string().trim().max(120).allow('', null),
  vehicleNo: Joi.string().trim().max(40).allow('', null), destination: Joi.string().trim().max(200).allow('', null), remarks: Joi.string().trim().max(300).allow('', null),
}) }), async (req, res) => res.json(await packingService.saveGatePass(req, req.params.code, req.params.id, req.body)));
router.delete('/:code/packing-lists/:id', validate({ params: listKey }), async (req, res) => res.json(await packingService.remove(req, req.params.code, req.params.id)));

module.exports = router;
