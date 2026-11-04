import { Inject, Injectable, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../infra/kv/kv.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { PlansModule } from '../plans/plans.module';
import { TrackingModule } from '../tracking/tracking.module';
import { BullScanQueue, InlineScanQueue, ScanQueue, SCANS_QUEUE } from './scan-queue';
import { StorageImageUrlResolver, ImageUrlResolver, ScanProcessor } from './scan.processor';
import { ScansController } from './scans.controller';
import { ScansService } from './scans.service';

const SWEEP_EVERY_MS = 30_000;

const core = [
  ScanProcessor,
  { provide: ImageUrlResolver, useClass: StorageImageUrlResolver },
  {
    provide: ScanQueue,
    inject: [REDIS_CONNECTION, ScanProcessor],
    useFactory: (redis: Redis | null, processor: ScanProcessor): ScanQueue =>
      redis ? new BullScanQueue(redis) : new InlineScanQueue((id) => processor.process(id)),
  },
];

/** Without Redis there is no worker, so the API process runs the stuck-scan sweep (QA B17). */
export function runsInlineSweep(config: { NODE_ENV: string }, redis: unknown): boolean {
  return !redis && config.NODE_ENV !== 'test';
}

@Injectable()
class InlineSweep implements OnModuleInit, OnApplicationShutdown {
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

/** API role: endpoints. Without Redis the processor and the sweep run in-process (dev only). */
@Module({
  imports: [PlansModule, TrackingModule],
  controllers: [ScansController],
  providers: [...core, ScansService, InlineSweep],
  exports: [ScanQueue, ScanProcessor],
})
export class ScansModule {}


@Injectable()
class ScanWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ScanWorker');
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis | null,
    private readonly processor: ScanProcessor,
  ) {}

  onModuleInit(): void {
    if (this.redis) {
      this.worker = new Worker(SCANS_QUEUE, async (job) => this.processor.process((job.data as { scanId: string }).scanId), {
        connection: this.redis,
        concurrency: 8,
      });
      this.logger.log('scans worker started');
    } else {
      this.logger.warn('REDIS_URL not set: no BullMQ worker; scans run inline in the API process');
    }
    this.timer = setInterval(() => {
      this.processor.sweep().catch((e: unknown) => this.logger.error({ err: e }, 'sweep failed'));
    }, SWEEP_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
  }
}

/** Worker role: BullMQ processor for queue `scans` plus the stuck-job sweep. */
@Module({
  imports: [PlansModule, TrackingModule],
  providers: [...core, ScanWorker],
})
export class ScansWorkerModule {}
