import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { AppConfig } from '../../../config/env';
import { ScanQueue } from '../scan-queue';
import { ScanProcessor } from './scan.processor';

export const SWEEP_EVERY_MS = 30_000;

/** Every 30 s: retries scans that are stuck (process restarted, provider down) or have waited too long (QA B17). Not in tests. */
@Injectable()
export class ScanSweep implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger('ScanSweep');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly processor: ScanProcessor,
    private readonly queue: ScanQueue,
  ) {}

  onModuleInit(): void {
    if (this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.processor.sweep().catch((e: unknown) => this.logger.error({ err: e }, 'sweep failed')), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  /** Lets scans in flight finish before the database connection closes. */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue.drain();
  }
}
