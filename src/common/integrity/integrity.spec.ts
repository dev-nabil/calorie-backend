import { createHash, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppAttestVerifier, nonceFromCert } from './app-attest';
import { APPLE_APP_ATTEST_ROOT_PEM } from './apple-root';
import { decodeCbor, encodeCbor } from './cbor';
import { DeviceIntegrityVerifier } from './device-verifier';
import { evaluatePlayVerdict, requestHashFor, type PlayVerdict } from './play-integrity';

const fx = JSON.parse(readFileSync(resolve(__dirname, '../../../test/fixtures/integrity/app-attest.fixture.json'), 'utf8'));
const play = JSON.parse(readFileSync(resolve(__dirname, '../../../test/fixtures/integrity/play-integrity.fixture.json'), 'utf8')).verdict as PlayVerdict;
const sha = (...b: Buffer[]) => createHash('sha256').update(Buffer.concat(b)).digest();
const verifier = (allowDev = true) => new AppAttestVerifier(fx.appId, fx.rootPem, allowDev);

function assertion(clientData: string, counter: number, appId = fx.appId): Buffer {
  const c = Buffer.alloc(4);
  c.writeUInt32BE(counter);
  const authData = Buffer.concat([sha(Buffer.from(appId)), Buffer.from([0x01]), c]);
  const signature = sign('sha256', sha(authData, sha(Buffer.from(clientData))), fx.leafKeyPem);
  return encodeCbor(new Map<string, Buffer>([['signature', signature], ['authenticatorData', authData]]));
}

describe('CBOR', () => {
  it('round-trips the shapes App Attest uses', () => {
    const v = new Map<string, unknown>([['a', 1], ['b', Buffer.from([1, 2])], ['c', ['x', -5, true, null]], ['d', 300], ['e', 70000]]);
    const back = decodeCbor(encodeCbor(v as never)) as Map<string, unknown>;
    expect(back.get('a')).toBe(1);
    expect(back.get('c')).toEqual(['x', -5, true, null]);
    expect(back.get('e')).toBe(70000);
    expect(() => decodeCbor(Buffer.from([0x5a, 0, 0]))).toThrow(/truncated/);
  });
});

describe('App Attest (DEC-19, recorded fixture)', () => {
  it('embeds the real Apple root', () => {
    expect(() => new AppAttestVerifier('x', APPLE_APP_ATTEST_ROOT_PEM)).not.toThrow();
  });

  it('verifies the attestation chain, nonce, key id and authenticator data', () => {
    const r = verifier().verifyAttestation(Buffer.from(fx.attestation, 'base64'), fx.keyId, Buffer.from(fx.challenge));
    expect(r).toMatchObject({ valid: true, env: 'development' });
    expect(r.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('rejects wrong challenges, key ids, app ids, roots and development keys in production', () => {
    const att = Buffer.from(fx.attestation, 'base64');
    expect(verifier().verifyAttestation(att, fx.keyId, Buffer.from('other')).reason).toBe('nonce');
    expect(verifier().verifyAttestation(att, Buffer.alloc(32).toString('base64'), Buffer.from(fx.challenge)).reason).toBe('key_id');
    expect(new AppAttestVerifier('OTHER.app', fx.rootPem, true).verifyAttestation(att, fx.keyId, Buffer.from(fx.challenge)).reason).toBe('rp_id');
    expect(new AppAttestVerifier(fx.appId, APPLE_APP_ATTEST_ROOT_PEM, true).verifyAttestation(att, fx.keyId, Buffer.from(fx.challenge)).reason).toBe('chain');
    expect(verifier(false).verifyAttestation(att, fx.keyId, Buffer.from(fx.challenge)).reason).toBe('aaguid');
    expect(verifier().verifyAttestation(Buffer.from('junk'), fx.keyId, Buffer.from(fx.challenge)).valid).toBe(false);
    expect(nonceFromCert(Buffer.from('no extension here'))).toBeNull();
  });

  it('verifies assertions and rejects replays and tampering', () => {
    const v = verifier();
    const pem = v.verifyAttestation(Buffer.from(fx.attestation, 'base64'), fx.keyId, Buffer.from(fx.challenge)).publicKeyPem!;
    const data = 'POST /v1/scans 1793600000000';
    expect(v.verifyAssertion(assertion(data, 1), pem, Buffer.from(data), 0)).toEqual({ valid: true, counter: 1 });
    expect(v.verifyAssertion(assertion(data, 1), pem, Buffer.from(data), 1).reason).toBe('replay');
    expect(v.verifyAssertion(assertion(data, 2), pem, Buffer.from('POST /v1/other 1'), 1).reason).toBe('signature');
    expect(v.verifyAssertion(assertion(data, 3, 'OTHER.app'), pem, Buffer.from(data), 1).reason).toBe('rp_id');
  });
});

describe('Play Integrity verdicts (recorded shape)', () => {
  const now = 1_793_600_000_000;
  const data = Buffer.from(`POST /v1/scans ${now}`);
  const ok = (): PlayVerdict => ({ ...play, requestDetails: { ...play.requestDetails, requestHash: requestHashFor(data), timestampMillis: String(now - 1000) } });
  const expectFor = { packageName: 'app.nouri.test', requestHash: requestHashFor(data), now };

  it('accepts a recognised app on a device with integrity', () => {
    expect(evaluatePlayVerdict(ok(), expectFor)).toEqual({ valid: true });
  });
  it('rejects each failing verdict field', () => {
    expect(evaluatePlayVerdict({ ...ok(), requestDetails: { ...ok().requestDetails, requestPackageName: 'evil' } }, expectFor).reason).toBe('package');
    expect(evaluatePlayVerdict(ok(), { ...expectFor, requestHash: 'other' }).reason).toBe('request_hash');
    expect(evaluatePlayVerdict(ok(), { ...expectFor, now: now + 10 * 60_000 }).reason).toBe('stale');
    expect(evaluatePlayVerdict({ ...ok(), appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } }, expectFor).reason).toBe('app');
    expect(evaluatePlayVerdict({ ...ok(), deviceIntegrity: { deviceRecognitionVerdict: [] } }, expectFor).reason).toBe('device');
  });
});

describe('DeviceIntegrityVerifier', () => {
  const now = 1_793_600_000_000;
  const v = verifier();
  const pem = v.verifyAttestation(Buffer.from(fx.attestation, 'base64'), fx.keyId, Buffer.from(fx.challenge)).publicKeyPem!;
  const device = { _id: 'd1', integrity: { keyId: 'kid', publicKeyPem: pem, counter: 0 } };
  const model = {
    findOne: () => ({ lean: async () => device }),
    updateOne: async (_f: unknown, u: { $set: { 'integrity.counter': number } }) => {
      const ok = u.$set['integrity.counter'] > device.integrity.counter;
      if (ok) device.integrity.counter = u.$set['integrity.counter'];
      return { modifiedCount: ok ? 1 : 0 };
    },
  };
  const playOk: PlayVerdict = { ...play, requestDetails: { requestPackageName: 'app.nouri.test', requestHash: requestHashFor(Buffer.from(`GET /v1/x ${now}`)), timestampMillis: String(now) } };
  const dv = new DeviceIntegrityVerifier(model as never, v, { packageName: 'app.nouri.test', decode: async () => playOk }, () => now);

  it('checks App Attest assertions against the stored key and counter', async () => {
    const token = `appattest.kid.${assertion(`POST /v1/scans ${now}`, 5).toString('base64url')}`;
    expect(await dv.verify(token, { method: 'POST', path: '/v1/scans', timestamp: String(now) })).toEqual({ valid: true });
    expect((await dv.verify(token, { method: 'POST', path: '/v1/scans', timestamp: String(now) })).reason).toBe('replay');
  });
  it('checks Play Integrity tokens, timestamps and formats', async () => {
    expect(await dv.verify('playintegrity.tok', { method: 'GET', path: '/v1/x', timestamp: String(now) })).toEqual({ valid: true });
    expect((await dv.verify('playintegrity.tok', { method: 'GET', path: '/v1/x', timestamp: String(now - 3_600_000) })).reason).toBe('timestamp');
    expect((await dv.verify('something', { method: 'GET', path: '/v1/x', timestamp: String(now) })).reason).toBe('format');
    expect((await dv.verify('appattest.only', { method: 'GET', path: '/v1/x', timestamp: String(now) })).reason).toBe('format');
  });
});
