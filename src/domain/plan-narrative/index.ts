/**
 * Plan narrative rules (PLAN-GEN). The model personalises wording; it never produces a number the
 * user could take as a target. Everything it returns is checked here before it is shown or stored.
 */
import { createHash } from 'node:crypto';
import type { PlanNarrative, PlanPreview, PlanTimeframe } from '../../shared';
import type { ProfileFields } from '../onboarding-engine';
import type { QuestionSet } from '../onboarding-engine';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { normaliseDigits, packsFor, RULE_PACKS } from './locales';
import type { PlanAssessment } from '../../shared';

// ── Input hash ───────────────────────────────────────────────────────────────────────────────────

/** Profile fields that feed the calculation or the personalisation. A change to any of them makes a draft stale. */
const HASHED_FIELDS = [
  'primaryGoal', 'supportingGoals', 'personalMotivation', 'ageYears', 'calculationSex', 'lifeStage', 'heightCm', 'weightKg', 'weightIsEstimate',
  'targetWeightKg', 'activityLevel', 'dietPattern', 'dietPatternOther', 'mealSource', 'nutritionFamiliarity', 'startingMood',
  'habitPriorities', 'timeframeWeeks', 'allergies', 'allergyOther', 'mealsPerDay', 'schedulePattern', 'higherIntakePattern',
  'trackingExperience', 'routineBarriers', 'eatingCues', 'movementActions',
] as const satisfies ReadonlyArray<keyof ProfileFields>;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function planInputHash(profile: Partial<ProfileFields>): string {
  const picked: Record<string, unknown> = {};
  for (const k of HASHED_FIELDS) picked[k] = profile[k] ?? null;
  return createHash('sha256').update(stable(picked)).digest('hex').slice(0, 32);
}

// ── Model context ────────────────────────────────────────────────────────────────────────────────

/** Option label for a field, so the model reads words rather than ids. */
export function makeLabeler(set: QuestionSet): (fieldKey: string, optionId: string | null | undefined) => string | null {
  const byField = new Map(set.questions.map((q) => [q.fieldKey, q]));
  return (fieldKey, optionId) => {
    if (!optionId) return null;
    const label = byField.get(fieldKey)?.options.find((o) => o.id === optionId)?.label;
    return typeof label === 'string' ? label : optionId;
  };
}

export interface NarrativeFacts {
  context: string;
  /** Lower-case words that must not appear as a suggestion (the user's allergens). */
  avoidTerms: string[];
}

const STOP_WORDS = new Set(['and', 'the', 'with', 'all', 'any', 'for', 'but', 'not', 'nor', 'some', 'food', 'foods', 'than', 'that', 'this', 'from', 'etc']);

/** Words that must not appear as a suggestion: the allergens (q36), what the eating pattern rules out, and the user's own free text. */
export function avoidTermsFor(allergies: string[] | null | undefined, other: string | null | undefined, dietPattern?: string | null, locale: LocaleCode = DEFAULT_LOCALE): string[] {
  const terms = new Set<string>();
  for (const pack of packsFor(locale)) {
    for (const a of allergies ?? []) for (const t of pack.allergens[a] ?? []) terms.add(t);
    for (const t of pack.patterns[dietPattern ?? ''] ?? []) terms.add(t);
  }
  for (const w of (other ?? '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}]+/u)) if ([...w].length >= (isLatin(w) ? 3 : 2) && !STOP_WORDS.has(w)) terms.add(w);
  return [...terms];
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isLatin = (t: string): boolean => /^\p{ASCII}+$/u.test(t);
/** Bangla case endings and clitics that attach to a noun (দুধ -> দুধের, ডিম -> ডিমে). */
const BANGLA_ENDINGS = ['র', 'ের', 'য়ের', 'কে', 'ে', 'য়ে', 'য়', 'টি', 'টা', 'খানা', 'গুলো', 'গুলি', 'ও', 'ই', 'সহ'];

/**
 * Unicode-aware term match. Short Latin words must be whole words (with a plural); longer Latin stems also match their forms
 * ("anchov" -> anchovies). Other scripts match the whole word plus the usual case endings, so "রুটি" (bread) does not fire on
 * "রুটিন" (routine) and "আম" (mango) does not fire on "আমি" (I), while "দুধের" and "ডিমে" are still caught.
 */
const termRegex = (term: string): RegExp => {
  const left = '(?<![\\p{L}\\p{M}])';
  const right = '(?![\\p{L}\\p{M}])';
  const body = escapeRe(term.normalize('NFC').toLowerCase());
  if (!isLatin(term)) return new RegExp(`${left}${body}(?:${BANGLA_ENDINGS.join('|')})?${right}`, 'iu');
  return new RegExp(term.length <= 4 ? `${left}${body}(?:e?s)?${right}` : `${left}${body}`, 'iu');
};

export interface NarrativeInputs {
  profile: ProfileFields;
  preview: PlanPreview;
  timeframe: PlanTimeframe | null;
  assessment: PlanAssessment;
  label: (fieldKey: string, optionId: string | null | undefined) => string | null;
  /** Language the tips will be written in: widens the words to avoid. */
  locale?: LocaleCode;
}

/**
 * The only data the model receives. No name, email, birth date or ids: just what the plan needs.
 * Numbers are included as facts so the text can stay consistent, but the model is told not to repeat them.
 */
export function buildNarrativeContext(i: NarrativeInputs): NarrativeFacts {
  const p = i.profile;
  const L = i.label;
  const labels = (field: string, ids: readonly string[] | null | undefined) => (ids ?? []).map((id) => L(field, id)).filter((x): x is string => Boolean(x));
  const allergies = p.allergies === null ? 'not provided' : p.allergies.includes('none') ? 'none reported' : [...labels('food_allergies', p.allergies.filter((a) => a !== 'other')), ...(p.allergyOther ? [`other (user text): ${p.allergyOther}`] : [])];
  const ctx = {
    goal: L('primary_goal', p.primaryGoal) ?? 'not provided',
    otherGoals: labels('supporting_goals', p.supportingGoals),
    motivation: L('personal_motivation', p.personalMotivation),
    profile: {
      ageYears: p.ageYears,
      heightCm: p.heightCm,
      weightKg: p.weightKg,
      targetWeightKg: p.targetWeightKg,
      activity: L('activity_level', p.activityLevel),
    },
    numbers: {
      dailyTargetKcal: i.preview.calculated?.energyKcal,
      maintenanceKcal: i.preview.tdeeKcal,
      proteinG: i.preview.calculated?.proteinG,
      carbsG: i.preview.calculated?.carbsG,
      fatG: i.preview.calculated?.fatG,
      waterMl: i.preview.waterMl,
      estimatedWeeks: i.timeframe ? i.timeframe.estimatedWeeks : null,
    },
    timeframeVerdict: i.timeframe?.verdict ?? null,
    preferences: {
      eatingPattern: p.dietPattern === 'other' ? `other (user text): ${p.dietPatternOther ?? 'not given'}` : L('diet_pattern', p.dietPattern),
      allergiesAndIntolerances: allergies,
      whereMealsComeFrom: L('meal_source', p.mealSource),
      mealsInAUsualDay: L('meals_per_day', p.mealsPerDay),
    },
    routine: {
      workOrStudySchedule: L('schedule_pattern', p.schedulePattern),
      eatsMoreOnDaysOff: L('higher_intake_pattern', p.higherIntakePattern),
      whatGetsInTheWay: labels('routine_barriers', p.routineBarriers),
      eatingCues: labels('eating_cues', p.eatingCues),
      firstHabits: labels('habit_priorities', p.habitPriorities),
      movementThatFits: labels('movement_actions', p.movementActions),
    },
    experience: {
      nutritionKnowledge: L('nutrition_familiarity', p.nutritionFamiliarity),
      foodDiaryBefore: L('tracking_experience', p.trackingExperience),
      feelingAboutChange: L('starting_mood', p.startingMood),
    },
    notices: i.assessment.issues.filter((x) => x.severity === 'warning').map((x) => x.code),
  };
  return { context: JSON.stringify(ctx, null, 1), avoidTerms: avoidTermsFor(p.allergies, p.allergyOther, p.dietPattern, i.locale) };
}

// ── Output validation ────────────────────────────────────────────────────────────────────────────

/** A bare figure of three or more digits ("1800 a day", "1,800 daily") or "2k" is a target in disguise. */
const BARE_BIG_NUMBER = /\b\d{3,}\b|\d,\d{3}|\b\d+(?:\.\d+)?\s?k\b/i;
const SPELLED_TARGET = /\b(?:kcal|calories)\s+(?:target|goal)\s+(?:of|is)\s+\d/i;

export interface NarrativeCheck {
  ok: boolean;
  problems: string[];
}

function textsOf(n: PlanNarrative): string[] {
  return [n.headline, n.summary, ...n.assumptions, ...n.guidance.flatMap((g) => [g.title, g.body]), ...n.watchOuts];
}

/** Rules the schema cannot express, per language (English rules always apply). Problems are fed back to the model on the retry. */
export function checkNarrative(n: PlanNarrative, avoidTerms: string[], locale: LocaleCode = DEFAULT_LOCALE): NarrativeCheck {
  const packs = packsFor(locale);
  const problems = new Set<string>();
  for (const raw of textsOf(n)) {
    const t = normaliseDigits(raw.normalize('NFC'));
    for (const p of packs) {
      const num = p.numberWithUnit.exec(t);
      if (num) problems.add(`contains the figure "${num[0].trim()}" - do not state any calorie, macro, weight, percentage or time figures; the app shows them`);
      if (p.spelledFigure.test(t)) problems.add('states a figure that looks like a target - the app shows every number');
      if (p.restriction.test(t)) problems.add('suggests cutting out a whole food group or weighing yourself daily');
      if (p.bannedWording.test(t)) problems.add('uses moral or diet-culture wording about food');
      if (p.fastingPlan.test(t)) problems.add('suggests fasting or skipping meals');
      if (p.medicalClaim.test(t)) problems.add('makes a medical claim');
    }
    if (SPELLED_TARGET.test(t) || BARE_BIG_NUMBER.test(t)) problems.add('states a figure that looks like a target - the app shows every number');
    for (const sentence of t.split(/(?<=[.!?।])\s+/u)) {
      const lower = sentence.toLowerCase();
      const hit = avoidTerms.find((term) => termRegex(term).test(lower));
      if (hit && !packs.some((p) => p.safeCue.test(lower))) problems.add(`mentions "${hit}", which the user avoids, without saying to avoid or swap it`);
    }
  }
  if (n.guidance.length !== new Set(n.guidance.map((g) => g.title.toLowerCase())).size) problems.add('repeats a guidance title');
  return { ok: problems.size === 0, problems: [...problems] };
}

export { RULE_PACKS };
