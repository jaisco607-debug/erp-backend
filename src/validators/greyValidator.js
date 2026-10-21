const { Joi, uuidParam, paging } = require('./common');
const { ymdDate } = require('../utils/dates');

// optional text; '' or null clears it (the services turn '' into null)
const text = (max) => Joi.string().trim().max(max).allow('', null);
const meters = Joi.number().precision(2).positive().max(99999999);
const date = ymdDate().messages({ 'string.pattern.base': 'date must look like 2026-10-13' });

const master = {
  list: { query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(100), search: Joi.string().trim().max(100), isActive: Joi.boolean() }) },
  get: { params: uuidParam },
};

const lotFields = {
  dcNo: text(50),
  inwardDate: date,
  customerId: Joi.string().guid(),
  qualityId: Joi.string().guid(),
  // typed by hand instead of qualityId: existing quality is used, or a new one is added
  qualityName: Joi.string().trim().min(2).max(150),
  // typed by hand; leave out for the automatic number
  lotNo: Joi.number().integer().min(1).max(99999999),
  unit: Joi.string().uppercase().valid('METER', 'YARD'),
  // length of every thaan in `unit`, e.g. [52.5, 48, 50]; pieces and totals are worked out
  thaans: Joi.array().items(meters).min(1).max(2000),
  inwardMeters: meters,
  inwardYards: meters,
  pieces: Joi.number().integer().min(0).max(1000000),
  glm: Joi.number().precision(2).positive().max(99999).allow(null),
  gsm: Joi.number().precision(2).positive().max(99999).allow(null),
  partyRef: text(80),
  vehicleNo: text(30),
  remarks: text(500),
  isReprocess: Joi.boolean(),
  reprocessOfLotId: Joi.string().guid().allow(null),
};

module.exports = {
  customer: {
    ...master,
    create: {
      body: Joi.object({
        code: Joi.number().integer().min(1).max(99999999),
        name: Joi.string().trim().min(2).max(150).required(),
        phone: text(30),
        address: text(300),
      }),
    },
    update: {
      params: uuidParam,
      body: Joi.object({ name: Joi.string().trim().min(2).max(150), phone: text(30), address: text(300), isActive: Joi.boolean() }).min(1),
    },
  },
  quality: {
    ...master,
    create: { body: Joi.object({ name: Joi.string().trim().min(2).max(150).required() }) },
    update: { params: uuidParam, body: Joi.object({ name: Joi.string().trim().min(2).max(150), isActive: Joi.boolean() }).min(1) },
  },
  lot: {
    list: {
      query: Joi.object({
        ...paging,
        search: Joi.string().trim().max(100),
        customerId: Joi.string().guid(),
        qualityId: Joi.string().guid(),
        isActive: Joi.boolean(),
        isApproved: Joi.boolean(),
        isReprocess: Joi.boolean(),
        dateFrom: date,
        dateTo: date,
      }),
    },
    get: { params: uuidParam },
    create: {
      body: Joi.object({
        ...lotFields,
        inwardDate: date.required(),
        customerId: lotFields.customerId.required(),
        qualityId: lotFields.qualityId,
        unit: lotFields.unit.default('METER'),
        isReprocess: Joi.boolean().default(false),
        reprocessOfLotId: Joi.string().guid().allow(null).default(null),
      }).xor('qualityId', 'qualityName'),
    },
    update: { params: uuidParam, body: Joi.object({ ...lotFields, typeNo: Joi.string().trim().min(1).max(20) }).oxor('qualityId', 'qualityName').min(1) },
    active: { params: uuidParam, body: Joi.object({ isActive: Joi.boolean().required() }) },
    approve: { params: uuidParam },
    giveBack: {
      params: uuidParam,
      body: Joi.object({
        thaanNos: Joi.array().items(Joi.number().integer().min(1)).min(1).max(2000),
        meters, pieces: Joi.number().integer().min(0).max(1000000),
        returnDate: date, vehicleNo: text(30), remarks: text(500),
      }).xor('thaanNos', 'meters'),
    },
    undoGiveBack: { params: Joi.object({ id: Joi.string().guid().required(), returnId: Joi.string().guid().required() }) },
    numbering: {
      body: Joi.object({
        nextLotNo: Joi.number().integer().min(1).max(99999999),
        nextTypeNo: Joi.number().integer().min(1).max(99999999),
      }).min(1),
    },
  },
};
