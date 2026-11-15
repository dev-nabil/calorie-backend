/**
 * `pnpm describe:smoke [--fake] [--only <n>]`
 * Real calls to Gemini with the exact text-logging prompt, schema, context and normaliser that POST /meals/describe uses.
 * It checks what a mock cannot: that Gemini accepts the schema, keeps stated weights, reads Bangla and Banglish, asks a
 * short question when an amount is missing, and applies a correction to the draft. About 8 calls, well under a cent.
 * Needs no database. Never prints the key. Exit code 0 only when every check passed.
 * --fake   runs the same path against the built-in fake provider (checks this script, not Gemini)
 * --only   run one scenario by its number
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../config/env';
import { buildFoodIndex, type FoodRecord } from '../domain/food-nutrition';
import { normaliseDescribe } from '../domain/nutrition-validator';
import { AiProvider, FakeAiProvider } from '../modules/ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../modules/ai/ai-models';
import { GeminiProvider } from '../modules/ai/providers/gemini.provider';
import { defaultContentDir, latestVersionedFile, loadContentBundle } from '../modules/content/content.loader';
import { describeContext, MEAL_DESCRIBE_TIMEOUT_MS } from '../modules/meal-parse/meal-describe.handler';
import { MealDescribeOutputSchema, type MealDescribeRequest, type MealDescribeResponse } from '../shared';
import type { LocaleCode } from '../shared/locales';

interface Scenario {
  name: string;
  locale: LocaleCode;
  req: MealDescribeRequest;
  check: (r: MealDescribeResponse) => string[];
}

const BN = /[ঀ-৿]/;
const grams = (r: MealDescribeResponse, re: RegExp) => r.items.find((i) => re.test(`${i.canonicalName} ${i.name}`))?.grams;
const totalsAddUp = (r: MealDescribeResponse): string[] => {
  const sum = r.items.reduce((a, i) => a + (i.kcal ?? 0), 0);
  return Math.abs(sum - (r.totals.kcal ?? 0)) <= 1 ? [] : [`total ${r.totals.kcal} kcal is not the sum of the items (${sum})`];
};
const kcalPlausible = (r: MealDescribeResponse): string[] =>
  r.items.flatMap((i) => (i.kcal !== null && i.per100g.kcal !== null && (i.per100g.kcal > 900 || i.kcal > 6000) ? [`${i.name}: implausible ${i.kcal} kcal`] : []));

const PIZZA_DRAFT = { mealName: 'Chicken pizza', items: [{ name: 'Chicken pizza', grams: 215, portion: '215 g', per100g: { kcal: 250, proteinG: 12, carbsG: 28, fatG: 10, fiberG: 2, sugarG: 3, sodiumMg: 560 } }] };

const SCENARIOS: Scenario[] = [
  {
    name: 'English: explicit grams are kept',
    locale: 'en',
    req: { text: 'I ate 215 g of chicken pizza.' },
    check: (r) => [...(r.items.length === 1 ? [] : [`expected 1 item, got ${r.items.length}`]), ...(grams(r, /pizza/i) === 215 ? [] : [`pizza is ${grams(r, /pizza/i)} g, not 215`]), ...(r.items[0]?.quantityStated ? [] : ['not marked as stated']), ...totalsAddUp(r)],
  },
  {
    name: 'English: several foods, counts and a glass',
    locale: 'en',
    req: { text: 'I ate two boiled eggs and drank a glass of milk.' },
    check: (r) => [
      ...(r.items.length === 2 ? [] : [`expected 2 items, got ${r.items.length}`]),
      ...((grams(r, /egg/i) ?? 0) >= 80 && (grams(r, /egg/i) ?? 0) <= 130 ? [] : [`eggs ${grams(r, /egg/i)} g`]),
      ...((grams(r, /milk/i) ?? 0) >= 200 && (grams(r, /milk/i) ?? 0) <= 300 ? [] : [`milk ${grams(r, /milk/i)} g`]),
      ...totalsAddUp(r),
      ...kcalPlausible(r),
    ],
  },
  {
    name: 'English: rice, curry and dal for lunch (meal named, published records)',
    locale: 'en',
    req: { text: 'I had rice, chicken curry, and dal for lunch.' },
    check: (r) => [
      ...(r.items.length === 3 ? [] : [`expected 3 items, got ${r.items.length}`]),
      ...(r.category === 'lunch' ? [] : [`category ${r.category}`]),
      ...(r.items.some((i) => i.source.type === 'verified_record') ? [] : ['no item matched a published record']),
      ...totalsAddUp(r),
      ...kcalPlausible(r),
    ],
  },
  {
    name: 'Bangla (app in Bangla): grams in Bangla digits',
    locale: 'bn',
    req: { text: 'আমি ২১৫ গ্রাম চিকেন পিজ্জা খেয়েছি' },
    check: (r) => [...(grams(r, /pizza|পিজ/i) === 215 ? [] : [`pizza is ${grams(r, /pizza|পিজ/i)} g, not 215`]), ...(BN.test(r.items[0]?.name ?? '') ? [] : ['food name not in Bangla']), ...totalsAddUp(r)],
  },
  {
    name: 'Bangla: rice, chicken curry and dal at lunch',
    locale: 'bn',
    req: { text: 'দুপুরে ভাত, মুরগির তরকারি আর ডাল খেয়েছি' },
    check: (r) => [...(r.items.length === 3 ? [] : [`expected 3 items, got ${r.items.length}`]), ...(r.category === 'lunch' ? [] : [`category ${r.category}`]), ...totalsAddUp(r), ...kcalPlausible(r)],
  },
  {
    name: 'Missing amount of a big item: one short question, draft kept',
    locale: 'en',
    req: { text: 'I had biryani' },
    check: (r) => [
      ...(r.items.length >= 1 ? [] : ['no draft items']),
      ...(r.status === 'needs_info' && r.clarifyingQuestion && r.clarifyingQuestion.split(/\s+/).length <= 14 ? [] : [`status ${r.status}, question "${r.clarifyingQuestion}"`]),
      ...(r.items[0]?.quantityStated === false ? [] : ['assumed amount not marked as assumed']),
    ],
  },
  {
    name: 'Correction: "Actually, it was 150 g" updates the draft',
    locale: 'en',
    req: { text: 'Actually, it was 150 g', history: ['I ate 215 g of chicken pizza.'], draft: PIZZA_DRAFT },
    check: (r) => [...(r.items.length === 1 ? [] : [`expected 1 item, got ${r.items.length}`]), ...(r.items[0]?.grams === 150 ? [] : [`grams ${r.items[0]?.grams}`]), ...(r.items[0]?.kcal === 375 ? [] : [`kcal ${r.items[0]?.kcal}, expected 375 from the draft basis`])],
  },
  {
    name: 'Answer to the question: "2 plates" sets the amount, nothing else added',
    locale: 'en',
    req: {
      text: '2 plates',
      history: ['I had biryani'],
      draft: { mealName: 'Biryani', items: [{ name: 'Biryani', grams: 350, portion: '1 plate', per100g: { kcal: 145, proteinG: 8.5, carbsG: 12.2, fatG: 6.8, fiberG: null, sugarG: null, sodiumMg: null } }] },
    },
    check: (r) => [...(r.items.length === 1 ? [] : [`expected 1 item, got ${r.items.length}`]), ...((r.items[0]?.grams ?? 0) >= 500 ? [] : [`grams ${r.items[0]?.grams} for 2 plates`]), ...(r.items[0]?.quantityStated ? [] : ['not marked as stated']), ...(r.status === 'ok' ? [] : [`status ${r.status}`])],
  },
  {
    name: 'Banglish: "2 ta dim ar ek cup cha"',
    locale: 'en',
    req: { text: 'sokale 2 ta dim ar ek cup cha khaisi' },
    check: (r) => [...(r.items.length === 2 ? [] : [`expected 2 items, got ${r.items.length}`]), ...((grams(r, /egg/i) ?? 0) >= 80 ? [] : [`eggs ${grams(r, /egg/i)} g`]), ...(r.category === 'breakfast' ? [] : [`category ${r.category}`]), ...totalsAddUp(r)],
  },
  {
    name: 'Not food: no items, a friendly question',
    locale: 'en',
    req: { text: 'What is the capital of France?' },
    check: (r) => (r.status === 'not_food' && r.items.length === 0 && r.clarifyingQuestion ? [] : [`status ${r.status}, ${r.items.length} items`]),
  },
];

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const fake = process.argv.includes('--fake');
  const oi = process.argv.indexOf('--only');
  const only = oi >= 0 ? Number(process.argv[oi + 1]) : null;
  let provider: AiProvider;
  if (fake) {
    provider = new FakeAiProvider();
  } else {
    if (!config.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set (.env). Use --fake to check the script only.');
      process.exit(1);
    }
    provider = new GeminiProvider(config.GEMINI_API_KEY);
  }
  const bundle = loadContentBundle(config.CONTENT_DIR);
  const prompt = bundle.prompts.filter((p) => p.key === 'meal-describe').sort((a, b) => b.version - a.version)[0];
  if (!prompt) throw new Error('content/prompts/meal-describe.vN.md is missing');
  const model = (typeof prompt.meta.model === 'string' ? prompt.meta.model : '') || DEFAULT_TEXT_MODEL;
  const recordsFile = latestVersionedFile(join(config.CONTENT_DIR ?? defaultContentDir(), 'food-records'), 'food-records');
  const data = recordsFile ? (JSON.parse(readFileSync(recordsFile, 'utf8')) as { records: FoodRecord[]; sources: Record<string, { name: string }> }) : { records: [], sources: {} };
  const records = buildFoodIndex(data.records, data.sources);
  console.warn(`\nDescribe smoke test: provider=${provider.name}, model=${model}, prompt=meal-describe.v${prompt.version}, ${SCENARIOS.length} scenarios\n`);

  let failures = 0;
  for (const [i, s] of SCENARIOS.entries()) {
    if (only !== null && only !== i + 1) continue;
    const started = Date.now();
    try {
      const res = await provider.structured({
        task: 'meal_describe',
        model,
        instructions: prompt.staticPrefix,
        context: describeContext(prompt.dynamicTemplate, s.req, s.locale),
        timeoutMs: MEAL_DESCRIBE_TIMEOUT_MS,
        maxOutputTokens: 1600,
      });
      const parsed = MealDescribeOutputSchema.safeParse(res.output);
      if (!parsed.success) throw new Error(`schema: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      const r = normaliseDescribe(parsed.data, { records, draft: s.req.draft?.items ?? [], text: s.req.text });
      const problems = fake ? [] : s.check(r);
      failures += problems.length ? 1 : 0;
      console.warn(`${problems.length ? 'FAIL' : 'ok  '} ${i + 1}. ${s.name} (${((Date.now() - started) / 1000).toFixed(1)}s, ${res.usage.outputTokens} out tokens)`);
      console.warn(`     > ${s.req.text}`);
      console.warn(`     ${r.status} · ${r.mealName ?? '-'} · ${r.totals.kcal} kcal${r.category ? ` · ${r.category}` : ''}${r.clarifyingQuestion ? ` · ? ${r.clarifyingQuestion}` : ''}`);
      for (const it of r.items) {
        console.warn(`       - ${it.name} [${it.canonicalName}] ${it.portion ?? ''} = ${it.grams} g → ${it.kcal} kcal, P ${it.proteinG} C ${it.carbsG} F ${it.fatG} (${it.source.type}${it.quantityStated ? ', stated' : ', assumed'})${it.assumption ? ` · ${it.assumption}` : ''}`);
      }
      for (const p of problems) console.warn(`     ! ${p}`);
    } catch (err) {
      failures++;
      const e = err as { status?: number; message?: string };
      console.warn(`FAIL ${i + 1}. ${s.name}: ${e.status ? `HTTP ${e.status} ` : ''}${e.message ?? String(err)}`);
    }
    console.warn('');
  }
  console.warn(failures ? `${failures} scenario(s) failed.` : 'OK: every scenario passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(`FAILED: ${(err as { message?: string }).message ?? String(err)}`);
  process.exit(1);
});
