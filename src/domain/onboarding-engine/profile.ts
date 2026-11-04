/** Active profile values from the current answers (plan section 6 `profiles`). */
import { mapActivityOption, type ActivityLevel } from '../plan-calculator';
import { ageFromAnswer } from './conditions';
import type { AnswerMap, AnswerValue, QuestionSet } from './types';

export interface ProfileFields {
  primaryGoal: string | null;
  supportingGoals: string[];
  personalMotivation: string | null;
  requestedFeatures: string[];
  displayName: string | null;
  ageYears: number | null;
  birthDate: string | null;
  calculationSex: 'female' | 'male' | null;
  heightCm: number | null;
  weightKg: number | null;
  weightIsEstimate: boolean;
  targetWeightKg: number | null;
  activityLevel: ActivityLevel | null;
  dietPattern: string | null;
  mealSource: string | null;
  nutritionFamiliarity: string | null;
  startingMood: string | null;
  habitPriorities: string[];
  loggingMethods: string[];
  /** Plan personalisation inputs (questions v2 and the existing routine questions). null / [] = not answered. */
  timeframeWeeks: number | null;
  /** Option ids of q36; ['none'] = answered, no allergies; null = not answered. */
  allergies: string[] | null;
  /** detail.text of q36 'other' and q11 'other' (free text, untrusted). */
  allergyOther: string | null;
  dietPatternOther: string | null;
  mealsPerDay: string | null;
  schedulePattern: string | null;
  higherIntakePattern: string | null;
  trackingExperience: string | null;
  routineBarriers: string[];
  eatingCues: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: AnswerValue | undefined): string | null => (typeof v === 'string' && v.trim() ? v : null);
const arr = (v: AnswerValue | undefined): string[] => (Array.isArray(v) ? [...v] : []);
const objNum = (v: AnswerValue | undefined, key: string): number | null =>
  isObject(v) && typeof v[key] === 'number' ? (v[key] as number) : null;

/**
 * Map answered values to profile fields by fieldKey. Only `answered` records count; skipped,
 * deferred and not_applicable values never reach the profile (BR-11). Age is never inferred.
 */
export function profileFromAnswers(set: QuestionSet, answers: AnswerMap, today: string): ProfileFields {
  const byField: Record<string, AnswerValue | undefined> = {};
  const detailByField: Record<string, { text?: string; number?: number } | null | undefined> = {};
  for (const q of set.questions) {
    const rec = answers[q.id];
    if (rec?.status === 'answered') {
      byField[q.fieldKey] = rec.value;
      detailByField[q.fieldKey] = rec.detail;
    }
  }
  const age = byField.birth_date_or_age;
  const weight = byField.current_weight_kg;
  const sex = byField.calculation_sex;
  return {
    primaryGoal: str(byField.primary_goal),
    supportingGoals: arr(byField.supporting_goals),
    personalMotivation: str(byField.personal_motivation),
    requestedFeatures: arr(byField.requested_features),
    displayName: str(byField.preferred_name),
    ageYears: ageFromAnswer(age, today),
    birthDate: isObject(age) && age.mode === 'dob' && typeof age.dob === 'string' ? age.dob : null,
    calculationSex: sex === 'female' || sex === 'male' ? sex : null,
    heightCm: objNum(byField.height_cm, 'cm'),
    weightKg: objNum(weight, 'kg'),
    weightIsEstimate: isObject(weight) && weight.isEstimate === true,
    targetWeightKg: objNum(byField.target_weight_kg, 'kg'),
    activityLevel: mapActivityOption(str(byField.activity_level)),
    dietPattern: str(byField.diet_pattern),
    mealSource: str(byField.meal_source),
    nutritionFamiliarity: str(byField.nutrition_familiarity),
    startingMood: str(byField.starting_mood),
    habitPriorities: arr(byField.habit_priorities),
    loggingMethods: arr(byField.logging_methods),
    timeframeWeeks: timeframeWeeks(byField.timeframe_weeks, detailByField.timeframe_weeks),
    allergies: Array.isArray(byField.food_allergies) ? [...byField.food_allergies] : null,
    allergyOther: arr(byField.food_allergies).includes('other') ? cleanText(detailByField.food_allergies?.text) : null,
    dietPatternOther: byField.diet_pattern === 'other' ? cleanText(detailByField.diet_pattern?.text) : null,
    mealsPerDay: str(byField.meals_per_day),
    schedulePattern: str(byField.schedule_pattern),
    higherIntakePattern: str(byField.higher_intake_pattern),
    trackingExperience: str(byField.tracking_experience),
    routineBarriers: arr(byField.routine_barriers),
    eatingCues: arr(byField.eating_cues),
  };
}

/** q35: 12w/26w/52w map to weeks, custom reads detail.number; none and unsure mean no wish. */
const TIMEFRAME_WEEKS: Record<string, number> = { '12w': 12, '26w': 26, '52w': 52 };
function timeframeWeeks(value: AnswerValue | undefined, detail: { number?: number } | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  if (value === 'custom') return typeof detail?.number === 'number' && Number.isInteger(detail.number) ? detail.number : null;
  return TIMEFRAME_WEEKS[value] ?? null;
}

/** Free text from the user is data: one line, no control characters, at most 50 characters. */
export function cleanText(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\p{Cc}+/gu, ' ').replace(/`+/g, "'").replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  return t ? [...t].slice(0, 50).join('') : null;
}
