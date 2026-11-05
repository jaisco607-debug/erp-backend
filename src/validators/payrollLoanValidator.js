const { Joi, uuidParam } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
const month = Joi.string().pattern(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/).messages({ 'string.pattern.base': 'month looks like 2026-11' });
const months = Joi.number().strict().integer().min(1).max(12);
const remarks = Joi.string().trim().max(500).allow('', null);
const reason = Joi.string().trim().min(3).max(500);
// an amount: a decimal string ("50000" or "50000.50") or a number with at most 2 decimals
const amount = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,12}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'amount looks like 50000 or 50000.50' }),
  Joi.number().strict().precision(2).min(0).max(999999999999),
);
const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(1000).default(100) };

module.exports = {
  list: {
    query: Joi.object({
      ...paging, search: Joi.string().trim().max(100), status: Joi.string().valid('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'),
      departmentId: id, groupId: id, employeeId: id, from: date, to: date, balanceOnly: Joi.boolean(),
    }),
  },
  get: { params: uuidParam },
  create: { body: Joi.object({ employeeId: id.required(), applicationDate: date, appliedAmount: amount.required(), months: months.required(), deductFrom: month.required(), remarks }) },
  update: { params: uuidParam, body: Joi.object({ applicationDate: date, appliedAmount: amount, months, deductFrom: month, remarks }).min(1) },
  review: { params: uuidParam, body: Joi.object({ approvedAmount: amount, months, deductFrom: month, remarks }).min(1) },
  reject: { params: uuidParam, body: Joi.object({ reason: reason.required() }) },
  attachment: { params: Joi.object({ id: Joi.string().guid({ version: 'uuidv4' }).required(), key: Joi.string().pattern(/^ATT_[0-9a-f]{10}$/).required() }) },
};
