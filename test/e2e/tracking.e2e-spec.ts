import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, signIn } from '../setup/helpers';
import { dayKeyFor, addDays } from '../../src/domain/day-keys';

const item = (over: Record<string, unknown> = {}) => ({ name: 'Grilled chicken', grams: 150, kcal: 248, proteinG: 46.5, carbsG: 0, fatG: 5.4, ...over });

describe('Tracking (M3-T1..T3)', () => {
  let t: TestApp;
  let h: Record<string, string>;
  const tz = 'Europe/London';
  const today = () => dayKeyFor(new Date(), tz);

  beforeAll(async () => {
    t = await createTestApp();
    const s = await signIn(t);
    h = bearer(s.accessToken);
    await t.http().patch('/v1/me').set(h).send({ timezone: tz }).expect(200);
  });
  afterAll(() => t.close());

  const meal = (over: Record<string, unknown> = {}) => ({
    loggedAt: new Date().toISOString(),
    timezone: tz,
    category: 'lunch',
    name: 'Chicken and rice',
    source: 'manual',
    items: [item(), item({ name: 'White rice', grams: 160, kcal: 208, proteinG: 4.3, carbsG: 45, fatG: 0.5 })],
    ...over,
  });

  describe('meals', () => {
    it('creates idempotently, computes totals and updates the day', async () => {
      const key = idem();
      const body = meal({ portionMultiplier: 1.5 });
      const res = await t.http().post('/v1/meals').set(h).set(key).send(body).expect(201);
      expect(res.body).toMatchObject({ date: today(), timezone: tz, portionMultiplier: 1.5, totals: { kcal: 684, proteinG: 76.2 } });
      expect(res.body.items[0]).toMatchObject({ grams: 150, kcal: 248, scaled: { grams: 225, kcal: 372 } });
      const replay = await t.http().post('/v1/meals').set(h).set(key).send(body).expect(201);
      expect(replay.body.id).toBe(res.body.id);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const day = await t.http().get(`/v1/days/${today()}`).set(h).expect(200);
      expect(day.body.meals).toHaveLength(1);
      expect(day.body.totals.kcal).toBe(684);
      expect(day.body.streak).toMatchObject({ current: 1, loggedToday: true });
      await t.http().delete(`/v1/meals/${res.body.id}`).set(h).expect(200);
    });

    it('requires an Idempotency-Key and validates the body', async () => {
      expect((await t.http().post('/v1/meals').set(h).send(meal()).expect(400)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const bad = await t.http().post('/v1/meals').set(h).set(idem()).send(meal({ category: 'brunch' })).expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      await t.http().post('/v1/meals').set(h).set(idem()).send(meal({ timezone: 'Nowhere/City' })).expect(400);
      const future = await t.http().post('/v1/meals').set(h).set(idem()).send(meal({ date: addDays(today(), 2) })).expect(400);
      expect(future.body.error.code).toBe('INVALID_DAY_KEY');
      await t.http().post('/v1/meals').set(h).set(idem()).send(meal({ items: [item({ grams: 5000 })] })).expect(400);
    });

    it('edits, soft-deletes and restores with totals following (BR-17)', async () => {
      const created = await t.http().post('/v1/meals').set(h).set(idem()).send(meal({ category: 'dinner', date: addDays(today(), -1) })).expect(201);
      const id = created.body.id;
      const edited = await t
        .http()
        .patch(`/v1/meals/${id}`)
        .set(h)
        .send({ portionMultiplier: 0.5, items: [item({ excluded: false }), item({ name: 'Oil', grams: 5, kcal: 45, proteinG: 0, fatG: 5, excluded: true })] })
        .expect(200);
      expect(edited.body.totals.kcal).toBe(124);
      const date = created.body.date;
      expect((await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.totals.kcal).toBe(124);
      const deleted = await t.http().delete(`/v1/meals/${id}`).set(h).expect(200);
      expect(deleted.body.restorableUntil).toEqual(expect.any(String));
      expect((await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.totals.kcal).toBe(0);
      await t.http().post(`/v1/meals/${id}/restore`).set(h).expect(200);
      expect((await t.http().get(`/v1/days/${date}`).set(h).expect(200)).body.totals.kcal).toBe(124);
      const list = await t.http().get('/v1/meals').query({ from: addDays(today(), -7), to: today() }).set(h).expect(200);
      expect(list.body.items.map((m: { id: string }) => m.id)).toContain(id);
    });

    it('refuses restore after 7 days and unknown ids', async () => {
      const created = await t.http().post('/v1/meals').set(h).set(idem()).send(meal()).expect(201);
      await t.http().delete(`/v1/meals/${created.body.id}`).set(h).expect(200);
      const meals = t.get<Model<{ deletedAt: Date }>>(getModelToken('Meal'));
      await meals.updateOne({ _id: created.body.id }, { $set: { deletedAt: new Date(Date.now() - 8 * 86400000) } });
      const res = await t.http().post(`/v1/meals/${created.body.id}/restore`).set(h).expect(409);
      expect(res.body.error.code).toBe('MEAL_RESTORE_EXPIRED');
      expect((await t.http().patch(`/v1/meals/${'a'.repeat(24)}`).set(h).send({ name: 'x' }).expect(404)).body.error.code).toBe('MEAL_NOT_FOUND');
      await t.http().delete('/v1/meals/not-an-id').set(h).expect(400);
    });

    it('keeps users apart', async () => {
      const other = await signIn(t);
      const mine = await t.http().post('/v1/meals').set(h).set(idem()).send(meal()).expect(201);
      await t.http().delete(`/v1/meals/${mine.body.id}`).set(bearer(other.accessToken)).expect(404);
    });

    it('validates list ranges', async () => {
      await t.http().get('/v1/meals').query({ from: today(), to: addDays(today(), -1) }).set(h).expect(400);
      await t.http().get('/v1/meals').query({ from: addDays(today(), -200), to: today() }).set(h).expect(400);
      await t.http().get('/v1/meals').query({ from: 'yesterday', to: today() }).set(h).expect(400);
    });
  });

  describe('day keys per entry (BR-07)', () => {
    it('Tokyo 23:50 and London 00:10 land on their own local days', async () => {
      const s = await signIn(t);
      const hh = bearer(s.accessToken);
      const tokyo = await t
        .http()
        .post('/v1/meals')
        .set(hh)
        .set(idem())
        .send(meal({ timezone: 'Asia/Tokyo', loggedAt: '2026-10-31T14:50:00Z' }))
        .expect(201);
      const london = await t
        .http()
        .post('/v1/meals')
        .set(hh)
        .set(idem())
        .send(meal({ timezone: 'Europe/London', loggedAt: '2026-11-01T00:10:00Z' }))
        .expect(201);
      expect(tokyo.body.date).toBe('2026-10-31');
      expect(london.body.date).toBe('2026-11-01');
    });
  });

  describe('water (BR-09)', () => {
    it('adds in 250 ml steps, undoes, never goes below zero, replays by key', async () => {
      const s = await signIn(t);
      const hh = bearer(s.accessToken);
      const d = dayKeyFor(new Date(), 'UTC');
      const key = idem();
      const add = await t.http().post(`/v1/days/${d}/water`).set(hh).set(key).send({ amountMl: 250, timezone: 'UTC' }).expect(201);
      expect(add.body).toMatchObject({ totalMl: 250, targetMl: 2500, stepMl: 250 });
      await t.http().post(`/v1/days/${d}/water`).set(hh).set(key).send({ amountMl: 250, timezone: 'UTC' }).expect(201);
      const undo = await t.http().post(`/v1/days/${d}/water`).set(hh).set(idem()).send({ amountMl: -250, timezone: 'UTC' }).expect(201);
      expect(undo.body.totalMl).toBe(0);
      const below = await t.http().post(`/v1/days/${d}/water`).set(hh).set(idem()).send({ amountMl: -250, timezone: 'UTC' }).expect(422);
      expect(below.body.error.code).toBe('VALIDATION_FAILED');
      await t.http().post(`/v1/days/${d}/water`).set(hh).set(idem()).send({ amountMl: 100, timezone: 'UTC' }).expect(400);
      const day = await t.http().get(`/v1/days/${d}`).set(hh).expect(200);
      expect(day.body.water.entries).toHaveLength(2);
    });
  });

  describe('weights and progress', () => {
    it('logs weights idempotently and reports progress', async () => {
      const key = idem();
      const w = await t.http().post('/v1/weights').set(h).set(key).send({ weightKg: 78.04, timezone: tz }).expect(201);
      expect(w.body).toMatchObject({ weightKg: 78, date: today(), source: 'manual' });
      await t.http().post('/v1/weights').set(h).set(key).send({ weightKg: 78.04, timezone: tz }).expect(201);
      await t.http().post('/v1/weights').set(h).set(idem()).send({ weightKg: 77.5, timezone: tz, date: addDays(today(), -3) }).expect(201);
      const list = await t.http().get('/v1/weights').set(h).expect(200);
      expect(list.body.items).toHaveLength(2);
      await t.http().post('/v1/weights').set(h).set(idem()).send({ weightKg: 5, timezone: tz }).expect(400);
      const p = await t.http().get('/v1/progress').query({ range: 'week' }).set(h).expect(200);
      expect(p.body.days).toHaveLength(7);
      expect(p.body.to).toBe(today());
      expect(p.body.goal.currentWeightKg).toBe(78);
      expect(p.body.loggedDays).toBeGreaterThanOrEqual(1);
      expect((await t.http().get('/v1/progress').query({ range: 'quarter' }).set(h).expect(200)).body.days).toHaveLength(90);
      await t.http().get('/v1/progress').query({ range: 'year' }).set(h).expect(400);
    });
  });

  describe('GET /days/{date}', () => {
    it('returns targets from the active plan, remaining and a nudge for today', async () => {
      const res = await t.http().get(`/v1/days/${today()}`).set(h).expect(200);
      expect(res.body).toMatchObject({ date: today(), targets: { energyKcal: null, waterMl: 2500 } });
      expect(res.body.categories).toHaveLength(4);
      expect(res.body.nudge === null || typeof res.body.nudge.id === 'string').toBe(true);
      await t.http().get('/v1/days/2026-02-30').set(h).expect(400);
    });
  });
});
