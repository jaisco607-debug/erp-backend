const { Joi, email, newPassword, uuidParam, paging } = require('./common');
const { ACCESS_LEVELS } = require('../models/UserService');
const { CODES, DEFAULT_JOB_ROLE } = require('../utils/jobRoles');

// [{ "serviceId": "...", "access": "VIEW" | "FULL" }], each service once
const phone = Joi.string().trim().max(30).allow('', null);

const services = Joi.array()
  .items(Joi.object({ serviceId: Joi.string().guid().required(), access: Joi.string().uppercase().valid(...ACCESS_LEVELS).required() }))
  .unique('serviceId')
  .max(100);

const jobRole = Joi.string().trim().uppercase().valid(...CODES);
// ?jobRole=ACCOUNTANT or ?jobRole=ACCOUNTANT,MANAGER or ?jobRole=ACCOUNTANT&jobRole=MANAGER
const jobRoleFilter = Joi.alternatives(
  Joi.array().items(jobRole).single().min(1).max(CODES.length),
  Joi.string().pattern(/^[A-Za-z_,]+$/).custom((v, h) => {
    const roles = v.toUpperCase().split(',').filter(Boolean);
    return roles.length && roles.every((r) => CODES.includes(r)) ? roles : h.error('any.invalid');
  }),
);

module.exports = {
  list: { query: Joi.object({ ...paging, search: Joi.string().trim().max(100), isActive: Joi.boolean(), jobRole: jobRoleFilter }) },
  serviceOptions: {},
  roles: {},
  get: { params: uuidParam },
  create: {
    body: Joi.object({
      name: Joi.string().trim().min(2).max(120).required(),
      email: email.required(),
      phone,
      password: newPassword.required(),
      jobRole: jobRole.default(DEFAULT_JOB_ROLE),
      services: services.default([]),
    }),
  },
  update: {
    params: uuidParam,
    body: Joi.object({ name: Joi.string().trim().min(2).max(120), email, phone, isActive: Joi.boolean(), jobRole }).min(1),
  },
  resetPassword: { params: uuidParam, body: Joi.object({ newPassword: newPassword.required() }) },
  setServices: { params: uuidParam, body: Joi.object({ services: services.required() }) },
};
