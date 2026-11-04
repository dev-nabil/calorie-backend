import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { APPLE_APP_ATTEST_ROOT_PEM } from './apple-root';
import { decodeCbor, type Cbor } from './cbor';

const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const NONCE_OID = Buffer.from('06092a864886f763640802', 'hex'); // 1.2.840.113635.100.8.2
const AAGUID_PROD = Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]);
const AAGUID_DEV = Buffer.from('appattestdevelop');

export interface AttestationResult {
  valid: boolean;
  reason?: string;
  publicKeyPem?: string;
  env?: 'production' | 'development';
}

function get(m: Cbor, k: string): Cbor {
  return m instanceof Map ? m.get(k) : undefined;
}

/** Reads the 32-byte nonce from the leaf certificate's Apple extension. */
export function nonceFromCert(der: Buffer): Buffer | null {
  const at = der.indexOf(NONCE_OID);
  if (at < 0) return null;
  const marker = der.indexOf(Buffer.from([0xa1, 0x22, 0x04, 0x20]), at);
  return marker < 0 || marker > at + 32 ? null : der.subarray(marker + 4, marker + 36);
}

/**
 * Apple App Attest (DEC-19, M1-T8). `verifyAttestation` runs once per key at registration;
 * `verifyAssertion` runs on guarded requests with the stored public key and counter.
 * https://developer.apple.com/documentation/devicecheck/validating_apps_that_connect_to_your_server
 */
export class AppAttestVerifier {
  private readonly root: X509Certificate;

  constructor(
    private readonly appId: string, // `<TEAMID>.<bundle id>`
    rootPem: string = APPLE_APP_ATTEST_ROOT_PEM,
    private readonly allowDevelopment = false,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = new X509Certificate(rootPem);
  }

  verifyAttestation(attestation: Buffer, keyIdB64: string, challenge: Buffer): AttestationResult {
    try {
      const obj = decodeCbor(attestation);
      if (get(obj, 'fmt') !== 'apple-appattest') return { valid: false, reason: 'fmt' };
      const x5c = get(get(obj, 'attStmt'), 'x5c');
      const authData = get(obj, 'authData');
      if (!Array.isArray(x5c) || x5c.length < 2 || !Buffer.isBuffer(authData)) return { valid: false, reason: 'shape' };
      const [leaf, inter] = [new X509Certificate(x5c[0] as Buffer), new X509Certificate(x5c[1] as Buffer)];
      const now = this.now();
      for (const c of [leaf, inter]) if (now < new Date(c.validFrom) || now > new Date(c.validTo)) return { valid: false, reason: 'cert_validity' };
      if (!inter.verify(this.root.publicKey) || !leaf.verify(inter.publicKey) || !leaf.checkIssued(inter)) return { valid: false, reason: 'chain' };
      const nonce = sha256(authData, sha256(challenge));
      const certNonce = nonceFromCert(leaf.raw);
      if (!certNonce || !certNonce.equals(nonce)) return { valid: false, reason: 'nonce' };
      const jwk = leaf.publicKey.export({ format: 'jwk' });
      const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
      const keyId = Buffer.from(keyIdB64, 'base64');
      if (!sha256(point).equals(keyId)) return { valid: false, reason: 'key_id' };
      if (!authData.subarray(0, 32).equals(sha256(Buffer.from(this.appId)))) return { valid: false, reason: 'rp_id' };
      if (authData.readUInt32BE(33) !== 0) return { valid: false, reason: 'counter' };
      const aaguid = authData.subarray(37, 53);
      const env = aaguid.equals(AAGUID_PROD) ? 'production' : aaguid.equals(AAGUID_DEV) ? 'development' : null;
      if (!env || (env === 'development' && !this.allowDevelopment)) return { valid: false, reason: 'aaguid' };
      const credLen = authData.readUInt16BE(53);
      if (!authData.subarray(55, 55 + credLen).equals(keyId)) return { valid: false, reason: 'credential_id' };
      return { valid: true, publicKeyPem: leaf.publicKey.export({ type: 'spki', format: 'pem' }).toString(), env };
    } catch (e) {
      return { valid: false, reason: `decode: ${(e as Error).message}` };
    }
  }

  /** Returns the new counter when the assertion is valid and newer than `storedCounter`. */
  verifyAssertion(assertion: Buffer, publicKeyPem: string, clientData: Buffer, storedCounter: number): { valid: boolean; counter?: number; reason?: string } {
    try {
      const obj = decodeCbor(assertion);
      const signature = get(obj, 'signature');
      const authData = get(obj, 'authenticatorData');
      if (!Buffer.isBuffer(signature) || !Buffer.isBuffer(authData) || authData.length < 37) return { valid: false, reason: 'shape' };
      const nonce = sha256(authData, sha256(clientData));
      if (!verify('sha256', nonce, createPublicKey(publicKeyPem), signature)) return { valid: false, reason: 'signature' };
      if (!authData.subarray(0, 32).equals(sha256(Buffer.from(this.appId)))) return { valid: false, reason: 'rp_id' };
      const counter = authData.readUInt32BE(33);
      if (counter <= storedCounter) return { valid: false, reason: 'replay' };
      return { valid: true, counter };
    } catch (e) {
      return { valid: false, reason: `decode: ${(e as Error).message}` };
    }
  }
}
