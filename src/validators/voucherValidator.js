const { Joi, uuidParam, paging } = require('./common');
const { ymdDate } = require('../utils/dates');
const { MODES } = require('../services/voucherSupport');

const id = Joi.string().guid({ version: 'uuidv4' });
const date = ymdDate();
const text = (max) => Joi.string().trim().max(max).allow('', null);
// a decimal string ("1500.50") or a number with at most 2 decimals
const amount = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,13}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'amount must look like 1500.50' }),
  Joi.number().strict().precision(2).min(0).max(9999999999999),
);
const rate = Joi.number().strict().precision(2).min(0).max(99.99); // income tax withheld, in percent

const listBase = { ...paging, limit: Joi.number().integer().min(1).max(500).default(50), status: Joi.string().valid('DRAFT', 'CONFIRMED'), dateFrom: date, dateTo: date, search: Joi.string().trim().max(100) };
const common = { get: { params: uuidParam }, unconfirm: { params: uuidParam, body: Joi.object({ reason: Joi.string().trim().max(200) }) } };
const header = { voucherDate: date, paymentMode: Joi.string().valid(...MODES), chequeDate: date.allow(null, ''), chequeNo: text(40), notes: text(300) };

module.exports = {
  payment: {
    ...common,
    list: { query: Joi.object({ ...listBase, vendorId: id }) },
    bills: { query: Joi.object({ vendorId: id.required(), search: Joi.string().trim().max(100), limit: Joi.number().integer().min(1).max(500).default(200) }) },
    lines: Joi.array().items(Joi.object({ purchaseInvoiceId: id, advance: Joi.boolean().valid(true), amount: amount.required(), notes: text(200) }).xor('purchaseInvoiceId', 'advance')).min(1).max(200),
    create: null, update: null,
  },
  receipt: {
    ...common,
    list: { query: Joi.object({ ...listBase, customerId: id }) },
    invoices: { query: Joi.object({ customerId: id.required(), search: Joi.string().trim().max(100), limit: Joi.number().integer().min(1).max(500).default(200) }) },
    lines: Joi.array().items(Joi.object({ salesInvoiceId: id, advance: Joi.boolean().valid(true), chequeAmount: amount.required(), incomeTaxRate: rate.default(0), notes: text(200) }).xor('salesInvoiceId', 'advance')).min(1).max(200),
    create: null, update: null,
  },
  journal: {
    ...common,
    list: { query: Joi.object(listBase) },
    lines: Joi.array().items(Joi.object({ accountId: id.required(), debit: amount, credit: amount, narration: text(200), partyId: id })).min(2).max(500),
    create: null, update: null,
  },
  contra: {
    ...common,
    list: { query: Joi.object({ ...listBase, customerId: id, vendorId: id }) },
    invoices: { query: Joi.object({ customerId: id.required(), search: Joi.string().trim().max(100), limit: Joi.number().integer().min(1).max(500).default(200) }) },
    bills: { query: Joi.object({ vendorId: id.required(), search: Joi.string().trim().max(100), limit: Joi.number().integer().min(1).max(500).default(200) }) },
    create: null, update: null,
  },
  // the employee loan voucher: the money paid out against an approved loan application of the payroll
  loan: {
    ...common,
    list: { query: Joi.object({ ...listBase, loanId: id, employeeId: id }) },
    loans: { query: Joi.object({ search: Joi.string().trim().max(100), limit: Joi.number().integer().min(1).max(500).default(200) }) },
    create: null, update: null,
  },
  // the employee advance voucher: the money paid out for an advance written down in the payroll
  advance: {
    ...common,
    list: { query: Joi.object({ ...listBase, advanceId: id, employeeId: id }) },
    advances: { query: Joi.object({ search: Joi.string().trim().max(100), limit: Joi.number().integer().min(1).max(500).default(200) }) },
    create: null, update: null,
  },
  // the salary payment voucher: the salary paid to the employees of approved payslips
  salary: {
    ...common,
    list: { query: Joi.object({ ...listBase, slipId: id }) },
    slips: { query: Joi.object({ search: Joi.string().trim().max(100), runId: id, month: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/), groupId: id, method: Joi.string().valid('BANK', 'CASH'), limit: Joi.number().integer().min(1).max(1000).default(500) }) },
    create: null, update: null,
  },
  // the EOBI contribution voucher: the EOBI of one location of a list, paid to EOBI
  eobi: {
    ...common,
    list: { query: Joi.object({ ...listBase, month: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/), providerId: id, locationId: id }) },
    locations: { query: Joi.object({ month: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/).required(), providerId: id }) },
    create: null, update: null,
  },
  header,
};

// the create / update schemas need the line schema of their own kind
const v = module.exports;
v.payment.create = { body: Joi.object({ ...header, paymentMode: header.paymentMode.required(), vendorId: id.required(), payFromAccountId: id.required(), taxSection: text(120), incomeTaxRate: rate, lines: v.payment.lines.required() }) };
v.payment.update = { params: uuidParam, body: Joi.object({ ...header, vendorId: id, payFromAccountId: id, taxSection: text(120), incomeTaxRate: rate, lines: v.payment.lines }).min(1) };
v.receipt.create = { body: Joi.object({ ...header, paymentMode: header.paymentMode.required(), customerId: id.required(), depositAccountId: id.required(), lines: v.receipt.lines.required() }) };
v.receipt.update = { params: uuidParam, body: Joi.object({ ...header, customerId: id, depositAccountId: id, lines: v.receipt.lines }).min(1) };
const jvHeader = { voucherDate: date, reference: text(60), narration: text(300) };
v.journal.create = { body: Joi.object({ ...jvHeader, lines: v.journal.lines.required() }) };
v.journal.update = { params: uuidParam, body: Joi.object({ ...jvHeader, lines: v.journal.lines }).min(1) };
const loanHeader = { voucherDate: date, paymentMode: header.paymentMode, chequeDate: header.chequeDate, chequeNo: header.chequeNo, refNo: text(40), notes: header.notes };
v.loan.create = { body: Joi.object({ ...loanHeader, paymentMode: header.paymentMode.required(), loanId: id.required(), payFromAccountId: id.required(), amount: amount.required() }) };
v.loan.update = { params: uuidParam, body: Joi.object({ ...loanHeader, loanId: id, payFromAccountId: id, amount }).min(1) };
v.advance.create = { body: Joi.object({ ...loanHeader, paymentMode: header.paymentMode.required(), advanceId: id.required(), payFromAccountId: id.required(), amount }) };
v.advance.update = { params: uuidParam, body: Joi.object({ ...loanHeader, advanceId: id, payFromAccountId: id, amount }).min(1) };
const salaryLines = Joi.array().items(Joi.object({ slipId: id.required(), amount })).min(1).max(1000);
const salaryHeader = { voucherDate: date, paymentMode: header.paymentMode, chequeDate: header.chequeDate, chequeNo: header.chequeNo, refNo: text(40), notes: header.notes };
v.salary.create = { body: Joi.object({ ...salaryHeader, paymentMode: header.paymentMode.required(), payFromAccountId: id.required(), lines: salaryLines.required() }) };
v.salary.update = { params: uuidParam, body: Joi.object({ ...salaryHeader, payFromAccountId: id, lines: salaryLines }).min(1) };
const eobiHeader = { voucherDate: date, paymentMode: header.paymentMode, chequeDate: header.chequeDate, chequeNo: header.chequeNo, refNo: text(40), notes: header.notes };
v.eobi.create = { body: Joi.object({ ...eobiHeader, paymentMode: header.paymentMode.required(), providerId: id.required(), locationId: id.required(), month: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/).required(), payFromAccountId: id.required() }) };
v.eobi.update = { params: uuidParam, body: Joi.object({ ...eobiHeader, payFromAccountId: id }).min(1) };
const contraHeader = { voucherDate: date, reference: text(60), narration: text(300) };
const contraInvoices = Joi.array().items(Joi.object({ salesInvoiceId: id.required(), amount: amount.required() })).min(1).max(200);
const contraBills = Joi.array().items(Joi.object({ purchaseInvoiceId: id.required(), amount: amount.required() })).min(1).max(200);
v.contra.create = { body: Joi.object({ ...contraHeader, customerId: id.required(), vendorId: id.required(), amount: amount.required(), invoices: contraInvoices.required(), bills: contraBills.required() }) };
v.contra.update = { params: uuidParam, body: Joi.object({ ...contraHeader, customerId: id, vendorId: id, amount, invoices: contraInvoices, bills: contraBills }).min(1) };

// the salary tax voucher: the withheld income tax paid to the government
const taxMonth = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/);
v.salaryTax = {
  ...common,
  list: { query: Joi.object({ ...listBase, month: taxMonth }) },
  slips: { query: Joi.object({ month: taxMonth.required() }) },
  create: { body: Joi.object({ voucherDate: date, paymentMode: header.paymentMode.required(), chequeDate: header.chequeDate, chequeNo: header.chequeNo, refNo: text(40), notes: header.notes,
    month: taxMonth.required(), payFromAccountId: id.required(), slipIds: Joi.array().items(id).min(1).max(2000) }) },
  update: { params: uuidParam, body: Joi.object({ voucherDate: date, paymentMode: header.paymentMode, chequeDate: header.chequeDate, chequeNo: header.chequeNo, refNo: text(40), notes: header.notes, payFromAccountId: id }).min(1) },
};
