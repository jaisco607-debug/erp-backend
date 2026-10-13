// Checks the database settings in .env and tries to connect, without ever printing the password.
// Run: npm run db:check
const fromSystem = new Set(Object.keys(process.env));
const dotenv = require('dotenv');
const fs = require('fs');

const loaded = dotenv.config({ quiet: true });
const raw = process.env.DATABASE_URL || '';

console.log('\n=== Database settings check ===');
console.log('.env file found:          ', !loaded.error);
console.log('DATABASE_URL comes from:  ', fromSystem.has('DATABASE_URL') ? 'Windows/system environment (this OVERRIDES .env!)' : '.env');
if (fs.existsSync('.env')) {
  const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^\s*DATABASE_URL\s*=/.test(l));
  console.log('DATABASE_URL lines in .env:', lines.length, lines.length > 1 ? '(more than one! only the FIRST is used)' : '');
}

let url;
try {
  url = new URL(raw);
} catch {
  console.log('DATABASE_URL is not a valid address. Check for spaces or quotes.');
  process.exit(1);
}
const password = decodeURIComponent(url.password);
console.log('host:                     ', url.hostname);
console.log('port:                     ', url.port || '5432');
console.log('database:                 ', url.pathname.slice(1));
console.log('user:                     ', decodeURIComponent(url.username));
console.log('password length:          ', password.length);
console.log('password has [ or ]:      ', /[[\]]/.test(password));
console.log('password has spaces:      ', /\s/.test(password));
console.log('password has quotes:      ', /["']/.test(raw));
console.log('DATABASE_SSL:             ', process.env.DATABASE_SSL);
console.log('DATABASE_SSL_CA file:     ', process.env.DATABASE_SSL_CA || '(none)', process.env.DATABASE_SSL_CA ? `exists: ${fs.existsSync(process.env.DATABASE_SSL_CA)}` : '');
if (url.hostname.includes('pooler.supabase.com') && !decodeURIComponent(url.username).startsWith('postgres.')) {
  console.log('WARNING: Supabase pooler needs user "postgres.<project-ref>", not just "postgres".');
}

process.env.LOG_LEVEL = 'silent';
const { sequelize } = require('../src/config/database');
sequelize
  .authenticate()
  .then(() => console.log('\nRESULT: connected successfully\n'))
  .catch((err) => console.log('\nRESULT: failed:', err.parent?.message || err.message, '\n'))
  .finally(() => sequelize.close());
