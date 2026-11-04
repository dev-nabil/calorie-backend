import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../infra/kv/kv.module';
import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/env';
import { ScanProcessor } from './scan.processor';
import { SWEEP_EVERY_MS } from '../scans.providers';

/** Without Redis there is no worker, so the API process runs the stuck-scan sweep (QA B17). */
export function runsInlineSweep(config: { NODE_ENV: string }, redis: unknown): boolean {
  return !redis && config.NODE_ENV !== 'test';
}

@Injectable()
export class InlineSweep implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis | null,
    private readonly processor: ScanProcessor,
  ) {}
  onModuleInit(): void {
    if (!runsInlineSweep(this.config, this.redis)) return;
    this.timer = setInterval(() => void this.processor.sweep().catch(() => undefined), SWEEP_EVERY_MS);
    this.timer.unref();
  }
  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
