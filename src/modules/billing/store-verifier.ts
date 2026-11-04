import type { EntitlementPeriod, EntitlementSource } from '../../shared';

export interface StoreEntitlement {
  plan: 'free' | 'plus';
  period: EntitlementPeriod | null;
  activeUntil: Date | null;
  source: EntitlementSource | null;
}

/** Store verification for POST /billing/sync (DEC-09). */
export abstract class StoreVerifier {
  /** null = no information; keep what the server has. */
  abstract fetch(appUserId: string): Promise<StoreEntitlement | null>;
}

/** Dev/test: no store; the server's entitlement stays as it is. */
export class StubStoreVerifier extends StoreVerifier {
  async fetch(): Promise<StoreEntitlement | null> {
    return null;
  }
}

interface RcEntitlement {
  expires_date: string | null;
  grace_period_expires_date?: string | null;
  product_identifier: string;
}
interface RcSubscriber {
  subscriber?: {
    entitlements?: Record<string, RcEntitlement>;
    subscriptions?: Record<string, { store?: string }>;
  };
}

/** Maps a RevenueCat subscriber to our entitlement (BR-03: grace period counts as active). */
export function mapRevenueCatSubscriber(body: RcSubscriber, now = new Date()): StoreEntitlement {
  const plus = body.subscriber?.entitlements?.plus;
  const until = plus ? new Date(plus.grace_period_expires_date ?? plus.expires_date ?? 8.64e15) : null;
  if (!plus || !until || until <= now) return { plan: 'free', period: null, activeUntil: until, source: null };
  const store = body.subscriber?.subscriptions?.[plus.product_identifier]?.store;
  return {
    plan: 'plus',
    period: plus.product_identifier.includes('yearly') ? 'yearly' : 'monthly',
    activeUntil: until,
    source: store === 'app_store' ? 'app_store' : store === 'play_store' ? 'play_store' : 'promo',
  };
}

export class RevenueCatVerifier extends StoreVerifier {
  constructor(private readonly apiKey: string) {
    super();
  }
  async fetch(appUserId: string): Promise<StoreEntitlement | null> {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return mapRevenueCatSubscriber((await res.json()) as RcSubscriber);
  }
}
