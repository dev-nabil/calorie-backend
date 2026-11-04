import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { applyRcEvent, type RcEvent } from '../../../domain/entitlements/revenuecat';
import { clock } from '../../../common/clock';
import { ApiError } from '../../../common/errors/api-error';
import { KvStore } from '../../../infra/kv/kv-store';
import type { UserDoc } from '../../users/schemas/users.schema';
import type { BillingEventDoc, SubscriptionDoc } from '../schemas/billing.schema';
import { entitlementCacheKey } from '../entitlement-cache';

/** Applies one billing event (webhook or admin replay) to subscriptions and users.entitlement. */
@Injectable()
export class BillingEventsService {
  private readonly logger = new Logger('RevenueCat');

  constructor(
    @InjectModel('BillingEvent') private readonly events: Model<BillingEventDoc>,
    @InjectModel('Subscription') private readonly subs: Model<SubscriptionDoc>,
    @InjectModel('User') private readonly users: Model<UserDoc>,
    private readonly kv: KvStore,
  ) {}

  async receive(e: RcEvent): Promise<{ status: string }> {
    try {
      await this.events.create({ eventId: e.id, type: e.type, payload: e as unknown as Record<string, unknown>, receivedAt: clock.now() });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return { status: 'duplicate' };
      throw err;
    }
    return this.process(e.id, false);
  }

  async process(eventId: string, force: boolean): Promise<{ status: string }> {
    const doc = await this.events.findOne({ eventId }).lean<BillingEventDoc>();
    if (!doc) throw ApiError.notFound();
    const e = doc.payload as unknown as RcEvent;
    const user = await this.findUser(e);
    if (!user) {
      await this.events.updateOne({ _id: doc._id }, { $set: { status: 'failed', error: 'unknown app_user_id', processedAt: clock.now() } });
      return { status: 'failed' };
    }
    const key = { userId: user._id, originalTransactionId: e.original_transaction_id ?? null };
    const prev = await this.subs.findOne(key).lean<SubscriptionDoc>();
    const out = applyRcEvent(prev, e, clock.now(), { force });
    if ('ignored' in out) {
      await this.events.updateOne({ _id: doc._id }, { $set: { status: 'ignored', error: out.ignored, userId: user._id, processedAt: clock.now() } });
      return { status: 'ignored' };
    }
    await this.subs.updateOne(key, { $set: { ...out.subscription, revenuecatAppUserId: e.app_user_id } }, { upsert: true });
    await this.users.updateOne({ _id: user._id }, { $set: { entitlement: out.entitlement } });
    await this.kv.del(entitlementCacheKey(user._id.toString()));
    await this.events.updateOne({ _id: doc._id }, { $set: { status: 'processed', error: null, userId: user._id, processedAt: clock.now() } });
    this.logger.log({ type: e.type, userId: user._id.toString(), plan: out.entitlement.plan }, 'billing event applied');
    return { status: 'processed' };
  }

  /** RevenueCat app user id is our user id; aliases fall back to original_app_user_id. */
  private async findUser(e: RcEvent): Promise<UserDoc | null> {
    for (const id of [e.app_user_id, e.original_app_user_id]) {
      if (id && Types.ObjectId.isValid(id)) {
        const u = await this.users.findById(id).lean<UserDoc>();
        if (u) return u;
      }
    }
    return null;
  }
}
