// Like requireService, but the person may have ANY of several services, e.g. requireAnyService(['SO_CARD', 'DYEING'], 'FULL').
//   CLIENT_ADMIN  every service the company has (always FULL)
//   USER          the services the client admin gave them: VIEW passes with VIEW or FULL on any of them,
//                 FULL needs FULL on at least one of them
// Sets req.access = 'VIEW' | 'FULL' (the best the person has among these services). Use after authenticate.
const AppError = require('../utils/AppError');
const { companyServices, userServices } = require('../services/accessService');

const requireAnyService = (codes, level = 'VIEW') => async (req, res, next) => {
  const { user } = req;
  if (!user || !user.companyId) return next(AppError.forbidden());

  const mine = user.userType === 'CLIENT_ADMIN'
    ? (await companyServices(user.companyId)).filter((s) => codes.includes(s.code)).map(() => 'FULL')
    : (await userServices(user)).filter((g) => codes.includes(g.service.code)).map((g) => g.access);
  if (!mine.length) return next(AppError.forbidden('You do not have this service'));
  if (level === 'FULL' && !mine.includes('FULL')) return next(AppError.forbidden('You can only view this service'));
  req.access = mine.includes('FULL') ? 'FULL' : 'VIEW';
  next();
};

module.exports = requireAnyService;
