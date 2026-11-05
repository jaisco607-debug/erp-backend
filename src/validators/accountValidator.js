const { Joi, uuidParam, paging } = require('./common');
const { ACCOUNT_TYPES, SUB_TYPES, CONTROL_TYPES } = require('../models/Account');
const { PRESETS, TEMPLATES } = require('../services/accountCatalog');

const DEFAULT_KEYS = ['SALES', 'OUTPUT_TAX', 'CUSTOMERS', 'PURCHASES', 'INPUT_TAX', 'SUPPLIERS', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES', 'EMPLOYEE_LOANS', 'EMPLOYEE_ADVANCES', 'SALARY_EXPENSE', 'SALARIES_PAYABLE', 'EOBI_PAYABLE', 'SALARY_TAX_PAYABLE', 'EMPLOYEE_DEDUCTIONS', 'EOBI_EMPLOYER_EXPENSE'];
const ALL_SUB_TYPES = [...new Set(Object.values(SUB_TYPES).flat())];
// a code is letters, digits and . _ - (for example 1100 or 1100-01); stored in capitals
const code = Joi.string().trim().min(1).max(20).pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).messages({ 'string.pattern.base': 'code may contain letters, digits and . _ - only' });
const name = Joi.string().trim().min(1).max(150);
const id = Joi.string().guid({ version: 'uuidv4' });
const money = Joi.number().precision(2).min(0).max(999999999999999);

const fields = {
  parentId: id.allow(null, ''),
  isGroup: Joi.boolean(),
  accountType: Joi.string().valid(...ACCOUNT_TYPES),
  normalBalance: Joi.string().valid('DEBIT', 'CREDIT'),
  subType: Joi.string().valid(...ALL_SUB_TYPES).allow(null, ''),
  controlType: Joi.string().valid(...Object.keys(CONTROL_TYPES)).allow(null, ''),
  isActive: Joi.boolean(),
  isContra: Joi.boolean(),
  // no longer entered on the account (use PUT /accounting/opening-balances); only 0 is accepted
  openingBalance: money,
  openingSide: Joi.string().valid('DEBIT', 'CREDIT'),
};

module.exports = {
  list: {
    query: Joi.object({
      ...paging, limit: Joi.number().integer().min(1).max(1000).default(200),
      search: Joi.string().trim().max(100), accountType: fields.accountType, isGroup: Joi.boolean(), isActive: Joi.boolean(), parentId: id,
    }),
  },
  tree: { query: Joi.object({ isActive: Joi.boolean() }) },
  nextCode: { query: Joi.object({ parentId: id, accountType: fields.accountType, isGroup: Joi.boolean(), subType: fields.subType }) },
  applyTemplate: { body: Joi.object({ templateKey: Joi.string().valid(...TEMPLATES.map((t) => t.key)).required() }) },
  get: { params: uuidParam },
  defaultKey: { params: Joi.object({ key: Joi.string().valid(...DEFAULT_KEYS).required() }) },
  defaultSet: { params: Joi.object({ key: Joi.string().valid(...DEFAULT_KEYS).required() }), body: Joi.object({ accountId: id.required() }) },
  // code may be left out: the company's next free number is used
  create: { body: Joi.object({ code: code.allow('', null), name, presetKey: Joi.string().valid(...PRESETS.map((x) => x.key)), ...fields }) },
  update: { params: uuidParam, body: Joi.object({ code, name, ...fields }).min(1) },
};
