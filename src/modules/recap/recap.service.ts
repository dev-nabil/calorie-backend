import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { AI_LIMITS, ERROR_CODES, WATER_DEFAULT_TARGET_ML, type RecapRange, type RecapStats, type WeeklyRecap } from '../../shared';
import { describeAllergies, describeDietPattern, effectiveMode } from '../../domain/copy-rules';
import { addDays, dayKeyFor } from '../../domain/day-keys';
import { isPlusActive } from '../../domain/entitlements';
import { avoidTermsFor } from '../../domain/plan-narrative';
import { computeStreak } from '../../domain/streaks';
import { buildRecapStats, recapWeek, type RecapMode, type RecapWeek } from '../../domain/weekly-recap';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { requestLocale } from '../../common/http/request-context';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { KvStore } from '../../infra/kv/kv-store';
import { AiJobRunner } from '../ai/ai-jobs';
import { AppConfigService } from '../content/app-config.service';
import type { ProfileDoc } from '../onboarding/schemas/onboarding.schema';
import type { PlanDoc } from '../plans/schemas/plans.schema';
import { PlansService } from '../plans/plans.service';
import type { MealDoc } from '../tracking/schemas/tracking.schema';
import { DailyLogsService } from '../tracking/services/daily-logs.service';
import type { UserDoc } from '../users/schemas/users.schema';
import { UsersService } from '../users/users.service';
import type { WeeklyRecapDoc } from './schemas/weekly-recap.schema';
import { WEEKLY_RECAP_JOB, WEEKLY_RECAP_TIMEOUT_MS, type WeeklyRecapJob, type WeeklyRecapJobResult } from './weekly-recap.handler';

/** Same look-back as Today's streak (DaysService). */
const STREAK_LOOKBACK_DAYS = 400;
/** A model answer is kept until its week is over (`last`) or its day is (`this`); the TTL index removes it afterwards. */
const KEEP_LAST_MS = 8 * 86_400_000;
const KEEP_THIS_MS = 2 * 86_400_000;
/** One model call per recap key at a time; a second request waits for the first one's answer. */
const LOCK_TTL_SEC = 60;
const WAIT_STEP_MS = 500;

interface RecapKey {
  userId: Types.ObjectId;
  range: RecapRange;
  weekStart: string;
  day: string;
  locale: string;
  mode: RecapMode;
}

const isDuplicateKey = (e: unknown): boolean => (e as { code?: number }).code === 11000;

/**
 * GET /recap/weekly (Plus). Stats come from the person's day logs every time; the story cards come from one model call
 * per user, range, week, language, mode and (for `this`) day, kept in `weekly_recaps`. Nothing logged, AI unavailable, the
 * daily cap or an unusable answer give the stats with no cards (`ai: false`), never an error.
 */
@Injectable()
export class RecapService {
  private readonly logger = new Logger('WeeklyRecap');

  constructor(
    @InjectModel('WeeklyRecap') private readonly recaps: Model<WeeklyRecapDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('Meal') private readonly meals: Model<MealDoc>,
    private readonly users: UsersService,
    private readonly plans: PlansService,
    private readonly dailyLogs: DailyLogsService,
    private readonly appConfig: AppConfigService,
    private readonly quota: DailyQuota,
    private readonly runner: AiJobRunner,
    private readonly kv: KvStore,
  ) {}

  async weekly(userId: string, range: RecapRange, now = clock.now()): Promise<WeeklyRecap> {
    const user = await this.users.requireActive(userId);
    if (!isPlusActive(user.entitlement, now)) throw new ApiError(ERROR_CODES.PLUS_REQUIRED, 'The weekly recap is part of Nouri Plus', 402);
    const today = dayKeyFor(now, user.timezone);
    const week = recapWeek(range, today);
    const [profile, plan] = await Promise.all([this.profiles.findOne({ userId: user._id }).lean<ProfileDoc>(), this.plans.active(userId)]);
    const mode = effectiveMode(profile?.mode, plan?.energyKcal);
    const locale = requestLocale();
    const key: RecapKey = { userId: user._id, range, weekStart: week.weekStart, day: range === 'this' ? today : '', locale, mode };

    const kept = await this.recaps.findOne(key).lean<WeeklyRecapDoc>();
    if (kept?.ai) return this.view(kept);

    const stats = await this.stats(user, week, mode, plan, today);
    const plain: WeeklyRecap = { range, weekStart: week.weekStart, weekEnd: week.weekEnd, mode, stats, cards: [], ai: false, generatedAt: now.toISOString() };
    // An unusable answer for this key was already paid for: the app shows its own cards instead of a second call.
    if (kept || stats.loggedDays === 0) return plain;

    const lock = `recap:lock:${[userId, range, week.weekStart, key.day, locale, mode].join(':')}`;
    if (!(await this.kv.setIfAbsent(lock, '1', LOCK_TTL_SEC))) return (await this.waitFor(key)) ?? plain;
    try {
      const limits = await this.appConfig.get<{ plus?: { recapPerDay?: number } }>('limits', AI_LIMITS);
      const perDay = limits.plus?.recapPerDay ?? AI_LIMITS.plus.recapPerDay;
      if ((await this.quota.used('recap', userId, user.timezone)) >= perDay) return plain;
      const job: WeeklyRecapJob = {
        range,
        mode,
        stats,
        locale,
        allergies: describeAllergies(profile?.allergies, profile?.allergyOther),
        dietPattern: describeDietPattern(profile?.dietPattern, profile?.dietPatternOther),
        avoidTerms: avoidTermsFor(profile?.allergies, profile?.allergyOther, profile?.dietPattern, locale),
      };
      let result: WeeklyRecapJobResult;
      try {
        result = await this.runner.run<WeeklyRecapJobResult>(WEEKLY_RECAP_JOB, job, WEEKLY_RECAP_TIMEOUT_MS + 5000);
      } catch (e) {
        // Kill switch, budget, open breaker, provider error or a worker timeout: the stats still answer.
        if (!(e instanceof ApiError)) throw e;
        this.logger.warn({ userId, range, code: e.code, reason: e.details?.reason }, 'weekly recap without cards: AI unavailable');
        return plain;
      }
      const ai = result.cards.length > 0;
      if (ai) await this.quota.consume('recap', userId, user.timezone); // successful answers only (OQ-38)
      const doc = {
        ...key,
        weekEnd: week.weekEnd,
        stats,
        cards: result.cards,
        ai,
        model: result.model,
        generatedAt: now,
        expiresAt: new Date(now.getTime() + (range === 'last' ? KEEP_LAST_MS : KEEP_THIS_MS)),
      };
      await this.recaps.updateOne(key, { $set: doc }, { upsert: true }).catch((e: unknown) => {
        if (!isDuplicateKey(e)) throw e; // a parallel writer won; its answer stands
      });
      return ai ? this.view(doc) : plain;
    } finally {
      await this.kv.del(lock);
    }
  }

  /** Waits for the request that holds the lock; null when it ends without an answer. */
  private async waitFor(key: RecapKey): Promise<WeeklyRecap | null> {
    const deadline = Date.now() + WEEKLY_RECAP_TIMEOUT_MS + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
      const doc = await this.recaps.findOne(key).lean<WeeklyRecapDoc>();
      if (doc) return doc.ai ? this.view(doc) : null;
    }
    return null;
  }

  private view(d: Pick<WeeklyRecapDoc, 'range' | 'weekStart' | 'weekEnd' | 'mode' | 'stats' | 'cards' | 'ai' | 'generatedAt'>): WeeklyRecap {
    return {
      range: d.range,
      weekStart: d.weekStart,
      weekEnd: d.weekEnd,
      mode: d.mode,
      stats: d.stats,
      cards: d.cards.map((c) => ({ id: c.id, title: c.title, text: c.text, miloState: c.miloState })),
      ai: d.ai,
      generatedAt: new Date(d.generatedAt).toISOString(),
    };
  }

  private async stats(user: UserDoc, week: RecapWeek, mode: RecapMode, plan: PlanDoc | null, today: string): Promise<RecapStats> {
    const uid = user._id;
    const [logs, meals, loggedDays] = await Promise.all([
      this.dailyLogs.range(uid, week.weekStart, week.weekEnd),
      this.meals
        .find({ userId: uid, date: { $gte: week.weekStart, $lte: week.weekEnd }, deletedAt: null }, { date: 1, 'items.name': 1, 'items.excluded': 1 })
        .sort({ date: 1, loggedAt: 1 })
        .lean<Pick<MealDoc, 'date' | 'items'>[]>(),
      this.dailyLogs.loggedDays(uid, addDays(today, -STREAK_LOOKBACK_DAYS), today),
    ]);
    return buildRecapStats({
      week,
      mode,
      logs: logs.map((l) => ({ date: l.date, logged: Boolean(l.logged), mealsCount: l.mealsCount ?? 0, kcal: l.totals?.kcal ?? 0, proteinG: l.totals?.proteinG ?? 0, waterMl: l.waterMl ?? 0 })),
      meals: meals.map((m) => ({ date: m.date, items: (m.items ?? []).map((i) => ({ name: i.name, excluded: i.excluded })) })),
      targets: { proteinG: plan?.proteinG ?? null, waterMl: plan?.waterMl ?? WATER_DEFAULT_TARGET_ML },
      streak: computeStreak(loggedDays, today).current,
    });
  }
}
