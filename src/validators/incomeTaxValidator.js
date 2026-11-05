const { Joi, uuidParam } = require('./common');

const id = Joi.string().guid();
const month = Joi.string().pattern(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/).messages({ 'string.pattern.base': 'month looks like 2026-10' });
const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(2000).default(200) };
// a monthly amount: a decimal string or a number with at most 2 decimals (0 = no tax)
const amount = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,10}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'the tax looks like 12500 or 12500.50' }),
  Joi.number().strict().precision(2).min(0).max(9999999999),
);
const percent = Joi.number().strict().precision(2).min(0).max(100);

module.exports = {
  list: { query: Joi.object({ ...paging, month: month.required(), search: Joi.string().trim().max(100), groupId: id, departmentId: id, source: Joi.string().valid('AMOUNT', 'PERCENT', 'CARD', 'NONE') }) },
  employee: { params: uuidParam },
  set: { params: uuidParam, body: Joi.object({ effectiveFrom: month, monthlyAmount: amount.allow(null), percent: percent.allow(null) }).or('monthlyAmount', 'percent') },
  removeRow: { params: uuidParam },
  import: { body: Joi.object({ effectiveFrom: month, rows: Joi.array().items(Joi.object().unknown(true)).min(1).max(5000).required(), dryRun: Joi.boolean() }) },
  report: { query: Joi.object({ ...paging, month: month.required(), groupId: id, search: Joi.string().trim().max(100) }) },
};
