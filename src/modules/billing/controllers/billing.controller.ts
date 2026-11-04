import { Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { BillingEntitlementSchema, BillingSyncRequestSchema, type BillingEntitlement } from '../../../shared';
import { CurrentUser, type AuthUser } from '../../../common/auth/auth.decorators';
import { noStore } from '../../../common/http/etag';
import { ApiErrors, ZBody, ZResponse } from '../../../common/zod/decorators';
import { BillingService } from '../services/billing.service';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('entitlement')
  @ZResponse(200, BillingEntitlementSchema, 'Plan, renewal date and free scans left (cached 60 s)')
  @ApiErrors(401)
  get(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response): Promise<BillingEntitlement> {
    noStore(res);
    return this.billing.entitlement(u.id);
  }

  @Post('sync')
  @HttpCode(200)
  @ZResponse(200, BillingEntitlementSchema, 'Refresh after purchase or restore (stub store outside production)')
  @ApiErrors(400, 401)
  sync(@CurrentUser() u: AuthUser, @ZBody(BillingSyncRequestSchema) _body: unknown): Promise<BillingEntitlement> {
    return this.billing.sync(u.id);
  }
}
