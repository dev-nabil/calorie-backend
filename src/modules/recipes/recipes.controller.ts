import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CreateRecipeRequestSchema,
  ObjectIdSchema,
  RecipeListSchema,
  RecipeSchema,
  UpdateRecipeRequestSchema,
  type CreateRecipeRequest,
  type Recipe,
  type UpdateRecipeRequest,
} from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../common/zod/decorators';
import { UsersService } from '../users/users.service';
import { RecipesService } from './recipes.service';


/** Saved recipes (Milo buddy, contract §5). Chat saves them through its action path; these routes list, edit and delete. */
@ApiTags('recipes')
@ApiBearerAuth()
@Controller('recipes')
export class RecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ZResponse(200, RecipeListSchema, 'Saved recipes, newest first (at most 100)')
  @ApiErrors(401)
  async list(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    await this.users.requireActive(u.id);
    return { items: await this.recipes.list(u.id), nextCursor: null };
  }

  @Get(':id')
  @ZResponse(200, RecipeSchema)
  @ApiErrors(401, 404)
  get(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @Res({ passthrough: true }) res: Response): Promise<Recipe> {
    noStore(res);
    return this.recipes.get(u.id, id);
  }

  @Post()
  @Idempotent()
  @ZResponse(201, RecipeSchema, 'Values computed by the server from each per-100 g basis (no AI call)')
  @ApiErrors(400, 401, 422)
  async create(@CurrentUser() u: AuthUser, @ZBody(CreateRecipeRequestSchema) body: CreateRecipeRequest): Promise<Recipe> {
    await this.users.requireActive(u.id);
    return this.recipes.create(u.id, body);
  }

  @Patch(':id')
  @ZResponse(200, RecipeSchema, '409 VERSION_CONFLICT (details.recipe) when version is not the current one')
  @ApiErrors(400, 401, 404, 409)
  update(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string, @ZBody(UpdateRecipeRequestSchema) body: UpdateRecipeRequest): Promise<Recipe> {
    return this.recipes.update(u.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ZResponse(204, null, 'Deleted; diary meals logged from it keep their values')
  @ApiErrors(401, 404)
  async remove(@CurrentUser() u: AuthUser, @ZParam('id', ObjectIdSchema) id: string): Promise<void> {
    await this.recipes.remove(u.id, id);
  }
}
