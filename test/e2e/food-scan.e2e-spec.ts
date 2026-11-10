import { createHash, randomUUID } from 'node:crypto';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import sharp from 'sharp';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn, uploadPhoto } from '../setup/helpers';
import { StorageService } from '../../src/infra/storage/storage';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { AiService } from '../../src/modules/ai/ai.service';
import { FakeFoodVisionProvider, FoodVisionProvider } from '../../src/modules/ai/providers/food-vision.provider';
import type { AiUsageDailyDoc, FoodScanUsageDailyDoc } from '../../src/modules/ai/schemas/ai.schema';
import { AppConfigService } from '../../src/modules/content/app-config.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { ScanQueue } from '../../src/modules/scans/scan-queue';
import type { ScanDoc } from '../../src/modules/scans/schemas/scans.schema';
import { ScanProcessor } from '../../src/modules/scans/services/scan.processor';
import { UsersService } from '../../src/modules/users/users.service';

/** A Bangladeshi lunch as Gemini would return it. Rice, dal and fish curry have records; the greens do not. */
const LUNCH = {
  status: 'ok',
  mealName: 'Rice, dal and fish curry',
  items: [
    { name: 'White rice', en: 'white rice', g: 200, prep: 'boiled', role: 'single', of: null, n: { kcal: 130, p: 2.7, c: 28, f: 0.3, fib: 0.4, sug: 0, na: 1 }, rich: [], conf: 0.85, pt: { x: 0.3, y: 0.6 }, note: null },
    { name: 'Dal', en: 'dal', g: 120, prep: 'curried', role: 'mixed_dish', of: null, n: { kcal: 120, p: 7, c: 15, f: 4, fib: 4, sug: 1, na: 300 }, rich: ['folate', 'iron', 'potassium'], conf: 0.8, pt: { x: 0.6, y: 0.3 }, note: null },
    { name: 'Fish curry', en: 'fish curry', g: 150, prep: 'curried', role: 'mixed_dish', of: null, n: { kcal: 110, p: 12, c: 4, f: 5, fib: 0.5, sug: 1, na: 350 }, rich: ['vitaminB12', 'vitaminD'], conf: 0.7, pt: { x: 0.7, y: 0.7 }, note: 'Oil assumed' },
    { name: 'Shak bhaji', en: 'greens stir fry', g: 80, prep: 'fried', role: 'single', of: null, n: { kcal: 70, p: 2, c: 5, f: 5, fib: 2, sug: null, na: null }, rich: ['vitaminA', 'vitaminK', 'vitaminC', 'iron'], conf: 0.6, pt: null, note: null },
  ],
  assumptions: ['Oil in the curry is assumed to be typical.'],
  question: null,
  retake: null,
};

describe('Food photo scanner, Gemini mocked', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  let vision: FakeFoodVisionProvider;
  const drain = () => t.get<ScanQueue>(ScanQueue).drain();
  const scans = () => t.get<Model<ScanDoc>>(getModelToken('Scan'));
  const usage = () => t.get<Model<FoodScanUsageDailyDoc>>(getModelToken('FoodScanUsageDaily'));
  const config = () => t.get<AppConfigService>(AppConfigService);
  const caps = async (requests: number, spendUsd: number) => {
    await t.get<SettingsService>(SettingsService).set('scan.dailyRequestCap', requests);
    await t.get<SettingsService>(SettingsService).set('scan.dailySpendUsd', spendUsd);
  };

  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true', RATE_LIMIT_MULTIPLIER: '100' });
    await config().set('ai.budget', { monthlyLimitUsd: 2 });
    fake = t.get<FakeAiProvider>(AiProvider);
    vision = t.get<FakeFoodVisionProvider>(FoodVisionProvider);
  });
  beforeEach(async () => {
    fake.reset();
    vision.reset();
    await usage().deleteMany({});
    await caps(1000, 100);
  });
  afterAll(() => t.close());

  const asPlus = async () => {
    const s = await signIn(t);
    await t.get<UsersService>(UsersService).users.updateOne({ _id: s.user.id }, { $set: { entitlement: { plan: 'plus', period: 'monthly', activeUntil: new Date(Date.now() + 86400000), source: 'promo' } } });
    return bearer(s.accessToken);
  };
  const post = (h: Record<string, string>, body: object) => t.http().post('/v1/scans').set(h).set(INTEGRITY).send(body);
  const body = async (h: Record<string, string>, seed?: string) => {
    const { key, hash } = await uploadPhoto(t, h, seed);
    return { scanId: randomUUID(), imageKey: key, imageHash: hash, category: 'lunch' };
  };
  const poll = async (h: Record<string, string>, id: string) => (await t.http().get(`/v1/scans/${id}`).set(h).expect(200)).body;
  const scanLunch = async (h: Record<string, string>) => {
    fake.enqueue(structuredClone(LUNCH));
    const b = await body(h);
    await post(h, b).expect(202);
    await drain();
    return { b, scan: await poll(h, b.scanId) };
  };
  const recalc = (h: Record<string, string>, id: string, payload: object) => t.http().post(`/v1/scans/${id}/recalculate`).set(h).set(idem()).send(payload);
  const mealFrom = (scan: { scanId: string; result: { items: Record<string, unknown>[] } }, over: object = {}) => ({
    loggedAt: new Date().toISOString(),
    timezone: 'Asia/Dhaka',
    category: 'lunch',
    name: 'Rice and curry',
    source: 'photo',
    scanId: scan.scanId,
    items: scan.result.items.map((i) => ({ scanItemId: i.id, name: i.name, grams: i.grams, kcal: i.kcal, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG })),
    ...over,
  });

  describe('result', () => {
    it('sends one request with the image and little else, and labels the result an estimate', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      expect(vision.calls).toHaveLength(1);
      const sent = vision.calls[0]!;
      expect(sent).toMatchObject({ model: 'gemini-3.5-flash-lite', thinkingLevel: 'minimal', resolution: 'high', maxOutputTokens: 4096 });
      expect(sent.context.length).toBeLessThan(200);
      expect(sent.image.mimeType).toBe('image/jpeg');
      expect(scan).toMatchObject({ status: 'succeeded', result: { outcome: 'ok', isEstimate: true, assumptions: ['Oil in the curry is assumed to be typical.'] } });
    });

    it('calculates from per-100-gram values on the server and keeps each source', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      const [rice, dal, fish, greens] = scan.result.items;
      expect(rice).toMatchObject({ id: 'i0', grams: 200, per100g: { kcal: 111 }, kcal: 222, source: { type: 'verified_record', recordId: 'fct_bd:01_0041' } });
      expect(dal.source.recordId).toBe('usda_fdc:2707427');
      expect(fish).toMatchObject({ per100g: { kcal: 93 }, kcal: 140, assumption: 'Oil assumed' });
      expect(greens).toMatchObject({ source: { type: 'ai_estimate' }, per100g: { sugarG: null, sodiumMg: null }, sugarG: null, sodiumMg: null, kcal: 56 });
      expect(scan.result.totals.kcal).toBe(222 + dal.kcal + 140 + 56);
      expect([rice.richIn, dal.richIn, greens.richIn]).toEqual([[], ['folate', 'iron', 'potassium'], ['vitaminA', 'vitaminK', 'vitaminC', 'iron']]);
    });

    it('reports a total as incomplete when one item lacks the nutrient', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      expect(scan.result.totals.incomplete).toEqual(expect.arrayContaining(['sugarG', 'sodiumMg']));
      expect(scan.result.totals.incomplete).not.toContain('kcal');
      expect(typeof scan.result.totals.sodiumMg).toBe('number');
    });

    it('records tokens, model, latency and cost, without the photo', async () => {
      const h = await asPlus();
      const { b } = await scanLunch(h);
      const doc = await scans().findById(b.scanId).lean<ScanDoc>();
      expect(doc).toMatchObject({ model: 'gemini-3.5-flash-lite', promptKey: 'meal-scan', promptVersion: 4, providerAttempts: 1, usage: { inputTokens: 1600, outputTokens: 420 } });
      expect(doc!.usage.costUsd).toBeCloseTo((1600 * 0.3 + 420 * 2.5) / 1e6, 8);
      expect(doc!.modelLatencyMs).not.toBeNull();
      expect(JSON.stringify(doc)).not.toMatch(/base64|\/9j\//);
    });
  });

  describe('portion recalculation', () => {
    it('never calls the model, and matches the per-100-gram maths', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      const calls = vision.calls.length;
      const half = await recalc(h, scan.scanId, { portionMultiplier: 0.5 }).expect(200);
      expect(half.body.totals.kcal).toBe(Math.round(scan.result.totals.kcal * 0.5));
      const edited = await recalc(h, scan.scanId, { items: [{ id: 'i0', grams: 300 }] }).expect(200);
      expect(edited.body.items[0]).toMatchObject({ grams: 300, kcal: 333, source: { type: 'verified_record' } });
      expect(edited.body.totals.kcal).toBe(scan.result.totals.kcal + 111);
      expect(vision.calls).toHaveLength(calls);
    });

    it('re-matches a corrected food, and warns when no record fits', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      const fixed = await recalc(h, scan.scanId, { items: [{ id: 'i2', name: 'Chicken curry' }] }).expect(200);
      expect(fixed.body.items[2]).toMatchObject({ source: { recordId: 'usda_fdc:2706437' }, per100g: { kcal: 107 } });
      expect(fixed.body.staleItems).toEqual([]);
      const unknown = await recalc(h, scan.scanId, { items: [{ id: 'i2', name: 'Ilish bhuna' }] }).expect(200);
      expect(unknown.body.items[2].source.type).toBe('adjusted_estimate');
      expect(unknown.body.staleItems).toEqual(['i2']);
    });

    it('adds foods typed in afterwards and excludes foods the user removes', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      const per100g = { kcal: 50, proteinG: 1, carbsG: 10, fatG: 0, fiberG: 1, sugarG: 2, sodiumMg: 5 };
      const res = await recalc(h, scan.scanId, { items: [{ id: 'i3', excluded: true }], addedItems: [{ name: 'Salad', grams: 100, per100g }] }).expect(200);
      expect(res.body.totals.kcal).toBe(scan.result.totals.kcal - 56 + 50);
      expect(res.body.totals.incomplete).not.toContain('sodiumMg'); // only the removed food lacked it
    });

    it('is private to the owner and refuses unknown items and unfinished scans', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      await recalc(bearer((await signIn(t)).accessToken), scan.scanId, {}).expect(404);
      await recalc(h, scan.scanId, { items: [{ id: 'i99', grams: 10 }] }).expect(400);
      fake.enqueue({ status: 'no_food', mealName: null, items: [], assumptions: [], question: null, retake: null });
      const b = await body(h);
      await post(h, b).expect(202);
      await drain();
      await recalc(h, b.scanId, {}).expect(409);
    });
  });

  describe('saving a meal', () => {
    it('saves only on request, from the stored basis, whatever numbers the client sends', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      const date = new Date().toISOString().slice(0, 10);
      expect((await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.meals).toEqual([]);
      const tampered = mealFrom(scan);
      tampered.items[0] = { ...tampered.items[0]!, kcal: 1, grams: 100 };
      const saved = await t.http().post('/v1/meals').set(h).set(idem()).send(tampered).expect(201);
      expect(saved.body.items[0]).toMatchObject({ grams: 100, kcal: 111, sugarG: null, preparation: 'boiled', scanItemId: 'i0', per100g: { kcal: 111 }, source: { recordId: 'fct_bd:01_0041' } });
      expect(saved.body.totals.incomplete).toEqual(expect.arrayContaining(['sugarG', 'sodiumMg']));
      expect(saved.body.items[1].richIn).toEqual(['folate', 'iron', 'potassium']);
      expect(vision.calls).toHaveLength(1);
    });

    it('keeps unknown values unknown through to the day totals', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      const saved = await t.http().post('/v1/meals').set(h).set(idem()).send(mealFrom(scan, { portionMultiplier: 1.5 })).expect(201);
      expect(saved.body.items[3]).toMatchObject({ sugarG: null, sodiumMg: null });
      expect(saved.body.totals.kcal).toBe(Math.round(scan.result.totals.kcal * 1.5));
      const day = await t.http().get(`/v1/days/${saved.body.date}`).set(h).expect(200);
      expect(day.body.totals.kcal).toBe(saved.body.totals.kcal);
    });

    it('lets a meal with an unknown energy value be saved as null', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const res = await t.http().post('/v1/meals').set(h).set(idem()).send({ loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'snack', name: 'Mystery', source: 'manual', items: [{ name: 'Mystery', grams: 50, kcal: null, proteinG: null, carbsG: null, fatG: null }] }).expect(201);
      expect(res.body.items[0]).toMatchObject({ kcal: null, source: { type: 'user_entered' } });
      expect(res.body.totals).toMatchObject({ kcal: null, incomplete: expect.arrayContaining(['kcal']) });
    });

    it('edits keep the source, and a saved portion change recalculates from the basis', async () => {
      const h = await asPlus();
      const { scan } = await scanLunch(h);
      const saved = await t.http().post('/v1/meals').set(h).set(idem()).send(mealFrom(scan)).expect(201);
      const items = scan.result.items.map((i: Record<string, unknown>) => ({ scanItemId: i.id, name: i.name, grams: i.id === 'i0' ? 100 : i.grams, kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }));
      const patched = await t.http().patch(`/v1/meals/${saved.body.id}`).set(h).send({ items }).expect(200);
      expect(patched.body.items[0]).toMatchObject({ kcal: 111, source: { recordId: 'fct_bd:01_0041' } });
    });
  });

  describe('duplicate costs', () => {
    it('a repeated request with one scanId calls the model once', async () => {
      const h = await asPlus();
      const b = await body(h);
      await post(h, b).expect(202);
      await post(h, b).expect(200);
      await drain();
      await post(h, b).expect(200);
      expect(vision.calls).toHaveLength(1);
    });

    it('reopening and polling a result calls nothing', async () => {
      const h = await asPlus();
      const { b } = await scanLunch(h);
      for (let i = 0; i < 3; i++) await poll(h, b.scanId);
      expect(vision.calls).toHaveLength(1);
    });

    it('a double tap with two scanIds becomes one model call and two answers', async () => {
      const h = await asPlus();
      const first = await body(h, 'double-tap');
      const second = await body(h, 'double-tap');
      const [a, b] = await Promise.all([post(h, first), post(h, second)]);
      expect([a.status, b.status].sort()).toEqual([200, 202]);
      await drain();
      expect(vision.calls).toHaveLength(1);
      const [x, y] = [await poll(h, first.scanId), await poll(h, second.scanId)];
      expect(x.status).toBe('succeeded');
      expect(y.status).toBe('succeeded');
      expect(y.result.totals).toEqual(x.result.totals);
    });

    it('a free user double tapping is charged once and not sent to the paywall', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const first = await body(h, 'free-tap');
      const second = await body(h, 'free-tap');
      const [a, b] = await Promise.all([post(h, first), post(h, second)]);
      expect([a.status, b.status].sort()).toEqual([200, 202]);
      await drain();
      await poll(h, first.scanId);
      await poll(h, second.scanId);
      expect((await t.http().get('/v1/me').set(h)).body.freeScans.used).toBe(1);
    });

    it('caches within one account only', async () => {
      const a = await asPlus();
      const b = await asPlus();
      const seed = randomUUID();
      await post(a, await body(a, seed)).expect(202);
      await drain();
      await post(a, await body(a, seed)).expect(200);
      await post(b, await body(b, seed)).expect(202);
      await drain();
      expect(vision.calls).toHaveLength(2);
    });

    it('a language change is a new scan, because food names differ', async () => {
      const h = await asPlus();
      const seed = randomUUID();
      await post(h, await body(h, seed)).expect(202);
      await drain();
      const inBangla = await body(h, seed);
      await t.http().post('/v1/scans').set(h).set(INTEGRITY).set('Accept-Language', 'bn').send(inBangla).expect(202);
      await drain();
      expect(vision.calls).toHaveLength(2);
      expect(vision.calls[1]!.context).toContain('Bangla');
    });

    it('caches a rejected photo too, so retrying it costs nothing', async () => {
      const h = await asPlus();
      fake.enqueue({ status: 'no_food', mealName: null, items: [], assumptions: [], question: 'A cat', retake: null });
      const seed = randomUUID();
      await post(h, await body(h, seed)).expect(202);
      await drain();
      const again = await post(h, await body(h, seed)).expect(200);
      expect(again.body).toMatchObject({ status: 'rejected', deduped: true, error: { code: 'NO_FOOD_DETECTED' } });
      expect(vision.calls).toHaveLength(1);
    });

    it('never caches a failure', async () => {
      const h = await asPlus();
      fake.enqueue(Object.assign(new Error('bad'), { status: 400 }));
      const seed = randomUUID();
      await post(h, await body(h, seed)).expect(202);
      await drain();
      await post(h, await body(h, seed)).expect(202);
      await drain();
      expect(vision.calls).toHaveLength(2);
    });

    it('the same meal can still be logged twice on purpose', async () => {
      const h = await asPlus();
      fake.enqueue(structuredClone(LUNCH));
      const seed = randomUUID();
      const one = await body(h, seed);
      await post(h, one).expect(202);
      await drain();
      const first = await poll(h, one.scanId);
      const two = await body(h, seed);
      await post(h, two).expect(200);
      const second = await poll(h, two.scanId);
      expect(vision.calls).toHaveLength(1);
      await t.http().post('/v1/meals').set(h).set(idem()).send(mealFrom(first)).expect(201);
      await t.http().post('/v1/meals').set(h).set(idem()).send(mealFrom(second)).expect(201);
      const date = new Date().toISOString().slice(0, 10);
      expect((await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.meals).toHaveLength(2);
    });
  });

  describe('invalid and unusable photos', () => {
    /** Straight into storage: a presigned S3 PUT accepts any bytes, so the API cannot rely on the upload step. */
    const upload = async (h: Record<string, string>, raw: Buffer) => {
      const p = await t.http().post('/v1/uploads/presign').set(h).send({ kind: 'meal_photo', contentType: 'image/jpeg', bytes: raw.length }).expect(200);
      await t.get<StorageService>(StorageService).put(p.body.key, raw, 'image/jpeg');
      return post(h, { scanId: randomUUID(), imageKey: p.body.key, imageHash: createHash('sha256').update(raw).digest('hex') });
    };

    it('refuses bad files before any model call or charge', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const notImage = await upload(h, Buffer.from('this is not an image at all'));
      expect(notImage.status).toBe(400);
      expect(notImage.body.error).toMatchObject({ code: 'IMAGE_INVALID', details: { reason: 'corrupt' } });
      const gif = await upload(h, await sharp({ create: { width: 400, height: 400, channels: 3, background: '#000' } }).gif().toBuffer());
      expect(gif.body.error.details.reason).toBe('unsupported_type');
      const tiny = await upload(h, await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).jpeg().toBuffer());
      expect(tiny.body.error.details.reason).toBe('too_small');
      expect(vision.calls).toHaveLength(0);
      expect((await t.http().get('/v1/me').set(h)).body.freeScans.used).toBe(0);
    });

    it('refuses a hash that does not match the file, so the cache cannot be bypassed', async () => {
      const h = await asPlus();
      const b = await body(h);
      const res = await post(h, { ...b, imageHash: 'f'.repeat(64) }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'IMAGE_INVALID', details: { reason: 'hash_mismatch' } });
    });

    it('asks for another photo when the picture is unclear, free of charge', async () => {
      const h = bearer((await signIn(t)).accessToken);
      fake.enqueue({ status: 'unclear', mealName: null, items: [], assumptions: [], question: 'Too dark to see. Try with more light.', retake: 'too_dark' });
      const b = await body(h);
      await post(h, b).expect(202);
      await drain();
      expect(await poll(h, b.scanId)).toMatchObject({
        status: 'rejected',
        chargedFreeScan: false,
        error: { code: 'IMAGE_UNCLEAR' },
        result: { outcome: 'unclear', retakeReason: 'too_dark', clarifyingQuestion: 'Too dark to see. Try with more light.', items: [] },
      });
      expect((await t.http().get('/v1/me').set(h)).body.freeScans.remaining).toBe(1);
    });
  });

  describe('bad model output', () => {
    it.each([
      ['truncated JSON', '{"status":"ok","mealName":"Ri'],
      ['plain text', 'Sorry, I cannot help with that.'],
    ])('fails safely on %s: nothing shown, no charge, cost still recorded', async (_name, text) => {
      const h = bearer((await signIn(t)).accessToken);
      vision.script({ output: text, truncated: true });
      const b = await body(h);
      await post(h, b).expect(202);
      await drain();
      expect(await poll(h, b.scanId)).toMatchObject({ status: 'failed', result: null, chargedFreeScan: false, error: { code: 'MODEL_OUTPUT_INVALID' } });
      expect((await t.http().get('/v1/me').set(h)).body.freeScans.remaining).toBe(1);
      expect((await usage().findOne())?.spendMicroUsd).toBeGreaterThan(0);
    });

    it('rejects a valid JSON object of the wrong shape', async () => {
      const h = await asPlus();
      fake.enqueue({ ...LUNCH, items: [{ name: 'Rice' }] });
      const b = await body(h);
      await post(h, b).expect(202);
      await drain();
      expect((await poll(h, b.scanId)).error.code).toBe('MODEL_OUTPUT_INVALID');
    });
  });

  describe('a worker that comes back late', () => {
    it('drops a scan the app gave up on: no model call, no charge', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const b = await body(h);
      await post(h, b).expect(202);
      await drain();
      const stale = await body(h, 'stale-photo');
      await scans().create({ _id: stale.scanId, userId: (await scans().findById(b.scanId))!.userId, status: 'queued', imageKey: stale.imageKey, imageHash: stale.imageHash, queuedAt: new Date(Date.now() - 3 * 3600_000) });
      const calls = vision.calls.length;
      await t.get<ScanProcessor>(ScanProcessor).process(stale.scanId);
      expect(vision.calls).toHaveLength(calls);
      expect(await poll(h, stale.scanId)).toMatchObject({ status: 'failed', chargedFreeScan: false, error: { code: 'TIMEOUT' } });
    });
  });

  describe('allowances and limits', () => {
    it('enforces the free allowance on the server', async () => {
      const h = bearer((await signIn(t)).accessToken);
      await post(h, await body(h)).expect(202);
      await drain();
      const limited = await post(h, await body(h)).expect(402);
      expect(limited.body.error.code).toBe('SCAN_LIMIT_REACHED');
      expect(vision.calls).toHaveLength(1);
    });

    it('enforces the Plus daily limit', async () => {
      const h = await asPlus();
      await config().set('limits.plus.scansPerDay', 1);
      await post(h, await body(h)).expect(202);
      await drain();
      expect((await post(h, await body(h)).expect(402)).body.error.details).toMatchObject({ plan: 'plus', period: 'day' });
      await config().set('limits.plus.scansPerDay', 30);
    });

    it('rate limits one account', async () => {
      await config().set('limits.scanAbuse', { perUserMinute: 0.02 }); // 2 after RATE_LIMIT_MULTIPLIER
      const h = await asPlus();
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push((await post(h, await body(h))).status);
        await drain();
      }
      expect(results).toEqual([202, 202, 429]);
      await config().set('limits.scanAbuse', {});
    });
  });

  describe('daily caps', () => {
    it('stops at the request cap, even when calls run at the same moment', async () => {
      await caps(2, 100);
      const users = await Promise.all(Array.from({ length: 6 }, () => asPlus()));
      const bodies = await Promise.all(users.map((h) => body(h)));
      const accepted = await Promise.all(users.map((h, i) => post(h, bodies[i]!)));
      await drain();
      expect(vision.calls.length).toBeLessThanOrEqual(2);
      const day = await usage().findOne();
      expect(day).toMatchObject({ requests: 2, reservedRequests: 0, reservedMicroUsd: 0 });
      const states = await Promise.all(users.map((h, i) => (accepted[i]!.status === 202 ? poll(h, bodies[i]!.scanId) : null)));
      expect(states.filter((s) => s?.status === 'succeeded')).toHaveLength(2);
      expect(states.filter((s) => s?.status === 'failed').every((s) => s.error.code === 'AI_UNAVAILABLE')).toBe(true);
    });

    it('stops at the spending cap before a call that could pass it', async () => {
      await caps(1000, 0.000001);
      const h = await asPlus();
      const res = await post(h, await body(h)).expect(503);
      expect(res.body.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { reason: 'daily_cap' } });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(vision.calls).toHaveLength(0);
    });

    it('a scan already queued when the cap closes fails at once, without charge', async () => {
      const h = bearer((await signIn(t)).accessToken);
      const b = await body(h);
      await post(h, b).expect(202);
      await caps(0, 0);
      await drain();
      expect(await poll(h, b.scanId)).toMatchObject({ status: 'failed', chargedFreeScan: false, error: { code: 'AI_UNAVAILABLE' } });
      expect(vision.calls).toHaveLength(0);
    });

    it('releases a reservation when a call fails, and does not count it as spend', async () => {
      const h = await asPlus();
      fake.enqueue(Object.assign(new Error('bad'), { status: 400 }));
      await post(h, await body(h)).expect(202);
      await drain();
      expect(await usage().findOne()).toMatchObject({ requests: 1, failures: 1, spendMicroUsd: 0, reservedRequests: 0, reservedMicroUsd: 0 });
    });
  });

  describe('separate from the monthly AI budget', () => {
    it('an exhausted monthly budget does not stop scans, and scan spend does not use it up', async () => {
      const ai = t.get<AiService>(AiService);
      const rows = t.get<Model<AiUsageDailyDoc>>(getModelToken('AiUsageDaily'));
      const date = new Date().toISOString().slice(0, 10);
      await rows.create({ date, feature: 'chat', model: 'gemini-3.8-flash', requests: 1, costUsd: 1.94 });
      await expect(ai.assertAvailable('chat')).rejects.toMatchObject({ reason: 'budget' });
      const h = await asPlus();
      await post(h, await body(h)).expect(202);
      await drain();
      const spent = await ai.monthSpend();
      expect(spent).toBeCloseTo(1.94, 6);
      const gemini = await rows.findOne({ date, model: 'gemini-3.5-flash-lite' }).lean<AiUsageDailyDoc>();
      expect(gemini?.feature).toBe('vision');
      expect(gemini?.costUsd).toBeGreaterThan(0);
      await rows.deleteMany({ feature: 'chat', model: 'gemini-3.8-flash' });
    });
  });
});
