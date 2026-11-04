import { Schema, Types } from 'mongoose';
import type { SubscriptionStatus } from '../../domain/entitlements/revenuecat';

export interface SubscriptionDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  store: 'app_store' | 'play_store' | 'promo';
  productId: string;
  period: 'monthly' | 'yearly';
  status: SubscriptionStatus;
  startedAt: Date | null;
  currentPeriodEnd: Date | null;
  gracePeriodEnd: Date | null;
  autoRenew: boolean;
  originalTransactionId: string | null;
  revenuecatAppUserId: string;
  lastEventAt: number;
  createdAt: Date;
}

/** subscriptions (plan section 6). Kept after account purge (store records). */
export const SubscriptionSchema = new Schema<SubscriptionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    store: { type: String, required: true },
    productId: { type: String, required: true },
    period: { type: String, required: true },
    status: { type: String, required: true },
    startedAt: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    gracePeriodEnd: { type: Date, default: null },
    autoRenew: { type: Boolean, default: true },
    originalTransactionId: { type: String, default: null },
    revenuecatAppUserId: { type: String, required: true },
    lastEventAt: { type: Number, default: 0 },
  },
  { collection: 'subscriptions', timestamps: true },
);
SubscriptionSchema.index({ userId: 1, originalTransactionId: 1 });
SubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

export interface BillingEventDoc {
  _id: Types.ObjectId;
  eventId: string;
  type: string;
  userId: Types.ObjectId | null;
  payload: Record<string, unknown>;
  status: 'pending' | 'processed' | 'failed' | 'ignored';
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

/** billing_events: idempotent by RevenueCat event id, kept 7 years (BR-14), replayable. */
export const BillingEventSchema = new Schema<BillingEventDoc>(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, default: null },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, default: 'pending' },
    error: { type: String, default: null },
    receivedAt: { type: Date, required: true },
    processedAt: { type: Date, default: null },
  },
  { collection: 'billing_events', timestamps: true, minimize: false },
);
BillingEventSchema.index({ eventId: 1 }, { unique: true });
BillingEventSchema.index({ userId: 1, receivedAt: -1 });
BillingEventSchema.index({ status: 1, receivedAt: -1 });
