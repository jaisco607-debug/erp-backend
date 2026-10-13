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
const { companyServices } = require('../services/accessService');
const AppError = require('../utils/AppError');

const router = express.Router();
router.use(authenticate, requireUserType('CLIENT_ADMIN', 'USER'));

/** :code -> the company's department service (404 when the company does not have it). */
async function byCode(req, code) {
  const s = (await companyServices(req.user.companyId)).find((x) => ['PROCESS', 'FOLDING'].includes(x.kind) && x.code === String(code).toUpperCase());
  if (!s) throw AppError.notFound('Department');
  return s;
}

const listQuery = v.list.query.fork(['departmentId', 'side'], (k) => k.forbidden());

router.get('/', async (req, res) => {
  const list = (await companyServices(req.user.companyId)).filter((s) => ['PROCESS', 'FOLDING'].includes(s.kind));
  res.json(list.map((s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, tracksColour: s.tracksColour })));
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

router.get('/:code/send-form', async (req, res) => {
  const d = await byCode(req, req.params.code);
  res.json(await jobService.formData(req, { fromDepartmentId: d.id }));
});

const sendBody = Joi.object({
  toDepartmentCode: Joi.string().trim().max(50).required(),
  colourId: Joi.string().guid().allow(null),
  jobDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  sentThrough: Joi.string().trim().max(120).allow('', null),
  remarks: Joi.string().trim().max(500).allow('', null),
  items: Joi.array().items(Joi.object({ jobItemId: Joi.string().guid().required() })).min(1).max(100).required(),
});
router.post('/:code/send', validate({ body: sendBody }), async (req, res) => {
  const from = await byCode(req, req.params.code);
  const to = await byCode(req, req.body.toDepartmentCode);
  const { toDepartmentCode, ...rest } = req.body;
  res.status(201).json(await jobService.create(req, { ...rest, fromDepartmentId: from.id, departmentId: to.id }));
});

module.exports = router;
