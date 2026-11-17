/**
 * Energy and macro targets (BR-04, BR-05, BR-06), nutrition assessment v2 (decision 0017):
 * two-part activity, goal pace with limits, a sex-specific floor, protein on a reference weight
 * and personal water. All values are pending dietitian review (OQ-03).
 */
import {
  DAY_ACTIVITIES,
  EXERCISE_FREQUENCIES,
  GOAL_PACES,
  KCAL_PER_KG_BODY_WEIGHT,
  WATER_DEFAULT_TARGET_ML,
  WATER_STEP_ML,
  type ActivityLevel,
  type DayActivity,
  type ExerciseFrequency,
  type GoalPace,
  type MacroTargets,
  type PaceLimit,
  type PlanPace,
  type PlanPreview,
  type PlanSource,
  type ProfileMode,
} from '../../shared';

export type { ActivityLevel };

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────

/** v1 activity factors, still used for a q10 answer when q39 and q40 are not both answered. */
export const ACTIVITY_FACTORS: Readonly<Record<ActivityLevel, number>> = {
  seated: 1.2,
  light: 1.375,
  active: 1.55,
  intense: 1.725, // q10 'intense' (OQ-27)
};

/** q39: what the usual day adds to resting energy, workouts left out (decision 0017 §2). */
export const DAY_ACTIVITY_BASE: Readonly<Record<DayActivity, number>> = { seated: 1.2, standing: 1.35, moving: 1.5, physical: 1.7 };
/** q40: what exercise adds on top of the usual day, about 0.05 per weekly session. */
export const EXERCISE_ADD: Readonly<Record<ExerciseFrequency, number>> = { none: 0, one_two: 0.075, three_four: 0.15, five_plus: 0.25 };
export const ACTIVITY_FACTOR_MAX = 1.9;

/** Q10 option id → calculator activity level. 'unsure' gives no level (never guessed). */
const ACTIVITY_OPTION_MAP: Readonly<Record<string, ActivityLevel>> = {
  seated: 'seated',
  light: 'light',
  active: 'active',
  intense: 'intense',
};

export function mapActivityOption(id: string | null | undefined): ActivityLevel | null {
  if (!id || !Object.hasOwn(ACTIVITY_OPTION_MAP, id)) return null;
  return ACTIVITY_OPTION_MAP[id] ?? null;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
export const asDayActivity = (v: unknown): DayActivity | null => oneOf(DAY_ACTIVITIES, v);
export const asExerciseFrequency = (v: unknown): ExerciseFrequency | null => oneOf(EXERCISE_FREQUENCIES, v);
export const asGoalPace = (v: unknown): GoalPace | null => oneOf(GOAL_PACES, v);

export interface ActivityAnswers {
  dayActivity?: string | null;
  exerciseFrequency?: string | null;
  activityLevel?: string | null;
}

/** q39 and q40 when both are answered with known options; null otherwise (then q10 is used). */
export function twoPartActivity(i: ActivityAnswers): { dayActivity: DayActivity; exerciseFrequency: ExerciseFrequency } | null {
  const dayActivity = asDayActivity(i.dayActivity);
  const exerciseFrequency = asExerciseFrequency(i.exerciseFrequency);
  return dayActivity && exerciseFrequency ? { dayActivity, exerciseFrequency } : null;
}

/**
 * The activity factor: `min(1.9, base(q39) + add(q40))` to 3 decimals when both are answered (they win),
 * else the v1 factor of the q10 level, else null (activity is missing: never guessed).
 */
export function activityFactorOf(i: ActivityAnswers): number | null {
  const two = twoPartActivity(i);
  if (two) return Math.round(Math.min(ACTIVITY_FACTOR_MAX, DAY_ACTIVITY_BASE[two.dayActivity] + EXERCISE_ADD[two.exerciseFrequency]) * 1000) / 1000;
  const level = mapActivityOption(i.activityLevel);
  return level ? ACTIVITY_FACTORS[level] : null;
}

/** The four-value level other features read, from a two-part factor. */
export function activityBandOf(factor: number): ActivityLevel {
  if (factor < 1.29) return 'seated';
  if (factor < 1.46) return 'light';
  if (factor < 1.64) return 'active';
  return 'intense';
}

/** The level a profile carries: derived from q39 + q40 when both are answered, else the q10 answer. */
export function activityLevelOf(i: ActivityAnswers): ActivityLevel | null {
  const two = twoPartActivity(i);
  return two ? activityBandOf(activityFactorOf(two) as number) : mapActivityOption(i.activityLevel);
}

// ── Goal size (pace) ─────────────────────────────────────────────────────────────────────────────

/** v1 goal adjustment in percent, and the size of a goal when q41 is not answered (`gradual`). */
export const GOAL_ADJUSTMENT_PCT: Readonly<Record<string, number>> = { lose: -10, gain: 10, maintain: 0 };

/** Percent of maintenance per pace (decision 0017 §3). Every goal other than lose/gain keeps maintenance. */
export const PACE_ADJUSTMENT_PCT: Readonly<Record<'lose' | 'gain', Readonly<Record<PlanPace, number>>>> = {
  lose: { gentle: -10, steady: -15, faster: -20, gradual: -10 },
  gain: { gentle: 5, steady: 10, faster: 15, gradual: 10 },
};

/** Loss goal with a BMI under this: gentle at most (lean people lose proportionally more muscle). */
export const LOW_BMI_PACE_LIMIT = 20;
/** Loss goal from this age: steady at most (protects muscle and bone). */
export const STEADY_PACE_FROM_AGE = 65;
export const MAX_DAILY_DEFICIT_KCAL = 1000;
export const MAX_DAILY_SURPLUS_KCAL = 500;

/** The lowest floor anybody gets, whatever the BMR and the sex input (BR-04, as in v1). */
export const ENERGY_FLOOR_KCAL = 1200;
/** Floor by sex input (female 1,200, male 1,500). The male figure applies only up to maintenance: see {@link energyFloor}. */
export const SEX_FLOOR_KCAL: Readonly<Record<'female' | 'male', number>> = { female: 1200, male: 1500 };

// ── Macros and water ─────────────────────────────────────────────────────────────────────────────

/** g per kg of reference weight for a lose or gain goal (BR-05), and the v1 figure for every goal. */
export const PROTEIN_G_PER_KG = 1.6;
/** g per kg of reference weight for every other goal. */
export const PROTEIN_G_PER_KG_OTHER = 1.4;
/** Added when exercise is 3 or more sessions a week. */
export const PROTEIN_TRAINING_BONUS = 0.2;
/** Above this BMI protein is counted on the weight at this BMI: needs follow lean mass, not fat mass. */
export const PROTEIN_REFERENCE_BMI = 25;
export const PROTEIN_MIN_SHARE = 0.15; // BR-05
export const PROTEIN_MAX_SHARE = 0.3; // BR-05
export const FAT_SHARE = 0.27; // BR-05

export const WATER_ML_PER_KG = 30;
export const WATER_MIN_ML = 1500;
export const WATER_MAX_ML = 3500;

/** Upper bound of user adjustment above maintenance (OQ-37). */
export const ADJUST_MAX_OVER_TDEE = 0.2;
export const ADULT_AGE = 18;
/** Below this BMI a weight-loss goal cannot be set: the person picks another goal instead. */
export const UNDERWEIGHT_BMI = 18.5;

/** Stated life stages that get a habits goal instead of calorie, weight or time figures (q38). */
export const NO_TARGET_LIFE_STAGES: readonly string[] = ['pregnant', 'breastfeeding'];

/** Reasons no calorie, weight or time figures are set. The person keeps a habits goal or picks another goal; nothing here is a diagnosis. */
export const SAFETY_REASONS = ['pregnant_or_breastfeeding', 'underweight_loss_goal'] as const;
export const isSafetyReason = (r: string): boolean => (SAFETY_REASONS as readonly string[]).includes(r);

export function bmiOf(weightKg: number, heightCm: number): number {
  const m = heightCm / 100;
  return weightKg / (m * m);
}

const KCAL_PER_G_PROTEIN = 4;
const KCAL_PER_G_CARBS = 4;
const KCAL_PER_G_FAT = 9;

export interface PlanInputs {
  ageYears: number | null;
  calculationSex: 'female' | 'male' | null;
  heightCm: number | null;
  weightKg: number | null;
  /** q10 (v1). Used only when q39 and q40 are not both answered. */
  activityLevel: ActivityLevel | null;
  /** q39 and q40 (decision 0017): together they replace q10. */
  dayActivity?: string | null;
  exerciseFrequency?: string | null;
  /** q41: gentle | steady | faster; null or absent = not answered (`gradual`). */
  goalPace?: string | null;
  goal: string | null;
  targetWeightKg?: number | null;
  /** q38: none | pregnant | breastfeeding | declined; null = not asked yet. Only read when the sex input is female. */
  lifeStage?: string | null;
  /** The person's own water target. Absent = 30 ml per kg for a calorie plan, the default otherwise. */
  waterMl?: number;
}

export interface EligibilityResult {
  adult: boolean;
  estimateAllowed: boolean;
  reasons: string[];
  mode: ProfileMode;
}

/**
 * BR-04 eligibility. Unknown age or under 18 → habits-only mode (plan 8.8 rule 3). Adults need
 * sex input, height, weight and activity (q39 + q40, or an older q10 answer), plus the life stage
 * when the sex input is female.
 */
export function assessEligibility(i: PlanInputs): EligibilityResult {
  if (i.ageYears === null || !Number.isFinite(i.ageYears)) {
    return { adult: false, estimateAllowed: false, reasons: ['age_unknown'], mode: 'habits_only' };
  }
  if (i.ageYears < ADULT_AGE) {
    return { adult: false, estimateAllowed: false, reasons: ['under_18'], mode: 'habits_only' };
  }
  const reasons: string[] = [];
  if (!i.calculationSex) reasons.push('sex_input_missing');
  // Only asked when it can apply. A question never asked is not read as "no"; a declined one is the person's choice.
  if (i.calculationSex === 'female') {
    if (!i.lifeStage) reasons.push('life_stage_missing');
    else if (NO_TARGET_LIFE_STAGES.includes(i.lifeStage)) reasons.push('pregnant_or_breastfeeding');
  }
  if (!isPositive(i.heightCm)) reasons.push('height_missing');
  if (!isPositive(i.weightKg)) reasons.push('weight_missing');
  if (activityFactorOf(i) === null) reasons.push('activity_missing');
  // A person who is already underweight is not given a weight-loss plan: they choose another goal (plan-assessment).
  if (i.goal === 'lose' && isPositive(i.heightCm) && isPositive(i.weightKg) && bmiOf(i.weightKg, i.heightCm) < UNDERWEIGHT_BMI) {
    reasons.push('underweight_loss_goal');
  }
  return { adult: true, estimateAllowed: reasons.length === 0, reasons, mode: 'full' };
}

function isPositive(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Mifflin–St Jeor BMR (unrounded). */
export function mifflinStJeor(sex: 'female' | 'male', weightKg: number, heightCm: number, ageYears: number): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === 'male' ? base + 5 : base - 161;
}

/** v1 adjustment: the size of a goal whose pace was not chosen. */
export function goalAdjustmentPct(goal: string | null): number {
  return (goal && GOAL_ADJUSTMENT_PCT[goal]) || 0;
}

export interface ResolvedPace {
  /** null for every goal other than lose and gain. */
  pace: PlanPace | null;
  limitedBy: PaceLimit | null;
  /** Percent of maintenance the pace asks for, before the daily caps ({@link paceTarget}) and the floor. */
  pct: number;
}

/**
 * The pace a plan uses (decision 0017 §3), with limits 1 and 2 applied in order: a loss goal with a BMI
 * under 20 gets gentle at most, a loss goal at 65 or over gets steady at most. An unanswered pace is
 * `gradual` (10% either way, the v1 size) and is never limited: it is already at or below both limits.
 */
export function resolvePace(i: { goal: string | null; goalPace?: string | null; ageYears: number; bmi: number }): ResolvedPace {
  if (i.goal !== 'lose' && i.goal !== 'gain') return { pace: null, limitedBy: null, pct: 0 };
  let pace: PlanPace = asGoalPace(i.goalPace) ?? 'gradual';
  let limitedBy: PaceLimit | null = null;
  if (i.goal === 'lose') {
    if (i.bmi < LOW_BMI_PACE_LIMIT && (pace === 'steady' || pace === 'faster')) {
      pace = 'gentle';
      limitedBy = 'low_bmi';
    }
    if (i.ageYears >= STEADY_PACE_FROM_AGE && pace === 'faster') {
      pace = 'steady';
      limitedBy = 'age';
    }
  }
  return { pace, limitedBy, pct: PACE_ADJUSTMENT_PCT[i.goal][pace] };
}

/**
 * Limit 4, unrounded: `max(BMR, 1200, min(sex floor, TDEE))`. Never under BMR, never under 1,200 kcal (as in v1), and
 * for a male input never under 1,500 kcal unless maintenance itself is lower: then maintenance is the floor, so a
 * small, seated man is never told to eat above maintenance on a loss goal.
 */
export function energyFloor(sex: 'female' | 'male', bmrKcal: number, tdeeKcal: number): number {
  return Math.max(bmrKcal, ENERGY_FLOOR_KCAL, Math.min(SEX_FLOOR_KCAL[sex], tdeeKcal));
}

/**
 * The target a pace asks for, with limit 3 applied (never more than 1,000 kcal a day below maintenance or 500 kcal
 * above it), and the percent of maintenance that target really is: the pace percent, or the effective percent to one
 * decimal when a daily cap changed it.
 */
export function paceTarget(tdeeKcal: number, pacePct: number): { energyKcal: number; pct: number } {
  const asked = tdeeKcal * (1 + pacePct / 100);
  const capped = Math.min(tdeeKcal + MAX_DAILY_SURPLUS_KCAL, Math.max(tdeeKcal - MAX_DAILY_DEFICIT_KCAL, asked));
  if (capped === asked) return { energyKcal: asked, pct: pacePct };
  return { energyKcal: capped, pct: Math.round(((capped - tdeeKcal) / tdeeKcal) * 1000) / 10 };
}

/** Expected kg a week at a daily target: the gap to maintenance × 7 ÷ 7,700, two decimals; null without a gap in the goal's direction. */
export function weeklyChangeKg(goal: string | null, tdeeKcal: number, energyKcal: number): number | null {
  if (goal !== 'lose' && goal !== 'gain') return null;
  const gap = goal === 'lose' ? tdeeKcal - energyKcal : energyKcal - tdeeKcal;
  if (gap <= 0) return null;
  return Math.round(((gap * 7) / KCAL_PER_KG_BODY_WEIGHT) * 100) / 100;
}

/** Protein range in grams for an energy target: 15%–30% of energy (BR-05). */
export function proteinBounds(energyKcal: number): { min: number; max: number } {
  return {
    min: Math.ceil((PROTEIN_MIN_SHARE * energyKcal) / KCAL_PER_G_PROTEIN),
    max: Math.floor((PROTEIN_MAX_SHARE * energyKcal) / KCAL_PER_G_PROTEIN),
  };
}

/** The weight protein is counted on: the actual weight up to BMI 25, above that the weight at BMI 25 for the height. */
export function proteinReferenceWeightKg(weightKg: number, heightCm: number): number {
  if (bmiOf(weightKg, heightCm) <= PROTEIN_REFERENCE_BMI) return weightKg;
  const m = heightCm / 100;
  return PROTEIN_REFERENCE_BMI * m * m;
}

/** g per kg of reference weight: 1.6 for lose and gain, 1.4 otherwise; +0.2 with exercise 3 or more times a week. */
export function proteinPerKg(goal: string | null, exerciseFrequency?: string | null): number {
  const base = goal === 'lose' || goal === 'gain' ? PROTEIN_G_PER_KG : PROTEIN_G_PER_KG_OTHER;
  const trains = exerciseFrequency === 'three_four' || exerciseFrequency === 'five_plus';
  return Math.round((base + (trains ? PROTEIN_TRAINING_BONUS : 0)) * 10) / 10;
}

export interface ProteinRule {
  gPerKg: number;
  /** The weight the grams are counted on. */
  weightKg: number;
  /** True when that weight is the reference weight (BMI over 25), not the person's own. */
  reference: boolean;
}

/** The protein rule a preview was made with: v1 previews (stored drafts) keep 1.6 g per kg of actual weight. */
export function proteinRuleOf(preview: Pick<PlanPreview, 'method' | 'inputs' | 'goal'>): ProteinRule | null {
  const inp = preview.inputs;
  if (!inp) return null;
  if (preview.method !== 'mifflin_st_jeor_v2') return { gPerKg: PROTEIN_G_PER_KG, weightKg: inp.weightKg, reference: false };
  const ref = proteinReferenceWeightKg(inp.weightKg, inp.heightCm);
  return { gPerKg: proteinPerKg(preview.goal.type, inp.exerciseFrequency), weightKg: ref, reference: ref !== inp.weightKg };
}

/**
 * BR-05 macros: the wanted protein (rule × reference weight, or the user's own figure) kept within
 * 15–30% of energy, fat 27% of energy, carbohydrate the remainder. Integer grams.
 */
export function macrosForEnergy(energyKcal: number, wantedProteinG: number, proteinG?: number): MacroTargets {
  const energy = Math.round(energyKcal);
  const bounds = proteinBounds(energy);
  const wanted = proteinG ?? wantedProteinG;
  const protein = Math.min(bounds.max, Math.max(bounds.min, Math.round(wanted)));
  const fatKcal = FAT_SHARE * energy;
  const carbsKcal = Math.max(0, energy - protein * KCAL_PER_G_PROTEIN - fatKcal);
  return {
    energyKcal: energy,
    proteinG: protein,
    carbsG: Math.round(carbsKcal / KCAL_PER_G_CARBS),
    fatG: Math.round(fatKcal / KCAL_PER_G_FAT),
  };
}

/** 30 ml per kg, to the nearest 250 ml, kept between 1,500 and 3,500 ml (decision 0017 §5). */
export function personalWaterMl(weightKg: number): number {
  const stepped = Math.round((WATER_ML_PER_KG * weightKg) / WATER_STEP_ML) * WATER_STEP_ML;
  return Math.min(WATER_MAX_ML, Math.max(WATER_MIN_ML, stepped));
}

function goalFor(i: PlanInputs, mode: ProfileMode, pace: ResolvedPace | null): PlanPreview['goal'] {
  const type = i.goal ?? 'habits';
  return {
    type,
    startWeightKg: i.weightKg ?? null,
    // OQ-15: optional, display only, full mode only; never used in the calculation (BR-06).
    targetWeightKg: mode === 'full' ? (i.targetWeightKg ?? null) : null,
    pace: pace ? pace.pace : type === 'lose' || type === 'gain' ? (asGoalPace(i.goalPace) ?? 'gradual') : null,
    paceLimitedBy: pace?.limitedBy ?? null,
  };
}

/** Proposed targets (not saved). The user confirms or adjusts before anything is stored (BR-06). */
export function calculatePlan(i: PlanInputs): PlanPreview {
  const elig = assessEligibility(i);
  if (!elig.estimateAllowed) {
    const goal = goalFor(i, elig.mode, null);
    // Nothing weight-focused is shown to people who are not given a plan for safety reasons (BR-18) or are under 18.
    if (elig.mode === 'habits_only' || elig.reasons.some(isSafetyReason)) {
      goal.pace = null;
      if (elig.reasons.some(isSafetyReason)) {
        goal.startWeightKg = null;
        goal.targetWeightKg = null;
      }
    }
    return {
      eligible: false,
      mode: elig.mode,
      reasons: elig.reasons,
      method: null,
      inputs: null,
      bmrKcal: null,
      activityFactor: null,
      tdeeKcal: null,
      adjustmentPct: null,
      weeklyChangeKg: null,
      floorKcal: null,
      calculated: null,
      bounds: null,
      waterMl: i.waterMl ?? WATER_DEFAULT_TARGET_ML,
      goal,
    };
  }
  // estimateAllowed guarantees every input is present.
  const age = i.ageYears as number;
  const sex = i.calculationSex as 'female' | 'male';
  const height = i.heightCm as number;
  const weight = i.weightKg as number;
  const two = twoPartActivity(i);
  const factor = activityFactorOf(i) as number;
  const activity = two ? activityBandOf(factor) : (mapActivityOption(i.activityLevel) as ActivityLevel);

  const bmr = mifflinStJeor(sex, weight, height, age);
  const tdee = bmr * factor;
  const pace = resolvePace({ goal: i.goal, goalPace: i.goalPace, ageYears: age, bmi: bmiOf(weight, height) });
  // Limit 3 (daily caps), then limit 4 (the floor).
  const wanted = paceTarget(tdee, pace.pct);
  const floor = energyFloor(sex, bmr, tdee);
  const energy = Math.round(Math.max(floor, wanted.energyKcal));
  const floorKcal = Math.round(floor);
  const tdeeKcal = Math.round(tdee);
  const goal = goalFor(i, 'full', pace);
  const inputs = {
    ageYears: age,
    calculationSex: sex,
    heightCm: height,
    weightKg: weight,
    activityLevel: activity,
    dayActivity: two?.dayActivity ?? null,
    exerciseFrequency: two?.exerciseFrequency ?? null,
    activityFactor: factor,
  };
  const rule = proteinRuleOf({ method: 'mifflin_st_jeor_v2', inputs, goal }) as ProteinRule;

  return {
    eligible: true,
    mode: 'full',
    reasons: [],
    method: 'mifflin_st_jeor_v2',
    inputs,
    bmrKcal: Math.round(bmr),
    activityFactor: factor,
    tdeeKcal,
    adjustmentPct: wanted.pct,
    weeklyChangeKg: weeklyChangeKg(i.goal, tdeeKcal, energy),
    floorKcal,
    calculated: macrosForEnergy(energy, rule.gPerKg * rule.weightKg),
    bounds: {
      energyKcal: { min: floorKcal, max: Math.max(floorKcal, Math.round(tdee * (1 + ADJUST_MAX_OVER_TDEE))) },
      proteinG: proteinBounds(energy),
    },
    waterMl: i.waterMl ?? personalWaterMl(weight),
    goal,
  };
}

/** The maintenance numbers a stored plan was calculated from (see {@link energyBasisOf}). */
export interface EnergyBasis {
  bmrKcal: number;
  activityFactor: number;
  tdeeKcal: number;
}

const KNOWN_METHODS: readonly string[] = ['mifflin_st_jeor_v1', 'mifflin_st_jeor_v2'];

/**
 * BMR, activity factor and maintenance (TDEE) of a stored plan, recalculated from the inputs
 * kept with it exactly as {@link calculatePlan} made them. The energy target already holds the
 * activity allowance `tdeeKcal − bmrKcal` (BR-04): the app needs it so activity imported from
 * Apple Health or Health Connect is never counted twice. The factor is the one stored with the
 * inputs (v2); plans without one (v1) use the q10 table. Null when the plan has no calculated
 * inputs (habits only, legacy plans).
 */
export function energyBasisOf(inputs: Record<string, unknown> | null | undefined, method: string | null | undefined): EnergyBasis | null {
  if (!method || !KNOWN_METHODS.includes(method) || !inputs) return null;
  const { ageYears, calculationSex, heightCm, weightKg, activityLevel, activityFactor } = inputs;
  if (calculationSex !== 'female' && calculationSex !== 'male') return null;
  if (typeof ageYears !== 'number' || !Number.isFinite(ageYears)) return null;
  if (typeof heightCm !== 'number' || !isPositive(heightCm) || typeof weightKg !== 'number' || !isPositive(weightKg)) return null;
  const stored = typeof activityFactor === 'number' && Number.isFinite(activityFactor) && activityFactor >= 1 && activityFactor <= 2.5 ? activityFactor : null;
  const factor =
    stored ??
    activityFactorOf({
      dayActivity: typeof inputs.dayActivity === 'string' ? inputs.dayActivity : null,
      exerciseFrequency: typeof inputs.exerciseFrequency === 'string' ? inputs.exerciseFrequency : null,
      activityLevel: typeof activityLevel === 'string' ? activityLevel : null,
    });
  if (factor === null) return null;
  const bmr = mifflinStJeor(calculationSex, weightKg, heightCm, ageYears);
  return { bmrKcal: Math.round(bmr), activityFactor: factor, tdeeKcal: Math.round(bmr * factor) };
}

export type TargetValidation =
  | { ok: true; targets: MacroTargets | null }
  | {
      ok: false;
      code: 'PLAN_NOT_ELIGIBLE' | 'PLAN_OUT_OF_BOUNDS' | 'VALIDATION_FAILED';
      message: string;
      details: Record<string, unknown>;
    };

/**
 * Validate a confirm request against a preview. 'none' is always allowed (habits only);
 * every other source needs an eligible preview; adjustments stay within bounds and never
 * go below the floor (BR-06). Adjusted targets keep the protein rule the preview was made with.
 */
export function validateTargets(
  preview: PlanPreview,
  req: { source: PlanSource; energyKcal?: number; proteinG?: number },
): TargetValidation {
  if (req.source === 'none') return { ok: true, targets: null };
  const rule = proteinRuleOf(preview);
  if (!preview.eligible || !preview.calculated || !preview.bounds || !preview.inputs || !rule) {
    return {
      ok: false,
      code: 'PLAN_NOT_ELIGIBLE',
      message: 'Energy targets are not available for this profile',
      details: { reasons: preview.reasons },
    };
  }
  if (req.source === 'calculated') return { ok: true, targets: preview.calculated };

  if (req.energyKcal === undefined) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'energyKcal is required for adjusted and manual plans',
      details: { field: 'energyKcal' },
    };
  }
  const { min, max } = preview.bounds.energyKcal;
  if (req.energyKcal < min || req.energyKcal > max) {
    return {
      ok: false,
      code: 'PLAN_OUT_OF_BOUNDS',
      message: `Energy must be between ${min} and ${max} kcal`,
      details: { field: 'energyKcal', min, max },
    };
  }
  if (req.proteinG !== undefined) {
    const pb = proteinBounds(req.energyKcal);
    if (req.proteinG < pb.min || req.proteinG > pb.max) {
      return {
        ok: false,
        code: 'PLAN_OUT_OF_BOUNDS',
        message: `Protein must be between ${pb.min} and ${pb.max} g for ${req.energyKcal} kcal`,
        details: { field: 'proteinG', min: pb.min, max: pb.max },
      };
    }
  }
  return { ok: true, targets: macrosForEnergy(req.energyKcal, rule.gPerKg * rule.weightKg, req.proteinG) };
}
