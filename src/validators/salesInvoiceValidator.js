const { Joi, uuidParam, paging } = require('./common');
const { ymdDate } = require('../utils/dates');

const text = (max) => Joi.string().trim().max(max).allow('', null);
const id = Joi.string().guid({ version: 'uuidv4' });
const date = ymdDate();

// an amount: a decimal string ("1500.50") or a number with at most 2 decimals, never negative
const others = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,13}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'othersAmount must look like 1500.50' }),
  Joi.number().strict().precision(2).min(0).max(9999999999999),
);

const fields = {
  invoiceDate: date,
  dueDate: date.allow(null, ''), // empty = invoice date + the customer's credit days
  invoiceNo: Joi.number().integer().min(1).max(99999999),
  notes: text(300),
  invoiceDetails: text(300),
  hsCode: text(20),
  taxRate: Joi.number().precision(2).min(0).max(100),
  othersAmount: others, // an extra amount ADDED to the bill
  othersNote: text(300), // what the others amount is for
};
const gatePassIds = Joi.array().items(id).min(1).max(200);

module.exports = {
  list: {
    query: Joi.object({
      ...paging, limit: Joi.number().integer().min(1).max(500).default(50),
      status: Joi.string().valid('APPROVED', 'UNAPPROVED'), dateFrom: date, dateTo: date, customerId: id, search: Joi.string().trim().max(100),
    }),
  },
  gatePasses: {
    query: Joi.object({
      customerId: id.required(), destination: Joi.string().trim().max(200), search: Joi.string().trim().max(100), invoiceId: id,
      limit: Joi.number().integer().min(1).max(500).default(200),
    }),
  },
  get: { params: uuidParam },
  create: { body: Joi.object({ customerId: id.required(), gatePassIds: gatePassIds.required(), ...fields }) },
  update: { params: uuidParam, body: Joi.object({ customerId: id, gatePassIds, ...fields }).min(1) },
  unapprove: { params: uuidParam, body: Joi.object({ reason: Joi.string().trim().max(200) }) },
};
