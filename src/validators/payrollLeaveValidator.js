const { Joi, uuidParam } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
const reason = Joi.string().trim().min(3).max(500);
const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(1000).default(100) };
const year = Joi.number().integer().min(2000).max(2100);

module.exports = {
  list: {
    query: Joi.object({
      ...paging, search: Joi.string().trim().max(100), status: Joi.string().valid('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'),
      departmentId: id, groupId: id, employeeId: id, from: date, to: date,
    }),
  },
  get: { params: uuidParam },
  create: { body: Joi.object({ employeeId: id.required(), applicationDate: date, fromDate: date.required(), toDate: date.required(), reason: reason.required() }) },
  update: { params: uuidParam, body: Joi.object({ applicationDate: date, fromDate: date, toDate: date, reason }).min(1) },
  review: { params: uuidParam, body: Joi.object({ fromDate: date, toDate: date, reason }).min(1) },
  reject: { params: uuidParam, body: Joi.object({ reason: reason.required() }) },
  cancel: { params: uuidParam, body: Joi.object({ reason: reason.required() }) },
  preview: { query: Joi.object({ employeeId: id.required(), fromDate: date.required(), toDate: date.required(), exceptId: id }) },
  balance: { query: Joi.object({ employeeId: id.required(), date }) },
  annualLeaves: {
    query: Joi.object({ ...paging, year, groupId: id, departmentId: id, employeeId: id, search: Joi.string().trim().max(100), closed: Joi.string().valid('false', 'all').default('false') }),
  },
  statement: { params: uuidParam, query: Joi.object({ year }) },
};
