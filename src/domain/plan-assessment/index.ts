/**
 * Plan assessment (PLAN-GEN): decides, from validated profile values only, whether a calorie plan
 * can be made, what is missing and what contradicts itself. Everyone ends with a goal: a calorie
 * plan, or a habits goal. Pure and deterministic: the AI never sees an input that has not passed
 * through here and never fills a gap. Product wording is pending dietitian review (OQ-03).
 */
import {
  KCAL_PER_KG_BODY_WEIGHT,
  type PlanAssessment,
  type PlanIssue,
  type PlanMissingItem,
  type PlanNotice,
  type PlanOutcome,
  type PlanPreview,
  type PlanTimeframe,
} from '../../shared';
import { asDayActivity, asExerciseFrequency, assessEligibility, bmiOf, mapActivityOption, proteinRuleOf, twoPartActivity, UNDERWEIGHT_BMI, type PlanInputs } from '../plan-calculator';
import { tr as defaultTr, type Translator } from '../../shared/i18n';

/**
 * Questions a calorie plan needs, in asking order. q38 only counts when the sex input is female. Activity is
 * q39 + q40 (decision 0017); a profile that runs on an older q10 answer alone lists q10 instead ({@link requiredForTargets}).
 */
export const REQUIRED_FOR_TARGETS = ['q06', 'q07', 'q38', 'q08', 'q09', 'q39', 'q40'] as const;

/** True when activity comes from an older q10 answer and neither q39 nor q40 has been answered. */
export function runsOnLegacyActivity(i: Pick<PlanInputs, 'activityLevel' | 'dayActivity' | 'exerciseFrequency'>): boolean {
  return mapActivityOption(i.activityLevel) !== null && !asDayActivity(i.dayActivity) && !asExerciseFrequency(i.exerciseFrequency);
}

/** The questions this person's calorie plan needs, in asking order. */
export function requiredForTargets(i: Pick<PlanInputs, 'calculationSex' | 'activityLevel' | 'dayActivity' | 'exerciseFrequency'>): string[] {
  return [...['q06', 'q07'], ...(i.calculationSex === 'female' ? ['q38'] : []), 'q08', 'q09', ...(runsOnLegacyActivity(i) ? ['q10'] : ['q39', 'q40'])];
}

/** BMI outside this range almost always means a typing slip (or a unit mix-up). */
export const BMI_PLAUSIBLE = { min: 12, max: 70 } as const;
/** A target change above this share of body weight gets a "go in stages" note. */
export const LARGE_CHANGE_SHARE = 0.25;

export interface AssessInputs extends PlanInputs {
  weightIsEstimate?: boolean;
  /** Optional answers (questions v2 and routine): null / empty = not answered. */
  allergies?: string[] | null;
  mealsPerDay?: string | null;
  schedulePattern?: string | null;
  mealSource?: string | null;
  dietPattern?: string | null;
}

const missing = (tr: Translator): Record<string, PlanMissingItem> => ({
  age_unknown: { questionId: 'q06', field: 'ageYears', reason: tr('plan.missing.age') },
  sex_input_missing: { questionId: 'q07', field: 'calculationSex', reason: tr('plan.missing.sex') },
  life_stage_missing: { questionId: 'q38', field: 'lifeStage', reason: tr('plan.missing.lifeStage') },
  height_missing: { questionId: 'q08', field: 'heightCm', reason: tr('plan.missing.height') },
  weight_missing: { questionId: 'q09', field: 'weightKg', reason: tr('plan.missing.weight') },
  day_activity_missing: { questionId: 'q39', field: 'dayActivity', reason: tr('plan.missing.dayActivity') },
  exercise_missing: { questionId: 'q40', field: 'exerciseFrequency', reason: tr('plan.missing.exercise') },
});

/** Missing items behind one eligibility reason. Activity is two questions: only the unanswered ones are listed, q39 first. */
function missingFor(reason: string, i: AssessInputs, items: Record<string, PlanMissingItem>): PlanMissingItem[] {
  if (reason !== 'activity_missing') return items[reason] ? [items[reason]] : [];
  const out: PlanMissingItem[] = [];
  if (!asDayActivity(i.dayActivity)) out.push(items.day_activity_missing!);
  if (!asExerciseFrequency(i.exerciseFrequency)) out.push(items.exercise_missing!);
  return out;
}

const ESSENTIAL_REASONS = ['sex_input_missing', 'life_stage_missing', 'height_missing', 'weight_missing', 'activity_missing'];

const issue = (code: string, severity: PlanIssue['severity'], message: string, questionIds: string[]): PlanIssue => ({ code, severity, message, questionIds });

/** Plausibility and consistency checks on values that are all present. */
export function consistencyIssues(i: AssessInputs, tr: Translator = defaultTr): PlanIssue[] {
  const out: PlanIssue[] = [];
  const h = i.heightCm;
  const w = i.weightKg;
  if (typeof h === 'number' && typeof w === 'number' && h > 0 && w > 0) {
    const bmi = bmiOf(w, h);
    if (bmi < BMI_PLAUSIBLE.min || bmi > BMI_PLAUSIBLE.max) {
      out.push(issue('bmi_implausible', 'blocking', tr('plan.issue.bmi_implausible'), ['q08', 'q09']));
    } else if (i.goal === 'lose' && bmi < UNDERWEIGHT_BMI) {
      out.push(issue('loss_goal_underweight', 'blocking', tr('plan.issue.loss_goal_underweight'), ['q01', 'q09']));
    }
  }
  const t = i.targetWeightKg;
  if (typeof t === 'number' && typeof w === 'number' && (i.goal === 'lose' || i.goal === 'gain')) {
    if (t === w) {
      out.push(issue('target_equals_current', 'blocking', tr('plan.issue.target_equals_current'), ['target_weight']));
    } else if (i.goal === 'lose' && t > w) {
      out.push(issue('target_above_current', 'blocking', tr('plan.issue.target_above_current'), ['q01', 'target_weight']));
    } else if (i.goal === 'gain' && t < w) {
      out.push(issue('target_below_current', 'blocking', tr('plan.issue.target_below_current'), ['q01', 'target_weight']));
    } else {
      if (typeof h === 'number' && h > 0 && bmiOf(t, h) < UNDERWEIGHT_BMI) {
        out.push(issue('target_bmi_low', 'blocking', tr('plan.issue.target_bmi_low'), ['target_weight']));
      }
      if (Math.abs(t - w) / w > LARGE_CHANGE_SHARE) {
        out.push(issue('large_change', 'warning', tr('plan.issue.large_change'), ['target_weight']));
      }
    }
  }
  if (!i.allergies || i.allergies.length === 0) {
    out.push(issue('allergies_unknown', 'warning', tr('plan.issue.allergies_unknown'), ['q36']));
  }
  if (i.weightIsEstimate) {
    out.push(issue('weight_is_estimate', 'warning', tr('plan.issue.weight_is_estimate'), ['q09']));
  }
  return out;
}

/** Optional answers that would make the plan fit better. */
export function optionalUnanswered(i: AssessInputs): string[] {
  const out: string[] = [];
  if (!i.dietPattern) out.push('q11');
  if (!i.allergies || i.allergies.length === 0) out.push('q36');
  if (!i.mealSource) out.push('q12');
  if (!i.schedulePattern) out.push('q13');
  if (!i.mealsPerDay) out.push('q37');
  return out;
}

export function assessPlan(i: AssessInputs, tr: Translator = defaultTr): PlanAssessment {
  const elig = assessEligibility(i);
  const optional = optionalUnanswered(i);
  const MISSING = missing(tr);
  const required = requiredForTargets(i);
  const base = { requiredForTargets: required, optionalUnanswered: optional };
  const build = (outcome: PlanOutcome, extra: Partial<PlanAssessment>): PlanAssessment => ({
    outcome,
    missing: [],
    issues: [],
    guidanceReasons: [],
    canContinueWithoutTargets: true,
    ...base,
    ...extra,
  });

  if (elig.reasons.includes('under_18')) {
    return build('habits_only', { guidanceReasons: ['under_18'] });
  }
  if (elig.reasons.includes('age_unknown')) {
    return build('needs_input', { missing: [MISSING.age_unknown!] });
  }

  // Pregnant or breastfeeding: a habits goal needs no height, weight or activity, so nothing is missing.
  if (elig.reasons.includes('pregnant_or_breastfeeding')) {
    return build('habits_only', { guidanceReasons: ['pregnant_or_breastfeeding'] });
  }

  const essentials = elig.reasons.filter((r) => ESSENTIAL_REASONS.includes(r));
  if (essentials.length) {
    return build('needs_input', { missing: essentials.flatMap((r) => missingFor(r, i, MISSING)), issues: consistencyIssues(i, tr).filter((x) => x.severity === 'warning') });
  }

  const issues = consistencyIssues(i, tr);
  if (issues.some((x) => x.severity === 'blocking')) return build('needs_input', { issues });

  return build('ready', { issues });
}

// ── Time estimate ────────────────────────────────────────────────────────────────────────────────

export const MAX_LOSS_KG_PER_WEEK = 1;
export const MAX_LOSS_SHARE_PER_WEEK = 0.01;
export const MAX_GAIN_KG_PER_WEEK = 0.5;
/** Weight change slows as intake, weight and adherence drift; the upper end allows for it. */
export const SLOWDOWN_FACTOR = 1.25;

/** Weeks as the unit people think in: weeks up to 16, then months, then years (one decimal). */
export function durationParts(weeks: number): { n: number; unit: 'weeks' | 'months' | 'years' } {
  if (weeks <= 16) return { n: weeks, unit: 'weeks' };
  const months = Math.round(weeks / 4.345);
  if (months < 24) return { n: months, unit: 'months' };
  return { n: Math.round((weeks / 52.18) * 10) / 10, unit: 'years' };
}

export function humanDuration(weeks: number, tr: Translator = defaultTr): string {
  const d = durationParts(weeks);
  return tr('plan.duration', { n: d.n, unit: d.unit });
}

const range = (min: number, max: number, tr: Translator): string => {
  if (min === max) return tr('plan.range.single', { a: humanDuration(min, tr) });
  const a = durationParts(min);
  const b = durationParts(max);
  return tr('plan.range.same', { a: a.unit === b.unit ? a.n : humanDuration(min, tr), b: humanDuration(max, tr) });
};

const kg1 = (n: number): string => (Math.round(n * 10) / 10).toString();

export interface TimeframeInputs {
  goal: string | null;
  weightKg: number;
  targetWeightKg: number | null;
  tdeeKcal: number;
  energyKcal: number;
  requestedWeeks: number | null;
}

/**
 * How long the confirmed daily target would take to reach the target weight. An estimate from the
 * energy gap (about 7,700 kcal per kg), widened for the slowdown that real life brings. It never
 * sets a date and never changes the daily targets.
 */
export function estimateTimeframe(i: TimeframeInputs, tr: Translator = defaultTr): PlanTimeframe | null {
  if ((i.goal !== 'lose' && i.goal !== 'gain') || i.targetWeightKg === null) return null;
  const direction = i.goal;
  const change = Math.abs(i.targetWeightKg - i.weightKg);
  if (change < 0.5) return null;
  if (direction === 'lose' ? i.targetWeightKg > i.weightKg : i.targetWeightKg < i.weightKg) return null;
  const gap = direction === 'lose' ? i.tdeeKcal - i.energyKcal : i.energyKcal - i.tdeeKcal;
  if (gap <= 0) return null;

  const pace = (gap * 7) / KCAL_PER_KG_BODY_WEIGHT;
  const min = Math.max(1, Math.ceil(change / pace));
  const max = Math.max(min, Math.ceil(min * SLOWDOWN_FACTOR));
  const maxSafePace = direction === 'lose' ? Math.min(MAX_LOSS_KG_PER_WEEK, MAX_LOSS_SHARE_PER_WEEK * i.weightKg) : MAX_GAIN_KG_PER_WEEK;
  const safeMin = Math.max(1, Math.ceil(change / maxSafePace));
  const req = i.requestedWeeks;
  const eta = range(min, max, tr);
  const kind = direction;
  const base = { verb: tr(`plan.verb.${kind}.ing`), verbNoun: tr(`plan.verb.${kind}.noun`), change: kg1(change), eta };

  let verdict: PlanTimeframe['verdict'];
  let message: string;
  if (req === null) {
    verdict = 'no_request';
    message = tr('plan.timeframe.no_request', base);
  } else if (req < safeMin) {
    verdict = 'faster_than_safe';
    message = tr('plan.timeframe.faster_than_safe', { ...base, req: humanDuration(req, tr), maxPace: kg1(maxSafePace), safeMin: humanDuration(safeMin, tr) });
  } else if (req < min) {
    verdict = 'faster_than_plan';
    message = tr('plan.timeframe.faster_than_plan', { ...base, req: humanDuration(req, tr) });
  } else if (req <= max) {
    verdict = 'realistic';
    message = tr('plan.timeframe.realistic', { ...base, req: humanDuration(req, tr) });
  } else {
    verdict = 'slower_than_plan';
    message = tr('plan.timeframe.slower_than_plan', { ...base, req: humanDuration(req, tr) });
  }

  return {
    direction,
    startWeightKg: i.weightKg,
    targetWeightKg: i.targetWeightKg,
    changeKg: Math.round(change * 10) / 10,
    paceKgPerWeek: Math.round(pace * 100) / 100,
    estimatedWeeks: { min, max },
    safeMinWeeks: safeMin,
    requestedWeeks: req,
    verdict,
    message,
    rule: { kcalPerKg: KCAL_PER_KG_BODY_WEIGHT, slowdownFactor: SLOWDOWN_FACTOR },
  };
}

/** Re-estimate for adjusted targets (the stored plan always reflects what the user confirmed). */
export function retimeFrame(base: PlanTimeframe, tdeeKcal: number, energyKcal: number, tr: Translator = defaultTr): PlanTimeframe | null {
  return estimateTimeframe(
    {
    goal: base.direction,
    weightKg: base.startWeightKg,
    targetWeightKg: base.targetWeightKg,
    tdeeKcal,
    energyKcal,
    requestedWeeks: base.requestedWeeks,
    },
    tr,
  );
}

// ── Plain-language basis and static notices ──────────────────────────────────────────────────────

/**
 * How the numbers were made and what they assume, in words a non-expert follows. Deterministic, never AI.
 * `adjustedKcal` replaces the "N% below" line when the user confirmed a different daily target.
 */
export function buildBasis(preview: PlanPreview, i: AssessInputs, timeframe: PlanTimeframe | null, tr: Translator = defaultTr, adjustedKcal?: number): string[] {
  if (!preview.eligible || !preview.inputs || preview.bmrKcal === null || preview.tdeeKcal === null) return [];
  const out: string[] = [];
  const inp = preview.inputs;
  const two = twoPartActivity(inp);
  if (two) {
    out.push(
      tr('plan.basis.restingTwoPart', {
        bmr: preview.bmrKcal,
        day: tr(`plan.dayActivity.${two.dayActivity}`),
        exercise: tr(`plan.exercise.${two.exerciseFrequency}`),
        factor: preview.activityFactor ?? '',
        tdee: preview.tdeeKcal,
      }),
    );
  } else {
    const level = inp.activityLevel;
    const activity = level === 'seated' || level === 'light' || level === 'active' || level === 'intense' ? tr(`plan.activity.${level}`) : level;
    out.push(tr('plan.basis.resting', { bmr: preview.bmrKcal, activity, factor: preview.activityFactor ?? '', tdee: preview.tdeeKcal }));
  }
  const pct = preview.adjustmentPct ?? 0;
  const pace = preview.goal.pace;
  const chosen = pace === 'gentle' || pace === 'steady' || pace === 'faster' ? pace : null;
  const energy = preview.calculated?.energyKcal;
  const weekly = preview.weeklyChangeKg ?? null;
  // The floor, not the goal, set the target: quoting a percent (or "matches that number") would be wrong.
  const floorSet = preview.floorKcal !== null && energy === preview.floorKcal && energy > Math.round(preview.tdeeKcal * (1 + pct / 100));
  if (adjustedKcal !== undefined && adjustedKcal !== energy) out.push(tr('plan.basis.adjusted', { kcal: adjustedKcal }));
  else {
    // A limit changed the pace the person asked for (decision 0017, limits 1 and 2).
    if (preview.goal.paceLimitedBy === 'low_bmi' || preview.goal.paceLimitedBy === 'age') out.push(tr(`plan.basis.paceLimited.${preview.goal.paceLimitedBy}`));
    // A loss pace that would go under the minimum; or (v1 behaviour kept) a minimum that sits above maintenance itself.
    if (floorSet) out.push(tr(pct < 0 ? 'plan.basis.floorApplied' : 'plan.basis.floorRaised', { floor: preview.floorKcal as number }));
    else if (pct < 0) out.push(chosen && weekly !== null ? tr('plan.basis.belowPace', { pct: Math.abs(pct), pace: tr(`plan.pace.${chosen}`), kg: weekly }) : tr('plan.basis.below', { pct: Math.abs(pct) }));
    else if (pct > 0) out.push(chosen && weekly !== null ? tr('plan.basis.abovePace', { pct, pace: tr(`plan.pace.${chosen}`), kg: weekly }) : tr('plan.basis.above', { pct }));
    else out.push(tr('plan.basis.matches'));
  }
  if (preview.floorKcal !== null) out.push(tr('plan.basis.floor', { floor: preview.floorKcal }));
  const rule = proteinRuleOf(preview);
  if (preview.method !== 'mifflin_st_jeor_v2' || !rule) out.push(tr('plan.basis.macros'));
  else if (rule.reference) out.push(tr('plan.basis.proteinReference', { gPerKg: rule.gPerKg, refKg: Math.round(rule.weightKg) }));
  else out.push(tr('plan.basis.protein', { gPerKg: rule.gPerKg }));
  out.push(tr('plan.basis.estimates'));
  if (i.weightIsEstimate) out.push(tr('plan.basis.weightEstimate'));
  if (!i.allergies || i.allergies.length === 0) out.push(tr('plan.basis.allergiesUnknown'));
  if (timeframe) out.push(tr('plan.basis.timeframe', { kcalPerKg: timeframe.rule.kcalPerKg.toLocaleString('en-GB') }));
  return out;
}

export function noticeFor(assessment: PlanAssessment, tr: Translator = defaultTr): PlanNotice | null {
  if (assessment.outcome === 'habits_only') {
    const key = assessment.guidanceReasons.includes('pregnant_or_breastfeeding') ? 'life_stage' : 'habits_only';
    return { kind: 'habits_only', title: tr(`plan.notice.${key}.title`), body: tr(`plan.notice.${key}.body`), reasons: assessment.guidanceReasons };
  }
  if (assessment.outcome === 'needs_input') {
    const blocking = assessment.issues.some((x) => x.severity === 'blocking');
    const k = blocking ? 'blocking' : 'missing';
    return { kind: 'needs_input', title: tr(`plan.notice.needs_input.${k}.title`), body: tr(`plan.notice.needs_input.${k}.body`), reasons: assessment.missing.map((m) => m.field) };
  }
  return null;
}
