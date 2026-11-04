import { Controller, Get, HttpCode, Post, Put, Req, Res } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Model } from 'mongoose';
import { z } from 'zod';
import {
  AdminAuditLogSchema,
  AdminAuditQuerySchema,
  AdminExperimentSchema,
  AdminFlagSchema,
  AdminKillSwitchRequestSchema,
  AdminKillSwitchSchema,
  AdminMetricsOverviewSchema,
  AdminMinAppVersionSchema,
  AdminPageQuerySchema,
  AdminPutExperimentRequestSchema,
  AdminPutFlagRequestSchema,
  AdminPutMinAppVersionRequestSchema,
  AdminWaitlistEntrySchema,
  ERROR_CODES,
  AdminAdminUserSchema,
} from '../../../shared';
import { addDays } from '../../../domain/day-keys';
import { clock } from '../../../common/clock';
import { ApiError } from '../../../common/errors/api-error';
import { ApiErrors, ZBody, ZQuery, ZResponse } from '../../../common/zod/decorators';
import { CONFIG_DEFAULTS } from '../../app-config/app-config.defaults';
import { AppConfigService } from '../../content/app-config.service';
import type { AiUsageDailyDoc } from '../../ai/schemas/ai.schema';
import type { ProfileDoc } from '../../onboarding/schemas/onboarding.schema';
import type { ScanDoc } from '../../scans/schemas/scans.schema';
import type { UserDoc } from '../../users/schemas/users.schema';
import { Admin } from './admin-auth.controller';
import { AuditService } from '../services/audit.service';
import { CurrentAdmin } from '../security/admin.decorators';
import { type AdminSessionData } from '../security/admin-session.types';
import type { AdminUserDoc, AuditLogDoc } from '../schemas/admin.schema';

const FLAG_DESCRIPTIONS: Record<string, string> = {
  'paywall.onboarding': 'Soft paywall after onboarding (OQ-18)',
  'targets.enabled': 'Energy targets (off until dietitian sign-off, OQ-03)',
  'voice.serverStt': 'Server transcription fallback (DEC-07)',
  'voice.cloudReplies': 'Cloud text-to-speech for Plus coach replies',
  'coach.call': 'Coach call button (feature 1c)',
};

interface StoredExperiment {
  active: boolean;
  description?: string;
  status?: 'draft' | 'running' | 'stopped';
  allocationPct?: number;
  variants: { id: string; weight: number; value?: string | number | boolean }[];
  startedAt?: string | null;
  stoppedAt?: string | null;
  updatedAt?: string;
}

const KILL_LABELS: Record<string, string> = { 'ai.kill.vision': 'Photo scans', 'ai.kill.chat': 'Coach chat', 'ai.kill.extract': 'Onboarding extraction and meal parse', 'ai.kill.tts': 'Cloud speech' };
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** M7: overview, flags, experiments, min app version, kill switches, waitlist, audit log, admin users. */
@ApiTags('admin')
@Controller('admin')
export class AdminMiscController {
  constructor(
    @InjectModel('User') private readonly users: Model<UserDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('Scan') private readonly scans: Model<ScanDoc>,
    @InjectModel('AiUsageDaily') private readonly aiUsage: Model<AiUsageDailyDoc>,
    @InjectModel('Waitlist') private readonly waitlist: Model<{ _id: unknown; email: string; source?: string; utm?: Record<string, string>; confirmedAt?: Date | null; createdAt: Date }>,
    @InjectModel('AuditLog') private readonly logs: Model<AuditLogDoc>,
    @InjectModel('AdminUser') private readonly admins: Model<AdminUserDoc>,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  @Admin('overview.view')
  @Get('metrics/overview')
  @ZResponse(200, AdminMetricsOverviewSchema, 'Aggregates only (no personal data)')
  async overview() {
    const now = clock.now();
    const day = 86_400_000;
    const ago = (n: number) => new Date(now.getTime() - n * day);
    const kpi = (value: number, prev: number | null) => ({ value, deltaPct: prev === null || prev === 0 ? null : Math.round(((value - prev) / prev) * 1000) / 10 });
    const plusFilter = { 'entitlement.plan': 'plus' as const, 'entitlement.activeUntil': { $gt: now } };
    const [signups7, signupsPrev7, dau, wau, mau, total, plus, monthly, yearly, promo] = await Promise.all([
      this.users.countDocuments({ createdAt: { $gte: ago(7) } }),
      this.users.countDocuments({ createdAt: { $gte: ago(14), $lt: ago(7) } }),
      this.users.countDocuments({ lastActiveAt: { $gte: ago(1) } }),
      this.users.countDocuments({ lastActiveAt: { $gte: ago(7) } }),
      this.users.countDocuments({ lastActiveAt: { $gte: ago(30) } }),
      this.users.countDocuments({ status: { $ne: 'deleted' } }),
      this.users.countDocuments(plusFilter),
      this.users.countDocuments({ ...plusFilter, 'entitlement.period': 'monthly', 'entitlement.source': { $ne: 'promo' } }),
      this.users.countDocuments({ ...plusFilter, 'entitlement.period': 'yearly', 'entitlement.source': { $ne: 'promo' } }),
      this.users.countDocuments({ ...plusFilter, 'entitlement.source': 'promo' }),
    ]);
    const today = now.toISOString().slice(0, 10);
    const from30 = addDays(today, -29);
    const signupsDaily = await this.users.aggregate<{ _id: string; n: number }>([
      { $match: { createdAt: { $gte: new Date(`${from30}T00:00:00Z`) } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
    ]);
    const scanDays = await this.scans.aggregate<{ _id: { d: string; s: string; dd: boolean }; n: number }>([
      { $match: { queuedAt: { $gte: new Date(`${from30}T00:00:00Z`) } } },
      { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$queuedAt' } }, s: '$status', dd: '$deduped' }, n: { $sum: 1 } } },
    ]);
    const routes = await this.profiles.aggregate<{ _id: string; started: number; completed: number }>([
      { $group: { _id: '$onboarding.route', started: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$onboarding.status', 'completed'] }, 1, 0] } } } },
    ]);
    const [cost] = await this.aiUsage.aggregate<{ total: number }>([{ $match: { date: { $gte: `${today.slice(0, 7)}-01` } } }, { $group: { _id: null, total: { $sum: '$costUsd' } } }]);
    const days: string[] = [];
    for (let d = from30; d <= today; d = addDays(d, 1)) days.push(d);
    const signupMap = new Map(signupsDaily.map((s) => [s._id, s.n]));
    const scansDaily = days.map((date) => {
      const rows = scanDays.filter((r) => r._id.d === date);
      const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((a, r) => a + r.n, 0);
      return { date, succeeded: sum((r) => r._id.s === 'succeeded' && !r._id.dd), rejected: sum((r) => r._id.s === 'rejected'), failed: sum((r) => r._id.s === 'failed'), deduped: sum((r) => r._id.dd) };
    });
    const week = scansDaily.slice(-7);
    const finished = week.reduce((a, d) => a + d.succeeded + d.rejected + d.failed, 0);
    return {
      generatedAt: now.toISOString(),
      kpis: {
        signups7d: kpi(signups7, signupsPrev7),
        dau: kpi(dau, null),
        wau: kpi(wau, null),
        mau: kpi(mau, null),
        plusConversionPct: kpi(pct(plus, total), null),
        activeSubscriptions: kpi(monthly + yearly, null),
        aiCostMtdUsd: kpi(Math.round((cost?.total ?? 0) * 100) / 100, null),
        scanSuccessRatePct: kpi(finished ? pct(week.reduce((a, d) => a + d.succeeded + d.rejected, 0), finished) : 100, null),
      },
      signupsDaily: days.map((date) => ({ date, signups: signupMap.get(date) ?? 0 })),
      activeUsersDaily: [{ date: today, dau, wau, mau }],
      onboardingByRoute: (['basic', 'detailed', 'conversation'] as const).map((route) => ({ route, started: routes.find((r) => r._id === route)?.started ?? 0, completed: routes.find((r) => r._id === route)?.completed ?? 0 })),
      scansDaily,
      plusConversionWeekly: [{ week: today, conversionPct: pct(plus, total) }],
      subscriptions: { monthly, yearly, grace: 0, promo },
    };
  }

  @Admin('content.view')
  @Get('flags')
  @ZResponse(200, z.array(AdminFlagSchema))
  async flags() {
    const doc = await this.appConfig.getDoc('flags');
    const values = { ...CONFIG_DEFAULTS.flags, ...((doc?.value as Record<string, boolean>) ?? {}) };
    return Object.entries(values).map(([key, enabled]) => ({ key, description: FLAG_DESCRIPTIONS[key] ?? (key.startsWith('features.') ? 'Phase 2 feature (hidden)' : ''), enabled, updatedAt: iso(doc?.updatedAt) ?? new Date(0).toISOString(), updatedBy: doc?.updatedBy ?? 'default' }));
  }

  @Admin('flags.edit')
  @Put('flags')
  @ZResponse(200, z.array(AdminFlagSchema))
  @ApiErrors(400, 401, 403)
  async putFlag(@ZBody(AdminPutFlagRequestSchema) body: z.infer<typeof AdminPutFlagRequestSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    if (!(body.key in CONFIG_DEFAULTS.flags)) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Unknown flag ${body.key}`, 400, { known: Object.keys(CONFIG_DEFAULTS.flags) });
    }
    const current = await this.appConfig.get<Record<string, boolean>>('flags', {});
    await this.appConfig.set('flags', { ...current, [body.key]: body.enabled }, admin.email);
    await this.audit.log(admin, req, { action: 'flag.set', targetType: 'flag', targetId: body.key, reason: body.reason, diff: { enabled: [current[body.key] ?? CONFIG_DEFAULTS.flags[body.key] ?? null, body.enabled] } });
    return this.flags();
  }

  private async experimentMap(): Promise<Record<string, StoredExperiment>> {
    return { ...(CONFIG_DEFAULTS.experiments as Record<string, StoredExperiment>), ...(await this.appConfig.get<Record<string, StoredExperiment>>('experiments', {})) };
  }

  @Admin('content.view')
  @Get('experiments')
  @ZResponse(200, z.array(AdminExperimentSchema))
  async experiments() {
    return Object.entries(await this.experimentMap()).map(([key, e]) => ({
      key,
      description: e.description ?? '',
      status: e.status ?? (e.active ? 'running' : 'draft'),
      allocationPct: e.allocationPct ?? 100,
      variants: e.variants.map((v) => ({ id: v.id, weight: v.weight, value: v.value ?? v.id })),
      startedAt: e.startedAt ?? null,
      stoppedAt: e.stoppedAt ?? null,
      updatedAt: e.updatedAt ?? new Date(0).toISOString(),
    }));
  }

  @Admin('experiments.edit')
  @Put('experiments')
  @ZResponse(200, z.array(AdminExperimentSchema))
  @ApiErrors(400, 401, 403)
  async putExperiment(@ZBody(AdminPutExperimentRequestSchema) body: z.infer<typeof AdminPutExperimentRequestSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const e = body.experiment;
    const total = e.variants.reduce((a, v) => a + v.weight, 0);
    if (e.status === 'running' && Math.abs(total - 100) > 0.001) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Variant weights must add up to 100 for a running experiment', 400, { total });
    }
    const map = await this.appConfig.get<Record<string, StoredExperiment>>('experiments', {});
    const prev = map[e.key] ?? (CONFIG_DEFAULTS.experiments as Record<string, StoredExperiment>)[e.key];
    const now = clock.now().toISOString();
    map[e.key] = {
      ...prev,
      active: e.status === 'running',
      status: e.status,
      allocationPct: e.allocationPct,
      variants: e.variants,
      startedAt: e.status === 'running' ? (prev?.startedAt ?? now) : (prev?.startedAt ?? null),
      stoppedAt: e.status === 'stopped' ? now : null,
      updatedAt: now,
    };
    await this.appConfig.set('experiments', map, admin.email);
    await this.audit.log(admin, req, { action: 'experiment.set', targetType: 'experiment', targetId: e.key, reason: body.reason, diff: { status: e.status, allocationPct: e.allocationPct, variants: e.variants } });
    return this.experiments();
  }

  @Admin('content.view')
  @Get('config/min-app-version')
  @ZResponse(200, AdminMinAppVersionSchema)
  async minAppVersion() {
    const doc = await this.appConfig.getDoc('minAppVersion');
    const v = { ...CONFIG_DEFAULTS.minAppVersion, ...((doc?.value as object) ?? {}) };
    return { ios: v.ios, android: v.android, updatedAt: iso(doc?.updatedAt) ?? new Date(0).toISOString(), updatedBy: doc?.updatedBy ?? 'default' };
  }

  @Admin('appVersion.edit')
  @Put('config/min-app-version')
  @ZResponse(200, AdminMinAppVersionSchema)
  @ApiErrors(400, 401, 403)
  async putMinAppVersion(@ZBody(AdminPutMinAppVersionRequestSchema) body: z.infer<typeof AdminPutMinAppVersionRequestSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const before = await this.minAppVersion();
    await this.appConfig.set('minAppVersion', { ios: body.ios, android: body.android }, admin.email);
    await this.audit.log(admin, req, { action: 'config.min_app_version', targetType: 'app_config', targetId: 'minAppVersion', reason: body.reason, diff: { ios: [before.ios, body.ios], android: [before.android, body.android] } });
    return this.minAppVersion();
  }

  @Admin('ai.killSwitch')
  @Post('ai/kill-switch')
  @HttpCode(200)
  @ZResponse(200, AdminKillSwitchSchema)
  @ApiErrors(400, 401, 403)
  async killSwitch(@ZBody(AdminKillSwitchRequestSchema) body: z.infer<typeof AdminKillSwitchRequestSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    await this.appConfig.set(body.key, body.enabled, admin.email, KILL_LABELS[body.key], body.reason);
    await this.audit.log(admin, req, { action: 'ai.kill_switch', targetType: 'app_config', targetId: body.key, reason: body.reason, diff: { enabled: body.enabled } });
    return (await this.killSwitches()).find((k) => k.key === body.key)!;
  }

  /** BI-3: current state of every kill switch with who changed it, when and why. */
  @Admin('ai.view')
  @Get('ai/kill-switches')
  @ZResponse(200, z.array(AdminKillSwitchSchema))
  async killSwitches() {
    return Promise.all(
      Object.entries(KILL_LABELS).map(async ([key, label]) => {
        const doc = await this.appConfig.getDoc(key);
        return { key, label, enabled: doc?.value === true, reason: doc?.reason ?? null, updatedAt: iso(doc?.updatedAt) ?? new Date(0).toISOString(), updatedBy: doc?.updatedBy ?? 'default' };
      }),
    );
  }

  @Admin('waitlist.view')
  @Get('waitlist')
  @ZResponse(200, z.object({ items: z.array(AdminWaitlistEntrySchema), nextCursor: z.string().nullable(), total: z.number().int() }), 'JSON, or text/csv with ?format=csv')
  async listWaitlist(@ZQuery(AdminPageQuerySchema) q: z.infer<typeof AdminPageQuerySchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const filter = q.query ? { email: { $regex: q.query.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {};
    const rows = await this.waitlist.find(filter).sort({ createdAt: -1 }).limit(q.format === 'csv' ? 100_000 : (q.limit ?? 100)).lean();
    const items = rows.map((w) => ({ id: String(w._id), email: w.email, source: w.source ?? '', utm: w.utm ?? {}, createdAt: new Date(w.createdAt).toISOString(), confirmedAt: iso(w.confirmedAt) }));
    if (q.format === 'csv') {
      await this.audit.log(admin, req, { action: 'waitlist.export', targetType: 'waitlist', reason: null, diff: { rows: items.length } });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="nouri-waitlist.csv"');
      const lines = [['id', 'email', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'createdAt', 'confirmedAt'].join(',')];
      for (const i of items) lines.push([i.id, i.email, i.source, i.utm.source, i.utm.medium, i.utm.campaign, i.createdAt, i.confirmedAt].map(csvCell).join(','));
      res.send(lines.join('\n') + '\n');
      return undefined;
    }
    return { items, nextCursor: null, total: await this.waitlist.countDocuments(filter) };
  }

  @Admin('audit.view')
  @Get('audit-logs')
  @ZResponse(200, z.object({ items: z.array(AdminAuditLogSchema), nextCursor: z.string().nullable() }))
  async auditLogs(@ZQuery(AdminAuditQuerySchema) q: z.infer<typeof AdminAuditQuerySchema>) {
    const filter: Record<string, unknown> = {};
    if (q.action) filter.action = q.action;
    if (q.actor) filter.$or = [{ actorId: q.actor }, { actorEmail: q.actor }];
    if (q.targetType) filter.targetType = q.targetType;
    if (q.targetId) filter.targetId = q.targetId;
    if (q.cursor) filter._id = { $lt: q.cursor };
    const limit = q.limit ?? 100;
    const docs = await this.logs.find(filter).sort({ _id: -1 }).limit(limit + 1).lean<AuditLogDoc[]>();
    const items = docs.slice(0, limit).map((d) => ({ ...d, id: d._id.toString(), _id: undefined, createdAt: new Date(d.createdAt).toISOString() }));
    return { items: items.map(({ _id, ...rest }) => rest), nextCursor: docs.length > limit ? items.at(-1)!.id : null };
  }

  @Admin('adminUsers.manage')
  @Get('admin-users')
  @ZResponse(200, z.array(AdminAdminUserSchema))
  async adminUsers() {
    const docs = await this.admins.find().sort({ createdAt: 1 }).lean<AdminUserDoc[]>();
    return docs.map((a) => ({ id: a._id.toString(), email: a.email, role: a.role, status: a.status, totpEnabled: Boolean(a.totpSecretEnc), lastLoginAt: iso(a.lastLoginAt), createdAt: new Date(a.createdAt).toISOString() }));
  }
}
