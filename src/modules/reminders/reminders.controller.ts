import { Controller, Get, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PutRemindersRequestSchema, RemindersResponseSchema, type PutRemindersRequest } from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { RemindersService } from './reminders.service';

@ApiTags('reminders')
@ApiBearerAuth()
@Controller('reminders')
export class RemindersController {
  constructor(private readonly svc: RemindersService) {}

  @Get()
  @ZResponse(200, RemindersResponseSchema)
  @ApiErrors(401)
  get(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    noStore(res);
    return this.svc.get(u.id);
  }

  @Put()
  @ZResponse(200, RemindersResponseSchema, 'Replaces all reminders (at most 3 per day; any time of day is allowed)')
  @ApiErrors(400, 401, 422)
  put(@CurrentUser() u: AuthUser, @ZBody(PutRemindersRequestSchema) body: PutRemindersRequest) {
    return this.svc.put(u.id, body);
  }
}
