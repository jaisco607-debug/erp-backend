// Before all tests: empty the TEST database and build it again with the migrations.
// Refuses to run against any database whose name does not end in "_test", so real data is never touched.
const { execSync } = require('child_process');
const { Client } = require('pg');

module.exports = async () => {
  require('./setup');
  const url = process.env.DATABASE_URL;
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('Tests only run on a database whose name ends in _test');
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  execSync('npx sequelize-cli db:migrate', { stdio: 'ignore', env: process.env });
};
