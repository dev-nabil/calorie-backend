import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  CreateMealRequestSchema,
  CreateWeightRequestSchema,
  DayKeySchema,
  DayResponseSchema,
  ListMealsQuerySchema,
  ListWeightsQuerySchema,
  MealListSchema,
  MealSchema,
  ObjectIdSchema,
  ProgressQuerySchema,
  ProgressResponseSchema,
  UpdateMealRequestSchema,
  WaterRequestSchema,
  WaterStateSchema,
  WeightEntrySchema,
  WeightListSchema,
  type CreateMealRequest,
  type CreateWeightRequest,
  type DayResponse,
  type ListMealsQuery,
  type Meal,
  type ProgressResponse,
  type UpdateMealRequest,
  type WaterRequest,
  type WeightEntry,
} from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { ApiErrors, ZBody, ZParam, ZQuery, ZResponse } from '../../common/zod/decorators';
import { UsersService } from '../users/users.service';
import { DaysService } from './days.service';
import { MealsService } from './meals.service';
import { WeightsService } from './weights.service';

@ApiTags('meals')
@ApiBearerAuth()
@Controller('meals')
export class MealsController {
  constructor(
    private readonly meals: MealsService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ZResponse(200, MealListSchema, 'Meals by day range (max 93 days)')
  @ApiErrors(400, 401)
  async list(@CurrentUser() u: AuthUser, @ZQuery(ListMealsQuerySchema) q: ListMealsQuery, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return { items: await this.meals.list(u.id, q.from, q.to, q.includeDeleted === 'true'), nextCursor: null };
  }

  @Post()
  @Idempotent()
  @ZResponse(201, MealSchema, 'Meal saved; items are at 1× and `totals` apply the portion multiplier')
  @ApiErrors(400, 401, 409, 422)
  async create(@CurrentUser() u: AuthUser, @ZBody(CreateMealRequestSchema) body: CreateMealRequest): Promise<Meal> {
    await this.users.requireActive(u.id);
    return this.meals.create(u.id, body);
  }

  @Patch(':id')
  @ZResponse(200, MealSchema)
  @ApiErrors(400, 401, 404)
  update(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @ZBody(UpdateMealRequestSchema) body: UpdateMealRequest): Promise<Meal> {
    return this.meals.update(u.id, id, body);
  }

  @Delete(':id')
  @ZResponse(200, MealSchema, 'Soft-deleted; restorable until `restorableUntil` (BR-17)')
  @ApiErrors(401, 404)
  remove(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string): Promise<Meal> {
    return this.meals.remove(u.id, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ZResponse(200, MealSchema, 'Undo a delete within 7 days (BR-17)')
  @ApiErrors(401, 404, 409)
  restore(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string): Promise<Meal> {
    return this.meals.restore(u.id, id);
  }
}

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

@ApiTags('weights')
@ApiBearerAuth()
@Controller('weights')
export class WeightsController {
  constructor(private readonly weights: WeightsService) {}

  @Get()
  @ZResponse(200, WeightListSchema, 'Newest first')
  @ApiErrors(400, 401)
  async list(@CurrentUser() u: AuthUser, @ZQuery(ListWeightsQuerySchema) q: z.infer<typeof ListWeightsQuerySchema>, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return { items: await this.weights.list(u.id, q), nextCursor: null };
  }

  @Post()
  @Idempotent()
  @ZResponse(201, WeightEntrySchema)
  @ApiErrors(400, 401)
  create(@CurrentUser() u: AuthUser, @ZBody(CreateWeightRequestSchema) body: CreateWeightRequest): Promise<WeightEntry> {
    return this.weights.create(u.id, body);
  }
}

@ApiTags('progress')
@ApiBearerAuth()
@Controller('progress')
export class ProgressController {
  constructor(private readonly days: DaysService) {}

  @Get()
  @ZResponse(200, ProgressResponseSchema)
  @ApiErrors(400, 401)
  get(@CurrentUser() u: AuthUser, @ZQuery(ProgressQuerySchema) q: z.infer<typeof ProgressQuerySchema>, @Res({ passthrough: true }) res: Response): Promise<ProgressResponse> {
    noStore(res);
    return this.days.progress(u.id, q.range, q.date);
  }
}
