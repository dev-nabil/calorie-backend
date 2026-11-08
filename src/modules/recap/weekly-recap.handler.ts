import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WeeklyRecapOutputSchema, type RecapCard, type RecapRange, type RecapStats } from '../../shared';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { checkRecapCards, type RecapMode } from '../../domain/weekly-recap';
import { AiJobHandlers } from '../ai/ai-jobs';
import { AiProvider } from '../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../ai/ai-models';
import { AiService, AiUnavailableError } from '../ai/ai.service';
import { languageDirective } from '../ai/language';
import { fillTemplate } from '../content/content.loader';
import { ContentService } from '../content/content.service';

export const WEEKLY_RECAP_JOB = 'weekly_recap';
export const WEEKLY_RECAP_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1500;

/** Used only when no `weekly-recap` prompt is stored (a database that was never seeded). */
const FALLBACK_INSTRUCTIONS =
  'You are Milo in the Nouri nutrition app. Write 4 to 6 short, warm weekly recap cards as JSON. Use only numbers that appear in the stats. Never judge food, a day or the person.';

export interface WeeklyRecapJob {
  range: RecapRange;
  mode: RecapMode;
  stats: RecapStats;
  /** Reply language of the cards (jobs run in the worker, outside the request). */
  locale: LocaleCode;
  /** Prompt-ready descriptions (domain/copy-rules `describeAllergies`, `describeDietPattern`). */
  allergies: string;
  dietPattern: string;
  /** Lower-case terms the cards must not suggest. */
  avoidTerms: string[];
}

export interface WeeklyRecapJobResult {
  /** Empty when the answer was unusable: the app then builds cards from the stats. */
  cards: RecapCard[];
  model: string;
  rejected: string[];
}

/**
 * Runs in the worker (queue `ai`): one structured call writes the story cards from the stats, then every card is checked
 * (numbers, judging words, habits-only, allergens). Unavailable AI throws AI_UNAVAILABLE; the service degrades to stats only.
 */
@Injectable()
export class WeeklyRecapHandler implements OnModuleInit {
  private readonly logger = new Logger('WeeklyRecap');

  constructor(
    private readonly handlers: AiJobHandlers,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(WEEKLY_RECAP_JOB, (p) => this.handle(p as WeeklyRecapJob));
  }

  async handle(job: WeeklyRecapJob): Promise<WeeklyRecapJobResult> {
    // No real model behind the provider: say so (the app shows its own cards) rather than show made-up ones.
    if (!this.provider.configured) throw new AiUnavailableError('not_configured', 3600);
    const locale = job.locale ?? DEFAULT_LOCALE;
    const prompt = await this.content.activePrompt('weekly-recap');
    const model = prompt?.model || (await this.ai.modelFor('recap', DEFAULT_TEXT_MODEL));
    const res = await this.ai.runOrUnavailable('recap', () =>
      this.provider.structured({
        task: 'weekly_recap',
        model,
        instructions: prompt?.staticPrefix ?? FALLBACK_INSTRUCTIONS,
        context:
          languageDirective(locale) +
          fillTemplate(prompt?.dynamicTemplate ?? 'Mode: {{mode}}\nStats: {{statsJson}}', {
            range: job.range,
            rangeNote: job.range === 'last' ? 'last week, Monday to Sunday' : 'this week so far, Monday to today',
            mode: job.mode,
            dietPattern: job.dietPattern,
            allergies: job.allergies,
            statsJson: JSON.stringify(job.stats),
          }),
        timeoutMs: (prompt?.params?.timeoutSec ?? 0) * 1000 || WEEKLY_RECAP_TIMEOUT_MS,
        maxOutputTokens: prompt?.params?.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
      }),
    );
    const parsed = WeeklyRecapOutputSchema.safeParse(res.output);
    if (!parsed.success) {
      this.logger.warn({ model: res.model, issues: parsed.error.issues.slice(0, 3).map((i) => i.message) }, 'weekly recap: answer does not match the schema');
      return { cards: [], model: res.model, rejected: ['answer does not match the schema'] };
    }
    const check = checkRecapCards(parsed.data.cards, job.stats, { mode: job.mode, locale, avoidTerms: job.avoidTerms });
    if (check.rejected.length) this.logger.warn({ model: res.model, kept: check.cards.length, rejected: check.rejected }, 'weekly recap: cards dropped');
    return { cards: check.cards, model: res.model, rejected: check.rejected };
  }
}
