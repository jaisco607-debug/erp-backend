// Runs before every protected route. Reads "Authorization: Bearer <access token>" and loads the user.
// Refused when: no token, bad/expired token, user deleted or deactivated,
// or the user's sessions were ended after this token was made (password change, logout from all devices),
// or the user's company has been switched off by the super admin.
const { User, Company } = require('../models');
const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/tokens');

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(AppError.unauthorized());

  const payload = verifyAccessToken(token);
  if (!payload) return next(AppError.unauthorized('Session expired, please log in again'));

  const user = await User.findByPk(payload.sub, { include: [{ model: Company, as: 'company' }] });
  if (!user || !user.isActive || user.tokenVersion !== payload.ver || (user.company && !user.company.isActive)) {
    return next(AppError.unauthorized('Session expired, please log in again'));
  }
  req.user = user;
  next();
}

module.exports = authenticate;
