// Lets a company person through only when they may use this service, e.g. requireService('GREY_STORE', 'FULL').
//   CLIENT_ADMIN  every service the company has (always FULL)
//   USER          only services the client admin gave them; 'VIEW' routes accept VIEW or FULL,
//                 'FULL' routes need FULL
// Super admins manage the platform, not a company's data, so they are refused here.
// Sets req.access = 'VIEW' | 'FULL'. Use after authenticate.
const AppError = require('../utils/AppError');
const { companyServices, userServices } = require('../services/accessService');

const requireService = (code, level = 'VIEW') => async (req, res, next) => {
  const { user } = req;
  if (!user || !user.companyId) return next(AppError.forbidden());

  let access = null;
  if (user.userType === 'CLIENT_ADMIN') {
    access = (await companyServices(user.companyId)).some((s) => s.code === code) ? 'FULL' : null;
  } else {
    access = (await userServices(user)).find((g) => g.service.code === code)?.access ?? null;
  }
  if (!access) return next(AppError.forbidden('You do not have this service'));
  if (level === 'FULL' && access !== 'FULL') return next(AppError.forbidden('You can only view this service'));
  req.access = access;
  next();
};

module.exports = requireService;
