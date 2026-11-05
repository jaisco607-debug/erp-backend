const { Joi, uuidParam } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
const month = Joi.string().pattern(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/).messages({ 'string.pattern.base': 'month looks like 2026-10' });
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
// an amount typed by HR: a decimal string ("1500.50") or a number with at most 2 decimals, never negative
const amount = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,10}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'an amount looks like 1500 or 1500.50' }),
  Joi.number().strict().precision(2).min(0).max(9999999999),
);
const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(1000).default(200) };

const policy = {
  lateLimitMinutes: Joi.number().strict().integer().min(0).max(600),
  halfDayLimitMinutes: Joi.number().strict().integer().min(1).max(1440),
  latesPerHalfDay: Joi.number().strict().integer().min(0).max(31),
  weeklyOffDay: Joi.string().valid(...DAYS).allow(null),
  overtimeFactor: Joi.number().strict().precision(2).min(0).max(10),
  leaveEarnedPerMonth: Joi.number().strict().precision(2).min(0).max(31),
  maxLeavePerYear: Joi.number().strict().precision(2).min(0).max(366),
  monthsBeforeLeave: Joi.number().strict().integer().min(0).max(120),
};

module.exports = {
  sheet: { params: uuidParam, query: Joi.object({ format: Joi.string().valid('json', 'xlsx').default('json') }) },
  bankFile: {
    params: uuidParam,
    query: Joi.object({ format: Joi.string().valid('MEEZAN').default('MEEZAN'), scope: Joi.string().valid('unpaid', 'all').default('unpaid'), onlyNew: Joi.boolean().default(false) }),
  },
  makeBankFile: { params: uuidParam, body: Joi.object({ format: Joi.string().valid('MEEZAN').default('MEEZAN'), scope: Joi.string().valid('unpaid', 'all').default('unpaid'), onlyNew: Joi.boolean().default(false) }) },
  cashSheet: {
    params: uuidParam,
    query: Joi.object({
      format: Joi.string().valid('json', 'xlsx', 'pdf').default('json'), scope: Joi.string().valid('unpaid', 'all').default('unpaid'),
      // the notes to count, e.g. 5000,1000,500,100,50,20,10 (a note nobody has can be left out)
      denominations: Joi.string().pattern(/^\d{1,6}(,\d{1,6}){0,9}$/).custom((value, helpers) => {
        const list = value.split(',').map(Number);
        if (list.some((n) => n < 1)) return helpers.error('any.invalid');
        return list;
      }).messages({ 'string.pattern.base': 'denominations look like 5000,1000,500,100,50,20,10', 'any.invalid': 'every note must be at least 1' }),
    }),
  },
  overview: { query: Joi.object({ month }) },
  list: { query: Joi.object({ month, search: Joi.string().trim().max(100) }) },
  create: { body: Joi.object({ month: month.required(), groupId: id.required() }) },
  get: { params: uuidParam },
  policy: { params: uuidParam, body: Joi.object({ ...policy, makeDefault: Joi.boolean() }).min(1) },
  slips: {
    params: uuidParam,
    query: Joi.object({ ...paging, status: Joi.string().valid('DRAFT', 'REVIEW', 'FINAL_REVIEW', 'APPROVED', 'SUSPENDED'), search: Joi.string().trim().max(100), department: Joi.string().trim().max(100), departmentId: id, paid: Joi.string().valid('unpaid') }),
  },
  moveMany: { params: uuidParam, body: Joi.object({ action: Joi.string().valid('review', 'final-review', 'approve', 'send-back').required(), slipIds: Joi.array().items(id).max(1000) }) },
  slip: { params: uuidParam },
  updateSlip: {
    params: uuidParam,
    body: Joi.object({
      basicSalary: amount, dutyHours: Joi.number().strict().precision(2).min(0).max(24), food: amount, maintenance: amount, mobile: amount, othersAdd: amount, eobi: amount, incomeTax: amount, othersDeduct: amount,
      overtimeHours: Joi.number().strict().precision(2).min(0).max(744).allow(null), isCash: Joi.boolean(), notes: Joi.string().trim().max(500).allow('', null),
      loans: Joi.array().items(Joi.object({ loanId: id.required(), amount: amount.required() })).max(20),
      advances: Joi.array().items(Joi.object({ advanceId: id.required(), amount: amount.required() })).max(20),
    }).min(1),
  },
  day: { params: Joi.object({ id: Joi.string().guid({ version: 'uuidv4' }).required(), date: date.required() }), body: Joi.object({ code: Joi.string().valid('P', 'L', 'HD', 'A', 'R', 'AL').required() }) },
  calculate: { params: uuidParam, body: Joi.object({ auto: Joi.boolean() }) },
  suspend: { params: uuidParam, body: Joi.object({ note: Joi.string().trim().min(3).max(500).required() }) },
};
