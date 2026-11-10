import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, INTEGRITY, signIn } from '../setup/helpers';
import { AppleTokenVerifier, EmailSender, GoogleTokenVerifier, JoseAppleVerifier, MemoryEmailSender, type ProviderIdentity } from '../../src/modules/auth/providers';
import { KvStore } from '../../src/infra/kv/kv-store';

class FakeGoogle extends GoogleTokenVerifier {
  tokens = new Map<string, ProviderIdentity>();
  async verify(idToken: string): Promise<ProviderIdentity> {
    const id = this.tokens.get(idToken);
    if (!id) throw new Error('bad token');
    return id;
  }
}

describe('Auth (M1-T2..T4)', () => {
  let t: TestApp;
  const google = new FakeGoogle();
  let applePrivate: Parameters<SignJWT['sign']>[0];
  const outbox = () => (t.get<EmailSender>(EmailSender) as MemoryEmailSender).outbox;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    applePrivate = privateKey;
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    t = await createTestApp({}, (b) =>
      b
        .overrideProvider(GoogleTokenVerifier)
        .useValue(google)
        .overrideProvider(AppleTokenVerifier)
        .useValue(new JoseAppleVerifier(['app.nouri.test'], createLocalJWKSet({ keys: [jwk] }))),
    );
  });
  afterAll(() => t.close());

  const appleToken = (claims: Record<string, unknown>, aud = 'app.nouri.test') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://appleid.apple.com')
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(applePrivate);

  describe('POST /v1/auth/email/start', () => {
    it('sends a 6-digit code', async () => {
      const res = await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email: 'Start@Example.com' }).expect(200);
      expect(res.body).toEqual({ sent: true, expiresInSec: 600, resendAfterSec: 60 });
      expect(outbox().get('start@example.com')).toMatch(/^\d{6}$/);
    });
    it('enforces the resend cooldown with Retry-After', async () => {
      const res = await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email: 'start@example.com' }).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBeDefined();
    });
    it('rejects disposable domains', async () => {
      const res = await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email: 'x@mailinator.com' }).expect(422);
      expect(res.body.error.code).toBe('DISPOSABLE_EMAIL');
    });
    it('validates the body and rejects unknown fields', async () => {
      const bad = await t.http().post('/v1/auth/email/start').send({ email: 'nope' }).expect(400);
      expect(bad.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: expect.any(Array) } });
      await t.http().post('/v1/auth/email/start').send({ email: 'a@example.com', extra: 1 }).expect(400);
    });
  });

  describe('POST /v1/auth/email/verify', () => {
    it('counts wrong attempts and locks after 5', async () => {
      const email = 'attempts@example.com';
      await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
      const code = outbox().get(email)!;
      const wrong = code === '000000' ? '111111' : '000000';
      const first = await t.http().post('/v1/auth/email/verify').send({ email, code: wrong }).expect(401);
      expect(first.body.error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 4 } });
      for (let i = 0; i < 4; i++) await t.http().post('/v1/auth/email/verify').send({ email, code: wrong }).expect(401);
      const locked = await t.http().post('/v1/auth/email/verify').send({ email, code }).expect(401);
      expect(locked.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');
    });
    it('signs up a new verified user, and the code is single use', async () => {
      const email = 'new@example.com';
      await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
      const code = outbox().get(email)!;
      const res = await t.http().post('/v1/auth/email/verify').send({ email, code }).expect(200);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', isNewUser: true, provider: 'email', user: { email, emailVerified: true } });
      expect(res.body.user.freeScans).toEqual({ allowance: 1, used: 0, remaining: 1 });
      const again = await t.http().post('/v1/auth/email/verify').send({ email, code }).expect(401);
      expect(again.body.error.code).toBe('OTP_EXPIRED');
    });
    it('returns isNewUser false for a returning user', async () => {
      const email = 'returning@example.com';
      const first = await signIn(t, email);
      await t.get<KvStore>(KvStore).del(`otp:cooldown:${email}`);
      const second = await signIn(t, email);
      expect(first.isNewUser).toBe(true);
      expect(second.isNewUser).toBe(false);
      expect(second.user.id).toBe(first.user.id);
    });
    it('rejects an expired code', async () => {
      const email = 'expired@example.com';
      await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
      const otps = t.get<Model<{ email: string; expiresAt: Date }>>(getModelToken('OtpCode'));
      await otps.updateOne({ email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await t.http().post('/v1/auth/email/verify').send({ email, code: outbox().get(email) }).expect(401);
      expect(res.body.error.code).toBe('OTP_EXPIRED');
    });
  });

  describe('refresh rotation and reuse detection', () => {
    it('rotates, and reusing an old token revokes the family', async () => {
      const s = await signIn(t);
      const r1 = await t.http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
      expect(r1.body.refreshToken).not.toBe(s.refreshToken);
      await t.http().get('/v1/me').set(bearer(r1.body.accessToken)).expect(200);
      const reuse = await t.http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      const after = await t.http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
      expect(after.body.error.code).toBe('TOKEN_REVOKED');
      const me = await t.http().get('/v1/me').set(bearer(r1.body.accessToken)).expect(401);
      expect(me.body.error.code).toBe('TOKEN_REVOKED');
    });
    it('rejects malformed and unknown refresh tokens', async () => {
      await t.http().post('/v1/auth/refresh').send({ refreshToken: 'x'.repeat(30) }).expect(401);
      await t.http().post('/v1/auth/refresh').send({ refreshToken: `${'a'.repeat(24)}.${'b'.repeat(40)}` }).expect(401);
    });
  });

  describe('POST /v1/auth/logout', () => {
    it('signs out the current session only', async () => {
      const email = 'logout@example.com';
      const a = await signIn(t, email);
      const b = await t.http().post('/v1/auth/refresh').send({ refreshToken: a.refreshToken }).expect(200);
      await t.http().post('/v1/auth/logout').set(bearer(b.body.accessToken)).send({}).expect(204);
      await t.http().get('/v1/me').set(bearer(b.body.accessToken)).expect(401);
    });
    it('allDevices signs out every session within one request (S-08)', async () => {
      const g = { subject: 'g-logout', email: 'multi@example.com', emailVerified: true, name: null };
      google.tokens.set('tok-multi-1', g);
      const one = await t.http().post('/v1/auth/google').send({ idToken: 'tok-multi-1' }).expect(200);
      const two = await t.http().post('/v1/auth/google').send({ idToken: 'tok-multi-1' }).expect(200);
      await t.http().post('/v1/auth/logout').set(bearer(one.body.accessToken)).send({ allDevices: true }).expect(204);
      await t.http().get('/v1/me').set(bearer(two.body.accessToken)).expect(401);
      await t.http().post('/v1/auth/refresh').send({ refreshToken: two.body.refreshToken }).expect(401);
    });
    it('requires a token', async () => {
      const res = await t.http().post('/v1/auth/logout').send({}).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('Google and Apple (M1-T3, S-07)', () => {
    it('creates an account and signs in again by subject', async () => {
      google.tokens.set('tok-alpha-001', { subject: 'g-1', email: 'g1@gmail.com', emailVerified: true, name: 'Gee' });
      const first = await t.http().post('/v1/auth/google').send({ idToken: 'tok-alpha-001' }).expect(200);
      expect(first.body).toMatchObject({ isNewUser: true, provider: 'google', user: { email: 'g1@gmail.com', displayName: 'Gee', emailVerified: true } });
      google.tokens.set('tok-bravo-002', { subject: 'g-1', email: 'changed@gmail.com', emailVerified: true, name: null });
      const second = await t.http().post('/v1/auth/google').send({ idToken: 'tok-bravo-002' }).expect(200);
      expect(second.body.isNewUser).toBe(false);
      expect(second.body.user.id).toBe(first.body.user.id);
    });
    it('auto-links an existing email account only when the provider verified the email', async () => {
      const email = 'linkme@example.com';
      const s = await signIn(t, email);
      google.tokens.set('tok-unverified', { subject: 'g-2', email, emailVerified: false, name: null });
      const refused = await t.http().post('/v1/auth/google').send({ idToken: 'tok-unverified' }).expect(409);
      expect(refused.body.error.code).toBe('ACCOUNT_LINK_REQUIRED');
      google.tokens.set('tok-verified', { subject: 'g-3', email, emailVerified: true, name: null });
      const linked = await t.http().post('/v1/auth/google').send({ idToken: 'tok-verified' }).expect(200);
      expect(linked.body.user.id).toBe(s.user.id);
      expect(linked.body.user.authProviders.sort()).toEqual(['email', 'google']);
    });
    it('rejects an invalid Google token', async () => {
      const res = await t.http().post('/v1/auth/google').send({ idToken: 'not-a-real-token' }).expect(401);
      expect(res.body.error.code).toBe('PROVIDER_TOKEN_INVALID');
    });
    it('verifies Apple tokens with JWKS, audience and nonce', async () => {
      const nonce = 'raw-nonce-123';
      const token = await appleToken({
        sub: 'apple-1',
        email: 'k7q2xm9d4p@privaterelay.appleid.com',
        email_verified: 'true',
        nonce: createHash('sha256').update(nonce).digest('hex'),
      });
      const res = await t.http().post('/v1/auth/apple').send({ identityToken: token, nonce, displayName: 'Alex' }).expect(200);
      expect(res.body).toMatchObject({ isNewUser: true, provider: 'apple', user: { displayName: 'Alex', emailVerified: true } });
      const badNonce = await t.http().post('/v1/auth/apple').send({ identityToken: token, nonce: 'other' }).expect(401);
      expect(badNonce.body.error.code).toBe('PROVIDER_TOKEN_INVALID');
      const wrongAud = await appleToken({ sub: 'apple-2', email: 'a@b.com', email_verified: true }, 'someone.else');
      await t.http().post('/v1/auth/apple').send({ identityToken: wrongAud }).expect(401);
    });
    it('does not link an Apple relay email to an unrelated account', async () => {
      const token = await appleToken({ sub: 'apple-3', email: 'linkme@example.com', email_verified: false });
      const res = await t.http().post('/v1/auth/apple').send({ identityToken: token }).expect(409);
      expect(res.body.error.code).toBe('ACCOUNT_LINK_REQUIRED');
    });
  });
});

describe('Integrity enforcement (DEC-19, M1-T8)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({}, undefined, { 'integrity.enforce': true });
  });
  afterAll(() => t.close());

  it('rejects /auth/email/start without an assertion when enforced', async () => {
    const res = await t.http().post('/v1/auth/email/start').send({ email: 'i@example.com' }).expect(403);
    expect(res.body.error.code).toBe('INTEGRITY_REQUIRED');
    await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email: 'i@example.com' }).expect(200);
  });
});

describe('DEV_FIXED_OTP (development sign-in code)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ DEV_FIXED_OTP: '000000' });
  });
  afterAll(() => t.close());

  it('sends 000000 and signs in with it; a wrong code still fails', async () => {
    const email = 'fixed@example.com';
    await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email }).expect(200);
    expect((t.get<EmailSender>(EmailSender) as MemoryEmailSender).outbox.get(email)).toBe('000000');
    const device = { deviceId: 'dev-fixed', platform: 'ios', appVersion: '1.0.0' };
    const bad = await t.http().post('/v1/auth/email/verify').send({ email, code: '123456', device }).expect(401);
    expect(bad.body.error.code).toBe('OTP_INVALID');
    const ok = await t.http().post('/v1/auth/email/verify').send({ email, code: '000000', device }).expect(200);
    expect(ok.body).toMatchObject({ isNewUser: true, provider: 'email', user: { email } });
  });
});
