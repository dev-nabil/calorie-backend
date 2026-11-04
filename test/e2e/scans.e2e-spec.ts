import { randomUUID } from 'node:crypto';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn, uploadPhoto } from '../setup/helpers';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { AppConfigService } from '../../src/modules/content/app-config.service';
import { InlineScanQueue, ScanQueue } from '../../src/modules/scans/scan-queue';
import { ScanProcessor } from '../../src/modules/scans/scan.processor';
import { UsersService } from '../../src/modules/users/users.service';
import { GoogleTokenVerifier } from '../../src/modules/auth/providers';


describe('Scans (M4-T3)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  const drain = () => (t.get<ScanQueue>(ScanQueue) as InlineScanQueue).drain();

  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' }, (b) =>
      b.overrideProvider(GoogleTokenVerifier).useValue({
        verify: async () => ({ subject: 'g-unverified', email: 'unverified@example.com', emailVerified: false, name: null }),
      }),
    );
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  beforeEach(() => fake.reset());
  afterAll(() => t.close());

  const post = (h: Record<string, string>, body: object) => t.http().post('/v1/scans').set(h).set(INTEGRITY).send(body);
  const scanBody = async (h: Record<string, string>, seed?: string) => {
    const { key, hash } = await uploadPhoto(t, h, seed);
    return { scanId: randomUUID(), imageKey: key, imageHash: hash, category: 'lunch' };
  };
  const poll = (h: Record<string, string>, id: string) => t.http().get(`/v1/scans/${id}`).set(h).expect(200);

  it('queues, analyses, charges the free scan once and dedupes retries (BR-01, BR-02)', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    const body = await scanBody(h, 'plate-1');
    const queued = await post(h, body).expect(202);
    expect(queued.body).toMatchObject({ scanId: body.scanId, status: 'queued', result: null });
    await drain();
    const done = await poll(h, body.scanId);
    expect(done.body).toMatchObject({ status: 'succeeded', chargedFreeScan: true, deduped: false });
    expect(done.body.result.totals.kcal).toBe(501);
    expect(done.body.result.reactionLineId).toMatch(/^scan\.reaction\./);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.instructions).toContain('Static prefix');

    const retry = await post(h, body).expect(200);
    expect(retry.body.status).toBe('succeeded');
    const samePhoto = await post(h, await scanBody(h, 'plate-1')).expect(200);
    expect(samePhoto.body).toMatchObject({ status: 'succeeded', deduped: true, chargedFreeScan: false });
    await drain();
    expect(fake.calls).toHaveLength(1);

    const me = await t.http().get('/v1/me').set(h).expect(200);
    expect(me.body.freeScans).toEqual({ allowance: 1, used: 1, remaining: 0 });
    const ledger = t.get<Model<{ emailHmac: string; freeScansUsed: number }>>(getModelToken('ScanLedger'));
    expect((await ledger.findOne({ emailHmac: t.get<UsersService>(UsersService).ledgerKey(s.user.email) }))?.freeScansUsed).toBe(1);

    const limit = await post(h, await scanBody(h)).expect(402);
    expect(limit.body.error.code).toBe('SCAN_LIMIT_REACHED');

    const meal = {
      loggedAt: new Date().toISOString(),
      timezone: 'UTC',
      category: 'lunch',
      name: 'Chicken and rice',
      source: 'photo',
      scanId: body.scanId,
      items: done.body.result.items.map((i: Record<string, unknown>) => ({
        name: i.name, grams: i.grams, kcal: i.kcal, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG,
      })),
    };
    const saved = await t.http().post('/v1/meals').set(h).set(idem()).send(meal).expect(201);
    expect(saved.body.photo).toMatchObject({ key: body.imageKey, thumbKey: null, url: expect.stringContaining('/v1/dev/uploads?') });
    const img = new URL(saved.body.photo.url);
    const got = await t.http().get(img.pathname + img.search).expect(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(saved.body.totals.kcal).toBe(501);
    expect((await t.http().post('/v1/meals').set(h).set(idem()).send(meal).expect(409)).body.error.code).toBe('CONFLICT');
  });

  it('does not charge a rejected (not food) scan', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue({ isFood: false, mealName: '', items: [], notes: 'That looks like a cat.', clarifyingQuestion: null });
    const body = await scanBody(h);
    await post(h, body).expect(202);
    await drain();
    const res = await poll(h, body.scanId);
    expect(res.body).toMatchObject({ status: 'rejected', chargedFreeScan: false, result: { isFood: false, items: [] } });
    expect((await t.http().get('/v1/me').set(h)).body.freeScans.remaining).toBe(1);
  });

  it('fails without charge on model errors and invalid output', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue(Object.assign(new Error('bad request'), { status: 400 }));
    const a = await scanBody(h);
    await post(h, a).expect(202);
    await drain();
    expect((await poll(h, a.scanId)).body).toMatchObject({ status: 'failed', chargedFreeScan: false, error: { code: 'AI_FAILED' } });
    fake.enqueue({ isFood: true, unexpected: 'field' });
    const b = await scanBody(h);
    await post(h, b).expect(202);
    await drain();
    expect((await poll(h, b.scanId)).body.error.code).toBe('MODEL_OUTPUT_INVALID');
    expect((await t.http().get('/v1/me').set(h)).body.freeScans.remaining).toBe(1);
  });

  it('retries once on a 5xx before failing', async () => {
    const h = bearer((await signIn(t)).accessToken);
    fake.enqueue(Object.assign(new Error('upstream'), { status: 503 }));
    const body = await scanBody(h);
    await post(h, body).expect(202);
    await drain();
    expect((await poll(h, body.scanId)).body.status).toBe('succeeded');
    expect(fake.calls).toHaveLength(2);
  });

  it('kill switch keeps the scan queued, then the sweep fails it without charge (plan 8.10)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const cfg = t.get<AppConfigService>(AppConfigService);
    // B21: uploads still work while the switch is on, but a new scan is refused up front.
    await cfg.set('ai.kill.vision', true);
    const refused = await scanBody(h);
    const res = await post(h, refused).expect(503);
    expect(res.body.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'kill_switch' } });
    await t.http().get(`/v1/scans/${refused.scanId}`).set(h).expect(404);
    // A scan queued just before the switch waits, then the sweep fails it.
    await cfg.set('ai.kill.vision', false);
    const body = await scanBody(h);
    await post(h, body).expect(202);
    await cfg.set('ai.kill.vision', true);
    await drain();
    const waiting = await poll(h, body.scanId);
    expect(waiting.body).toMatchObject({ status: 'queued', error: { code: 'AI_UNAVAILABLE' } });
    expect(fake.calls).toHaveLength(0);
    await t.get<ScanProcessor>(ScanProcessor).sweep(new Date(Date.now() + 3 * 60_000));
    expect((await poll(h, body.scanId)).body).toMatchObject({ status: 'failed', chargedFreeScan: false });
    await cfg.set('ai.kill.vision', false);
  });

  it('Plus users are never charged (BR-03)', async () => {
    const s = await signIn(t);
    const users = t.get<UsersService>(UsersService);
    await users.users.updateOne({ _id: s.user.id }, { $set: { entitlement: { plan: 'plus', period: 'monthly', activeUntil: new Date(Date.now() + 86400000), source: 'promo' } } });
    const h = bearer(s.accessToken);
    for (const _ of [1, 2]) {
      const body = await scanBody(h);
      await post(h, body).expect(202);
      await drain();
      expect((await poll(h, body.scanId)).body).toMatchObject({ status: 'succeeded', chargedFreeScan: false });
    }
  });

  it('requires a verified account (BR-16) and owns scan ids', async () => {
    const g = await t.http().post('/v1/auth/google').send({ idToken: 'google-token-unverified' }).expect(200);
    const gh = bearer(g.body.accessToken);
    const res = await post(gh, await scanBody(gh)).expect(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    const a = bearer((await signIn(t)).accessToken);
    const b = bearer((await signIn(t)).accessToken);
    const body = await scanBody(a);
    await post(a, body).expect(202);
    expect((await post(b, body).expect(409)).body.error.code).toBe('SCAN_CONFLICT');
    const notMine = await post(b, { ...(await scanBody(b)), imageKey: body.imageKey }).expect(400);
    expect(notMine.body.error.details.field).toBe('imageKey');
    await post(a, { ...body, scanId: randomUUID(), imageKey: body.imageKey.replace(/[^/]+$/, 'missing.jpg') }).expect(400);
    expect((await t.http().get(`/v1/scans/${body.scanId}`).set(b).expect(404)).body.error.code).toBe('SCAN_NOT_FOUND');
    await drain();
    await post(a, { ...(await scanBody(a)), imageHash: 'nothex' }).expect(400);
  });
});
