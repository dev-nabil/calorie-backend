/**
 * RevenueCat webhook events → subscription state and entitlement (DEC-09, BR-03). Pure.
 * Plus is active while activeUntil is in the future, including the store's grace period.
 * Refunds and expiry return the user to Free immediately.
 */
export interface RcEvent {
  id: string;
  type: string;
  app_user_id: string;
  original_app_user_id?: string;
  product_id?: string;
  event_timestamp_ms?: number;
  purchased_at_ms?: number | null;
  expiration_at_ms?: number | null;
  grace_period_expiration_at_ms?: number | null;
  store?: string;
  cancel_reason?: string | null;
  original_transaction_id?: string | null;
  environment?: string;
}

export type SubscriptionStatus = 'active' | 'grace' | 'billing_retry' | 'cancelled' | 'expired' | 'refunded';

export interface SubscriptionState {
  status: SubscriptionStatus;
  productId: string;
  period: 'monthly' | 'yearly';
  store: 'app_store' | 'play_store' | 'promo';
  startedAt: Date | null;
  currentPeriodEnd: Date | null;
  gracePeriodEnd: Date | null;
  autoRenew: boolean;
  lastEventAt: number;
}

export interface EntitlementPatch {
  plan: 'free' | 'plus';
  period: 'monthly' | 'yearly' | null;
  activeUntil: Date | null;
  source: 'app_store' | 'play_store' | 'promo' | null;
}

export type RcOutcome = { ignored: string } | { subscription: SubscriptionState; entitlement: EntitlementPatch };

const ACTIVE_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT']);
const ms = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? new Date(v) : null);

export function storeOf(s?: string): SubscriptionState['store'] {
  return s === 'APP_STORE' || s === 'MAC_APP_STORE' ? 'app_store' : s === 'PLAY_STORE' ? 'play_store' : 'promo';
}

export function entitlementFor(sub: SubscriptionState, now: Date): EntitlementPatch {
  const until = sub.status === 'grace' ? sub.gracePeriodEnd : sub.currentPeriodEnd;
  const live = ['active', 'cancelled', 'grace'].includes(sub.status) && until !== null && until > now;
  return live ? { plan: 'plus', period: sub.period, activeUntil: until, source: sub.store } : { plan: 'free', period: null, activeUntil: until, source: null };
}

export function applyRcEvent(prev: SubscriptionState | null, e: RcEvent, now: Date, opts: { force?: boolean } = {}): RcOutcome {
  if (e.type === 'TEST') return { ignored: 'test_event' };
  const at = e.event_timestamp_ms ?? now.getTime();
  if (prev && !opts.force && at < prev.lastEventAt) return { ignored: 'out_of_order' };
  const productId = e.product_id ?? prev?.productId ?? 'unknown';
  const base: SubscriptionState = {
    status: prev?.status ?? 'active',
    productId,
    period: /year|annual/i.test(productId) ? 'yearly' : 'monthly',
    store: e.store ? storeOf(e.store) : (prev?.store ?? 'promo'),
    startedAt: prev?.startedAt ?? ms(e.purchased_at_ms),
    currentPeriodEnd: ms(e.expiration_at_ms) ?? prev?.currentPeriodEnd ?? null,
    gracePeriodEnd: prev?.gracePeriodEnd ?? null,
    autoRenew: prev?.autoRenew ?? true,
    lastEventAt: at,
  };
  let sub: SubscriptionState;
  if (ACTIVE_TYPES.has(e.type)) {
    sub = { ...base, status: 'active', gracePeriodEnd: null, autoRenew: e.type !== 'NON_RENEWING_PURCHASE' };
  } else if (e.type === 'REFUND' || (e.type === 'CANCELLATION' && e.cancel_reason === 'CUSTOMER_SUPPORT')) {
    sub = { ...base, status: 'refunded', autoRenew: false, currentPeriodEnd: now, gracePeriodEnd: null };
  } else if (e.type === 'CANCELLATION') {
    sub = { ...base, status: 'cancelled', autoRenew: false };
  } else if (e.type === 'BILLING_ISSUE') {
    const grace = ms(e.grace_period_expiration_at_ms);
    sub = grace && grace > now ? { ...base, status: 'grace', gracePeriodEnd: grace } : { ...base, status: 'billing_retry', gracePeriodEnd: null };
  } else if (e.type === 'EXPIRATION') {
    sub = { ...base, status: 'expired', autoRenew: false, gracePeriodEnd: null };
  } else {
    return { ignored: `unsupported:${e.type}` };
  }
  return { subscription: sub, entitlement: entitlementFor(sub, now) };
}
