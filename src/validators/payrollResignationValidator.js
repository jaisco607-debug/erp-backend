const { Joi, uuidParam } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
// the last day of a month filter: not before the first day
const dateTo = date.custom((v, h) => { const from = h.state.ancestors[0].from; return from && v < from ? h.error('date.order') : v; }).messages({ 'date.order': 'to must not be before from' });
const reason = Joi.string().trim().min(3).max(500);
const refNo = Joi.string().trim().max(40).allow('', null);
const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(1000).default(100) };

module.exports = {
  list: {
    query: Joi.object({
      ...paging, search: Joi.string().trim().max(100), status: Joi.string().valid('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'),
      departmentId: id, groupId: id, employeeId: id, from: date, to: dateTo,
    }),
  },
  absentees: { query: Joi.object({ ...paging, days: Joi.number().integer().min(1).max(365).default(10), groupId: id, departmentId: id }) },
  get: { params: uuidParam },
  create: { body: Joi.object({ employeeId: id.required(), applicationDate: date.required(), lastWorkingDay: date.required(), reason: reason.required(), refNo }) },
  update: { params: uuidParam, body: Joi.object({ employeeId: id, applicationDate: date, lastWorkingDay: date, reason, refNo }).min(1) },
  review: { params: uuidParam, body: Joi.object({ lastWorkingDay: date, reason, refNo }).min(1) },
  reject: { params: uuidParam, body: Joi.object({ reason: reason.required() }) },
};
