const { Joi, uuidParam } = require('./common');

const id = Joi.string().guid();
const month = Joi.string().pattern(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/).messages({ 'string.pattern.base': 'month looks like 2026-10' });
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

const fields = {
  lateLimitMinutes: Joi.number().strict().integer().min(0).max(600),
  halfDayLimitMinutes: Joi.number().strict().integer().min(1).max(1440),
  latesPerHalfDay: Joi.number().strict().integer().min(0).max(31), // 0 = lates are never penalised
  weeklyOffDay: Joi.string().valid(...DAYS).allow(null), // null = no weekly off
  overtimeFactor: Joi.number().strict().precision(2).min(0).max(10),
  leaveEarnedPerMonth: Joi.number().strict().precision(2).min(0).max(31),
  maxLeavePerYear: Joi.number().strict().precision(2).min(0).max(366),
  monthsBeforeLeave: Joi.number().strict().integer().min(0).max(120),
};

module.exports = {
  DAYS,
  list: { query: Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(500).default(100), groupId: id }) },
  byGroup: { query: Joi.object({ month }) },
  effective: { query: Joi.object({ groupId: id.required(), month }) },
  get: { params: uuidParam },
  // every rule is optional: what is not sent is taken from the policy in force that month (or the defaults)
  create: { body: Joi.object({ groupId: id.required(), effectiveFrom: month.required(), ...fields }) },
  update: { params: uuidParam, body: Joi.object(fields).min(1) },
};
