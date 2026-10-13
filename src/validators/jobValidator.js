const { Joi, uuidParam, paging } = require('./common');
const { STATUSES } = require('../models/Job');

const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'date must look like 2026-10-13' });
const text = (max) => Joi.string().trim().max(max).allow('', null);

module.exports = {
  formData: { query: Joi.object({ fromDepartmentId: Joi.string().guid() }) },
  list: {
    query: Joi.object({
      ...paging,
      departmentId: Joi.string().guid(),
      side: Joi.string().valid('in', 'out').default('in'),
      view: Joi.string().valid('job', 'so').default('job'),
      status: Joi.string().uppercase().valid(...STATUSES),
      isReprocess: Joi.boolean(),
      colourId: Joi.string().guid(),
      search: Joi.string().trim().max(20),
      dateFrom: date,
      dateTo: date,
    }),
  },
  get: { params: uuidParam },
  create: {
    body: Joi.object({
      fromDepartmentId: Joi.string().guid().allow(null),
      departmentId: Joi.string().guid().required(),
      jobDate: date,
      colourId: Joi.string().guid().allow(null),
      sentThrough: text(120),
      remarks: text(500),
      items: Joi.array().items(Joi.object({
        soCardLotId: Joi.string().guid(),
        meters: Joi.number().precision(2).positive().max(99999999),
        jobItemId: Joi.string().guid(),
      }).xor('soCardLotId', 'jobItemId')).min(1).max(100).required(),
    }),
  },
  status: { params: uuidParam, body: Joi.object({ status: Joi.string().uppercase().valid(...STATUSES).required() }) },
  update: { params: uuidParam, body: Joi.object({ colourId: Joi.string().guid().allow(null), sentThrough: text(120), remarks: text(500) }).min(1) },
  history: { params: uuidParam },
};
