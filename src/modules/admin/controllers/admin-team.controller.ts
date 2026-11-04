import { createHash, randomBytes } from 'node:crypto';
import { Controller, HttpCode, Inject, Patch, Post, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Model } from 'mongoose';
import { z } from 'zod';
import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/env';
import { AdminAcceptInviteResultSchema, AdminAcceptInviteSchema, AdminAdminUserSchema, AdminInviteSchema, AdminPatchAdminUserSchema, ERROR_CODES, ObjectIdSchema } from '../../../shared';
import { Public } from '../../../common/auth/auth.decorators';
import { ApiError } from '../../../common/errors/api-error';
import { RateLimiter } from '../../../common/rate-limit/rate-limiter.service';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../../common/zod/decorators';
import { KvStore } from '../../../infra/kv/kv-store';
import { EmailSender } from '../../auth/providers';
import { encryptSecret, hashPassword, newTotpSecret, otpauthUrl } from '../security/admin-crypto';
import { Admin } from './admin-auth.controller';
import { AdminSessions } from '../services/admin-sessions.service';
import { AuditService } from '../services/audit.service';
import { CurrentAdmin } from '../security/admin.decorators';
import { type AdminSessionData } from '../security/admin-session.types';
import type { AdminUserDoc } from '../schemas/admin.schema';

const INVITE_TTL_SEC = 72 * 3600;
const inviteKey = (token: string) => `admin:invite:${createHash('sha256').update(token).digest('hex')}`;
const view = (a: AdminUserDoc) => ({ id: a._id.toString(), email: a.email, role: a.role, status: a.status, totpEnabled: Boolean(a.totpSecretEnc), lastLoginAt: a.lastLoginAt ? new Date(a.lastLoginAt).toISOString() : null, createdAt: new Date(a.createdAt).toISOString() });

/** M7-T6 admin users (owner only): invite by email link, change role or status. */
@ApiTags('admin')
@Controller('admin')
export class AdminTeamController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel('AdminUser') private readonly admins: Model<AdminUserDoc>,
    private readonly kv: KvStore,
    private readonly email: EmailSender,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly sessions: AdminSessions,
  ) {}

  @Admin('adminUsers.manage')
  @Post('admin-users')
  @ZResponse(201, AdminAdminUserSchema, 'Invited; the invite link (72 h) is emailed')
  @ApiErrors(400, 401, 403, 409)
  async invite(@ZBody(AdminInviteSchema) body: z.infer<typeof AdminInviteSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const email = body.email.toLowerCase();
    if (await this.admins.exists({ email })) throw ApiError.conflict(ERROR_CODES.CONFLICT, 'An admin with this email exists');
    const doc = (await this.admins.create({ email, role: body.role, status: 'invited' })).toObject() as AdminUserDoc;
    const token = randomBytes(32).toString('base64url');
    await this.kv.set(inviteKey(token), doc._id.toString(), INVITE_TTL_SEC);
    await this.email.sendLink(email, 'admin_invite', `${this.config.ADMIN_APP_URL}/accept-invite?token=${token}`);
    await this.audit.log(admin, req, { action: 'admin_user.invite', targetType: 'admin_user', targetId: doc._id.toString(), reason: body.reason, diff: { email, role: body.role } });
    return view(doc);
  }

  @Admin('adminUsers.manage')
  @Patch('admin-users/:id')
  @ZResponse(200, AdminAdminUserSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  async patch(@ZParam('id', ObjectIdSchema) id: string, @ZBody(AdminPatchAdminUserSchema) body: z.infer<typeof AdminPatchAdminUserSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const target = await this.admins.findById(id).lean<AdminUserDoc>();
    if (!target) throw ApiError.notFound();
    const demotesOwner = target.role === 'owner' && ((body.role && body.role !== 'owner') || body.status === 'deactivated');
    if (demotesOwner && (await this.admins.countDocuments({ role: 'owner', status: 'active' })) <= 1) {
      throw ApiError.conflict(ERROR_CODES.CONFLICT, 'At least one active owner must remain');
    }
    if (id === admin.adminId && body.status === 'deactivated') throw ApiError.conflict(ERROR_CODES.CONFLICT, 'You cannot deactivate yourself');
    const doc = await this.admins.findByIdAndUpdate(id, { $set: { ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}) } }, { returnDocument: 'after' }).lean<AdminUserDoc>();
    await this.audit.log(admin, req, { action: 'admin_user.update', targetType: 'admin_user', targetId: id, reason: body.reason, diff: { role: [target.role, doc!.role], status: [target.status, doc!.status] } });
    // B20: open sessions pick up the new role on their next request; deactivation ends them everywhere.
    if (doc!.status === 'deactivated' && target.status !== 'deactivated') {
      await this.sessions.revokeAll(id);
      await this.audit.log(admin, req, { action: 'admin_user.sessions_revoked', targetType: 'admin_user', targetId: id, reason: body.reason });
    } else {
      await this.sessions.invalidate(id);
    }
    return view(doc!);
  }

  /** Public: the invitee sets a password and receives the TOTP secret once. */
  @Public()
  @Post('auth/accept-invite')
  @HttpCode(200)
  @ZResponse(200, AdminAcceptInviteResultSchema, 'Add the TOTP secret to an authenticator, then sign in')
  @ApiErrors(400, 401, 429)
  async accept(@ZBody(AdminAcceptInviteSchema) body: z.infer<typeof AdminAcceptInviteSchema>, @Req() req: Request) {
    await this.limiter.consume({ key: `admin:invite:ip:${req.ip}`, limit: 10, windowSec: 900 });
    const id = await this.kv.get(inviteKey(body.token));
    const admin = id ? await this.admins.findOne({ _id: id, status: 'invited' }).lean<AdminUserDoc>() : null;
    if (!admin) throw ApiError.unauthenticated(ERROR_CODES.UNAUTHENTICATED, 'This invite is invalid or has expired');
    const secret = newTotpSecret();
    await this.admins.updateOne({ _id: admin._id }, { $set: { status: 'active', passwordHash: hashPassword(body.password), totpSecretEnc: encryptSecret(secret, this.config.OTP_PEPPER) } });
    await this.kv.del(inviteKey(body.token));
    await this.audit.log(null, req, { action: 'admin_user.accept_invite', targetType: 'admin_user', targetId: admin._id.toString() });
    return { email: admin.email, totpSecret: secret, otpauthUrl: otpauthUrl(admin.email, secret) };
  }
}
