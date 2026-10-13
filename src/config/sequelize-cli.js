// Settings used by the migration command (npm run db:migrate). Same database as the app.
const env = require('./env');
const { sslOptions } = require('./ssl');

const config = {
  url: env.databaseUrl,
  dialect: 'postgres',
  dialectOptions: sslOptions(),
  migrationStorageTableName: 'sequelize_migrations',
};

module.exports = { development: config, test: config, production: config };
