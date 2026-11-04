import { requestLocale } from '../../common/http/request-context';
import { clock } from '../../common/clock';
import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.service';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AI_LIMITS, ERROR_CODES, type CreateScanRequest, type Scan } from '../../shared';
import { canStartScan, freeScansRemaining, isPlusActive, isVerifiedAccount } from '../../domain/entitlements';
import { ApiError } from '../../common/errors/api-error';
import { AppConfigService } from '../content/app-config.service';
import { DaysService } from '../tracking/days.service';
import { MealsService } from '../tracking/meals.service';
import { UsersService } from '../users/users.service';
import { ScanQueue } from './scan-queue';
import { StorageService } from '../../infra/storage/storage';
import { ownsKey } from '../uploads/uploads.module';
import { AiService } from '../ai/ai.service';
import type { AbuseEventDoc, ScanDoc } from './scans.schemas';

const DEDUPE_WINDOW_MS = 24 * 3600_000;
const DECISION_STATUS: Record<string, HttpStatus> = {
  EMAIL_NOT_VERIFIED: HttpStatus.FORBIDDEN,
  INTEGRITY_REQUIRED: HttpStatus.FORBIDDEN,
  SCAN_LIMIT_REACHED: HttpStatus.PAYMENT_REQUIRED,
};

/** M4-T7 defaults (app_config `limits.scanAbuse` overrides). */
export const SCAN_ABUSE_DEFAULTS = { perDeviceHour: 20, perIpHour: 60, accountDailyAlert: 40 };

/** POST /scans and GET /scans/{scanId} (M4-T3, S-01). */
@Injectable()
export class ScansService implements OnModuleInit {
  private readonly logger = new Logger('ScanAbuse');

  constructor(
    @InjectModel('Scan') private readonly scans: Model<ScanDoc>,
    @InjectModel('AbuseEvent') private readonly abuse: Model<AbuseEventDoc>,
    private readonly limiter: RateLimiter,
    private readonly users: UsersService,
    private readonly appConfig: AppConfigService,
    private readonly queue: ScanQueue,
    private readonly meals: MealsService,
    private readonly days: DaysService,
    private readonly storage: StorageService,
    private readonly ai: AiService,
  ) {}

  onModuleInit(): void {
    this.meals.setPhotoSource({
      photoFor: async (userId, scanId) => {
        const s = await this.scans.findOne({ _id: scanId, userId }, { imageKey: 1 }).lean<Pick<ScanDoc, 'imageKey'>>();
        return s ? { key: s.imageKey, thumbKey: null } : null;
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
    const l = await this.appConfig.get('limits.scanAbuse', SCAN_ABUSE_DEFAULTS);
    const rules = [
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
    if (!ownsKey(userId, 'meal_photo', req.imageKey) || !(await this.storage.exists(req.imageKey))) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Upload the photo with POST /uploads/presign first', HttpStatus.BAD_REQUEST, { field: 'imageKey' });
    }
    const isPlus = isPlusActive(user.entitlement, now);
    const verified = isVerifiedAccount(user);
    if (!verified || !integrityOk) this.refuse(canStartScan({ verified, integrityOk, isPlus, freeRemaining: 1, plusScansToday: 0, plusDailyLimit: 1 }));

    // Same photo within 24 h: return the stored result, no model call, no charge (section 4).
    const prior = await this.scans
      .findOne({ userId: uid, imageHash: req.imageHash, status: 'succeeded', deduped: false, finishedAt: { $gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) } })
      .lean<ScanDoc>();
    if (prior) {
      const doc = await this.insert(uid, req, timezone, now, {
        status: 'succeeded',
        result: prior.result,
        deduped: true,
        dedupedFrom: prior._id,
        finishedAt: now,
        latencyMs: 0,
      });
      return [this.toScan(doc), false];
    }

    // Kill switch, open breaker or budget stop: refuse here, not at upload, so "Save photo" still works (B21).
    await this.ai.assertAvailable('vision');

    const ledgerUsed = await this.users.ledgerUsed(user.email);
    const plusDailyLimit = await this.appConfig.get<number>('limits.plus.scansPerDay', AI_LIMITS.plus.scansPerDay);
    const plusScansToday = isPlus
      ? await this.scans.countDocuments({ userId: uid, deduped: false, status: { $in: ['queued', 'processing', 'succeeded'] }, queuedAt: { $gte: new Date(now.getTime() - 86_400_000) } })
      : 0;
    const inFlight = isPlus ? 0 : await this.scans.countDocuments({ userId: uid, status: { $in: ['queued', 'processing'] } });
    const freeRemaining = freeScansRemaining({ allowance: user.freeScans.allowance, used: user.freeScans.used, ledgerUsed }) - inFlight;
    const decision = canStartScan({ verified, integrityOk, isPlus, freeRemaining, plusScansToday, plusDailyLimit });
    if (!decision.allowed) this.refuse(decision);

    await this.abuseChecks(uid, ctx, now);
    const doc = await this.insert(uid, req, timezone, now, { status: 'queued' });
    await this.queue.enqueue(doc._id);
    return [this.toScan(doc), true];
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
        category: req.category ?? null,
        timezone,
        locale: requestLocale(),
        queuedAt: now,
        ...fields,
      });
      return doc.toObject() as ScanDoc;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
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
    return this.toScan(doc);
  }

  toScan(d: ScanDoc): Scan {
    return {
      scanId: d._id,
      status: d.status,
      category: d.category ?? null,
      result: d.result ?? null,
      error: d.error ? { code: d.error.code, message: d.error.message } : null,
      deduped: Boolean(d.deduped),
      chargedFreeScan: Boolean(d.chargedFreeScan),
      queuedAt: new Date(d.queuedAt).toISOString(),
      finishedAt: d.finishedAt ? new Date(d.finishedAt).toISOString() : null,
    };
  }
}
