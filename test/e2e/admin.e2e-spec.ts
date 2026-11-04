import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, signIn } from '../setup/helpers';
import { encryptSecret, hashPassword, newTotpSecret, totp } from '../../src/modules/admin/security/admin-crypto';
import type { AdminRole } from '../../src/modules/admin/schemas/admin.schema';

const PASSWORD = 'correct-horse-battery';

describe('Admin API (/v1/admin, M7)', () => {
  let t: TestApp;
  const secrets = new Map<string, string>();
  beforeAll(async () => {
    t = await createTestApp();
    const admins = t.get<Model<unknown>>(getModelToken('AdminUser'));
    for (const role of ['owner', 'admin', 'support', 'editor', 'analyst'] as AdminRole[]) {
      const secret = newTotpSecret();
      secrets.set(role, secret);
      await admins.create({ email: `${role}@nouri.dev`, role, passwordHash: hashPassword(PASSWORD), totpSecretEnc: encryptSecret(secret, t.config.OTP_PEPPER) });
    }
  });
  afterAll(() => t.close());

  async function login(role: AdminRole): Promise<Record<string, string>> {
    await t.get<Model<unknown>>(getModelToken('AdminUser')).updateOne({ email: `${role}@nouri.dev` }, { $set: { lastTotpStep: null } });
    const l = await t.http().post('/v1/admin/auth/login').send({ email: `${role}@nouri.dev`, password: PASSWORD }).expect(200);
    const s = await t.http().post('/v1/admin/auth/totp').send({ challengeId: l.body.challengeId, code: totp(secrets.get(role)!) }).expect(200);
    const cookies = (s.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
    const csrf = cookies.find((c) => c.startsWith('nouri_admin_csrf='))!.split('=')[1]!;
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': csrf };
  }

  it('signs in with password then TOTP and sets hardened cookies', async () => {
    await t.http().post('/v1/admin/auth/login').send({ email: 'owner@nouri.dev', password: 'wrong-password' }).expect(401);
    const l = await t.http().post('/v1/admin/auth/login').send({ email: 'owner@nouri.dev', password: PASSWORD }).expect(200);
    expect(l.body.totpRequired).toBe(true);
    expect((await t.http().post('/v1/admin/auth/totp').send({ challengeId: l.body.challengeId, code: '000000' }).expect(401)).body.error.code).toBe('OTP_INVALID');
    const code = totp(secrets.get('owner')!);
    const s = await t.http().post('/v1/admin/auth/totp').send({ challengeId: l.body.challengeId, code }).expect(200);
    expect(s.body).toMatchObject({ email: 'owner@nouri.dev', role: 'owner', idleTimeoutSec: 1800 });
    // QA B11: the same code cannot be used twice.
    const again = await t.http().post('/v1/admin/auth/login').send({ email: 'owner@nouri.dev', password: PASSWORD }).expect(200);
    expect((await t.http().post('/v1/admin/auth/totp').send({ challengeId: again.body.challengeId, code }).expect(401)).body.error.code).toBe('OTP_INVALID');
    const cookie = (s.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-nouri_admin='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('GET auth/session needs the cookie; logout ends it', async () => {
    const h = await login('support');
    expect((await t.http().get('/v1/admin/auth/session').set(h).expect(200)).body.role).toBe('support');
    await t.http().get('/v1/admin/auth/session').expect(401);
    await t.http().post('/v1/admin/auth/logout').set(h).expect(204);
    await t.http().get('/v1/admin/auth/session').set(h).expect(401);
  });

  it('enforces CSRF on writes and roles on every route', async () => {
    const owner = await login('owner');
    const noCsrf = { Cookie: owner.Cookie! };
    expect((await t.http().put('/v1/admin/flags').set(noCsrf).send({ key: 'coach.call', enabled: true, reason: 'testing csrf' }).expect(403)).body.error.message).toMatch(/CSRF/);
    const analyst = await login('analyst');
    await t.http().get('/v1/admin/users').set(analyst).expect(403);
    await t.http().get('/v1/admin/metrics/overview').set(analyst).expect(200);
    const editor = await login('editor');
    await t.http().put('/v1/admin/flags').set(editor).send({ key: 'coach.call', enabled: true, reason: 'not allowed' }).expect(403);
    await t.http().get('/v1/admin/content/milo-lines').set(editor).expect(200);
    const adminH = await login('admin');
    await t.http().get('/v1/admin/admin-users').set(adminH).expect(403);
    expect((await t.http().get('/v1/admin/admin-users').set(owner).expect(200)).body).toHaveLength(5);
    await t.http().get('/v1/admin/users').set(bearer('app-user-token-is-not-an-admin-session')).expect(401);
  });

  it('users: list, audited detail and actions', async () => {
    const s = await signIn(t, 'patient@example.com');
    const support = await login('support');
    const list = await t.http().get('/v1/admin/users').query({ query: 'patient' }).set(support).expect(200);
    expect(list.body).toMatchObject({ total: 1, items: [{ email: 'patient@example.com', status: 'active', platform: 'ios' }] });
    const id = list.body.items[0].id;
    const detail = await t.http().get(`/v1/admin/users/${id}`).set(support).expect(200);
    expect(detail.body).toMatchObject({ emailVerified: true, authProviders: ['email'], usage: { scansTotal: 0 }, devices: [{ deviceId: 'dev-1' }] });
    await t.http().post(`/v1/admin/users/${id}/entitlement`).set(support).send({ plan: 'plus', days: 30 }).expect(400); // reason required
    await t.http().post(`/v1/admin/users/${id}/entitlement`).set(support).send({ plan: 'plus', days: 30, reason: 'goodwill promo' }).expect(200);
    expect((await t.http().get('/v1/billing/entitlement').set(bearer(s.accessToken)).expect(200)).body).toMatchObject({ isPlus: true, source: 'promo' });
    const scans = await t.http().post(`/v1/admin/users/${id}/free-scans`).set(support).send({ count: 2, reason: 'support ticket 42' }).expect(200);
    expect(scans.body.freeScans.allowance).toBe(3);
    await t.http().patch(`/v1/admin/users/${id}`).set(support).send({ status: 'disabled', reason: 'abuse report' }).expect(200);
    expect((await t.http().get('/v1/me').set(bearer(s.accessToken)).expect(401)).body.error.code).toBe('TOKEN_REVOKED');
    await t.http().delete(`/v1/admin/users/${id}`).set(support).send({ reason: 'not allowed for support' }).expect(403);
    const adminH = await login('admin');
    const del = await t.http().delete(`/v1/admin/users/${id}`).set(adminH).send({ reason: 'user asked by email' }).expect(202);
    expect(del.body.status).toBe('pending_deletion');
    const ownerH = await login('owner');
    const audit = await t.http().get('/v1/admin/audit-logs').query({ targetId: id }).set(ownerH).expect(200);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['user.view', 'user.grant_promo', 'user.add_free_scans', 'user.disable', 'user.delete']),
    );
    expect(audit.body.items.find((a: { action: string }) => a.action === 'user.disable').reason).toBe('abuse report');
    await t.http().get(`/v1/admin/users/${'a'.repeat(24)}`).set(support).expect(404);
  });

  it('content: copy edits publish a new version; a stale baseVersion is a 409', async () => {
    const editor = await login('editor');
    const doc = await t.http().get('/v1/admin/content/onboarding-questions').set(editor).expect(200);
    expect(doc.body).toMatchObject({ kind: 'onboarding_questions', version: 2, publishedBy: 'seed' }); // questions.v2.json is the newest seeded version
    const q01 = doc.body.data.questions.find((q: { id: string }) => q.id === 'q01');
    const put = await t
      .http()
      .put('/v1/admin/content/onboarding-questions')
      .set(editor)
      .send({ baseVersion: 2, reason: 'friendlier wording', data: { questions: [{ id: 'q01', text: 'What would you like to work on first?', options: [{ id: q01.options[0].id, label: 'Healthier habits' }] }] } })
      .expect(200);
    expect(put.body).toMatchObject({ version: 3, publishedBy: 'editor@nouri.dev' });
    const pub = await t.http().get('/v1/onboarding/questions').expect(200);
    expect(pub.body.version).toBe(3);
    expect(pub.body.questionSet.questions.find((q: { id: string }) => q.id === 'q01').text).toBe('What would you like to work on first?');
    const stale = await t.http().put('/v1/admin/content/onboarding-questions').set(editor).send({ baseVersion: 2, reason: 'late edit here', data: { questions: [] } }).expect(409);
    expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 3 } });
    const lines = await t.http().put('/v1/admin/content/milo-lines').set(editor).send({ baseVersion: 2, reason: 'greeting copy', data: { lines: [{ key: 'welcome.greeting', text: 'Hello, I am Milo.' }] } }).expect(200);
    expect(lines.body.data.lines.find((l: { key: string }) => l.key === 'welcome.greeting').text).toBe('Hello, I am Milo.');
    await t.http().put('/v1/admin/content/nope').set(editor).send({ baseVersion: 2, reason: 'unknown kind', data: {} }).expect(404);
  });

  it('flags, experiments, min app version and kill switches reach GET /v1/config', async () => {
    const admin = await login('admin');
    await t.http().put('/v1/admin/flags').set(admin).send({ key: 'paywall.onboarding', enabled: false, reason: 'pause paywall' }).expect(200);
    const bad = await t
      .http()
      .put('/v1/admin/experiments')
      .set(admin)
      .send({ reason: 'weights test', experiment: { key: 'freeScans.allowance', status: 'running', allocationPct: 100, variants: [{ id: '1', weight: 50, value: 1 }, { id: '3', weight: 40, value: 3 }] } })
      .expect(400);
    expect(bad.body.error.details.total).toBe(90);
    const exps = await t
      .http()
      .put('/v1/admin/experiments')
      .set(admin)
      .send({ reason: 'start free scan test', experiment: { key: 'freeScans.allowance', status: 'running', allocationPct: 100, variants: [{ id: '1', weight: 0, value: 1 }, { id: '3', weight: 100, value: 3 }] } })
      .expect(200);
    expect(exps.body.find((e: { key: string }) => e.key === 'freeScans.allowance')).toMatchObject({ status: 'running', startedAt: expect.any(String) });
    await t.http().put('/v1/admin/config/min-app-version').set(admin).send({ ios: '1.2.0', android: '1.1.0', reason: 'force update' }).expect(200);
    await t.http().put('/v1/admin/config/min-app-version').set(admin).send({ ios: 'one', android: '1.1.0', reason: 'bad version' }).expect(400);
    await t.http().post('/v1/admin/ai/kill-switch').set(admin).send({ key: 'ai.kill.vision', enabled: true, reason: 'provider outage' }).expect(200);
    const user = await signIn(t);
    const cfg = await t.http().get('/v1/config').set(bearer(user.accessToken)).expect(200);
    expect(cfg.body).toMatchObject({ flags: { 'paywall.onboarding': false }, minAppVersion: { ios: '1.2.0', android: '1.1.0' }, killSwitches: { vision: true }, experiments: { 'freeScans.allowance': '3' } });
    await t.http().post('/v1/admin/ai/kill-switch').set(admin).send({ key: 'ai.kill.vision', enabled: false, reason: 'outage over' }).expect(200);
    // B22: once stopped, already-bucketed users fall back to the default (no variant in /v1/config).
    await t.http().put('/v1/admin/experiments').set(admin)
      .send({ reason: 'stop free scan test', experiment: { key: 'freeScans.allowance', status: 'stopped', allocationPct: 100, variants: [{ id: '1', weight: 0, value: 1 }, { id: '3', weight: 100, value: 3 }] } })
      .expect(200);
    const after = await t.http().get('/v1/config').set(bearer(user.accessToken)).expect(200);
    expect(after.body.experiments).not.toHaveProperty('freeScans.allowance');
    expect((await t.http().get('/v1/admin/config/min-app-version').set(admin).expect(200)).body).toMatchObject({ ios: '1.2.0', updatedBy: 'admin@nouri.dev' });
  });

  it('BI-1: Milo lines round-trip — GET gives text for every line and PUT accepts it back', async () => {
    const editor = await login('editor');
    const got = await t.http().get('/v1/admin/content/milo-lines').set(editor).expect(200);
    expect(got.body.data.lines.every((l: { text: unknown }) => typeof l.text === 'string' && l.text.length > 0)).toBe(true);
    const freeBar = got.body.data.lines.find((l: { key: string }) => l.key === 'today.freeBar.left#title');
    expect(freeBar.text).toBe('Free plan · 1 scan left');
    const edited = got.body.data.lines.map((l: { key: string; text: string }) => (l.key === 'today.freeBar.left#title' ? { ...l, text: 'Free plan: 1 scan left' } : l));
    const put = await t.http().put('/v1/admin/content/milo-lines').set(editor).send({ baseVersion: got.body.version, reason: 'round trip test', data: { lines: edited } }).expect(200);
    expect(put.body.data.lines.find((l: { key: string }) => l.key === 'today.freeBar.left#title').text).toBe('Free plan: 1 scan left');
    const pub = await t.http().get('/v1/content/milo-lines').expect(200);
    expect(pub.body.data.lines['today.freeBar.left']).toEqual({ title: 'Free plan: 1 scan left', sub: 'Try a photo scan on us.' });
  });

  it('BI-3: GET ai/kill-switches lists each switch with who, when and why', async () => {
    const admin = await login('admin');
    await t.http().post('/v1/admin/ai/kill-switch').set(admin).send({ key: 'ai.kill.chat', enabled: true, reason: 'chat incident 12' }).expect(200);
    const analyst = await login('analyst');
    const list = await t.http().get('/v1/admin/ai/kill-switches').set(analyst).expect(200);
    expect(list.body).toHaveLength(4);
    expect(list.body.find((k: { key: string }) => k.key === 'ai.kill.chat')).toMatchObject({ enabled: true, reason: 'chat incident 12', updatedBy: 'admin@nouri.dev' });
    expect(list.body.find((k: { key: string }) => k.key === 'ai.kill.vision')).toMatchObject({ enabled: false });
    await t.http().post('/v1/admin/ai/kill-switch').set(admin).send({ key: 'ai.kill.chat', enabled: false, reason: 'incident closed' }).expect(200);
  });

  it('waitlist JSON and CSV export, metrics overview', async () => {
    await t.http().post('/v1/public/waitlist').send({ email: 'fan@example.com', turnstileToken: 'ok', source: 'home', utm: { campaign: 'launch' } }).expect(200);
    const owner = await login('owner');
    expect((await t.http().get('/v1/admin/waitlist').set(owner).expect(200)).body).toMatchObject({ total: 1, items: [{ email: 'fan@example.com', source: 'home' }] });
    const csv = await t.http().get('/v1/admin/waitlist').query({ format: 'csv' }).set(owner).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[1]).toContain('"fan@example.com","home","","","launch"');
    const supportH = await login('support');
    await t.http().get('/v1/admin/waitlist').set(supportH).expect(403);
    const m = await t.http().get('/v1/admin/metrics/overview').set(owner).expect(200);
    expect(m.body.kpis.signups7d.value).toBeGreaterThan(0);
    expect(m.body.signupsDaily).toHaveLength(30);
    expect(m.body.onboardingByRoute).toHaveLength(3);
  });
});
