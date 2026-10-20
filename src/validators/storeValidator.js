const { Joi, uuidParam, paging } = require('./common');
const { UNITS } = require('../models');

const text = (max) => Joi.string().trim().max(max).allow('', null);
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'date must look like 2026-10-14' });
const id = Joi.string().guid();
const qty = Joi.number().precision(3).positive().max(999999999); // kg with grams: 2.5 = 2 kg 500 g
const money = Joi.number().precision(4).min(0).max(999999999);

const listQuery = Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(100), search: Joi.string().trim().max(100), isActive: Joi.boolean(), categoryId: id, brandId: id });
const params = Joi.object({ id: id.required(), store: Joi.string() });

const name = (max) => Joi.string().trim().min(1).max(max);
const masters = {
  vendor: {
    create: Joi.object({ code: Joi.number().integer().min(1).max(99999999), name: name(150).required(), phone: text(30), address: text(300) }),
    update: Joi.object({ name: name(150), phone: text(30), address: text(300), isActive: Joi.boolean() }).min(1),
  },
  category: {
    create: Joi.object({ name: name(100).required() }),
    update: Joi.object({ name: name(100), isActive: Joi.boolean() }).min(1),
  },
  item: {
    create: Joi.object({ name: name(150).required(), unit: Joi.string().valid(...UNITS).required(), categoryId: id.allow(null), brandId: id.allow(null) }),
    update: Joi.object({ name: name(150), unit: Joi.string().valid(...UNITS), categoryId: id.allow(null), brandId: id.allow(null), isActive: Joi.boolean() }).min(1),
  },
};
masters.brand = masters.category;

const master = (kind) => ({
  list: { query: listQuery },
  get: { params },
  create: { body: masters[kind].create },
  update: { params, body: masters[kind].update },
});

// qty = 3.5, or the two boxes: qtyMain 3 (KG/LTR) + qtySub 500 (G/ML)
// item picked (itemId) or typed (itemName, with optional categoryId and unit)
const line = Joi.object({
  itemId: id.allow('', null), itemName: Joi.string().trim().max(150).allow('', null), categoryId: id.allow('', null), unit: Joi.string().valid(...UNITS), qty, qtyMain: Joi.number().integer().min(0).max(999999999), qtySub: Joi.number().precision(3).min(0).max(999999), rate: money.allow(null),
}).or('qty', 'qtyMain', 'qtySub').oxor('qty', 'qtyMain').oxor('qty', 'qtySub');
const inwardBody = {
  inwardDate: date,
  billType: Joi.string().valid('GST', 'OTHER'),
  vendorId: id.allow(null, ''),
  vendorName: Joi.string().trim().max(150).allow('', null), // typed vendor: used if it exists, else added
  acntNo: text(30),
  dcNo: text(50),
  grnNo: text(50),
  notes: text(500),
  salesTax: Joi.number().precision(2).min(0).max(999999999),
  gstPercent: Joi.number().precision(2).min(0).max(100).allow(null), // picked GST %; the server works out salesTax
  lines: Joi.array().items(line).min(1).max(200),
  approve: Joi.boolean(), // true = save and approve in one go
};

module.exports = {
  vendor: master('vendor'),
  category: master('category'),
  brand: master('brand'),
  item: master('item'),
  inward: {
    list: {
      query: Joi.object({
        ...paging, tab: Joi.string().valid('all', 'gst', 'other', 'draft').default('all'),
        dateFrom: date, dateTo: date, ipNo: Joi.number().integer().min(1), dcNo: Joi.string().trim().max(50),
        grnNo: Joi.string().trim().max(50), vendor: Joi.string().trim().max(100), description: Joi.string().trim().max(100),
      }),
    },
    get: { params },
    create: { body: Joi.object({ ...inwardBody, inwardDate: date.required(), lines: inwardBody.lines.required() }) },
    update: { params, body: Joi.object(inwardBody).min(1) },
  },
  stock: {
    query: Joi.object({ categoryId: id, brandId: id, search: Joi.string().trim().max(100), inStockOnly: Joi.boolean(), groupBy: Joi.string().valid('category', 'brand') }),
  },
  moves: { params, query: Joi.object({ dateFrom: date, dateTo: date }) },
  uuidParam,
};
