import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
DeletionRequestResponseSchema,
DeletionRequestSchema, WaitlistRequestSchema,
WaitlistResponseSchema,
type WaitlistResponse
} from '../../shared';
import { Public } from '../../common/auth/auth.decorators';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { PublicService } from './public.service';

@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(private readonly svc: PublicService) {}

  @Public()
  @Post('waitlist')
  @HttpCode(200)
  @ZResponse(200, WaitlistResponseSchema, 'Landing-page waitlist; repeat sign-ups are not an error')
  @ApiErrors(400, 403, 429)
  join(@ZBody(WaitlistRequestSchema) body: Parameters<PublicService['join']>[0], @Req() req: Request): Promise<WaitlistResponse> {
    return this.svc.join(body, req.ip ?? 'unknown');
  }

  @Public()
  @Post('deletion-requests')
  @HttpCode(202)
  @ZResponse(202, DeletionRequestResponseSchema, 'Always 202 { status: "received" } (Google Play web deletion)')
  @ApiErrors(400, 403, 429)
  async deletion(@ZBody(DeletionRequestSchema) body: Parameters<PublicService['requestDeletion']>[0], @Req() req: Request) {
    await this.svc.requestDeletion(body, req.ip ?? 'unknown');
    return { status: 'received' as const };
  }
}
