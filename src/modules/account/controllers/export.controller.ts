import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ExportResponseSchema } from '../../../shared';
import { CurrentUser, type AuthUser } from '../../../common/auth/auth.decorators';
import { ApiErrors, ZResponse } from '../../../common/zod/decorators';
import { UsersService } from '../../users/users.service';
import { AccountService } from '../account.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class ExportController {
  constructor(
    private readonly account: AccountService,
    private readonly users: UsersService,
  ) {}

  @Get('export')
  @HttpCode(202)
  @ZResponse(202, ExportResponseSchema, 'Builds the JSON export in the worker and emails a 24-hour link')
  @ApiErrors(401, 403, 429)
  async export(@CurrentUser() u: AuthUser) {
    await this.users.requireActive(u.id);
    const { exportId } = await this.account.requestExport(u.id);
    return { status: 'queued' as const, exportId, message: 'We are preparing your data and will email you a download link.' };
  }
}
