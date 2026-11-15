import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFoodIndex, type FoodRecord } from '../food-nutrition';
import { MealDescribeOutputSchema, type MealDescribeOutput } from '../../shared';
import { describeValuesSane, explicitWeights, normaliseDescribe } from './describe';

const file = JSON.parse(readFileSync(resolve(__dirname, '../../../content/food-records/food-records.v1.json'), 'utf8')) as { records: FoodRecord[]; sources: Record<string, { name: string }> };
const records = buildFoodIndex(file.records, file.sources);

type Item = MealDescribeOutput['items'][number];
const item = (over: Partial<Item> = {}): Item => ({
  name: 'Chicken pizza',
  en: 'chicken pizza',
  portion: '215 g',
  stated: true,
  qty: 215,
  unit: 'g',
  g: 215,
  prep: 'baked',
  proc: 'processed',
  n: { kcal: 250, p: 12, c: 28, f: 10, fib: 2, sug: 3, na: 560 },
  conf: 0.8,
  assume: null,
  ...over,
});
const out = (items: Item[], over: Partial<MealDescribeOutput> = {}): MealDescribeOutput => ({ status: 'ok', mealName: 'Lunch', category: null, day: null, items, question: null, ...over });

describe('explicitWeights', () => {
  it.each([
    ['I ate 215 g of chicken pizza', [215]],
    ['215g pizza', [215]],
    ['1.5 kg rice', [1500]],
    ['a 250ml glass of milk and 30 grams of nuts', [250, 30]],
    ['২১৫ গ্রাম চিকেন পিজ্জা খেয়েছি', [215]],
    ['আধা লিটার দুধ, ১ কেজি', [1000]],
    ['two boiled eggs and a glass of milk', []],
    ['I had 2 eggs', []],
    ['200 gm bhat', [200]],
  ])('%s', (text, grams) => expect(explicitWeights(text)).toEqual(grams));
});

describe('normaliseDescribe', () => {
  it('keeps a stated weight and multiplies the per-100-g values by it (never shows per 100 g as the total)', () => {
    const r = normaliseDescribe(out([item()]));
    expect(r.items[0]).toMatchObject({ grams: 215, kcal: 538, proteinG: 25.8, carbsG: 60.2, fatG: 21.5, quantityStated: true, portion: '215 g' });
    expect(r.items[0]!.per100g).toMatchObject({ kcal: 250, proteinG: 12 });
    expect(r.totals).toMatchObject({ kcal: 538, proteinG: 25.8 });
  });

  it('converts a stated weight itself even when the model wrote a different g', () => {
    const r = normaliseDescribe(out([item({ g: 330, qty: 215, unit: 'g' })]));
    expect(r.items[0]!.grams).toBe(215);
    const kg = normaliseDescribe(out([item({ name: 'Rice', en: 'unlisted rice dish', qty: 0.5, unit: 'kg', g: 300 })]));
    expect(kg.items[0]!.grams).toBe(500);
  });

  it('a lone written weight wins when the model did not mark it as stated', () => {
    const r = normaliseDescribe(out([item({ stated: false, qty: null, unit: null, g: 300 })]), { text: 'I ate 215 g of chicken pizza' });
    expect(r.items[0]).toMatchObject({ grams: 215, kcal: 538, quantityStated: true });
  });

  it('does not force a lone weight onto one of several foods', () => {
    const r = normaliseDescribe(out([item({ stated: false, qty: null, unit: null, g: 300 }), item({ name: 'Cola', en: 'cola', stated: false, qty: null, unit: null, g: 330, n: { kcal: 42, p: 0, c: 10.6, f: 0, fib: 0, sug: 10.6, na: 4 } })]), { text: '200 g of pizza and cola' });
    expect(r.items.map((i) => i.grams)).toEqual([300, 330]);
  });

  it('uses the published record when the name matches (white rice, chicken curry, dal)', () => {
    const r = normaliseDescribe(
      out([
        item({ name: 'ভাত', en: 'white rice', prep: 'boiled', stated: false, qty: null, unit: null, g: 250, n: { kcal: 160, p: 3, c: 35, f: 1, fib: null, sug: null, na: null }, assume: '১ প্লেট ধরে নেওয়া হয়েছে' }),
        item({ name: 'মুরগির তরকারি', en: 'chicken curry', prep: 'curried', stated: false, qty: null, unit: null, g: 170 }),
        item({ name: 'ডাল', en: 'dal', prep: 'curried', stated: false, qty: null, unit: null, g: 200 }),
      ]),
      { records },
    );
    const [rice, curry, dal] = r.items;
    expect(rice).toMatchObject({ grams: 250, kcal: 278, source: { type: 'verified_record' }, quantityStated: false, assumption: '১ প্লেট ধরে নেওয়া হয়েছে' });
    expect(curry).toMatchObject({ kcal: 182, source: { type: 'verified_record' } });
    expect(dal).toMatchObject({ kcal: 290, source: { type: 'verified_record' } });
    // The meal total is the sum of the items, each from its own basis.
    expect(r.totals.kcal).toBe(278 + 182 + 290);
    expect(r.totals.proteinG).toBeCloseTo(rice!.proteinG! + curry!.proteinG! + dal!.proteinG!, 1);
  });

  it('keeps the draft basis for the same food, so a correction changes only the amount', () => {
    const draft = [{ name: 'Chicken pizza', grams: 215, per100g: { kcal: 250, proteinG: 12, carbsG: 28, fatG: 10, fiberG: 2, sugarG: 3, sodiumMg: 560 } }];
    // The model answers the correction with slightly different numbers per 100 g.
    const r = normaliseDescribe(out([item({ qty: 150, g: 150, n: { kcal: 270, p: 11, c: 30, f: 12, fib: 2, sug: 3, na: 600 } })]), { draft, text: 'Actually, it was 150 g' });
    expect(r.items[0]).toMatchObject({ grams: 150, kcal: 375, proteinG: 18, per100g: { kcal: 250 } });
  });

  it('turns impossible densities into unknown, never zero, and lists them as incomplete', () => {
    const r = normaliseDescribe(out([item({ n: { kcal: 2500, p: 300, c: 28, f: 10, fib: null, sug: null, na: null } })]));
    expect(r.items[0]!.kcal).toBeNull();
    expect(r.items[0]!.proteinG).toBeNull();
    expect(r.totals.incomplete).toEqual(expect.arrayContaining(['kcal', 'proteinG']));
    expect(describeValuesSane(r)).toBe(true);
  });

  it('clamps nonsense weights into the item range', () => {
    const r = normaliseDescribe(out([item({ qty: 50, unit: 'kg', g: 50000 }), item({ stated: false, qty: null, unit: null, g: -4 })]));
    expect(r.items.map((i) => i.grams)).toEqual([2000, 1]);
  });

  it('passes a follow-up question through with the assumed draft', () => {
    const r = normaliseDescribe(out([item({ name: 'Pizza', en: 'pizza', stated: false, qty: null, unit: null, g: 220, assume: 'Assumed 2 slices' })], { status: 'needs_info', question: 'How many slices did you have?' }));
    expect(r).toMatchObject({ status: 'needs_info', clarifyingQuestion: 'How many slices did you have?' });
    expect(r.items[0]).toMatchObject({ quantityStated: false, assumption: 'Assumed 2 slices' });
  });

  it('drops a question on an ok answer, and returns no items for not-food text', () => {
    expect(normaliseDescribe(out([item()], { question: 'Anything else?' })).clarifyingQuestion).toBeNull();
    const nf = normaliseDescribe(out([item()], { status: 'not_food', mealName: null, question: 'What did you eat?' }));
    expect(nf).toMatchObject({ status: 'not_food', items: [], mealName: null, clarifyingQuestion: 'What did you eat?', totals: { kcal: 0 } });
  });

  it('passes meal and day from the text, and caps the list at 15 foods', () => {
    const many = Array.from({ length: 20 }, (_, i) => item({ name: `Food ${i}`, en: `food ${i}` }));
    const r = normaliseDescribe(out(many, { category: 'lunch', day: 'yesterday' }));
    expect(r.items).toHaveLength(15);
    expect(r).toMatchObject({ category: 'lunch', day: 'yesterday' });
  });

  it('names an untitled meal after its foods', () => {
    expect(normaliseDescribe(out([item(), item({ name: 'Cola', en: 'cola' })], { mealName: '  ' })).mealName).toBe('Chicken pizza, Cola');
  });
});

describe('MealDescribeOutputSchema', () => {
  it('rejects unknown fields and wrong types', () => {
    expect(MealDescribeOutputSchema.safeParse(out([item()])).success).toBe(true);
    expect(MealDescribeOutputSchema.safeParse({ ...out([item()]), extra: 1 }).success).toBe(false);
    expect(MealDescribeOutputSchema.safeParse(out([{ ...item(), g: '215' } as unknown as Item])).success).toBe(false);
    expect(MealDescribeOutputSchema.safeParse(out([{ ...item(), unit: 'spoonful' } as unknown as Item])).success).toBe(false);
  });
});
