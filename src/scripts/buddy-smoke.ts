/**
 * Milo buddy live check (decision 0016): sends the real coach-interpret prompt to the real Gemini model for a few chat
 * messages and runs the answers through the server's own validation and draft calculator. No database. Under a cent.
 * Usage: pnpm buddy:smoke [--fake]
 */
import { existsSync } from 'node:fs';
import { loadConfig } from '../config/env';
import { applyModelOps, compactDraft, type DraftContext } from '../domain/chat-draft';
import { AiProvider, FakeAiProvider } from '../modules/ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../modules/ai/ai-models';
import { coachLanguageDirective } from '../modules/ai/language';
import { GeminiProvider } from '../modules/ai/providers/gemini.provider';
import { fillTemplate, loadContentBundle } from '../modules/content/content.loader';
import { InterpretOutputSchema, type ChatDraft, type InterpretOutput } from '../shared';

let n = 0;
const ctx: DraftContext = { newId: () => `d${++n}`, conversationId: 'smoke', now: new Date() };

interface Scenario {
  name: string;
  text: string;
  draft?: () => ChatDraft | null;
  check: (o: InterpretOutput, d: ChatDraft | null) => string[];
}

let recipeDraft: ChatDraft | null = null;
const SCENARIOS: Scenario[] = [
  {
    name: 'Banglish recipe with a portion',
    text: 'Ami 500 gram murgi, 30 gram tel ar 100 gram peyaj diye ranna korechi. 4 bhag korechi, ekta kheyechi.',
    check: (o, d) => {
      recipeDraft = d;
      return [
        ...(d?.kind === 'recipe' ? [] : ['not a recipe draft']),
        ...(d?.items.length === 3 ? [] : [`expected 3 items, got ${d?.items.length}`]),
        ...(d?.items.find((i) => i.grams === 30) ? [] : ['oil is not 30 g']),
        ...(d?.recipe?.servings === 4 ? [] : [`servings ${d?.recipe?.servings}`]),
        ...(d?.portionTotals ? [] : ['no portion computed']),
      ];
    },
  },
  {
    name: 'English correction keeps the draft and changes one item',
    text: 'Actually, the oil was 20 g.',
    draft: () => recipeDraft,
    check: (o, d) => [...(d?.items.length === 3 ? [] : ['item count changed']), ...(d?.items.some((i) => /oil|tel|তেল/i.test(`${i.name} ${i.canonicalName}`) && i.grams === 20) ? [] : ['oil not 20 g'])],
  },
  {
    name: 'Ambiguous reference is not guessed',
    text: 'make it 150 g',
    draft: () => recipeDraft,
    check: (o) => (o.clarify || o.ops.every((x) => x.itemId === null) ? [] : [`guessed ${o.ops.map((x) => x.itemId).join(',')}`]),
  },
  {
    name: 'Health question changes nothing',
    text: 'Can I stop my metformin if I eat less sugar?',
    check: (o) => (o.ops.length === 0 && o.act === null ? [] : ['ops or act on a medical question']),
  },
];

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const fake = process.argv.includes('--fake');
  let provider: AiProvider;
  if (fake) provider = new FakeAiProvider();
  else {
    if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set (.env). Use --fake to check the script only.');
    provider = new GeminiProvider(config.GEMINI_API_KEY);
  }
  const bundle = loadContentBundle(config.CONTENT_DIR);
  const prompt = bundle.prompts.filter((p) => p.key === 'coach-interpret').sort((a, b) => b.version - a.version)[0];
  if (!prompt) throw new Error('content/prompts/coach-interpret.vN.md is missing');
  const model = (typeof prompt.meta.model === 'string' ? prompt.meta.model : '') || DEFAULT_TEXT_MODEL;
  console.warn(`\nBuddy smoke: provider=${provider.name}, model=${model}, prompt=coach-interpret.v${prompt.version}\n`);
  let failures = 0;
  for (const [i, s] of SCENARIOS.entries()) {
    const started = Date.now();
    const draft = s.draft?.() ?? null;
    try {
      const res = await provider.structured({
        task: 'coach_interpret',
        model,
        instructions: prompt.staticPrefix,
        context:
          coachLanguageDirective('en', null, s.text) +
          fillTemplate(prompt.dynamicTemplate, {
            todayDate: '2026-11-16',
            selectedDate: '2026-11-16',
            localTime: '13:00',
            mode: 'full',
            memoryOn: 'on',
            profileJson: JSON.stringify({ dietPattern: null, allergies: null, units: { weight: 'kg', height: 'cm' } }),
            draftJson: JSON.stringify(compactDraft(draft)),
            recipesJson: '[]',
            recentJson: '[]',
            text: s.text,
          }),
        timeoutMs: 20_000,
        maxOutputTokens: 1600,
        thinking: 'minimal',
      });
      const parsed = InterpretOutputSchema.safeParse(res.output);
      if (!parsed.success) throw new Error(`schema: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      const o = parsed.data;
      const applied = applyModelOps(draft, o.ops, ctx, o.intent === 'recipe' ? 'recipe' : 'meal');
      const problems = fake ? [] : s.check(o, applied.draft);
      failures += problems.length ? 1 : 0;
      console.warn(`${problems.length ? 'FAIL' : 'ok  '} ${i + 1}. ${s.name} (${((Date.now() - started) / 1000).toFixed(1)}s, ${res.usage.inputTokens} in / ${res.usage.outputTokens} out)`);
      console.warn(`     > ${s.text}`);
      console.warn(`     intent ${o.intent}; ops ${o.ops.map((x) => `${x.op}${x.itemId ? `(${x.itemId})` : ''}`).join(', ') || '-'}; clarify ${o.clarify?.question ?? '-'}`);
      const d = applied.draft;
      if (d) console.warn(`     draft v${d.version} ${d.kind}: ${d.items.map((x) => `${x.name} ${x.grams} g = ${x.kcal} kcal`).join('; ')} → total ${d.totals.kcal} kcal, portion ${d.portionTotals?.kcal ?? '-'} kcal`);
      for (const p of problems) console.warn(`     ! ${p}`);
    } catch (e) {
      failures++;
      console.warn(`FAIL ${i + 1}. ${s.name}: ${(e as Error).message}`);
    }
  }
  console.warn(`\n${failures ? `${failures} scenario(s) failed` : 'all scenarios passed'}\n`);
  process.exit(failures ? 1 : 0);
}

void main();
