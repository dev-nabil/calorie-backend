import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import {
ERROR_CODES,
MAX_MEAL_ITEMS,
MealParseOutputSchema, type MealParseRequest,
type MealParseResponse
} from '../../shared';
import { computeTotals, normaliseItem } from '../../domain/nutrition-validator';
import { ApiError } from '../../common/errors/api-error';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { AiJobs } from '../ai/ai-jobs';
import { languageDirective } from '../ai/language';
import { AiProvider } from '../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../ai/ai-models';
import { AiService } from '../ai/ai.service';
import { fillTemplate } from '../content/content.loader';
import { ContentService } from '../content/content.service';
import type { ProfileDoc } from '../onboarding/schemas/onboarding.schema';
import { UsersService } from '../users/users.service';

export const MEAL_PARSE_JOB = 'meal_parse';
export const MEAL_PARSE_TIMEOUT_MS = 15_000;

interface ParseJob {
  userId: string;
  req: MealParseRequest;
  /** Reply language (the job may run outside the request context). */
  locale?: LocaleCode;
}

/** An AI job (AiJobs): one structured model call, validated and normalised (plan 8.4). */
@Injectable()
export class MealParseHandler implements OnModuleInit {
  constructor(
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    private readonly handlers: AiJobs,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
    private readonly users: UsersService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(MEAL_PARSE_JOB, (p) => this.handle(p as ParseJob));
  }

  async handle({ userId, req, locale }: ParseJob): Promise<MealParseResponse> {
    const user = await this.users.requireActive(userId);
    const profile = await this.profiles.findOne({ userId: new Types.ObjectId(userId) }).lean<ProfileDoc>();
    const prompt = await this.content.activePrompt('meal-parse');
    const model = prompt?.model || (await this.ai.modelFor('extract', DEFAULT_TEXT_MODEL));
    const res = await this.ai.runOrUnavailable('extract', () =>
      this.provider.structured({
        task: 'meal_parse',
        model,
        instructions: prompt?.staticPrefix ?? 'Turn the meal description into items. Return JSON.',
        context: languageDirective(locale ?? DEFAULT_LOCALE) + fillTemplate(prompt?.dynamicTemplate ?? '{{text}}', {
          mode: req.mode ?? 'describe',
          inputMethod: req.inputMethod ?? 'typed',
          category: req.category ?? '',
          dietPattern: profile?.dietPattern ?? '',
          locale: user.locale,
          existingItemsJson: req.existingItems ? JSON.stringify(req.existingItems) : '',
          text: req.text,
        }),
        timeoutMs: MEAL_PARSE_TIMEOUT_MS,
        maxOutputTokens: 1100,
      }),
    );
    const parsed = MealParseOutputSchema.safeParse(res.output);
    if (!parsed.success) throw new ApiError(ERROR_CODES.AI_UNAVAILABLE, 'The description could not be read. Try again.', HttpStatus.BAD_GATEWAY);
    const max = req.mode === 'add_item' ? 1 : MAX_MEAL_ITEMS;
    const items = parsed.data.items.slice(0, max).map((i) => normaliseItem({ ...i, point: null }));
    return {
      mealName: req.mode === 'add_item' ? null : parsed.data.mealName || null,
      items,
      totals: computeTotals(items),
      notes: parsed.data.notes,
      clarifyingQuestion: parsed.data.clarifyingQuestion,
    };
  }
}
