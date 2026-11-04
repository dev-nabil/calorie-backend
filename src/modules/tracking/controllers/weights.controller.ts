import { Controller, Get, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
CreateWeightRequestSchema, ListWeightsQuerySchema, WeightEntrySchema,
WeightListSchema, type CreateWeightRequest, type WeightEntry
} from '../../../shared';
import { CurrentUser, type AuthUser } from '../../../common/auth/auth.decorators';
import { noStore } from '../../../common/http/etag';
import { Idempotent } from '../../../common/idempotency/idempotency.interceptor';
import { ApiErrors, ZBody, ZQuery, ZResponse } from '../../../common/zod/decorators';
import { WeightsService } from '../services/weights.service';

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
