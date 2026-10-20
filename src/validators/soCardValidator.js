const { Joi, uuidParam, paging } = require('./common');
const { STATUSES } = require('../models/SoCard');

const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'date must look like 2026-10-13' });
// a lot with a thaan list: thaanNos; a lot without one: meters (+ pieces)
const lotLines = Joi.array().items(Joi.object({
  greyLotId: Joi.string().guid().required(),
  thaanNos: Joi.array().items(Joi.number().integer().min(1)).min(1).max(2000).unique(),
  // part of a thaan: meters left out = all that is free of it
  thaans: Joi.array().items(Joi.object({ thaanNo: Joi.number().integer().min(1).required(), meters: Joi.number().precision(2).positive().max(99999999) }))
    .min(1).max(2000).unique('thaanNo'),
  meters: Joi.number().precision(2).positive().max(99999999),
  pieces: Joi.number().integer().min(0).max(1000000).default(0),
}).xor('thaanNos', 'thaans', 'meters')).min(1).max(50).unique('greyLotId');
const text = (max) => Joi.string().trim().max(max).allow('', null);

module.exports = {
  availableLots: {
    query: Joi.object({ customerId: Joi.string().guid(), search: Joi.string().trim().max(20), limit: Joi.number().integer().min(1).max(500).default(200) }),
  },
  list: {
    query: Joi.object({
      ...paging,
      search: Joi.string().trim().max(100),
      customerId: Joi.string().guid(),
      departmentId: Joi.string().guid(),
      status: Joi.string().uppercase().valid(...STATUSES),
      isReprocess: Joi.boolean(),
      isConfirmed: Joi.boolean(),
      dateFrom: date,
      dateTo: date,
    }),
  },
  get: { params: uuidParam },
  create: {
    body: Joi.object({
      cardDate: date.required(),
      lots: lotLines.required(),
      remarks: text(500),
      description: text(500),
      deliveryDate: date.allow(null),
      article: text(150),
      instructions: text(1000),
      workInstructions: text(1000),
      qualityId: Joi.string().guid().allow(null),
      // send straight away from the same screen (optional)
      departmentId: Joi.string().guid(),
      sentThrough: text(120),
    }),
  },
  update: {
    params: uuidParam,
    body: Joi.object({ cardDate: date, deliveryDate: date.allow(null), article: text(150), instructions: text(1000), workInstructions: text(1000), remarks: text(500), description: text(500), qualityId: Joi.string().guid().allow(null), departmentId: Joi.string().guid(), sentThrough: text(120), lots: lotLines }).min(1),
  },
  confirm: { params: uuidParam, body: Joi.object({ isConfirmed: Joi.boolean().required() }) },
  numbering: {
    body: Joi.object({ nextCardNo: Joi.number().integer().min(1).max(99999999), nextIdNo: Joi.number().integer().min(1).max(99999999) }).min(1),
  },
  send: {
    params: uuidParam,
    body: Joi.object({ departmentId: Joi.string().guid().required(), sentThrough: text(120), remarks: text(500), workInstructions: text(1000) }),
  },
  sendMany: {
    body: Joi.object({
      soCardIds: Joi.array().items(Joi.string().guid()).min(1).max(50).unique().required(),
      departmentId: Joi.string().guid().required(),
      colourId: Joi.string().guid().allow(null),
      jobDate: date,
      sentThrough: text(120),
      remarks: text(500),
      workInstructions: text(1000),
    }),
  },
  incoming: { query: Joi.object({ departmentId: Joi.string().guid().required() }) },
};
