// Encrypted (SSL) connection settings for cloud databases such as Supabase.
// The server's certificate is always checked, so nobody in between can pretend to be the database.
// Providers that use their own certificate authority (Supabase does) give a .crt file:
// put its path in DATABASE_SSL_CA.
const fs = require('fs');
const env = require('./env');

function sslOptions() {
  if (!env.databaseSsl) return {};
  const ssl = { require: true, rejectUnauthorized: true };
  if (env.databaseSslCa) ssl.ca = fs.readFileSync(env.databaseSslCa, 'utf8');
  return { ssl };
}

module.exports = { sslOptions };
