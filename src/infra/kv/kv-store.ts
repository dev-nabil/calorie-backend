import type Redis from 'ioredis';

/**
 * Small key-value contract over Redis (DEC-04): idempotency keys, rate limits, revocation
 * timestamps and caches. The in-memory driver is used when REDIS_URL is not set (dev, tests);
 * it is per-process and therefore not for production (config refuses it there).
 */
export abstract class KvStore {
  abstract readonly kind: 'redis' | 'memory';
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, ttlSec: number): Promise<void>;
  /** SET NX: true when the key was created. */
  abstract setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>;
  abstract del(key: string): Promise<void>;
  /** Increments a counter; the TTL starts with the first hit. */
  abstract incr(key: string, ttlSec: number): Promise<{ count: number; ttlSec: number }>;
  abstract ping(): Promise<boolean>;
  abstract close(): Promise<void>;
}

export class MemoryKvStore extends KvStore {
  readonly kind = 'memory' as const;
  private readonly data = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.data.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.data.set(key, { value, expiresAt: this.now() + ttlSec * 1000 });
  }
  async setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean> {
    if (this.live(key)) return false;
    await this.set(key, value, ttlSec);
    return true;
  }
  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
  async incr(key: string, ttlSec: number): Promise<{ count: number; ttlSec: number }> {
    const entry = this.live(key);
    if (!entry) {
      await this.set(key, '1', ttlSec);
      return { count: 1, ttlSec };
    }
    entry.value = String(Number(entry.value) + 1);
    return { count: Number(entry.value), ttlSec: Math.max(1, Math.ceil((entry.expiresAt - this.now()) / 1000)) };
  }
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {
    this.data.clear();
  }
}

export class RedisKvStore extends KvStore {
  readonly kind = 'redis' as const;
  constructor(private readonly redis: Redis) {
    super();
  }
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSec);
  }
  async setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean> {
    return (await this.redis.set(key, value, 'EX', ttlSec, 'NX')) === 'OK';
  }
  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
  async incr(key: string, ttlSec: number): Promise<{ count: number; ttlSec: number }> {
    const [[, count], [, ttl]] = (await this.redis.multi().incr(key).ttl(key).exec()) as [[null, number], [null, number]];
    if (ttl < 0) {
      await this.redis.expire(key, ttlSec);
      return { count, ttlSec };
    }
    return { count, ttlSec: ttl };
  }
  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
