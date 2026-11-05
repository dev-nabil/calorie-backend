import { computeTotals, editItemGrams, kcalFromMacros, normaliseAnalysis, normaliseItem, parseModelOutput, scaleItem, type ParsedItemInput } from './index';
import { chooseReactionLine } from './reactions';
import { PLAN_EXAMPLE_ANALYSIS } from './fixtures';
import type { MealAnalysisOutput } from '../../shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reactionCategory, reactionFacts, variantIndex, type ScanReactionContent } from './reactions';

const lines = JSON.parse(readFileSync(resolve(__dirname, '../../../content/milo/lines.v1.json'), 'utf8')) as {
  scanReactions: ScanReactionContent;
};
const content = lines.scanReactions;

const example = (): MealAnalysisOutput => JSON.parse(JSON.stringify(PLAN_EXAMPLE_ANALYSIS));
const item = (over: Partial<ParsedItemInput> = {}): ParsedItemInput => ({
  name: 'Thing',
  portion: null,
  grams: 100,
  kcal: 100,
  proteinG: 5,
  carbsG: 10,
  fatG: 4.4,
  fiberG: null,
  confidence: 0.5,
  point: null,
  ...over,
});

describe('nutrition-validator (plan 8.3)', () => {
  describe('rule 1: parseModelOutput', () => {
    it('accepts the plan example as an object and as JSON', () => {
      expect(parseModelOutput(example())).toMatchObject({ ok: true });
      expect(parseModelOutput(JSON.stringify(example()))).toMatchObject({ ok: true });
    });
    it('rejects unknown fields, missing fields and bad JSON', () => {
      const extra = { ...example(), totals: { kcal: 1 } };
      const r = parseModelOutput(extra);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join(' ')).toMatch(/totals|Unrecognized/i);
      const missing: Record<string, unknown> = { ...example() };
      delete missing.items;
      expect(parseModelOutput(missing).ok).toBe(false);
      expect(parseModelOutput('{not json')).toEqual({ ok: false, issues: ['Output is not valid JSON'] });
      expect(parseModelOutput(null).ok).toBe(false);
    });
  });

  it('normalises the plan example', () => {
    const r = normaliseAnalysis(example());
    expect(r.status).toBe('succeeded');
    expect(r.analysis.items).toHaveLength(3);
    expect(r.analysis.items.every((i) => !i.kcalRecomputed)).toBe(true);
    expect(r.analysis.totals).toEqual({ kcal: 501, proteinG: 50.8, carbsG: 45, fatG: 10.9, fiberG: 0.6, sugarG: 0.2, sodiumMg: 113, incomplete: [] });
    expect(r.analysis).toMatchObject({ isEstimate: true, outcome: 'ok', assumptions: ['Oil is not visible; the estimate may be low.'] });
    expect(r.analysis.items[2]?.point).toBeNull();
    expect(r.analysis.reactionLineId).toBeNull();
  });

  it('rule 2: not food is rejected with empty items', () => {
    const r = normaliseAnalysis({ ...example(), status: 'no_food', items: [], question: 'A cat' });
    expect(r.status).toBe('rejected');
    expect(r.analysis).toMatchObject({ isFood: false, items: [], totals: { kcal: 0 }, reactionLineId: null, notes: 'A cat' });
  });

  describe('rule 3: clamping', () => {
    it('clamps grams and scales nutrients with them', () => {
      const n = normaliseItem(item({ grams: 4000, kcal: 800, proteinG: 40, carbsG: 80, fatG: 35.6 }));
      expect(n.grams).toBe(2000);
      expect(n.kcal).toBe(400);
      expect(n.proteinG).toBe(20);
      expect(n.fatG).toBe(17.8);
      const small = normaliseItem(item({ grams: 0.5 }));
      expect(small.grams).toBe(1);
      expect(small.kcal).toBe(200);
      const zero = normaliseItem(item({ grams: 0 }));
      expect(zero.grams).toBe(1);
      expect(zero.proteinG).toBe(5);
    });
    it('keeps at most 15 items', () => {
      const one = example().items[0]!;
      const out = { ...example(), items: Array.from({ length: 20 }, (_, i) => ({ ...one, name: `Item ${i}` })) };
      expect(normaliseAnalysis(out).analysis.items).toHaveLength(15);
    });
    it('clamps confidence and drops points outside the photo', () => {
      expect(normaliseItem(item({ confidence: 1.4 })).confidence).toBe(1);
      expect(normaliseItem(item({ confidence: -1 })).confidence).toBe(0);
      expect(normaliseItem(item({ point: { x: 1.2, y: 0.5 } })).point).toBeNull();
      expect(normaliseItem(item({ point: { x: 0.5, y: -0.1 } })).point).toBeNull();
      expect(normaliseItem(item({ point: { x: 0, y: 1 } })).point).toEqual({ x: 0, y: 1 });
    });
    it('scales fibre and trims names', () => {
      expect(normaliseItem(item({ name: '  Oats ', grams: 3000, fiberG: 30 }))).toMatchObject({ name: 'Oats', fiberG: 20 });
    });
  });

  describe('rule 4: kcal recompute', () => {
    it('keeps kcal within 20% of macros', () => {
      // macros 4×5 + 4×10 + 9×4.4 = 99.6
      expect(normaliseItem(item({ kcal: 119 }))).toMatchObject({ kcal: 119, kcalRecomputed: false });
    });
    it('recomputes and flags kcal more than 20% off', () => {
      expect(normaliseItem(item({ kcal: 130 }))).toMatchObject({ kcal: 100, kcalRecomputed: true });
      expect(normaliseItem(item({ kcal: 50 }))).toMatchObject({ kcal: 100, kcalRecomputed: true });
    });
    it('treats zero macros and zero kcal as equal, but recomputes kcal with zero macros', () => {
      expect(normaliseItem(item({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }))).toMatchObject({ kcal: 0, kcalRecomputed: false });
      expect(normaliseItem(item({ kcal: 5, proteinG: 0, carbsG: 0, fatG: 0 }))).toMatchObject({ kcal: 0, kcalRecomputed: true });
    });
    it('computes Atwater energy', () => {
      expect(kcalFromMacros({ proteinG: 10, carbsG: 10, fatG: 10 })).toBe(170);
    });
  });

  describe('rule 5: totals', () => {
    it('ignores model totals and skips excluded items', () => {
      const t = computeTotals([
        { kcal: 100, proteinG: 1.04, carbsG: 2, fatG: 3, excluded: false },
        { kcal: 50, proteinG: 1, carbsG: 1, fatG: 1, excluded: true },
        { kcal: 20.4, proteinG: 0.03, carbsG: 0, fatG: 0 },
      ]);
      expect(t).toEqual({ kcal: 120, proteinG: 1.1, carbsG: 2, fatG: 3 });
    });
    it('applies a multiplier', () => {
      expect(computeTotals([{ kcal: 100, proteinG: 10, carbsG: 10, fatG: 10 }], 1.5)).toEqual({
        kcal: 150,
        proteinG: 15,
        carbsG: 15,
        fatG: 15,
      });
    });
  });

  describe('rule 6: portions and grams edits', () => {
    const base = { name: 'Rice', grams: 160, kcal: 208, proteinG: 4.3, carbsG: 45, fatG: 0.5, fiberG: 0.6 };
    it('scales every nutrient with the portion multiplier', () => {
      expect(scaleItem(base, 0.5)).toEqual({ name: 'Rice', grams: 80, kcal: 104, proteinG: 2.2, carbsG: 22.5, fatG: 0.3, fiberG: 0.3 });
      expect(scaleItem({ ...base, fiberG: null }, 1.5).fiberG).toBeNull();
      expect('fiberG' in scaleItem({ grams: 1, kcal: 1, proteinG: 0, carbsG: 0, fatG: 0 }, 2)).toBe(false);
    });
    it('scales an item linearly from its per-gram values on a grams edit', () => {
      expect(editItemGrams(base, 240)).toMatchObject({ grams: 240, kcal: 312, carbsG: 67.5 });
      expect(editItemGrams(base, 5000).grams).toBe(2000);
      expect(editItemGrams(base, 0).grams).toBe(1);
      expect(editItemGrams({ ...base, grams: 0 }, 50)).toMatchObject({ grams: 50, kcal: 208 });
    });
  });

  describe('rule 7: reaction line from content (R-10)', () => {
    const it_ = (name: string, kcal: number, p: number, c: number, excluded = false) => ({ name, kcal, proteinG: p, carbsG: c, excluded });
    const base = { mode: 'full' as const, remainingBefore: null, scanId: '6a1f0e8e-7f53-4c55-9f6f-111111111111' };
    const cat = (items: ReturnType<typeof it_>[], over: Partial<typeof base> | { mode: 'habits_only' } | { remainingBefore: number } = {}) =>
      reactionCategory(content, { ...base, ...over, items });

    it('heavy only in full mode with a positive remaining target', () => {
      const big = [it_('Pasta bake', 700, 20, 90)];
      expect(cat(big, { remainingBefore: 1000 })).toBe('heavy');
      expect(cat(big, { remainingBefore: 2000 })).not.toBe('heavy');
      expect(cat(big, { remainingBefore: 0 })).not.toBe('heavy');
      expect(cat(big, { mode: 'habits_only', remainingBefore: 1000 } as never)).not.toBe('heavy');
    });
    it('sweet, balanced, high_protein, light and neutral in order', () => {
      expect(cat([it_('Chocolate cake', 400, 5, 50)])).toBe('sweet');
      expect(cat([it_('Chicken', 200, 30, 0), it_('Rice', 200, 4, 45), it_('Broccoli', 50, 4, 7)])).toBe('balanced');
      expect(cat([it_('Steak', 500, 50, 0)])).toBe('high_protein');
      expect(cat([it_('Apple', 80, 0, 20)])).toBe('light');
      expect(cat([it_('Pasta', 700, 20, 120)])).toBe('neutral');
      expect(cat([])).toBe('light');
    });
    it('matches whole words only and ignores excluded items', () => {
      expect(reactionFacts(content, [it_('Green beans', 50, 3, 7)]).hasVegetable).toBe(true);
      expect(reactionFacts(content, [it_('Pepperoni pizza', 600, 25, 60)]).hasVegetable).toBe(false);
      expect(reactionFacts(content, [it_('Side salad', 50, 1, 5, true)]).hasVegetable).toBe(false);
    });
    it('picks a stable variant from the scan id', () => {
      const items = [it_('Steak', 500, 50, 0)];
      const a = chooseReactionLine(content, { ...base, items });
      expect(a).toMatch(/^scan\.reaction\.high_protein\.[123]$/);
      expect(chooseReactionLine(content, { ...base, items })).toBe(a);
      expect(variantIndex('x', 3)).toBe(variantIndex('x', 3));
    });
    it('returns null when content has no usable category', () => {
      expect(chooseReactionLine({ ...content, order: ['unknown'] }, { ...base, items: [] })).toBeNull();
    });
    it('normaliseAnalysis applies the reaction when content is given', () => {
      const r = normaliseAnalysis(example(), { reaction: { ...base, content } });
      expect(r.analysis.reactionLineId).toMatch(/^scan\.reaction\.high_protein\./);
    });
  });
});
