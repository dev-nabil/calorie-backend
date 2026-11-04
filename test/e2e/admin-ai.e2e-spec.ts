import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, seedAdmins, signIn, uploadPhoto } from '../setup/helpers';
import { totp } from '../../src/modules/admin/security/admin-crypto';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { InlineScanQueue, ScanQueue } from '../../src/modules/scans/scan-queue';
import { AppConfigService } from '../../src/modules/content/app-config.service';

describe('Admin M7 rest: AI settings, prompts, scans, usage, SLOs, conversations, admin users', () => {
  let t: TestApp;
  let login: Awaited<ReturnType<typeof seedAdmins>>;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
    login = await seedAdmins(t);
  });
  afterAll(() => t.close());

  it('AI settings round-trip and feed limits and the budget guard', async () => {
    const admin = await login('admin');
    const got = await t.http().get('/v1/admin/ai/settings').set(admin).expect(200);
    expect(got.body).toMatchObject({ models: { vision: 'gpt-5-mini', moderation: 'omni-moderation-latest' }, limits: { free: { describePerDay: 3, scansLifetime: 1 }, plus: { scans: 30 } }, budget: { alertPct: 80, downgradePct: 95 } });
    expect(got.body.killSwitches).toHaveLength(4);
    const body = { models: got.body.models, limits: { ...got.body.limits, free: { ...got.body.limits.free, describePerDay: 5 } }, budget: { monthlyLimitUsd: 0.000001, alertPct: 80, downgradePct: 95 }, reason: 'tune limits' };
    const put = await t.http().put('/v1/admin/ai/settings').set(admin).send(body).expect(200);
    expect(put.body.limits.free.describePerDay).toBe(5);
    const hAnalyst1 = await login('analyst');
    await t.http().put('/v1/admin/ai/settings').set(hAnalyst1).send(body).expect(403);
    // Budget guard (plan 8.9): once month-to-date spend passes downgradePct of the budget, calls stop.
    const coachPrompt = (await t.http().get('/v1/admin/prompts').query({ key: 'coach' }).set(admin).expect(200)).body[0].id;
    await t.get<AppConfigService>(AppConfigService).set('ai.price.gpt-5-mini', { inputPerM: 1, cachedPerM: 1, outputPerM: 1 });
    await t.http().post('/v1/admin/prompts/test').set(admin).send({ promptId: coachPrompt, input: 'hi' }).expect(200);
    const over = await t.http().post('/v1/admin/prompts/test').set(admin).send({ promptId: coachPrompt, input: 'hi' }).expect(503);
    expect(over.body.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'budget' } });
    await t.http().put('/v1/admin/ai/settings').set(admin).send({ ...body, budget: { monthlyLimitUsd: 0, alertPct: 80, downgradePct: 95 } }).expect(200);
    await t.get<AppConfigService>(AppConfigService).set('ai.price.gpt-5-mini', null);
  });

  it('prompts: list, create a version, edit the draft, activate and roll back, test in the playground', async () => {
    const admin = await login('admin');
    const list = await t.http().get('/v1/admin/prompts').query({ key: 'meal-parse' }).set(admin).expect(200);
    expect(list.body[0]).toMatchObject({ key: 'meal-parse', version: 1, active: true });
    const v1 = list.body[0];
    const v2 = await t.http().post('/v1/admin/prompts').set(admin).send({ key: 'meal-parse', staticPrefix: v1.staticPrefix + '\nBe concise.', content: v1.content, model: '', params: { temperature: 1, maxOutputTokens: 900 }, notes: 'concise', reason: 'try concise wording' }).expect(201);
    expect(v2.body).toMatchObject({ version: 2, active: false });
    await t.http().patch(`/v1/admin/prompts/${v2.body.id}`).set(admin).send({ notes: 'concise v2', reason: 'note update' }).expect(200);
    expect((await t.http().patch(`/v1/admin/prompts/${v1.id}`).set(admin).send({ content: 'x', reason: 'edit active' }).expect(409)).body.error.code).toBe('CONFLICT');
    const act = await t.http().post(`/v1/admin/prompts/${v2.body.id}/activate`).set(admin).send({ reason: 'ship concise' }).expect(200);
    expect(act.body).toMatchObject({ active: true, activatedAt: expect.any(String) });
    const fake = t.get<FakeAiProvider>(AiProvider);
    fake.reset();
    const user = bearer((await signIn(t)).accessToken);
    await t.http().post('/v1/meals/parse').set(user).set(INTEGRITY).send({ text: 'toast' }).expect(200);
    expect(fake.calls[0]!.instructions).toContain('Be concise.');
    await t.http().post(`/v1/admin/prompts/${v1.id}/activate`).set(admin).send({ reason: 'roll back' }).expect(200);
    const after = await t.http().get('/v1/admin/prompts').query({ key: 'meal-parse' }).set(admin).expect(200);
    expect(after.body.find((p: { active: boolean }) => p.active).version).toBe(1);
    const test = await t.http().post('/v1/admin/prompts/test').set(admin).send({ promptId: v2.body.id, input: 'two eggs' }).expect(200);
    expect(JSON.parse(test.body.output).mealName).toBe('Scrambled eggs on toast');
    expect(test.body.usage.inputTokens).toBeGreaterThan(0);
  });

  it('failed scans list, AI usage and SLOs', async () => {
    const h = bearer((await signIn(t)).accessToken);
    t.get<FakeAiProvider>(AiProvider).enqueue(Object.assign(new Error('bad'), { status: 400 }));
    const { key, hash } = await uploadPhoto(t, h);
    await t.http().post('/v1/scans').set(h).set(INTEGRITY).send({ scanId: randomUUID(), imageKey: key, imageHash: hash }).expect(202);
    await (t.get<ScanQueue>(ScanQueue) as InlineScanQueue).drain();
    await t.http().get(`/v1/days/${new Date().toISOString().slice(0, 10)}`).set(h).expect(200);
    const admin = await login('admin');
    const failed = await t.http().get('/v1/admin/scans').query({ status: 'failed' }).set(admin).expect(200);
    expect(failed.body.items[0]).toMatchObject({ status: 'failed', error: { code: 'AI_FAILED' } });
    await t.http().get('/v1/admin/scans').query({ status: 'low_confidence' }).set(admin).expect(200);
    const usage = await t.http().get('/v1/admin/metrics/ai-usage').query({ days: 7 }).set(admin).expect(200);
    expect(usage.body.days.some((d: { feature: string }) => d.feature === 'vision')).toBe(true);
    const slo = await t.http().get('/v1/admin/metrics/slo').set(admin).expect(200);
    expect(slo.body.items.map((i: { key: string }) => i.key)).toEqual(['availability', 'read_latency', 'write_latency', 'scan_e2e', 'scan_success', 'webhook', 'reconcile_drift']);
    expect(slo.body.items.find((i: { key: string }) => i.key === 'read_latency').current).toMatch(/ms$/);
    const hSupport2 = await login('support');
    await t.http().get('/v1/admin/metrics/slo').set(hSupport2).expect(403);
  });

  it('user conversations are listed and audited', async () => {
    const s = await signIn(t, 'talker@example.com');
    await t.http().post('/v1/conversations').set(bearer(s.accessToken)).set(idem()).send({ type: 'coach' }).expect(201);
    const support = await login('support');
    const list = await t.http().get(`/v1/admin/users/${s.user.id}/conversations`).set(support).expect(200);
    expect(list.body.items[0]).toMatchObject({ kind: 'coach', turns: 0 });
    const hOwner3 = await login('owner');
    const audit = await t.http().get('/v1/admin/audit-logs').query({ action: 'user.view_conversations' }).set(hOwner3).expect(200);
    expect(audit.body.items.length).toBe(1);
  });

  it('owner invites an admin who accepts, signs in, and can be deactivated; the last owner is protected', async () => {
    const owner = await login('owner');
    const inv = await t.http().post('/v1/admin/admin-users').set(owner).send({ email: 'new.editor@nouri.dev', role: 'editor', reason: 'new hire' }).expect(201);
    expect(inv.body).toMatchObject({ status: 'invited', totpEnabled: false });
    await t.http().post('/v1/admin/admin-users').set(owner).send({ email: 'new.editor@nouri.dev', role: 'editor', reason: 'duplicate' }).expect(409);
    const hAdmin4 = await login('admin');
    await t.http().post('/v1/admin/admin-users').set(hAdmin4).send({ email: 'x@nouri.dev', role: 'editor', reason: 'not owner' }).expect(403);
    const link = (await t.http().get('/v1/dev/last-link').query({ email: 'new.editor@nouri.dev' }).expect(200)).body;
    expect(link.kind).toBe('admin_invite');
    await t.http().get('/v1/dev/last-link').query({ email: 'nobody@nouri.dev' }).expect(404);
    const token = new URL(link.url).searchParams.get('token')!;
    const acc = await t.http().post('/v1/admin/auth/accept-invite').send({ token, password: 'a-long-password-1' }).expect(200);
    await t.http().post('/v1/admin/auth/accept-invite').send({ token, password: 'a-long-password-1' }).expect(401);
    const l = await t.http().post('/v1/admin/auth/login').send({ email: 'new.editor@nouri.dev', password: 'a-long-password-1' }).expect(200);
    await t.http().post('/v1/admin/auth/totp').send({ challengeId: l.body.challengeId, code: totp(acc.body.totpSecret) }).expect(200);
    await t.http().patch(`/v1/admin/admin-users/${inv.body.id}`).set(owner).send({ status: 'deactivated', reason: 'left the team' }).expect(200);
    await t.http().post('/v1/admin/auth/login').send({ email: 'new.editor@nouri.dev', password: 'a-long-password-1' }).expect(401);
    const owners = (await t.http().get('/v1/admin/admin-users').set(owner).expect(200)).body.filter((a: { role: string }) => a.role === 'owner');
    expect((await t.http().patch(`/v1/admin/admin-users/${owners[0].id}`).set(owner).send({ role: 'admin', reason: 'demote last owner' }).expect(409)).body.error.code).toBe('CONFLICT');
  });

  it('B20: open sessions follow a role change at once and end when the admin is deactivated', async () => {
    const owner = await login('owner');
    const inv = await t.http().post('/v1/admin/admin-users').set(owner).send({ email: 'temp.admin@nouri.dev', role: 'admin', reason: 'contractor' }).expect(201);
    const link = (await t.http().get('/v1/dev/last-link').query({ email: 'temp.admin@nouri.dev' }).expect(200)).body;
    const acc = await t.http().post('/v1/admin/auth/accept-invite').send({ token: new URL(link.url).searchParams.get('token'), password: 'a-long-password-2' }).expect(200);
    const l = await t.http().post('/v1/admin/auth/login').send({ email: 'temp.admin@nouri.dev', password: 'a-long-password-2' }).expect(200);
    const s = await t.http().post('/v1/admin/auth/totp').send({ challengeId: l.body.challengeId, code: totp(acc.body.totpSecret) }).expect(200);
    const cookies = (s.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
    const temp = { Cookie: cookies.join('; '), 'X-CSRF-Token': cookies.find((c) => c.startsWith('nouri_admin_csrf='))!.split('=')[1]! };
    await t.http().get('/v1/admin/audit-logs').set(temp).expect(200);

    await t.http().patch(`/v1/admin/admin-users/${inv.body.id}`).set(owner).send({ role: 'analyst', reason: 'scope reduced' }).expect(200);
    await t.http().get('/v1/admin/audit-logs').set(temp).expect(403);
    expect((await t.http().get('/v1/admin/auth/session').set(temp).expect(200)).body.role).toBe('analyst');

    await t.http().patch(`/v1/admin/admin-users/${inv.body.id}`).set(owner).send({ status: 'deactivated', reason: 'contract ended' }).expect(200);
    await t.http().get('/v1/admin/auth/session').set(temp).expect(401);
    await t.http().get('/v1/admin/metrics/slo').set(temp).expect(401);
    const audit = await t.http().get('/v1/admin/audit-logs').query({ action: 'admin_user.sessions_revoked' }).set(owner).expect(200);
    expect(audit.body.items[0]).toMatchObject({ targetId: inv.body.id });

    // Reactivating does not bring old sessions back.
    await t.http().patch(`/v1/admin/admin-users/${inv.body.id}`).set(owner).send({ status: 'active', reason: 'rehired' }).expect(200);
    await t.http().get('/v1/admin/auth/session').set(temp).expect(401);
  });
});
