import { clock } from '../../../common/clock';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import {
  ERROR_CODES,
  MEAL_CATEGORIES,
  WATER_DEFAULT_TARGET_ML,
  WATER_STEP_ML,
  type DayResponse,
  type MealCategory,
  type ProgressRange,
  type ProgressResponse,
  type WaterRequest,
} from '../../../shared';
import { addDays, dayKeyFor, isValidDayKey, resolveEntryDay } from '../../../domain/day-keys';
import { chooseNudge, localMinutes, type NudgeContent } from '../../../domain/nudges';
import { computeStreak } from '../../../domain/streaks';
import { ApiError } from '../../../common/errors/api-error';
import { ContentService } from '../../content/content.service';
import type { ProfileDoc } from '../../onboarding/schemas/onboarding.schema';
import { PlansService } from '../../plans/plans.service';
import { UsersService } from '../../users/users.service';
import { DailyLogsService } from './daily-logs.service';
import { MealsService } from './meals.service';
import type { DailyLogDoc, WeightLogDoc } from '../schemas/tracking.schema';

const STREAK_LOOKBACK_DAYS = 400;
const RANGE_DAYS: Record<ProgressRange, number> = { week: 7, month: 30, quarter: 90 };
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface PendingScanSource {
  hasPendingScan(userId: Types.ObjectId, since: Date): Promise<boolean>;
}

/** GET /days/{date}, water and GET /progress (M3-T2). */
@Injectable()
export class DaysService {
  private pendingScans: PendingScanSource | null = null;

  constructor(
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('WeightLog') private readonly weights: Model<WeightLogDoc>,
    private readonly users: UsersService,
    private readonly plans: PlansService,
    private readonly meals: MealsService,
    private readonly dailyLogs: DailyLogsService,
    private readonly content: ContentService,
  ) {}

  setPendingScanSource(source: PendingScanSource): void {
    this.pendingScans = source;
  }

  static assertDayKey(date: string): void {
    if (!isValidDayKey(date)) throw new ApiError(ERROR_CODES.INVALID_DAY_KEY, 'Expected a date as YYYY-MM-DD');
  }

  async day(userId: string, date: string, now = clock.now()): Promise<DayResponse> {
    DaysService.assertDayKey(date);
    const user = await this.users.requireActive(userId);
    const uid = user._id;
    const [plan, log, meals, profile, loggedDays] = await Promise.all([
      this.plans.active(userId),
      this.dailyLogs.get(uid, date),
      this.meals.forDay(uid, date),
      this.profiles.findOne({ userId: uid }).lean<ProfileDoc>(),
      this.dailyLogs.loggedDays(uid, addDays(date, -STREAK_LOOKBACK_DAYS), date),
    ]);
    const totals = log?.totals ?? { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
    const targets = {
      energyKcal: plan?.energyKcal ?? null,
      proteinG: plan?.proteinG ?? null,
      carbsG: plan?.carbsG ?? null,
      fatG: plan?.fatG ?? null,
      waterMl: plan?.waterMl ?? WATER_DEFAULT_TARGET_ML,
    };
    const waterMl = log?.waterMl ?? 0;
    const remain = (target: number | null, eaten: number) => (target === null ? null : r1(target - eaten));
    const mode = profile?.mode ?? 'habits_only';
    const categories = MEAL_CATEGORIES.map((category) => {
      const ms = meals.filter((m) => m.category === category);
      const sum = (k: 'kcal' | 'proteinG' | 'carbsG' | 'fatG') => ms.reduce((s, m) => s + (m.totals[k] ?? 0), 0);
      return { category, mealCount: ms.length, totals: { kcal: Math.round(sum('kcal')), proteinG: r1(sum('proteinG')), carbsG: r1(sum('carbsG')), fatG: r1(sum('fatG')) } };
    });
    const isToday = date === dayKeyFor(now, user.timezone);
    let nudge: DayResponse['nudge'] = null;
    const lines = (await this.content.miloLines())?.data as { nudges?: NudgeContent } | undefined;
    if (isToday && lines?.nudges) {
      const logged = Object.fromEntries(MEAL_CATEGORIES.map((c) => [c, meals.some((m) => m.category === c)])) as Record<MealCategory, boolean>;
      nudge = chooseNudge(lines.nudges, {
        localMinutes: localMinutes(now, user.timezone),
        logged,
        mode,
        overTarget: mode === 'full' && targets.energyKcal !== null && totals.kcal > targets.energyKcal,
        pendingScan: this.pendingScans ? await this.pendingScans.hasPendingScan(uid, new Date(now.getTime() - 86_400_000)) : false,
        savedPhoto: meals.some((m) => m.photo && m.items.length === 0),
      });
    }
    return {
      date,
      targets,
      totals,
      remaining: {
        kcal: remain(targets.energyKcal, totals.kcal),
        proteinG: remain(targets.proteinG, totals.proteinG),
        carbsG: remain(targets.carbsG, totals.carbsG),
        fatG: remain(targets.fatG, totals.fatG),
        waterMl: Math.max(0, targets.waterMl - waterMl),
      },
      meals: meals.map((m) => this.meals.toMeal(m)),
      categories,
      water: this.water(log, targets.waterMl),
      streak: computeStreak(loggedDays, date),
      nudge,
    };
  }

  private water(log: DailyLogDoc | null, targetMl: number): DayResponse['water'] {
    return {
      totalMl: log?.waterMl ?? 0,
      targetMl,
      stepMl: WATER_STEP_ML,
      entries: (log?.waterEntries ?? []).map((e) => ({ ml: e.ml, at: new Date(e.at).toISOString(), timezone: e.timezone })),
    };
  }

  async addWater(userId: string, date: string, req: WaterRequest, now = clock.now()): Promise<DayResponse['water']> {
    DaysService.assertDayKey(date);
    const user = await this.users.requireActive(userId);
    const at = req.at ? new Date(req.at) : now;
    const day = resolveEntryDay({ loggedAt: at, timeZone: req.timezone, date, now });
    const log = await this.dailyLogs.addWater(user._id, day.date, req.amountMl, at, day.timezone);
    const plan = await this.plans.active(userId);
    return this.water(log, plan?.waterMl ?? WATER_DEFAULT_TARGET_ML);
  }

  async progress(userId: string, range: ProgressRange, date: string | undefined, now = clock.now()): Promise<ProgressResponse> {
    const user = await this.users.requireActive(userId);
    const to = date ?? dayKeyFor(now, user.timezone);
    const from = addDays(to, -(RANGE_DAYS[range] - 1));
    const [logs, plan, weights, loggedDays] = await Promise.all([
      this.dailyLogs.range(user._id, from, to),
      this.plans.active(userId),
      this.weights.find({ userId: user._id }).sort({ date: 1, loggedAt: 1 }).lean<WeightLogDoc[]>(),
      this.dailyLogs.loggedDays(user._id, addDays(to, -STREAK_LOOKBACK_DAYS), to),
    ]);
    const byDate = new Map(logs.map((l) => [l.date, l]));
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const l = byDate.get(d);
      days.push({ date: d, kcal: l?.totals.kcal ?? 0, logged: Boolean(l?.logged), waterMl: l?.waterMl ?? 0 });
    }
    const logged = days.filter((d) => d.logged);
    const inRange = weights.filter((w) => w.date >= from && w.date <= to);
    return {
      range,
      from,
      to,
      days,
      targetKcal: plan?.energyKcal ?? null,
      averageKcal: logged.length ? Math.round(logged.reduce((s, d) => s + d.kcal, 0) / logged.length) : null,
      loggedDays: logged.length,
      weights: inRange.map((w) => ({ date: w.date, weightKg: w.weightKg, isEstimate: w.isEstimate })),
      goal: {
        startWeightKg: plan?.goal.startWeightKg ?? weights[0]?.weightKg ?? null,
        currentWeightKg: weights.at(-1)?.weightKg ?? null,
        targetWeightKg: plan?.goal.targetWeightKg ?? null,
      },
      streak: computeStreak(loggedDays, to),
    };
  }
}
