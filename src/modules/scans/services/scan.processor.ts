import { clock } from '../../../common/clock';
import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { dayKeyFor } from '../../../domain/day-keys';
import { isPlusActive, shouldChargeFreeScan } from '../../../domain/entitlements';
import { normaliseAnalysis, normaliseLabel, parseLabelOutput, parseModelOutput } from '../../../domain/nutrition-validator';
import { FoodRecordsService } from '../../content/food-records.service';
import { fillTemplate } from '../../content/content.loader';
import { ERROR_CODES, scanPromptKey, type ScanOutcome } from '../../../shared';
import { DEFAULT_LOCALE, parseLocale } from '../../../shared/locales';
import { languageDirective } from '../../ai/language';
import { ContentService } from '../../content/content.service';
import { AiUnavailableError } from '../../ai/ai.service';
import { FoodScanService } from '../../ai/food-scan.service';
import { FoodVisionError } from '../../ai/providers/food-vision.provider';
import type { ProfileDoc } from '../../onboarding/schemas/onboarding.schema';
import { PlansService } from '../../plans/plans.service';
import { DailyLogsService } from '../../tracking/services/daily-logs.service';
import type { ScanLedgerDoc, UserDoc } from '../../users/schemas/users.schema';
import { UsersService } from '../../users/users.service';
import type { ScanDoc } from '../schemas/scans.schema';
import { KvStore } from '../../../infra/kv/kv-store';
import { StorageService } from '../../../infra/storage/storage';
import { entitlementCacheKey } from '../../billing/entitlement-cache';

export const AI_WAIT_LIMIT_MS = 2 * 60_000; // plan 8.10: queued up to 2 minutes, then failed
export const STUCK_PROCESSING_MS = 3 * 60_000; // plan 8.10 stuck-job sweep

const REJECTIONS: Partial<Record<ScanOutcome, { code: string; message: string }>> = {
  no_food: { code: ERROR_CODES.NO_FOOD_DETECTED, message: 'No food was found in this photo' },
  unclear: { code: ERROR_CODES.IMAGE_UNCLEAR, message: 'This photo is too unclear to estimate' },
};
const LABEL_REJECTIONS: Partial<Record<ScanOutcome, { code: string; message: string }>> = {
  no_food: { code: ERROR_CODES.NO_LABEL_DETECTED, message: 'No nutrition table was found in this photo' },
  unclear: { code: ERROR_CODES.IMAGE_UNCLEAR, message: 'The nutrition table could not be read' },
};

function failureOf(e: unknown): { code: string; message: string } {
  if (e instanceof AiUnavailableError) return { code: e.code, message: e.message };
  if (e instanceof FoodVisionError && e.kind === 'timeout') return { code: 'TIMEOUT', message: 'The analysis took too long' };
  return { code: 'AI_FAILED', message: 'The analysis did not finish' };
}

/**
 * Worker job for one scan (M4-T3): claim → model call through modules/ai → validate and
 * normalise (plan 8.3) → write succeeded/rejected/failed → charge the free scan on success only.
 */
@Injectable()
export class ScanProcessor {
  private readonly logger = new Logger('ScanProcessor');

  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectModel('Scan') private readonly scans: Model<ScanDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('ScanLedger') private readonly ledger: Model<ScanLedgerDoc>,
    private readonly users: UsersService,
    private readonly foodScan: FoodScanService,
    private readonly records: FoodRecordsService,
    private readonly content: ContentService,
    private readonly plans: PlansService,
    private readonly dailyLogs: DailyLogsService,
    private readonly storage: StorageService,
    private readonly kv: KvStore,
  ) {}

  async process(scanId: string, now = clock.now()): Promise<void> {
    const scan = await this.scans
      .findOneAndUpdate(
        { _id: scanId, status: 'queued' },
        { $set: { status: 'processing', startedAt: now }, $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      )
      .lean<ScanDoc>();
    if (!scan) return; // already done or claimed: retries never call the model twice
    // The app gave up on this long ago (for example the worker was down): no model call, no charge.
    if (now.getTime() - new Date(scan.queuedAt).getTime() >= AI_WAIT_LIMIT_MS) {
      return this.finish(scan, 'failed', { error: { code: 'TIMEOUT', message: 'The analysis took too long' } });
    }
    const user = await this.users.findById(scan.userId.toString());
    if (!user) return this.finish(scan, 'failed', { error: { code: 'USER_GONE', message: 'Account no longer active' } });
    try {
      const mode = scan.mode ?? 'meal';
      const prompt = await this.content.activePrompt(scanPromptKey(mode));
      const profile = await this.profiles.findOne({ userId: scan.userId }).lean<ProfileDoc>();
      const scanLocale = parseLocale(scan.locale) ?? parseLocale(user.locale) ?? DEFAULT_LOCALE;
      const image = await this.storage.get(scan.imageKey);
      if (!image) return this.finish(scan, 'failed', { error: { code: 'AI_FAILED', message: 'The photo is no longer available' } });
      const res = await this.foodScan.analyse({
        scanId,
        mode,
        instructions: prompt?.staticPrefix ?? (mode === 'label' ? 'Copy the nutrition table in the photo and return JSON.' : 'List the foods in the photo and return JSON.'),
        context: languageDirective(scanLocale) + fillTemplate(prompt?.dynamicTemplate ?? '', { dietPattern: profile?.dietPattern ?? '' }),
        image,
      });
      const parsed = mode === 'label' ? parseLabelOutput(res.output) : parseModelOutput(res.output);
      const meta = {
        model: res.model,
        promptKey: prompt?.key ?? null,
        promptVersion: prompt?.version ?? null,
        rawOutput: res.output,
        usage: { ...res.usage, costUsd: res.costUsd },
        providerAttempts: res.attempts,
        modelLatencyMs: res.modelLatencyMs,
      };
      if (!parsed.ok) {
        // Malformed or cut-off JSON is never repaired: nothing is shown, and the user is not charged.
        return this.finish(scan, 'failed', { ...meta, error: { code: 'MODEL_OUTPUT_INVALID', message: 'The analysis could not be read' } });
      }
      const reaction = await this.reactionInput(scan, user, profile, now);
      const extra = reaction ? { reaction } : {};
      const normalised =
        mode === 'label'
          ? normaliseLabel(parsed.value as Parameters<typeof normaliseLabel>[0], { barcode: scan.barcode ?? null, ...extra })
          : normaliseAnalysis(parsed.value as Parameters<typeof normaliseAnalysis>[0], { records: this.records.index, ...extra });
      const rejections = mode === 'label' ? LABEL_REJECTIONS : REJECTIONS;
      if (normalised.status === 'succeeded') await this.succeed(scan, user, { ...meta, result: normalised.analysis }, now);
      else await this.finish(scan, normalised.status, { ...meta, result: normalised.analysis, error: rejections[normalised.analysis.outcome] ?? null });
    } catch (e) {
      const mayRecover = e instanceof AiUnavailableError && e.reason !== 'daily_cap' && e.reason !== 'not_configured';
      if (mayRecover && now.getTime() - new Date(scan.queuedAt).getTime() < AI_WAIT_LIMIT_MS) {
        // Degraded mode: back to queued; the queue retries with backoff, the sweep fails it after 2 min.
        await this.scans.updateOne({ _id: scan._id, status: 'processing' }, { $set: { status: 'queued', error: { code: e.code, message: e.message } } });
        throw e;
      }
      this.logger.warn({ scanId, err: (e as Error).message }, 'scan failed');
      await this.finish(scan, 'failed', { error: failureOf(e) });
    }
  }

  private async reactionInput(scan: ScanDoc, user: UserDoc, profile: ProfileDoc | null, now: Date) {
    const content = await this.content.scanReactions(parseLocale(scan.locale) ?? parseLocale(user.locale) ?? DEFAULT_LOCALE);
    if (!content) return null;
    const mode = profile?.mode ?? 'habits_only';
    const plan = await this.plans.active(user._id.toString());
    let remainingBefore: number | null = null;
    if (mode === 'full' && plan?.energyKcal != null) {
      const log = await this.dailyLogs.get(user._id, dayKeyFor(now, scan.timezone));
      remainingBefore = plan.energyKcal - (log?.totals.kcal ?? 0);
    }
    return { content, mode, remainingBefore, scanId: scan._id };
  }

  private async finish(scan: ScanDoc, status: 'succeeded' | 'rejected' | 'failed', fields: Partial<ScanDoc>): Promise<void> {
    const finishedAt = new Date();
    await this.scans.updateOne(
      { _id: scan._id },
      { $set: { ...fields, status, finishedAt, inflightKey: null, latencyMs: finishedAt.getTime() - new Date(scan.queuedAt).getTime(), ...(status === 'succeeded' ? { error: null } : {}) } },
    );
  }

  /**
   * BR-01/BR-02: `succeeded` and the free-scan charge are written in one transaction, so a poll
   * never sees a succeeded scan that is not yet charged (QA P2). Charged once, never for Plus, and
   * mirrored in scan_ledger by email HMAC.
   */
  private async succeed(scan: ScanDoc, user: UserDoc, fields: Partial<ScanDoc>, now: Date): Promise<void> {
    const chargeable = shouldChargeFreeScan({
      status: 'succeeded',
      alreadyCharged: scan.chargedFreeScan,
      deduped: scan.deduped,
      isPlus: isPlusActive(user.entitlement, now),
    });
    const finishedAt = new Date();
    await this.conn.transaction(async (session) => {
      const done = await this.scans.updateOne(
        { _id: scan._id, status: 'processing' },
        {
          $set: {
            ...fields,
            status: 'succeeded',
            error: null,
            finishedAt,
            inflightKey: null,
            latencyMs: finishedAt.getTime() - new Date(scan.queuedAt).getTime(),
            chargedFreeScan: chargeable,
          },
        },
        { session },
      );
      if (done.modifiedCount !== 1 || !chargeable) return;
      await this.users.users.updateOne({ _id: user._id }, { $inc: { 'freeScans.used': 1 } }, { session });
      await this.ledger.updateOne({ emailHmac: this.users.ledgerKey(user.email) }, { $inc: { freeScansUsed: 1 } }, { upsert: true, session });
    });
    if (chargeable) await this.kv.del(entitlementCacheKey(user._id.toString()));
  }

  /** Stuck-job sweep: processing > 3 min, or queued > 2 min while AI is unavailable → failed, no charge. */
  async sweep(now = clock.now()): Promise<number> {
    const stuck = await this.scans.updateMany(
      {
        $or: [
          { status: 'processing', startedAt: { $lt: new Date(now.getTime() - STUCK_PROCESSING_MS) } },
          { status: 'queued', queuedAt: { $lt: new Date(now.getTime() - AI_WAIT_LIMIT_MS) } },
        ],
      },
      { $set: { status: 'failed', finishedAt: now, inflightKey: null, error: { code: 'TIMEOUT', message: 'The analysis took too long' } } },
    );
    return stuck.modifiedCount;
  }

}
