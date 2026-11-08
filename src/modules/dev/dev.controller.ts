import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ERROR_CODES } from '../../shared';
import { CurrentUser, Public, type AuthUser } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe';
import { KvStore } from '../../infra/kv/kv-store';
import { EmailSender, MemoryEmailSender } from '../auth/providers';
import { entitlementCacheKey } from '../billing/entitlement-cache';
import { UsersService } from '../users/users.service';
import { clock } from '../../common/clock';
import { AiProvider, FAKE_AI_MODES, FakeAiProvider } from '../ai/ai.provider';
import { AppConfigService } from '../content/app-config.service';
import { ContentService } from '../content/content.service';
import { JobHandlers } from '../../jobs/jobs.module';
import { RECONCILE_JOB } from '../../jobs/reconcile';
import { PURGE_JOB } from '../account/account.service';
import { SUMMARY_JOB } from '../conversations/services/conversation-summaries.service';
import { REMINDER_JOB } from '../reminders/reminders.service';
import { ConsolePushSender, PushSender } from '../reminders/providers/push';
import type { DeviceDoc } from '../users/schemas/users.schema';

/** Scheduled jobs QA can run on demand (POST /v1/dev/jobs/{name}). */
const DEV_JOBS = { purge: PURGE_JOB, reconcile: RECONCILE_JOB, reminders: REMINDER_JOB, summaries: SUMMARY_JOB } as const;

const DevEntitlementSchema = z.strictObject({
  plan: z.enum(['free', 'plus']),
  period: z.enum(['monthly', 'yearly']).optional(),
  days: z.number().int().min(1).max(400).optional(),
  freeScansUsed: z.number().int().min(0).max(100).optional(),
});

/** Development-only helpers; the module is not loaded unless config.devRoutes (never in production). */
@ApiTags('dev')
@Controller('dev')
export class DevController {
  constructor(
    private readonly email: EmailSender,
    private readonly users: UsersService,
    private readonly kv: KvStore,
    private readonly ai: AiProvider,
    private readonly appConfig: AppConfigService,
    private readonly content: ContentService,
    private readonly jobs: JobHandlers,
    private readonly push: PushSender,
    @InjectModel('Device') private readonly devices: Model<DeviceDoc>,
  ) {}

  /**
   * QA: run a scheduled job now, in this process: purge, reconcile, reminders, or summaries
   * (body `{conversationId}`). Combine with POST /v1/dev/clock to make work due.
   */
  @Public()
  @Post('jobs/:name')
  @HttpCode(200)
  async runJob(@Param('name') name: string, @Body(new ZodValidationPipe(z.strictObject({ conversationId: z.string().regex(/^[a-f0-9]{24}$/).optional() }))) body: { conversationId?: string }) {
    const job = DEV_JOBS[name as keyof typeof DEV_JOBS];
    if (!job) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, `Unknown job. Use one of: ${Object.keys(DEV_JOBS).join(', ')}`);
    if (name === 'summaries' && !body.conversationId) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'conversationId is required for summaries', 400, { field: 'conversationId' });
    const startedAt = Date.now();
    const result = await this.jobs.dispatch(job, name === 'summaries' ? { conversationId: body.conversationId } : {});
    return { name, job, result: result ?? null, ms: Date.now() - startedAt };
  }

  /** QA: the last push the console FCM driver "sent" to any of a user's devices. */
  @Public()
  @Get('last-push')
  async lastPush(@Query('userId') userId?: string) {
    if (!(this.push instanceof ConsolePushSender)) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'The console push driver is not active');
    if (!userId || !Types.ObjectId.isValid(userId)) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'userId must be an id', 400, { field: 'userId' });
    const tokens = new Set((await this.devices.find({ userId: new Types.ObjectId(userId) }, { pushToken: 1 }).lean<DeviceDoc[]>()).map((d) => d.pushToken).filter(Boolean));
    const mine = this.push.sent.filter((m) => tokens.has(m.token));
    const last = mine.at(-1);
    if (!last) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'No push sent to this user since the server started');
    return { userId, count: mine.length, title: last.title, body: last.body, data: last.data };
  }

  /** QA: fake AI behaviour for every caller (ok | not_food | fail | slow | unavailable). */
  @Public()
  @Post('ai-mode')
  @HttpCode(200)
  aiMode(@Body(new ZodValidationPipe(z.strictObject({ mode: z.enum(FAKE_AI_MODES), slowMs: z.number().int().min(0).max(120000).optional() }))) body: { mode: (typeof FAKE_AI_MODES)[number]; slowMs?: number }) {
    if (!(this.ai instanceof FakeAiProvider)) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'The fake AI provider is not active');
    this.ai.mode = body.mode;
    if (body.slowMs !== undefined) this.ai.slowMs = body.slowMs;
    return { mode: this.ai.mode, slowMs: this.ai.slowMs };
  }

  @Public()
  @Get('clock')
  getClock() {
    return { now: clock.now().toISOString(), offsetMs: clock.offsetMs() };
  }

  /** QA: shift the server clock (offsetMs, or an absolute `now`); `{ offsetMs: 0 }` resets. Caches are cleared. */
  @Public()
  @Post('clock')
  @HttpCode(200)
  setClock(@Body(new ZodValidationPipe(z.strictObject({ offsetMs: z.number().int().optional(), now: z.iso.datetime().optional() }))) body: { offsetMs?: number; now?: string }) {
    clock.setOffset(body.now ? new Date(body.now).getTime() - Date.now() : (body.offsetMs ?? 0));
    this.appConfig.clearCache();
    this.content.clearCache();
    return { now: clock.now().toISOString(), offsetMs: clock.offsetMs() };
  }

  @Public()
  @Get('last-otp')
  lastOtp(@Query('email') email?: string): { email: string; code: string } {
    const key = (email ?? '').trim().toLowerCase();
    const code = this.email instanceof MemoryEmailSender ? this.email.outbox.get(key) : undefined;
    if (!code) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'No code sent to this address since the server started');
    return { email: key, code };
  }

  /** BI-9: the last emailed link (admin invite, data export) for an address, for live tests. */
  @Public()
  @Get('last-link')
  lastLink(@Query('email') email?: string): { email: string; kind: string; url: string } {
    const key = (email ?? '').trim().toLowerCase();
    const link = this.email instanceof MemoryEmailSender ? this.email.links.get(key) : undefined;
    if (!link) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, 'No link sent to this address since the server started');
    return { email: key, ...link };
  }

  /** QA: switch the signed-in user between Free and Plus, or reset the free-scan count. */
  @ApiBearerAuth()
  @Post('entitlement')
  @HttpCode(200)
  async entitlement(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(DevEntitlementSchema)) body: z.infer<typeof DevEntitlementSchema>) {
    const set: Record<string, unknown> =
      body.plan === 'plus'
        ? { entitlement: { plan: 'plus', period: body.period ?? 'monthly', activeUntil: new Date(Date.now() + (body.days ?? 30) * 86_400_000), source: 'promo' } }
        : { entitlement: { plan: 'free', period: null, activeUntil: null, source: null } };
    if (body.freeScansUsed !== undefined) set['freeScans.used'] = body.freeScansUsed;
    await this.users.users.updateOne({ _id: u.id }, { $set: set });
    await this.kv.del(entitlementCacheKey(u.id));
    return { ok: true };
  }
}
