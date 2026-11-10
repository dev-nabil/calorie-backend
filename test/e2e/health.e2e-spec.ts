import { createTestApp, type TestApp } from '../setup/test-app';

describe('GET /v1/health (M0-T3)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('reports mongo up and the package version', async () => {
    const res = await t.http().get('/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', version: expect.stringMatching(/^\d+\.\d+\.\d+/), checks: { mongo: 'up' } });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('echoes a safe incoming request id', async () => {
    const res = await t.http().get('/v1/health').set('X-Request-Id', 'abc12345-req').expect(200);
    expect(res.headers['x-request-id']).toBe('abc12345-req');
  });

  it('renders unknown routes in the standard error shape', async () => {
    const res = await t.http().get('/v1/nope').expect(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String), details: {} } });
  });

  it('requires auth by default', async () => {
    const res = await t.http().get('/v1/me').expect((r) => expect([401, 404]).toContain(r.status));
    expect(res.body.error.code).toBeDefined();
  });

  it('rejects malformed JSON with BAD_REQUEST', async () => {
    const res = await t.http().post('/v1/health').set('Content-Type', 'application/json').send('{bad').expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('serves the swagger json outside production', async () => {
    const res = await t.http().get('/docs-json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.components.schemas.ErrorResponse).toBeDefined();
  });
});
