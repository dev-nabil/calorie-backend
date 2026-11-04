import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, signIn } from '../setup/helpers';
import { UsersService } from '../../src/modules/users/users.service';
import { KvStore } from '../../src/infra/kv/kv-store';
import { EmailSender, type MemoryEmailSender } from '../../src/modules/auth/providers';

describe('/v1/me (M1-T5)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('GET returns the profile with defaults and no-store caching', async () => {
    const s = await signIn(t);
    const res = await t.http().get('/v1/me').set(bearer(s.accessToken)).expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toMatchObject({
      emailVerified: true,
      locale: 'en-GB',
      units: { weight: 'kg', height: 'cm', energy: 'kcal', water: 'ml' },
      entitlement: { plan: 'free', isPlus: false, activeUntil: null },
      status: 'active',
    });
  });

  it('PATCH updates units, timezone, name, flags and stamps consents', async () => {
    const s = await signIn(t);
    const res = await t
      .http()
      .patch('/v1/me')
      .set(bearer(s.accessToken))
      .send({
        displayName: 'Alex',
        timezone: 'Asia/Tokyo',
        units: { weight: 'lb' },
        flags: { analyticsOptOut: true },
        consents: { termsVersion: '2026-11', privacyVersion: '2026-11', healthData: true },
      })
      .expect(200);
    expect(res.body).toMatchObject({ displayName: 'Alex', timezone: 'Asia/Tokyo', units: { weight: 'lb', height: 'cm' }, flags: { analyticsOptOut: true } });
    expect(res.body.consents.termsVersion).toBe('2026-11');
    expect(res.body.consents.healthDataAt).toEqual(expect.any(String));
  });

  it('PATCH rejects unknown timezones, units and fields', async () => {
    const s = await signIn(t);
    for (const body of [{ timezone: 'Mars/Base' }, { units: { weight: 'stone' } }, { email: 'x@y.z' }, { consents: { healthData: false } }]) {
      const res = await t.http().patch('/v1/me').set(bearer(s.accessToken)).send(body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('DELETE signs out at once and blocks sign-in (BR-13, S-08)', async () => {
    const email = 'leaving@example.com';
    const s = await signIn(t, email);
    const res = await t.http().delete('/v1/me').set(bearer(s.accessToken)).expect(202);
    expect(res.body.status).toBe('pending_deletion');
    expect(new Date(res.body.purgeAfter).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    const me = await t.http().get('/v1/me').set(bearer(s.accessToken)).expect(401);
    expect(me.body.error.code).toBe('TOKEN_REVOKED');
    await t.http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    await t.get<KvStore>(KvStore).del(`otp:cooldown:${email}`);
    await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
    const code = t.get<MemoryEmailSender>(EmailSender).outbox.get(email);
    const blocked = await t.http().post('/v1/auth/email/verify').send({ email, code }).expect(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_DELETED');
  });

  it('a recreated account keeps the used free scan from the ledger (BR-01)', async () => {
    const email = 'again@example.com';
    const users = t.get<UsersService>(UsersService);
    const ledger = t.get<Model<{ emailHmac: string; freeScansUsed: number }>>(getModelToken('ScanLedger'));
    await ledger.create({ emailHmac: users.ledgerKey(email), freeScansUsed: 1 });
    const s = await signIn(t, email);
    expect(s.user.freeScans).toEqual({ allowance: 1, used: 1, remaining: 0 });
  });

  it('rejects requests without or with a bad token', async () => {
    expect((await t.http().get('/v1/me').expect(401)).body.error.code).toBe('UNAUTHENTICATED');
    await t.http().get('/v1/me').set(bearer('garbage')).expect(401);
  });
});
