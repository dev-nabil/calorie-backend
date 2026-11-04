import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
CreateMealRequestSchema, ListMealsQuerySchema, MealListSchema,
MealSchema,
ObjectIdSchema, UpdateMealRequestSchema, type CreateMealRequest, type ListMealsQuery,
type Meal, type UpdateMealRequest
} from '../../../shared';
import { CurrentUser, type AuthUser } from '../../../common/auth/auth.decorators';
import { noStore } from '../../../common/http/etag';
import { Idempotent } from '../../../common/idempotency/idempotency.interceptor';
import { ApiErrors, ZBody, ZParam, ZQuery, ZResponse } from '../../../common/zod/decorators';
import { UsersService } from '../../users/users.service';
import { MealsService } from '../services/meals.service';

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
