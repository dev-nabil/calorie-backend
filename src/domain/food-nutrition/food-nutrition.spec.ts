import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnalysedItem, MealAnalysisOutput, NutrientValues } from '../../shared';
import { normaliseAnalysis } from '../nutrition-validator';
import {
  applyItemCorrection,
  buildFoodIndex,
  computeMealTotals,
  isInsideDish,
  matchFoodRecord,
  normaliseFoodName,
  nutrientsForGrams,
  sanitisePer100g,
  type FoodRecord,
} from './index';

const file = JSON.parse(readFileSync(resolve(__dirname, '../../../content/food-records/food-records.v1.json'), 'utf8')) as { records: FoodRecord[]; sources: Record<string, { name: string }> };
const index = buildFoodIndex(file.records, file.sources);

const rice: NutrientValues = { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fiberG: 0.4, sugarG: null, sodiumMg: 1 };

const out = (items: MealAnalysisOutput['items']): MealAnalysisOutput => ({ status: 'ok', box_2d: null, mealName: 'Lunch', items, assumptions: [], question: null, retake: null });
const food = (over: Partial<MealAnalysisOutput['items'][number]> = {}): MealAnalysisOutput['items'][number] => ({
  name: 'Food',
  en: 'unlisted food',
  ves: 'plate',
  cm: 26,
  pcs: 1,
  g: 100,
  prep: 'unknown',
  proc: 'whole',
  role: 'single',
  of: null,
  n: { kcal: 100, p: 5, c: 10, f: 4.4, fib: 1, sug: 1, na: 10 },
  rich: [],
  conf: 0.7,
  pt: null,
  note: null,
  ...over,
});

describe('per-100-gram arithmetic', () => {
  it('scales from the basis and keeps unknown as null, never zero', () => {
    expect(nutrientsForGrams(rice, 180)).toEqual({ kcal: 234, proteinG: 4.9, carbsG: 50.4, fatG: 0.5, fiberG: 0.7, sugarG: null, sodiumMg: 2 });
  });

  it('gives the same values for any portion path: 200 g equals 100 g doubled', () => {
    const twice = nutrientsForGrams(rice, 200);
    expect(twice.kcal).toBe(2 * nutrientsForGrams(rice, 100).kcal!);
  });
});

describe('meal totals', () => {
  it('flags a nutrient as incomplete when one counted item lacks it, and still sums the rest', () => {
    const t = computeMealTotals([{ kcal: 200, sugarG: 2, sodiumMg: 100, proteinG: 5, carbsG: 30, fatG: 5, fiberG: 1 }, { kcal: 100, sugarG: null, sodiumMg: 50, proteinG: 2, carbsG: 10, fatG: 1, fiberG: 2 }]);
    expect(t).toMatchObject({ kcal: 300, sugarG: 2, sodiumMg: 150, incomplete: ['sugarG'] });
  });

  it('is null, not zero, when no counted item has the nutrient', () => {
    const t = computeMealTotals([{ kcal: 100, sugarG: null }, { kcal: 50, sugarG: null }]);
    expect(t.sugarG).toBeNull();
    expect(t.incomplete).toContain('sugarG');
  });

  it('ignores excluded items, so a missing value on one does not mark the total incomplete', () => {
    const t = computeMealTotals([{ kcal: 100, proteinG: 1, carbsG: 1, fatG: 1, fiberG: 1, sugarG: 1, sodiumMg: 1 }, { kcal: 999, sugarG: null, excluded: true }]);
    expect(t).toMatchObject({ kcal: 100, sugarG: 1, incomplete: [] });
  });

  it('applies the portion multiplier', () => {
    expect(computeMealTotals([{ kcal: 100, proteinG: 10, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 100 }], 1.5)).toMatchObject({ kcal: 150, proteinG: 15, sodiumMg: 150 });
  });

  it('reports an empty meal as zero, nothing unknown', () => {
    expect(computeMealTotals([])).toMatchObject({ kcal: 0, incomplete: [] });
  });
});

describe('sanitising model values', () => {
  it('turns impossible values into unknown', () => {
    const { per100g } = sanitisePer100g({ ...rice, kcal: 5000, sodiumMg: 90000 });
    expect(per100g.sodiumMg).toBeNull();
    expect(per100g.kcal).toBeNull();
  });

  it('recomputes energy far from the macros, and leaves it alone when macros are unknown', () => {
    expect(sanitisePer100g({ ...rice, kcal: 300 })).toMatchObject({ kcalRecomputed: true });
    expect(sanitisePer100g({ ...rice, kcal: 300, fatG: null })).toMatchObject({ kcalRecomputed: false, per100g: { kcal: 300 } });
  });

  it('drops macros that cannot fit in 100 g', () => {
    expect(sanitisePer100g({ ...rice, proteinG: 60, carbsG: 60 }).per100g).toMatchObject({ proteinG: null, carbsG: null, fatG: null });
  });
});

describe('food records', () => {
  it('holds only sourced records', () => {
    for (const r of file.records) {
      expect(file.sources[r.source]).toBeDefined();
      expect(r.sourceRef).toBeTruthy();
    }
  });

  it('matches on name and preparation together', () => {
    expect(matchFoodRecord(index, ['White Rice'], 'boiled')?.id).toBe('fct_bd:01_0041');
    expect(matchFoodRecord(index, ['ভাত'], 'unknown')?.id).toBe('fct_bd:01_0041');
    expect(matchFoodRecord(index, ['white rice'], 'fried')).toBeNull();
    expect(matchFoodRecord(index, ['boiled egg'], 'fried')).toBeNull();
    expect(matchFoodRecord(index, ['fried egg'], 'fried')?.source).toBe('usda_fdc');
    expect(matchFoodRecord(index, ['kacchi biryani'], 'mixed')).toBeNull();
  });

  it('normalises punctuation but keeps Bangla', () => {
    expect(normaliseFoodName('  Rice, (cooked)! ')).toBe('rice cooked');
    expect(normaliseFoodName('মাছের ঝোল')).toBe('মাছের ঝোল');
  });
});

describe('a Bangladeshi plate', () => {
  const plate = normaliseAnalysis(
    out([
      food({ name: 'ভাত', en: 'white rice', g: 200, prep: 'boiled', n: { kcal: 130, p: 2.7, c: 28, f: 0.3, fib: 0.4, sug: 0, na: 1 } }),
      food({ name: 'ডাল', en: 'dal', g: 120, prep: 'curried', role: 'mixed_dish' }),
      food({ name: 'মাছের ঝোল', en: 'fish curry', g: 150, prep: 'curried', role: 'mixed_dish' }),
      food({ name: 'শাক ভাজি', en: 'mixed greens stir fry', g: 80, prep: 'fried', n: { kcal: 60, p: 2, c: 5, f: 3.5, fib: 2, sug: null, na: null } }),
    ]),
    { records: index },
  );

  it('prefers verified records, preserves their source, and labels the rest as AI estimates', () => {
    const [rice, dal, fish, greens] = plate.analysis.items;
    expect(rice).toMatchObject({ source: { type: 'verified_record', recordId: 'fct_bd:01_0041', reference: '01_0041' }, per100g: { kcal: 111 }, kcal: 222 });
    expect(rice!.source.name).toContain('Bangladesh');
    expect(dal).toMatchObject({ source: { type: 'verified_record', recordId: 'usda_fdc:2707427' } });
    expect(fish).toMatchObject({ source: { type: 'verified_record', recordId: 'usda_fdc:2706460' } });
    expect(greens).toMatchObject({ source: { type: 'ai_estimate', recordId: null }, sugarG: null, sodiumMg: null });
  });

  it('adds extra nutrients only from records', () => {
    const [rice, , , greens] = plate.analysis.items;
    expect(rice!.otherNutrients.map((o) => o.key)).toContain('ironMg');
    expect(greens!.otherNutrients).toEqual([]);
  });

  it('marks totals incomplete where an item is unknown', () => {
    expect(plate.analysis.totals.incomplete).toEqual(expect.arrayContaining(['sugarG', 'sodiumMg']));
    expect(plate.analysis.totals.incomplete).not.toContain('kcal');
  });
});

describe('mixed dishes are not counted twice', () => {
  it('leaves a declared component out of the totals and links it to the dish', () => {
    const { analysis } = normaliseAnalysis(
      out([
        food({ name: 'Chicken biryani', en: 'chicken biryani', g: 300, prep: 'mixed', role: 'mixed_dish' }),
        food({ name: 'Rice', en: 'white rice', g: 200, prep: 'boiled', role: 'component', of: 0 }),
      ]),
      { records: index },
    );
    expect(analysis.items[1]).toMatchObject({ role: 'component', excluded: true, countedIn: 'i0' });
    expect(analysis.totals.kcal).toBe(analysis.items[0]!.kcal);
  });

  it('catches ingredients the model listed as separate foods', () => {
    const { analysis } = normaliseAnalysis(
      out([food({ name: 'Mutton biryani', en: 'mutton biryani', g: 300, prep: 'mixed', role: 'mixed_dish' }), food({ name: 'Cooking oil', en: 'cooking oil', g: 10 }), food({ name: 'Salad', en: 'cucumber salad', g: 50, prep: 'raw' })]),
      { records: index },
    );
    expect(analysis.items.map((i) => i.excluded)).toEqual([false, true, false]);
  });

  it('keeps foods that only sit next to a dish', () => {
    expect(isInsideDish('chicken curry', 'white rice')).toBe(false);
    expect(isInsideDish('fish curry', 'chicken curry')).toBe(false);
    expect(isInsideDish('khichuri', 'dal')).toBe(true);
  });

  it('treats a component with no valid parent as a plain food', () => {
    const { analysis } = normaliseAnalysis(out([food({ role: 'component', of: 9 })]), { records: index });
    expect(analysis.items[0]).toMatchObject({ role: 'single', excluded: false });
  });
});

describe('sizes the model is not held to', () => {
  it('trims an over-long reply instead of failing the scan', () => {
    const long = 'x'.repeat(500);
    const { analysis } = normaliseAnalysis({ ...out([food({ name: long, note: long })]), mealName: long, question: long, assumptions: Array.from({ length: 9 }, () => long) }, { records: index });
    expect(analysis.items[0]!.name).toHaveLength(120);
    expect(analysis.items[0]!.assumption).toHaveLength(140);
    expect(analysis.mealName).toHaveLength(120);
    expect(analysis.clarifyingQuestion).toHaveLength(200);
    expect(analysis.assumptions).toHaveLength(5);
  });
});

describe('unclear photos', () => {
  it('asks for another photo instead of inventing numbers', () => {
    const r = normaliseAnalysis({ status: 'unclear', box_2d: null, mealName: null, items: [], assumptions: [], question: 'Move closer to the plate', retake: 'too_far' });
    expect(r.status).toBe('rejected');
    expect(r.analysis).toMatchObject({ outcome: 'unclear', isFood: true, items: [], retakeReason: 'too_far', clarifyingQuestion: 'Move closer to the plate' });
  });

  it('treats "ok" with no items as unclear', () => {
    expect(normaliseAnalysis(out([])).analysis.outcome).toBe('unclear');
  });
});

describe('user corrections', () => {
  const scanned = (): AnalysedItem => normaliseAnalysis(out([food({ name: 'Fish curry', en: 'fish curry', g: 100, prep: 'curried', role: 'mixed_dish' })]), { records: index }).analysis.items[0]!;

  it('recalculates a portion change from the stored basis', () => {
    const { item, stale } = applyItemCorrection(scanned(), { grams: 200 }, index);
    expect(item).toMatchObject({ grams: 200, kcal: 186, source: { type: 'verified_record' } });
    expect(stale).toBe(false);
  });

  it('finds a record for a corrected name', () => {
    const { item, stale } = applyItemCorrection(scanned(), { name: 'chicken curry' }, index);
    expect(item.source).toMatchObject({ type: 'verified_record', recordId: 'usda_fdc:2706437' });
    expect(item.kcal).toBe(107);
    expect(stale).toBe(false);
  });

  it('never keeps a verified label on a food it no longer describes', () => {
    const { item, stale } = applyItemCorrection(scanned(), { name: 'hilsa curry' }, index);
    expect(item.source).toEqual({ type: 'adjusted_estimate', recordId: null, name: null, reference: null });
    expect(item.otherNutrients).toEqual([]);
    expect(stale).toBe(true);
  });

  it('re-matches on preparation', () => {
    const egg = normaliseAnalysis(out([food({ name: 'Egg', en: 'boiled egg', prep: 'boiled', g: 50 })]), { records: index }).analysis.items[0]!;
    expect(applyItemCorrection(egg, { preparation: 'fried' }, index).stale).toBe(true);
  });
});

describe('how processed a food is', () => {
  it('takes the model\'s tag', () => {
    const items = normaliseAnalysis(out([food({ proc: 'whole' }), food({ name: 'Cola', en: 'cola', proc: 'ultra_processed' })])).analysis.items;
    expect(items.map((i) => i.processing)).toEqual(['whole', 'ultra_processed']);
  });

  it('keeps it on a portion or preparation change and drops it when the food is renamed', () => {
    const dal = normaliseAnalysis(out([food({ name: 'Dal', en: 'dal', prep: 'curried', proc: 'whole' })]), { records: index }).analysis.items[0]!;
    expect(applyItemCorrection(dal, { grams: 250 }, index).item.processing).toBe('whole');
    expect(applyItemCorrection(dal, { preparation: 'fried' }, index).item.processing).toBe('whole');
    expect(applyItemCorrection(dal, { name: 'jilapi' }, index).item.processing).toBeNull();
  });

  it('treats a scan stored before the field existed as unknown', () => {
    const old = { ...normaliseAnalysis(out([food()])).analysis.items[0]!, processing: undefined } as unknown as AnalysedItem;
    expect(applyItemCorrection(old, { grams: 150 }, index).item.processing).toBeNull();
  });
});

describe('vitamins and minerals a food is rich in', () => {
  it('keeps the model\'s names, without repeats, at most four', () => {
    const [item] = normaliseAnalysis(out([food({ rich: ['iron', 'folate', 'iron', 'potassium', 'magnesium', 'zinc'] })])).analysis.items;
    expect(item!.richIn).toEqual(['iron', 'folate', 'potassium', 'magnesium']);
  });

  it('keeps them on a portion or preparation change and drops them when the food is renamed', () => {
    const dal = normaliseAnalysis(out([food({ name: 'Dal', en: 'dal', prep: 'curried', rich: ['folate', 'iron'] })]), { records: index }).analysis.items[0]!;
    expect(applyItemCorrection(dal, { grams: 250 }, index).item.richIn).toEqual(['folate', 'iron']);
    expect(applyItemCorrection(dal, { preparation: 'fried' }, index).item.richIn).toEqual(['folate', 'iron']);
    expect(applyItemCorrection(dal, { name: 'chicken curry' }, index).item.richIn).toEqual([]);
  });

  it('treats a scan stored before the field existed as having none', () => {
    const old = { ...normaliseAnalysis(out([food()])).analysis.items[0]!, richIn: undefined } as unknown as AnalysedItem;
    expect(applyItemCorrection(old, { grams: 150 }, index).item.richIn).toEqual([]);
  });

  it('multiplies the weight of one piece by the piece count', () => {
    const bananas = normaliseAnalysis(out([food({ name: '3 bananas', en: 'banana', pcs: 3, g: 120, n: { kcal: 89, p: 1.1, c: 23, f: 0.3, fib: 2.6, sug: 12, na: 1 } })])).analysis.items[0]!;
    expect(bananas.grams).toBe(360);
    expect(bananas.kcal).toBe(320);
  });
});
