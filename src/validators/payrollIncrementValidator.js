const { Joi, uuidParam } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
const month = Joi.string().pattern(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/).messages({ 'string.pattern.base': 'month looks like 2026-10' });
const STATUSES = ['DRAFT', 'REVIEW', 'FINAL_REVIEW', 'APPROVED'];
const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(2000).default(200) };
// a figure: a decimal string or a number with at most 2 decimals, never negative
const amount = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,10}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'an amount looks like 75000 or 75000.50' }),
  Joi.number().strict().precision(2).min(0).max(9999999999),
);
const filters = { status: Joi.string().valid(...STATUSES), search: Joi.string().trim().max(100), groupId: id, month };

module.exports = {
  list: { query: Joi.object({ ...paging, ...filters }) },
  csv: { query: Joi.object(filters) },
  employees: { query: Joi.object({ ...paging, groupId: id, search: Joi.string().trim().max(100) }) },
  create: { body: Joi.object({ employeeIds: Joi.array().items(id).min(1).max(500).required(), applicationDate: date }) },
  get: { params: uuidParam },
  update: {
    params: uuidParam,
    body: Joi.object({
      salary: amount, food: amount, mobile: amount, maintenance: amount,
      salaryIncrease: amount, foodIncrease: amount, mobileIncrease: amount, maintenanceIncrease: amount,
      remarks: Joi.string().trim().max(300).allow('', null), applicationDate: date, effectiveMonth: month.allow(null, ''),
    }).min(1),
  },
  reject: { params: uuidParam, body: Joi.object({ reason: Joi.string().trim().min(1).max(300).required() }) },
  bulk: { body: Joi.object({ ids: Joi.array().items(id).min(1).max(500).required(), reason: Joi.string().trim().max(300) }) },
  bulkReject: { body: Joi.object({ ids: Joi.array().items(id).min(1).max(500).required(), reason: Joi.string().trim().min(1).max(300).required() }) },
  import: { body: Joi.object({ rows: Joi.array().items(Joi.object().unknown(true)).min(1).max(5000).required(), dryRun: Joi.boolean(), applicationDate: date }) },
};
