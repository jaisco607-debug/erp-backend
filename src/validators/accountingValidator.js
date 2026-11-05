const { Joi } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid({ version: 'uuidv4' });
// a decimal string ("1500.50") or a number with at most 2 decimals; never negative
const amount = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,13}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'amount must look like 1500.50' }),
  Joi.number().strict().precision(2).min(0).max(9999999999999), // strict: 1.234 is an error, not rounded
);

module.exports = {
  openingGet: { query: Joi.object({ date: ymdDate() }) },
  openingSave: {
    body: Joi.object({
      date: ymdDate().required(),
      lines: Joi.array().items(Joi.object({ accountId: id.required(), amount: amount.required(), side: Joi.string().valid('DEBIT', 'CREDIT'), partyId: id })).max(2000).required(),
      balancingAccountId: id,
    }),
  },
  trialBalance: {
    query: Joi.object({
      dateFrom: ymdDate(), dateTo: ymdDate(), fiscalYear: Joi.number().integer().min(1990).max(2100), includeZero: Joi.boolean().default(false),
      accountType: Joi.string().valid('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'),
    }),
  },
  ledger: { query: Joi.object({ accountId: id.required(), dateFrom: ymdDate(), dateTo: ymdDate(), fiscalYear: Joi.number().integer().min(1990).max(2100) }) },
  partyLedger: {
    query: Joi.object({
      partyType: Joi.string().valid('CUSTOMER', 'VENDOR').required(), partyId: id.required(), dateFrom: ymdDate(), dateTo: ymdDate(), fiscalYear: Joi.number().integer().min(1990).max(2100),
      search: Joi.string().trim().max(100).allow(''),
      kind: Joi.string().valid('SALES_INVOICE', 'PURCHASE_INVOICE', 'PAYMENT_VOUCHER', 'RECEIPT_VOUCHER', 'JOURNAL_VOUCHER', 'CONTRA_VOUCHER', 'EMPLOYEE_LOAN_VOUCHER', 'EMPLOYEE_ADVANCE_VOUCHER', 'SALARY_PAYMENT_VOUCHER', 'EOBI_VOUCHER', 'SALARY_TAX_VOUCHER'),
    }),
  },
  parties: {
    query: Joi.object({
      date: ymdDate(), search: Joi.string().trim().max(100).allow(''), includeZero: Joi.boolean().default(false),
      page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(500).default(20),
    }),
  },
  bankSummary: {
    query: Joi.object({
      accountId: id.required(), dateFrom: ymdDate(), dateTo: ymdDate(), fiscalYear: Joi.number().integer().min(1990).max(2100),
      status: Joi.string().valid('ALL', 'CLEARED', 'UNCLEARED'), search: Joi.string().trim().max(100).allow(''),
    }),
  },
  bankClearingSet: { body: Joi.object({ journalLineId: id.required(), clearedDate: ymdDate().required() }) },
  bankClearingRemove: { params: Joi.object({ lineId: id.required() }) },
  profitLoss: { query: Joi.object({ dateFrom: ymdDate(), dateTo: ymdDate(), fiscalYear: Joi.number().integer().min(1990).max(2100), includeZero: Joi.boolean().default(false) }) },
  balanceSheet: { query: Joi.object({ date: ymdDate(), includeZero: Joi.boolean().default(false) }) },
  balances: { query: Joi.object({ date: ymdDate(), search: Joi.string().trim().max(100).allow('') }) },
  openItems: { query: Joi.object({ partyType: Joi.string().valid('CUSTOMER', 'VENDOR').required(), partyId: id.required(), date: ymdDate() }) },
  cutoff: { query: Joi.object({ date: ymdDate(), search: Joi.string().trim().max(100).allow(''), detail: Joi.boolean().default(false) }) },
  // buckets=15,30,60 : the day limits of the due schedule (1 to 3650, up to 8)
  dueSchedule: {
    query: Joi.object({
      date: ymdDate(), search: Joi.string().trim().max(100).allow(''), detail: Joi.boolean().default(false),
      buckets: Joi.string().pattern(/^\d{1,4}(,\d{1,4}){0,7}$/).custom((v, helpers) => {
        const days = v.split(',').map(Number);
        return days.some((d) => d < 1 || d > 3650) ? helpers.error('any.invalid') : days;
      }).messages({ 'string.pattern.base': 'buckets must look like 15,30,60', 'any.invalid': 'each bucket is 1 to 3650 days' }),
    }),
  },
  settingsSave: { body: Joi.object({ fiscalYearStartMonth: Joi.number().integer().min(1).max(12).required() }) },
};
