import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { resolveLive, type Live, type ProviderIdentity } from './provider-identity';

/** Apple identity-token verification against Apple's JWKS (M1-T3). */
export abstract class AppleTokenVerifier {
  abstract verify(identityToken: string, rawNonce?: string): Promise<ProviderIdentity>;
}

export const APPLE_ISSUER = 'https://appleid.apple.com';

export class JoseAppleVerifier extends AppleTokenVerifier {
  constructor(
    private readonly audiences: Live<string[]>,
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${APPLE_ISSUER}/auth/keys`)),
  ) {
    super();
  }
  async verify(identityToken: string, rawNonce?: string): Promise<ProviderIdentity> {
    const audience = await resolveLive(this.audiences);
    if (!audience.length) throw new Error('Apple sign-in is not configured (settings auth.apple.bundleId / auth.apple.serviceId)');
    const { payload } = await jwtVerify(identityToken, this.keys, { issuer: APPLE_ISSUER, audience });
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
