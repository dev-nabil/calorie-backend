/**
 * Nutrition labels (scan mode "label"). The model only copies what is printed; every conversion
 * (kJ to kcal, salt to sodium, per serving to per 100 g) happens here, where it can be tested.
 */
import { chooseReactionLine, type ReactionInput, type ScanReactionContent } from './reactions';
import { computeMealTotals, nutrientsForGrams, sanitisePer100g } from '../food-nutrition';
import { ITEM_GRAMS_MAX, ITEM_GRAMS_MIN, LabelScanOutputSchema, type AnalysedItem, type LabelScanOutput, type MealAnalysis, type NutrientValues, type NutritionSource } from '../../shared';

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const trimTo = (s: string, max: number): string => s.trim().slice(0, max);
const positive = (n: number | null): number | null => (n !== null && Number.isFinite(n) && n > 0 ? n : null);

/** 1 kcal = 4.184 kJ. */
export const KJ_PER_KCAL = 4.184;
/** Salt is sodium chloride: 1 g salt holds 400 mg sodium (EU labelling factor 2.5). */
export const SODIUM_MG_PER_G_SALT = 400;
/** A pack this small is usually eaten at once, so it is the default portion when no serving is printed. */
export const SINGLE_PACK_MAX_G = 250;
const MAX_RICH_IN = 4;

export type LabelParseResult = { ok: true; value: LabelScanOutput } | { ok: false; issues: string[] };

export function parseLabelOutput(raw: unknown): LabelParseResult {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, issues: ['Output is not valid JSON'] };
    }
  }
  const parsed = LabelScanOutputSchema.safeParse(data);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  return { ok: true, value: parsed.data };
}

/** The printed column as the seven nutrients, energy and sodium filled from kJ and salt when only those are printed. */
export function labelValues(n: LabelScanOutput['n']): NutrientValues {
  const kcal = n.kcal ?? (n.kj === null ? null : n.kj / KJ_PER_KCAL);
  const sodiumMg = n.na ?? (n.salt === null ? null : n.salt * SODIUM_MG_PER_G_SALT);
  return { kcal, proteinG: n.p, carbsG: n.c, fatG: n.f, fiberG: n.fib, sugarG: n.sug, sodiumMg };
}

/** Per 100 g from the printed column; null when the label is per serving and the serving weight is unknown. */
export function labelPer100g(out: Pick<LabelScanOutput, 'basis' | 'servingG' | 'n'>): NutrientValues | null {
  const values = labelValues(out.n);
  if (out.basis === 'per_100g') return values;
  const serving = positive(out.servingG);
  if (serving === null) return null;
  const scale = 100 / serving;
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === null ? null : v * scale])) as NutrientValues;
}

/** One serving when printed; else a small pack whole; else 100 g. */
export function labelGrams(out: Pick<LabelScanOutput, 'servingG' | 'packG'>): number {
  const serving = positive(out.servingG);
  const pack = positive(out.packG);
  const grams = serving ?? (pack !== null && pack <= SINGLE_PACK_MAX_G ? pack : 100);
  return round1(clamp(grams, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX));
}

export const labelSource = (barcode: string | null): NutritionSource => ({ type: 'package_label', recordId: null, name: null, reference: barcode });

export interface LabelNormaliseResult {
  status: 'rejected' | 'succeeded';
  analysis: MealAnalysis;
}

const isEmpty = (v: NutrientValues): boolean => v.kcal === null && v.proteinG === null && v.carbsG === null && v.fatG === null;

/** Validated label output → the stored analysis: one item, values as printed, `isEstimate` false. */
export function normaliseLabel(
  out: LabelScanOutput,
  opts: { barcode?: string | null; reaction?: Omit<ReactionInput, 'items'> & { content: ScanReactionContent } } = {},
): LabelNormaliseResult {
  const question = out.question === null ? null : trimTo(out.question, 200);
  const base = { isEstimate: false, notes: question, clarifyingQuestion: null, retakeReason: out.retake, assumptions: [] };
  const rejected = (outcome: 'no_food' | 'unclear'): LabelNormaliseResult => ({
    status: 'rejected',
    analysis: { ...base, outcome, isFood: outcome !== 'no_food', mealName: null, items: [], totals: computeMealTotals([]), reactionLineId: null },
  });
  if (out.status !== 'ok') return rejected(out.status);
  const raw = labelPer100g(out);
  // Per serving without a readable serving size cannot be scaled; nothing is guessed.
  if (raw === null || isEmpty(raw)) return rejected('unclear');
  const clean = sanitisePer100g(raw);
  if (isEmpty(clean.per100g)) return rejected('unclear');
  const grams = labelGrams(out);
  const name = trimTo(out.name ?? out.en ?? '', 120) || 'Packaged food';
  const item: AnalysedItem = {
    id: 'i0',
    name,
    canonicalName: out.en === null ? null : trimTo(out.en, 120),
    portion: out.servingText === null ? null : trimTo(out.servingText, 60),
    grams,
    ...nutrientsForGrams(clean.per100g, grams),
    per100g: clean.per100g,
    source: labelSource(opts.barcode ?? null),
    otherNutrients: [],
    richIn: [...new Set(out.rich)].slice(0, MAX_RICH_IN),
    processing: out.proc,
    preparation: null,
    role: 'single',
    excluded: false,
    countedIn: null,
    assumption: null,
    confidence: clean.kcalRecomputed ? 0.7 : 0.95,
    point: null,
    kcalRecomputed: clean.kcalRecomputed,
  };
  const reactionItems = [{ name: item.name, kcal: item.kcal ?? 0, proteinG: item.proteinG ?? 0, carbsG: item.carbsG ?? 0, excluded: false }];
  return {
    status: 'succeeded',
    analysis: {
      ...base,
      outcome: 'ok',
      isFood: true,
      mealName: name,
      items: [item],
      totals: computeMealTotals([item]),
      reactionLineId: opts.reaction ? chooseReactionLine(opts.reaction.content, { ...opts.reaction, items: reactionItems }) : null,
    },
  };
}

