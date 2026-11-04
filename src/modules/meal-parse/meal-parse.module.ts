import { Controller, HttpCode, HttpStatus, Injectable, Module, OnModuleInit, Post, Req } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Types, type Model } from 'mongoose';
import {
  AI_LIMITS,
  ERROR_CODES,
  MAX_MEAL_ITEMS,
  MealParseOutputSchema,
  MealParseRequestSchema,
  MealParseResponseSchema,
  type MealParseRequest,
  type MealParseResponse,
} from '../../shared';
import { isPlusActive, isVerifiedAccount } from '../../domain/entitlements';
import { computeTotals, normaliseItem } from '../../domain/nutrition-validator';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { integrityOk, RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { clock } from '../../common/clock';
import { requestLocale } from '../../common/http/request-context';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { AiJobHandlers, AiJobRunner } from '../ai/ai-jobs';
import { languageDirective } from '../ai/language';
import { AiProvider } from '../ai/ai.provider';
import { AiService } from '../ai/ai.service';
import { AppConfigService } from '../content/app-config.service';
import { fillTemplate } from '../content/content.loader';
import { ContentService } from '../content/content.service';
import type { ProfileDoc } from '../onboarding/onboarding.schemas';
import { UsersService } from '../users/users.service';

const JOB = 'meal_parse';
const TIMEOUT_MS = 15_000;

interface ParseJob {
  userId: string;
  req: MealParseRequest;
  /** Reply language (jobs may run in the worker, outside the request). */
  locale?: LocaleCode;
}

/** Runs in the worker (queue `ai`): one structured model call, validated and normalised (plan 8.4). */
@Injectable()
export class MealParseHandler implements OnModuleInit {
  constructor(
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    private readonly handlers: AiJobHandlers,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
    private readonly users: UsersService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(JOB, (p) => this.handle(p as ParseJob));
  }

  async handle({ userId, req, locale }: ParseJob): Promise<MealParseResponse> {
    const user = await this.users.requireActive(userId);
    const profile = await this.profiles.findOne({ userId: new Types.ObjectId(userId) }).lean<ProfileDoc>();
    const prompt = await this.content.activePrompt('meal-parse');
    const model = prompt?.model || (await this.ai.modelFor('extract', 'gpt-5-mini'));
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
        timeoutMs: TIMEOUT_MS,
        maxOutputTokens: 900,
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

@ApiTags('meals')
@ApiBearerAuth()
@Controller('meals')
class MealParseController {
  constructor(
    private readonly runner: AiJobRunner,
    private readonly users: UsersService,
    private readonly quota: DailyQuota,
    private readonly appConfig: AppConfigService,
  ) {}

  @Post('parse')
  @HttpCode(200)
  @RequireIntegrity()
  @ZResponse(200, MealParseResponseSchema, 'Items from a text or voice description; nothing is saved (plan 8.4)')
  @ApiErrors(400, 401, 402, 403, 429, 502, 503)
  async parse(@CurrentUser() u: AuthUser, @ZBody(MealParseRequestSchema) body: MealParseRequest, @Req() req: Request): Promise<MealParseResponse> {
    const user = await this.users.requireActive(u.id);
    if (!isVerifiedAccount(user)) throw ApiError.forbidden(ERROR_CODES.EMAIL_NOT_VERIFIED, 'Verify your email to describe meals');
    if (!integrityOk(req)) throw ApiError.forbidden(ERROR_CODES.INTEGRITY_REQUIRED, 'This device could not be verified');
    const plus = isPlusActive(user.entitlement, clock.now());
    const limits = await this.appConfig.get('limits', AI_LIMITS);
    const limit = plus ? limits.plus.describePerDay : limits.free.describePerDay;
    await this.quota.assertAvailable('describe', u.id, user.timezone, limit, plus, plus ? 'Daily limit reached. Try again tomorrow.' : 'Free descriptions are used up for today.');
    const result = await this.runner.run<MealParseResponse>(JOB, { userId: u.id, req: body, locale: requestLocale() }, TIMEOUT_MS + 5000);
    await this.quota.consume('describe', u.id, user.timezone); // only after a successful answer (OQ-38)
    return result;
  }
}

@Module({ controllers: [MealParseController], providers: [MealParseHandler] })
export class MealParseModule {}

/** Worker role: only the handler. */
@Module({ providers: [MealParseHandler] })
export class MealParseWorkerModule {}
