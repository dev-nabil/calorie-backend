import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ERROR_CODES, MealDescribeOutputSchema, type MealDescribeRequest, type MealDescribeResponse } from '../../shared';
import { describeValuesSane, normaliseDescribe } from '../../domain/nutrition-validator';
import { ApiError } from '../../common/errors/api-error';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { AiJobs } from '../ai/ai-jobs';
import { languageDirective } from '../ai/language';
import { AiProvider } from '../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../ai/ai-models';
import { AiService } from '../ai/ai.service';
import { fillTemplate } from '../content/content.loader';
import { ContentService } from '../content/content.service';
import { FoodRecordsService } from '../content/food-records.service';

export const MEAL_DESCRIBE_JOB = 'meal_describe';
export const MEAL_DESCRIBE_TIMEOUT_MS = 15_000;

/** Used when no prompt row exists yet (a fresh database before content seeding). */
const FALLBACK_INSTRUCTIONS =
  'List every food and drink in the description with its amount and its values per 100 g. Use the amounts the user gives. Return JSON only.';

/**
 * The dynamic part of the prompt: reply language, the newest message, earlier messages and the draft. The model gets
 * the draft's names and amounts only, never its numbers, so it cannot copy a per-100-gram value as a total.
 */
export function describeContext(template: string | undefined, req: MealDescribeRequest, locale?: LocaleCode): string {
  const draft = req.draft?.items ?? [];
  return (
    languageDirective(locale ?? DEFAULT_LOCALE) +
    fillTemplate(template ?? '{{text}}', {
      inputMethod: req.inputMethod ?? 'typed',
      category: req.category ?? '',
      historyJson: req.history?.length ? JSON.stringify(req.history) : '',
      draftJson: draft.length ? JSON.stringify({ mealName: req.draft?.mealName ?? null, items: draft.map((d) => ({ name: d.name, grams: d.grams, portion: d.portion ?? null })) }) : '',
      text: req.text,
    })
  );
}

interface DescribeJob {
  req: MealDescribeRequest;
  /** Reply language (the job may run outside the request context). */
  locale?: LocaleCode;
}

/**
 * Text logging (POST /meals/describe): one structured model call that says what was eaten, how much and the values
 * per 100 g; the server matches published food records and does every multiplication (normaliseDescribe).
 */
@Injectable()
export class MealDescribeHandler implements OnModuleInit {
  private readonly log = new Logger(MealDescribeHandler.name);

  constructor(
    private readonly handlers: AiJobs,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
    private readonly records: FoodRecordsService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(MEAL_DESCRIBE_JOB, (p) => this.handle(p as DescribeJob));
  }

  async handle({ req, locale }: DescribeJob): Promise<MealDescribeResponse> {
    const prompt = await this.content.activePrompt('meal-describe');
    const model = prompt?.model || (await this.ai.modelFor('extract', DEFAULT_TEXT_MODEL));
    const draft = req.draft?.items ?? [];
    const res = await this.ai.runOrUnavailable('extract', () =>
      this.provider.structured({
        task: 'meal_describe',
        model,
        instructions: prompt?.staticPrefix ?? FALLBACK_INSTRUCTIONS,
        context: describeContext(prompt?.dynamicTemplate, req, locale),
        timeoutMs: MEAL_DESCRIBE_TIMEOUT_MS,
        maxOutputTokens: Number(prompt?.params?.maxOutputTokens) || 1600,
      }),
    );
    const parsed = MealDescribeOutputSchema.safeParse(res.output);
    if (!parsed.success) {
      this.log.warn(`meal_describe output rejected: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      throw new ApiError(ERROR_CODES.AI_UNAVAILABLE, 'The description could not be read. Try again.', HttpStatus.BAD_GATEWAY);
    }
    const out = normaliseDescribe(parsed.data, { records: this.records.index, draft, text: req.text });
    if (!describeValuesSane(out)) throw new ApiError(ERROR_CODES.AI_UNAVAILABLE, 'The description could not be read. Try again.', HttpStatus.BAD_GATEWAY);
    return out;
  }
}
