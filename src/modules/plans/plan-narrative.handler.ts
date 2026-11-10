import { Injectable, OnModuleInit } from '@nestjs/common';
import { PlanNarrativeSchema, type PlanAiStatus, type PlanNarrative } from '../../shared';
import { checkNarrative } from '../../domain/plan-narrative';
import { translatorFor } from '../../shared/i18n';
import type { LocaleCode } from '../../shared/locales';
import { languageDirective } from '../ai/language';
import { AiJobs } from '../ai/ai-jobs';
import { AiProvider } from '../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../ai/ai-models';
import { AiService, AiUnavailableError } from '../ai/ai.service';
import { fillTemplate } from '../content/content.loader';
import { ContentService } from '../content/content.service';

export const PLAN_NARRATIVE_JOB = 'plan_narrative';
/** Whole budget for one generation, both attempts included (the app waits at most this long plus a little). */
export const PLAN_NARRATIVE_BUDGET_MS = 75_000;
const DEFAULT_MODEL = DEFAULT_TEXT_MODEL;
const DEFAULT_TIMEOUT_MS = 40_000;
const MIN_ATTEMPT_MS = 8_000;
const MAX_ATTEMPTS = 2;

export interface PlanNarrativeJob {
  facts: string;
  avoidTerms: string[];
  /** Reply language of the tips (the job runs outside the request context). */
  locale: LocaleCode;
}

export interface PlanNarrativeResult {
  status: PlanAiStatus;
  narrative: PlanNarrative | null;
  message: string | null;
  retryable: boolean;
  model: string | null;
  /** What the model got wrong on each rejected attempt (logged, never shown to the user). */
  rejected: string[][];
}

const fail = (status: Exclude<PlanAiStatus, 'ok' | 'skipped'>, retryable: boolean, model: string | null, locale: LocaleCode, rejected: string[][] = []): PlanNarrativeResult => ({
  status,
  narrative: null,
  message: translatorFor(locale)(`plan.ai.${status}`),
  retryable,
  model,
  rejected,
});

/**
 * An AI job (AiJobs): one structured call for the plan narrative. The answer must pass the
 * schema and the content rules (no figures, no allergens, no fasting); on a miss the model gets the
 * problems back once. A missing key, an open breaker, a timeout or a second miss end as an honest status:
 * nothing is ever substituted.
 */
@Injectable()
export class PlanNarrativeHandler implements OnModuleInit {
  constructor(
    private readonly handlers: AiJobs,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(PLAN_NARRATIVE_JOB, (p) => this.handle(p as PlanNarrativeJob));
  }

  async handle(job: PlanNarrativeJob): Promise<PlanNarrativeResult> {
    if (!this.provider.configured) return fail('not_configured', false, null, job.locale);

    const prompt = await this.content.activePrompt('plan-narrative');
    if (!prompt) return fail('unavailable', false, null, job.locale);
    const model = await this.ai.modelFor('plan', (typeof prompt.meta?.model === 'string' ? prompt.meta.model : '') || DEFAULT_MODEL);
    const timeoutMs = (prompt.params?.timeoutSec ?? 0) * 1000 || DEFAULT_TIMEOUT_MS;
    const maxOutputTokens = prompt.params?.maxOutputTokens || 3000;
    const deadline = Date.now() + PLAN_NARRATIVE_BUDGET_MS;
    const rejected: string[][] = [];
    let retryNote = '';

    // At most MAX_ATTEMPTS model calls in total: AiService does not retry on its own here, so a provider error, a rejected
    // answer or a timeout each cost one of them and the whole job stays inside PLAN_NARRATIVE_BUDGET_MS.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1 && deadline - Date.now() < MIN_ATTEMPT_MS) return fail('unavailable', true, model, job.locale, rejected);
      let output: unknown;
      let usedModel = model;
      try {
        const res = await this.ai.run('plan', () =>
          this.provider.structured({
            task: 'plan_narrative',
            model,
            instructions: prompt.staticPrefix,
            context: languageDirective(job.locale) + fillTemplate(prompt.dynamicTemplate, { facts: job.facts, retryNote }),
            timeoutMs: Math.max(MIN_ATTEMPT_MS, Math.min(timeoutMs, deadline - Date.now())),
            maxOutputTokens,
            // Thinking tokens bill as output and count against maxOutputTokens; a short personalised write-up needs little.
            thinking: 'low',
          }),
          { retry: false },
        );
        output = res.output;
        usedModel = res.model;
      } catch (e) {
        if (e instanceof AiUnavailableError) return fail('unavailable', e.reason === 'circuit_open' || e.reason === 'provider_error', null, job.locale, rejected);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 500)); // one more try after a provider error, within the same budget
          continue;
        }
        return fail('unavailable', true, null, job.locale, rejected);
      }

      const parsed = PlanNarrativeSchema.safeParse(output);
      const problems = parsed.success
        ? checkNarrative(parsed.data, job.avoidTerms, job.locale).problems
        : parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'output'}: ${i.message}`);
      if (parsed.success && problems.length === 0) {
        return { status: 'ok', narrative: parsed.data, message: null, retryable: false, model: usedModel, rejected };
      }
      rejected.push(problems);
      retryNote = `Your previous answer was rejected for these reasons: ${problems.join('; ')}. Write it again and fix every one of them.`;
    }
    return fail('invalid_response', true, model, job.locale, rejected);
  }
}
