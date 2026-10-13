// Gives every request an id and writes one log line when it finishes:
// method, path, status, time taken, client IP and (once logged in) the user id.
// Request bodies and query values are not logged.
const { randomUUID } = require('crypto');
const pinoHttp = require('pino-http');
const logger = require('../utils/logger');

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

module.exports = pinoHttp({
  logger,
  // Keep the id sent by our own proxy if it looks safe, otherwise make a new one.
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  customProps: (req) => ({ userId: req.user?.id, companyId: req.user?.companyId }),
  serializers: {
    req: (req) => ({ method: req.method, url: req.url.split('?')[0], ip: req.remoteAddress }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
