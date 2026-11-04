import { Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ConfirmPlanRequestSchema,
  GeneratePlanRequestSchema,
  PlanDraftSchema,
  PlanPreviewRequestSchema,
  PlanPreviewSchema,
  PlanReadinessSchema,
  PlanSchema,
  type ConfirmPlanRequest,
  type GeneratePlanRequest,
  type Plan,
  type PlanDraft,
  type PlanPreview,
  type PlanPreviewRequest,
  type PlanReadiness,
} from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { UsersService } from '../users/users.service';
import { PlansService } from './plans.service';

@ApiTags('plan')
@ApiBearerAuth()
@Controller('plan')
export class PlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly users: UsersService,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @ZResponse(200, PlanPreviewSchema, 'Proposed targets, not saved (BR-04/05/06)')
  @ApiErrors(400, 401)
  async preview(@CurrentUser() u: AuthUser, @ZBody(PlanPreviewRequestSchema) body: PlanPreviewRequest): Promise<PlanPreview> {
    await this.users.requireActive(u.id);
    return this.plans.preview(u.id, body.eligibility);
  }

  @Get('readiness')
  @ZResponse(200, PlanReadinessSchema, 'What a plan can be made from right now: missing essentials, contradictions, professional-guidance reasons. No model call')
  @ApiErrors(401)
  async readiness(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response): Promise<PlanReadiness> {
    noStore(res);
    await this.users.requireActive(u.id);
    return this.plans.readiness(u.id);
  }

  @Post('generate')
  @HttpCode(200)
  @Idempotent()
  @ZResponse(200, PlanDraftSchema, 'Validated targets and time estimate, plus AI personalisation when available. Nothing is saved as the active plan. Same answers return the same draft unless regenerate is true')
  @ApiErrors(400, 401, 409, 429)
  async generate(@CurrentUser() u: AuthUser, @ZBody(GeneratePlanRequestSchema) body: GeneratePlanRequest): Promise<PlanDraft> {
    return this.plans.generate(u.id, body);
  }

  @Get('draft')
  @ZResponse(200, PlanDraftSchema, 'The latest prepared plan; `stale` is true when the answers changed since')
  @ApiErrors(401, 404)
  async draft(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response): Promise<PlanDraft> {
    noStore(res);
    await this.users.requireActive(u.id);
    return this.plans.latestDraft(u.id);
  }

  @Get()
  @ZResponse(200, PlanSchema)
  @ApiErrors(401, 404)
  async get(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response): Promise<Plan> {
    noStore(res);
    return this.plans.get(u.id);
  }

  @Post()
  @Idempotent()
  @ZResponse(201, PlanSchema, 'Confirmed plan (calculated, adjusted within bounds, manual, or none)')
  @ApiErrors(400, 401, 404, 409, 422)
  async confirm(@CurrentUser() u: AuthUser, @ZBody(ConfirmPlanRequestSchema) body: ConfirmPlanRequest): Promise<Plan> {
    await this.users.requireActive(u.id);
    return this.plans.confirm(u.id, body);
  }
}
