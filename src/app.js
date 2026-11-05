// Builds the Express app. Every request passes through these steps in this order.
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { verifyAccessToken } = require('./utils/tokens');
const env = require('./config/env');
const requestLogger = require('./middlewares/requestLogger');
const cors = require('./middlewares/cors');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const routes = require('./routes');

const app = express();

// We run behind one proxy (nginx / load balancer): trust it for the real client IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(requestLogger); // 1. request id + one log line per request
app.use(helmet()); // 2. browser security headers
app.use(cors); // 3. only our frontend may call from a browser
app.use(express.json({ limit: '1mb' })); // 4. read JSON bodies, refuse very large ones
// who the request is from, read from a valid access token (the signature is checked, so nobody can invent a bucket); null when not signed in
const signedInUser = (req) => {
  if (req.rateUser === undefined) {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    const payload = scheme === 'Bearer' && token ? verifyAccessToken(token) : null;
    req.rateUser = payload ? payload.sub : null;
  }
  return req.rateUser;
};
app.use(
  '/api',
  rateLimit({
    // 5. every signed-in person has their own bucket (RATE_LIMIT_USER_PER_MINUTE, default 1200 a minute), so people in one office
    //    behind one IP address do not use each other up; everyone else shares RATE_LIMIT_IP_PER_MINUTE (default 300) per IP
    windowMs: 60 * 1000,
    limit: (req) => (signedInUser(req) ? env.rateLimit.userPerMinute : env.rateLimit.ipPerMinute),
    keyGenerator: (req) => (signedInUser(req) ? `user:${signedInUser(req)}` : ipKeyGenerator(req.ip)),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest,
  }),
);

app.use('/api', routes); // 6. our routes

app.use(notFound); // 7. unknown URL
app.use(errorHandler); // 8. every error in one format

module.exports = app;
