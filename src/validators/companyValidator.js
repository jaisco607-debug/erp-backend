const { Joi, email, newPassword, uuidParam, paging } = require('./common');

const optionalText = (max) => Joi.string().trim().max(max).allow('', null);
const serviceIds = Joi.array().items(Joi.string().guid()).unique().max(100);

module.exports = {
  list: { query: Joi.object({ ...paging, search: Joi.string().trim().max(100), isActive: Joi.boolean() }) },
  get: { params: uuidParam },
  create: {
    body: Joi.object({
      name: Joi.string().trim().min(2).max(150).required(),
      contactPerson: optionalText(120),
      phone: optionalText(30),
      address: optionalText(300),
      // The company's first client admin
      admin: Joi.object({
        name: Joi.string().trim().min(2).max(120).required(),
        email: email.required(),
        password: newPassword.required(),
      }).required(),
    }),
  },
  update: {
    params: uuidParam,
    body: Joi.object({
      name: Joi.string().trim().min(2).max(150),
      contactPerson: optionalText(120),
      phone: optionalText(30),
      address: optionalText(300),
      isActive: Joi.boolean(),
    }).min(1),
  },
  // The company code is made by the server only. If it leaks, the super admin asks for a new one.
  newCode: { params: uuidParam },
  remove: { params: uuidParam },
  updateAdmin: {
    params: Joi.object({ id: Joi.string().guid().required(), userId: Joi.string().guid().required() }),
    body: Joi.object({ name: Joi.string().trim().min(2).max(120), email, phone: optionalText(30), isActive: Joi.boolean() }).min(1),
  },
  createAdmin: {
    params: uuidParam,
    body: Joi.object({ name: Joi.string().trim().min(2).max(120).required(), email: email.required(), phone: optionalText(30), password: newPassword.required() }),
  },
  deleteAdmin: { params: Joi.object({ id: Joi.string().guid().required(), userId: Joi.string().guid().required() }) },
  resetAdminPassword: {
    params: Joi.object({ id: Joi.string().guid().required(), userId: Joi.string().guid().required() }),
    body: Joi.object({ newPassword: newPassword.required() }),
  },
  toggleService: {
    params: Joi.object({ id: Joi.string().guid().required(), serviceId: Joi.string().guid().required() }),
    body: Joi.object({ enabled: Joi.boolean().required() }),
  },
  setServices: { params: uuidParam, body: Joi.object({ serviceIds: serviceIds.required() }) },
};
