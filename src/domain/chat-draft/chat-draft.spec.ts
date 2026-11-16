import { buildFoodIndex, nutrientsForGrams, type FoodRecord } from '../food-nutrition';
import { EMPTY_INTERPRET, type ChatDraft, type InterpretOp } from '../../shared';
import {
  applyEdits,
  applyModelOps,
  compactDraft,
  draftFromRecipe,
  itemFromOp,
  mealRequestFor,
  newDraft,
  opGrams,
  per100gOfTotals,
  portionFraction,
  recipeValues,
  recompute,
  resolveTarget,
  scaleTotals,
  type DraftContext,
} from './index';

let n = 0;
const ctx = (records?: DraftContext['records']): DraftContext => ({ newId: () => `d${++n}`, conversationId: 'c1', now: new Date('2026-11-16T08:00:00Z'), records });
const op = (o: Partial<InterpretOp>): InterpretOp => ({
  op: 'add_item',
  kind: null,
  itemId: null,
  name: null,
  en: null,
  qty: null,
  unit: null,
  g: null,
  stated: null,
  state: null,
  bone: null,
  prep: null,
  proc: null,
  n: null,
  assume: null,
  count: null,
  portionKind: null,
  value: null,
  recipeId: null,
  ...o,
});
const chicken = op({ name: 'Chicken', en: 'chicken breast', qty: 500, unit: 'g', g: 500, stated: true, state: 'raw', n: { kcal: 120, p: 22, c: 0, f: 3, fib: 0, sug: 0, na: 70 } });
const oil = op({ name: 'Oil', en: 'mustard oil', qty: 30, unit: 'g', g: 30, stated: true, n: { kcal: 884, p: 0, c: 0, f: 100, fib: 0, sug: 0, na: 0 } });
const onion = op({ name: 'Onion', en: 'onion', qty: 100, unit: 'g', g: 100, stated: true, state: 'raw', n: { kcal: 40, p: 1.1, c: 9.3, f: 0.1, fib: 1.7, sug: 4.2, na: 4 } });

/** "I cooked 500 g chicken, 30 g oil and 100 g onion." */
function curry(): ChatDraft {
  const r = applyModelOps(null, [op({ op: 'start_draft', kind: 'recipe', name: 'Chicken curry' }), chicken, oil, onion], ctx(), 'recipe');
  return r.draft!;
}

describe('chat drafts: recipe arithmetic (Milo buddy)', () => {
  it('builds a recipe with whole-dish totals from each per-100 g basis, kept apart from the portion', () => {
    const d = curry();
    expect(d).toMatchObject({ kind: 'recipe', version: 1, name: 'Chicken curry', status: 'open' });
    expect(d.items.map((i) => [i.id, i.name, i.grams, i.kcal])).toEqual([
      ['i1', 'Chicken', 500, 600],
      ['i2', 'Oil', 30, 265],
      ['i3', 'Onion', 100, 40],
    ]);
    expect(d.recipe).toMatchObject({ rawWeightG: 630, servings: null, cookedYieldG: null });
    expect(d.totals.kcal).toBe(905);
    expect(d.totals.proteinG).toBe(111.1);
    // No portion yet: nothing to log, and the draft says what is missing.
    expect(d.portionTotals).toBeNull();
    expect(d.pending).toEqual({ code: 'portion', itemId: null });
    expect(d.assumptions.filter((a) => a.code === 'basis_assumed')).toHaveLength(3);
    expect(d.assumptions.some((a) => a.code === 'yield_unknown')).toBe(true);
  });

  it('"divided into four, ate one" is a quarter of every nutrient; the gram weight is the raw share and says so', () => {
    const d = applyModelOps(curry(), [op({ op: 'set_servings', count: 4 }), op({ op: 'set_portion', portionKind: 'servings', value: 1 })], ctx()).draft!;
    expect(d.version).toBe(2);
    expect(d.portionTotals!.kcal).toBe(226);
    expect(d.portionTotals!.proteinG).toBe(27.8);
    expect(d.portionGrams).toBe(157.5);
    expect(d.gramsBasis).toBe('raw_share');
    expect(d.assumptions.some((a) => a.code === 'raw_share_weight')).toBe(true);
    expect(d.pending).toBeNull();
  });

  it('a gram portion uses the cooked weight and never the raw weight; without it the draft asks for it', () => {
    const noYield = applyModelOps(curry(), [op({ op: 'set_portion', portionKind: 'grams', value: 250 })], ctx()).draft!;
    expect(noYield.portionTotals).toBeNull();
    expect(noYield.pending).toEqual({ code: 'yield', itemId: null });
    expect(mealRequestFor(noYield, { date: '2026-11-16', timezone: 'UTC', loggedAt: '2026-11-16T12:00:00Z', category: 'lunch', source: 'text' })).toEqual({ ok: false, blockedBy: 'yield' });
    const d = applyModelOps(noYield, [op({ op: 'set_yield', value: 900 })], ctx()).draft!;
    expect(d.portionTotals!.kcal).toBe(Math.round((905 * 250) / 900));
    expect(d.portionGrams).toBe(250);
    expect(d.gramsBasis).toBe('cooked');
    expect(d.recipe!.per100gCooked!.kcal).toBeCloseTo(100.5556, 3);
    // More than the whole dish is not a portion.
    expect(applyModelOps(d, [op({ op: 'set_portion', portionKind: 'grams', value: 1000 })], ctx()).rejected).toEqual([{ op: 'set_portion', reason: 'invalid' }]);
  });

  it('"Actually, the oil was 20 g" updates that item, keeps its basis and recalculates; the version moves once', () => {
    const d = applyModelOps(curry(), [op({ op: 'set_servings', count: 4 }), op({ op: 'set_portion', portionKind: 'servings', value: 1 })], ctx()).draft!;
    const fixed = applyModelOps(d, [op({ op: 'update_item', itemId: 'i2', qty: 20, unit: 'g', g: 20, stated: true })], ctx()).draft!;
    expect(fixed.version).toBe(d.version + 1);
    expect(fixed.items.find((i) => i.id === 'i2')).toMatchObject({ grams: 20, kcal: 177, per100g: d.items[1]!.per100g });
    expect(fixed.totals.kcal).toBe(817);
    expect(fixed.portionTotals!.kcal).toBe(204);
    expect(fixed.items).toHaveLength(3); // a correction never adds an entry
  });

  it('"remove the oil" removes it; an unclear reference with several items is never guessed', () => {
    const d = curry();
    const removed = applyModelOps(d, [op({ op: 'remove_item', itemId: 'i2' })], ctx()).draft!;
    expect(removed.items.map((i) => i.name)).toEqual(['Chicken', 'Onion']);
    const unclear = applyModelOps(d, [op({ op: 'update_item', itemId: null, qty: 150, unit: 'g', g: 150 })], ctx());
    expect(unclear.ambiguous).toEqual(['i1', 'i2', 'i3']);
    expect(unclear.changed).toBe(false);
    expect(unclear.draft!.version).toBe(1);
    // One item: "make it 150 g" means that one.
    const single = applyModelOps(null, [op({ name: 'Rice', en: 'cooked white rice', g: 250, n: { kcal: 130, p: 2.7, c: 28, f: 0.3, fib: 0.4, sug: 0, na: 1 } })], ctx()).draft!;
    expect(resolveTarget(single, null)).toEqual({ item: single.items[0] });
    expect(applyModelOps(single, [op({ op: 'update_item', qty: 150, unit: 'g', g: 150 })], ctx()).draft!.items[0]!.grams).toBe(150);
    // An id that is not in the draft is dropped, not applied to something else.
    expect(applyModelOps(d, [op({ op: 'remove_item', itemId: 'i9' })], ctx()).ambiguous).toEqual(['i1', 'i2', 'i3']);
    expect(applyModelOps(null, [op({ op: 'remove_item', itemId: 'i1' })], ctx()).rejected).toEqual([{ op: 'remove_item', reason: 'no_draft' }]);
  });

  it('half of that, all of it and portion limits', () => {
    const d = curry();
    expect(applyModelOps(d, [op({ op: 'set_portion', portionKind: 'fraction', value: 0.5 })], ctx()).draft!.portionTotals!.kcal).toBe(453);
    expect(applyModelOps(d, [op({ op: 'set_portion', portionKind: 'all' })], ctx()).draft!.portionTotals!.kcal).toBe(905);
    expect(applyModelOps(d, [op({ op: 'set_portion', portionKind: 'fraction', value: 2 })], ctx()).rejected[0]!.reason).toBe('invalid');
    expect(applyModelOps(d, [op({ op: 'set_portion', portionKind: 'servings', value: 1 })], ctx()).draft!.pending).toEqual({ code: 'portion', itemId: null });
    expect(portionFraction({ kind: 'meal', portion: null, recipe: null })).toEqual({ fraction: 1, pending: null });
  });

  it('a published record beats the model basis, except for weights with the bone in', () => {
    const record: FoodRecord = { id: 'r1', source: 's', sourceRef: 'x', sourceName: 'Table', kind: 'single', aliases: ['chicken breast'], preparations: ['unknown', 'raw', 'curried'], per100g: { kcal: 110, proteinG: 23, carbsG: 0, fatG: 1.5, fiberG: 0, sugarG: 0, sodiumMg: 60 }, other: {} };
    const records = buildFoodIndex([record], { s: { name: 'Food table' } });
    expect(itemFromOp(chicken, 'i1', records)).toMatchObject({ kcal: 550, source: { type: 'verified_record' } });
    const boneIn = itemFromOp({ ...chicken, bone: 'in', n: { kcal: 90, p: 16, c: 0, f: 2.6, fib: 0, sug: 0, na: 60 } }, 'i1', records);
    expect(boneIn).toMatchObject({ kcal: 450, source: { type: 'ai_estimate' }, bone: 'in' });
  });

  it('amounts: written weights are converted by the server, assumed amounts are flagged, no amount is no item', () => {
    expect(opGrams({ qty: 1.5, unit: 'kg', g: 900, stated: true })).toEqual({ grams: 1500, stated: true });
    expect(opGrams({ qty: 250, unit: 'ml', g: 260, stated: true })).toEqual({ grams: 250, stated: true });
    expect(opGrams({ qty: 2, unit: 'piece', g: 100, stated: true })).toEqual({ grams: 100, stated: true });
    expect(opGrams({ qty: null, unit: null, g: 160, stated: false })).toEqual({ grams: 160, stated: false });
    expect(opGrams({ qty: null, unit: null, g: null, stated: null })).toBeNull();
    const r = applyModelOps(null, [op({ name: 'Rice' })], ctx());
    expect(r.rejected).toEqual([{ op: 'add_item', reason: 'no_amount' }]);
    const assumed = applyModelOps(null, [op({ name: 'Rice', g: 160, stated: false, n: { kcal: 130, p: 2.7, c: 28, f: 0.3, fib: null, sug: null, na: null } })], ctx()).draft!;
    expect(assumed.assumptions).toContainEqual({ code: 'amount_assumed', itemId: 'i1', text: null });
    expect(assumed.totals.incomplete).toEqual(['fiberG', 'sugarG', 'sodiumMg']);
  });

  it('a new dish parks the old one; new food after a logged meal starts a new meal', () => {
    const d = curry();
    const next = applyModelOps(d, [op({ op: 'start_draft', kind: 'meal', name: 'Breakfast' }), op({ name: 'Egg', g: 100, qty: 2, unit: 'piece', stated: true, n: { kcal: 143, p: 12.6, c: 0.7, f: 9.5, fib: 0, sug: 0.4, na: 142 } })], ctx());
    expect(next.parked?.id).toBe(d.id);
    expect(next.draft!.id).not.toBe(d.id);
    expect(next.draft!.version).toBe(1);
    const meal = { ...next.draft!, status: 'logged' as const };
    const more = applyModelOps(meal, [op({ name: 'Banana', g: 120, qty: 1, unit: 'piece', stated: true, n: { kcal: 89, p: 1.1, c: 23, f: 0.3, fib: 2.6, sug: 12, na: 1 } })], ctx());
    expect(more.parked?.id).toBe(meal.id);
    expect(more.draft!.items.map((i) => i.name)).toEqual(['Banana']);
  });

  it('a draft holds at most 15 foods; servings, yield and renames are validated', () => {
    let d: ChatDraft | null = null;
    for (let i = 0; i < 16; i++) d = applyModelOps(d, [op({ name: `Food ${i}`, g: 10, n: { kcal: 100, p: 1, c: 1, f: 1, fib: 0, sug: 0, na: 0 } })], ctx()).draft;
    expect(d!.items).toHaveLength(15);
    expect(applyModelOps(d, [op({ name: 'One more', g: 10 })], ctx()).rejected).toEqual([{ op: 'add_item', reason: 'limit' }]);
    expect(applyModelOps(curry(), [op({ op: 'set_servings', count: 0 })], ctx()).rejected[0]!.reason).toBe('invalid');
    expect(applyModelOps(curry(), [op({ op: 'set_yield', value: 50_000 })], ctx()).rejected[0]!.reason).toBe('invalid');
    expect(applyModelOps(curry(), [op({ op: 'rename', name: '  ' })], ctx()).rejected[0]!.reason).toBe('invalid');
    expect(applyModelOps(curry(), [op({ op: 'rename', name: 'Murgir jhol' })], ctx()).draft!.name).toBe('Murgir jhol');
    expect(applyModelOps(curry(), [op({ op: 'load_recipe', recipeId: 'r9' })], ctx()).loadRecipeId).toBe('r9');
  });

  it('a different food on update gets a new basis; the same food keeps its basis', () => {
    const d = curry();
    const swapped = applyModelOps(d, [op({ op: 'update_item', itemId: 'i2', name: 'Ghee', en: 'ghee', n: { kcal: 900, p: 0, c: 0, f: 100, fib: 0, sug: 0, na: 0 } })], ctx()).draft!;
    expect(swapped.items[1]).toMatchObject({ name: 'Ghee', kcal: 270, per100g: { kcal: 900 } });
    const raw = applyModelOps(d, [op({ op: 'update_item', itemId: 'i1', state: 'cooked' })], ctx()).draft!;
    expect(raw.items[0]).toMatchObject({ state: 'cooked', per100g: d.items[0]!.per100g });
  });
});

describe('chat drafts: card edits', () => {
  it('edits are all or nothing with one version bump', () => {
    const d = curry();
    const ok = applyEdits(d, [{ op: 'update_item', itemId: 'i2', grams: 20 }, { op: 'set_servings', servings: 4 }, { op: 'set_portion', portion: { kind: 'servings', servings: 1 } }], new Date());
    expect(ok.ok && ok.draft.version).toBe(2);
    expect(ok.ok && ok.draft.portionTotals!.kcal).toBe(204);
    expect(applyEdits(d, [{ op: 'update_item', itemId: 'i9', grams: 20 }], new Date())).toEqual({ ok: false, field: 'itemId', reason: 'unknown_item' });
    expect(applyEdits(d, [{ op: 'remove_item', itemId: 'i1' }, { op: 'remove_item', itemId: 'i2' }, { op: 'remove_item', itemId: 'i3' }], new Date())).toEqual({ ok: false, field: 'ops', reason: 'empty' });
    expect(applyEdits(d, [{ op: 'set_portion', portion: { kind: 'servings' } }], new Date())).toMatchObject({ ok: false, field: 'portion' });
    const y = applyEdits(d, [{ op: 'set_yield', grams: 900 }], new Date());
    expect(y.ok && applyEdits(y.draft, [{ op: 'set_portion', portion: { kind: 'grams', grams: 1000 } }], new Date())).toMatchObject({ ok: false, reason: 'above_yield' });
    const renamed = applyEdits(d, [{ op: 'rename_item', itemId: 'i1', name: 'Chicken thigh' }, { op: 'rename', name: 'Curry' }], new Date());
    expect(renamed.ok && renamed.draft.items[0]).toMatchObject({ name: 'Chicken thigh', source: { type: 'adjusted_estimate' } });
    expect(applyEdits(d, [{ op: 'set_servings' }], new Date())).toMatchObject({ ok: false });
    expect(applyEdits(d, [{ op: 'set_yield' }], new Date())).toMatchObject({ ok: false });
    expect(applyEdits(d, [{ op: 'rename' }], new Date())).toMatchObject({ ok: false });
    expect(applyEdits(d, [{ op: 'rename_item', itemId: 'i1' }], new Date())).toMatchObject({ ok: false });
    const meal = applyModelOps(null, [op({ name: 'Rice', g: 250, n: { kcal: 130, p: 2.7, c: 28, f: 0.3, fib: 0, sug: 0, na: 0 } })], ctx()).draft!;
    expect(applyEdits(meal, [{ op: 'update_item', itemId: 'i1', grams: 3000 }], new Date())).toMatchObject({ ok: false, reason: 'too_large' });
  });
});

describe('chat drafts: saving through POST /meals', () => {
  const target = { date: '2026-11-16', timezone: 'Asia/Dhaka', loggedAt: '2026-11-16T07:00:00Z', category: 'lunch' as const, source: 'text' as const };

  it('a recipe portion is one item whose per-100 g basis makes the diary compute exactly the portion', () => {
    const d = applyModelOps(curry(), [op({ op: 'set_servings', count: 4 }), op({ op: 'set_portion', portionKind: 'servings', value: 1 })], ctx()).draft!;
    const r = mealRequestFor(d, target);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.items).toHaveLength(1);
    const item = r.request.items[0]!;
    expect(item).toMatchObject({ name: 'Chicken curry', grams: 157.5, preparation: 'mixed' });
    expect(nutrientsForGrams(item.per100g as never, item.grams).kcal).toBe(d.portionTotals!.kcal);
    expect(r.request.portionMultiplier).toBeUndefined();
  });

  it('a big portion uses the multiplier; a meal draft keeps its items; an empty draft cannot be saved', () => {
    const big = applyModelOps(null, [op({ op: 'start_draft', kind: 'recipe', name: 'Biryani pot' }), op({ name: 'Rice', g: 3000, n: { kcal: 150, p: 3, c: 30, f: 2, fib: 0, sug: 0, na: 0 } })], ctx(), 'recipe').draft!;
    const all = applyModelOps(big, [op({ op: 'set_portion', portionKind: 'all' })], ctx()).draft!;
    const r = mealRequestFor(all, target);
    expect(r.ok && r.request.portionMultiplier).toBe(2);
    expect(r.ok && r.request.items[0]!.grams).toBe(1500);
    const meal = applyModelOps(null, [op({ name: 'Roti', qty: 2, unit: 'piece', g: 80, stated: true, n: { kcal: 300, p: 9, c: 50, f: 7, fib: 4, sug: 1, na: 400 } })], ctx()).draft!;
    const half = applyModelOps(meal, [op({ op: 'set_portion', portionKind: 'fraction', value: 0.5 })], ctx()).draft!;
    const m = mealRequestFor(half, target);
    expect(m.ok && m.request).toMatchObject({ name: 'Roti', portionMultiplier: 0.5, items: [{ name: 'Roti', grams: 80 }] });
    const tiny = applyModelOps(meal, [op({ op: 'set_portion', portionKind: 'fraction', value: 0.05 })], ctx()).draft!;
    const t = mealRequestFor(tiny, target);
    expect(t.ok && t.request.items[0]!.grams).toBe(4);
    expect(mealRequestFor({ ...meal, items: [] }, target)).toEqual({ ok: false, blockedBy: 'empty' });
  });

  it('saved recipes recompute with the same calculator and load back as a fresh draft', () => {
    const d = curry();
    const v = recipeValues(d.items, 900);
    expect(v.totals.kcal).toBe(905);
    expect(v.per100gCooked!.kcal).toBeCloseTo(100.5556, 3);
    const again = draftFromRecipe({ id: 'r1', name: 'Chicken curry', items: d.items, servings: 4, cookedYieldG: 900 }, ctx());
    expect(again).toMatchObject({ version: 1, savedRecipeId: 'r1', kind: 'recipe', recipe: { servings: 4, cookedYieldG: 900 } });
    expect(again.totals.kcal).toBe(905);
  });

  it('helpers: scaling keeps unknowns, per-100 g of incomplete totals stays unknown, compact view for the model', () => {
    const t = { kcal: 100, proteinG: null, carbsG: 10, fatG: 1, fiberG: null, sugarG: null, sodiumMg: 5, incomplete: ['proteinG' as const] };
    expect(scaleTotals(t, 0.5)).toMatchObject({ kcal: 50, proteinG: null, carbsG: 5, sodiumMg: 3 });
    expect(per100gOfTotals({ ...t, proteinG: 4 }, 200)).toMatchObject({ kcal: 50, proteinG: null, carbsG: 5 });
    expect(per100gOfTotals(t, 0).kcal).toBeNull();
    expect(compactDraft(null)).toBeNull();
    expect(compactDraft(curry())).toMatchObject({ kind: 'recipe', items: [{ id: 'i1', said: '500 g', stated: true }, { id: 'i2' }, { id: 'i3' }], totalKcal: 905, pending: 'portion' });
    expect(recompute(newDraft('meal', null, ctx())).pending).toBeNull();
    expect(EMPTY_INTERPRET.ops).toEqual([]);
  });
});
