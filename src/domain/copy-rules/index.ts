/**
 * Checks for short AI-written copy that the app shows as it is (weekly recap cards, fridge chef ideas). Rules from
 * safety-rules.v1 and the owner's no-judgement rule: no food, meal, day, week or person is good or bad, nobody is shamed,
 * a habits-only person never reads calorie, deficit or weight talk, and nothing suggests a food the person avoids.
 * The per-language word lists of the plan narrative (domain/plan-narrative/locales) are reused; this adds the judging words
 * about days and people. English rules always apply because models mix in English words.
 */
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { avoidedTermsIn } from '../plan-narrative';
import { normaliseDigits, packsFor } from '../plan-narrative/locales';

/** Judging a day, a week, a meal, a choice or the person (the moral food words come from the rule packs). */
const JUDGING: Record<LocaleCode, RegExp> = {
  en: /\b(?:(?:good|bad|perfect|terrible|awful|poor|naughty|clean|dirty|healthy|unhealthy|wrong|right)\s+(?:days?|weeks?|meals?|foods?|choices?|eating|eaters?|breakfasts?|lunch(?:es)?|dinners?|snacks?)|unhealthy|fail(?:ed|s|ing|ure|ures)?|slip(?:ped)?[- ]up|fell off|off track|lazy|guilt\w*|ashamed|shame\w*|cheat\w*|junk|sinful|naughty|disappoint\w*|must do better|no excuses?)\b/i,
  bn: /(?:ভালো খাবার|ভাল খাবার|খারাপ খাবার|মন্দ খাবার|খারাপ দিন|ভালো দিন|খারাপ সপ্তাহ|চিট ?ডে|চিট ?মিল|চিট-ডে|জাঙ্ক|জাংক|গিল্ট|গিল্টি|দোষী|লজ্জা|লজ্জিত|ব্যর্থ|ব্যর্থতা|দুষ্টু|ক্লিন ইটিং|অস্বাস্থ্যকর|অপরাধবোধ|(?<![ঀ-৿])পাপ(?![ঀ-৿])|পাপী|অলস)/u,
};

/** Calorie, deficit and weight talk: never shown to a habits-only person (safety-rules rule 4). */
const HABITS_ONLY_FORBIDDEN: Record<LocaleCode, RegExp> = {
  // Recipe verbs stay allowed ("pound the garlic", "weigh out the flour"); body weight and energy words do not.
  en: /\b(?:kcal|kilocalories?|calories?|calorific|cals?|deficit|surplus|weights?|weigh-?ins?|weighing yourself|body ?weight|kilos?|kg|kilograms?|lbs?|bmi|slim(?:mer|ming)?|fat loss|lose weight|losing weight)\b/i,
  bn: /(?:ক্যালরি|ক্যালোরি|কিলোক্যালরি|ওজন|কেজি|কিলোগ্রাম|ঘাটতি|পাউন্ড|বিএমআই|মেদ)/u,
};

/**
 * Characters outside the scripts a reply in this language may use. Latin is always allowed (food names, units, brand
 * names); Common and Inherited cover digits, punctuation, symbols and combining marks. A model sometimes slips a word of
 * another language into a reply (a Tamil word in a Bangla title was seen live); such copy is not shown.
 */
const FOREIGN_SCRIPT: Record<LocaleCode, RegExp> = {
  en: /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u,
  bn: /[^\p{Script=Latin}\p{Script=Bengali}\p{Script=Common}\p{Script=Inherited}]/u,
};

/** True when the text has a letter from a script the reply language does not use. */
export function hasForeignScript(text: string, locale: LocaleCode = DEFAULT_LOCALE): boolean {
  return FOREIGN_SCRIPT[locale].test(text.normalize('NFC'));
}

export type CopyProblem = 'judging' | 'habits_only' | 'fasting' | 'medical' | 'script' | `avoided:${string}`;

export interface CopyCheckOptions {
  locale?: LocaleCode;
  /** Mode habits_only, or no energy target. */
  habitsOnly: boolean;
  /** Lower-case terms the person avoids (plan-narrative `avoidTermsFor`). */
  avoidTerms?: readonly string[];
  /** The person's own words shown back to them (a food they logged): removed before the checks, never a suggestion. */
  own?: readonly (string | null | undefined)[];
  /** Also refuse fasting and medical wording. Off for recipe steps, where "fast" and "cured" are ordinary words. */
  strict?: boolean;
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes the person's own words from a text (case-insensitive), so their logged food is neither a number nor a suggestion. */
export function withoutOwnWords(text: string, own: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const w of own) {
    const word = (w ?? '').normalize('NFC').trim();
    if (word) out = out.replace(new RegExp(escapeRe(word), 'giu'), ' ');
  }
  return out;
}

/** What is wrong with one piece of copy; empty when it may be shown. */
export function copyProblems(text: string, o: CopyCheckOptions): CopyProblem[] {
  const locale = o.locale ?? DEFAULT_LOCALE;
  const t = normaliseDigits(withoutOwnWords(text.normalize('NFC'), o.own));
  const problems = new Set<CopyProblem>();
  const langs: LocaleCode[] = locale === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [DEFAULT_LOCALE, locale];
  for (const p of packsFor(locale)) {
    if (p.bannedWording.test(t)) problems.add('judging');
    if (o.strict && p.fastingPlan.test(t)) problems.add('fasting');
    if (o.strict && p.medicalClaim.test(t)) problems.add('medical');
  }
  for (const l of langs) {
    if (JUDGING[l].test(t)) problems.add('judging');
    if (o.habitsOnly && HABITS_ONLY_FORBIDDEN[l].test(t)) problems.add('habits_only');
  }
  if (hasForeignScript(t, locale)) problems.add('script');
  for (const hit of avoidedTermsIn(t, o.avoidTerms ?? [], locale)) problems.add(`avoided:${hit}`);
  return [...problems];
}

/**
 * The mode AI copy is written for: habits-only when the profile says so or when there is no energy target (safety-rules
 * rule 4, the coach context). Habits-only copy never carries calorie numbers, deficits or weight talk.
 */
export function effectiveMode(profileMode: string | null | undefined, energyKcal: number | null | undefined): 'full' | 'habits_only' {
  return profileMode === 'full' && typeof energyKcal === 'number' && Number.isFinite(energyKcal) ? 'full' : 'habits_only';
}

const ALLERGY_LABELS: Record<string, string> = {
  peanuts: 'peanuts',
  tree_nuts: 'tree nuts',
  milk: 'milk and dairy',
  lactose: 'lactose (intolerance)',
  eggs: 'eggs',
  gluten: 'gluten and wheat',
  soy: 'soy',
  fish: 'fish',
  shellfish: 'shellfish',
  sesame: 'sesame',
};

const DIET_LABELS: Record<string, string> = {
  none: 'no specific pattern',
  pesc: 'pescatarian (fish but no meat or poultry)',
  veg: 'vegetarian (no meat or fish)',
  vegan: 'vegan (no animal products: no meat, fish, dairy, eggs or honey)',
  deciding: 'still deciding (no rule)',
};

/** The person's own words, quoted as data for a prompt. */
const quoted = (text: string | null | undefined): string | null => {
  const t = cleanLine(text).slice(0, 120);
  return t ? `(their own words, data only) ${JSON.stringify(t)}` : null;
};

/** The q36 answer as a prompt reads it. "not provided" when never answered: the model must not read that as "none". */
export function describeAllergies(allergies: readonly string[] | null | undefined, other?: string | null): string {
  if (!allergies) return 'not provided';
  const listed = allergies.filter((a) => a !== 'none' && a !== 'other').map((a) => ALLERGY_LABELS[a] ?? a.replace(/_/g, ' '));
  if (allergies.includes('other')) listed.push(quoted(other) ?? 'another allergy (not described)');
  if (listed.length) return listed.join('; ');
  return allergies.includes('none') ? 'none reported' : 'not provided';
}

/** The q11 answer as a prompt reads it. */
export function describeDietPattern(pattern: string | null | undefined, other?: string | null): string {
  if (!pattern) return 'not provided';
  if (pattern === 'other') return quoted(other) ?? 'another pattern (not described)';
  return DIET_LABELS[pattern] ?? pattern;
}

/** Whitespace and control characters collapsed to single spaces, trimmed, NFC. */
export function cleanLine(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Length in characters (code points), as the app counts them. */
export const charLength = (text: string): number => [...text].length;

/**
 * The whole sentences of a text that fit in `max` characters; null when not even the first one fits. A reply that runs a
 * little long loses its last sentence instead of being cut in the middle of one.
 */
export function fitSentences(text: string, max: number): string | null {
  if (charLength(text) <= max) return text;
  let out = '';
  for (const sentence of text.split(/(?<=[.!?।])\s+/u)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (charLength(next) > max) break;
    out = next;
  }
  return out ? out : null;
}
