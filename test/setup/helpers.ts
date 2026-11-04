import { createHash, randomUUID } from 'node:crypto';
import { EmailSender, MemoryEmailSender } from '../../src/modules/auth/providers';
import type { AuthSession } from '../../src/shared';
import type { TestApp } from './test-app';

export const INTEGRITY = { 'X-Device-Integrity': 'dev-assertion' };
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const idem = (key: string = randomUUID()) => ({ 'Idempotency-Key': key });

/** Signs up (or in) with an email code through the real endpoints. */
export async function signIn(t: TestApp, email = `user-${randomUUID().slice(0, 8)}@example.com`): Promise<AuthSession> {
  await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email }).expect(200);
  const code = (t.get<EmailSender>(EmailSender) as MemoryEmailSender).outbox.get(email.toLowerCase());
  const res = await t
    .http()
    .post('/v1/auth/email/verify')
    .send({ email, code, device: { deviceId: 'dev-1', platform: 'ios', appVersion: '1.0.0' } })
    .expect(200);
  return res.body as AuthSession;
}

/** Presigns and uploads a small JPEG through the local storage driver; returns its key and SHA-256. */
export async function uploadPhoto(t: TestApp, auth: Record<string, string>, seed: string = randomUUID(), raw?: Buffer): Promise<{ key: string; hash: string }> {
  const bytes = raw ?? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed)]);
  const p = await t.http().post('/v1/uploads/presign').set(auth).send({ kind: 'meal_photo', contentType: 'image/jpeg', bytes: bytes.length }).expect(200);
  const url = new URL(p.body.uploadUrl);
  await t.http().put(url.pathname + url.search).set(p.body.headers).send(bytes).expect(200);
  return { key: p.body.key, hash: createHash('sha256').update(bytes).digest('hex') };
}

/** Seeds one admin per role (password `correct-horse-battery`) and returns a login helper. */
export async function seedAdmins(t: TestApp): Promise<(role: 'owner' | 'admin' | 'support' | 'editor' | 'analyst') => Promise<Record<string, string>>> {
  const { getModelToken } = await import('@nestjs/mongoose');
  const { encryptSecret, hashPassword, newTotpSecret, totp } = await import('../../src/modules/admin/admin-crypto');
  const admins = t.get<{ create: (d: unknown) => Promise<unknown> }>(getModelToken('AdminUser'));
  const secrets = new Map<string, string>();
  for (const role of ['owner', 'admin', 'support', 'editor', 'analyst']) {
    const secret = newTotpSecret();
    secrets.set(role, secret);
    await admins.create({ email: `${role}@nouri.dev`, role, passwordHash: hashPassword('correct-horse-battery'), totpSecretEnc: encryptSecret(secret, t.config.OTP_PEPPER) });
  }
  return async (role) => {
    // Codes are single-use (QA B11); tests sign in many times inside one 30 s window.
    await (admins as unknown as { updateOne: (f: unknown, u: unknown) => Promise<unknown> }).updateOne({ email: `${role}@nouri.dev` }, { $set: { lastTotpStep: null } });
    const l = await t.http().post('/v1/admin/auth/login').send({ email: `${role}@nouri.dev`, password: 'correct-horse-battery' }).expect(200);
    const s = await t.http().post('/v1/admin/auth/totp').send({ challengeId: l.body.challengeId, code: totp(secrets.get(role)!) }).expect(200);
    const cookies = (s.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
    return { Cookie: cookies.join('; '), 'X-CSRF-Token': cookies.find((c) => c.startsWith('nouri_admin_csrf='))!.split('=')[1]! };
  };
}
