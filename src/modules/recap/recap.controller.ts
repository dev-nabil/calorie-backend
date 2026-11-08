import { Controller, Get, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RecapQuerySchema, WeeklyRecapSchema, type RecapQuery, type WeeklyRecap } from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { ApiErrors, ZQuery, ZResponse } from '../../common/zod/decorators';
import { RecapService } from './recap.service';

@ApiTags('recap')
@ApiBearerAuth()
@Controller('recap')
export class RecapController {
  constructor(private readonly recap: RecapService) {}

  @Get('weekly')
  @ZResponse(
    200,
    WeeklyRecapSchema,
    "Plus. Stats from the person's logs and Milo's story cards in the app language. ai: false (no cards) when nothing is logged, Milo is resting, the daily limit is used or the answer was unusable: build the cards from stats. Never an error for those",
  )
  @ApiErrors(400, 401, 402)
  weekly(@CurrentUser() u: AuthUser, @ZQuery(RecapQuerySchema) q: RecapQuery, @Res({ passthrough: true }) res: Response): Promise<WeeklyRecap> {
    noStore(res);
    return this.recap.weekly(u.id, q.range);
  }
}
