const request = require('supertest');
const app = require('../src/app');
const { sequelize } = require('../src/config/database');

afterAll(() => sequelize.close());

describe('App setup: health, errors and security', () => {
  test('health answers ok when the database answers, with a request id', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('sends security headers and hides that this is Express', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('unknown URL and broken JSON come back in the standard error format', async () => {
    expect((await request(app).get('/api/v1/nothing').expect(404)).body.error.code).toBe('NOT_FOUND');
    const bad = await request(app).post('/api/v1/nothing').set('content-type', 'application/json').send('{bad').expect(400);
    expect(bad.body.error).toMatchObject({ code: 'BAD_JSON', message: 'Request body is not valid JSON', details: { line: 1, column: 2, character: 'U+0062 (b)' } });
    expect(JSON.stringify(bad.body)).not.toContain('{bad');
  });

  test('refuses request bodies over 1 MB', async () => {
    const big = JSON.stringify({ x: 'a'.repeat(1_100_000) });
    await request(app).post('/api/v1/nothing').set('content-type', 'application/json').send(big).expect(413);
  });

  test('keeps a safe request id from the proxy and replaces an unsafe one', async () => {
    expect((await request(app).get('/api/health').set('X-Request-Id', 'abc12345-trace')).headers['x-request-id']).toBe('abc12345-trace');
    expect((await request(app).get('/api/health').set('X-Request-Id', '<script>')).headers['x-request-id']).not.toBe('<script>');
  });

  test('allows the configured frontend in CORS', async () => {
    const res = await request(app).options('/api/health').set('Origin', 'http://localhost:5173').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
