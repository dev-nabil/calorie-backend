import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { ACCESS_TOKEN_TTL_SECONDS, ERROR_CODES } from '../../shared';
import { KvStore } from '../../infra/kv/kv-store';
import { ApiError } from '../errors/api-error';
import type { AuthUser } from './auth.decorators';

const ISSUER = 'nouri-api';
const AUDIENCE = 'nouri-app';
const revokedKey = (userId: string) => `auth:revokedBefore:${userId}`;
const revokedFamilyKey = (family: string) => `auth:revokedFamily:${family}`;

/**
 * Access tokens (15 min, HS256) and refresh-token secrets (DEC-05). Refresh tokens are
 * `<sessionId>.<secret>`; only an HMAC of the secret is stored. Revocation uses a per-user
 * `revokedBefore` timestamp in Redis checked on every request (S-08).
 */
@Injectable()
export class TokenService {
  private readonly accessKey: Uint8Array;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly kv: KvStore,
  ) {
    this.accessKey = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
  }

  async signAccess(user: AuthUser, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const iat = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date((iat + ACCESS_TOKEN_TTL_SECONDS) * 1000);
    const token = await new SignJWT({ sid: user.sessionId, iatMs: now.getTime(), typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.accessKey);
    return { token, expiresAt };
  }

  async verifyAccess(token: string): Promise<AuthUser> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.accessKey, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] }));
    } catch (e) {
      if (e instanceof joseErrors.JWTExpired) throw ApiError.unauthenticated(ERROR_CODES.TOKEN_EXPIRED, 'Access token expired');
      throw ApiError.unauthenticated();
    }
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw ApiError.unauthenticated();
    }
    const [revokedBefore, familyRevoked] = await Promise.all([
      this.kv.get(revokedKey(payload.sub)),
      this.kv.get(revokedFamilyKey(payload.sid)),
    ]);
    if (familyRevoked) throw ApiError.unauthenticated(ERROR_CODES.TOKEN_REVOKED, 'Session has been signed out');
    const issuedMs = typeof payload.iatMs === 'number' ? payload.iatMs : (payload.iat ?? 0) * 1000;
    if (revokedBefore && issuedMs <= Number(revokedBefore)) {
      throw ApiError.unauthenticated(ERROR_CODES.TOKEN_REVOKED, 'Session has been signed out');
    }
    return { id: payload.sub, sessionId: payload.sid };
  }

  /** Every access token issued at or before now stops working at once (deletion, sign out everywhere). */
  async revokeAllAccess(userId: string, now = new Date()): Promise<void> {
    // Access tokens live 15 minutes, so the marker only needs to outlive them.
    await this.kv.set(revokedKey(userId), String(now.getTime()), ACCESS_TOKEN_TTL_SECONDS + 60);
  }

  /** Access tokens of one session family stop working at once (logout, refresh-token reuse). */
  async revokeFamilyAccess(family: string): Promise<void> {
    await this.kv.set(revokedFamilyKey(family), '1', ACCESS_TOKEN_TTL_SECONDS + 60);
  }

  newRefreshSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  hashRefreshSecret(secret: string): string {
    return createHmac('sha256', this.config.JWT_REFRESH_SECRET).update(secret).digest('hex');
  }

  matchesHash(secret: string, hash: string): boolean {
    const a = Buffer.from(this.hashRefreshSecret(secret), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  static splitRefreshToken(token: string): { sessionId: string; secret: string } | null {
    const [sessionId, secret, ...rest] = token.split('.');
    if (!sessionId || !secret || rest.length || !/^[a-f0-9]{24}$/.test(sessionId)) return null;
    return { sessionId, secret };
  }
}
