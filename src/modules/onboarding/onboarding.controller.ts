import { Controller, Get, HttpCode, Post, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  BulkAnswersRequestSchema,
  CompleteOnboardingRequestSchema,
  CompleteOnboardingResponseSchema,
  OnboardingQuestionsResponseSchema,
  OnboardingStateSchema,
  PutAnswerRequestSchema,
  QuestionIdSchema,
  SetRouteRequestSchema,
  type BulkAnswersRequest,
  type CompleteOnboardingResponse,
  type OnboardingState,
  type PutAnswerRequest,
  type SetRouteRequest,
} from '../../shared';
import { CurrentUser, Public, type AuthUser } from '../../common/auth/auth.decorators';
import { applyContentCaching, noStore } from '../../common/http/etag';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../common/zod/decorators';
import { ContentService } from '../content/content.service';
import { OnboardingService } from './onboarding.service';

@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly content: ContentService,
  ) {}

  @Public()
  @Get('questions')
  @ZResponse(200, OnboardingQuestionsResponseSchema, 'Active question set and conversation subset (ETag, public 300 s)')
  async questions(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { version, raw, locale } = await this.content.questionSet();
    const conversation = await this.content.conversation(locale);
    const body = { version, locale, questionSet: raw, conversation: conversation?.data ?? null };
    return applyContentCaching(req, res, `questions-${locale}-v${version}-c${conversation?.version ?? 0}`, body) ? body : undefined;
  }

  @ApiBearerAuth()
  @Get('state')
  @ZResponse(200, OnboardingStateSchema)
  @ApiErrors(401)
  state(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response): Promise<OnboardingState> {
    noStore(res);
    return this.onboarding.state(u.id);
  }

  @ApiBearerAuth()
  @Post('route')
  @HttpCode(200)
  @ZResponse(200, OnboardingStateSchema)
  @ApiErrors(400, 401)
  route(@CurrentUser() u: AuthUser, @ZBody(SetRouteRequestSchema) body: SetRouteRequest): Promise<OnboardingState> {
    return this.onboarding.setRoute(u.id, body.route);
  }

  @ApiBearerAuth()
  @Put('answers')
  @ZResponse(200, OnboardingStateSchema, 'Bulk upload of answers collected before the account existed (DEC-18)')
  @ApiErrors(400, 401, 404, 422)
  bulk(@CurrentUser() u: AuthUser, @ZBody(BulkAnswersRequestSchema) body: BulkAnswersRequest): Promise<OnboardingState> {
    return this.onboarding.save(u.id, body.answers, body.route);
  }

  @ApiBearerAuth()
  @Put('answers/:questionId')
  @ZResponse(200, OnboardingStateSchema, 'Save, skip or defer one answer; `cleared` lists stale dependents removed (BR-11)')
  @ApiErrors(400, 401, 404, 422)
  put(
    @CurrentUser() u: AuthUser,
    @ZParam('questionId', QuestionIdSchema) questionId: string,
    @ZBody(PutAnswerRequestSchema) body: PutAnswerRequest,
  ): Promise<OnboardingState> {
    return this.onboarding.save(u.id, [{ ...body, questionId }]);
  }

  @ApiBearerAuth()
  @Post('complete')
  @HttpCode(200)
  @ZResponse(200, CompleteOnboardingResponseSchema, 'Profile and plan preview; unasked questions become deferred')
  @ApiErrors(400, 401, 422)
  complete(@CurrentUser() u: AuthUser, @ZBody(CompleteOnboardingRequestSchema) _body: unknown): Promise<CompleteOnboardingResponse> {
    return this.onboarding.complete(u.id);
  }
}
