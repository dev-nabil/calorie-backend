import { randomUUID } from 'node:crypto';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import sharp from 'sharp';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn, uploadPhoto } from '../setup/helpers';
import { JobQueue } from '../../src/jobs/background-jobs';
import { AppConfigService } from '../../src/modules/content/app-config.service';
import { InlineScanQueue, ScanQueue } from '../../src/modules/scans/scan-queue';

describe('M4 leftovers: thumbnails, abuse limits, scan events', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
  });
  afterAll(() => t.close());

  it('M4-T8: a saved photo gets 320/1024 px thumbnails and signed URLs', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const jpeg = await sharp({ create: { width: 1280, height: 960, channels: 3, background: '#c96' } }).jpeg().toBuffer();
    const { key } = await uploadPhoto(t, h, undefined, jpeg);
    const meal = await t.http().post('/v1/meals').set(h).set(idem()).send({ loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'lunch', name: 'Plate', source: 'photo', imageKey: key, items: [] }).expect(201);
    expect(meal.body.photo.thumbUrl).toBeNull();
    await t.get<JobQueue>(JobQueue).drain();
    const day = await t.http().get(`/v1/days/${meal.body.date}`).set(h).expect(200);
    const photo = day.body.meals[0].photo;
    expect(photo.thumbKey).toMatch(/\/thumb\/.+_320\.jpg$/);
    const thumb = new URL(photo.thumbUrl);
    const img = await t.http().get(thumb.pathname + thumb.search).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect((await sharp(img.body as Buffer).metadata()).width).toBe(320);
    expect(photo.url).toContain(encodeURIComponent('_1024.jpg'));
  });

  it('M4-T7: per-device scan limits apply across accounts and are logged', async () => {
    await t.get<AppConfigService>(AppConfigService).set('limits.scanAbuse', { perDeviceHour: 2, perIpHour: 100, accountDailyAlert: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const h = bearer((await signIn(t)).accessToken);
      const { key, hash } = await uploadPhoto(t, h);
      const r = await t.http().post('/v1/scans').set(h).set(INTEGRITY).set('X-Device-Id', 'shared-device').send({ scanId: randomUUID(), imageKey: key, imageHash: hash });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([202, 202, 429]);
    const abuse = t.get<Model<{ kind: string; deviceId: string }>>(getModelToken('AbuseEvent'));
    expect(await abuse.countDocuments({ kind: 'scan_rate_limit', deviceId: 'shared-device' })).toBe(1);
    await (t.get<ScanQueue>(ScanQueue) as InlineScanQueue).drain();
    await t.get<AppConfigService>(AppConfigService).set('limits.scanAbuse', { perDeviceHour: 100, perIpHour: 100, accountDailyAlert: 100 });
  });

  it('GET /scans/{id}/events streams status changes until a final state', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const { key, hash } = await uploadPhoto(t, h);
    const scanId = randomUUID();
    await t.http().post('/v1/scans').set(h).set(INTEGRITY).send({ scanId, imageKey: key, imageHash: hash }).expect(202);
    const res = await t.http().get(`/v1/scans/${scanId}/events`).set(h).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c: Buffer) => (d += c)); r.on('end', () => cb(null, d)); }).expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = (res.body as string).split('\n\n').filter(Boolean).map((e) => JSON.parse(e.split('data: ')[1]!));
    expect(events.at(-1).status).toBe('succeeded');
    await t.http().get(`/v1/scans/${randomUUID()}/events`).set(h).expect(404);
  });
});
