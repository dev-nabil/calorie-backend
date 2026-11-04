import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../infra/kv/kv.module';
import { AiJobHandlers, startAiWorker } from './ai-jobs';

@Injectable()
export class AiWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('AiWorker');
  private worker: Worker | null = null;
  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis | null,
    private readonly handlers: AiJobHandlers,
  ) {}
  onModuleInit(): void {
    if (this.redis) this.worker = startAiWorker(this.redis, this.handlers, this.logger);
  }
  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
