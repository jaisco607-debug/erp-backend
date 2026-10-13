// Extra limit on the login and refresh routes only: LOGIN_IP_MAX tries per LOGIN_IP_WINDOW_MINUTES from one IP (default 10 per 15).
// (The account lock after 5 wrong passwords protects one account; this protects against trying many accounts.)
const rateLimit = require('express-rate-limit');
const env = require('../config/env');

module.exports = rateLimit({
  windowMs: env.login.ipWindowMinutes * 60 * 1000,
  limit: env.login.ipMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.isTest,
  handler: (req, res) => {
    req.log.warn('Too many login attempts from one IP');
    res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: `Too many attempts, try again in ${env.login.ipWindowMinutes} minute(s)` } });
  },
});
