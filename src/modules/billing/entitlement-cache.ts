/** Key-value store key for the 60 s entitlement cache (plan section 7); deleted on every change. */
export const entitlementCacheKey = (userId: string): string => `ent:${userId}`;
export const ENTITLEMENT_CACHE_SEC = 60;
