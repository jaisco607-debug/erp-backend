// Reads settings from the .env file, checks them, and stops the server if something is wrong.
// Every other file takes its settings from here, never from process.env directly.
// Remember which settings the computer itself already had before .env was read: those win over .env.
const fromSystem = new Set(Object.keys(process.env));
const loaded = require('dotenv').config({ quiet: true });
const Joi = require('joi');

const isProduction = process.env.NODE_ENV === 'production';

// In production a short or sample secret would let anyone forge login tokens.
const secret = isProduction
  ? Joi.string().min(32).invalid('change-me-access', 'change-me-refresh').required()
  : Joi.string().min(8).required();

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  DATABASE_SSL: Joi.boolean().default(false),
  DATABASE_SSL_CA: Joi.string().allow('').default(''),
  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_SECRET: secret,
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('7d'),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // Login safety. Defaults are for real use; while testing you may shorten the minutes in .env.
  LOGIN_MAX_FAILED: Joi.number().integer().min(1).max(50).default(5),
  LOGIN_LOCK_MINUTES: Joi.number().integer().min(1).max(1440).default(15),
  LOGIN_IP_MAX: Joi.number().integer().min(1).max(1000).default(10),
  LOGIN_IP_WINDOW_MINUTES: Joi.number().integer().min(1).max(1440).default(15),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent').default('info'),
}).unknown(true);

const { value, error } = schema.validate(process.env, { abortEarly: false });
if (error) {
  // Only the setting names are printed, never their values.
  const names = error.details.map((d) => d.context.key).join(', ');
  throw new Error(`Invalid or missing settings in .env: ${names}`);
}

module.exports = {
  nodeEnv: value.NODE_ENV,
  isProduction: value.NODE_ENV === 'production',
  isTest: value.NODE_ENV === 'test',
  port: value.PORT,
  databaseUrl: value.DATABASE_URL,
  // Where DATABASE_URL came from, so a wrong database is easy to spot in the startup log.
  databaseUrlSource: fromSystem.has('DATABASE_URL') ? 'system environment (overrides .env)' : loaded.error ? 'missing .env' : '.env file',
  databaseSsl: value.DATABASE_SSL,
  databaseSslCa: value.DATABASE_SSL_CA,
  jwt: {
    accessSecret: value.JWT_ACCESS_SECRET,
    refreshSecret: value.JWT_REFRESH_SECRET,
    accessTtl: value.JWT_ACCESS_TTL,
    refreshTtl: value.JWT_REFRESH_TTL,
  },
  corsOrigins: value.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  login: {
    maxFailed: value.LOGIN_MAX_FAILED,
    lockMinutes: value.LOGIN_LOCK_MINUTES,
    ipMax: value.LOGIN_IP_MAX,
    ipWindowMinutes: value.LOGIN_IP_WINDOW_MINUTES,
  },
  logLevel: value.LOG_LEVEL,
};
