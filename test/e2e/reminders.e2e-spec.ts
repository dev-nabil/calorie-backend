import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, signIn } from '../setup/helpers';
import { ReconcileService } from '../../src/jobs/reconcile';
import { ConsolePushSender, PushSender } from '../../src/modules/reminders/providers/push';
import { RemindersService } from '../../src/modules/reminders/reminders.service';

describe('Reminders (M9-T1) and the daily_logs reconcile job', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
  });
  afterAll(() => t.close());

  it('validates and stores reminders with a precomputed next fire time', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const empty = await t.http().get('/v1/reminders').set(h).expect(200);
    expect(empty.body).toMatchObject({ timezone: 'UTC', maxPerDay: 3, reminders: [] });
    expect(empty.body).not.toHaveProperty('quietHours');
    const put = await t.http().put('/v1/reminders').set(h).send({ timezone: 'Europe/London', reminders: [{ type: 'log_meal', time: '12:30', days: ['mon', 'wed'], enabled: true }, { type: 'water', time: '15:00', enabled: false }] }).expect(200);
    expect(put.body.timezone).toBe('Europe/London');
    expect(put.body.reminders.find((r: { type: string }) => r.type === 'log_meal').nextFireAt).toEqual(expect.any(String));
    expect(put.body.reminders.find((r: { type: string }) => r.type === 'water').nextFireAt).toBeNull();
    // Late-night and early-morning times are fine: the user picks the time.
    const night = await t.http().put('/v1/reminders').set(h).send({ reminders: [{ type: 'water', time: '23:00', enabled: true }, { type: 'water', time: '03:00', enabled: true }] }).expect(200);
    expect(night.body.reminders.map((r: { time: string }) => r.time)).toEqual(['03:00', '23:00']);
    const four = ['08:00', '10:00', '12:00', '14:00'].map((time) => ({ type: 'water', time, enabled: true }));
    expect((await t.http().put('/v1/reminders').set(h).send({ reminders: four }).expect(422)).body.error.details).toMatchObject({ max: 3, count: 4 });
    await t.http().put('/v1/reminders').set(h).send({ reminders: [{ type: 'water', time: '7:00', enabled: true }] }).expect(400);
  });

  it('stores a reminder that repeats every N hours (user-picked) until an end time', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const put = await t
      .http()
      .put('/v1/reminders')
      .set(h)
      .send({ timezone: 'UTC', reminders: [{ type: 'water', time: '08:00', enabled: true, everyHours: 2, endTime: '20:00' }, { type: 'log_meal', time: '13:00', enabled: true, endTime: '15:00' }] })
      .expect(200);
    const water = put.body.reminders.find((r: { type: string }) => r.type === 'water');
    expect(water).toMatchObject({ time: '08:00', everyHours: 2, endTime: '20:00' });
    expect(new Date(water.nextFireAt).getUTCMinutes()).toBe(0);
    expect(new Date(water.nextFireAt).getUTCHours() % 2).toBe(0);
    // No interval: once a day, and a stray end time is dropped.
    expect(put.body.reminders.find((r: { type: string }) => r.type === 'log_meal')).toMatchObject({ everyHours: null, endTime: null });
    const hourly = await t.http().put('/v1/reminders').set(h).send({ reminders: [{ type: 'water', time: '08:00', enabled: true, everyHours: 1, endTime: '20:00' }] }).expect(200);
    expect(hourly.body.reminders[0]).toMatchObject({ everyHours: 1, endTime: '20:00' });
    for (const everyHours of [0, 13, 1.5]) {
      await t.http().put('/v1/reminders').set(h).send({ reminders: [{ type: 'water', time: '08:00', enabled: true, everyHours, endTime: '20:00' }] }).expect(400);
    }
    const late = await t.http().put('/v1/reminders').set(h).send({ reminders: [{ type: 'water', time: '20:00', enabled: true, everyHours: 2, endTime: '08:00' }] }).expect(422);
    expect(late.body.error.details).toMatchObject({ time: '20:00', endTime: '08:00' });
  });

  it('the rings of a repeating reminder are not held back by the daily push cap', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().post('/v1/devices').set(h).set(idem()).send({ deviceId: 'p3', platform: 'android', pushToken: 'fcm-token-interval-1' }).expect(201);
    const put = await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', reminders: [{ type: 'water', time: '06:00', enabled: true, everyHours: 2, endTime: '16:00' }] }).expect(200);
    const push = t.get<ConsolePushSender>(PushSender);
    const svc = t.get<RemindersService>(RemindersService);
    const before = push.sent.length;
    let due = new Date(put.body.reminders[0].nextFireAt);
    for (let i = 0; i < 5; i++) {
      await svc.tick(new Date(due.getTime() + 1_000));
      due = new Date((await t.http().get('/v1/reminders').set(h).expect(200)).body.reminders[0].nextFireAt);
    }
    expect(push.sent.slice(before).filter((m) => m.token === 'fcm-token-interval-1')).toHaveLength(5);
  });

  it('the minute job sends due reminders to registered devices and schedules the next one', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().post('/v1/devices').set(h).set(idem()).send({ deviceId: 'p1', platform: 'android', pushToken: 'fcm-token-abcdefghij' }).expect(201);
    // Lock-screen copy is discreet by default; this person switched it off to see the reminder text.
    const put = await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', settings: { discreet: false }, reminders: [{ type: 'log_meal', time: '12:00', enabled: true }] }).expect(200);
    expect(put.body.settings).toEqual({ quietHours: null, pausedUntil: null, discreet: false });
    const due = new Date(put.body.reminders[0].nextFireAt);
    const push = t.get<ConsolePushSender>(PushSender);
    const svc = t.get<RemindersService>(RemindersService);
    const before = push.sent.length;
    const r = await svc.tick(new Date(due.getTime() + 30_000));
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(push.sent.slice(before)).toContainEqual(expect.objectContaining({ token: 'fcm-token-abcdefghij', title: 'Time to add a meal?', data: expect.objectContaining({ type: 'reminder.log_meal' }) }));
    const after = await t.http().get('/v1/reminders').set(h).expect(200);
    expect(new Date(after.body.reminders[0].nextFireAt).getTime()).toBe(due.getTime() + 86_400_000);
    // A timezone change moves the reminder to 12:00 local in the new zone.
    await t.http().patch('/v1/me').set(h).send({ timezone: 'Asia/Tokyo' }).expect(200);
    const moved = await t.http().get('/v1/reminders').set(h).expect(200);
    expect(moved.body.timezone).toBe('Asia/Tokyo');
    expect(new Date(moved.body.reminders[0].nextFireAt).getUTCHours()).toBe(3);
  });

  it('Milo buddy kinds: habit, check-in and weekly review, stable ids on edit, links, and the cap that skips the weekly review', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const put = await t
      .http()
      .put('/v1/reminders')
      .set(h)
      .send({
        timezone: 'Asia/Dhaka',
        reminders: [
          { type: 'log_meal', time: '20:30', enabled: true, category: 'dinner' },
          { type: 'habit', time: '18:00', enabled: true, habit: 'movement' },
          { type: 'check_in', time: '21:30', enabled: true, checkIn: 'day_review' },
          { type: 'weekly_review', time: '10:00', days: ['sun'], enabled: true },
        ],
      })
      .expect(200);
    const byType = (b: { reminders: { type: string }[] }, type: string) => b.reminders.find((r) => r.type === type) as Record<string, unknown>;
    expect(byType(put.body, 'log_meal')).toMatchObject({ category: 'dinner', link: '/coach?qa=log_meal&category=dinner' });
    expect(byType(put.body, 'habit')).toMatchObject({ habit: 'movement', link: '/today' });
    expect(byType(put.body, 'check_in')).toMatchObject({ checkIn: 'day_review', link: '/coach?qa=review_day' });
    expect(byType(put.body, 'weekly_review')).toMatchObject({ days: ['sun'], link: '/coach?qa=weekly_review' });
    expect(put.body.settings).toEqual({ quietHours: null, pausedUntil: null, discreet: true });
    // Editing keeps the id (the phone updates its alarm instead of adding one); a reminder left out is deleted.
    const meal = byType(put.body, 'log_meal');
    const edited = await t
      .http()
      .put('/v1/reminders')
      .set(h)
      .send({ reminders: [{ id: meal.id, type: 'log_meal', time: '21:00', enabled: true, category: 'dinner' }] })
      .expect(200);
    expect(edited.body.reminders).toHaveLength(1);
    expect(edited.body.reminders[0]).toMatchObject({ id: meal.id, time: '21:00' });
    // The weekly review is outside the daily cap; a fourth daily reminder is not.
    const three = ['08:00', '12:00', '18:00'].map((time) => ({ type: 'water', time, enabled: true }));
    await t.http().put('/v1/reminders').set(h).send({ reminders: [...three, { type: 'weekly_review', time: '10:00', days: ['sun'], enabled: true }] }).expect(200);
    const capped = await t.http().put('/v1/reminders').set(h).send({ reminders: [...three, { type: 'check_in', time: '21:00', enabled: true, checkIn: 'day_review' }] }).expect(422);
    expect(capped.body.error.details).toMatchObject({ reason: 'max_per_day' });
    // A weekly review needs exactly one day; a custom habit needs its label.
    await t.http().put('/v1/reminders').set(h).send({ reminders: [{ type: 'weekly_review', time: '10:00', enabled: true }] }).expect(422);
    await t.http().put('/v1/reminders').set(h).send({ reminders: [{ type: 'habit', time: '10:00', enabled: true, habit: 'custom' }] }).expect(422);
  });

  it('quiet hours (off by default) and pauses skip rings without sending them later; a timezone change re-times them', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const now = Date.now();
    const base = await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', reminders: [{ type: 'water', time: '06:00', enabled: true, everyHours: 2, endTime: '22:00' }] }).expect(200);
    const rings = (iso: string) => new Date(iso).getUTCHours();
    expect(base.body.settings.quietHours).toBeNull();
    // Quiet 21:00–09:00 (crosses midnight): the next ring is never inside it.
    const quiet = await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', settings: { quietHours: { start: '21:00', end: '09:00' } }, reminders: [{ type: 'water', time: '06:00', enabled: true, everyHours: 2, endTime: '22:00' }] }).expect(200);
    const next = rings(quiet.body.reminders[0].nextFireAt);
    expect(next >= 9 && next < 21).toBe(true);
    // Pause everything for two days: no ring before the day after the pause.
    const until = new Date(now + 2 * 86_400_000).toISOString().slice(0, 10);
    const paused = await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', settings: { pausedUntil: until }, reminders: [{ type: 'water', time: '12:00', enabled: true }] }).expect(200);
    expect(paused.body.reminders[0].nextFireAt.slice(0, 10) > until).toBe(true);
    // Per-reminder pause works the same way.
    const one = await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', settings: { pausedUntil: null }, reminders: [{ type: 'water', time: '12:00', enabled: true, pausedUntil: until }] }).expect(200);
    expect(one.body.reminders[0].nextFireAt.slice(0, 10) > until).toBe(true);
    // Timezone change: 12:00 local follows the person.
    await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', reminders: [{ type: 'water', time: '12:00', enabled: true }] }).expect(200);
    await t.http().patch('/v1/me').set(h).send({ timezone: 'Asia/Dhaka' }).expect(200);
    const moved = await t.http().get('/v1/reminders').set(h).expect(200);
    expect(new Date(moved.body.reminders[0].nextFireAt).getUTCHours()).toBe(6);
  });

  it('no burst after downtime, and an "already done" meal reminder is skipped', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().post('/v1/devices').set(h).set(idem()).send({ deviceId: 'pb', platform: 'android', pushToken: 'fcm-token-burst-12345' }).expect(201);
    const put = await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', settings: { discreet: false }, reminders: [{ type: 'log_meal', time: '12:00', enabled: true, category: 'lunch' }] }).expect(200);
    const due = new Date(put.body.reminders[0].nextFireAt);
    const push = t.get<ConsolePushSender>(PushSender);
    const svc = t.get<RemindersService>(RemindersService);
    const mine = () => push.sent.filter((m) => m.token === 'fcm-token-burst-12345').length;
    // Three hours late (the server was down): skipped, not sent, and moved to the next day.
    await svc.tick(new Date(due.getTime() + 3 * 3600_000));
    expect(mine()).toBe(0);
    const after = await t.http().get('/v1/reminders').set(h).expect(200);
    expect(new Date(after.body.reminders[0].nextFireAt).getTime()).toBe(due.getTime() + 86_400_000);
    // Lunch already logged that day: the lunch reminder is skipped.
    const day2 = new Date(due.getTime() + 86_400_000);
    // (The day is in the future for the API, so the meal goes straight into the collection.)
    await t.get<Model<unknown>>(getModelToken('Meal')).collection.insertOne({ userId: new Types.ObjectId(s.user.id), date: day2.toISOString().slice(0, 10), category: 'lunch', name: 'Rice', deletedAt: null });
    await svc.tick(new Date(day2.getTime() + 30_000));
    expect(mine()).toBe(0);
    // Not logged on day 3: it rings.
    await svc.tick(new Date(day2.getTime() + 86_400_000 + 30_000));
    expect(mine()).toBe(1);
  });

  it('dev hooks: run a scheduled job now and read the last push a user got (QA, development only)', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().get('/v1/dev/last-push').query({ userId: s.user.id }).expect(404);
    await t.http().post('/v1/devices').set(h).set(idem()).send({ deviceId: 'p2', platform: 'ios', pushToken: 'fcm-token-dev-hook-1' }).expect(201);
    const put = await t.http().put('/v1/reminders').set(h).send({ timezone: 'UTC', reminders: [{ type: 'water', time: '09:00', enabled: true }] }).expect(200);
    const due = new Date(put.body.reminders[0].nextFireAt);
    await t.http().post('/v1/dev/clock').send({ now: new Date(due.getTime() + 30_000).toISOString() }).expect(200);
    try {
      const run = await t.http().post('/v1/dev/jobs/reminders').send({}).expect(200);
      expect(run.body).toMatchObject({ name: 'reminders', job: 'reminders_tick', result: { sent: expect.any(Number) } });
      expect(run.body.result.sent).toBeGreaterThanOrEqual(1);
    } finally {
      await t.http().post('/v1/dev/clock').send({ offsetMs: 0 }).expect(200);
    }
    const last = await t.http().get('/v1/dev/last-push').query({ userId: s.user.id }).expect(200);
    expect(last.body).toMatchObject({ userId: s.user.id, count: 1, data: { type: 'reminder.water' } });
    await t.http().get('/v1/dev/last-push').query({ userId: 'nope' }).expect(400);
    expect((await t.http().post('/v1/dev/jobs/reconcile').send({}).expect(200)).body.result).toMatchObject({ drifted: expect.any(Number) });
    await t.http().post('/v1/dev/jobs/purge').send({}).expect(200);
    await t.http().post('/v1/dev/jobs/summaries').send({}).expect(400);
    expect((await t.http().post('/v1/dev/jobs/summaries').send({ conversationId: 'a'.repeat(24) }).expect(200)).body.result).toBe('');
    await t.http().post('/v1/dev/jobs/export').send({}).expect(404);
  });

  it('reconcile repairs drift in daily_logs (S-10)', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    const meal = await t.http().post('/v1/meals').set(h).set(idem()).send({ loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'lunch', name: 'Soup', source: 'manual', items: [{ name: 'Soup', grams: 300, kcal: 200, proteinG: 8, carbsG: 20, fatG: 8 }] }).expect(201);
    const users = t.get<Model<unknown>>(getModelToken('User'));
    await users.updateOne({ _id: s.user.id }, { $set: { lastActiveAt: new Date() } });
    await t.get<Model<unknown>>(getModelToken('DailyLog')).updateOne({ userId: meal.body.id ? (await users.findById(s.user.id).lean() as { _id: unknown })._id : null, date: meal.body.date }, { $set: { 'totals.kcal': 999 } });
    const result = await t.get<ReconcileService>(ReconcileService).run();
    expect(result.drifted).toBeGreaterThanOrEqual(1);
    const day = await t.http().get(`/v1/days/${meal.body.date}`).set(h).expect(200);
    expect(day.body.totals.kcal).toBe(200);
    expect((await t.get<ReconcileService>(ReconcileService).run()).drifted).toBe(0);
  });
});
