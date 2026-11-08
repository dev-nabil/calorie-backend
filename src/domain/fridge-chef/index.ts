/**
 * Fridge chef (Plus): what the model saw in a photo of the person's fridge or cupboard and up to three ideas to cook with
 * it. Pure: normalises the model's answer and drops every idea that breaks a rule before it is shown.
 *
 * Rules: never an idea with a food the person avoids (listed allergens, what their eating pattern rules out, their own
 * allergy text); energy per serving only in full mode (habits-only: no calorie, deficit or weight talk at all); no moral
 * words about food; sizes as the contract says (15 ingredients, 3 ideas, 5 steps).
 */
import { FRIDGE_MAX_IDEAS, FRIDGE_MAX_INGREDIENTS, FRIDGE_MAX_STEPS, type FridgeChefIdea, type FridgeChefOutput, type FridgeChefResponse } from '../../shared';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { charLength, cleanLine, copyProblems, fitSentences, hasForeignScript } from '../copy-rules';

export interface FridgeChefOptions {
  mode: 'full' | 'habits_only';
  locale?: LocaleCode;
  /** Lower-case terms the person avoids (plan-narrative `avoidTermsFor`). */
  avoidTerms?: readonly string[];
}

export interface FridgeChefCheck extends FridgeChefResponse {
  /** Why each dropped idea was dropped (logged, never shown). */
  dropped: string[];
}

const NAME_MAX = 80;
const ITEM_MAX = 60;
const WHY_MAX = 200;
const STEP_MAX = 220;
const MAX_ITEMS_PER_LIST = 15;
const MAX_EXTRA = 10;
const MINUTES_MIN = 1;
const MINUTES_MAX = 240;
/** Energy per serving outside this range is not a plausible estimate for one dish, so it is not shown. */
const KCAL_MIN = 20;
const KCAL_MAX = 2500;

/** Cleaned, non-empty, unique (ignoring case), short enough, at most `max`. */
export function cleanList(items: readonly string[] | null | undefined, max: number, itemMax = ITEM_MAX): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items ?? []) {
    const item = cleanLine(raw);
    if (!item || charLength(item) > itemMax) continue;
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length === max) break;
  }
  return out;
}

/** Per-serving energy as shown: full mode only, a whole number, null when implausible or unknown. */
export function servingKcal(kcal: number | null | undefined, mode: FridgeChefOptions['mode']): number | null {
  if (mode !== 'full' || typeof kcal !== 'number' || !Number.isFinite(kcal)) return null;
  const n = Math.round(kcal);
  return n >= KCAL_MIN && n <= KCAL_MAX ? n : null;
}

function checkIdea(raw: FridgeChefOutput['ideas'][number], o: FridgeChefOptions): { idea: FridgeChefIdea } | { problem: string } {
  const name = cleanLine(raw.name);
  if (!name || charLength(name) > NAME_MAX) return { problem: 'no usable name' };
  const why = fitSentences(cleanLine(raw.why), WHY_MAX) ?? '';
  if (typeof raw.minutes !== 'number' || !Number.isFinite(raw.minutes) || raw.minutes <= 0) return { problem: 'no usable time' };
  const steps = (raw.steps ?? [])
    .map((s) => cleanLine(s))
    .filter(Boolean)
    .map((s) => fitSentences(s, STEP_MAX))
    .filter((s): s is string => Boolean(s))
    .slice(0, FRIDGE_MAX_STEPS);
  if (!steps.length) return { problem: 'no steps' };
  const uses = cleanList(raw.uses, MAX_ITEMS_PER_LIST);
  const usesKeys = new Set(uses.map((u) => u.toLocaleLowerCase()));
  const extra = cleanList(raw.extra, MAX_EXTRA).filter((e) => !usesKeys.has(e.toLocaleLowerCase()));
  const idea: FridgeChefIdea = {
    name,
    why,
    minutes: Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, Math.round(raw.minutes))),
    kcal: servingKcal(raw.kcal, o.mode),
    uses,
    extra,
    steps,
  };
  // Each list item is its own sentence for the allergen check, so "eggs" in `extra` is caught even without a full stop.
  const text = [idea.name, idea.why, ...idea.uses, ...idea.extra, ...idea.steps].map((t) => (/[.!?।]$/u.test(t) ? t : `${t}.`)).join(' ');
  const problems = copyProblems(text, { locale: o.locale ?? DEFAULT_LOCALE, habitsOnly: o.mode === 'habits_only', avoidTerms: o.avoidTerms });
  return problems.length ? { problem: problems.join(', ') } : { idea };
}

/** The response the app gets: nothing from the photo when it shows no food, at most three ideas that keep every rule. */
export function normaliseFridgeChef(raw: FridgeChefOutput, o: FridgeChefOptions): FridgeChefCheck {
  const locale = o.locale ?? DEFAULT_LOCALE;
  const ingredients = raw.notFood ? [] : cleanList((raw.ingredients ?? []).filter((i) => !hasForeignScript(i, locale)), FRIDGE_MAX_INGREDIENTS);
  if (!ingredients.length) return { notFood: true, ingredients: [], ideas: [], dropped: [] };
  const ideas: FridgeChefIdea[] = [];
  const dropped: string[] = [];
  const names = new Set<string>();
  for (const [index, rawIdea] of (raw.ideas ?? []).entries()) {
    const checked = checkIdea(rawIdea, o);
    if ('problem' in checked) {
      dropped.push(`idea ${index + 1}: ${checked.problem}`);
      continue;
    }
    const key = checked.idea.name.toLocaleLowerCase();
    if (names.has(key)) {
      dropped.push(`idea ${index + 1}: repeats a name`);
      continue;
    }
    names.add(key);
    if (ideas.length < FRIDGE_MAX_IDEAS) ideas.push(checked.idea);
  }
  return { notFood: false, ingredients, ideas, dropped };
}
