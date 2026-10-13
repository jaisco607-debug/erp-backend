// One shared connection (pool) to PostgreSQL, used by every model.
const { Sequelize } = require('sequelize');
const env = require('./env');
const { sslOptions } = require('./ssl');
const logger = require('../utils/logger');

const sequelize = new Sequelize(env.databaseUrl, {
  dialect: 'postgres',
  // SQL is not printed; slow or failing queries show up through errors instead.
  logging: false,
  dialectOptions: sslOptions(),
  pool: { max: 10, min: 0, idle: 10_000, acquire: 30_000 },
  define: {
    // createdAt / updatedAt on every table, and camelCase column names everywhere.
    timestamps: true,
    underscored: false,
  },
});

async function connectDatabase() {
  // Log where we connect (never the password), so a wrong address in .env is easy to see.
  const url = new URL(env.databaseUrl);
  const target = { host: url.hostname, port: url.port || '5432', database: url.pathname.slice(1), user: decodeURIComponent(url.username), from: env.databaseUrlSource };
  logger.info({ database: target }, 'Connecting to database');
  await sequelize.authenticate();
  logger.info('Database connected');
}

module.exports = { sequelize, connectDatabase };
