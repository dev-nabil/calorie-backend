import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import {
  ERROR_CODES,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type AuthProvider,
  type AuthSession,
  type DeviceInfo,
} from '../../shared';
import { ApiError } from '../../common/errors/api-error';
import { clock } from '../../common/clock';
import { TokenService } from '../../common/auth/token.service';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.service';
import { KvStore } from '../../infra/kv/kv-store';
import { UsersService } from '../users/users.service';
import type { DeviceDoc, UserDoc } from '../users/schemas/users.schema';
import type { OtpCodeDoc, SessionDoc } from './schemas/auth.schema';
import { AppleTokenVerifier, EmailSender, GoogleTokenVerifier, isDisposableEmail, type ProviderIdentity } from './providers';

const RESEND_COOLDOWN_SEC = 60;

export interface RequestMeta {
  ip: string;
  deviceId?: string;
}

/** M1-T2..T4: email code, Google and Apple sign-in, rotating refresh tokens with reuse detection. */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel('OtpCode') private readonly otps: Model<OtpCodeDoc>,
    @InjectModel('Session') private readonly sessions: Model<SessionDoc>,
    @InjectModel('Device') private readonly devices: Model<DeviceDoc>,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly limiter: RateLimiter,
    private readonly kv: KvStore,
    private readonly email: EmailSender,
    private readonly google: GoogleTokenVerifier,
    private readonly apple: AppleTokenVerifier,
  ) {
    if (config.DEV_FIXED_OTP) this.logger.warn(`DEV_FIXED_OTP is set: every email sign-in code is ${config.DEV_FIXED_OTP}. Development only.`);
  }

  private otpHash(email: string, code: string): string {
    return createHmac('sha256', this.config.OTP_PEPPER).update(`${email}:${code}`).digest('hex');
  }

  async startEmail(email: string, meta: RequestMeta): Promise<{ expiresInSec: number; resendAfterSec: number }> {
    if (isDisposableEmail(email)) {
      throw new ApiError(ERROR_CODES.DISPOSABLE_EMAIL, 'Please use a permanent email address', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    await this.limiter.consume(
      { key: `otp:start:email:${email}`, limit: 5, windowSec: 3600 },
      { key: `otp:start:ip:${meta.ip}`, limit: 20, windowSec: 3600 },
      ...(meta.deviceId ? [{ key: `otp:start:device:${meta.deviceId}`, limit: 10, windowSec: 3600 }] : []),
    );
    const cooldown = Math.max(1, Math.ceil(RESEND_COOLDOWN_SEC / this.limiter.multiplier));
    if (!(await this.kv.setIfAbsent(`otp:cooldown:${email}`, '1', cooldown))) {
      throw ApiError.rateLimited(cooldown);
    }
    const code = this.config.DEV_FIXED_OTP ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.otps.updateOne(
      { email },
      { $set: { codeHash: this.otpHash(email, code), attempts: 0, expiresAt: new Date(clock.now().getTime() + OTP_TTL_SECONDS * 1000) } },
      { upsert: true },
    );
    await this.email.sendOtp(email, code);
    return { expiresInSec: OTP_TTL_SECONDS, resendAfterSec: RESEND_COOLDOWN_SEC };
  }

  async verifyEmail(email: string, code: string, device: DeviceInfo | undefined, meta: RequestMeta): Promise<AuthSession> {
    await this.limiter.consume({ key: `otp:verify:ip:${meta.ip}`, limit: 30, windowSec: 600 });
    const otp = await this.otps.findOne({ email }).lean<OtpCodeDoc>();
    if (!otp || otp.expiresAt.getTime() <= clock.now().getTime()) {
      throw new ApiError(ERROR_CODES.OTP_EXPIRED, 'This code has expired. Ask for a new one.', HttpStatus.UNAUTHORIZED);
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      throw new ApiError(ERROR_CODES.OTP_TOO_MANY_ATTEMPTS, 'Too many attempts. Ask for a new code.', HttpStatus.UNAUTHORIZED);
    }
    const a = Buffer.from(this.otpHash(email, code), 'hex');
    const b = Buffer.from(otp.codeHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      const updated = await this.otps.findOneAndUpdate({ _id: otp._id }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).lean<OtpCodeDoc>();
      const left = Math.max(0, OTP_MAX_ATTEMPTS - (updated?.attempts ?? OTP_MAX_ATTEMPTS));
      throw new ApiError(ERROR_CODES.OTP_INVALID, 'That code is not right.', HttpStatus.UNAUTHORIZED, { attemptsLeft: left });
    }
    // Single use: only the request that deletes the code may sign in.
    const consumed = await this.otps.deleteOne({ _id: otp._id, codeHash: otp.codeHash });
    if (consumed.deletedCount !== 1) {
      throw new ApiError(ERROR_CODES.OTP_EXPIRED, 'This code has already been used.', HttpStatus.UNAUTHORIZED);
    }
    let user = await this.users.users.findOne({ email }).lean<UserDoc>();
    let isNewUser = false;
    if (!user) {
      user = await this.users.create({ email, emailVerified: true, provider: { provider: 'email', subject: email, emailVerified: true } });
      isNewUser = true;
    } else {
      this.assertCanSignIn(user);
      const set: Record<string, unknown> = {};
      if (!user.emailVerifiedAt) set.emailVerifiedAt = new Date();
      const update: Record<string, unknown> = { $set: set };
      if (!user.authProviders.some((p) => p.provider === 'email')) {
        update.$push = { authProviders: { provider: 'email', subject: email, emailVerified: true, linkedAt: new Date() } };
      }
      user = (await this.users.users.findByIdAndUpdate(user._id, update, { returnDocument: 'after' }).lean<UserDoc>())!;
    }
    return this.issue(user, 'email', device, isNewUser);
  }

  async signInWithGoogle(idToken: string, device?: DeviceInfo): Promise<AuthSession> {
    const identity = await this.verifyProvider(() => this.google.verify(idToken));
    return this.socialSignIn('google', identity, device);
  }

  async signInWithApple(identityToken: string, nonce: string | undefined, displayName: string | undefined, device?: DeviceInfo): Promise<AuthSession> {
    const identity = await this.verifyProvider(() => this.apple.verify(identityToken, nonce));
    return this.socialSignIn('apple', { ...identity, name: displayName ?? identity.name }, device);
  }

  private async verifyProvider(fn: () => Promise<ProviderIdentity>): Promise<ProviderIdentity> {
    try {
      return await fn();
    } catch (e) {
      this.logger.warn({ reason: (e as Error).message }, 'provider token rejected');
      throw ApiError.unauthenticated(ERROR_CODES.PROVIDER_TOKEN_INVALID, 'Sign-in token could not be verified');
    }
  }

  /**
   * S-07: link by provider subject first. Auto-link to an existing account by email only when the
   * provider asserts the email is verified; otherwise the user must verify with an email code.
   */
  private async socialSignIn(provider: 'google' | 'apple', id: ProviderIdentity, device?: DeviceInfo): Promise<AuthSession> {
    const bySubject = await this.users.users
      .findOne({ authProviders: { $elemMatch: { provider, subject: id.subject } } })
      .lean<UserDoc>();
    if (bySubject) {
      this.assertCanSignIn(bySubject);
      return this.issue(bySubject, provider, device, false);
    }
    if (!id.email) {
      throw ApiError.unauthenticated(ERROR_CODES.PROVIDER_TOKEN_INVALID, 'The provider did not share an email address');
    }
    const byEmail = await this.users.users.findOne({ email: id.email }).lean<UserDoc>();
    if (byEmail) {
      this.assertCanSignIn(byEmail);
      if (!id.emailVerified) {
        throw ApiError.conflict(ERROR_CODES.ACCOUNT_LINK_REQUIRED, 'Verify this email with a code to link the account', {
          email: id.email,
          provider,
        });
      }
      const linked = await this.users.users
        .findByIdAndUpdate(
          byEmail._id,
          {
            $push: { authProviders: { provider, subject: id.subject, emailVerified: true, linkedAt: new Date() } },
            $set: { emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date() },
          },
          { returnDocument: 'after' },
        )
        .lean<UserDoc>();
      return this.issue(linked!, provider, device, false);
    }
    const created = await this.users.create({
      email: id.email,
      emailVerified: id.emailVerified,
      provider: { provider, subject: id.subject, emailVerified: id.emailVerified },
      displayName: id.name?.slice(0, 50) ?? null,
    });
    return this.issue(created, provider, device, true);
  }

  private assertCanSignIn(user: UserDoc): void {
    if (user.status === 'disabled') throw ApiError.forbidden(ERROR_CODES.ACCOUNT_DISABLED, 'This account is disabled');
    if (user.status !== 'active') throw ApiError.forbidden(ERROR_CODES.ACCOUNT_DELETED, 'This account is being deleted');
  }

  private async issue(user: UserDoc, provider: AuthProvider, device: DeviceInfo | undefined, isNewUser: boolean, family: string = randomUUID()): Promise<AuthSession> {
    if (device) await this.registerDevice(user._id, device);
    const { token: refreshToken, expiresAt: refreshExpiresAt } = await this.createSession(user._id, family, device?.deviceId ?? null);
    const access = await this.tokens.signAccess({ id: user._id.toString(), sessionId: family });
    return {
      tokenType: 'Bearer',
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      isNewUser,
      provider,
      user: this.users.toMe(user),
    };
  }

  private async createSession(userId: Types.ObjectId, family: string, deviceId: string | null): Promise<{ token: string; expiresAt: Date }> {
    const secret = this.tokens.newRefreshSecret();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    const session = await this.sessions.create({ userId, family, deviceId, refreshTokenHash: this.tokens.hashRefreshSecret(secret), expiresAt });
    return { token: `${session._id.toString()}.${secret}`, expiresAt };
  }

  private async registerDevice(userId: Types.ObjectId, device: DeviceInfo): Promise<void> {
    await this.devices.updateOne(
      { userId, deviceId: device.deviceId },
      { $set: { platform: device.platform, appVersion: device.appVersion ?? null, lastSeenAt: new Date() } },
      { upsert: true },
    );
  }

  /** M1-T4: rotate; presenting an already-rotated token revokes the whole family (reuse detection). */
  async refresh(refreshToken: string): Promise<AuthSession> {
    const parts = TokenService.splitRefreshToken(refreshToken);
    if (!parts) throw ApiError.unauthenticated();
    const session = await this.sessions.findById(parts.sessionId).lean<SessionDoc>();
    if (!session || !this.tokens.matchesHash(parts.secret, session.refreshTokenHash)) throw ApiError.unauthenticated();
    if (session.revokedAt) throw ApiError.unauthenticated(ERROR_CODES.TOKEN_REVOKED, 'Session has been signed out');
    if (session.rotatedAt) {
      await this.revokeFamily(session.userId, session.family);
      this.logger.warn({ userId: session.userId.toString() }, 'refresh token reuse detected; family revoked');
      throw ApiError.unauthenticated(ERROR_CODES.REFRESH_TOKEN_REUSED, 'Session ended for your security. Please sign in again.');
    }
    if (session.expiresAt.getTime() <= Date.now()) throw ApiError.unauthenticated(ERROR_CODES.TOKEN_EXPIRED, 'Session expired');
    const claimed = await this.sessions.updateOne({ _id: session._id, rotatedAt: null, revokedAt: null }, { $set: { rotatedAt: new Date() } });
    if (claimed.modifiedCount !== 1) {
      await this.revokeFamily(session.userId, session.family);
      throw ApiError.unauthenticated(ERROR_CODES.REFRESH_TOKEN_REUSED, 'Session ended for your security. Please sign in again.');
    }
    const user = await this.users.findById(session.userId.toString());
    if (!user) throw ApiError.unauthenticated();
    this.assertCanSignIn(user);
    const provider = user.authProviders[0]?.provider ?? 'email';
    return this.issue(user, provider, undefined, false, session.family);
  }

  private async revokeFamily(userId: Types.ObjectId, family: string): Promise<void> {
    await this.sessions.updateMany({ userId, family, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await this.tokens.revokeFamilyAccess(family);
  }

  async logout(userId: string, family: string, allDevices: boolean, refreshToken?: string): Promise<void> {
    const uid = new Types.ObjectId(userId);
    const parts = refreshToken ? TokenService.splitRefreshToken(refreshToken) : null;
    if (parts) {
      const other = await this.sessions.findById(parts.sessionId).lean<SessionDoc>();
      if (other && other.userId.equals(uid) && other.family !== family) await this.revokeFamily(uid, other.family);
    }
    if (allDevices) {
      await this.sessions.updateMany({ userId: uid, revokedAt: null }, { $set: { revokedAt: new Date() } });
      await this.tokens.revokeAllAccess(userId);
      return;
    }
    await this.revokeFamily(uid, family);
  }
}
