import { Controller, Get, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CoachPreferencesSchema, ERROR_CODES, PutCoachPreferencesRequestSchema, type CoachPreferences, type PutCoachPreferencesRequest } from '../../shared';
import { isPlusActive } from '../../domain/entitlements';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import { noStore } from '../../common/http/etag';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { UsersService } from '../users/users.service';
import { CoachPreferencesService } from './coach-preferences.service';

@ApiTags('coach')
@ApiBearerAuth()
@Controller('coach')
export class CoachPreferencesController {
  constructor(
    private readonly prefs: CoachPreferencesService,
    private readonly users: UsersService,
  ) {}

  @Get('preferences')
  @ZResponse(200, CoachPreferencesSchema, "Milo's tone and the notes Milo remembers (defaults: warm, no notes), for any signed-in user. The coach applies them only while Plus is active")
  @ApiErrors(401)
  async get(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response): Promise<CoachPreferences> {
    noStore(res);
    await this.users.requireActive(u.id);
    return this.prefs.get(u.id);
  }

  /** Full replace, so a repeat is harmless (no Idempotency-Key needed). Plus only. */
  @Put('preferences')
  @ZResponse(200, CoachPreferencesSchema, 'Saved as sent: notes trimmed, inner whitespace collapsed, duplicates dropped. 402 PLUS_REQUIRED for free users')
  @ApiErrors(400, 401, 402)
  async put(@CurrentUser() u: AuthUser, @ZBody(PutCoachPreferencesRequestSchema) body: PutCoachPreferencesRequest, @Res({ passthrough: true }) res: Response): Promise<CoachPreferences> {
    noStore(res);
    const user = await this.users.requireActive(u.id);
    if (!isPlusActive(user.entitlement, clock.now())) throw new ApiError(ERROR_CODES.PLUS_REQUIRED, "Milo's style and memory are part of Nouri Plus", 402);
    return this.prefs.put(u.id, body);
  }
}
