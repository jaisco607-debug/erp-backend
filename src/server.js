// Starting point: connect to the database, then start listening for requests.
const env = require('./config/env');
const logger = require('./utils/logger');
const { sequelize, connectDatabase } = require('./config/database');
const app = require('./app');

async function start() {
  await connectDatabase();
  const server = app.listen(env.port, () => logger.info(`Textile ERP API listening on port ${env.port}`));

  // Edit locks that ran out long ago are removed every 10 minutes (an expired lock is already free; this only tidies the table).
  setInterval(() => require('./services/lockService').cleanup().catch((err) => logger.warn({ err }, 'Lock cleanup failed')), 10 * 60 * 1000).unref();

  // On shutdown, stop taking new requests, let running ones finish, then close the database.
  const stop = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await sequelize.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled promise rejection');
});

start().catch((err) => {
  logger.fatal({ err }, 'Server failed to start');
  process.exit(1);
});
