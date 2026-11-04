/**
 * Server rules for AI meal analysis (plan section 8.3, rules 1–7). The server never trusts
 * model totals and normalises every item before it reaches a user.
 */
import { chooseReactionLine, type ReactionInput, type ScanReactionContent } from './reactions';
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

/** Relative tolerance between stated kcal and 4P + 4C + 9F before kcal is recomputed (rule 4). */
export const KCAL_TOLERANCE = 0.2;

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
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG?: number | null;
}

/** Rule 6: the portion multiplier scales grams and every nutrient. */
export function scaleItem<T extends ScalableItem>(item: T, multiplier: number): T {
  return {
    ...item,
    grams: round1(item.grams * multiplier),
    kcal: round0(item.kcal * multiplier),
    proteinG: round1(item.proteinG * multiplier),
    carbsG: round1(item.carbsG * multiplier),
    fatG: round1(item.fatG * multiplier),
    ...(item.fiberG === undefined ? {} : { fiberG: item.fiberG === null ? null : round1(item.fiberG * multiplier) }),
  };
}

/** Rule 6: a grams edit scales that item's nutrients linearly from its per-gram values. */
export function editItemGrams<T extends ScalableItem>(item: T, newGrams: number): T {
  const grams = clamp(newGrams, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX);
  if (item.grams <= 0) return { ...item, grams: round1(grams) };
  const scaled = scaleItem(item, grams / item.grams);
  return { ...scaled, grams: round1(grams) };
}

/** Rule 5: the server computes totals; excluded items are skipped. */
export function computeTotals(
  items: { kcal: number; proteinG: number; carbsG: number; fatG: number; excluded?: boolean }[],
  multiplier = 1,
): NutrientTotals {
  const sum = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const it of items) {
    if (it.excluded) continue;
    sum.kcal += it.kcal;
    sum.proteinG += it.proteinG;
    sum.carbsG += it.carbsG;
    sum.fatG += it.fatG;
  }
  return {
    kcal: round0(sum.kcal * multiplier),
    proteinG: round1(sum.proteinG * multiplier),
    carbsG: round1(sum.carbsG * multiplier),
    fatG: round1(sum.fatG * multiplier),
  };
}

type OutputItem = MealAnalysisOutput['items'][number];

/** Rules 3 and 4 for one item. */
export function normaliseItem(item: OutputItem): AnalysedItem {
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

  const point =
    item.point && item.point.x >= 0 && item.point.x <= 1 && item.point.y >= 0 && item.point.y <= 1
      ? { x: item.point.x, y: item.point.y }
      : null;

  return {
    name: item.name.trim(),
    portion: item.portion,
    grams: round1(grams),
    kcal: round0(kcal),
    proteinG,
    carbsG,
    fatG,
    fiberG,
    confidence: clamp(item.confidence, 0, 1),
    point,
    kcalRecomputed,
  };
}

export interface NormaliseResult {
  status: 'rejected' | 'succeeded';
  analysis: MealAnalysis;
}

/** Rules 2–7: turn validated model output into the stored analysis. */
export function normaliseAnalysis(
  out: MealAnalysisOutput,
  opts: { reaction?: Omit<ReactionInput, 'items'> & { content: ScanReactionContent } } = {},
): NormaliseResult {
  if (!out.isFood) {
    // Rule 2: not food → rejected, friendly message on the client, no charge.
    return {
      status: 'rejected',
      analysis: {
        isFood: false,
        mealName: null,
        items: [],
        totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
        notes: out.notes,
        clarifyingQuestion: out.clarifyingQuestion,
        reactionLineId: null,
      },
    };
  }
  const items = out.items.slice(0, MAX_MEAL_ITEMS).map(normaliseItem);
  const totals = computeTotals(items);
  return {
    status: 'succeeded',
    analysis: {
      isFood: true,
      mealName: out.mealName,
      items,
      totals,
      notes: out.notes,
      clarifyingQuestion: out.clarifyingQuestion,
      reactionLineId: opts.reaction ? chooseReactionLine(opts.reaction.content, { ...opts.reaction, items }) : null,
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
