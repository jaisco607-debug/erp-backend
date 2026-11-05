// Tests always use their own database (TEST_DATABASE_URL in .env), never real data.
// .env is read here first so TEST_DATABASE_URL and the SSL certificate path (DATABASE_SSL_CA) are found.
require('dotenv').config({ quiet: true });
const devUrl = process.env.DATABASE_URL; // kept for globalSetup: the test database must never be this one
const testUrl = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/erp_test';
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(new URL(testUrl).hostname);
process.env.NODE_ENV = 'test';
process.env.DEV_DATABASE_URL = devUrl || '';
process.env.DATABASE_URL = testUrl;
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.DATABASE_SSL = isLocal ? 'false' : 'true'; // a cloud database (Supabase) needs the encrypted connection
process.env.CORS_ORIGINS = 'http://localhost:5173'; // the CORS test must not depend on the developer's .env
