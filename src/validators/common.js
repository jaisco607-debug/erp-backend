// Rules shared by several forms.
const Joi = require('joi');
const { PATTERN, normalize: normalizeCode } = require('../utils/companyCode');

const email = Joi.string().trim().lowercase().email({ tlds: false }).max(200);

// At least 10 characters with a capital letter, a small letter and a digit.
const newPassword = Joi.string()
  .min(10)
  .max(128)
  .pattern(/[A-Z]/, 'capital letter')
  .pattern(/[a-z]/, 'small letter')
  .pattern(/[0-9]/, 'digit')
  .messages({ 'string.pattern.name': 'password needs at least one {#name}' });

// Company login code as typed at login, e.g. "K7QM-4XPA" (small letters, spaces or no dash are fine).
const companyCode = Joi.string().trim().max(20).custom((value, helpers) => {
  const code = normalizeCode(value);
  return PATTERN.test(code) ? code : helpers.error('string.pattern.name', { name: 'company code' });
}).messages({ 'string.pattern.name': 'company code looks like K7QM-4XPA (8 letters/digits)' });

const uuidParam = Joi.object({ id: Joi.string().guid({ version: 'uuidv4' }).required() });

const paging = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
};

module.exports = { Joi, email, newPassword, companyCode, uuidParam, paging };
