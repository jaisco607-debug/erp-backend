const { Joi, uuidParam } = require('./common');

module.exports = {
  // kind: one or more of MODULE, PROCESS, FOLDING, e.g. ?kind=PROCESS&kind=FOLDING (or ?kind=PROCESS,FOLDING)
  list: {
    query: Joi.object({
      isActive: Joi.boolean(),
      kind: Joi.alternatives(Joi.array().items(Joi.string().uppercase().valid('MODULE', 'PROCESS', 'FOLDING')).single(),
        Joi.string().pattern(/^[A-Za-z,]+$/).custom((v, h) => {
          const kinds = v.toUpperCase().split(',').filter(Boolean);
          return kinds.every((k) => ['MODULE', 'PROCESS', 'FOLDING'].includes(k)) ? kinds : h.error('any.invalid');
        })),
    }),
  },
  create: {
    body: Joi.object({
      // Capital letters, digits and _ , e.g. "WASHING"
      code: Joi.string().trim().uppercase().max(40).pattern(/^[A-Z][A-Z0-9_]*$/, 'service code')
        .messages({ 'string.pattern.name': 'code may only have capital letters, digits and _' }).required(),
      name: Joi.string().trim().min(2).max(120).required(),
      kind: Joi.string().valid('MODULE', 'PROCESS', 'FOLDING').default('PROCESS'),
      tracksColour: Joi.boolean().default(true),
      sortOrder: Joi.number().integer().min(0).max(100000),
    }),
  },
  companies: { params: uuidParam },
  setCompanies: { params: uuidParam, body: Joi.object({ companyIds: Joi.array().items(Joi.string().guid()).unique().max(1000).required() }) },
  addCompanies: { params: uuidParam, body: Joi.object({ companyIds: Joi.array().items(Joi.string().guid()).unique().min(1).max(1000).required() }) },
  update: {
    params: uuidParam,
    body: Joi.object({
      name: Joi.string().trim().min(2).max(120),
      tracksColour: Joi.boolean(),
      isActive: Joi.boolean(),
      sortOrder: Joi.number().integer().min(0).max(100000),
    }).min(1),
  },
};
