import { clock } from '../../common/clock';
import { Controller, Get, HttpCode, Injectable, Module, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { BillingEntitlementSchema, BillingSyncRequestSchema, SUBSCRIPTION_PRODUCTS, type BillingEntitlement } from '../../shared';
import { entitlementView, freeScansRemaining } from '../../domain/entitlements';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { noStore } from '../../common/http/etag';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { KvStore } from '../../infra/kv/kv-store';
import { UsersService } from '../users/users.service';
import { ENTITLEMENT_CACHE_SEC, entitlementCacheKey } from './entitlement-cache';
import { RevenueCatVerifier, StoreVerifier, StubStoreVerifier } from './store-verifier';
import { BillingEventsService, RevenueCatWebhookController } from './revenuecat-webhook';

@Injectable()
export class BillingService {
  constructor(
    private readonly users: UsersService,
    private readonly kv: KvStore,
    private readonly store: StoreVerifier,
  ) {}

  async entitlement(userId: string): Promise<BillingEntitlement> {
    const cached = await this.kv.get(entitlementCacheKey(userId));
    if (cached) return JSON.parse(cached) as BillingEntitlement;
    const user = await this.users.requireActive(userId);
    const ledgerUsed = await this.users.ledgerUsed(user.email);
    const view = entitlementView(user.entitlement, clock.now());
    const body: BillingEntitlement = {
      ...view,
      freeScans: {
        allowance: user.freeScans.allowance,
        used: Math.max(user.freeScans.used, ledgerUsed),
        remaining: freeScansRemaining({ allowance: user.freeScans.allowance, used: user.freeScans.used, ledgerUsed }),
      },
      products: { monthly: SUBSCRIPTION_PRODUCTS.monthly.productId, yearly: SUBSCRIPTION_PRODUCTS.yearly.productId },
    };
    await this.kv.set(entitlementCacheKey(userId), JSON.stringify(body), ENTITLEMENT_CACHE_SEC);
    return body;
  }

  /** After purchase or restore: ask the store (RevenueCat) and refresh the server entitlement. */
  async sync(userId: string): Promise<BillingEntitlement> {
    await this.users.requireActive(userId);
    const fresh = await this.store.fetch(userId);
    if (fresh) await this.users.users.updateOne({ _id: userId }, { $set: { entitlement: fresh } });
    await this.kv.del(entitlementCacheKey(userId));
    return this.entitlement(userId);
  }
}

@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
class BillingController {
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

@Module({
  controllers: [BillingController, RevenueCatWebhookController],
  providers: [
    BillingService,
    BillingEventsService,
    {
      provide: StoreVerifier,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): StoreVerifier => (c.REVENUECAT_API_KEY ? new RevenueCatVerifier(c.REVENUECAT_API_KEY) : new StubStoreVerifier()),
    },
  ],
  exports: [BillingService, BillingEventsService],
})
export class BillingModule {}
