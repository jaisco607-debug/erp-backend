// Lets only the listed kinds of user through, e.g. requireUserType('SUPER_ADMIN').
// Use after authenticate.
const AppError = require('../utils/AppError');

const requireUserType = (...types) => (req, res, next) => {
  if (!req.user || !types.includes(req.user.userType)) return next(AppError.forbidden());
  next();
};

module.exports = requireUserType;
