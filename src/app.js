// Builds the Express app. Every request passes through these steps in this order.
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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
app.use(
  '/api',
  rateLimit({
    // 5. at most 300 requests per minute per IP
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest,
  }),
);

app.use('/api', routes); // 6. our routes

app.use(notFound); // 7. unknown URL
app.use(errorHandler); // 8. every error in one format

module.exports = app;
