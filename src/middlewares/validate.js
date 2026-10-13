// Checks the shape of incoming data before any controller sees it.
// Unknown fields are refused (nobody can sneak in "userType": "SUPER_ADMIN" on a form that does not offer it).
const AppError = require('../utils/AppError');

const OPTIONS = { abortEarly: false, allowUnknown: false, convert: true, errors: { wrap: { label: false } } };

/**
 * @param schemas { body, params, query } Joi schemas; any part not given must be empty.
 * The cleaned query goes to req.validatedQuery (Express 5 does not allow replacing req.query).
 */
function validate(schemas) {
  return (req, res, next) => {
    const details = [];
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const { value, error } = schema.validate(req[part] ?? {}, OPTIONS);
      if (error) {
        details.push(...error.details.map((d) => ({ field: [part, ...d.path].join('.'), message: d.message })));
      } else if (part === 'query') {
        req.validatedQuery = value;
      } else {
        req[part] = value;
      }
    }
    if (details.length) return next(AppError.validation(details));
    next();
  };
}

module.exports = validate;
