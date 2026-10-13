const { Joi, email, newPassword, uuidParam, paging } = require('./common');

module.exports = {
  list: { query: Joi.object({ ...paging, search: Joi.string().trim().max(100), isActive: Joi.boolean() }) },
  create: {
    body: Joi.object({ name: Joi.string().trim().min(2).max(120).required(), email: email.required(), password: newPassword.required() }),
  },
  update: {
    params: uuidParam,
    body: Joi.object({ name: Joi.string().trim().min(2).max(120), isActive: Joi.boolean() }).min(1),
  },
  resetPassword: { params: uuidParam, body: Joi.object({ newPassword: newPassword.required() }) },
};
