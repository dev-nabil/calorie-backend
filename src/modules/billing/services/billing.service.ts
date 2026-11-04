import { clock } from '../../../common/clock';
import { Injectable } from '@nestjs/common';
import { SUBSCRIPTION_PRODUCTS, type BillingEntitlement } from '../../../shared';
import { entitlementView, freeScansRemaining } from '../../../domain/entitlements';
import { KvStore } from '../../../infra/kv/kv-store';
import { UsersService } from '../../users/users.service';
import { ENTITLEMENT_CACHE_SEC, entitlementCacheKey } from '../entitlement-cache';
import { StoreVerifier } from '../providers/store-verifier';

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
