import { Controller, Get, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
ProgressQuerySchema,
ProgressResponseSchema, type ProgressResponse
} from '../../../shared';
import { CurrentUser, type AuthUser } from '../../../common/auth/auth.decorators';
import { noStore } from '../../../common/http/etag';
import { ApiErrors, ZQuery, ZResponse } from '../../../common/zod/decorators';
import { DaysService } from '../services/days.service';

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
