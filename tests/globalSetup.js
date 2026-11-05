// Before all tests: empty the TEST database and build it again with the migrations.
// Refuses to run unless it is clearly NOT the real database:
//   - its name ends in "_test" (a local database), or
//   - it is a cloud database given by TEST_DATABASE_URL that differs from the real one (DATABASE_URL, from .env or the system) in user, host, port or name.
// Supabase always names its database "postgres", so the second rule is what protects a cloud test project.
const fs = require('fs');
const { execSync } = require('child_process');
const { Client } = require('pg');

const where = (u) => { const x = new URL(u); return `${decodeURIComponent(x.username)}@${x.hostname}:${x.port || '5432'}${x.pathname}`; };

module.exports = async () => {
  require('./setup');
  const url = process.env.DATABASE_URL;
  const dev = process.env.DEV_DATABASE_URL;
  const nameOk = new URL(url).pathname.endsWith('_test');
  // the real database must be KNOWN and different: when DATABASE_URL cannot be found, nothing cloud is wiped
  const cloudOk = Boolean(process.env.TEST_DATABASE_URL) && Boolean(dev) && where(dev) !== where(url);
  if (!nameOk && !cloudOk) {
    throw new Error('Tests only run on a database whose name ends in _test, or on a TEST_DATABASE_URL that is not the real DATABASE_URL (which must be set in .env or the system, so the two can be compared)');
  }
  const ssl = process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: true, ...(process.env.DATABASE_SSL_CA ? { ca: fs.readFileSync(process.env.DATABASE_SSL_CA, 'utf8') } : {}) }
    : undefined;
  const client = new Client({ connectionString: url, ssl });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  execSync('npx sequelize-cli db:migrate', { stdio: 'ignore', env: process.env });
};
