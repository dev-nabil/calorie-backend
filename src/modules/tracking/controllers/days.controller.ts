import { Controller, Get, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
DayKeySchema,
DayResponseSchema, WaterRequestSchema,
WaterStateSchema, type DayResponse, type WaterRequest
} from '../../../shared';
import { CurrentUser, type AuthUser } from '../../../common/auth/auth.decorators';
import { noStore } from '../../../common/http/etag';
import { Idempotent } from '../../../common/idempotency/idempotency.interceptor';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../../common/zod/decorators';
import { DaysService } from '../services/days.service';

@ApiTags('days')
@ApiBearerAuth()
@Controller('days')
export class DaysController {
  constructor(private readonly days: DaysService) {}

  @Get(':date')
  @ZResponse(200, DayResponseSchema, 'Today payload: targets, totals, remaining, meals, water, streak, nudge')
  @ApiErrors(400, 401)
  get(@CurrentUser() u: AuthUser, @ZParam('date', DayKeySchema) date: string, @Res({ passthrough: true }) res: Response): Promise<DayResponse> {
    noStore(res);
    return this.days.day(u.id, date);
  }

  @Post(':date/water')
  @Idempotent()
  @ZResponse(201, WaterStateSchema, 'Water after the change (BR-09)')
  @ApiErrors(400, 401, 422)
  water(@CurrentUser() u: AuthUser, @ZParam('date', DayKeySchema) date: string, @ZBody(WaterRequestSchema) body: WaterRequest) {
    return this.days.addWater(u.id, date, body);
  }
}
