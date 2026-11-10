import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { seedAdmins } from '../setup/helpers';
import { MongoKvStore, type KvEntryDoc } from '../../src/infra/kv/kv-store';
import type { JobDoc, JobScheduleDoc } from '../../src/jobs/job.schema';
import { JobHandlers, JobQueue, JobScheduler } from '../../src/jobs/jobs.module';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { FoodScanBudget } from '../../src/modules/ai/food-scan-budget.service';

describe('No Redis: MongoDB key-value store, job queue and admin settings', () => {
  let t: TestApp;
  let login: Awaited<ReturnType<typeof seedAdmins>>;
  beforeAll(async () => {
    t = await createTestApp();
    login = await seedAdmins(t);
  });
  afterAll(() => t.close());

  describe('MongoKvStore', () => {
    let now = 1_000_000;
    const kv = () => new MongoKvStore(t.get<Model<KvEntryDoc>>(getModelToken('KvEntry')), () => now);

    it('sets, reads, expires and deletes', async () => {
      const s = kv();
      await s.set('a', 'one', 10);
      expect(await s.get('a')).toBe('one');
      now += 11_000;
      expect(await s.get('a')).toBeNull(); // expired before the TTL monitor removes the row
      await s.set('b', 'two', 60);
      await s.del('b');
      expect(await s.get('b')).toBeNull();
    });

    it('set-if-absent wins once while the key lives, and again once it expired', async () => {
      const s = kv();
      const results = await Promise.all(Array.from({ length: 5 }, () => s.setIfAbsent('lock', '1', 30)));
      expect(results.filter(Boolean)).toHaveLength(1);
      now += 31_000;
      expect(await s.setIfAbsent('lock', '2', 30)).toBe(true);
      expect(await s.get('lock')).toBe('2');
    });

    it('counts atomically within a window and restarts after it', async () => {
      const s = kv();
      const counts = await Promise.all(Array.from({ length: 10 }, () => s.incr('rl:x', 60)));
      expect(counts.map((c) => c.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      now += 30_000;
      expect(await s.incr('rl:x', 60)).toEqual({ count: 11, ttlSec: 30 });
      expect(await s.get('rl:x')).toBe('11');
      now += 31_000;
      expect(await s.incr('rl:x', 60)).toEqual({ count: 1, ttlSec: 60 });
    });
  });

  describe('JobQueue', () => {
    const jobs = () => t.get<Model<JobDoc>>(getModelToken('Job'));

    it('runs a job once per key and retries a failure with backoff', async () => {
      const handlers = t.get<JobHandlers>(JobHandlers);
      const queue = t.get<JobQueue>(JobQueue);
      const seen: unknown[] = [];
      handlers.register('test_ok', async (p) => void seen.push(p));
      handlers.register('test_fail', async () => {
        throw new Error('boom');
      });
      await queue.enqueue('test_ok', { n: 1 }, { key: 'once' });
      await queue.enqueue('test_ok', { n: 2 }, { key: 'once' });
      await queue.enqueue('test_fail', {});
      await queue.drain();
      expect(seen).toEqual([{ n: 1 }]);
      expect(await jobs().findOne({ key: 'once' }).lean()).toMatchObject({ status: 'done', attempts: 1, expiresAt: expect.any(Date) });
      const failed = await jobs().findOne({ name: 'test_fail' }).lean<JobDoc>();
      expect(failed).toMatchObject({ status: 'queued', attempts: 1, error: 'boom' });
      expect(failed!.runAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('picks up a job whose process died while running it', async () => {
      const seen: string[] = [];
      t.get<JobHandlers>(JobHandlers).register('test_orphan', async () => void seen.push('ran'));
      await jobs().create({ name: 'test_orphan', payload: {}, status: 'running', runAt: new Date(Date.now() - 600_000), attempts: 1, lockedUntil: new Date(Date.now() - 1000) });
      await t.get<JobQueue>(JobQueue).drain();
      expect(seen).toEqual(['ran']);
    });

    it('schedules a repeating job once per interval, across ticks and instances', async () => {
      const handlers = t.get<JobHandlers>(JobHandlers);
      const runs: number[] = [];
      handlers.register('test_daily', async () => void runs.push(1), 24 * 3600_000);
      const scheduler = t.get<JobScheduler>(JobScheduler);
      const now = new Date();
      await Promise.all([scheduler.tick(now), scheduler.tick(now), scheduler.tick(new Date(now.getTime() + 60_000))]);
      await t.get<JobQueue>(JobQueue).drain();
      expect(runs).toHaveLength(1);
      await scheduler.tick(new Date(now.getTime() + 25 * 3600_000));
      await t.get<JobQueue>(JobQueue).drain();
      expect(runs).toHaveLength(2);
      expect(await t.get<Model<JobScheduleDoc>>(getModelToken('JobSchedule')).findById('test_daily').lean()).toBeTruthy();
    });
  });

  describe('admin settings', () => {
    it('lists every setting with its default, and owners and admins only', async () => {
      const owner = await login('owner');
      const res = await t.http().get('/v1/admin/settings').set(owner).expect(200);
      expect(res.body.groups.map((g: { id: string }) => g.id)).toContain('scans');
      const cap = res.body.items.find((i: { key: string }) => i.key === 'scan.dailyRequestCap');
      expect(cap).toMatchObject({ kind: 'number', value: 500, defaultValue: 500, isDefault: true, min: 0, updatedBy: null });
      // Secrets never appear.
      expect(JSON.stringify(res.body)).not.toMatch(/GEMINI_API_KEY|JWT_|PEPPER|MONGODB/);
      const support = await login('support');
      await t.http().get('/v1/admin/settings').set(support).expect(403);
      await t.http().get('/v1/admin/settings').expect(401);
    });

    it('validates, stores, audits and resets a setting; the service reads it at once', async () => {
      const admin = await login('admin');
      await t.http().put('/v1/admin/settings/scan.dailyRequestCap').set(admin).send({ value: -1, reason: 'test bad value' }).expect(400);
      await t.http().put('/v1/admin/settings/scan.dailyRequestCap').set(admin).send({ value: '10', reason: 'test bad type' }).expect(400);
      await t.http().put('/v1/admin/settings/made.up').set(admin).send({ value: 1, reason: 'unknown key' }).expect(404);
      await t.http().put('/v1/admin/settings/scan.model').set(admin).send({ value: 'gemini-9-ultra', reason: 'no known price' }).expect(400);
      const ok = await t.http().put('/v1/admin/settings/scan.dailyRequestCap').set(admin).send({ value: 25, reason: 'launch week cap' }).expect(200);
      expect(ok.body).toMatchObject({ value: 25, isDefault: false, updatedBy: 'admin@nouri.dev' });
      expect(await t.get<FoodScanBudget>(FoodScanBudget).limits()).toMatchObject({ dailyRequests: 25 });
      const owner = await login('owner');
      const audit = await t.http().get('/v1/admin/audit-logs').query({ targetId: 'scan.dailyRequestCap' }).set(owner).expect(200);
      expect(JSON.stringify(audit.body)).toContain('setting.set');
      const reset = await t.http().post('/v1/admin/settings/scan.dailyRequestCap/reset').set(admin).send({ reason: 'back to default' }).expect(200);
      expect(reset.body).toMatchObject({ value: 500, isDefault: true });
      expect(await t.get<SettingsService>(SettingsService).get('scan.dailyRequestCap')).toBe(500);
    });

    it('trims URLs and lists', async () => {
      const admin = await login('admin');
      const r = await t.http().put('/v1/admin/settings/admin.appUrl').set(admin).send({ value: 'https://nouri.example/nouri-admin/', reason: 'deploy url' }).expect(200);
      expect(r.body.value).toBe('https://nouri.example/nouri-admin');
      await t.http().put('/v1/admin/settings/admin.appUrl').set(admin).send({ value: 'ftp://x', reason: 'bad scheme' }).expect(400);
    });
  });
});
