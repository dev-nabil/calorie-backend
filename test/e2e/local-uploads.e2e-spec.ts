import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, INTEGRITY, samplePhoto, signIn, uploadPhoto } from '../setup/helpers';
import { ScanQueue } from '../../src/modules/scans/scan-queue';

// A test server with local photo storage and the dev routes OFF (render.yaml): food scans must still work.
describe('Local storage uploads without dev routes (Render test profile)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'false' });
  });
  afterAll(() => t.close());

  it('dev helpers are closed, but the presigned upload and a food scan work', async () => {
    await t.http().get('/v1/dev/last-otp').query({ email: 'a@example.com' }).expect(404);
    await t.http().post('/v1/dev/clock').send({ offsetMs: 0 }).expect(404);
    const h = bearer((await signIn(t)).accessToken);
    const { key, hash } = await uploadPhoto(t, h, 'render-plate');
    const scanId = randomUUID();
    await t.http().post('/v1/scans').set(h).set(INTEGRITY).send({ scanId, imageKey: key, imageHash: hash, category: 'lunch' }).expect(202);
    await t.get<ScanQueue>(ScanQueue).drain();
    const done = await t.http().get(`/v1/scans/${scanId}`).set(h).expect(200);
    expect(done.body.status).toBe('succeeded');
  });

  it('behind a proxy that ends TLS, upload URLs use the scheme the client used (X-Forwarded-Proto)', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const bytes = await samplePhoto('proto');
    const presign = (proto?: string) => {
      const r = t.http().post('/v1/uploads/presign').set(h).set('Host', 'nouri-api.onrender.com');
      return (proto ? r.set('X-Forwarded-Proto', proto) : r).send({ kind: 'meal_photo', contentType: 'image/jpeg', bytes: bytes.length }).expect(200);
    };
    expect((await presign('https')).body.uploadUrl).toMatch(/^https:\/\/nouri-api\.onrender\.com\/v1\/dev\/uploads\?/);
    expect((await presign('https,http')).body.uploadUrl).toMatch(/^https:\/\//);
    expect((await presign()).body.uploadUrl).toMatch(/^http:\/\/nouri-api\.onrender\.com\//);
    expect((await presign('gopher')).body.uploadUrl).toMatch(/^http:\/\//);
  });
});
