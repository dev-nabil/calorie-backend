import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, INTEGRITY, signIn } from '../setup/helpers';
import { AppConfigService } from '../../src/modules/content/app-config.service';

describe('GET /v1/config and billing', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
  });
  afterAll(() => t.close());

  it('serves public config with ETag and no experiments when signed out', async () => {
    const res = await t.http().get('/v1/config').expect(200);
    expect(res.body).toMatchObject({
      flags: { 'paywall.onboarding': true },
      experiments: {},
      minAppVersion: { ios: '1.0.0', android: '1.0.0' },
      killSwitches: { vision: false, chat: false, extract: false, tts: false },
      contentVersions: { onboardingQuestions: 3 },
    });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    await t.http().get('/v1/config').set('If-None-Match', String(res.headers.etag)).expect(304);
  });

  it('assigns experiments once for a signed-in user and reflects kill switches', async () => {
    const s = await signIn(t);
    const a = await t.http().get('/v1/config').set(bearer(s.accessToken)).expect(200);
    expect(a.body.experiments).toEqual({ 'paywall.onboarding': 'on' });
    expect(a.headers['cache-control']).toBe('private, no-store');
    const me = await t.http().get('/v1/me').set(bearer(s.accessToken)).expect(200);
    expect(me.body.experiments).toEqual({ 'paywall.onboarding': 'on' });
    await t.get<AppConfigService>(AppConfigService).set('ai.kill.chat', true);
    const b = await t.http().get('/v1/config').set(bearer('invalid-token')).expect(200);
    expect(b.body.killSwitches.chat).toBe(true);
    expect(b.body.experiments).toEqual({});
    await t.get<AppConfigService>(AppConfigService).set('ai.kill.chat', false);
  });

  it('GET /billing/entitlement reports the free scan; sync keeps it with the stub store', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    const e = await t.http().get('/v1/billing/entitlement').set(h).expect(200);
    expect(e.body).toMatchObject({ plan: 'free', isPlus: false, freeScans: { allowance: 1, used: 0, remaining: 1 }, products: { monthly: 'nouri_plus_monthly', yearly: 'nouri_plus_yearly' } });
    const synced = await t.http().post('/v1/billing/sync').set(h).send({ platform: 'ios' }).expect(200);
    expect(synced.body.plan).toBe('free');
    await t.http().post('/v1/billing/sync').set(h).send({ store: 'x' }).expect(400);
    await t.http().get('/v1/billing/entitlement').expect(401);
  });

  it('dev routes: last OTP and the QA entitlement switch', async () => {
    const email = 'qa@example.com';
    await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email }).expect(200);
    const otp = await t.http().get('/v1/dev/last-otp').query({ email }).expect(200);
    expect(otp.body.code).toMatch(/^\d{6}$/);
    await t.http().get('/v1/dev/last-otp').query({ email: 'nobody@example.com' }).expect(404);
    const s = await t.http().post('/v1/auth/email/verify').send({ email, code: otp.body.code }).expect(200);
    const h = bearer(s.body.accessToken);
    await t.http().get('/v1/billing/entitlement').set(h).expect(200);
    await t.http().post('/v1/dev/entitlement').set(h).send({ plan: 'plus', period: 'yearly', days: 365 }).expect(200);
    expect((await t.http().get('/v1/billing/entitlement').set(h).expect(200)).body).toMatchObject({ plan: 'plus', isPlus: true, period: 'yearly' });
  });
});

describe('dev routes are absent unless enabled', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());
  it('404s /v1/dev/last-otp in the test environment', async () => {
    await t.http().get('/v1/dev/last-otp').query({ email: 'a@b.c' }).expect(404);
  });
});
