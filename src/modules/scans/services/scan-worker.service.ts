import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../infra/kv/kv.module';
import { SCANS_QUEUE } from '../scan-queue';
import { ScanProcessor } from './scan.processor';
import { SWEEP_EVERY_MS } from '../scans.providers';

@Injectable()
export class ScanWorker implements OnModuleInit, OnApplicationShutdown {
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
