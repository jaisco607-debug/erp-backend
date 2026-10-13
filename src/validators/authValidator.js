const { Joi, email, newPassword, companyCode } = require('./common');

module.exports = {
  // companyCode: everyone types one. Super admins: the super admins' code; everyone else: their company's code.
  login: {
    body: Joi.object({
      companyCode: companyCode.required(),
      email: email.required(),
      password: Joi.string().max(128).required(),
    }),
  },
  refresh: { body: Joi.object({ refreshToken: Joi.string().max(200).required() }) },
  changePassword: {
    body: Joi.object({ currentPassword: Joi.string().max(128).required(), newPassword: newPassword.required() }),
  },
};
