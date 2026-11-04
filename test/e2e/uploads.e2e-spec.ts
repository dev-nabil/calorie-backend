import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, signIn } from '../setup/helpers';
import { AppConfigService } from '../../src/modules/content/app-config.service';

describe('POST /v1/uploads/presign (M4-T1) with the local driver', () => {
  let t: TestApp;
  let h: Record<string, string>;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
    h = bearer((await signIn(t)).accessToken);
  });
  afterAll(() => t.close());

  const presign = (body: object) => t.http().post('/v1/uploads/presign').set(h).send(body);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  it('returns a user-sharded key and a signed PUT URL that accepts the JPEG once uploaded', async () => {
    const p = await presign({ kind: 'meal_photo', contentType: 'image/jpeg' }).expect(200);
    expect(p.body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, maxBytes: 1500000 });
    expect(p.body.key).toMatch(/^u\/[a-f0-9]{24}\/meal_photo\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    const url = new URL(p.body.uploadUrl);
    expect(url.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/); // the origin the client used
    const put = await t.http().put(url.pathname + url.search).set('Content-Type', 'image/jpeg').send(jpeg).expect(200);
    expect(put.body).toEqual({ key: p.body.key, bytes: jpeg.length });
  });

  it('enforces type, size, signature and JPEG bytes', async () => {
    expect((await presign({ kind: 'meal_photo', contentType: 'image/png' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    await presign({ kind: 'meal_photo', contentType: 'image/jpeg', bytes: 5_000_000 }).expect(413);
    await presign({ kind: 'video', contentType: 'video/mp4' }).expect(400);
    const p = await presign({ kind: 'meal_photo', contentType: 'image/jpeg' }).expect(200);
    const url = new URL(p.body.uploadUrl);
    await t.http().put(url.pathname + url.search).set('Content-Type', 'image/jpeg').send(Buffer.from('not a jpeg')).expect(400);
    await t.http().put(url.pathname + url.search).set('Content-Type', 'audio/aac').send(jpeg).expect(400);
    const tampered = url.search.replace(/sig=[a-f0-9]+/, 'sig=' + '0'.repeat(64));
    expect((await t.http().put(url.pathname + tampered).set('Content-Type', 'image/jpeg').send(jpeg).expect(403)).body.error.code).toBe('FORBIDDEN');
    await t.http().post('/v1/uploads/presign').send({ kind: 'meal_photo', contentType: 'image/jpeg' }).expect(401);
  });

  it('B21: still presigns meal photos while the vision kill switch is on (Save photo and finish later)', async () => {
    const cfg = t.get<AppConfigService>(AppConfigService);
    await cfg.set('ai.kill.vision', true);
    try {
      await presign({ kind: 'meal_photo', contentType: 'image/jpeg' }).expect(200);
      await presign({ kind: 'voice_note', contentType: 'audio/aac' }).expect(200);
    } finally {
      await cfg.set('ai.kill.vision', false);
    }
  });

  it('presigns voice notes', async () => {
    const p = await presign({ kind: 'voice_note', contentType: 'audio/aac' }).expect(200);
    expect(p.body.key).toMatch(/\/voice_note\/.+\.m4a$/);
  });
});
