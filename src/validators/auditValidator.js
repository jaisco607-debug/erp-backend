const { Joi, paging } = require('./common');

module.exports = {
  list: {
    query: Joi.object({
      ...paging,
      action: Joi.string().max(60),
      actorId: Joi.string().guid(),
      companyId: Joi.string().guid(),
      entityType: Joi.string().max(60),
      entityId: Joi.string().max(64),
      from: Joi.date().iso(),
      to: Joi.date().iso(),
    }),
  },
};
