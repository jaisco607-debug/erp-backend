const { Joi, uuidParam, paging } = require('./common');

// optional text; '' or null clears it (the services turn '' into null)
const text = (max) => Joi.string().trim().max(max).allow('', null);
const meters = Joi.number().precision(2).positive().max(99999999);
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'date must look like 2026-10-13' });

const master = {
  list: { query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(100), search: Joi.string().trim().max(100), isActive: Joi.boolean() }) },
  get: { params: uuidParam },
};

const lotFields = {
  dcNo: text(50),
  inwardDate: date,
  customerId: Joi.string().guid(),
  qualityId: Joi.string().guid(),
  inwardMeters: meters,
  pieces: Joi.number().integer().min(0).max(1000000),
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
        qualityId: lotFields.qualityId.required(),
        inwardMeters: meters.required(),
        pieces: lotFields.pieces.required(),
        isReprocess: Joi.boolean().default(false),
        reprocessOfLotId: Joi.string().guid().allow(null).default(null),
      }),
    },
    update: { params: uuidParam, body: Joi.object(lotFields).min(1) },
    active: { params: uuidParam, body: Joi.object({ isActive: Joi.boolean().required() }) },
    approve: { params: uuidParam },
    numbering: {
      body: Joi.object({
        nextLotNo: Joi.number().integer().min(1).max(99999999),
        nextTypeNo: Joi.number().integer().min(1).max(99999999),
      }).min(1),
    },
  },
};
