import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { KvStore, MemoryKvStore, RedisKvStore } from './kv-store';

export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');

@Injectable()
class KvShutdown implements OnApplicationShutdown {
  constructor(@Inject(KvStore) private readonly kv: KvStore) {}
  async onApplicationShutdown(): Promise<void> {
    await this.kv.close();
  }
}

/** Redis when REDIS_URL is set, otherwise an in-memory store (dev and tests). */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis | null =>
        config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false }) : null,
    },
    {
      provide: KvStore,
      inject: [REDIS_CONNECTION],
      useFactory: (redis: Redis | null): KvStore => (redis ? new RedisKvStore(redis) : new MemoryKvStore()),
    },
    KvShutdown,
  ],
  exports: [KvStore, REDIS_CONNECTION],
})
export class KvModule {}
