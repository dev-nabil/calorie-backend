import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
AI_LIMITS,
ERROR_CODES, MealParseRequestSchema,
MealParseResponseSchema,
type MealParseRequest,
type MealParseResponse
} from '../../shared';
import { isPlusActive, isVerifiedAccount } from '../../domain/entitlements';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { integrityOk, RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { clock } from '../../common/clock';
import { requestLocale } from '../../common/http/request-context';
import { AiJobRunner } from '../ai/ai-jobs';
import { AppConfigService } from '../content/app-config.service';
import { UsersService } from '../users/users.service';
import { MEAL_PARSE_JOB, MEAL_PARSE_TIMEOUT_MS } from './meal-parse.handler';

@ApiTags('meals')
@ApiBearerAuth()
@Controller('meals')
export class MealParseController {
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
    const result = await this.runner.run<MealParseResponse>(MEAL_PARSE_JOB, { userId: u.id, req: body, locale: requestLocale() }, MEAL_PARSE_TIMEOUT_MS + 5000);
    await this.quota.consume('describe', u.id, user.timezone); // only after a successful answer (OQ-38)
    return result;
  }
}
