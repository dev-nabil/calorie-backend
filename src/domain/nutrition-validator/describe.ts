/**
 * Text logging (POST /meals/describe): turns the model's per-100-gram answer into a draft the app can show and save.
 * The model says what each food is, how much was eaten and its density; every value the user sees is computed
 * here from one per-100-gram basis, so a per-100-gram number can never be shown as the total for the amount.
 */
import {
  AI_ESTIMATE,
  computeMealTotals,
  matchFoodRecord,
  normaliseFoodName,
  nutrientsForGrams,
  otherNutrientsFor,
  recordSource,
  sanitisePer100g,
  type FoodIndex,
} from '../food-nutrition';
import {
  ITEM_GRAMS_MAX,
  ITEM_GRAMS_MIN,
  MAX_MEAL_ITEMS,
  NUTRIENT_KEYS,
  type DescribeDraftItem,
  type DescribedItem,
  type DescribeUnit,
  type MealDescribeOutput,
  type MealDescribeResponse,
  type NutrientValues,
} from '../../shared';

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const trimTo = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** Grams per unit for amounts the server converts itself. Liquids count 1 ml as 1 g (water-like drinks). */
const GRAMS_PER_UNIT: Partial<Record<DescribeUnit, number>> = { g: 1, kg: 1000, ml: 1, l: 1000 };

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
const toAsciiDigits = (s: string): string => s.replace(/[০-৯]/g, (d) => String(BENGALI_DIGITS.indexOf(d)));

/**
 * Weights and volumes written as numbers in the text ("215 g", "1.5 kg", "250ml", "২১৫ গ্রাম"), in grams.
 * Words like "a glass" are not weights; the model handles those.
 */
export function explicitWeights(text: string): number[] {
  const t = toAsciiDigits(text.toLowerCase());
  const re = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilo(?:gram)?s?|g|gm|gms|grams?|gr|ml|millilit(?:re|er)s?|l|lit(?:re|er)s?|কেজি|গ্রাম|গ্রা|মিলি(?:লিটার)?|লিটার)(?![\p{L}\p{M}])/gu;
  const out: number[] = [];
  for (const m of t.matchAll(re)) {
    const n = Number(m[1]!.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) continue;
    const u = m[2]!;
    const factor = /^(kg|kilo|কেজি)/.test(u) || /^(l|lit|লিটার)/.test(u) ? 1000 : 1;
    out.push(round1(n * factor));
  }
  return out;
}

type OutItem = MealDescribeOutput['items'][number];

/** Grams for one item: a stated weight or volume is converted here; everything else is the model's estimate. */
function itemGrams(raw: OutItem): { grams: number; stated: boolean } {
  const factor = raw.unit ? GRAMS_PER_UNIT[raw.unit] : undefined;
  if (raw.stated && factor && raw.qty !== null && Number.isFinite(raw.qty) && raw.qty > 0) return { grams: raw.qty * factor, stated: true };
  return { grams: Number.isFinite(raw.g) ? raw.g : 0, stated: raw.stated && raw.qty !== null };
}

/** A usable per-100-gram basis sent back from the draft: every core value known and inside real-food limits. */
function draftBasis(item: DescribeDraftItem | undefined): NutrientValues | null {
  if (!item?.per100g) return null;
  const clean = sanitisePer100g(item.per100g).per100g;
  return clean.kcal === null ? null : clean;
}

function draftFor(draft: DescribeDraftItem[], raw: OutItem): DescribeDraftItem | undefined {
  const names = new Set([normaliseFoodName(raw.name), normaliseFoodName(raw.en)]);
  return draft.find((d) => names.has(normaliseFoodName(d.name)));
}

export interface DescribeOptions {
  records?: FoodIndex;
  /** The unsaved draft the user is correcting. */
  draft?: DescribeDraftItem[];
  /** The newest message: a lone weight in it is the amount of a lone food. */
  text?: string;
}

const NO_RECORDS: FoodIndex = { byAlias: new Map(), sources: {} };

/**
 * Validated model output → the draft returned to the app. A published record replaces the model's density when
 * the name matches; otherwise the same food in the draft keeps its basis, so "Actually, it was 150 g" only changes
 * the weight. Impossible densities become unknown, never zero.
 */
export function normaliseDescribe(out: MealDescribeOutput, opts: DescribeOptions = {}): MealDescribeResponse {
  const records = opts.records ?? NO_RECORDS;
  const draft = opts.draft ?? [];
  const raws = out.status === 'not_food' ? [] : out.items.filter((i) => trimTo(i.name, 120) !== null).slice(0, MAX_MEAL_ITEMS);

  const items: DescribedItem[] = raws.map((raw, i) => {
    const amount = itemGrams(raw);
    const grams = round1(clamp(amount.grams, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX));
    const record = matchFoodRecord(records, [raw.en, raw.name], raw.prep);
    const fromDraft = record ? null : draftBasis(draftFor(draft, raw));
    const model = sanitisePer100g({ kcal: raw.n.kcal, proteinG: raw.n.p, carbsG: raw.n.c, fatG: raw.n.f, fiberG: raw.n.fib, sugarG: raw.n.sug, sodiumMg: raw.n.na });
    const per100g = record?.per100g ?? fromDraft ?? model.per100g;
    return {
      id: `d${i}`,
      name: trimTo(raw.name, 120)!,
      canonicalName: trimTo(raw.en, 120),
      portion: trimTo(raw.portion, 60),
      grams,
      ...nutrientsForGrams(per100g, grams),
      per100g,
      source: record ? recordSource(records, record) : AI_ESTIMATE,
      otherNutrients: otherNutrientsFor(record, grams),
      richIn: [],
      processing: raw.proc,
      preparation: raw.prep,
      role: 'single',
      excluded: false,
      countedIn: null,
      assumption: trimTo(raw.assume, 140),
      confidence: clamp(Number.isFinite(raw.conf) ? raw.conf : 0.5, 0, 1),
      point: null,
      kcalRecomputed: !record && !fromDraft && model.kcalRecomputed,
      quantityStated: amount.stated,
    };
  });

  // Safety net for the most common case: one food and one written weight ("I ate 215 g of chicken pizza",
  // "Actually, it was 150 g"). If the model did not mark the amount as stated, the written weight wins.
  const weights = explicitWeights(opts.text ?? '');
  const only = items.length === 1 ? items[0]! : null;
  if (only && weights.length === 1 && !only.quantityStated) {
    const grams = round1(clamp(weights[0]!, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX));
    const k = only.grams > 0 ? grams / only.grams : 1;
    Object.assign(only, nutrientsForGrams(only.per100g, grams), {
      grams,
      quantityStated: true,
      otherNutrients: only.otherNutrients.map((o) => ({ ...o, amount: round1(o.amount * k) })),
    });
  }

  const status = !items.length ? (out.status === 'needs_info' && out.question ? 'needs_info' : 'not_food') : out.status === 'needs_info' ? 'needs_info' : 'ok';
  const name = trimTo(out.mealName, 120) ?? (items.length ? items.map((i) => i.name).slice(0, 3).join(', ').slice(0, 120) : null);
  return {
    status,
    mealName: items.length ? name : null,
    items,
    totals: computeMealTotals(items),
    // ok means nothing to ask; the other two always carry a question when the model wrote one.
    clarifyingQuestion: status === 'ok' ? null : trimTo(out.question, 200),
    category: out.category,
    day: out.day,
  };
}

/** True when every core nutrient of every item is a finite, non-negative number or null (a last check before replying). */
export function describeValuesSane(r: MealDescribeResponse): boolean {
  return r.items.every((i) => i.grams >= ITEM_GRAMS_MIN && i.grams <= ITEM_GRAMS_MAX && NUTRIENT_KEYS.every((k) => i[k] === null || (Number.isFinite(i[k]) && (i[k] as number) >= 0)));
}
