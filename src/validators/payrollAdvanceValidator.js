const { Joi, uuidParam } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
const remarks = Joi.string().trim().max(300).allow('', null);
// an amount: a decimal string ("5000" or "5000.50") or a number with at most 2 decimals, more than 0
const amount = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,12}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'amount looks like 5000 or 5000.50' }),
  Joi.number().strict().precision(2).positive().max(999999999999),
);
const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(1000).default(100) };

module.exports = {
  list: {
    query: Joi.object({
      ...paging, search: Joi.string().trim().max(100), status: Joi.string().valid('WAITING_VOUCHER', 'PAID', 'RECOVERED'), employeeId: id, departmentId: id, groupId: id, from: date, to: date,
    }),
  },
  get: { params: uuidParam },
  employee: { params: uuidParam },
  create: { body: Joi.object({ employeeId: id.required(), amount: amount.required(), advanceDate: date, remarks }) },
  update: { params: uuidParam, body: Joi.object({ amount, advanceDate: date, remarks }).min(1) },
};
