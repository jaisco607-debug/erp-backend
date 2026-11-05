const { Joi, uuidParam } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const name = (max = 120) => Joi.string().trim().min(1).max(max);
const text = (max) => Joi.string().trim().max(max).allow('', null);
const time = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).messages({ 'string.pattern.base': 'time looks like 08:00 (24 hour)' });
const date = ymdDate();

const listBase = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(100),
  search: Joi.string().trim().max(100),
  isActive: Joi.boolean(),
};
const get = { params: uuidParam };

module.exports = {
  masters: {},
  groups: {
    list: { query: Joi.object(listBase) },
    get,
    create: { body: Joi.object({ name: name(80).required() }) },
    update: { params: uuidParam, body: Joi.object({ name: name(80), isActive: Joi.boolean(), sortOrder: Joi.number().integer().min(0).max(100000) }).min(1) },
  },
  departments: {
    list: { query: Joi.object({ ...listBase, groupId: id }) },
    get,
    create: { body: Joi.object({ groupId: id.required(), name: name(120).required(), fte: Joi.number().strict().integer().min(0).max(100000).default(0) }) },
    update: { params: uuidParam, body: Joi.object({ groupId: id, name: name(120), fte: Joi.number().strict().integer().min(0).max(100000), isActive: Joi.boolean() }).min(1) },
  },
  designations: {
    list: { query: Joi.object(listBase) },
    get,
    create: { body: Joi.object({ name: name(120).required() }) },
    update: { params: uuidParam, body: Joi.object({ name: name(120), isActive: Joi.boolean() }).min(1) },
  },
  banks: {
    list: { query: Joi.object(listBase) },
    get,
    create: { body: Joi.object({ name: name(120).required(), shortName: text(20), bankCode: text(20) }) },
    update: { params: uuidParam, body: Joi.object({ name: name(120), shortName: text(20), bankCode: text(20), isActive: Joi.boolean() }).min(1) },
  },
  shifts: {
    list: { query: Joi.object(listBase) },
    get,
    create: {
      body: Joi.object({
        code: Joi.string().trim().uppercase().min(1).max(30).required(), name: text(80),
        startTime: time.required(), endTime: time.required(),
        dutyHours: Joi.number().strict().precision(2).greater(0).max(24).required(), isNight: Joi.boolean().default(false),
      }),
    },
    update: {
      params: uuidParam,
      body: Joi.object({
        code: Joi.string().trim().uppercase().min(1).max(30), name: text(80), startTime: time, endTime: time,
        dutyHours: Joi.number().strict().precision(2).greater(0).max(24), isNight: Joi.boolean(), isActive: Joi.boolean(),
      }).min(1),
    },
  },
  holidays: {
    list: { query: Joi.object({ ...listBase, dateFrom: date, dateTo: date, year: Joi.number().integer().min(1990).max(2100), groupId: id }) },
    get,
    // all groups (the default), or the chosen ones
    create: {
      body: Joi.object({
        holidayDate: date.required(), name: name(120).required(), appliesToAll: Joi.boolean().default(true),
        groupIds: Joi.array().items(id).unique().max(50).when('appliesToAll', { is: false, then: Joi.array().min(1).required(), otherwise: Joi.array().max(0) }),
      }),
    },
    update: { params: uuidParam, body: Joi.object({ holidayDate: date, name: name(120), appliesToAll: Joi.boolean(), groupIds: Joi.array().items(id).unique().max(50) }).min(1) },
  },
};
