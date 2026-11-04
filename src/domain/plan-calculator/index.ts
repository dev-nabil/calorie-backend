/**
 * Energy and macro targets (BR-04, BR-05, BR-06). All values are pending dietitian review
 * (OQ-03) and ship behind a flag until signed off.
 */
import {
  WATER_DEFAULT_TARGET_ML,
  type ActivityLevel,
  type EligibilityAttestation,
  type MacroTargets,
  type PlanPreview,
  type PlanSource,
  type ProfileMode,
} from '../../shared';

export type { ActivityLevel };

/** BR-04 activity factors. */
export const ACTIVITY_FACTORS: Readonly<Record<ActivityLevel, number>> = {
  seated: 1.2,
  light: 1.375,
  active: 1.55,
  intense: 1.725, // q10 'intense' (OQ-27)
};

/** Q10 option id → calculator activity level. 'unsure' gives no level (no estimate, never guess). */
const ACTIVITY_OPTION_MAP: Readonly<Record<string, ActivityLevel>> = {
  seated: 'seated',
  light: 'light',
  active: 'active',
  intense: 'intense',
};

export function mapActivityOption(id: string | null | undefined): ActivityLevel | null {
  if (!id) return null;
  return ACTIVITY_OPTION_MAP[id] ?? null;
}

/** BR-04 goal adjustment in percent. Every goal other than lose/gain keeps maintenance. */
export const GOAL_ADJUSTMENT_PCT: Readonly<Record<string, number>> = { lose: -10, gain: 10, maintain: 0 };

export const ENERGY_FLOOR_KCAL = 1200; // BR-04
export const PROTEIN_G_PER_KG = 1.6; // BR-05
export const PROTEIN_MIN_SHARE = 0.15; // BR-05
export const PROTEIN_MAX_SHARE = 0.3; // BR-05
export const FAT_SHARE = 0.27; // BR-05
/** Upper bound of user adjustment above maintenance. OQ-21 proposal, not yet a product rule. */
export const ADJUST_MAX_OVER_TDEE = 0.2;
export const ADULT_AGE = 18;
/** Below this BMI a weight-loss goal is referred to a professional instead of getting a plan. */
export const UNDERWEIGHT_BMI = 18.5;

/** Reasons that mean a professional, not this app, should guide the person. No calorie, weight or time figures for them. */
export const SAFETY_REASONS = ['pregnant_or_breastfeeding', 'supervised_condition', 'eating_disorder_concern', 'underweight_loss_goal'] as const;
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
  activityLevel: ActivityLevel | null;
  goal: string | null;
  targetWeightKg?: number | null;
  attestation?: EligibilityAttestation | null;
  waterMl?: number;
}

export interface EligibilityResult {
  adult: boolean;
  estimateAllowed: boolean;
  reasons: string[];
  mode: ProfileMode;
}

/**
 * BR-04 eligibility. Unknown age or under 18 → habits-only mode (plan 8.8 rule 3). Adults
 * need sex input, height, weight, activity and the eligibility check (plan section 10).
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
  if (!isPositive(i.heightCm)) reasons.push('height_missing');
  if (!isPositive(i.weightKg)) reasons.push('weight_missing');
  if (!i.activityLevel) reasons.push('activity_missing');
  // A stored attestation from before the eating-disorder row existed counts as unanswered, never as "no".
  if (!i.attestation || typeof (i.attestation as { eatingDisorderConcern?: unknown }).eatingDisorderConcern !== 'boolean') reasons.push('eligibility_unconfirmed');
  else {
    if (i.attestation.pregnantOrBreastfeeding) reasons.push('pregnant_or_breastfeeding');
    if (i.attestation.supervisedNutritionCondition) reasons.push('supervised_condition');
    if (i.attestation.eatingDisorderConcern) reasons.push('eating_disorder_concern');
  }
  // A person who is already underweight is not given a weight-loss plan (a professional should look first).
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

export function goalAdjustmentPct(goal: string | null): number {
  return (goal && GOAL_ADJUSTMENT_PCT[goal]) || 0;
}

/** Protein range in grams for an energy target: 15%–30% of energy (BR-05). */
export function proteinBounds(energyKcal: number): { min: number; max: number } {
  return {
    min: Math.ceil((PROTEIN_MIN_SHARE * energyKcal) / KCAL_PER_G_PROTEIN),
    max: Math.floor((PROTEIN_MAX_SHARE * energyKcal) / KCAL_PER_G_PROTEIN),
  };
}

/**
 * BR-05 macros: protein 1.6 g/kg (or the user's protein) kept within 15–30% of energy,
 * fat 27% of energy, carbohydrate the remainder. Integer grams.
 */
export function macrosForEnergy(energyKcal: number, weightKg: number, proteinG?: number): MacroTargets {
  const energy = Math.round(energyKcal);
  const bounds = proteinBounds(energy);
  const wanted = proteinG ?? PROTEIN_G_PER_KG * weightKg;
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

function goalFor(i: PlanInputs, mode: ProfileMode): PlanPreview['goal'] {
  const type = i.goal ?? 'habits';
  return {
    type,
    startWeightKg: i.weightKg ?? null,
    // OQ-15: optional, display only, full mode only; never used in the calculation (BR-06).
    targetWeightKg: mode === 'full' ? (i.targetWeightKg ?? null) : null,
    pace: type === 'lose' || type === 'gain' ? 'gradual' : null,
  };
}

/** Proposed targets (not saved). The user confirms or adjusts before anything is stored (BR-06). */
export function calculatePlan(i: PlanInputs): PlanPreview {
  const elig = assessEligibility(i);
  const waterMl = i.waterMl ?? WATER_DEFAULT_TARGET_ML;
  const goal = goalFor(i, elig.mode);
  if (!elig.estimateAllowed) {
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
      floorKcal: null,
      calculated: null,
      bounds: null,
      waterMl,
      goal,
    };
  }
  // estimateAllowed guarantees every input is present.
  const age = i.ageYears as number;
  const sex = i.calculationSex as 'female' | 'male';
  const height = i.heightCm as number;
  const weight = i.weightKg as number;
  const activity = i.activityLevel as ActivityLevel;

  const bmr = mifflinStJeor(sex, weight, height, age);
  const factor = ACTIVITY_FACTORS[activity];
  const tdee = bmr * factor;
  const adjustmentPct = goalAdjustmentPct(i.goal);
  const floor = Math.max(bmr, ENERGY_FLOOR_KCAL);
  const energy = Math.round(Math.max(floor, tdee * (1 + adjustmentPct / 100)));
  const calculated = macrosForEnergy(energy, weight);
  const floorKcal = Math.round(floor);

  return {
    eligible: true,
    mode: 'full',
    reasons: [],
    method: 'mifflin_st_jeor_v1',
    inputs: { ageYears: age, calculationSex: sex, heightCm: height, weightKg: weight, activityLevel: activity },
    bmrKcal: Math.round(bmr),
    activityFactor: factor,
    tdeeKcal: Math.round(tdee),
    adjustmentPct,
    floorKcal,
    calculated,
    bounds: {
      energyKcal: { min: floorKcal, max: Math.max(floorKcal, Math.round(tdee * (1 + ADJUST_MAX_OVER_TDEE))) },
      proteinG: proteinBounds(energy),
    },
    waterMl,
    goal,
  };
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
 * go below the floor (BR-06).
 */
export function validateTargets(
  preview: PlanPreview,
  req: { source: PlanSource; energyKcal?: number; proteinG?: number },
): TargetValidation {
  if (req.source === 'none') return { ok: true, targets: null };
  if (!preview.eligible || !preview.calculated || !preview.bounds || !preview.inputs) {
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
  return { ok: true, targets: macrosForEnergy(req.energyKcal, preview.inputs.weightKg, req.proteinG) };
}
