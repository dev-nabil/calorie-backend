/**
 * What Milo the coach knows about one person on one turn: the answers from goal setup, the active targets, today's diary and
 * the last seven days. Pure: the service loads the documents, this turns them into the JSON the prompt carries.
 *
 * Safety shapes it (plan 8.8 rules 3-4, safety-rules): a habits-only person (under 18, unknown age or no estimate) never
 * receives body measurements, calorie targets or a weight goal, so the model cannot repeat them. Unknown stays absent; it is
 * never filled with a guess (rule 8).
 */
import type { DayResponse, ProgressResponse } from '../../shared';
import { cmToFtIn, kgToLb, type UnitPreferences } from '../../shared/units';
import type { ProfileFields } from '../onboarding-engine';
import { calculatePlan } from '../plan-calculator';

export interface CoachContextInput {
  name: string | null;
  mode: 'full' | 'habits_only';
  units: UnitPreferences;
  profile: Partial<ProfileFields> | null;
  day: DayResponse;
  /** Last seven days (GET /progress?range=week); null when it could not be read. */
  week: ProgressResponse | null;
}

const round = (n: number, digits = 0): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
/** A nutrient the food data does not know stays null; it is never turned into zero. */
const known = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? round(n) : null);

/** Drops null, undefined, empty strings and empty arrays so the prompt only carries what is known. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function formatWeight(kg: number, units: UnitPreferences): string {
  return units.weight === 'lb' ? `${round(kgToLb(kg))} lb` : `${round(kg, 1)} kg`;
}

export function formatHeight(cm: number, units: UnitPreferences): string {
  if (units.height === 'ft_in') {
    const { ft, in: inches } = cmToFtIn(cm);
    return `${ft} ft ${inches} in`;
  }
  return `${round(cm)} cm`;
}

export function buildCoachContext(i: CoachContextInput): Record<string, unknown> {
  const p = i.profile ?? {};
  const t = i.day.targets;
  const habitsOnly = i.mode === 'habits_only' || t.energyKcal === null;

  // A weight goal is never repeated to a habits-only person (rule 4).
  const goalKind = habitsOnly && (p.primaryGoal === 'lose' || p.primaryGoal === 'gain') ? null : (p.primaryGoal ?? null);
  const goal = compact({
    main: goalKind,
    alsoWants: p.supportingGoals,
    inTheirWords: p.personalMotivation,
    timeframeWeeks: habitsOnly ? null : p.timeframeWeeks,
  });

  let body: Record<string, unknown> | null = null;
  let energy: Record<string, unknown> | null = null;
  if (!habitsOnly) {
    body = compact({
      ageYears: p.ageYears,
      sex: p.calculationSex,
      height: p.heightCm != null ? formatHeight(p.heightCm, i.units) : null,
      weight: p.weightKg != null ? formatWeight(p.weightKg, i.units) : null,
      weightIsEstimate: p.weightKg != null && p.weightIsEstimate ? true : null,
      targetWeight: p.targetWeightKg != null ? formatWeight(p.targetWeightKg, i.units) : null,
      activityLevel: p.activityLevel,
      lifeStage: p.lifeStage && p.lifeStage !== 'none' ? p.lifeStage : null,
    });
    // BMR, maintenance and the floor come from the same calculator that produced the plan.
    const calc = calculatePlan({
      ageYears: p.ageYears ?? null,
      calculationSex: p.calculationSex ?? null,
      heightCm: p.heightCm ?? null,
      weightKg: p.weightKg ?? null,
      activityLevel: p.activityLevel ?? null,
      goal: p.primaryGoal ?? null,
      targetWeightKg: p.targetWeightKg ?? null,
      lifeStage: p.lifeStage ?? null,
    });
    energy = compact({
      targetKcal: t.energyKcal,
      proteinG: t.proteinG,
      carbsG: t.carbsG,
      fatG: t.fatG,
      waterMl: t.waterMl,
      maintenanceKcal: calc.tdeeKcal,
      floorKcal: calc.floorKcal,
    });
  }

  const preferences = compact({
    dietPattern: p.dietPattern === 'other' ? (p.dietPatternOther ?? 'other') : p.dietPattern,
    // null = never asked: the model must not read it as "no allergies".
    allergies: p.allergies ? (p.allergies.includes('other') && p.allergyOther ? [...p.allergies.filter((a) => a !== 'other'), p.allergyOther] : p.allergies) : null,
    mealsPerDay: p.mealsPerDay,
    mealSource: p.mealSource,
    schedule: p.schedulePattern,
    higherIntakePattern: p.higherIntakePattern,
    routineBarriers: p.routineBarriers,
    eatingCues: p.eatingCues,
    movement: p.movementActions,
    trackingExperience: p.trackingExperience,
    nutritionFamiliarity: p.nutritionFamiliarity,
    startingMood: p.startingMood,
    habitPriorities: p.habitPriorities,
  });

  const left = t.energyKcal === null ? null : t.energyKcal - i.day.totals.kcal;
  const today = compact({
    date: i.day.date,
    meals: i.day.meals.map((m) => compact({ category: m.category, name: m.name, kcal: habitsOnly ? null : known(m.totals.kcal) })),
    totals: habitsOnly ? null : { kcal: round(i.day.totals.kcal), proteinG: round(i.day.totals.proteinG), carbsG: round(i.day.totals.carbsG), fatG: round(i.day.totals.fatG) },
    kcalLeft: left === null ? null : round(left),
    waterMl: i.day.water.totalMl,
    waterTargetMl: i.day.water.targetMl,
    streakDays: i.day.streak.current,
  });

  let week: Record<string, unknown> | null = null;
  if (i.week) {
    const w = i.week;
    const first = w.weights[0];
    const last = w.weights.at(-1);
    week = compact({
      loggedDays: w.loggedDays,
      daysInRange: w.days.length,
      averageKcal: habitsOnly ? null : w.averageKcal,
      kcalByDay: habitsOnly ? null : w.days.filter((d) => d.logged).map((d) => ({ date: d.date, kcal: round(d.kcal) })),
      weightChange:
        !habitsOnly && first && last && first.date !== last.date
          ? `${formatWeight(first.weightKg, i.units)} on ${first.date} to ${formatWeight(last.weightKg, i.units)} on ${last.date}`
          : null,
      currentWeight: !habitsOnly && w.goal.currentWeightKg != null ? formatWeight(w.goal.currentWeightKg, i.units) : null,
    });
  }

  return compact({
    name: i.name,
    mode: habitsOnly ? 'habits_only' : 'full',
    goal,
    about: body,
    dailyTargets: energy,
    preferences,
    today,
    last7Days: week,
  });
}
