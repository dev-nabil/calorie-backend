/**
 * Nutrition arithmetic and food-record matching. Everything a user sees is derived here from one
 * per-100-gram basis, so a portion change never needs a model and unknown stays unknown.
 */
import {
  ITEM_GRAMS_MAX,
  ITEM_GRAMS_MIN,
  NUTRIENT_KEYS,
  type AnalysedItem,
  type FoodPreparation,
  type MealTotals,
  type NutrientKey,
  type NutrientValues,
  type NutritionSource,
  type OtherNutrient,
  type OtherNutrientKey,
} from '../../shared';

const round0 = (n: number): number => Math.round(n);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** kcal and sodium are whole numbers; grams of nutrient keep one decimal. */
const roundFor = (key: NutrientKey, n: number): number => (key === 'kcal' || key === 'sodiumMg' ? round0(n) : round1(n));

export const emptyNutrients = (): NutrientValues => ({ kcal: null, proteinG: null, carbsG: null, fatG: null, fiberG: null, sugarG: null, sodiumMg: null });

/** Item values for a weight. A null basis value stays null, whatever the weight. */
export function nutrientsForGrams(per100g: NutrientValues, grams: number): NutrientValues {
  const out = emptyNutrients();
  for (const key of NUTRIENT_KEYS) {
    const v = per100g[key];
    out[key] = v === null ? null : roundFor(key, (v * grams) / 100);
  }
  return out;
}

/** Basis recovered from item values, for foods that arrive without one (text parse). */
export function per100gFromValues(values: NutrientValues, grams: number): NutrientValues {
  const out = emptyNutrients();
  if (grams <= 0) return out;
  for (const key of NUTRIENT_KEYS) {
    const v = values[key];
    out[key] = v === null ? null : round1((v * 100) / grams);
  }
  return out;
}

export interface CountableItem extends Partial<Record<NutrientKey, number | null>> {
  excluded?: boolean;
}

/**
 * Meal totals: excluded items are skipped; each nutrient sums what is known, and any nutrient unknown
 * on a counted item is listed in `incomplete`. With no counted item the meal is an empty zero.
 */
export function computeMealTotals(items: CountableItem[], multiplier = 1): MealTotals {
  const counted = items.filter((i) => !i.excluded);
  const totals: MealTotals = { ...emptyNutrients(), incomplete: [] };
  for (const key of NUTRIENT_KEYS) {
    const known = counted.map((i) => i[key]).filter((v): v is number => typeof v === 'number');
    if (known.length < counted.length) totals.incomplete.push(key);
    totals[key] = known.length || !counted.length ? roundFor(key, known.reduce((a, b) => a + b, 0) * multiplier) : null;
  }
  return totals;
}

/** Upper bounds for a real food per 100 g: pure fat is 900 kcal, table salt about 39,000 mg sodium. */
const PER_100G_MAX: Record<NutrientKey, number> = { kcal: 900, proteinG: 100, carbsG: 100, fatG: 100, fiberG: 100, sugarG: 100, sodiumMg: 40_000 };

/** Tolerance before stated energy is replaced by 4P + 4C + 9F (plan 8.3 rule 4). */
export const KCAL_TOLERANCE = 0.2;

/** Impossible values become unknown instead of being trusted. Energy far from the macros is recomputed. */
export function sanitisePer100g(raw: NutrientValues): { per100g: NutrientValues; kcalRecomputed: boolean } {
  const per100g = emptyNutrients();
  for (const key of NUTRIENT_KEYS) {
    const v = raw[key];
    per100g[key] = v !== null && Number.isFinite(v) && v >= 0 && v <= PER_100G_MAX[key] ? round1(v) : null;
  }
  const { proteinG: p, carbsG: c, fatG: f, kcal } = per100g;
  if (p === null || c === null || f === null) return { per100g, kcalRecomputed: false };
  if (p + c + f > 105) return { per100g: { ...per100g, proteinG: null, carbsG: null, fatG: null }, kcalRecomputed: false };
  const macroKcal = 4 * p + 4 * c + 9 * f;
  if (kcal === null || Math.abs(kcal - macroKcal) <= KCAL_TOLERANCE * macroKcal) return { per100g, kcalRecomputed: false };
  return { per100g: { ...per100g, kcal: round1(macroKcal) }, kcalRecomputed: true };
}

export interface FoodRecord {
  id: string;
  source: string;
  sourceRef: string;
  sourceName: string;
  kind: 'single' | 'mixed_dish';
  aliases: string[];
  preparations: FoodPreparation[];
  per100g: NutrientValues;
  other: Partial<Record<OtherNutrientKey, number>>;
}

export interface FoodSourceInfo {
  name: string;
}

export interface FoodIndex {
  byAlias: Map<string, FoodRecord[]>;
  sources: Record<string, FoodSourceInfo>;
}

/** Lowercase, punctuation and repeated spaces removed. Bangla letters are kept. */
export function normaliseFoodName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildFoodIndex(records: FoodRecord[], sources: Record<string, FoodSourceInfo>): FoodIndex {
  const byAlias = new Map<string, FoodRecord[]>();
  for (const r of records) {
    for (const alias of r.aliases) {
      const key = normaliseFoodName(alias);
      byAlias.set(key, [...(byAlias.get(key) ?? []), r]);
    }
  }
  return { byAlias, sources };
}

/** Exact name and matching preparation only: a near miss is an AI estimate, not a wrong record. */
export function matchFoodRecord(index: FoodIndex, names: Array<string | null | undefined>, preparation: FoodPreparation): FoodRecord | null {
  for (const name of names) {
    if (!name) continue;
    const hit = index.byAlias.get(normaliseFoodName(name))?.find((r) => r.preparations.includes(preparation));
    if (hit) return hit;
  }
  return null;
}

export const AI_ESTIMATE: NutritionSource = { type: 'ai_estimate', recordId: null, name: null, reference: null };
export const USER_ENTERED: NutritionSource = { type: 'user_entered', recordId: null, name: null, reference: null };
export const ADJUSTED_ESTIMATE: NutritionSource = { type: 'adjusted_estimate', recordId: null, name: null, reference: null };

export function recordSource(index: FoodIndex, r: FoodRecord): NutritionSource {
  return { type: 'verified_record', recordId: r.id, name: index.sources[r.source]?.name ?? r.source, reference: r.sourceRef };
}

export function otherNutrientsFor(record: Pick<FoodRecord, 'other'> | null, grams: number): OtherNutrient[] {
  if (!record) return [];
  return Object.entries(record.other).map(([key, per100]) => ({ key: key as OtherNutrientKey, amount: round1(((per100 ?? 0) * grams) / 100) }));
}

/** Ingredients a mixed dish already contains, by its name. Used when the model lists both as separate foods. */
const DISH_CONTENTS: Array<{ dish: RegExp; contains: RegExp }> = [
  { dish: /\b(biryani|biriyani|tehari|tehri)\b/, contains: /\b(rice|chicken|mutton|beef|potato|oil|ghee)\b/ },
  { dish: /\b(khichuri|khichdi|khichri)\b/, contains: /\b(rice|dal|daal|lentils?|oil|ghee)\b/ },
  { dish: /\b(pulao|polao|pilaf)\b/, contains: /\b(rice|oil|ghee)\b/ },
  { dish: /\b(curry|bhuna|jhol|dal|daal|korma|rezala)\b/, contains: /\b(oil|ghee|gravy)\b/ },
];

/** True when `item` is an ingredient the named dish already includes. */
export function isInsideDish(dishName: string, itemName: string): boolean {
  const dish = normaliseFoodName(dishName);
  const item = normaliseFoodName(itemName);
  if (!dish || !item || dish === item) return false;
  return DISH_CONTENTS.some((d) => d.dish.test(dish) && d.contains.test(item) && !d.dish.test(item));
}

/** A food added by text after the scan: the client holds its basis, the server still does the arithmetic. */
export function addedItem(a: { name: string; grams: number; per100g: NutrientValues; excluded?: boolean }, index: number): AnalysedItem {
  const grams = clamp(a.grams, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX);
  return {
    id: `a${index}`,
    name: a.name,
    canonicalName: null,
    portion: null,
    grams: round1(grams),
    ...nutrientsForGrams(a.per100g, grams),
    per100g: a.per100g,
    source: AI_ESTIMATE,
    otherNutrients: [],
    richIn: [],
    preparation: null,
    role: 'single',
    excluded: Boolean(a.excluded),
    countedIn: null,
    assumption: null,
    confidence: 0.5,
    point: null,
    kcalRecomputed: false,
  };
}

export interface ItemCorrection {
  name?: string;
  grams?: number;
  preparation?: FoodPreparation;
  excluded?: boolean;
}

export interface CorrectionResult {
  item: AnalysedItem;
  /** Renamed or re-prepared with no matching record: the nutrition is still the earlier estimate. */
  stale: boolean;
}

/** User corrections on a stored item. A changed identity looks for a record; it never calls a model. */
export function applyItemCorrection(base: AnalysedItem, c: ItemCorrection, index: FoodIndex): CorrectionResult {
  const name = c.name?.trim() || base.name;
  const preparation = c.preparation ?? base.preparation ?? 'unknown';
  const grams = clamp(c.grams ?? base.grams, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX);
  const renamed = name !== base.name;
  // Values read off a pack or a product database belong to that product: a new name is only a label.
  const fromPack = base.source.type === 'package_label' || base.source.type === 'product_database';
  const identityChanged = !fromPack && (renamed || preparation !== (base.preparation ?? 'unknown'));
  let per100g = base.per100g;
  let source = base.source;
  let other: Pick<FoodRecord, 'other'> | null = null;
  let stale = false;
  if (identityChanged) {
    const record = matchFoodRecord(index, renamed ? [name] : [base.canonicalName, name], preparation);
    if (record) {
      per100g = record.per100g;
      source = recordSource(index, record);
      other = record;
    } else {
      source = ADJUSTED_ESTIMATE;
      stale = true;
    }
  }
  const otherNutrients = identityChanged
    ? otherNutrientsFor(other, grams)
    : base.otherNutrients.map((o) => ({ ...o, amount: base.grams > 0 ? round1((o.amount * grams) / base.grams) : o.amount }));
  return {
    item: {
      ...base,
      name,
      canonicalName: renamed ? null : base.canonicalName,
      preparation,
      grams: round1(grams),
      per100g,
      source,
      otherNutrients,
      // A renamed food is another food: the old one's vitamins no longer apply. Scans stored before richIn have none.
      richIn: renamed && !fromPack ? [] : (base.richIn ?? []),
      excluded: c.excluded ?? base.excluded,
      ...nutrientsForGrams(per100g, grams),
    },
    stale,
  };
}
