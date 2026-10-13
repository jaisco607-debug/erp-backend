// Which websites may call this API from a browser. Only the frontend address(es) in CORS_ORIGINS.
// In development an empty list allows any site; in production an empty list allows none.
const env = require('../config/env');

module.exports = function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowAny = env.corsOrigins.length === 0 && !env.isProduction;
  if (origin && (allowAny || env.corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
};
