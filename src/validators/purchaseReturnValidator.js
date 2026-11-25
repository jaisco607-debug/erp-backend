const { Joi, uuidParam, paging } = require('./common');
const { ymdDate } = require('../utils/dates');

const text = (max) => Joi.string().trim().max(max).allow('', null);
const id = Joi.string().guid({ version: 'uuidv4' });
const date = ymdDate();
const vendorReturnIds = Joi.array().items(id).min(1).max(100);

module.exports = {
  list: {
    query: Joi.object({
      ...paging, limit: Joi.number().integer().min(1).max(500).default(50), status: Joi.string().valid('UNAPPROVED', 'APPROVED'), dateFrom: date, dateTo: date,
      vendorId: id, purchaseInvoiceId: id, search: Joi.string().trim().max(100).allow(''),
    }),
  },
  // the vendor's returns (stock sent back) to choose from; `invoiceId` is the return invoice being edited (its own returns stay in the list)
  vendorReturns: { query: Joi.object({ vendorId: id.required(), invoiceId: id, search: Joi.string().trim().max(100).allow(''), limit: Joi.number().integer().min(1).max(500).default(100) }) },
  get: { params: uuidParam },
  create: { body: Joi.object({ vendorId: id.required(), vendorReturnIds: vendorReturnIds.required(), returnDate: date, notes: text(300) }) },
  update: { params: uuidParam, body: Joi.object({ vendorReturnIds, returnDate: date, notes: text(300) }).min(1) },
  unapprove: { params: uuidParam, body: Joi.object({ reason: Joi.string().trim().max(200) }) },
};
