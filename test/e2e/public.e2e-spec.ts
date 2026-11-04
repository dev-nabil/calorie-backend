import { createTestApp, type TestApp } from '../setup/test-app';
import { TurnstileVerifier } from '../../src/modules/public/turnstile.verifier';

describe('Public endpoints (M8-T2)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({}, (b) =>
      b.overrideProvider(TurnstileVerifier).useValue({ verify: async (token: string) => token !== 'bot' }),
    );
  });
  afterAll(() => t.close());

  it('joins the waitlist once', async () => {
    const body = { email: 'Fan@Example.com', turnstileToken: 'ok', source: 'home', utm: { campaign: 'launch' } };
    expect((await t.http().post('/v1/public/waitlist').send(body).expect(200)).body).toEqual({ status: 'joined' });
    expect((await t.http().post('/v1/public/waitlist').send(body).expect(200)).body).toEqual({ status: 'already_joined' });
  });

  it('rejects bots and bad input', async () => {
    const bot = await t.http().post('/v1/public/waitlist').send({ email: 'b@example.com', turnstileToken: 'bot' }).expect(403);
    expect(bot.body.error.code).toBe('FORBIDDEN');
    await t.http().post('/v1/public/waitlist').send({ email: 'nope', turnstileToken: 'ok' }).expect(400);
    await t.http().post('/v1/public/waitlist').send({ email: 'a@example.com' }).expect(400);
  });

  it('always answers deletion requests with 202 received', async () => {
    const res = await t.http().post('/v1/public/deletion-requests').send({ email: 'nobody@example.com', turnstileToken: 'ok' }).expect(202);
    expect(res.body).toEqual({ status: 'received' });
  });

  it('allows the dev web and admin origins with the needed headers', async () => {
    const res = await t
      .http()
      .options('/v1/public/waitlist')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key,x-csrf-token');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(res.headers['access-control-allow-headers']).toMatch(/X-CSRF-Token/i);
  });
});
