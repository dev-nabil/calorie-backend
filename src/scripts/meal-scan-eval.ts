/**
 * Meal-scan eval harness (plan §16, M4-T6). `pnpm eval:meal-scan` — see evals/meal-scan/README.md.
 * The real provider only runs with both `--allow-real` and EVAL_ALLOW_REAL=1.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FoodIndex } from '../domain/food-nutrition';
import { normaliseAnalysis, parseModelOutput } from '../domain/nutrition-validator';
import { prepareScanImage } from '../infra/media/scan-image';
import { FakeAiProvider } from '../modules/ai/ai.provider';
import { geminiCostUsd, knownGeminiPrice } from '../modules/ai/gemini-pricing';
import { FakeFoodVisionProvider, type FoodVisionProvider } from '../modules/ai/providers/food-vision.provider';
import { GeminiFoodProvider } from '../modules/ai/providers/gemini-food.provider';
import { loadContentBundle } from '../modules/content/content.loader';
import { FoodRecordsService } from '../modules/content/food-records.service';

export interface EvalFixture {
  id: string;
  category?: string;
  expected: { isFood: boolean; kcal: number; items: { name: string; match: string[] }[] };
  fakeOutput?: unknown;
}

export interface EvalRow {
  id: string;
  ok: boolean;
  isFoodCorrect: boolean;
  kcal: number | null;
  kcalApe: number | null;
  recall: number | null;
  latencyMs: number;
  costUsd: number;
  error: string | null;
}

export interface EvalReport {
  provider: string;
  model: string;
  n: number;
  kcalMape: number | null;
  itemRecall: number | null;
  nonFoodAccuracy: number | null;
  meanLatencyMs: number;
  costPerScanUsd: number;
  rows: EvalRow[];
}

export function loadFixtures(dir: string): EvalFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalFixture);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n: number | null, d = 3) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

export async function runEval(
  fixtures: EvalFixture[],
  provider: FoodVisionProvider,
  opts: { model: string; imageDir?: string; instructions?: string; records?: FoodIndex; resolution?: 'low' | 'medium' | 'high' },
): Promise<EvalReport> {
  const rows: EvalRow[] = [];
  const price = knownGeminiPrice(opts.model) ?? { inputPerM: 0, cachedPerM: 0, outputPerM: 0 };
  for (const fx of fixtures) {
    if (provider instanceof FakeFoodVisionProvider) provider.script({ output: fx.fakeOutput ?? { nope: 1 } });
    const image = opts.imageDir ? join(opts.imageDir, `${fx.id}.jpg`) : null;
    const bytes = image && existsSync(image) ? await prepareScanImage(readFileSync(image), 1024) : Buffer.alloc(0);
    const started = Date.now();
    try {
      const res = await provider.analyse({
        model: opts.model,
        instructions: opts.instructions ?? 'List the foods in the photo.',
        context: '',
        image: { bytes, mimeType: 'image/jpeg' },
        resolution: opts.resolution ?? 'high',
        thinkingLevel: 'low',
        maxOutputTokens: 4096,
        timeoutMs: 25_000,
      });
      const latencyMs = Date.now() - started;
      const costUsd = geminiCostUsd(res.usage, price);
      const parsed = parseModelOutput(res.output);
      if (!parsed.ok) {
        rows.push({ id: fx.id, ok: false, isFoodCorrect: false, kcal: null, kcalApe: null, recall: null, latencyMs, costUsd, error: parsed.issues.join('; ') });
        continue;
      }
      const a = normaliseAnalysis(parsed.value, opts.records ? { records: opts.records } : {}).analysis;
      const isFoodCorrect = a.isFood === fx.expected.isFood;
      const names = a.items.map((i) => i.name.toLowerCase());
      const recall = fx.expected.items.length ? fx.expected.items.filter((e) => e.match.some((m) => names.some((n) => n.includes(m.toLowerCase())))).length / fx.expected.items.length : null;
      const kcalApe = fx.expected.isFood && fx.expected.kcal > 0 && a.totals.kcal !== null ? Math.abs(a.totals.kcal - fx.expected.kcal) / fx.expected.kcal : null;
      rows.push({ id: fx.id, ok: true, isFoodCorrect, kcal: a.totals.kcal, kcalApe, recall, latencyMs, costUsd, error: null });
    } catch (e) {
      rows.push({ id: fx.id, ok: false, isFoodCorrect: false, kcal: null, kcalApe: null, recall: null, latencyMs: Date.now() - started, costUsd: 0, error: (e as Error).message });
    }
  }
  const food = fixtures.filter((f) => f.expected.isFood).map((f) => f.id);
  const nonFood = rows.filter((r) => !food.includes(r.id));
  return {
    provider: provider.name,
    model: opts.model,
    n: rows.length,
    kcalMape: round(mean(rows.filter((r) => r.kcalApe !== null).map((r) => r.kcalApe!))),
    itemRecall: round(mean(rows.filter((r) => r.recall !== null).map((r) => r.recall!))),
    nonFoodAccuracy: nonFood.length ? round(nonFood.filter((r) => r.isFoodCorrect).length / nonFood.length) : null,
    meanLatencyMs: Math.round(mean(rows.map((r) => r.latencyMs)) ?? 0),
    costPerScanUsd: round(mean(rows.map((r) => r.costUsd)) ?? 0, 6)!,
    rows,
  };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const root = resolve(__dirname, '..', '..', 'evals', 'meal-scan');
  const content = resolve(__dirname, '..', '..', 'content');
  const providerName = arg('provider', 'fake');
  let provider: FoodVisionProvider = new FakeFoodVisionProvider(new FakeAiProvider());
  if (providerName === 'gemini') {
    if (!process.argv.includes('--allow-real') || process.env.EVAL_ALLOW_REAL !== '1' || !process.env.GEMINI_API_KEY) {
      throw new Error('The real provider needs --allow-real, EVAL_ALLOW_REAL=1 and GEMINI_API_KEY');
    }
    provider = new GeminiFoodProvider(process.env.GEMINI_API_KEY);
  }
  const prompt = loadContentBundle(content).prompts.filter((p) => p.key === 'meal-scan').sort((a, b) => b.version - a.version)[0];
  const resolution = arg('resolution', 'high') as 'low' | 'medium' | 'high';
  const report = await runEval(loadFixtures(join(root, 'fixtures')), provider, {
    model: arg('model', 'gemini-3.8-flash')!,
    imageDir: join(root, 'images'),
    resolution,
    records: new FoodRecordsService({ CONTENT_DIR: content } as never).index,
    ...(prompt ? { instructions: prompt.staticPrefix } : {}),
  });
  mkdirSync(join(root, 'reports'), { recursive: true });
  const out = join(root, 'reports', `${new Date().toISOString().replace(/[:.]/g, '-')}-${report.provider}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.warn(`n=${report.n} kcalMAPE=${report.kcalMape} recall=${report.itemRecall} nonFood=${report.nonFoodAccuracy} latency=${report.meanLatencyMs}ms cost/scan=$${report.costPerScanUsd}\n${out}`);
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
