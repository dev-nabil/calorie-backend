/**
 * `pnpm plan:smoke [--fake] [--locale bn]`
 * One real call to Gemini with the exact prompt, structured-output schema, model and checks the plan
 * personalisation uses, for a made-up sample profile. Run it once after adding GEMINI_API_KEY.
 * Needs no database. Prints the model, token usage, the validated narrative or why it was rejected;
 * never prints the key. Exit code 0 only when a narrative passed every check.
 * --fake   runs the same path against the built-in fake provider (checks this script, not Gemini)
 * --locale the language the tips are written in (en, bn); the rule pack of that language checks the answer
 */
import { existsSync } from 'node:fs';
import { ConfigError, loadConfig } from '../config/env';
import { loadContentBundle } from '../modules/content/content.loader';
import { fillTemplate } from '../modules/content/content.loader';
import { AiProvider, FakeAiProvider, PLAN_NARRATIVE_EXAMPLE } from '../modules/ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../modules/ai/ai-models';
import { GeminiProvider } from '../modules/ai/providers/gemini.provider';
import { PlanNarrativeSchema } from '../shared';
import { loadQuestionSet, type ProfileFields } from '../domain/onboarding-engine';
import { assessPlan, buildBasis, estimateTimeframe } from '../domain/plan-assessment';
import { calculatePlan } from '../domain/plan-calculator';
import { buildNarrativeContext, checkNarrative, makeLabeler } from '../domain/plan-narrative';
import { translatorFor } from '../shared/i18n';
import { DEFAULT_LOCALE, parseLocale } from '../shared/locales';
import { languageDirective } from '../modules/ai/language';

const SAMPLE: ProfileFields = {
  primaryGoal: 'lose', supportingGoals: ['energy'], personalMotivation: null, requestedFeatures: [], displayName: null, ageYears: 34, birthDate: null,
  calculationSex: 'female', heightCm: 168, weightKg: 82, weightIsEstimate: false, targetWeightKg: 74, activityLevel: 'light', dietPattern: 'veg',
  mealSource: 'mix', nutritionFamiliarity: 'some', startingMood: 'ready', habitPriorities: ['water'], loggingMethods: ['photo'], timeframeWeeks: 26,
  allergies: ['peanuts'], allergyOther: null, dietPatternOther: null, mealsPerDay: 'three', schedulePattern: 'shifts', higherIntakePattern: 'yes',
  trackingExperience: null, routineBarriers: ['busy'], eatingCues: [], lifeStage: 'none', movementActions: ['walk'],
};

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const fake = process.argv.includes('--fake');
  const li = process.argv.indexOf('--locale');
  const locale = (li >= 0 ? parseLocale(process.argv[li + 1]) : null) ?? DEFAULT_LOCALE;
  const tr = translatorFor(locale);
  let provider: AiProvider;
  if (fake) {
    const f = new FakeAiProvider();
    f.configured = true;
    f.enqueue(structuredClone(PLAN_NARRATIVE_EXAMPLE));
    provider = f;
  } else {
    if (config.AI_PROVIDER !== 'gemini' || !config.GEMINI_API_KEY) {
      console.error('Not configured. In .env set  AI_PROVIDER=gemini  and  GEMINI_API_KEY=<your key>, then run this again.');
      process.exit(2);
    }
    provider = new GeminiProvider(config.GEMINI_API_KEY);
  }

  const bundle = loadContentBundle(config.CONTENT_DIR);
  const prompt = bundle.prompts.find((p) => p.key === 'plan-narrative');
  if (!prompt) throw new Error('content/prompts/plan-narrative.v1.md not found');
  const set = loadQuestionSet(bundle.questions);
  const inputs = {
    ageYears: SAMPLE.ageYears, calculationSex: SAMPLE.calculationSex, heightCm: SAMPLE.heightCm, weightKg: SAMPLE.weightKg,
    activityLevel: SAMPLE.activityLevel, goal: SAMPLE.primaryGoal, targetWeightKg: SAMPLE.targetWeightKg, lifeStage: SAMPLE.lifeStage,
    allergies: SAMPLE.allergies,
  };
  const preview = calculatePlan(inputs);
  const timeframe = estimateTimeframe({ goal: 'lose', weightKg: 82, targetWeightKg: 74, tdeeKcal: preview.tdeeKcal!, energyKcal: preview.calculated!.energyKcal, requestedWeeks: 26 }, tr);
  const assessment = assessPlan(inputs, tr);
  const facts = buildNarrativeContext({ profile: SAMPLE, preview, timeframe, assessment, label: makeLabeler(set), locale });

  const model = config.GEMINI_PLAN_MODEL || (typeof prompt.meta.model === 'string' ? prompt.meta.model : '') || DEFAULT_TEXT_MODEL;
  console.warn(`\nPlan personalisation smoke test: provider=${provider.name}, model=${model}, language=${locale}`);
  console.warn(`Validated numbers: target ${preview.calculated!.energyKcal} kcal, maintenance ${preview.tdeeKcal} kcal; ${buildBasis(preview, inputs, timeframe, tr).length} basis lines\n`);

  const started = Date.now();
  const res = await provider.structured({
    task: 'plan_narrative',
    model,
    instructions: prompt.staticPrefix,
    context: languageDirective(locale) + fillTemplate(prompt.dynamicTemplate, { facts: facts.context, retryNote: '' }),
    timeoutMs: (Number(prompt.meta.timeoutSec) || 40) * 1000,
    maxOutputTokens: Number(prompt.meta.maxOutputTokens) || 3000,
    thinking: 'low',
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.warn(`Answer in ${seconds}s from ${res.model}; tokens in ${res.usage.inputTokens} (cached ${res.usage.cachedTokens}), out ${res.usage.outputTokens}`);

  const parsed = PlanNarrativeSchema.safeParse(res.output);
  if (!parsed.success) {
    console.error('\nREJECTED by the schema:');
    for (const i of parsed.error.issues.slice(0, 8)) console.error(`  - ${i.path.join('.') || 'output'}: ${i.message}`);
    console.error('\nRaw output:\n' + JSON.stringify(res.output, null, 2));
    process.exit(1);
  }
  const check = checkNarrative(parsed.data, facts.avoidTerms, locale);
  console.warn('\n' + JSON.stringify(parsed.data, null, 2));
  if (!check.ok) {
    console.error('\nREJECTED by the content rules (the app would retry once, then show no tips):');
    for (const p of check.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.warn('\nOK: schema and content rules passed. A live plan would show exactly this.');
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else {
    const e = err as { status?: number; message?: string };
    console.error(`FAILED${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message ?? String(err)}`);
  }
  process.exit(1);
});
