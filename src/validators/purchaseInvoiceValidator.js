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
  dueDate: date.allow(null, ''),
  billNo: text(50), // the number on the vendor's own bill
  notes: text(300),
  billDetails: text(300),
  taxRate: Joi.number().strict().precision(2).min(0).max(100), // the sales tax % of the invoice; chosen here, not in the store
  othersAmount: others, // an amount TAKEN OFF the bill (goods damaged / short)
  othersNote: text(300), // what the others amount is for
};
const inwardIds = Joi.array().items(id).min(1).max(200);

module.exports = {
  list: {
    query: Joi.object({
      ...paging, limit: Joi.number().integer().min(1).max(500).default(50),
      status: Joi.string().valid('APPROVED', 'UNAPPROVED'), dateFrom: date, dateTo: date, vendorId: id, search: Joi.string().trim().max(100),
    }),
  },
  inwards: {
    query: Joi.object({
      vendorId: id.required(), store: Joi.string().valid('CHEMICAL', 'GENERAL'), search: Joi.string().trim().max(100), invoiceId: id,
      limit: Joi.number().integer().min(1).max(500).default(200),
    }),
  },
  get: { params: uuidParam },
  create: { body: Joi.object({ vendorId: id.required(), inwardIds: inwardIds.required(), ...fields }) },
  update: { params: uuidParam, body: Joi.object({ vendorId: id, inwardIds, ...fields }).min(1) },
  unapprove: { params: uuidParam, body: Joi.object({ reason: Joi.string().trim().max(200) }) },
};
