import { applyRcEvent, entitlementFor, storeOf, type RcEvent, type SubscriptionState } from './revenuecat';

const now = new Date('2026-11-02T12:00:00Z');
const day = 86_400_000;
const ev = (type: string, over: Partial<RcEvent> = {}): RcEvent => ({
  id: `e-${type}`,
  type,
  app_user_id: 'u1',
  product_id: 'nouri_plus_monthly',
  store: 'APP_STORE',
  event_timestamp_ms: now.getTime(),
  purchased_at_ms: now.getTime(),
  expiration_at_ms: now.getTime() + 30 * day,
  ...over,
});
const state = (o: ReturnType<typeof applyRcEvent>): SubscriptionState => {
  if ('ignored' in o) throw new Error(o.ignored);
  return o.subscription;
};

describe('RevenueCat events (BR-03)', () => {
  it('purchase and renewal make Plus active until expiry', () => {
    const r = applyRcEvent(null, ev('INITIAL_PURCHASE'), now);
    expect(r).toMatchObject({ subscription: { status: 'active', period: 'monthly', store: 'app_store', autoRenew: true }, entitlement: { plan: 'plus', source: 'app_store' } });
    const yearly = applyRcEvent(null, ev('RENEWAL', { product_id: 'nouri_plus_yearly', store: 'PLAY_STORE' }), now);
    expect(yearly).toMatchObject({ entitlement: { plan: 'plus', period: 'yearly', source: 'play_store' } });
  });

  it('cancellation keeps Plus until the period ends; refunds end it at once', () => {
    const active = state(applyRcEvent(null, ev('INITIAL_PURCHASE'), now));
    const cancelled = applyRcEvent(active, ev('CANCELLATION', { cancel_reason: 'UNSUBSCRIBE', event_timestamp_ms: now.getTime() + 1 }), now);
    expect(cancelled).toMatchObject({ subscription: { status: 'cancelled', autoRenew: false }, entitlement: { plan: 'plus' } });
    const refunded = applyRcEvent(active, ev('CANCELLATION', { cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: now.getTime() + 2 }), now);
    expect(refunded).toMatchObject({ subscription: { status: 'refunded' }, entitlement: { plan: 'free' } });
    expect(applyRcEvent(active, ev('REFUND', { event_timestamp_ms: now.getTime() + 3 }), now)).toMatchObject({ entitlement: { plan: 'free' } });
  });

  it('billing issues: grace period counts as active; billing retry without grace does not', () => {
    const active = state(applyRcEvent(null, ev('INITIAL_PURCHASE', { expiration_at_ms: now.getTime() - 1000 }), now));
    const grace = applyRcEvent(active, ev('BILLING_ISSUE', { grace_period_expiration_at_ms: now.getTime() + 6 * day, expiration_at_ms: now.getTime() - 1000, event_timestamp_ms: now.getTime() + 1 }), now);
    expect(grace).toMatchObject({ subscription: { status: 'grace' }, entitlement: { plan: 'plus', activeUntil: new Date(now.getTime() + 6 * day) } });
    const retry = applyRcEvent(active, ev('BILLING_ISSUE', { grace_period_expiration_at_ms: null, expiration_at_ms: now.getTime() - 1000, event_timestamp_ms: now.getTime() + 2 }), now);
    expect(retry).toMatchObject({ subscription: { status: 'billing_retry' }, entitlement: { plan: 'free' } });
  });

  it('expiration returns to Free; old, test and unknown events are ignored', () => {
    const active = state(applyRcEvent(null, ev('INITIAL_PURCHASE'), now));
    expect(applyRcEvent(active, ev('EXPIRATION', { expiration_at_ms: now.getTime() - 1, event_timestamp_ms: now.getTime() + 1 }), now)).toMatchObject({ subscription: { status: 'expired' }, entitlement: { plan: 'free' } });
    expect(applyRcEvent(active, ev('RENEWAL', { event_timestamp_ms: now.getTime() - 5000 }), now)).toEqual({ ignored: 'out_of_order' });
    expect('ignored' in applyRcEvent(active, ev('RENEWAL', { event_timestamp_ms: now.getTime() - 5000 }), now, { force: true })).toBe(false);
    expect(applyRcEvent(null, ev('TEST'), now)).toEqual({ ignored: 'test_event' });
    expect(applyRcEvent(null, ev('TRANSFER'), now)).toEqual({ ignored: 'unsupported:TRANSFER' });
    expect(storeOf('PROMOTIONAL')).toBe('promo');
    expect(entitlementFor({ ...active, status: 'expired' }, now).plan).toBe('free');
  });
});
