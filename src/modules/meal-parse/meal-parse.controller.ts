import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
AI_LIMITS,
ERROR_CODES,
MealDescribeRequestSchema,
MealDescribeResponseSchema,
MealParseRequestSchema,
MealParseResponseSchema,
MealTranscribeResponseSchema,
TRANSCRIBE_AUDIO_TYPES,
TRANSCRIBE_MAX_BYTES,
type MealDescribeRequest,
type MealDescribeResponse,
type MealParseRequest,
type MealParseResponse,
type MealTranscribeResponse
} from '../../shared';
import { isPlusActive, isVerifiedAccount } from '../../domain/entitlements';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { integrityOk, RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { clock } from '../../common/clock';
import { requestLocale } from '../../common/http/request-context';
import { AiJobs } from '../ai/ai-jobs';
import { AppConfigService } from '../content/app-config.service';
import { UsersService } from '../users/users.service';
import { MEAL_DESCRIBE_JOB } from './meal-describe.handler';
import { MEAL_PARSE_JOB } from './meal-parse.handler';
import { MEAL_TRANSCRIBE_JOB } from './meal-transcribe.handler';

@ApiTags('meals')
@ApiBearerAuth()
@Controller('meals')
export class MealParseController {
  constructor(
    private readonly runner: AiJobs,
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
    return this.described(u, req, () => this.runner.run<MealParseResponse>(MEAL_PARSE_JOB, { userId: u.id, req: body, locale: requestLocale() }));
  }

  /**
   * Text logging: a description, an answer to the follow-up question or a correction, with the unsaved draft. Same
   * daily describe allowance as /meals/parse. Nothing is saved; the app sends the reviewed items to POST /meals.
   */
  @Post('describe')
  @HttpCode(200)
  @RequireIntegrity()
  @ZResponse(200, MealDescribeResponseSchema, 'A reviewable draft from a description: foods, amounts, server-computed values; nothing is saved')
  @ApiErrors(400, 401, 402, 403, 429, 502, 503)
  async describe(@CurrentUser() u: AuthUser, @ZBody(MealDescribeRequestSchema) body: MealDescribeRequest, @Req() req: Request): Promise<MealDescribeResponse> {
    return this.described(u, req, () => this.runner.run<MealDescribeResponse>(MEAL_DESCRIBE_JOB, { req: body, locale: requestLocale() }));
  }

  /**
   * Spoken food logging: a short recording (the raw request body, one of TRANSCRIBE_AUDIO_TYPES, at most 2 MB) turned into
   * the words that were said, in the language they were said in. Nothing is analysed, saved or stored (the audio stays
   * in memory). Needs a description left today, since the text is meant for POST /meals/describe, and has its own
   * daily cap (limits.*.transcribePerDay, default 20 free / 100 Plus) counted only after a good answer.
   */
  @Post('transcribe')
  @HttpCode(200)
  @RequireIntegrity()
  @ApiConsumes(...TRANSCRIBE_AUDIO_TYPES)
  @ApiBody({ description: 'The recording itself (for example 16 kHz mono WAV); at most 2 MB', schema: { type: 'string', format: 'binary' } })
  @ZResponse(200, MealTranscribeResponseSchema, 'The spoken words as editable text; nothing is analysed or saved')
  @ApiErrors(400, 401, 402, 403, 413, 429, 502, 503)
  async transcribe(@CurrentUser() u: AuthUser, @Req() req: Request): Promise<MealTranscribeResponse> {
    const type = (req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!(TRANSCRIBE_AUDIO_TYPES as readonly string[]).includes(type)) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Send the recording as one of ${TRANSCRIBE_AUDIO_TYPES.join(', ')}`, HttpStatus.BAD_REQUEST, { field: 'content-type' });
    }
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    // Under 1 KB is no recording at all; the body parser already refuses more than 2 MB (413).
    if (!audio || audio.length < 1024 || audio.length > TRANSCRIBE_MAX_BYTES) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'The recording is empty or too large', HttpStatus.BAD_REQUEST, { field: 'body' });
    }
    const user = await this.users.requireActive(u.id);
    if (!isVerifiedAccount(user)) throw ApiError.forbidden(ERROR_CODES.EMAIL_NOT_VERIFIED, 'Verify your email to describe meals');
    if (!integrityOk(req)) throw ApiError.forbidden(ERROR_CODES.INTEGRITY_REQUIRED, 'This device could not be verified');
    const plus = isPlusActive(user.entitlement, clock.now());
    const limits = await this.appConfig.get('limits', AI_LIMITS);
    const plan = (plus ? limits.plus : limits.free) as { describePerDay: number; transcribePerDay?: number };
    await this.quota.assertAvailable('describe', u.id, user.timezone, plan.describePerDay, plus, plus ? 'Daily limit reached. Try again tomorrow.' : 'Free descriptions are used up for today.');
    await this.quota.assertAvailable('transcribe', u.id, user.timezone, plan.transcribePerDay ?? (plus ? 100 : 20), plus, 'Voice input is used up for today. You can still type.');
    const result = await this.runner.run<MealTranscribeResponse>(MEAL_TRANSCRIBE_JOB, { audio, mimeType: type === 'audio/x-wav' ? 'audio/wav' : type });
    await this.quota.consume('transcribe', u.id, user.timezone);
    return result;
  }

  /** Account checks and the daily describe allowance around one model answer. */
  private async described<T>(u: AuthUser, req: Request, run: () => Promise<T>): Promise<T> {
    const user = await this.users.requireActive(u.id);
    if (!isVerifiedAccount(user)) throw ApiError.forbidden(ERROR_CODES.EMAIL_NOT_VERIFIED, 'Verify your email to describe meals');
    if (!integrityOk(req)) throw ApiError.forbidden(ERROR_CODES.INTEGRITY_REQUIRED, 'This device could not be verified');
    const plus = isPlusActive(user.entitlement, clock.now());
    const limits = await this.appConfig.get('limits', AI_LIMITS);
    const limit = plus ? limits.plus.describePerDay : limits.free.describePerDay;
    await this.quota.assertAvailable('describe', u.id, user.timezone, limit, plus, plus ? 'Daily limit reached. Try again tomorrow.' : 'Free descriptions are used up for today.');
    const result = await run();
    await this.quota.consume('describe', u.id, user.timezone); // only after a successful answer (OQ-38)
    return result;
  }
}
