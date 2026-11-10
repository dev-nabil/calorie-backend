import { randomUUID } from 'node:crypto';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn, uploadPhoto } from '../setup/helpers';
import { AiProvider, FakeAiProvider } from '../../src/modules/ai/ai.provider';
import { FakeFoodVisionProvider, FoodVisionProvider } from '../../src/modules/ai/providers/food-vision.provider';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { FakeProductDatabase, ProductDatabase } from '../../src/modules/foods/providers/product-database.provider';
import type { ProductDoc } from '../../src/modules/foods/schemas/products.schema';
import { LABEL_EXAMPLE } from '../../src/domain/nutrition-validator/fixtures';
import { ScanQueue } from '../../src/modules/scans/scan-queue';
import type { ScanDoc } from '../../src/modules/scans/schemas/scans.schema';
import { UsersService } from '../../src/modules/users/users.service';

const NUTELLA = {
  barcode: '3017624010701',
  name: 'Nutella',
  brand: 'Ferrero',
  servingG: 15,
  servingText: '15 g',
  packG: 400,
  per100g: { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: null, sugarG: 56.3, sodiumMg: 43 },
};
const LOCAL = '8941100500118';

describe('Packaged food: barcode lookup and label scans', () => {
  let t: TestApp;
  let fake: FakeAiProvider;
  let vision: FakeFoodVisionProvider;
  let db: FakeProductDatabase;
  const drain = () => t.get<ScanQueue>(ScanQueue).drain();
  const products = () => t.get<Model<ProductDoc>>(getModelToken('Product'));
  const scans = () => t.get<Model<ScanDoc>>(getModelToken('Scan'));

  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true', RATE_LIMIT_MULTIPLIER: '100' });
    fake = t.get<FakeAiProvider>(AiProvider);
    vision = t.get<FakeFoodVisionProvider>(FoodVisionProvider);
    db = t.get<FakeProductDatabase>(ProductDatabase);
  });
  beforeEach(async () => {
    fake.reset();
    vision.reset();
    db.reset();
    db.products.set(NUTELLA.barcode, structuredClone(NUTELLA));
    await products().deleteMany({});
    await t.get<SettingsService>(SettingsService).set('scan.dailyRequestCap', 1000);
    await t.get<SettingsService>(SettingsService).set('scan.dailySpendUsd', 100);
  });
  afterAll(() => t.close());

  const asPlus = async () => {
    const s = await signIn(t);
    await t.get<UsersService>(UsersService).users.updateOne({ _id: s.user.id }, { $set: { entitlement: { plan: 'plus', period: 'monthly', activeUntil: new Date(Date.now() + 86400000), source: 'promo' } } });
    return bearer(s.accessToken);
  };
  const lookup = (h: Record<string, string>, code: string) => t.http().get(`/v1/foods/barcode/${code}`).set(h);
  const scanLabel = async (h: Record<string, string>, over: object = {}) => {
    const { key, hash } = await uploadPhoto(t, h);
    const b = { scanId: randomUUID(), imageKey: key, imageHash: hash, category: 'snack', mode: 'label', ...over };
    await t.http().post('/v1/scans').set(h).set(INTEGRITY).send(b).expect(202);
    await drain();
    return (await t.http().get(`/v1/scans/${b.scanId}`).set(h).expect(200)).body;
  };

  describe('GET /foods/barcode/{code}', () => {
    it('returns the product with its basis and source, and caches it', async () => {
      const h = await asPlus();
      const r = await lookup(h, NUTELLA.barcode).expect(200);
      expect(r.body).toEqual({
        ...NUTELLA,
        found: true,
        complete: true,
        richIn: [],
        source: { type: 'product_database', recordId: null, name: 'Open Food Facts', reference: NUTELLA.barcode },
      });
      await lookup(h, NUTELLA.barcode).expect(200);
      expect(db.calls).toEqual([NUTELLA.barcode]);
      expect(fake.calls).toHaveLength(0);
      expect(vision.calls).toHaveLength(0);
    });

    it('answers found=false for an unknown barcode, cached for a day', async () => {
      const h = await asPlus();
      const r = await lookup(h, LOCAL).expect(200);
      expect(r.body).toMatchObject({ barcode: LOCAL, found: false, complete: false, name: null, source: null, per100g: { kcal: null } });
      const doc = await products().findById(LOCAL).lean<ProductDoc>();
      expect(doc!.expiresAt.getTime() - doc!.fetchedAt.getTime()).toBe(86_400_000);
    });

    it('flags a product without the macros as incomplete', async () => {
      db.products.set('12345670', { ...NUTELLA, barcode: '12345670', per100g: { ...NUTELLA.per100g, fatG: null } });
      const r = await lookup(await asPlus(), '12345670').expect(200);
      expect(r.body).toMatchObject({ found: true, complete: false });
    });

    it('says 503 when the database is down and nothing is cached, and serves a stale copy otherwise', async () => {
      const h = await asPlus();
      db.unavailable = true;
      const down = await lookup(h, NUTELLA.barcode).expect(503);
      expect(down.body.error.code).toBe('SERVICE_UNAVAILABLE');
      db.unavailable = false;
      await lookup(h, NUTELLA.barcode).expect(200);
      await products().updateOne({ _id: NUTELLA.barcode }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      db.unavailable = true;
      expect((await lookup(h, NUTELLA.barcode).expect(200)).body.name).toBe('Nutella');
    });

    it('refuses anything but 8 to 14 digits, and needs a session', async () => {
      const h = await asPlus();
      await lookup(h, '12ab5678').expect(400);
      await lookup(h, '1234567').expect(400);
      await t.http().get(`/v1/foods/barcode/${NUTELLA.barcode}`).expect(401);
    });
  });

  describe('label scans', () => {
    it('reads the label on the label prompt and stores values as printed, not as an estimate', async () => {
      const h = await asPlus();
      fake.enqueue(structuredClone(LABEL_EXAMPLE));
      const scan = await scanLabel(h);
      expect(vision.calls[0]!.mode).toBe('label');
      expect(scan).toMatchObject({ status: 'succeeded', mode: 'label', barcode: null, result: { outcome: 'ok', isEstimate: false, mealName: 'Bisk Club Chocolate Biscuits' } });
      expect(scan.result.items).toHaveLength(1);
      expect(scan.result.items[0]).toMatchObject({ grams: 25, kcal: 120, per100g: { kcal: 480 }, source: { type: 'package_label' } });
      const doc = await scans().findById(scan.scanId).lean<ScanDoc>();
      expect(doc).toMatchObject({ promptKey: 'label-scan', promptVersion: 1 });
    });

    it('rejects a photo without a nutrition table, free of charge', async () => {
      const h = await asPlus();
      fake.enqueue({ ...structuredClone(LABEL_EXAMPLE), status: 'no_food', question: 'Show me the back of the pack.' });
      const scan = await scanLabel(h);
      expect(scan).toMatchObject({ status: 'rejected', chargedFreeScan: false, error: { code: 'NO_LABEL_DETECTED' }, result: { notes: 'Show me the back of the pack.' } });
    });

    it('does not reuse a meal result for the same photo scanned as a label', async () => {
      const h = await asPlus();
      const { key, hash } = await uploadPhoto(t, h, 'same-photo');
      await t.http().post('/v1/scans').set(h).set(INTEGRITY).send({ scanId: randomUUID(), imageKey: key, imageHash: hash }).expect(202);
      await drain();
      fake.enqueue(structuredClone(LABEL_EXAMPLE));
      const label = { scanId: randomUUID(), imageKey: key, imageHash: hash, mode: 'label' };
      await t.http().post('/v1/scans').set(h).set(INTEGRITY).send(label).expect(202);
      await drain();
      expect(vision.calls.map((c) => c.mode)).toEqual(['meal', 'label']);
    });

    it('remembers a label scanned for an unknown barcode, for that user only', async () => {
      const h = await asPlus();
      expect((await lookup(h, LOCAL).expect(200)).body.found).toBe(false);
      fake.enqueue(structuredClone(LABEL_EXAMPLE));
      await scanLabel(h, { barcode: LOCAL });
      const again = await lookup(h, LOCAL).expect(200);
      expect(again.body).toMatchObject({
        found: true,
        complete: true,
        name: 'Bisk Club Chocolate Biscuits',
        servingG: 25,
        servingText: '3 biscuits (25 g)',
        packG: 75,
        per100g: { kcal: 480 },
        source: { type: 'package_label', reference: LOCAL },
      });
      expect((await lookup(await asPlus(), LOCAL).expect(200)).body.found).toBe(false);
    });
  });

  describe('logging a packaged food', () => {
    const meal = (items: object[]) => ({ loggedAt: new Date().toISOString(), timezone: 'Asia/Dhaka', category: 'snack', name: 'Nutella', source: 'barcode', items });

    it('takes the basis and source of the looked-up product, not the numbers sent', async () => {
      const h = await asPlus();
      await lookup(h, NUTELLA.barcode).expect(200);
      const r = await t
        .http()
        .post('/v1/meals')
        .set(h)
        .set(idem())
        .send(meal([{ name: 'Nutella', grams: 30, kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, barcode: NUTELLA.barcode }]))
        .expect(201);
      expect(r.body.source).toBe('barcode');
      expect(r.body.items[0]).toMatchObject({ grams: 30, kcal: 162, fatG: 9.3, per100g: { kcal: 539 }, source: { type: 'product_database', reference: NUTELLA.barcode } });
      expect(r.body.totals.kcal).toBe(162);
    });

    it('keeps the sent basis for a barcode the server has never looked up', async () => {
      const h = await asPlus();
      const per100g = { kcal: 400, proteinG: 10, carbsG: 50, fatG: 18, fiberG: null, sugarG: null, sodiumMg: null };
      const r = await t.http().post('/v1/meals').set(h).set(idem()).send(meal([{ name: 'Chips', grams: 50, kcal: 200, proteinG: 5, carbsG: 25, fatG: 9, per100g, barcode: '40000000' }])).expect(201);
      expect(r.body.items[0]).toMatchObject({ kcal: 200, source: { type: 'ai_estimate' } });
    });
  });
});
