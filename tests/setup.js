// Tests always use their own database (erp_test), never real data.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/erp_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.DATABASE_SSL = 'false';
process.env.CORS_ORIGINS = 'http://localhost:5173'; // the CORS test must not depend on the developer's .env
