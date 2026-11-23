// Extra limit on the login route only: LOGIN_IP_MAX FAILED tries per LOGIN_IP_WINDOW_MINUTES from one real client address (default 10 per 15).
// Successful logins are not counted, so one person's mistakes or a busy office do not lock others out. (The account lock after 5 wrong passwords protects one account.)
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');
const { clientIp } = require('./clientIp');

module.exports = rateLimit({
  windowMs: env.login.ipWindowMinutes * 60 * 1000,
  limit: env.login.ipMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  skip: () => env.isTest,
  handler: (req, res) => {
    req.log.warn('Too many failed login attempts from one IP');
    res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: `Too many attempts, try again in ${env.login.ipWindowMinutes} minute(s)` } });
  },
});
