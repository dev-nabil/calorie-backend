/**
 * Server rules for AI meal analysis (plan section 8.3, rules 1–7). The server never trusts
 * model totals and normalises every item before it reaches a user.
 */
import { chooseReactionLine, type ReactionInput, type ScanReactionContent } from './reactions';
import {
  AI_ESTIMATE,
  KCAL_TOLERANCE,
  computeMealTotals,
  isInsideDish,
  matchFoodRecord,
  nutrientsForGrams,
  otherNutrientsFor,
  per100gFromValues,
  recordSource,
  sanitisePer100g,
  type FoodIndex,
} from '../food-nutrition';
import {
  ITEM_GRAMS_MAX,
  ITEM_GRAMS_MIN,
  MAX_MEAL_ITEMS,
  MealAnalysisOutputSchema,
  type AnalysedItem,
  type MealAnalysis,
  type MealAnalysisOutput,
  type NutrientTotals,
} from '../../shared';

export { PLAN_EXAMPLE_ANALYSIS } from './fixtures';

export { KCAL_TOLERANCE };

const round0 = (n: number): number => Math.round(n);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Atwater energy from macros. */
export function kcalFromMacros(m: { proteinG: number; carbsG: number; fatG: number }): number {
  return 4 * m.proteinG + 4 * m.carbsG + 9 * m.fatG;
}

export type ParseResult = { ok: true; value: MealAnalysisOutput } | { ok: false; issues: string[] };

/** Rule 1: validate with zod and reject unknown fields. Accepts an object or a JSON string. */
export function parseModelOutput(raw: unknown): ParseResult {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ['Output is not valid JSON'] };
    }
  }
  const parsed = MealAnalysisOutputSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, value: parsed.data };
}

export interface ScalableItem {
  grams: number;
  kcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG?: number | null;
}

const scaled = (v: number | null, multiplier: number, round: (n: number) => number): number | null => (v === null ? null : round(v * multiplier));

/** Rule 6: the portion multiplier scales grams and every nutrient. Unknown stays unknown. */
export function scaleItem<T extends ScalableItem>(item: T, multiplier: number): T {
  return {
    ...item,
    grams: round1(item.grams * multiplier),
    kcal: scaled(item.kcal, multiplier, round0),
    proteinG: scaled(item.proteinG, multiplier, round1),
    carbsG: scaled(item.carbsG, multiplier, round1),
    fatG: scaled(item.fatG, multiplier, round1),
    ...(item.fiberG === undefined ? {} : { fiberG: item.fiberG === null ? null : round1(item.fiberG * multiplier) }),
  };
}

/** Rule 6: a grams edit scales that item's nutrients linearly from its per-gram values. */
export function editItemGrams<T extends ScalableItem>(item: T, newGrams: number): T {
  const grams = clamp(newGrams, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX);
  if (item.grams <= 0) return { ...item, grams: round1(grams) };
  const result = scaleItem(item, grams / item.grams);
  return { ...result, grams: round1(grams) };
}

/** Rule 5: the server computes totals; excluded items are skipped and unknown values add nothing. */
export function computeTotals(
  items: { kcal: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null; excluded?: boolean }[],
  multiplier = 1,
): NutrientTotals {
  const sum = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const it of items) {
    if (it.excluded) continue;
    sum.kcal += it.kcal ?? 0;
    sum.proteinG += it.proteinG ?? 0;
    sum.carbsG += it.carbsG ?? 0;
    sum.fatG += it.fatG ?? 0;
  }
  return {
    kcal: round0(sum.kcal * multiplier),
    proteinG: round1(sum.proteinG * multiplier),
    carbsG: round1(sum.carbsG * multiplier),
    fatG: round1(sum.fatG * multiplier),
  };
}

/** Item from the text parser (POST /meals/parse): the model gives item values, so the basis is derived from them. */
export interface ParsedItemInput {
  name: string;
  portion: string | null;
  grams: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number | null;
  confidence: number;
  point: { x: number; y: number } | null;
}

/** Rules 3 and 4 for one parsed item. */
export function normaliseItem(item: ParsedItemInput, index = 0): AnalysedItem {
  // Rule 3: clamp grams 1–2000 and keep per-gram values by scaling the nutrients with it.
  const grams = clamp(item.grams, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX);
  const ratio = item.grams > 0 ? grams / item.grams : 1;
  const proteinG = round1(item.proteinG * ratio);
  const carbsG = round1(item.carbsG * ratio);
  const fatG = round1(item.fatG * ratio);
  const fiberG = item.fiberG === null ? null : round1(item.fiberG * ratio);
  let kcal = item.kcal * ratio;

  // Rule 4: recompute kcal from macros when it differs by more than 20%.
  const macroKcal = kcalFromMacros({ proteinG, carbsG, fatG });
  let kcalRecomputed = false;
  if (Math.abs(kcal - macroKcal) > KCAL_TOLERANCE * macroKcal) {
    kcal = macroKcal;
    kcalRecomputed = true;
  }
  const values = { kcal: round0(kcal), proteinG, carbsG, fatG, fiberG, sugarG: null, sodiumMg: null };

  return {
    id: `i${index}`,
    name: item.name.trim(),
    canonicalName: null,
    portion: item.portion,
    grams: round1(grams),
    ...values,
    per100g: per100gFromValues(values, grams),
    source: AI_ESTIMATE,
    otherNutrients: [],
    preparation: null,
    role: 'single',
    excluded: false,
    countedIn: null,
    assumption: null,
    confidence: clamp(item.confidence, 0, 1),
    point: validPoint(item.point),
    kcalRecomputed,
  };
}

const MAX_ASSUMPTIONS = 5;
const trimTo = (s: string, max: number): string => s.trim().slice(0, max);

const validPoint = (p: { x: number; y: number } | null) => (p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 ? { x: p.x, y: p.y } : null);

type OutputItem = MealAnalysisOutput['items'][number];

/** Rules 3 and 4 for one scanned item: a matching record replaces the model's values and keeps its source. */
function scanItem(raw: OutputItem, i: number, index: FoodIndex): AnalysedItem {
  const grams = clamp(raw.g, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX);
  const record = matchFoodRecord(index, [raw.en, raw.name], raw.prep);
  const clean = sanitisePer100g({ kcal: raw.n.kcal, proteinG: raw.n.p, carbsG: raw.n.c, fatG: raw.n.f, fiberG: raw.n.fib, sugarG: raw.n.sug, sodiumMg: raw.n.na });
  const per100g = record?.per100g ?? clean.per100g;
  return {
    id: `i${i}`,
    name: trimTo(raw.name, 120),
    canonicalName: trimTo(raw.en, 120),
    portion: null,
    grams: round1(grams),
    ...nutrientsForGrams(per100g, grams),
    per100g,
    source: record ? recordSource(index, record) : AI_ESTIMATE,
    otherNutrients: otherNutrientsFor(record, grams),
    preparation: raw.prep,
    role: raw.role === 'component' ? 'component' : (record?.kind ?? raw.role),
    excluded: false,
    countedIn: null,
    assumption: raw.note === null ? null : trimTo(raw.note, 140),
    confidence: clamp(raw.conf, 0, 1),
    point: validPoint(raw.pt),
    kcalRecomputed: !record && clean.kcalRecomputed,
  };
}

/** A mixed dish already holds its ingredients: anything inside one is shown but left out of the totals. */
function settleMixedDishes(items: AnalysedItem[], raw: OutputItem[]): void {
  const inside = (item: AnalysedItem, dish: AnalysedItem) => {
    item.role = 'component';
    item.excluded = true;
    item.countedIn = dish.id;
  };
  items.forEach((item, i) => {
    if (item.role !== 'component') return;
    const of = raw[i]!.of;
    const dish = of !== null && of !== i ? items[of] : undefined;
    if (dish?.role === 'mixed_dish') inside(item, dish);
    else item.role = 'single';
  });
  for (const dish of items.filter((d) => d.role === 'mixed_dish')) {
    for (const item of items) {
      if (item.role === 'mixed_dish' || item.countedIn) continue;
      if (isInsideDish(dish.canonicalName ?? dish.name, item.canonicalName ?? item.name)) inside(item, dish);
    }
  }
}

export interface NormaliseResult {
  status: 'rejected' | 'succeeded';
  analysis: MealAnalysis;
}

const NO_RECORDS: FoodIndex = { byAlias: new Map(), sources: {} };

/** Rules 2–7: turn validated model output into the stored analysis. */
export function normaliseAnalysis(
  out: MealAnalysisOutput,
  opts: { records?: FoodIndex; reaction?: Omit<ReactionInput, 'items'> & { content: ScanReactionContent } } = {},
): NormaliseResult {
  const question = out.question === null ? null : trimTo(out.question, 200);
  const base = { isEstimate: true as const, notes: question, clarifyingQuestion: question, retakeReason: out.retake };
  if (out.status !== 'ok' || !out.items.length) {
    // Rule 2: not food, or too unclear to estimate → rejected, friendly message, no charge, nothing invented.
    const noFood = out.status === 'no_food';
    return {
      status: 'rejected',
      analysis: { ...base, outcome: noFood ? 'no_food' : 'unclear', isFood: !noFood, mealName: null, items: [], totals: computeMealTotals([]), assumptions: [], reactionLineId: null },
    };
  }
  const raw = out.items.slice(0, MAX_MEAL_ITEMS);
  const items = raw.map((r, i) => scanItem(r, i, opts.records ?? NO_RECORDS));
  settleMixedDishes(items, raw);
  const reactionItems = items.map((i) => ({ name: i.name, kcal: i.kcal ?? 0, proteinG: i.proteinG ?? 0, carbsG: i.carbsG ?? 0, excluded: i.excluded }));
  return {
    status: 'succeeded',
    analysis: {
      ...base,
      outcome: 'ok',
      isFood: true,
      mealName: out.mealName === null ? null : trimTo(out.mealName, 120),
      items,
      totals: computeMealTotals(items),
      assumptions: out.assumptions.slice(0, MAX_ASSUMPTIONS).map((a) => trimTo(a, 140)),
      reactionLineId: opts.reaction ? chooseReactionLine(opts.reaction.content, { ...opts.reaction, items: reactionItems }) : null,
    },
  };
}

export {
  chooseReactionLine,
  reactionCategory,
  reactionFacts,
  variantIndex,
  REACTION_RULES,
  type ReactionInput,
  type ReactionItem,
  type ScanReactionContent,
} from './reactions';
