const { Joi } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
const month = Joi.string().pattern(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/).messages({ 'string.pattern.base': 'month looks like 2026-10' });
const paging = { page: Joi.number().integer().min(1).default(1) };

// the rows of a punch file are checked one by one by the service (a bad row is reported, it does not fail the whole file); here only the shape of the call
const rows = Joi.array().items(Joi.object().unknown(true)).min(1).max(5000).required()
  .messages({ 'array.max': 'Send at most 5000 rows at a time: split a bigger file into pieces' });

module.exports = {
  overview: { query: Joi.object({ month }) },
  preview: { body: Joi.object({ rows }) },
  import: { body: Joi.object({ rows, source: Joi.string().valid('EXCEL', 'API', 'MANUAL').default('EXCEL'), fileName: Joi.string().trim().max(200).allow('', null) }) },
  fetch: { body: Joi.object({ from: date, to: date }) },
  process: { body: Joi.object({ from: date.required(), to: date.required(), groupId: id, employeeId: id, keepManual: Joi.boolean() }) },
  punches: {
    query: Joi.object({
      ...paging, limit: Joi.number().integer().min(1).max(1000).default(200), date, from: date, to: date,
      employeeCode: Joi.number().integer().min(1).max(99999999), deviceId: id, unmapped: Joi.boolean(),
    }),
  },
  unmapped: { query: Joi.object({ month }) },
  batches: { query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(200).default(50) }) },
  batch: { params: Joi.object({ id: Joi.string().guid().required() }) },
  device: { params: Joi.object({ id: Joi.string().guid().required() }), body: Joi.object({ name: Joi.string().trim().min(1).max(120), isActive: Joi.boolean() }).min(1) },
  days: {
    query: Joi.object({
      ...paging, limit: Joi.number().integer().min(1).max(500).default(100), month, groupId: id, departmentId: id, designationId: id, employeeId: id,
      search: Joi.string().trim().max(100), closed: Joi.string().valid('false', 'all').default('false'),
    }),
  },
  // the month reports (attendance and punch record): all employees of the month on one sheet, filters, Excel
  report: {
    query: Joi.object({
      ...paging, limit: Joi.number().integer().min(1).max(1000).default(100), month, groupId: id, departmentId: id, designationId: id, employeeId: id,
      search: Joi.string().trim().max(100), closed: Joi.string().valid('false', 'all').default('false'), format: Joi.string().valid('json', 'xlsx').default('json'),
    }),
  },
  reportEmployee: { params: Joi.object({ id: Joi.string().guid().required() }), query: Joi.object({ month, format: Joi.string().valid('json', 'xlsx').default('json') }) },
  daily: { query: Joi.object({ date: date.required(), code: Joi.string().valid('P', 'L', 'HD', 'A', 'R', 'AL') }) },
  day: { params: Joi.object({ employeeId: Joi.string().guid().required(), date: date.required() }) },
  editDay: {
    params: Joi.object({ employeeId: Joi.string().guid().required(), date: date.required() }),
    body: Joi.object({
      code: Joi.string().valid('P', 'L', 'HD', 'A', 'R', 'AL').required(),
      overtimeMinutes: Joi.number().strict().integer().min(0).max(1440),
      note: Joi.string().trim().max(300).allow('', null),
    }),
  },
};
