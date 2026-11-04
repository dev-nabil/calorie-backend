/**
 * Meal-scan eval harness (plan §16, M4-T6). `pnpm eval:meal-scan` — see evals/meal-scan/README.md.
 * The real provider only runs with both `--allow-real` and EVAL_ALLOW_REAL=1.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normaliseAnalysis, parseModelOutput } from '../domain/nutrition-validator';
import { FakeAiProvider, OpenAiProvider, type AiProvider } from '../modules/ai/ai.provider';

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

export interface Price {
  inPerM: number;
  cachedPerM: number;
  outPerM: number;
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
  provider: AiProvider,
  opts: { model: string; imageDir?: string; price?: Price; instructions?: string },
): Promise<EvalReport> {
  const rows: EvalRow[] = [];
  for (const fx of fixtures) {
    if (provider instanceof FakeAiProvider) provider.enqueue(fx.fakeOutput ?? new Error('fixture has no fakeOutput'));
    const image = opts.imageDir ? join(opts.imageDir, `${fx.id}.jpg`) : null;
    const imageUrl = image && existsSync(image) ? `data:image/jpeg;base64,${readFileSync(image).toString('base64')}` : 'data:,';
    const started = Date.now();
    try {
      const res = await provider.analyseMeal({ model: opts.model, instructions: opts.instructions ?? 'Analyse the meal photo.', context: `Meal category: ${fx.category ?? ''}`, imageUrl, timeoutMs: 25_000, maxOutputTokens: 1200 });
      const latencyMs = Date.now() - started;
      const p = opts.price ?? { inPerM: 0, cachedPerM: 0, outPerM: 0 };
      const costUsd = ((res.usage.inputTokens - res.usage.cachedTokens) * p.inPerM + res.usage.cachedTokens * p.cachedPerM + res.usage.outputTokens * p.outPerM) / 1e6;
      const parsed = parseModelOutput(res.output);
      if (!parsed.ok) {
        rows.push({ id: fx.id, ok: false, isFoodCorrect: false, kcal: null, kcalApe: null, recall: null, latencyMs, costUsd, error: parsed.issues.join('; ') });
        continue;
      }
      const a = normaliseAnalysis(parsed.value).analysis;
      const isFoodCorrect = a.isFood === fx.expected.isFood;
      const names = a.items.map((i) => i.name.toLowerCase());
      const recall = fx.expected.items.length ? fx.expected.items.filter((e) => e.match.some((m) => names.some((n) => n.includes(m.toLowerCase())))).length / fx.expected.items.length : null;
      const kcalApe = fx.expected.isFood && fx.expected.kcal > 0 ? Math.abs(a.totals.kcal - fx.expected.kcal) / fx.expected.kcal : null;
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
  const providerName = arg('provider', 'fake');
  let provider: AiProvider = new FakeAiProvider();
  if (providerName === 'openai') {
    if (!process.argv.includes('--allow-real') || process.env.EVAL_ALLOW_REAL !== '1' || !process.env.OPENAI_API_KEY) {
      throw new Error('The real provider needs --allow-real, EVAL_ALLOW_REAL=1 and OPENAI_API_KEY');
    }
    provider = new OpenAiProvider(process.env.OPENAI_API_KEY);
  }
  const report = await runEval(loadFixtures(join(root, 'fixtures')), provider, {
    model: arg('model', 'gpt-5-mini')!,
    imageDir: join(root, 'images'),
    price: { inPerM: Number(arg('price-in', '0')), cachedPerM: Number(arg('price-cached', '0')), outPerM: Number(arg('price-out', '0')) },
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
