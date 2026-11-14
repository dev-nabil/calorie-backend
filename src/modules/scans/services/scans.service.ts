import { requestLocale } from '../../../common/http/request-context';
import { clock } from '../../../common/clock';
import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RateLimiter } from '../../../common/rate-limit/rate-limiter.service';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AI_LIMITS, ERROR_CODES, UPLOAD_KINDS, scanPromptKey, type ScanMode, type AnalysedItem, type CreateScanRequest, type RecalculateScanRequest, type RecalculatedScan, type Scan } from '../../../shared';
import { canStartScan, freeScansRemaining, isPlusActive, isVerifiedAccount } from '../../../domain/entitlements';
import { ApiError } from '../../../common/errors/api-error';
import { AppConfigService } from '../../content/app-config.service';
import { DaysService } from '../../tracking/services/days.service';
import { MealsService } from '../../tracking/services/meals.service';
import { UsersService } from '../../users/users.service';
import { ScanQueue } from '../scan-queue';
import { StorageService } from '../../../infra/storage/storage';
import { ownsKey } from '../../uploads/uploads.keys';
import { addedItem, applyItemCorrection, computeMealTotals } from '../../../domain/food-nutrition';
import { ScanImageError, sha256Hex, validateScanImage } from '../../../infra/media/scan-image';
import { FoodScanService } from '../../ai/food-scan.service';
import { ContentService } from '../../content/content.service';
import { FoodRecordsService } from '../../content/food-records.service';
import type { ProfileDoc } from '../../onboarding/schemas/onboarding.schema';
import type { AbuseEventDoc, ScanDoc } from '../schemas/scans.schema';

const DEDUPE_WINDOW_MS = 24 * 3600_000;
const RECALCULATE_PER_MINUTE = 120;
const POSTS_PER_MINUTE = 30;
const DECISION_STATUS: Record<string, HttpStatus> = {
  EMAIL_NOT_VERIFIED: HttpStatus.FORBIDDEN,
  INTEGRITY_REQUIRED: HttpStatus.FORBIDDEN,
  SCAN_LIMIT_REACHED: HttpStatus.PAYMENT_REQUIRED,
};

/** M4-T7 defaults (app_config `limits.scanAbuse` overrides). */
export const SCAN_ABUSE_DEFAULTS = { perUserMinute: 6, perUserDay: 60, perDeviceHour: 20, perIpHour: 60, accountDailyAlert: 40 };

/** True when a unique-index clash came from the one-model-call-at-a-time rule, not from the scanId. */
const isInflightClash = (e: unknown): boolean => (e as { code?: number }).code === 11000 && Boolean((e as { keyPattern?: Record<string, unknown> }).keyPattern?.inflightKey);

/** POST /scans and GET /scans/{scanId} (M4-T3, S-01). */
@Injectable()
export class ScansService implements OnModuleInit {
  private readonly logger = new Logger('ScanAbuse');

  constructor(
    @InjectModel('Scan') private readonly scans: Model<ScanDoc>,
    @InjectModel('AbuseEvent') private readonly abuse: Model<AbuseEventDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    private readonly limiter: RateLimiter,
    private readonly users: UsersService,
    private readonly appConfig: AppConfigService,
    private readonly queue: ScanQueue,
    private readonly meals: MealsService,
    private readonly days: DaysService,
    private readonly storage: StorageService,
    private readonly foodScan: FoodScanService,
    private readonly content: ContentService,
    private readonly records: FoodRecordsService,
  ) {}

  onModuleInit(): void {
    this.meals.setPhotoSource({
      photoFor: async (userId, scanId) => {
        const s = await this.scans.findOne({ _id: scanId, userId }, { imageKey: 1, 'result.crop': 1 }).lean<Pick<ScanDoc, 'imageKey' | 'result'>>();
        return s ? { key: s.imageKey, thumbKey: null, crop: s.result?.crop ?? null } : null;
      },
      itemsFor: async (userId, scanId) => {
        const s = await this.scans.findOne({ _id: scanId, userId }, { result: 1 }).lean<Pick<ScanDoc, 'result'>>();
        return s?.result?.items ?? null;
      },
    });
    this.days.setPendingScanSource({
      hasPendingScan: async (userId, since) =>
        Boolean(await this.scans.exists({ userId, status: { $in: ['queued', 'processing'] }, queuedAt: { $gte: since } })),
    });
  }

  /** Returns [scan, created]. `created` is false for retries of the same scanId and deduped photos. */
  /** Per-device and per-IP limits independent of the account (S-03); every hit is logged. */
  private async abuseChecks(userId: Types.ObjectId, ctx: { ip?: string; deviceId?: string }, now: Date): Promise<void> {
    const l = { ...SCAN_ABUSE_DEFAULTS, ...(await this.appConfig.get<Partial<typeof SCAN_ABUSE_DEFAULTS>>('limits.scanAbuse', {})) };
    const uid = userId.toString();
    const rules = [
      { key: `scan:user:min:${uid}`, limit: l.perUserMinute, windowSec: 60 },
      { key: `scan:user:day:${uid}`, limit: l.perUserDay, windowSec: 86_400 },
      ...(ctx.deviceId ? [{ key: `scan:device:${ctx.deviceId}`, limit: l.perDeviceHour, windowSec: 3600 }] : []),
      ...(ctx.ip ? [{ key: `scan:ip:${ctx.ip}`, limit: l.perIpHour, windowSec: 3600 }] : []),
    ];
    try {
      await this.limiter.consume(...rules);
    } catch (e) {
      await this.flag('scan_rate_limit', userId, ctx, { perDeviceHour: l.perDeviceHour, perIpHour: l.perIpHour });
      throw e;
    }
    const today = await this.scans.countDocuments({ userId, queuedAt: { $gte: new Date(now.getTime() - 86_400_000) } });
    if (today + 1 === l.accountDailyAlert) await this.flag('scan_volume_account', userId, ctx, { scans24h: today + 1 });
  }

  private async flag(kind: string, userId: Types.ObjectId, ctx: { ip?: string; deviceId?: string }, details: Record<string, unknown>): Promise<void> {
    this.logger.warn({ kind, userId: userId.toString(), deviceId: ctx.deviceId, ip: ctx.ip, ...details }, 'scan anomaly');
    await this.abuse.create({ kind, userId, deviceId: ctx.deviceId ?? null, ip: ctx.ip ?? null, details });
  }

  async create(userId: string, req: CreateScanRequest, integrityOk: boolean, timezone: string, now = clock.now(), ctx: { ip?: string; deviceId?: string } = {}): Promise<[Scan, boolean]> {
    const existing = await this.scans.findById(req.scanId).lean<ScanDoc>();
    if (existing) {
      if (!existing.userId.equals(userId)) throw ApiError.conflict(ERROR_CODES.SCAN_CONFLICT, 'scanId already used');
      return [this.toScan(existing), false];
    }
    const user = await this.users.requireActive(userId);
    const uid = user._id;
    // Before the image is decoded: repeats of a cached photo never reach the limits further down.
    await this.limiter.consume({ key: `scan:post:${userId}`, limit: POSTS_PER_MINUTE, windowSec: 60 });
    if (!ownsKey(userId, 'meal_photo', req.imageKey) || !(await this.storage.exists(req.imageKey))) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Upload the photo with POST /uploads/presign first', HttpStatus.BAD_REQUEST, { field: 'imageKey' });
    }
    const isPlus = isPlusActive(user.entitlement, now);
    const verified = isVerifiedAccount(user);
    if (!verified || !integrityOk) this.refuse(canStartScan({ verified, integrityOk, isPlus, freeRemaining: 1, plusScansToday: 0, plusDailyLimit: 1 }));

    await this.checkImage(req);
    const cacheKey = await this.cacheKeyFor(uid, req.imageHash, req.mode ?? 'meal');

    // Same inputs within 24 h: return the stored outcome, no model call, no charge (section 4).
    const prior = await this.scans
      .findOne({ userId: uid, cacheKey, status: { $in: ['succeeded', 'rejected'] }, deduped: false, finishedAt: { $gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) } })
      .lean<ScanDoc>();
    if (prior) {
      const doc = await this.insert(uid, req, timezone, now, {
        status: prior.status,
        cacheKey,
        result: prior.result,
        error: prior.error,
        deduped: true,
        dedupedFrom: prior._id,
        finishedAt: now,
        latencyMs: 0,
      });
      return [this.toScan(doc), false];
    }

    // The same photo is already with the model (double tap, retry after a timeout): wait for that result.
    const running = await this.scans.findOne({ userId: uid, inflightKey: cacheKey }, { _id: 1 }).lean<Pick<ScanDoc, '_id'>>();
    if (running) return [this.toScan(await this.insertFollower(uid, req, timezone, now, cacheKey, running._id)), false];

    // Kill switch, open breaker or daily cap: refuse here, not at upload, so "Save photo" still works (B21).
    await this.foodScan.assertAvailable();

    const ledgerUsed = await this.users.ledgerUsed(user.email);
    const plusDailyLimit = await this.appConfig.get<number>('limits.plus.scansPerDay', AI_LIMITS.plus.scansPerDay);
    const plusScansToday = isPlus
      ? await this.scans.countDocuments({ userId: uid, deduped: false, status: { $in: ['queued', 'processing', 'succeeded'] }, queuedAt: { $gte: new Date(now.getTime() - 86_400_000) } })
      : 0;
    const inFlight = isPlus ? 0 : await this.scans.countDocuments({ userId: uid, deduped: false, status: { $in: ['queued', 'processing'] } });
    const freeRemaining = freeScansRemaining({ allowance: user.freeScans.allowance, used: user.freeScans.used, ledgerUsed }) - inFlight;
    const decision = canStartScan({ verified, integrityOk, isPlus, freeRemaining, plusScansToday, plusDailyLimit });
    if (!decision.allowed) this.refuse(decision);

    await this.abuseChecks(uid, ctx, now);
    let doc: ScanDoc;
    try {
      doc = await this.insert(uid, req, timezone, now, { status: 'queued', cacheKey, inflightKey: cacheKey });
    } catch (e) {
      if (!isInflightClash(e)) throw e;
      // Lost the race to an identical request in the same instant.
      const leader = await this.scans.findOne({ userId: uid, inflightKey: cacheKey }, { _id: 1 }).lean<Pick<ScanDoc, '_id'>>();
      if (!leader) throw e;
      return [this.toScan(await this.insertFollower(uid, req, timezone, now, cacheKey, leader._id)), false];
    }
    await this.queue.enqueue(doc._id);
    return [this.toScan(doc), true];
  }

  /** The file itself decides: size before reading it, then real type, dimensions, a full decode and the hash. */
  private async checkImage(req: CreateScanRequest): Promise<void> {
    const refuse = (reason: string): never => {
      throw new ApiError(ERROR_CODES.IMAGE_INVALID, 'That photo could not be used', HttpStatus.BAD_REQUEST, { reason });
    };
    const maxBytes = UPLOAD_KINDS.meal_photo.maxBytes;
    const size = await this.storage.size(req.imageKey);
    if (size !== null && size > maxBytes) refuse('too_large');
    const bytes = await this.storage.get(req.imageKey);
    if (!bytes) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Upload the photo with POST /uploads/presign first', HttpStatus.BAD_REQUEST, { field: 'imageKey' });
    try {
      await validateScanImage(bytes, { maxBytes });
    } catch (e) {
      if (e instanceof ScanImageError) refuse(e.reason);
      throw e;
    }
    // The cache trusts this hash, so a client must not be able to choose it.
    if (sha256Hex(bytes) !== req.imageHash) refuse('hash_mismatch');
  }

  private async cacheKeyFor(userId: Types.ObjectId, imageHash: string, mode: ScanMode): Promise<string> {
    const [prompt, profile] = await Promise.all([
      this.content.activePrompt(scanPromptKey(mode)),
      this.profiles.findOne({ userId }, { dietPattern: 1 }).lean<Pick<ProfileDoc, 'dietPattern'>>(),
    ]);
    return this.foodScan.cacheKey({ imageHash, locale: requestLocale(), dietPattern: profile?.dietPattern ?? '', promptKey: prompt?.key ?? scanPromptKey(mode), promptVersion: prompt?.version ?? 0 });
  }

  /** Rides on a running scan: no model call and no charge. Resolved when polled (`settleFollower`). */
  private insertFollower(userId: Types.ObjectId, req: CreateScanRequest, timezone: string, now: Date, cacheKey: string, leaderId: string): Promise<ScanDoc> {
    return this.insert(userId, req, timezone, now, { status: 'queued', cacheKey, deduped: true, dedupedFrom: leaderId });
  }

  private refuse(d: ReturnType<typeof canStartScan>): never {
    if (d.allowed) throw new Error('unreachable');
    const messages: Record<string, string> = {
      EMAIL_NOT_VERIFIED: 'Verify your email to scan meals',
      INTEGRITY_REQUIRED: 'This device could not be verified',
      SCAN_LIMIT_REACHED: 'Your free scan is used. Upgrade to keep scanning.',
    };
    throw new ApiError(d.code, messages[d.code] ?? d.code, DECISION_STATUS[d.code] ?? HttpStatus.FORBIDDEN, d.details);
  }

  private async insert(userId: Types.ObjectId, req: CreateScanRequest, timezone: string, now: Date, fields: Partial<ScanDoc>): Promise<ScanDoc> {
    try {
      const doc = await this.scans.create({
        _id: req.scanId,
        userId,
        imageKey: req.imageKey,
        imageHash: req.imageHash,
        mode: req.mode ?? 'meal',
        barcode: req.mode === 'label' ? (req.barcode ?? null) : null,
        category: req.category ?? null,
        timezone,
        locale: requestLocale(),
        queuedAt: now,
        ...fields,
      });
      return doc.toObject() as ScanDoc;
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && !isInflightClash(e)) {
        const raced = await this.scans.findById(req.scanId).lean<ScanDoc>();
        if (raced && raced.userId.equals(userId)) return raced;
        throw ApiError.conflict(ERROR_CODES.SCAN_CONFLICT, 'scanId already used');
      }
      throw e;
    }
  }

  async get(userId: string, scanId: string): Promise<Scan> {
    const doc = await this.scans.findOne({ _id: scanId, userId: new Types.ObjectId(userId) }).lean<ScanDoc>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.SCAN_NOT_FOUND, 'Scan not found');
    return this.toScan(doc.dedupedFrom && doc.status === 'queued' ? await this.settleFollower(doc) : doc);
  }

  /** Copies a finished leader's outcome onto a scan that was waiting for it. */
  private async settleFollower(doc: ScanDoc): Promise<ScanDoc> {
    const leader = await this.scans.findById(doc.dedupedFrom).lean<ScanDoc>();
    if (!leader || leader.status === 'queued' || leader.status === 'processing') return doc;
    const settled = await this.scans
      .findOneAndUpdate(
        { _id: doc._id, status: 'queued' },
        { $set: { status: leader.status, result: leader.result, error: leader.error, finishedAt: leader.finishedAt ?? clock.now(), latencyMs: 0 } },
        { returnDocument: 'after' },
      )
      .lean<ScanDoc>();
    return settled ?? doc;
  }

  /** Portion and name corrections from the stored basis: no model call, nothing saved. */
  async recalculate(userId: string, scanId: string, req: RecalculateScanRequest): Promise<RecalculatedScan> {
    await this.limiter.consume({ key: `scan:recalc:${userId}`, limit: RECALCULATE_PER_MINUTE, windowSec: 60 });
    const doc = await this.scans.findOne({ _id: scanId, userId: new Types.ObjectId(userId) }, { result: 1, status: 1 }).lean<Pick<ScanDoc, 'result' | 'status'>>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.SCAN_NOT_FOUND, 'Scan not found');
    if (doc.status !== 'succeeded' || !doc.result) throw ApiError.conflict(ERROR_CODES.SCAN_CONFLICT, 'This scan has no result to adjust');
    const stored = new Map(doc.result.items.map((i) => [i.id, i]));
    const corrections = new Map((req.items ?? []).map((c) => [c.id, c]));
    for (const id of corrections.keys()) {
      if (!stored.has(id)) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Unknown item ${id}`, HttpStatus.BAD_REQUEST, { field: 'items' });
    }
    const staleItems: string[] = [];
    const items: AnalysedItem[] = doc.result.items.map((base) => {
      const correction = corrections.get(base.id);
      if (!correction) return { ...base, processing: base.processing ?? null };
      const { item, stale } = applyItemCorrection(base, correction, this.records.index);
      if (stale) staleItems.push(item.id);
      return item;
    });
    items.push(...(req.addedItems ?? []).map((a, i) => addedItem(a, i)));
    const portionMultiplier = req.portionMultiplier ?? 1;
    return { portionMultiplier, items, totals: computeMealTotals(items, portionMultiplier), staleItems };
  }

  toScan(d: ScanDoc): Scan {
    return {
      scanId: d._id,
      status: d.status,
      mode: d.mode ?? 'meal',
      barcode: d.barcode ?? null,
      category: d.category ?? null,
      // Scans stored before `processing` existed have none: unknown.
      result: d.result ? { ...d.result, items: d.result.items.map((i) => ({ ...i, processing: i.processing ?? null })) } : null,
      error: d.error ? { code: d.error.code, message: d.error.message } : null,
      deduped: Boolean(d.deduped),
      chargedFreeScan: Boolean(d.chargedFreeScan),
      queuedAt: new Date(d.queuedAt).toISOString(),
      finishedAt: d.finishedAt ? new Date(d.finishedAt).toISOString() : null,
    };
  }
}
