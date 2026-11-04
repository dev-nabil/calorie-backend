import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { ProviderIdentity } from './provider-identity';

/** Apple identity-token verification against Apple's JWKS (M1-T3). */
export abstract class AppleTokenVerifier {
  abstract verify(identityToken: string, rawNonce?: string): Promise<ProviderIdentity>;
}

export const APPLE_ISSUER = 'https://appleid.apple.com';

export class JoseAppleVerifier extends AppleTokenVerifier {
  constructor(
    private readonly audiences: string[],
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`)),
  ) {
    super();
  }
  async verify(identityToken: string, rawNonce?: string): Promise<ProviderIdentity> {
    if (!this.audiences.length) throw new Error('APPLE_BUNDLE_ID / APPLE_SERVICE_ID not configured');
    const { payload } = await jwtVerify(identityToken, this.keys, { issuer: APPLE_ISSUER, audience: this.audiences });
    if (!payload.sub) throw new Error('no subject');
    if (rawNonce !== undefined) {
      const expected = createHash('sha256').update(rawNonce).digest('hex');
      if (payload.nonce !== expected && payload.nonce !== rawNonce) throw new Error('nonce mismatch');
    }
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    return { subject: payload.sub, email, emailVerified: verified, name: null };
  }
}
