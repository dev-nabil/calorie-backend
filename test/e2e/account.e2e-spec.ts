import { createHash, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, INTEGRITY, signIn, uploadPhoto } from '../setup/helpers';
import { encodeCbor } from '../../src/common/integrity/cbor';
import { JobQueue } from '../../src/jobs/jobs.module';
import { AccountService } from '../../src/modules/account/account.service';
import { EmailSender, type MemoryEmailSender } from '../../src/modules/auth/providers';
import { UsersService } from '../../src/modules/users/users.service';
import { KvStore } from '../../src/infra/kv/kv-store';
import { AppAttestVerifier } from '../../src/common/integrity/app-attest';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/integrity/app-attest.fixture.json'), 'utf8'));
const sha = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();

describe('Devices, export and purge (M1-T5, M1-T8)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ DEV_ROUTES: 'true' });
  });
  afterAll(() => t.close());

  it('registers, updates and removes devices idempotently', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const key = idem();
    const body = { deviceId: 'phone-1', platform: 'android', appVersion: '1.0.1', pushToken: 'fcm-token-1234567890' };
    const a = await t.http().post('/v1/devices').set(h).set(key).send(body).expect(201);
    expect(a.body).toMatchObject({ deviceId: 'phone-1', platform: 'android', pushEnabled: true });
    await t.http().post('/v1/devices').set(h).set(key).send(body).expect(201);
    const b = await t.http().post('/v1/devices').set(h).set(idem()).send({ deviceId: 'phone-1', platform: 'android', pushToken: null }).expect(201);
    expect(b.body.pushEnabled).toBe(false);
    await t.http().delete('/v1/devices/phone-1').set(h).expect(204);
    await t.http().post('/v1/devices').set(h).set(idem()).send({ deviceId: 'x', platform: 'windows' }).expect(400);
  });

  it('App Attest key registration needs a fresh one-time challenge', async () => {
    const h = bearer((await signIn(t)).accessToken);
    const c = await t.http().get('/v1/devices/attest-challenge').set(h).expect(200);
    expect(c.body.expiresInSec).toBe(300);
    const bad = await t.http().post('/v1/devices/attest').set(h).send({ deviceId: 'iphone', keyId: fx.keyId, attestation: fx.attestation, challenge: c.body.challenge }).expect(403);
    expect(bad.body.error.code).toBe('INTEGRITY_INVALID'); // fixture is bound to a different challenge and test root
    await t.http().post('/v1/devices/attest').set(h).send({ deviceId: 'iphone', keyId: fx.keyId, attestation: fx.attestation, challenge: c.body.challenge }).expect(403); // challenge used up
  });

  it('GET /me/export builds the JSON in a job and emails a signed link', async () => {
    const s = await signIn(t, 'exporter@example.com');
    const h = bearer(s.accessToken);
    await t.http().post('/v1/meals').set(h).set(idem()).send({ loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'lunch', name: 'Soup', source: 'manual', items: [] }).expect(201);
    const res = await t.http().get('/v1/me/export').set(h).expect(202);
    expect(res.body).toMatchObject({ status: 'queued', exportId: expect.any(String) });
    await t.get<JobQueue>(JobQueue).drain();
    const link = t.get<MemoryEmailSender>(EmailSender).links.get('exporter@example.com');
    expect(link?.kind).toBe('export');
    const url = new URL(link!.url);
    const file = await t.http().get(url.pathname + url.search).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c: Buffer) => (d += c)); r.on('end', () => cb(null, d)); }).expect(200);
    const data = JSON.parse(file.body as string);
    expect(data).toMatchObject({ format: 'nouri-export-v1', user: { email: 'exporter@example.com' }, meals: [{ name: 'Soup' }] });
    expect(JSON.stringify(data)).not.toContain('refreshTokenHash');
  });

  it('purges personal data 30 days after deletion but keeps the ledger (BR-13, BR-01)', async () => {
    const email = 'gone@example.com';
    const s = await signIn(t, email);
    const h = bearer(s.accessToken);
    await uploadPhoto(t, h);
    await t.http().post('/v1/meals').set(h).set(idem()).send({ loggedAt: new Date().toISOString(), timezone: 'UTC', category: 'lunch', name: 'Soup', source: 'manual', items: [] }).expect(201);
    const users = t.get<UsersService>(UsersService);
    const ledger = t.get<Model<{ emailHmac: string; freeScansUsed: number }>>(getModelToken('ScanLedger'));
    await ledger.create({ emailHmac: users.ledgerKey(email), freeScansUsed: 1 });
    await t.http().delete('/v1/me').set(h).expect(202);
    const account = t.get<AccountService>(AccountService);
    expect(await account.purge()).toBe(0); // not yet 30 days
    expect(await account.purge(new Date(Date.now() + 31 * 86_400_000))).toBe(1);
    const doc = await users.users.findById(s.user.id).lean();
    expect(doc).toMatchObject({ status: 'deleted', email: `deleted+${s.user.id}@deleted.invalid`, authProviders: [] });
    expect(await t.get<Model<unknown>>(getModelToken('Meal')).countDocuments({ userId: doc!._id })).toBe(0);
    expect(existsSync(join(t.config.LOCAL_STORAGE_DIR, 'u', s.user.id))).toBe(false);
    expect((await ledger.findOne({ emailHmac: users.ledgerKey(email) }))?.freeScansUsed).toBe(1);
    await t.get<KvStore>(KvStore).del(`otp:cooldown:${email}`);
    const again = await signIn(t, email); // the address can sign up again, with the used free scan
    expect(again.user.freeScans.remaining).toBe(0);
  });
});

describe('INTEGRITY_DRIVER=device with App Attest', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ INTEGRITY_DRIVER: 'device', INTEGRITY_ENFORCE: 'true', APPLE_APP_ATTEST_TEAM_ID: 'TEAMID1234', APPLE_BUNDLE_ID: 'app.nouri.test', APP_ATTEST_ROOT_PEM: fx.rootPem });
  });
  afterAll(() => t.close());

  it('accepts a request signed with a registered key and rejects a replay', async () => {
    const s = await signIn(t).catch(() => null);
    expect(s).toBeNull(); // email start itself is guarded: no assertion yet
    const devices = t.get<Model<unknown>>(getModelToken('Device'));
    const users = t.get<UsersService>(UsersService);
    const user = await users.create({ email: 'ios@example.com', emailVerified: true, provider: { provider: 'email', subject: 'ios@example.com', emailVerified: true } });
    const att = t.get<AppAttestVerifier>(AppAttestVerifier);
    const pem = att.verifyAttestation(Buffer.from(fx.attestation, 'base64'), fx.keyId, Buffer.from(fx.challenge)).publicKeyPem;
    await devices.create({ userId: user._id, deviceId: 'iphone', platform: 'ios', integrity: { keyId: 'kid1', publicKeyPem: pem, counter: 0, verifiedAt: new Date() } });
    const ts = String(Date.now());
    const c = Buffer.alloc(4);
    c.writeUInt32BE(1);
    const authData = Buffer.concat([sha(Buffer.from(fx.appId)), Buffer.from([1]), c]);
    const clientData = `POST /v1/auth/email/start ${ts}`;
    const assertion = encodeCbor(new Map<string, Buffer>([['signature', sign('sha256', sha(authData, sha(Buffer.from(clientData))), fx.leafKeyPem)], ['authenticatorData', authData]]));
    const headers = { 'X-Device-Integrity': `appattest.kid1.${assertion.toString('base64url')}`, 'X-Integrity-Timestamp': ts };
    await t.http().post('/v1/auth/email/start').set(headers).send({ email: 'ios@example.com' }).expect(200);
    const replay = await t.http().post('/v1/auth/email/start').set(headers).send({ email: 'ios2@example.com' }).expect(403);
    expect(replay.body.error.code).toBe('INTEGRITY_INVALID');
    await t.http().post('/v1/auth/email/start').set(INTEGRITY).send({ email: 'x@example.com' }).expect(403);
  });
});
