const { Joi, uuidParam, paging } = require('./common');
const { ymdDate } = require('../utils/dates');
const { UNITS } = require('../models');

const text = (max) => Joi.string().trim().max(max).allow('', null);
const date = ymdDate().messages({ 'string.pattern.base': 'date must look like 2026-10-14' });
const id = Joi.string().guid();
const qty = Joi.number().precision(3).positive().max(999999999); // kg with grams: 2.5 = 2 kg 500 g
const money = Joi.number().precision(4).min(0).max(999999999);

const VENDOR_STATUS = ['INDIVIDUAL', 'COMPANY', 'AOP'];
const VENDOR_TYPES = ['VENDORS'];
const VENDOR_PAYMENT = ['CHQ', 'CASH', 'ONLINE', 'PAY_ORDER'];
const vendorFields = {
  legalName: text(150), status: Joi.string().valid(...VENDOR_STATUS), type: Joi.string().valid(...VENDOR_TYPES), payment: Joi.string().valid(...VENDOR_PAYMENT),
  cnic: text(20), ntn: text(30), gstNo: text(30), email: Joi.string().trim().email().max(150).allow('', null), city: text(80), province: text(80),
  bankName: text(100), bankBranch: text(100), accountTitle: text(150), accountNo: text(50), iban: text(40),
};
const listQuery = Joi.object({ ...paging, export: Joi.boolean(), limit: Joi.number().integer().min(1).max(500).default(100), search: Joi.string().trim().max(100), isActive: Joi.boolean(), categoryId: id, brandId: id });
const params = Joi.object({ id: id.required(), store: Joi.string() });

const name = (max) => Joi.string().trim().min(1).max(max);
const masters = {
  vendor: {
    create: Joi.object({ code: Joi.number().integer().min(1).max(99999999), name: name(150).required(), phone: text(30), address: text(300), ...vendorFields }),
    update: Joi.object({ name: name(150), phone: text(30), address: text(300), isActive: Joi.boolean(), ...vendorFields }).min(1),
  },
  category: {
    create: Joi.object({ name: name(100).required() }),
    update: Joi.object({ name: name(100), isActive: Joi.boolean() }).min(1),
  },
  item: {
    create: Joi.object({ name: name(150).required(), unit: Joi.string().valid(...UNITS).required(), categoryId: id.allow(null), brandId: id.allow(null), reorderLevel: Joi.number().precision(3).min(0).max(999999999).allow(null) }),
    update: Joi.object({ name: name(150), unit: Joi.string().valid(...UNITS), categoryId: id.allow(null), brandId: id.allow(null), reorderLevel: Joi.number().precision(3).min(0).max(999999999).allow(null), isActive: Joi.boolean() }).min(1),
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
const PACK_TYPES = ['DRUM', 'BAG', 'CAN', 'CARTON', 'BOX', 'BARREL', 'OTHER'];
const REASONS = ['DAMAGED', 'WRONG_ITEM', 'EXPIRED', 'QUALITY', 'EXCESS', 'OTHER'];
const line = Joi.object({
  packType: Joi.string().valid(...PACK_TYPES), packCount: Joi.number().integer().min(1).max(99999), qtyPerPack: Joi.number().precision(3).positive().max(999999),
  lineId: id, itemId: id.allow('', null), itemName: Joi.string().trim().max(150).allow('', null), categoryId: id.allow('', null), unit: Joi.string().valid(...UNITS), qty, qtyMain: Joi.number().integer().min(0).max(999999999), qtySub: Joi.number().precision(3).min(0).max(999999), rate: money.allow(null),
}).or('qty', 'qtyMain', 'qtySub', 'packCount').oxor('qty', 'qtyMain').oxor('qty', 'qtySub').with('packCount', 'qtyPerPack').without('packCount', ['qty', 'qtyMain', 'qtySub']);
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

// return to vendor: lines name the purchase line they come from; qty, or packs x qty per pack
const vendorReturnLine = Joi.object({
  inwardLineId: id.required(), qty, packType: Joi.string().valid(...PACK_TYPES), packCount: Joi.number().integer().min(1).max(99999), qtyPerPack: Joi.number().precision(3).positive().max(999999),
}).or('qty', 'packCount').with('packCount', 'qtyPerPack').without('packCount', 'qty');

module.exports = {
  PACK_TYPES, REASONS,
  vendorReturn: {
    list: { query: Joi.object({ ...paging, limit: Joi.number().integer().min(1).max(500).default(100), dateFrom: date, dateTo: date, vendorId: id, itemId: id, status: Joi.string().valid('POSTED', 'CANCELLED') }) },
    returnable: { query: Joi.object({ vendorId: id.required(), itemId: id, dateTo: date }) },
    get: { params },
    create: { body: Joi.object({ returnDate: date, vendorId: id.required(), reason: Joi.string().valid(...REASONS).required(), notes: text(500), lines: Joi.array().items(vendorReturnLine).min(1).max(100).required() }) },
    cancel: { params, body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required() }) },
  },
  VENDOR_STATUS, VENDOR_TYPES, VENDOR_PAYMENT,
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
    // fix an approved entry: whole entry again (lines with their lineId), and why
    correct: { params, body: Joi.object({ ...inwardBody, approve: Joi.forbidden(), lines: inwardBody.lines.required(), reason: Joi.string().trim().min(3).max(300).required() }) },
  },
  stock: {
    query: Joi.object({ categoryId: id, brandId: id, search: Joi.string().trim().max(100), inStockOnly: Joi.boolean(), groupBy: Joi.string().valid('category', 'brand') }),
  },
  moves: { params, query: Joi.object({ dateFrom: date, dateTo: date }) },
  uuidParam,
};
