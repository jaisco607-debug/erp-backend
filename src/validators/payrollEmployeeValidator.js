const { Joi, uuidParam, email } = require('./common');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
const text = (max) => Joi.string().trim().max(max).allow('', null);

// CNIC: 13 digits, with or without the dashes; the server keeps it as 42301-1448872-9
const cnic = Joi.string().trim().allow('', null).custom((v, h) => {
  if (v === '') return v;
  const digits = v.replace(/-/g, '');
  if (!/^\d{13}$/.test(digits) || /[^\d-]/.test(v)) return h.error('any.invalid');
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}).messages({ 'any.invalid': 'CNIC looks like 42301-1448872-9 (13 digits)' });

const phone = Joi.string().trim().pattern(/^[0-9+\-\s()]{7,30}$/).allow('', null).messages({ 'string.pattern.base': 'phone has digits only (7 to 30 characters, + - and spaces allowed)' });

// an amount: a decimal string ("89000.50") or a number with at most 2 decimals, never negative
const money = Joi.alternatives().try(
  Joi.string().trim().pattern(/^\d{1,10}(\.\d{1,2})?$/).messages({ 'string.pattern.base': 'an amount looks like 89000 or 89000.50' }),
  Joi.number().strict().precision(2).min(0).max(9999999999),
);

// IBAN: PK + 22 characters (24 in all): PK, 2 check digits, 4 letters of the bank, 16 letters / digits. Spaces are dropped and capitals are kept.
const iban = Joi.string().trim().allow('', null).custom((v, h) => {
  if (v === '') return v;
  const compact = v.replace(/\s+/g, '').toUpperCase();
  return /^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/.test(compact) ? compact : h.error('any.invalid');
}).messages({ 'any.invalid': 'IBAN looks like PK36SCBL0000001123456702 (PK + 22 characters)' });

// the EOBI number and the SESSI / SCSSI number: free text, up to 30 characters
const regNo = Joi.string().trim().max(30).allow('', null);

const fields = {
  name: Joi.string().trim().uppercase().min(2).max(150), // kept in capitals
  fatherName: Joi.string().trim().uppercase().max(150).allow('', null),
  motherName: Joi.string().trim().uppercase().max(150).allow('', null),
  cnic, ntn: text(20),
  dateOfBirth: date.allow(null),
  gender: Joi.string().valid('MALE', 'FEMALE', 'OTHER').allow(null),
  maritalStatus: Joi.string().valid('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED').allow(null),
  religion: text(40), language: text(40), phone, email: email.allow('', null), address: text(300),
  groupId: id, departmentId: id.allow(null), designationId: id.allow(null), shiftId: id.allow(null),
  joiningDate: date,
  salaryType: Joi.string().valid('MONTHLY', 'FIXED', 'DAILY'),
  basicSalary: money, foodAllowance: money, maintenanceAllowance: money, mobileAllowance: money, monthlyIncomeTax: money.allow(null), eobiNo: regNo, scssiNo: regNo,
  paymentMethod: Joi.string().valid('BANK', 'CASH'),
  bankId: id.allow(null), accountNo: text(40), iban, accountTitle: text(120),
};
const required = (...keys) => Object.fromEntries(keys.map((k) => [k, fields[k].required()]));

const paging = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(1000).default(100) };
const kind = Joi.string().valid('photo', 'cnic-front', 'cnic-back').required();

module.exports = {
  fields, // reused by the joining application, which is the same form
  list: {
    query: Joi.object({
      ...paging, search: Joi.string().trim().max(100), code: Joi.number().integer().min(1), name: Joi.string().trim().max(100), cnicOrCell: Joi.string().trim().max(40),
      groupId: id, departmentId: id, designationId: id, shiftId: id, status: Joi.string().valid('DRAFT', 'CONFIRMED'),
      closed: Joi.string().valid('true', 'false', 'all').default('false'), // false = the working employees (default), true = the closed ones, all = both
    }),
  },
  summary: {},
  get: { params: uuidParam },
  create: { body: Joi.object({ code: Joi.number().strict().integer().min(1).max(99999999), ...fields, ...required('name', 'groupId', 'joiningDate') }) },
  update: { params: uuidParam, body: Joi.object(fields).min(1) },
  close: { params: uuidParam, body: Joi.object({ leavingDate: date.required() }) },
  file: { params: Joi.object({ id: Joi.string().guid({ version: 'uuidv4' }).required(), kind }) },
};
