import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

/** Decoded Play Integrity verdict (standard request). */
export interface PlayVerdict {
  requestDetails?: { requestPackageName?: string; requestHash?: string; nonce?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  accountDetails?: { appLicensingVerdict?: string };
}

export const requestHashFor = (clientData: Buffer): string => createHash('sha256').update(clientData).digest('base64url');

/**
 * Verdict rules (DEC-19): our package, the request hash bound to this request, issued within
 * 5 minutes, app recognised by Play and a device that meets device integrity.
 */
export function evaluatePlayVerdict(v: PlayVerdict, expect: { packageName: string; requestHash: string; now: number; maxAgeMs?: number }): { valid: boolean; reason?: string } {
  const d = v.requestDetails ?? {};
  if (d.requestPackageName !== expect.packageName) return { valid: false, reason: 'package' };
  if (d.requestHash !== expect.requestHash && d.nonce !== expect.requestHash) return { valid: false, reason: 'request_hash' };
  const ts = Number(d.timestampMillis ?? 0);
  if (!ts || Math.abs(expect.now - ts) > (expect.maxAgeMs ?? 5 * 60_000)) return { valid: false, reason: 'stale' };
  if (v.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') return { valid: false, reason: 'app' };
  if (!(v.deviceIntegrity?.deviceRecognitionVerdict ?? []).includes('MEETS_DEVICE_INTEGRITY')) return { valid: false, reason: 'device' };
  return { valid: true };
}

export type PlayDecoder = (token: string) => Promise<PlayVerdict>;

/** Decodes a token with the Play Integrity API using the service account (server-side only). */
export function googlePlayDecoder(packageName: string, serviceAccountJson: string): PlayDecoder {
  const auth = new GoogleAuth({ credentials: JSON.parse(serviceAccountJson) as Record<string, string>, scopes: ['https://www.googleapis.com/auth/playintegrity'] });
  return async (token) => {
    const client = await auth.getClient();
    const res = await client.request<{ tokenPayloadExternal: PlayVerdict }>({
      url: `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`,
      method: 'POST',
      data: { integrity_token: token },
      timeout: 5000,
    });
    return res.data.tokenPayloadExternal;
  };
}
