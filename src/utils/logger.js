// The one logger for the whole app. Writes JSON lines that any log system can read.
// Passwords, tokens and auth headers are replaced with [REDACTED] before anything is written.
const pino = require('pino');
const env = require('../config/env');

const logger = pino({
  level: env.isTest ? 'silent' : env.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
