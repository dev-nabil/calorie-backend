import { randomBytes } from 'node:crypto';
import { Controller, Get, HttpCode, Logger, Post, Req, Res, applyDecorators } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Model } from 'mongoose';
import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/env';
import { Inject } from '@nestjs/common';
import { AdminLoginRequestSchema, AdminLoginResponseSchema, AdminSessionSchema, AdminTotpRequestSchema, ERROR_CODES } from '../../../shared';
import { Public } from '../../../common/auth/auth.decorators';
import { ApiError } from '../../../common/errors/api-error';
import { RateLimiter } from '../../../common/rate-limit/rate-limiter.service';
import { ApiErrors, ZBody, ZResponse } from '../../../common/zod/decorators';
import { KvStore } from '../../../infra/kv/kv-store';
import { decryptSecret, hashPassword, needsRehash, totpStep, verifyPassword } from '../security/admin-crypto';
import { clock } from '../../../common/clock';
import { readCookie } from '../security/admin-cookies';
import { ADMIN_IDLE_SEC, ADMIN_SESSION_COOKIE } from '../security/admin-session.constants';
import { AdminRoute, CurrentAdmin } from '../security/admin.decorators';
import { AdminSessions } from '../services/admin-sessions.service';
import { AuditService } from '../services/audit.service';
import { type AdminSessionData } from '../security/admin-session.types';
import type { AdminUserDoc } from '../schemas/admin.schema';

const DUMMY_HASH = hashPassword('timing-equaliser');
const CHALLENGE_TTL = 300;

/** Admin decorator: skip the app-user bearer guard, require an admin session with `permission`. */
export const Admin = (permission: Parameters<typeof AdminRoute>[0]) => applyDecorators(Public(), AdminRoute(permission));

export function sessionView(s: AdminSessionData) {
  return { adminId: s.adminId, email: s.email, role: s.role, expiresAt: AdminSessions.expiresAt(s), idleTimeoutSec: ADMIN_IDLE_SEC };
}

/** Admin sign-in (M1-T7): password, then TOTP (mandatory unless ADMIN_TOTP_REQUIRED=false in development), then an httpOnly session cookie. */
@ApiTags('admin')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel('AdminUser') private readonly admins: Model<AdminUserDoc>,
    private readonly sessions: AdminSessions,
    private readonly kv: KvStore,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
  ) {
    if (!config.adminTotpRequired) new Logger('AdminAuth').warn('ADMIN_TOTP_REQUIRED=false: admin sign-in skips the two-factor step (development only)');
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ZResponse(200, AdminLoginResponseSchema, 'Password accepted. TOTP on: challenge to answer at auth/totp. TOTP off (dev only): sets the session cookies and returns the session')
  @ApiErrors(400, 401, 429)
  async login(@ZBody(AdminLoginRequestSchema) body: { email: string; password: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const email = body.email.toLowerCase();
    await this.limiter.consume({ key: `admin:login:ip:${req.ip}`, limit: 20, windowSec: 900 }, { key: `admin:login:email:${email}`, limit: 10, windowSec: 900 });
    const admin = await this.admins.findOne({ email, status: 'active' }).lean<AdminUserDoc>();
    const ok = verifyPassword(body.password, admin?.passwordHash ?? DUMMY_HASH) && Boolean(admin?.passwordHash);
    if (!admin || !ok || (this.config.adminTotpRequired && !admin.totpSecretEnc)) throw ApiError.unauthenticated(ERROR_CODES.UNAUTHENTICATED, 'Email or password is incorrect');
    if (needsRehash(admin.passwordHash!)) await this.admins.updateOne({ _id: admin._id }, { $set: { passwordHash: hashPassword(body.password) } });
    if (!this.config.adminTotpRequired) return { totpRequired: false as const, session: sessionView(await this.signIn(admin, req, res)) };
    const challengeId = randomBytes(24).toString('base64url');
    await this.kv.set(`admin:chal:${challengeId}`, admin._id.toString(), CHALLENGE_TTL);
    return { challengeId, totpRequired: true as const };
  }

  @Public()
  @Post('totp')
  @HttpCode(200)
  @ZResponse(200, AdminSessionSchema, 'Sets __Host-nouri_admin (httpOnly) and nouri_admin_csrf cookies')
  @ApiErrors(400, 401, 429)
  async totp(@ZBody(AdminTotpRequestSchema) body: { challengeId: string; code: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.limiter.consume({ key: `admin:totp:${body.challengeId}`, limit: 5, windowSec: CHALLENGE_TTL });
    const adminId = await this.kv.get(`admin:chal:${body.challengeId}`);
    const admin = adminId ? await this.admins.findOne({ _id: adminId, status: 'active' }).lean<AdminUserDoc>() : null;
    const step = admin?.totpSecretEnc ? totpStep(decryptSecret(admin.totpSecretEnc, this.config.OTP_PEPPER), body.code, clock.now().getTime()) : null;
    // A code is accepted once: the step must be newer than the last accepted one (QA B11).
    const fresh =
      step !== null &&
      (await this.admins.updateOne({ _id: admin!._id, $or: [{ lastTotpStep: null }, { lastTotpStep: { $lt: step } }] }, { $set: { lastTotpStep: step } })).modifiedCount === 1;
    if (!admin || !fresh) {
      throw ApiError.unauthenticated(ERROR_CODES.OTP_INVALID, 'The code is not right, was already used, or the sign-in expired');
    }
    await this.kv.del(`admin:chal:${body.challengeId}`);
    return sessionView(await this.signIn(admin, req, res));
  }

  /** Last step of every sign-in: stamp lastLoginAt, open the session (cookies) and audit it. */
  private async signIn(admin: AdminUserDoc, req: Request, res: Response): Promise<AdminSessionData> {
    await this.admins.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });
    const s = await this.sessions.create({ id: admin._id.toString(), email: admin.email, role: admin.role }, res);
    await this.audit.log(s, req, { action: 'admin.login', targetType: 'admin_user', targetId: s.adminId });
    return s;
  }

  @Admin(null)
  @Get('session')
  @ZResponse(200, AdminSessionSchema)
  @ApiErrors(401)
  session(@CurrentAdmin() s: AdminSessionData) {
    return sessionView(s);
  }

  @Admin(null)
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const sid = readCookie(req, ADMIN_SESSION_COOKIE);
    if (sid) await this.sessions.destroy(sid, res);
  }
}
