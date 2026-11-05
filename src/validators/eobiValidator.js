const { Joi, uuidParam } = require('./common');

const id = Joi.string().guid();
const month = Joi.string().pattern(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/).messages({ 'string.pattern.base': 'month looks like 2026-10' });
const name = Joi.string().trim().min(1).max(120);
const code = Joi.string().trim().max(30).allow('', null);
// the wage: a decimal string or a number with at most 2 decimals, more than 0
const wage = Joi.alternatives().try(
  Joi.string().trim().pattern(/^(?!0+(\.0+)?$)\d{1,10}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'the wage looks like 40700 or 40700.50 and is more than 0' }),
  Joi.number().strict().precision(2).greater(0).max(9999999999),
);
const percent = Joi.number().strict().precision(3).min(0).max(100);
const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(2000).default(500) };

module.exports = {
  providers: {
    create: { body: Joi.object({ name: name.required(), code }) },
    update: { params: uuidParam, body: Joi.object({ name, code, isActive: Joi.boolean() }).min(1) },
  },
  locations: {
    create: { body: Joi.object({ providerId: id.required(), name: name.required(), code }) },
    update: { params: uuidParam, body: Joi.object({ name, code, isActive: Joi.boolean() }).min(1) },
  },
  rates: {
    list: { query: Joi.object({ month }) },
    save: { body: Joi.object({ month: month.required(), wage: wage.required(), employerPercent: percent.required(), employeePercent: percent.required(), recalculate: Joi.boolean() }) },
  },
  get: { params: uuidParam },
  view: { query: Joi.object({ ...paging, providerId: id.required(), month: month.required(), search: Joi.string().trim().max(100), locationId: Joi.alternatives().try(id, Joi.string().valid('none')) }) },
  create: { body: Joi.object({ providerId: id.required(), month: month.required(), mode: Joi.string().valid('COPY', 'EMPTY').default('COPY'), copyFromMonth: month }) },
  candidates: { params: uuidParam, query: Joi.object({ search: Joi.string().trim().max(100), limit: Joi.number().integer().min(1).max(500).default(100) }) },
  addRows: { params: uuidParam, body: Joi.object({ employeeIds: Joi.array().items(id).min(1).max(2000).required(), locationId: id.allow(null) }) },
  removeRows: { params: uuidParam, body: Joi.object({ rowIds: Joi.array().items(id).min(1).max(2000).required() }) },
  setLocations: { params: uuidParam, body: Joi.object({ items: Joi.array().items(Joi.object({ rowId: id.required(), locationId: id.allow(null).required() })).min(1).max(2000).required() }) },
  import: { params: uuidParam, body: Joi.object({ rows: Joi.array().items(Joi.object().unknown(true)).min(1).max(5000).required(), locationId: id.allow(null), dryRun: Joi.boolean() }) },
  summary: { query: Joi.object({ providerId: id.required(), year: Joi.number().integer().min(2000).max(2100) }) },
};
