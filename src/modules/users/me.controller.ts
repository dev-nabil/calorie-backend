import { Controller, Delete, Get, HttpCode, Patch, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DeleteMeResponseSchema, MeSchema, UpdateMeRequestSchema, type DeleteMeResponse, type Me, type UpdateMeRequest } from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { UsersService } from './users.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ZResponse(200, MeSchema)
  @ApiErrors(401, 403)
  async get(@CurrentUser() auth: AuthUser, @Res({ passthrough: true }) res: Response): Promise<Me> {
    noStore(res);
    return this.users.toMe(await this.users.requireActive(auth.id));
  }

  @Patch()
  @ZResponse(200, MeSchema)
  @ApiErrors(400, 401, 403)
  async update(@CurrentUser() auth: AuthUser, @ZBody(UpdateMeRequestSchema) body: UpdateMeRequest): Promise<Me> {
    return this.users.toMe(await this.users.update(auth.id, body));
  }

  @Delete()
  @HttpCode(202)
  @ZResponse(202, DeleteMeResponseSchema, 'Deletion started; all sessions signed out (BR-13)')
  @ApiErrors(401, 403)
  async remove(@CurrentUser() auth: AuthUser): Promise<DeleteMeResponse> {
    const { purgeAfter } = await this.users.requestDeletion(auth.id);
    return { status: 'pending_deletion', purgeAfter: purgeAfter.toISOString() };
  }
}
