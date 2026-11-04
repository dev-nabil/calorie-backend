import { Controller, Delete, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import {
  AdminFreeScansRequestSchema,
  AdminGrantEntitlementRequestSchema,
  AdminPatchUserRequestSchema,
  AdminReasonRequestSchema,
  AdminUserDetailSchema,
  AdminUserListQuerySchema,
  AdminUserListSchema,
  ERROR_CODES,
  ObjectIdSchema,
  AdminDeleteUserResultSchema,
  AdminEntitlementResultSchema,
  AdminFreeScansResultSchema,
  AdminUserMealListSchema,
  AdminUserScanListSchema,
  AdminUserConversationListSchema,
} from '../../../shared';
import { addDays, dayKeyFor } from '../../../domain/day-keys';
import { computeStreak } from '../../../domain/streaks';
import { TokenService } from '../../../common/auth/token.service';
import { ApiError } from '../../../common/errors/api-error';
import { ApiErrors, ZBody, ZParam, ZQuery, ZResponse } from '../../../common/zod/decorators';
import { KvStore } from '../../../infra/kv/kv-store';
import { entitlementCacheKey } from '../../billing/entitlement-cache';
import type { ConversationDoc, MessageDoc } from '../../conversations/schemas/conversations.schema';
import type { ProfileDoc } from '../../onboarding/schemas/onboarding.schema';
import type { PlanDoc } from '../../plans/schemas/plans.schema';
import type { ScanDoc } from '../../scans/schemas/scans.schema';
import type { DailyLogDoc, MealDoc } from '../../tracking/schemas/tracking.schema';
import type { DeviceDoc, UserDoc } from '../../users/schemas/users.schema';
import { UsersService } from '../../users/users.service';
import { Admin } from './admin-auth.controller';
import { AuditService } from '../services/audit.service';
import { CurrentAdmin } from '../security/admin.decorators';
import { type AdminSessionData } from '../security/admin-session.types';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** M7-T3: users list, detail and audited actions. */
@ApiTags('admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    @InjectModel('User') private readonly users: Model<UserDoc>,
    @InjectModel('Device') private readonly devices: Model<DeviceDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('Plan') private readonly plans: Model<PlanDoc>,
    @InjectModel('Scan') private readonly scans: Model<ScanDoc>,
    @InjectModel('Meal') private readonly meals: Model<MealDoc>,
    @InjectModel('DailyLog') private readonly logs: Model<DailyLogDoc>,
    @InjectModel('Conversation') private readonly conversations: Model<ConversationDoc>,
    @InjectModel('Message') private readonly messages: Model<MessageDoc>,
    private readonly usersService: UsersService,
    private readonly tokens: TokenService,
    private readonly kv: KvStore,
    private readonly audit: AuditService,
  ) {}

  private async summary(u: UserDoc) {
    const device = await this.devices.findOne({ userId: u._id }).sort({ lastSeenAt: -1 }).lean<DeviceDoc>();
    const e = u.entitlement;
    return {
      id: u._id.toString(),
      email: u.email,
      displayName: u.displayName ?? null,
      status: u.status,
      entitlement: { plan: e.plan, ...(e.period ? { period: e.period } : {}), ...(e.activeUntil ? { activeUntil: new Date(e.activeUntil).toISOString() } : {}), ...(e.source ? { source: e.source } : {}) },
      freeScans: { allowance: u.freeScans.allowance, used: u.freeScans.used },
      platform: device?.platform === 'android' ? ('android' as const) : ('ios' as const),
      createdAt: new Date(u.createdAt).toISOString(),
      lastActiveAt: u.lastActiveAt ? new Date(u.lastActiveAt).toISOString() : null,
    };
  }

  private async find(id: string): Promise<UserDoc> {
    const u = await this.users.findById(id).lean<UserDoc>();
    if (!u) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'User not found');
    return u;
  }

  @Admin('users.view')
  @Get()
  @ZResponse(200, AdminUserListSchema)
  @ApiErrors(401, 403)
  async list(@ZQuery(AdminUserListQuerySchema) q: z.infer<typeof AdminUserListQuerySchema>) {
    const filter: Record<string, unknown> = {};
    if (q.query) filter.$or = [{ email: { $regex: escape(q.query.toLowerCase()) } }, { displayName: { $regex: escape(q.query), $options: 'i' } }];
    if (q.status) filter.status = q.status;
    if (q.plan === 'plus') Object.assign(filter, { 'entitlement.plan': 'plus', 'entitlement.activeUntil': { $gt: new Date() } });
    if (q.plan === 'free') filter.$nor = [{ 'entitlement.plan': 'plus', 'entitlement.activeUntil': { $gt: new Date() } }];
    const limit = q.limit ?? 50;
    const page = { ...filter, ...(q.cursor && Types.ObjectId.isValid(q.cursor) ? { _id: { $lt: new Types.ObjectId(q.cursor) } } : {}) };
    const [docs, total] = await Promise.all([this.users.find(page).sort({ _id: -1 }).limit(limit + 1).lean<UserDoc[]>(), this.users.countDocuments(filter)]);
    const items = await Promise.all(docs.slice(0, limit).map((u) => this.summary(u)));
    return { items, nextCursor: docs.length > limit ? items.at(-1)!.id : null, total };
  }

  /** Viewing a user's detail shows health data, so it is audited (M7 done-when). */
  @Admin('users.healthData.view')
  @Get(':id')
  @ZResponse(200, AdminUserDetailSchema)
  @ApiErrors(401, 403, 404)
  async detail(@ZParam('id', ObjectIdSchema) id: string, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const u = await this.find(id);
    await this.audit.log(admin, req, { action: 'user.view', targetType: 'user', targetId: id });
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * 86_400_000);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const today = dayKeyFor(now, u.timezone);
    const [profile, plan, devices, scansTotal, scansMonth, coachConvs, meals30, logged, recentMeals, recentScans] = await Promise.all([
      this.profiles.findOne({ userId: u._id }).lean<ProfileDoc>(),
      this.plans.findOne({ userId: u._id, active: true }).lean<PlanDoc>(),
      this.devices.find({ userId: u._id }).sort({ lastSeenAt: -1 }).lean<DeviceDoc[]>(),
      this.scans.countDocuments({ userId: u._id }),
      this.scans.countDocuments({ userId: u._id, queuedAt: { $gte: monthStart } }),
      this.conversations.find({ userId: u._id, type: 'coach' }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>(),
      this.meals.countDocuments({ userId: u._id, deletedAt: null, loggedAt: { $gte: since30 } }),
      this.logs.find({ userId: u._id, logged: true, date: { $gte: addDays(today, -400) } }, { date: 1 }).lean<{ date: string }[]>(),
      this.meals.find({ userId: u._id, deletedAt: null }).sort({ loggedAt: -1 }).limit(5).lean<MealDoc[]>(),
      this.scans.find({ userId: u._id }).sort({ queuedAt: -1 }).limit(5).lean<ScanDoc[]>(),
    ]);
    const coachTurns30d = coachConvs.length
      ? await this.messages.countDocuments({ userId: u._id, conversationId: { $in: coachConvs.map((c) => c._id) }, role: 'user', createdAt: { $gte: since30 } })
      : 0;
    const activity = [
      ...recentMeals.map((m) => ({ at: new Date(m.loggedAt).toISOString(), kind: 'meal_logged', summary: `${m.category}: ${m.name} (${Math.round(m.totals.kcal)} kcal)` })),
      ...recentScans.map((s) => ({ at: new Date(s.queuedAt).toISOString(), kind: 'scan', summary: `Scan ${s.status}` })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return {
      ...(await this.summary(u)),
      timezone: u.timezone,
      units: u.units.weight === 'lb' ? ('imperial' as const) : ('metric' as const),
      emailVerified: Boolean(u.emailVerifiedAt) || u.authProviders.some((p) => p.emailVerified),
      authProviders: [...new Set(u.authProviders.map((p) => p.provider))],
      onboarding: {
        route: profile?.onboarding.route ?? null,
        completedAt: profile?.onboarding.completedAt ? new Date(profile.onboarding.completedAt).toISOString() : null,
        deferredCount: profile?.onboarding.deferredCount ?? 0,
      },
      plan: plan ? { mode: plan.energyKcal === null ? ('habits_only' as const) : ('targets' as const), energyKcal: plan.energyKcal } : null,
      usage: { scansTotal, scansThisMonth: scansMonth, coachTurns30d, mealsLogged30d: meals30, streakDays: computeStreak(logged.map((l) => l.date), today).current },
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        platform: d.platform === 'android' ? ('android' as const) : ('ios' as const),
        appVersion: d.appVersion ?? '',
        lastSeenAt: new Date(d.lastSeenAt).toISOString(),
        integrityVerifiedAt: d.integrity?.verifiedAt ? new Date(d.integrity.verifiedAt).toISOString() : null,
        pushEnabled: Boolean(d.pushToken),
      })),
      recentActivity: activity.slice(0, 10),
      deletionRequestedAt: u.deletionRequestedAt ? new Date(u.deletionRequestedAt).toISOString() : null,
    };
  }

  @Admin('users.disable')
  @Patch(':id')
  @ZResponse(200, AdminUserDetailSchema.pick({ id: true, status: true }))
  @ApiErrors(400, 401, 403, 404)
  async patch(@ZParam('id', ObjectIdSchema) id: string, @ZBody(AdminPatchUserRequestSchema) body: z.infer<typeof AdminPatchUserRequestSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const u = await this.find(id);
    if (u.status === 'pending_deletion' || u.status === 'deleted') throw ApiError.conflict(ERROR_CODES.CONFLICT, 'Account is being deleted');
    await this.users.updateOne({ _id: u._id }, { $set: { status: body.status } });
    if (body.status === 'disabled') await this.tokens.revokeAllAccess(id);
    await this.audit.log(admin, req, { action: body.status === 'disabled' ? 'user.disable' : 'user.enable', targetType: 'user', targetId: id, reason: body.reason, diff: { status: [u.status, body.status] } });
    return { id, status: body.status };
  }

  @Admin('users.grantPromo')
  @Post(':id/entitlement')
  @HttpCode(200)
  @ZResponse(200, AdminEntitlementResultSchema)
  @ApiErrors(400, 401, 403, 404)
  async grant(@ZParam('id', ObjectIdSchema) id: string, @ZBody(AdminGrantEntitlementRequestSchema) body: z.infer<typeof AdminGrantEntitlementRequestSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const u = await this.find(id);
    const activeUntil = new Date(Date.now() + body.days * 86_400_000);
    await this.users.updateOne({ _id: u._id }, { $set: { entitlement: { plan: 'plus', period: null, activeUntil, source: 'promo' } } });
    await this.kv.del(entitlementCacheKey(id));
    await this.audit.log(admin, req, { action: 'user.grant_promo', targetType: 'user', targetId: id, reason: body.reason, diff: { days: body.days } });
    return { id, entitlement: { plan: 'plus', activeUntil: activeUntil.toISOString(), source: 'promo' } };
  }

  @Admin('users.addFreeScans')
  @Post(':id/free-scans')
  @HttpCode(200)
  @ZResponse(200, AdminFreeScansResultSchema)
  @ApiErrors(400, 401, 403, 404)
  async freeScans(@ZParam('id', ObjectIdSchema) id: string, @ZBody(AdminFreeScansRequestSchema) body: z.infer<typeof AdminFreeScansRequestSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    await this.find(id);
    const u = await this.users.findByIdAndUpdate(id, { $inc: { 'freeScans.allowance': body.count } }, { returnDocument: 'after' }).lean<UserDoc>();
    await this.kv.del(entitlementCacheKey(id));
    await this.audit.log(admin, req, { action: 'user.add_free_scans', targetType: 'user', targetId: id, reason: body.reason, diff: { count: body.count } });
    return { id, freeScans: { allowance: u!.freeScans.allowance, used: u!.freeScans.used } };
  }

  @Admin('users.delete')
  @Delete(':id')
  @HttpCode(202)
  @ZResponse(202, AdminDeleteUserResultSchema)
  @ApiErrors(400, 401, 403, 404)
  async remove(@ZParam('id', ObjectIdSchema) id: string, @ZBody(AdminReasonRequestSchema) body: { reason: string }, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const u = await this.find(id);
    if (u.status !== 'active' && u.status !== 'disabled') throw ApiError.conflict(ERROR_CODES.CONFLICT, 'Deletion already started');
    if (u.status === 'disabled') await this.users.updateOne({ _id: u._id }, { $set: { status: 'active' } });
    const { purgeAfter } = await this.usersService.requestDeletion(id);
    await this.audit.log(admin, req, { action: 'user.delete', targetType: 'user', targetId: id, reason: body.reason });
    return { status: 'pending_deletion', purgeAfter: purgeAfter.toISOString() };
  }

  @Admin('users.healthData.view')
  @Get(':id/meals')
  @ZResponse(200, AdminUserMealListSchema)
  async userMeals(@ZParam('id', ObjectIdSchema) id: string, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    await this.find(id);
    await this.audit.log(admin, req, { action: 'user.view_meals', targetType: 'user', targetId: id });
    const docs = await this.meals.find({ userId: new Types.ObjectId(id) }).sort({ loggedAt: -1 }).limit(100).lean<MealDoc[]>();
    return {
      items: docs.map((m) => ({ id: m._id.toString(), loggedAt: new Date(m.loggedAt).toISOString(), dayKey: m.date, category: m.category, name: m.name, kcal: Math.round(m.totals.kcal), source: m.source === 'photo' ? 'scan' : m.source === 'voice' ? 'text' : m.source })),
      nextCursor: null,
    };
  }

  @Admin('users.healthData.view')
  @Get(':id/conversations')
  @ZResponse(200, AdminUserConversationListSchema)
  async userConversations(@ZParam('id', ObjectIdSchema) id: string, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    await this.find(id);
    await this.audit.log(admin, req, { action: 'user.view_conversations', targetType: 'user', targetId: id });
    const docs = await this.conversations.find({ userId: new Types.ObjectId(id) }).sort({ createdAt: -1 }).limit(100).lean<ConversationDoc[]>();
    return { items: docs.map((c) => ({ id: c._id.toString(), kind: c.type, startedAt: new Date(c.createdAt).toISOString(), turns: Math.floor(c.messageCount / 2) })), nextCursor: null };
  }

  @Admin('users.healthData.view')
  @Get(':id/scans')
  @ZResponse(200, AdminUserScanListSchema)
  async userScans(@ZParam('id', ObjectIdSchema) id: string, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    await this.find(id);
    await this.audit.log(admin, req, { action: 'user.view_scans', targetType: 'user', targetId: id });
    const docs = await this.scans.find({ userId: new Types.ObjectId(id) }).sort({ queuedAt: -1 }).limit(100).lean<ScanDoc[]>();
    return {
      items: docs.map((s) => ({
        id: s._id,
        status: s.status,
        queuedAt: new Date(s.queuedAt).toISOString(),
        finishedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : null,
        kcal: s.result?.totals.kcal ?? null,
        confidence: s.result?.items.length ? Math.round((s.result.items.reduce((a, i) => a + i.confidence, 0) / s.result.items.length) * 100) / 100 : null,
      })),
      nextCursor: null,
    };
  }
}
