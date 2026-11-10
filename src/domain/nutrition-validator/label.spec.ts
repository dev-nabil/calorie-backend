import { LABEL_EXAMPLE } from './fixtures';
import { labelGrams, labelPer100g, labelValues, normaliseLabel, parseLabelOutput } from './label';
import type { LabelScanOutput } from '../../shared';

const label = (over: Partial<LabelScanOutput> = {}): LabelScanOutput => ({ ...(structuredClone(LABEL_EXAMPLE) as unknown as LabelScanOutput), ...over });
const n = (over: Partial<LabelScanOutput['n']> = {}): LabelScanOutput['n'] => ({ kcal: null, kj: null, p: null, c: null, f: null, fib: null, sug: null, na: null, salt: null, ...over });

describe('nutrition label scans', () => {
  it('accepts the example and rejects unknown fields', () => {
    expect(parseLabelOutput(LABEL_EXAMPLE).ok).toBe(true);
    expect(parseLabelOutput(JSON.stringify(LABEL_EXAMPLE)).ok).toBe(true);
    expect(parseLabelOutput({ ...LABEL_EXAMPLE, extra: 1 }).ok).toBe(false);
    expect(parseLabelOutput('{not json').ok).toBe(false);
  });

  it('fills energy from kJ and sodium from salt only when they are missing', () => {
    const fromKj = labelValues(n({ kj: 418.4, salt: 1 }));
    expect(fromKj.kcal).toBeCloseTo(100, 6);
    expect(fromKj.sodiumMg).toBe(400);
    expect(labelValues(n({ kcal: 90, kj: 418.4, na: 120, salt: 1 }))).toMatchObject({ kcal: 90, sodiumMg: 120 });
    expect(labelValues(n())).toMatchObject({ kcal: null, sodiumMg: null });
  });

  it('turns a per-serving column into per 100 g, and refuses without a serving weight', () => {
    expect(labelPer100g({ basis: 'per_serving', servingG: 25, n: n({ kcal: 120, p: 2, c: 16, f: 5 }) })).toMatchObject({ kcal: 480, proteinG: 8, carbsG: 64, fatG: 20, fiberG: null });
    expect(labelPer100g({ basis: 'per_serving', servingG: null, n: n({ kcal: 120 }) })).toBeNull();
    expect(labelPer100g({ basis: 'per_100g', servingG: null, n: n({ kcal: 480 }) })).toMatchObject({ kcal: 480 });
  });

  it('defaults the portion to one serving, else a small pack, else 100 g', () => {
    expect(labelGrams({ servingG: 25, packG: 75 })).toBe(25);
    expect(labelGrams({ servingG: null, packG: 40 })).toBe(40);
    expect(labelGrams({ servingG: null, packG: 500 })).toBe(100);
    expect(labelGrams({ servingG: 0, packG: null })).toBe(100);
  });

  it('stores one item read off the label, not an estimate', () => {
    const r = normaliseLabel(label(), { barcode: '8941100500118' });
    expect(r.status).toBe('succeeded');
    expect(r.analysis.isEstimate).toBe(false);
    expect(r.analysis.mealName).toBe('Bisk Club Chocolate Biscuits');
    const [item] = r.analysis.items;
    expect(item).toMatchObject({ grams: 25, kcal: 120, proteinG: 1.6, carbsG: 16.5, fatG: 5.3, sodiumMg: 60, portion: '3 biscuits (25 g)', canonicalName: 'chocolate biscuits' });
    expect(item!.per100g).toMatchObject({ kcal: 480, sodiumMg: 240 });
    expect(item!.source).toEqual({ type: 'package_label', recordId: null, name: null, reference: '8941100500118' });
    expect(r.analysis.totals.kcal).toBe(120);
  });

  it('rejects a photo with no table, an unreadable one, and a per-serving label without its serving size', () => {
    expect(normaliseLabel(label({ status: 'no_food' }))).toMatchObject({ status: 'rejected', analysis: { outcome: 'no_food', isFood: false, items: [] } });
    expect(normaliseLabel(label({ status: 'unclear', retake: 'blurry' }))).toMatchObject({ status: 'rejected', analysis: { outcome: 'unclear', retakeReason: 'blurry' } });
    expect(normaliseLabel(label({ basis: 'per_serving', servingG: null })).analysis.outcome).toBe('unclear');
    expect(normaliseLabel(label({ n: n({ fib: 2 }) })).analysis.outcome).toBe('unclear');
  });

  it('recomputes energy that cannot match the printed macros, and drops impossible values', () => {
    const misread = normaliseLabel(label({ n: n({ kcal: 48, p: 6.5, c: 66, f: 21 }) }));
    expect(misread.analysis.items[0]!.kcalRecomputed).toBe(true);
    expect(misread.analysis.items[0]!.per100g.kcal).toBeCloseTo(4 * 6.5 + 4 * 66 + 9 * 21, 0);
    const impossible = normaliseLabel(label({ n: n({ kcal: 480, p: 6.5, c: 660, f: 21 }) }));
    expect(impossible.analysis.items[0]!.per100g.carbsG).toBeNull();
  });
});
