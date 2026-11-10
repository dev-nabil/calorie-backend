import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, seedAdmins, signIn } from '../setup/helpers';
import { buildOpenApi } from '../../src/app.setup';
import { clock } from '../../src/common/clock';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { EmailSender, type MemoryEmailSender } from '../../src/modules/auth/providers';

describe('QA pass 3 regressions (B12–B18, dev clock)', () => {
  let t: TestApp;
  let login: Awaited<ReturnType<typeof seedAdmins>>;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
    login = await seedAdmins(t);
  });
  afterEach(() => {
    clock.setOffset(0);
    t.get<FakeAiProvider>(AiProvider).reset();
  });
  afterAll(() => t.close());

  const parse = (h: Record<string, string>) => t.http().post('/v1/meals/parse').set(h).set(INTEGRITY).send({ text: 'toast' });

  it('B12/B14: failed AI calls never consume the free quota; it resets at local midnight', async () => {
    const h = bearer((await signIn(t)).accessToken);
    await t.http().patch('/v1/me').set(h).send({ timezone: 'Asia/Tokyo' }).expect(200);
    await t.http().post('/v1/dev/ai-mode').send({ mode: 'fail' }).expect(200);
    for (let i = 0; i < 4; i++) {
      const r = await parse(h).expect(503);
      expect(r.body.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'provider_error', retryAfterSec: 30 } });
    }
    await t.http().post('/v1/dev/ai-mode').send({ mode: 'ok' }).expect(200);
    for (let i = 0; i < 3; i++) await parse(h).expect(200);
    expect((await parse(h).expect(402)).body.error.code).toBe('AI_LIMIT_REACHED');
    clock.setOffset(24 * 3600_000); // next local day in Tokyo
    await parse(h).expect(200);
  });

  it('B12: coach quota is consumed on success only; degraded answers are free', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = (await t.http().post('/v1/conversations').set(h).set(idem()).send({ type: 'coach' }).expect(201)).body;
    const say = (body: object) => t.http().post(`/v1/conversations/${c.id}/turns`).set(h).set(INTEGRITY).send({ inputMethod: 'typed', ...body });
    await t.http().post('/v1/dev/ai-mode').send({ mode: 'unavailable' }).expect(200);
    for (let i = 0; i < 12; i++) await say({ text: 'hi' }).expect(503);
    for (let i = 0; i < 3; i++) await say({ quickAction: 'review_day', inputMethod: 'chip' }).expect(200); // degraded templates
    await t.http().post('/v1/dev/ai-mode').send({ mode: 'ok' }).expect(200);
    for (let i = 0; i < 10; i++) await say({ text: `q${i}` }).expect(200);
    expect((await say({ text: 'one more' }).expect(402)).body.error.code).toBe('AI_LIMIT_REACHED');
  });

  it('B13: saving one experiment keeps the defaults in /v1/config', async () => {
    const admin = await login('admin');
    await t.http().put('/v1/admin/experiments').set(admin).send({ reason: 'start scan test', experiment: { key: 'freeScans.allowance', status: 'running', allocationPct: 100, variants: [{ id: '1', weight: 100, value: 1 }, { id: '3', weight: 0, value: 3 }] } }).expect(200);
    const user = bearer((await signIn(t)).accessToken);
    const cfg = await t.http().get('/v1/config').set(user).expect(200);
    expect(cfg.body.experiments).toEqual({ 'paywall.onboarding': 'on', 'freeScans.allowance': '1' });
  });

  it('B15: confirmed answers keep the typed input method', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = (await t.http().post('/v1/conversations').set(h).set(idem()).send({ type: 'onboarding' }).expect(201)).body;
    const turn = (body: object) => t.http().post(`/v1/conversations/${c.id}/turns`).set(h).set(INTEGRITY).send(body).expect(200);
    await turn({ chipIndex: 0, inputMethod: 'chip' });
    expect((await turn({ text: "I'm Kim and want to lose weight", inputMethod: 'typed' })).body.needsConfirmation).toBe(true);
    await t.http().post(`/v1/conversations/${c.id}/confirm`).set(h).send({ accept: true }).expect(200);
    const state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
    expect(state.body.answers.find((a: { questionId: string }) => a.questionId === 'q05').inputMethod).toBe('typed');
  });

  it('B16: unknown flags are rejected', async () => {
    const admin = await login('admin');
    const r = await t.http().put('/v1/admin/flags').set(admin).send({ key: 'made.up', enabled: true, reason: 'typo test' }).expect(400);
    expect(r.body.error.details.known).toContain('paywall.onboarding');
  });

  it('B18: admin operations declare the cookie scheme and 401/403', () => {
    const doc = buildOpenApi(t.app) as unknown as { paths: Record<string, Record<string, { security?: unknown; responses: Record<string, unknown> }>>; components: { securitySchemes: Record<string, unknown> } };
    expect(doc.components.securitySchemes.adminSession).toMatchObject({ type: 'apiKey', in: 'cookie', name: '__Host-nouri_admin' });
    const bad: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      if (!path.startsWith('/v1/admin/') || ['/v1/admin/auth/login', '/v1/admin/auth/totp', '/v1/admin/auth/accept-invite'].includes(path)) continue;
      for (const [method, op] of Object.entries(item)) {
        if (JSON.stringify(op.security) !== JSON.stringify([{ adminSession: [] }]) || !op.responses['401'] || !op.responses['403']) bad.push(`${method} ${path}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('dev clock: OTP codes expire and admin sessions idle out', async () => {
    const email = 'clocky@example.com';
    await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email }).expect(200);
    clock.setOffset(11 * 60_000);
    const code = t.get<MemoryEmailSender>(EmailSender).outbox.get(email);
    expect((await t.http().post('/v1/auth/email/verify').send({ email, code }).expect(401)).body.error.code).toBe('OTP_EXPIRED');
    clock.setOffset(0);
    const admin = await login('owner');
    await t.http().get('/v1/admin/auth/session').set(admin).expect(200);
    clock.setOffset(31 * 60_000);
    await t.http().get('/v1/admin/auth/session').set(admin).expect(401);
  });
});
