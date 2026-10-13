const { Joi, email, newPassword, uuidParam, paging } = require('./common');
const { ACCESS_LEVELS } = require('../models/UserService');

// [{ "serviceId": "...", "access": "VIEW" | "FULL" }], each service once
const services = Joi.array()
  .items(Joi.object({ serviceId: Joi.string().guid().required(), access: Joi.string().uppercase().valid(...ACCESS_LEVELS).required() }))
  .unique('serviceId')
  .max(100);

module.exports = {
  list: { query: Joi.object({ ...paging, search: Joi.string().trim().max(100), isActive: Joi.boolean() }) },
  get: { params: uuidParam },
  create: {
    body: Joi.object({
      name: Joi.string().trim().min(2).max(120).required(),
      email: email.required(),
      password: newPassword.required(),
      services: services.default([]),
    }),
  },
  update: {
    params: uuidParam,
    body: Joi.object({ name: Joi.string().trim().min(2).max(120), isActive: Joi.boolean() }).min(1),
  },
  resetPassword: { params: uuidParam, body: Joi.object({ newPassword: newPassword.required() }) },
  setServices: { params: uuidParam, body: Joi.object({ services: services.required() }) },
};
