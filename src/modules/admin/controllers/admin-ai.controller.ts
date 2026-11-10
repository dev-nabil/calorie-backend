import { Controller, Get, HttpCode, Patch, Post, Put, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import {
  AI_LIMITS,
  AdminAiSettingsSchema,
  AdminAiUsageSchema,
  AdminCreatePromptSchema,
  AdminPatchPromptSchema,
  AdminPromptSchema,
  AdminPromptTestResultSchema,
  AdminPromptTestSchema,
  AdminPutAiSettingsSchema,
  AdminScanListSchema,
  AdminSloReportSchema,
  ERROR_CODES,
  ObjectIdSchema,
  UPLOAD_KINDS,
} from '../../../shared';
import { clock } from '../../../common/clock';
import { ApiError } from '../../../common/errors/api-error';
import { percentile, requestMetrics } from '../../../common/metrics/request-metrics';
import { ApiErrors, ZBody, ZParam, ZQuery, ZResponse } from '../../../common/zod/decorators';
import { AiProvider, type AiTask } from '../../ai/ai.provider';
import { DEFAULT_TEXT_MODEL, DEFAULT_TTS_MODEL } from '../../ai/ai-models';
import { AiService } from '../../ai/ai.service';
import type { AiUsageDailyDoc } from '../../ai/schemas/ai.schema';
import { AppConfigService } from '../../content/app-config.service';
import { DYNAMIC_MARKER } from '../../content/content.loader';
import type { AiPromptDoc } from '../../content/schemas/content.schema';
import type { ScanDoc } from '../../scans/schemas/scans.schema';
import { Admin } from './admin-auth.controller';
import { AdminMiscController } from './admin-misc.controller';
import { AuditService } from '../services/audit.service';
import { CurrentAdmin } from '../security/admin.decorators';
import { type AdminSessionData } from '../security/admin-session.types';

type PromptDoc = AiPromptDoc & { _id: Types.ObjectId; createdAt: Date; notes?: string; activatedAt?: Date | null };
const FEATURES = ['vision', 'extract', 'chat', 'stt', 'tts', 'moderation'] as const;
const MODEL_DEFAULTS: Record<(typeof FEATURES)[number], string> = { vision: DEFAULT_TEXT_MODEL, extract: DEFAULT_TEXT_MODEL, chat: DEFAULT_TEXT_MODEL, stt: DEFAULT_TEXT_MODEL, tts: DEFAULT_TTS_MODEL, moderation: DEFAULT_TEXT_MODEL };
const TASK_FOR: Record<string, { task: AiTask | 'chat'; feature: 'vision' | 'extract' | 'chat' }> = {
  'meal-scan': { task: 'meal_scan', feature: 'vision' },
  'label-scan': { task: 'label_scan', feature: 'vision' },
  'meal-parse': { task: 'meal_parse', feature: 'extract' },
  'onboarding-extract': { task: 'onboarding_extract', feature: 'extract' },
  coach: { task: 'chat', feature: 'chat' },
};
const BUDGET_DEFAULTS = { monthlyLimitUsd: 0, alertPct: 80, downgradePct: 95 };
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

function toPrompt(p: PromptDoc) {
  const params = (p.params ?? {}) as { temperature?: number; maxOutputTokens?: number };
  return {
    id: p._id.toString(),
    key: p.key,
    version: p.version,
    staticPrefix: p.staticPrefix,
    content: p.content,
    model: p.model ?? '',
    params: { temperature: params.temperature ?? 1, maxOutputTokens: params.maxOutputTokens ?? 1000 },
    active: p.active,
    notes: p.notes ?? '',
    createdBy: p.createdBy,
    createdAt: new Date(p.createdAt).toISOString(),
    activatedAt: iso(p.activatedAt),
  };
}

/** M7-T4: AI settings, prompt versions (activate = rollback too), playground, failed scans, usage, SLOs. */
@ApiTags('admin')
@Controller('admin')
export class AdminAiController {
  constructor(
    @InjectModel('AiPrompt') private readonly prompts: Model<PromptDoc>,
    @InjectModel('Scan') private readonly scans: Model<ScanDoc>,
    @InjectModel('AiUsageDaily') private readonly usage: Model<AiUsageDailyDoc>,
    @InjectModel('BillingEvent') private readonly billingEvents: Model<{ receivedAt: Date; processedAt: Date | null }>,
    @InjectModel('ReconcileRun') private readonly reconcileRuns: Model<{ at: Date; checked: number; drifted: number }>,
    private readonly appConfig: AppConfigService,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly audit: AuditService,
    private readonly misc: AdminMiscController,
  ) {}

  @Admin('ai.view')
  @Get('ai/settings')
  @ZResponse(200, AdminAiSettingsSchema)
  async settings() {
    const models = Object.fromEntries(await Promise.all(FEATURES.map(async (f) => [f, await this.appConfig.get(`ai.model.${f}`, MODEL_DEFAULTS[f])])));
    const l = await this.appConfig.get<typeof AI_LIMITS & { plus: { spokenRepliesPerDay?: number }; free: { spokenRepliesPerDay?: number } }>('limits', AI_LIMITS as never);
    const image = await this.appConfig.get('limits.image', { maxEdgePx: 1280, maxBytes: UPLOAD_KINDS.meal_photo.maxBytes });
    const budget = await this.appConfig.get('ai.budget', BUDGET_DEFAULTS);
    const doc = await this.appConfig.getDoc('limits');
    return {
      models,
      limits: {
        free: { scans: l.free.scansLifetime, scansLifetime: l.free.scansLifetime, describePerDay: l.free.describePerDay, coachPerDay: l.free.coachPerDay, spokenRepliesPerDay: l.free.spokenRepliesPerDay ?? 0, maxReplyTokens: l.free.maxReplyTokens },
        plus: { scans: l.plus.scansPerDay, scansPerMonthSoftCap: l.plus.scansPerMonthSoft, describePerDay: l.plus.describePerDay, coachPerDay: l.plus.coachPerDay, spokenRepliesPerDay: l.plus.spokenRepliesPerDay ?? 50, maxReplyTokens: l.plus.maxReplyTokens },
        image,
      },
      budget: { ...BUDGET_DEFAULTS, ...budget },
      killSwitches: await this.misc.killSwitches(),
      updatedAt: iso(doc?.updatedAt) ?? new Date(0).toISOString(),
      updatedBy: doc?.updatedBy ?? 'default',
    };
  }

  @Admin('ai.settings.edit')
  @Put('ai/settings')
  @ZResponse(200, AdminAiSettingsSchema)
  @ApiErrors(400, 401, 403)
  async putSettings(@ZBody(AdminPutAiSettingsSchema) body: z.infer<typeof AdminPutAiSettingsSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    for (const [f, model] of Object.entries(body.models)) await this.appConfig.set(`ai.model.${f}`, model, admin.email);
    const { free, plus, image } = body.limits;
    await this.appConfig.set(
      'limits',
      {
        free: { scansLifetime: free.scansLifetime, describePerDay: free.describePerDay, coachPerDay: free.coachPerDay, spokenRepliesPerDay: free.spokenRepliesPerDay, maxReplyTokens: free.maxReplyTokens },
        plus: { scansPerDay: plus.scans, scansPerMonthSoft: plus.scansPerMonthSoftCap, describePerDay: plus.describePerDay, coachPerDay: plus.coachPerDay, spokenRepliesPerDay: plus.spokenRepliesPerDay, maxReplyTokens: plus.maxReplyTokens },
      },
      admin.email,
    );
    await this.appConfig.set('limits.image', image, admin.email);
    await this.appConfig.set('ai.budget', body.budget, admin.email);
    await this.audit.log(admin, req, { action: 'ai.settings', targetType: 'app_config', targetId: 'ai', reason: body.reason, diff: { models: body.models, limits: body.limits, budget: body.budget } });
    return this.settings();
  }

  @Admin('ai.view')
  @Get('prompts')
  @ZResponse(200, z.array(AdminPromptSchema))
  async listPrompts(@ZQuery(z.strictObject({ key: z.string().max(64).optional() })) q: { key?: string }) {
    const docs = await this.prompts.find(q.key ? { key: q.key } : {}).sort({ key: 1, version: -1 }).lean<PromptDoc[]>();
    return docs.map(toPrompt);
  }

  @Admin('ai.prompts.manage')
  @Post('prompts')
  @ZResponse(201, AdminPromptSchema, 'New inactive version')
  @ApiErrors(400, 401, 403)
  async createPrompt(@ZBody(AdminCreatePromptSchema) body: z.infer<typeof AdminCreatePromptSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const latest = await this.prompts.findOne({ key: body.key }).sort({ version: -1 }).lean<PromptDoc>();
    const doc = await this.prompts.create({
      key: body.key,
      version: (latest?.version ?? 0) + 1,
      content: body.content,
      staticPrefix: body.staticPrefix,
      dynamicTemplate: body.content.includes(DYNAMIC_MARKER) ? body.content.split(DYNAMIC_MARKER)[1]!.trim() : (latest?.dynamicTemplate ?? body.content),
      model: body.model || null,
      params: body.params,
      notes: body.notes,
      active: false,
      createdBy: admin.email,
    });
    await this.audit.log(admin, req, { action: 'prompt.create', targetType: 'ai_prompt', targetId: doc._id.toString(), reason: body.reason, diff: { key: body.key, version: doc.version } });
    return toPrompt(doc.toObject() as PromptDoc);
  }

  @Admin('ai.prompts.manage')
  @Patch('prompts/:id')
  @ZResponse(200, AdminPromptSchema)
  @ApiErrors(400, 401, 403, 404, 409)
  async patchPrompt(@ZParam('id', ObjectIdSchema) id: string, @ZBody(AdminPatchPromptSchema) body: z.infer<typeof AdminPatchPromptSchema>, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const p = await this.prompts.findById(id).lean<PromptDoc>();
    if (!p) throw ApiError.notFound();
    const { reason, ...rest } = body;
    if (p.active && (rest.content || rest.staticPrefix || rest.model || rest.params)) {
      throw ApiError.conflict(ERROR_CODES.CONFLICT, 'Active prompts are never edited in place; create a new version');
    }
    const set: Record<string, unknown> = { ...rest };
    if (rest.content?.includes(DYNAMIC_MARKER)) set.dynamicTemplate = rest.content.split(DYNAMIC_MARKER)[1]!.trim();
    const doc = await this.prompts.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after' }).lean<PromptDoc>();
    await this.audit.log(admin, req, { action: 'prompt.edit', targetType: 'ai_prompt', targetId: id, reason, diff: rest });
    return toPrompt(doc!);
  }

  /** Activate a version; activating an older one is the rollback. Takes effect immediately. */
  @Admin('ai.prompts.manage')
  @Post('prompts/:id/activate')
  @HttpCode(200)
  @ZResponse(200, AdminPromptSchema)
  @ApiErrors(400, 401, 403, 404)
  async activate(@ZParam('id', ObjectIdSchema) id: string, @ZBody(z.strictObject({ reason: z.string().trim().min(5).max(500) })) body: { reason: string }, @CurrentAdmin() admin: AdminSessionData, @Req() req: Request) {
    const p = await this.prompts.findById(id).lean<PromptDoc>();
    if (!p) throw ApiError.notFound();
    const previous = await this.prompts.findOne({ key: p.key, active: true }).lean<PromptDoc>();
    await this.prompts.updateMany({ key: p.key, _id: { $ne: p._id } }, { $set: { active: false } });
    const doc = await this.prompts.findByIdAndUpdate(id, { $set: { active: true, activatedAt: clock.now() } }, { returnDocument: 'after' }).lean<PromptDoc>();
    await this.audit.log(admin, req, { action: 'prompt.activate', targetType: 'ai_prompt', targetId: id, reason: body.reason, diff: { key: p.key, from: previous?.version ?? null, to: p.version } });
    return toPrompt(doc!);
  }

  /** Playground: runs a prompt version on sample input through modules/ai (kill switches and budget apply). */
  @Admin('ai.prompts.manage')
  @Post('prompts/test')
  @HttpCode(200)
  @ZResponse(200, AdminPromptTestResultSchema)
  @ApiErrors(400, 401, 403, 404, 503)
  async test(@ZBody(AdminPromptTestSchema) body: z.infer<typeof AdminPromptTestSchema>) {
    const p = await this.prompts.findById(body.promptId).lean<PromptDoc>();
    if (!p) throw ApiError.notFound();
    // A scan needs a photo and runs on Gemini; `pnpm eval:meal-scan` is the way to try a prompt version.
    if (p.key === 'meal-scan') throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'The meal scan prompt needs a photo: use pnpm eval:meal-scan');
    const spec = TASK_FOR[p.key] ?? { task: 'chat' as const, feature: 'chat' as const };
    const model = p.model || (await this.ai.modelFor(spec.feature, MODEL_DEFAULTS[spec.feature]));
    const maxOutputTokens = Number((p.params as { maxOutputTokens?: number })?.maxOutputTokens ?? 1000);
    const started = Date.now();
    const res = await this.ai.run(spec.feature, () =>
      spec.task === 'chat'
        ? this.provider.complete({ model, instructions: p.staticPrefix, messages: [{ role: 'user', content: body.input }], timeoutMs: 15_000, maxOutputTokens })
        : this.provider.structured({ task: spec.task as AiTask, model, instructions: p.staticPrefix, context: body.input, timeoutMs: 25_000, maxOutputTokens }),
    );
    return {
      output: typeof res.output === 'string' ? res.output : JSON.stringify(res.output, null, 2),
      latencyMs: Date.now() - started,
      usage: { ...res.usage, costUsd: res.costUsd },
    };
  }

  @Admin('ai.failedScans.view')
  @Get('scans')
  @ZResponse(200, AdminScanListSchema)
  async listScans(@ZQuery(z.strictObject({ status: z.string().max(32).optional(), cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(500).optional() })) q: { status?: string; cursor?: string; limit?: number }) {
    const lowConfidence = q.status === 'low_confidence';
    const filter: Record<string, unknown> = lowConfidence ? { status: 'succeeded' } : q.status ? { status: q.status } : {};
    if (q.cursor) filter.queuedAt = { $lt: new Date(q.cursor) };
    const limit = q.limit ?? 100;
    const docs = await this.scans.find(filter, { rawOutput: 0 }).sort({ queuedAt: -1 }).limit(lowConfidence ? 2000 : limit + 1).lean<ScanDoc[]>();
    const confidence = (s: ScanDoc) => (s.result?.items.length ? Math.round((s.result.items.reduce((a, i) => a + i.confidence, 0) / s.result.items.length) * 100) / 100 : null);
    const picked = (lowConfidence ? docs.filter((s) => (confidence(s) ?? 1) < 0.6) : docs).slice(0, limit + 1);
    const items = picked.slice(0, limit).map((s) => ({
      id: s._id,
      userId: s.userId.toString(),
      status: s.status,
      model: s.model ?? '',
      promptKey: s.promptKey ?? '',
      promptVersion: s.promptVersion ?? 0,
      error: s.error ?? null,
      confidence: confidence(s),
      attempts: s.attempts,
      queuedAt: new Date(s.queuedAt).toISOString(),
      finishedAt: iso(s.finishedAt),
      costUsd: s.usage?.costUsd ?? 0,
    }));
    return { items, nextCursor: picked.length > limit ? items.at(-1)!.queuedAt : null };
  }

  @Admin('ai.usage.view')
  @Get('metrics/ai-usage')
  @ZResponse(200, AdminAiUsageSchema)
  async aiUsage(@ZQuery(z.strictObject({ days: z.coerce.number().int().min(1).max(365).optional() })) q: { days?: number }) {
    const now = clock.now();
    const to = now.toISOString().slice(0, 10);
    const from = new Date(now.getTime() - ((q.days ?? 30) - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.usage.find({ date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean<AiUsageDailyDoc[]>();
    const budget = await this.appConfig.get('ai.budget', BUDGET_DEFAULTS);
    return {
      from,
      to,
      days: rows.map((r) => ({ date: r.date, feature: r.feature, model: r.model, requests: r.requests, inputTokens: r.inputTokens, cachedTokens: r.cachedTokens, outputTokens: r.outputTokens, costUsd: Math.round(r.costUsd * 1e6) / 1e6 })),
      monthlyBudgetUsd: budget.monthlyLimitUsd || 0,
      monthToDateUsd: Math.round((await this.ai.monthSpend(now)) * 100) / 100,
    };
  }

  /** Plan section 15 SLOs from this instance's request metrics and the last 24 h of scans and webhooks. */
  @Admin('metrics.aggregate')
  @Get('metrics/slo')
  @ZResponse(200, AdminSloReportSchema)
  async slo() {
    const since = new Date(clock.now().getTime() - 86_400_000);
    const scans = await this.scans.find({ queuedAt: { $gte: since }, status: { $in: ['succeeded', 'rejected', 'failed'] }, deduped: false }, { status: 1, latencyMs: 1 }).lean<ScanDoc[]>();
    const lat = scans.map((s) => s.latencyMs ?? 0).sort((a, b) => a - b);
    const ok = scans.filter((s) => s.status !== 'failed').length;
    const hooks = await this.billingEvents.find({ receivedAt: { $gte: since }, processedAt: { $ne: null } }, { receivedAt: 1, processedAt: 1 }).lean<{ receivedAt: Date; processedAt: Date }[]>();
    const hookLat = hooks.map((h) => new Date(h.processedAt).getTime() - new Date(h.receivedAt).getTime()).sort((a, b) => a - b);
    const lastRun = await this.reconcileRuns.findOne().sort({ at: -1 }).lean<{ checked: number; drifted: number }>();
    const avail = requestMetrics.total ? 1 - requestMetrics.errors5xx / requestMetrics.total : 1;
    const item = (key: string, name: string, target: string, current: string | null, good: boolean | null, budget: number) => ({
      key,
      name,
      target,
      current: current ?? 'no data',
      status: good === null ? ('ok' as const) : good ? ('ok' as const) : budget > 0 ? ('at_risk' as const) : ('breached' as const),
      budgetRemainingPct: Math.max(0, Math.min(100, Math.round(budget))),
    });
    const ms = (v: number | null) => (v === null ? null : `${Math.round(v)} ms`);
    const readP95 = requestMetrics.p95('read');
    const writeP95 = requestMetrics.p95('write');
    const p50 = percentile(lat, 50);
    const p95 = percentile(lat, 95);
    const successRate = scans.length ? ok / scans.length : null;
    return {
      generatedAt: clock.now().toISOString(),
      items: [
        item('availability', 'API availability (5xx-free)', '99.9%', `${(avail * 100).toFixed(2)}%`, avail >= 0.999, ((avail - 0.999) / 0.001) * 100),
        item('read_latency', 'Read latency p95 (/days, /meals, /progress)', '< 300 ms', ms(readP95), readP95 === null ? null : readP95 < 300, readP95 === null ? 100 : ((300 - readP95) / 300) * 100),
        item('write_latency', 'Write latency p95 (/meals, /water)', '< 500 ms', ms(writeP95), writeP95 === null ? null : writeP95 < 500, writeP95 === null ? 100 : ((500 - writeP95) / 500) * 100),
        item('scan_e2e', 'Scan end to end p50 / p95', '< 6 s / < 15 s', p50 === null ? null : `${(p50 / 1000).toFixed(1)} s / ${(p95! / 1000).toFixed(1)} s`, p95 === null ? null : p50! < 6000 && p95! < 15000, p95 === null ? 100 : ((15000 - p95) / 15000) * 100),
        item('scan_success', 'Scan success rate', '> 97%', successRate === null ? null : `${(successRate * 100).toFixed(1)}%`, successRate === null ? null : successRate > 0.97, successRate === null ? 100 : ((successRate - 0.97) / 0.03) * 100),
        item('webhook', 'Webhook processing p99', '< 10 s', ms(percentile(hookLat, 99)), hookLat.length ? percentile(hookLat, 99)! < 10_000 : null, 100),
        item('reconcile_drift', 'daily_logs drift (last nightly run)', '0 days', lastRun ? `${lastRun.drifted} of ${lastRun.checked}` : null, lastRun ? lastRun.drifted === 0 : null, lastRun?.drifted ? 0 : 100),
      ],
    };
  }
}
