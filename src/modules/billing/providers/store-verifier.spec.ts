import { mapRevenueCatSubscriber, StubStoreVerifier } from './store-verifier';

describe('RevenueCat mapping (BR-03)', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  it('maps an active yearly App Store subscription', () => {
    const e = mapRevenueCatSubscriber(
      { subscriber: { entitlements: { plus: { expires_date: '2027-11-02T12:00:00Z', product_identifier: 'nouri_plus_yearly' } }, subscriptions: { nouri_plus_yearly: { store: 'app_store' } } } },
      now,
    );
    expect(e).toEqual({ plan: 'plus', period: 'yearly', activeUntil: new Date('2027-11-02T12:00:00Z'), source: 'app_store' });
  });
  it('counts the grace period and returns free after expiry or refund', () => {
    const grace = mapRevenueCatSubscriber(
      { subscriber: { entitlements: { plus: { expires_date: '2026-11-01T00:00:00Z', grace_period_expires_date: '2026-11-10T00:00:00Z', product_identifier: 'nouri_plus_monthly' } }, subscriptions: { nouri_plus_monthly: { store: 'play_store' } } } },
      now,
    );
    expect(grace).toMatchObject({ plan: 'plus', period: 'monthly', source: 'play_store' });
    expect(mapRevenueCatSubscriber({ subscriber: { entitlements: { plus: { expires_date: '2026-11-01T00:00:00Z', product_identifier: 'x' } } } }, now).plan).toBe('free');
    expect(mapRevenueCatSubscriber({}, now)).toEqual({ plan: 'free', period: null, activeUntil: null, source: null });
  });
  it('stub returns no information', async () => {
    expect(await new StubStoreVerifier().fetch()).toBeNull();
  });
});
