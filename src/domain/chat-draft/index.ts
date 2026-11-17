/**
 * Milo buddy drafts (decision 0016): the recipe or meal a person builds in chat. Pure. Every value comes from one per-100-gram
 * basis per food (domain/food-nutrition, the code scans, /meals/describe and POST /meals use); a published record beats the
 * model's basis; unknown stays null, never zero.
 *
 * Recipe arithmetic: the whole dish (`recipe.totals`) is kept apart from what the person ate (`portionTotals`). A portion is
 * a share of the whole: servings ÷ servings made, a fraction, or cooked grams ÷ the cooked weight. Grams are never divided by
 * the raw ingredient weight: without the cooked weight a gram portion is not computable and the draft asks for it.
 */
import {
  ADJUSTED_ESTIMATE,
  AI_ESTIMATE,
  computeMealTotals,
  emptyNutrients,
  matchFoodRecord,
  nutrientsForGrams,
  recordSource,
  sanitisePer100g,
  type FoodIndex,
} from '../food-nutrition';
import type { LocaleCode } from '../../shared/locales';
import {
  BUDDY_LIMITS,
  ITEM_GRAMS_MAX,
  ITEM_GRAMS_MIN,
  NUTRIENT_KEYS,
  PORTION_MULTIPLIER_MAX,
  PORTION_MULTIPLIER_MIN,
  type Assumption,
  type ChatDraft,
  type CreateMealRequest,
  type DescribeUnit,
  type DraftEditOp,
  type DraftItem,
  type DraftKind,
  type InterpretOp,
  type MealCategory,
  type MealItemInput,
  type MealTotals,
  type NutrientValues,
  type Portion,
} from '../../shared';

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const finitePositive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const trimTo = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** Grams per unit for amounts the server converts itself (1 ml = 1 g, as /meals/describe). */
export const GRAMS_PER_UNIT: Partial<Record<DescribeUnit, number>> = { g: 1, kg: 1000, ml: 1, l: 1000 };

const NO_RECORDS: FoodIndex = { byAlias: new Map(), sources: {} };

export interface DraftContext {
  records?: FoodIndex;
  /** New draft ids (uuid in the service, fixed in tests). */
  newId: () => string;
  conversationId: string;
  now: Date;
  /** The request's language: unit words in `quantity.text` follow it (English when absent). */
  locale?: LocaleCode;
}

// ── Items ──────────────────────────────────────────────────────────────────────────────────────────

function nextItemId(items: readonly DraftItem[]): string {
  const max = items.reduce((m, i) => Math.max(m, Number(/^i(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
  return `i${max + 1}`;
}

/** Grams for an op: a written weight or volume (g, kg, ml, l) is converted here; anything else is the model's edible grams. */
export function opGrams(op: Pick<InterpretOp, 'qty' | 'unit' | 'g' | 'stated'>): { grams: number; stated: boolean } | null {
  const factor = op.unit ? GRAMS_PER_UNIT[op.unit] : undefined;
  if (factor && finitePositive(op.qty)) return { grams: op.qty * factor, stated: op.stated !== false };
  if (finitePositive(op.g)) return { grams: op.g, stated: Boolean(op.stated) && op.qty !== null };
  return null;
}

/** Counted units read in the plural above one ("2 pieces"); weights and spoons keep their short form. */
const PLURAL_UNITS: ReadonlySet<string> = new Set(['piece', 'slice', 'cup', 'glass', 'bowl', 'plate', 'serving']);

/** Bangla unit words as the app's Bangla copy writes them (টুকরো, গ্রাম, কেজি, মি.লি., লিটার, সার্ভিং); Bangla has no plural. */
const BN_UNITS: Readonly<Record<Exclude<DescribeUnit, 'other'>, string>> = {
  g: 'গ্রাম',
  kg: 'কেজি',
  ml: 'মি.লি.',
  l: 'লিটার',
  piece: 'টুকরো',
  slice: 'স্লাইস',
  cup: 'কাপ',
  glass: 'গ্লাস',
  bowl: 'বাটি',
  plate: 'প্লেট',
  tbsp: 'টেবিল চামচ',
  tsp: 'চা চামচ',
  serving: 'সার্ভিং',
};

/** "2 pieces", "1 slice", "150 g" ("2 টুকরো", "150 গ্রাম" in Bangla); an amount in no unit of ours ("other") reads as its grams. */
export const quantityText = (op: Pick<InterpretOp, 'qty' | 'unit'>, grams: number, locale?: LocaleCode): string => {
  const bn = locale === 'bn';
  if (op.qty === null || !op.unit || op.unit === 'other') return `${round1(grams)} ${bn ? BN_UNITS.g : 'g'}`;
  if (bn) return `${op.qty} ${BN_UNITS[op.unit]}`;
  const unit = op.qty !== 1 && PLURAL_UNITS.has(op.unit) ? (op.unit === 'glass' ? 'glasses' : `${op.unit}s`) : op.unit;
  return `${op.qty} ${unit}`;
};

/** The per-100-gram basis for a food: a matching record (not for weights with the bone in), else the model's sanitised values. */
function basisFor(op: InterpretOp, records: FoodIndex): { per100g: NutrientValues; source: DraftItem['source'] } {
  const record = op.bone === 'in' ? null : matchFoodRecord(records, [op.en, op.name], op.prep ?? 'unknown');
  if (record) return { per100g: record.per100g, source: recordSource(records, record) };
  const n = op.n;
  const model = sanitisePer100g({ kcal: n?.kcal ?? null, proteinG: n?.p ?? null, carbsG: n?.c ?? null, fatG: n?.f ?? null, fiberG: n?.fib ?? null, sugarG: n?.sug ?? null, sodiumMg: n?.na ?? null });
  return { per100g: model.per100g, source: AI_ESTIMATE };
}

/** A new draft item from an add_item op; null when it has no name or no amount (the reply then asks). */
export function itemFromOp(op: InterpretOp, id: string, records: FoodIndex = NO_RECORDS, locale?: LocaleCode): DraftItem | null {
  const name = trimTo(op.name ?? op.en, 120);
  const amount = opGrams(op);
  if (!name || !amount) return null;
  const grams = round1(clamp(amount.grams, ITEM_GRAMS_MIN, BUDDY_LIMITS.recipeItemGramsMax));
  const { per100g, source } = basisFor(op, records);
  return withValues({
    id,
    name,
    canonicalName: trimTo(op.en, 120),
    quantity: { value: op.qty ?? null, unit: op.unit ?? null, text: quantityText(op, grams, locale) },
    grams,
    quantityStated: amount.stated,
    state: op.state ?? null,
    bone: op.bone ?? null,
    preparation: op.prep ?? null,
    processing: op.proc ?? null,
    ...emptyNutrients(),
    per100g,
    source,
    assumption: trimTo(op.assume, 140),
  });
}

/** Item values from its basis and grams (the only way values are set). */
export function withValues(item: DraftItem): DraftItem {
  return { ...item, ...nutrientsForGrams(item.per100g, item.grams) };
}

// ── Draft lifecycle ────────────────────────────────────────────────────────────────────────────────

export function newDraft(kind: DraftKind, name: string | null, ctx: DraftContext): ChatDraft {
  return recompute({
    id: ctx.newId(),
    conversationId: ctx.conversationId,
    version: 1,
    kind,
    status: 'open',
    name: trimTo(name, 120) ?? '',
    items: [],
    recipe: null,
    portion: null,
    portionTotals: null,
    portionGrams: null,
    gramsBasis: null,
    totals: computeMealTotals([]),
    assumptions: [],
    pending: null,
    savedRecipeId: null,
    logs: [],
    updatedAt: ctx.now.toISOString(),
  });
}

/** Scales every nutrient of a total; unknown stays unknown. */
export function scaleTotals(t: MealTotals, f: number): MealTotals {
  const out = { ...t, incomplete: [...t.incomplete] };
  for (const k of NUTRIENT_KEYS) {
    const v = t[k];
    out[k] = v === null ? null : k === 'kcal' || k === 'sodiumMg' ? Math.round(v * f) : round1(v * f);
  }
  return out;
}

/** Per 100 g of a total spread over `grams`; nutrients unknown for any item stay unknown. Not rounded (the diary rounds). */
export function per100gOfTotals(t: MealTotals, grams: number): NutrientValues {
  const out = emptyNutrients();
  if (!(grams > 0)) return out;
  for (const k of NUTRIENT_KEYS) {
    const v = t[k];
    out[k] = v === null || t.incomplete.includes(k) ? null : Math.round(((v * 100) / grams) * 10_000) / 10_000;
  }
  return out;
}

/** The share of the whole the person ate, or why it cannot be worked out yet. */
export function portionFraction(d: Pick<ChatDraft, 'kind' | 'portion' | 'recipe'>): { fraction: number | null; pending: 'portion' | 'yield' | null } {
  const p = d.portion;
  if (!p) return d.kind === 'meal' ? { fraction: 1, pending: null } : { fraction: null, pending: 'portion' };
  if (p.kind === 'all') return { fraction: 1, pending: null };
  if (p.kind === 'fraction') return finitePositive(p.fraction) ? { fraction: Math.min(1, p.fraction), pending: null } : { fraction: null, pending: 'portion' };
  if (p.kind === 'servings') {
    const made = d.recipe?.servings ?? null;
    return finitePositive(p.servings) && finitePositive(made) ? { fraction: Math.min(1, p.servings / made), pending: null } : { fraction: null, pending: 'portion' };
  }
  const yieldG = d.recipe?.cookedYieldG ?? null;
  if (!finitePositive(p.grams)) return { fraction: null, pending: 'portion' };
  return finitePositive(yieldG) ? { fraction: Math.min(1, p.grams / yieldG), pending: null } : { fraction: null, pending: 'yield' };
}

/** Recomputes every derived value of a draft from its items, recipe facts and portion. */
export function recompute(d: ChatDraft): ChatDraft {
  const items = d.items.map(withValues);
  const totals = computeMealTotals(items);
  const rawWeightG = round1(items.reduce((s, i) => s + i.grams, 0));
  const recipe =
    d.kind === 'recipe'
      ? {
          servings: d.recipe?.servings ?? null,
          cookedYieldG: d.recipe?.cookedYieldG ?? null,
          rawWeightG,
          totals,
          per100gCooked: d.recipe?.cookedYieldG ? per100gOfTotals(totals, d.recipe.cookedYieldG) : null,
        }
      : null;
  const next: ChatDraft = { ...d, items, totals, recipe };
  const { fraction, pending } = portionFraction(next);
  const basisG = recipe?.cookedYieldG ?? rawWeightG;
  const assumptions: Assumption[] = [];
  for (const i of items) {
    if (!i.quantityStated) assumptions.push({ code: 'amount_assumed', itemId: i.id, text: null });
    if (i.source.type === 'ai_estimate' || i.source.type === 'adjusted_estimate') assumptions.push({ code: 'basis_assumed', itemId: i.id, text: null });
    if (i.assumption) assumptions.push({ code: 'text', itemId: i.id, text: i.assumption });
  }
  if (recipe && !recipe.cookedYieldG && items.length) {
    assumptions.push({ code: 'yield_unknown', itemId: null, text: null });
    if (fraction !== null) assumptions.push({ code: 'raw_share_weight', itemId: null, text: null });
  }
  return {
    ...next,
    portionTotals: fraction === null || !items.length ? null : scaleTotals(totals, fraction),
    portionGrams: fraction === null || !items.length ? null : round1(basisG * fraction),
    gramsBasis: fraction === null || !items.length ? null : recipe?.cookedYieldG ? 'cooked' : 'raw_share',
    assumptions,
    pending: !items.length ? null : pending ? { code: pending, itemId: null } : null,
  };
}

// ── Model ops (step 2 of a turn) ───────────────────────────────────────────────────────────────────

export interface OpsResult {
  draft: ChatDraft | null;
  /** The active draft was replaced by a new one (the service parks the previous one). */
  parked: ChatDraft | null;
  changed: boolean;
  /** Items the reference could mean: the reply asks which (never a guess). */
  ambiguous: string[] | null;
  /** Ops that were dropped, with why (the reply model is told). */
  rejected: { op: string; reason: 'no_draft' | 'unknown_item' | 'no_amount' | 'limit' | 'invalid' }[];
  /** A load_recipe op: the service loads it (needs the database). */
  loadRecipeId: string | null;
}

/** Which item an update/remove means: the named id, or the only item; ambiguous otherwise. */
export function resolveTarget(d: ChatDraft, itemId: string | null): { item: DraftItem } | { ambiguous: string[] } | null {
  if (itemId) {
    const hit = d.items.find((i) => i.id === itemId);
    if (hit) return { item: hit };
  }
  if (d.items.length === 1) return { item: d.items[0]! };
  if (d.items.length > 1) return { ambiguous: d.items.map((i) => i.id) };
  return null;
}

function portionFromOp(op: InterpretOp, d: ChatDraft): Portion | null {
  const v = op.value;
  switch (op.portionKind) {
    case 'all':
      return { kind: 'all', servings: null, fraction: null, grams: null };
    case 'fraction':
      return finitePositive(v) && v <= 1 ? { kind: 'fraction', servings: null, fraction: Math.max(0.01, v), grams: null } : null;
    case 'servings':
      return finitePositive(v) && v <= BUDDY_LIMITS.servingsMax ? { kind: 'servings', servings: v, fraction: null, grams: null } : null;
    case 'grams': {
      if (!finitePositive(v) || v > BUDDY_LIMITS.cookedYieldMaxG) return null;
      const y = d.recipe?.cookedYieldG;
      return y && v > y ? null : { kind: 'grams', servings: null, fraction: null, grams: v };
    }
    default:
      return null;
  }
}

/** Applies validated model ops in order; at most one version bump. Ops that name an unknown item never guess. */
export function applyModelOps(current: ChatDraft | null, ops: readonly InterpretOp[], ctx: DraftContext, defaultKind: DraftKind = 'meal'): OpsResult {
  const records = ctx.records ?? NO_RECORDS;
  const res: OpsResult = { draft: current, parked: null, changed: false, ambiguous: null, rejected: [], loadRecipeId: null };
  let d: ChatDraft | null = current ? structuredClone(current) : null;
  const touch = () => {
    res.changed = true;
  };
  const ensure = (kind: DraftKind): ChatDraft => {
    if (!d || d.status === 'discarded') {
      d = newDraft(kind, null, ctx);
      touch();
    }
    return d;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'start_draft': {
        const kind = op.kind ?? defaultKind;
        if (d && d.items.length && d.status !== 'discarded') {
          res.parked = res.parked ?? current;
        }
        if (!d || d.items.length || d.status === 'discarded' || d.kind !== kind) d = newDraft(kind, op.name, ctx);
        else if (op.name) d.name = trimTo(op.name, 120) ?? d.name;
        touch();
        break;
      }
      case 'add_item': {
        // A meal already in the diary is not reopened by "I also had…": that is a new entry (the old card is parked).
        if (d && d.kind === 'meal' && d.status === 'logged' && d.id === current?.id) {
          res.parked = current;
          d = newDraft('meal', null, ctx);
        }
        const draft = ensure(defaultKind);
        if (draft.items.length >= BUDDY_LIMITS.draftItems) {
          res.rejected.push({ op: op.op, reason: 'limit' });
          break;
        }
        const item = itemFromOp(op, nextItemId(draft.items), records, ctx.locale);
        if (!item) {
          res.rejected.push({ op: op.op, reason: 'no_amount' });
          break;
        }
        if (draft.kind === 'meal' && item.grams > ITEM_GRAMS_MAX) item.grams = ITEM_GRAMS_MAX;
        draft.items.push(withValues(item));
        if (!draft.name) draft.name = item.name;
        touch();
        break;
      }
      case 'update_item':
      case 'remove_item': {
        if (!d) {
          res.rejected.push({ op: op.op, reason: 'no_draft' });
          break;
        }
        const target = resolveTarget(d, op.itemId);
        if (!target) {
          res.rejected.push({ op: op.op, reason: 'unknown_item' });
          break;
        }
        if ('ambiguous' in target) {
          res.ambiguous = target.ambiguous;
          break;
        }
        if (op.op === 'remove_item') {
          d.items = d.items.filter((i) => i.id !== target.item.id);
          touch();
          break;
        }
        const updated = updateItem(target.item, op, records, ctx.locale);
        if (!updated) {
          res.rejected.push({ op: op.op, reason: 'invalid' });
          break;
        }
        d.items = d.items.map((i) => (i.id === target.item.id ? updated : i));
        touch();
        break;
      }
      case 'set_servings': {
        const n = op.count ?? op.value;
        if (!d || !finitePositive(n) || n > BUDDY_LIMITS.servingsMax) {
          res.rejected.push({ op: op.op, reason: d ? 'invalid' : 'no_draft' });
          break;
        }
        d.kind = 'recipe';
        d.recipe = { ...(d.recipe ?? emptyRecipe()), servings: Math.round(n) };
        touch();
        break;
      }
      case 'set_yield': {
        const g = op.value ?? op.g;
        if (!d || !finitePositive(g) || g > BUDDY_LIMITS.cookedYieldMaxG) {
          res.rejected.push({ op: op.op, reason: d ? 'invalid' : 'no_draft' });
          break;
        }
        d.kind = 'recipe';
        d.recipe = { ...(d.recipe ?? emptyRecipe()), cookedYieldG: round1(g) };
        touch();
        break;
      }
      case 'set_portion': {
        if (!d) {
          res.rejected.push({ op: op.op, reason: 'no_draft' });
          break;
        }
        const p = portionFromOp(op, d);
        if (!p) {
          res.rejected.push({ op: op.op, reason: 'invalid' });
          break;
        }
        d.portion = p;
        touch();
        break;
      }
      case 'rename': {
        const name = trimTo(op.name, 120);
        if (!d || !name) {
          res.rejected.push({ op: op.op, reason: d ? 'invalid' : 'no_draft' });
          break;
        }
        d.name = name;
        touch();
        break;
      }
      case 'load_recipe':
        if (op.recipeId) res.loadRecipeId = op.recipeId;
        else res.rejected.push({ op: op.op, reason: 'invalid' });
        break;
    }
  }
  if (res.changed && d) {
    const isNew = !current || d.id !== current.id;
    d = recompute({ ...d, version: isNew ? 1 : current!.version + 1, updatedAt: ctx.now.toISOString() });
  }
  res.draft = d;
  return res;
}

const emptyRecipe = (): NonNullable<ChatDraft['recipe']> => ({ servings: null, cookedYieldG: null, rawWeightG: 0, totals: computeMealTotals([]), per100gCooked: null });

/** An update_item op on one item: amount, raw/cooked, bone, or a different food (new basis). */
export function updateItem(item: DraftItem, op: InterpretOp, records: FoodIndex = NO_RECORDS, locale?: LocaleCode): DraftItem | null {
  const next: DraftItem = { ...item, quantity: { ...item.quantity } };
  const amount = op.qty !== null || op.g !== null ? opGrams(op) : null;
  if ((op.qty !== null || op.g !== null) && !amount) return null;
  if (amount) {
    next.grams = round1(clamp(amount.grams, ITEM_GRAMS_MIN, BUDDY_LIMITS.recipeItemGramsMax));
    next.quantityStated = amount.stated || op.stated === true;
    next.quantity = { value: op.qty ?? null, unit: op.unit ?? null, text: quantityText(op, next.grams, locale) };
  }
  if (op.state) next.state = op.state;
  if (op.bone) next.bone = op.bone;
  if (op.prep) next.preparation = op.prep;
  const renamed = trimTo(op.name, 120);
  const otherFood = renamed !== null && renamed.toLowerCase() !== item.name.toLowerCase();
  if (otherFood || op.bone === 'in' || op.n) {
    // A different food, or now weighed with the bone: a new basis (record or the model's), never the old one.
    const basis = basisFor({ ...op, name: renamed ?? item.name, en: op.en ?? item.canonicalName, prep: op.prep ?? item.preparation, bone: next.bone }, records);
    const hasModel = op.n !== null && op.n !== undefined;
    if (basis.source.type !== 'ai_estimate' || hasModel) {
      next.per100g = basis.per100g;
      next.source = basis.source;
    } else if (otherFood) {
      next.source = ADJUSTED_ESTIMATE;
    }
    if (renamed) next.name = renamed;
    if (op.en) next.canonicalName = trimTo(op.en, 120);
  }
  if (op.assume !== null && op.assume !== undefined) next.assumption = trimTo(op.assume, 140);
  return withValues(next);
}

// ── Card edits (PATCH /conversations/{id}/draft) ──────────────────────────────────────────────────

export type EditResult = { ok: true; draft: ChatDraft } | { ok: false; field: string; reason: string };

/** Deterministic edits from the card; all or nothing, one version bump. */
export function applyEdits(current: ChatDraft, ops: readonly DraftEditOp[], now: Date, locale?: LocaleCode): EditResult {
  const d = structuredClone(current);
  for (const op of ops) {
    const item = op.itemId ? d.items.find((i) => i.id === op.itemId) : undefined;
    switch (op.op) {
      case 'update_item':
        if (!item || op.grams === undefined) return { ok: false, field: 'itemId', reason: 'unknown_item' };
        if (d.kind === 'meal' && op.grams > ITEM_GRAMS_MAX) return { ok: false, field: 'grams', reason: 'too_large' };
        item.grams = round1(op.grams);
        item.quantity = { value: round1(op.grams), unit: 'g', text: quantityText({ qty: round1(op.grams), unit: 'g' }, op.grams, locale) };
        item.quantityStated = true;
        break;
      case 'remove_item':
        if (!item) return { ok: false, field: 'itemId', reason: 'unknown_item' };
        d.items = d.items.filter((i) => i.id !== item.id);
        break;
      case 'rename_item':
        if (!item || !op.name) return { ok: false, field: 'itemId', reason: 'unknown_item' };
        if (op.name.toLowerCase() !== item.name.toLowerCase()) item.source = ADJUSTED_ESTIMATE;
        item.name = op.name;
        break;
      case 'set_servings':
        if (op.servings === undefined) return { ok: false, field: 'servings', reason: 'missing' };
        d.kind = 'recipe';
        d.recipe = { ...(d.recipe ?? emptyRecipe()), servings: op.servings };
        break;
      case 'set_yield':
        if (op.grams === undefined) return { ok: false, field: 'grams', reason: 'missing' };
        d.kind = 'recipe';
        d.recipe = { ...(d.recipe ?? emptyRecipe()), cookedYieldG: round1(op.grams) };
        break;
      case 'set_portion': {
        const p = op.portion;
        if (!p) return { ok: false, field: 'portion', reason: 'missing' };
        const portion: Portion = { kind: p.kind, servings: p.servings ?? null, fraction: p.fraction ?? null, grams: p.grams ?? null };
        if ((p.kind === 'servings' && !p.servings) || (p.kind === 'fraction' && !p.fraction) || (p.kind === 'grams' && !p.grams)) return { ok: false, field: 'portion', reason: 'missing' };
        if (p.kind === 'grams' && d.recipe?.cookedYieldG && p.grams! > d.recipe.cookedYieldG) return { ok: false, field: 'portion', reason: 'above_yield' };
        d.portion = portion;
        break;
      }
      case 'rename':
        if (!op.name) return { ok: false, field: 'name', reason: 'missing' };
        d.name = op.name;
        break;
    }
  }
  if (!d.items.length) return { ok: false, field: 'ops', reason: 'empty' };
  return { ok: true, draft: recompute({ ...d, version: current.version + 1, updatedAt: now.toISOString() }) };
}

// ── Saving ─────────────────────────────────────────────────────────────────────────────────────────

export interface MealTarget {
  date: string;
  timezone: string;
  loggedAt: string;
  category: MealCategory;
  source: 'text' | 'voice';
}

export type MealRequestResult = { ok: true; request: CreateMealRequest } | { ok: false; blockedBy: 'portion' | 'yield' | 'empty' };

/**
 * The diary entry for a draft, through the same POST /meals path as everywhere else.
 * - meal: its items (each with its per-100-g basis), the portion as the multiplier.
 * - recipe: ONE item named after the recipe, grams = the eaten portion, per-100 g = recipe totals over the cooked weight
 *   (or the raw share when the cooked weight is unknown), so the diary computes exactly `portionTotals`.
 */
export function mealRequestFor(d: ChatDraft, t: MealTarget): MealRequestResult {
  if (!d.items.length) return { ok: false, blockedBy: 'empty' };
  const { fraction, pending } = portionFraction(d);
  if (fraction === null) return { ok: false, blockedBy: pending ?? 'portion' };
  const base = { loggedAt: t.loggedAt, timezone: t.timezone, date: t.date, category: t.category, name: d.name || d.items[0]!.name, source: t.source };
  if (d.kind === 'meal') {
    const scaleItems = fraction < PORTION_MULTIPLIER_MIN;
    const items: MealItemInput[] = d.items.map((i) => ({
      name: i.name,
      grams: round1(clamp(scaleItems ? i.grams * fraction : i.grams, ITEM_GRAMS_MIN, ITEM_GRAMS_MAX)),
      kcal: null,
      proteinG: null,
      carbsG: null,
      fatG: null,
      per100g: i.per100g,
      ...(i.preparation ? { preparation: i.preparation } : {}),
      processing: i.processing,
      addedByUser: false,
    }));
    return { ok: true, request: { ...base, items, ...(fraction !== 1 && !scaleItems ? { portionMultiplier: fraction } : {}) } };
  }
  const basisG = d.recipe?.cookedYieldG ?? d.recipe?.rawWeightG ?? 0;
  const grams = basisG * fraction;
  if (!(grams >= ITEM_GRAMS_MIN)) return { ok: false, blockedBy: 'portion' };
  const multiplier = grams > ITEM_GRAMS_MAX ? Math.ceil(grams / ITEM_GRAMS_MAX) : 1;
  if (multiplier > PORTION_MULTIPLIER_MAX) return { ok: false, blockedBy: 'portion' };
  const per100g = per100gOfTotals(d.totals, basisG);
  const item: MealItemInput = {
    name: base.name.slice(0, 120),
    grams: Math.round((grams / multiplier) * 10) / 10,
    kcal: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
    per100g,
    preparation: 'mixed',
    processing: null,
    addedByUser: false,
  };
  return { ok: true, request: { ...base, items: [item], ...(multiplier > 1 ? { portionMultiplier: multiplier } : {}) } };
}

/** The parts of a draft a saved recipe keeps (values are recomputed on every write). */
export function recipeFieldsOf(d: ChatDraft): { name: string; items: DraftItem[]; servings: number | null; cookedYieldG: number | null } {
  return { name: d.name || d.items[0]?.name || 'Recipe', items: d.items.map(withValues), servings: d.recipe?.servings ?? null, cookedYieldG: d.recipe?.cookedYieldG ?? null };
}

/** Totals of a saved recipe (same calculator as drafts). */
export function recipeValues(items: readonly DraftItem[], cookedYieldG: number | null): { items: DraftItem[]; totals: MealTotals; rawWeightG: number; per100gCooked: NutrientValues | null } {
  const valued = items.map(withValues);
  const totals = computeMealTotals(valued);
  return { items: valued, totals, rawWeightG: round1(valued.reduce((s, i) => s + i.grams, 0)), per100gCooked: cookedYieldG ? per100gOfTotals(totals, cookedYieldG) : null };
}

/** A fresh recipe draft from a saved recipe ("I made my chicken curry again"). */
export function draftFromRecipe(r: { id: string; name: string; items: DraftItem[]; servings: number | null; cookedYieldG: number | null }, ctx: DraftContext): ChatDraft {
  const d = newDraft('recipe', r.name, ctx);
  return recompute({ ...d, items: r.items.map(withValues), recipe: { ...emptyRecipe(), servings: r.servings, cookedYieldG: r.cookedYieldG }, savedRecipeId: r.id });
}

/** A short line per draft item for the model (ids it may refer to). */
export function compactDraft(d: ChatDraft | null): Record<string, unknown> | null {
  if (!d) return null;
  return {
    id: d.id,
    version: d.version,
    kind: d.kind,
    status: d.status,
    name: d.name,
    items: d.items.map((i) => ({ id: i.id, name: i.name, grams: i.grams, said: i.quantity.text, stated: i.quantityStated, state: i.state, bone: i.bone, kcal: i.kcal })),
    servings: d.recipe?.servings ?? null,
    cookedYieldG: d.recipe?.cookedYieldG ?? null,
    portion: d.portion,
    totalKcal: d.totals.kcal,
    portionKcal: d.portionTotals?.kcal ?? null,
    pending: d.pending?.code ?? null,
    logged: d.logs.length > 0,
  };
}
