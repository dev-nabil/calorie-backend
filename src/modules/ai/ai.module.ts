import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { REDIS_CONNECTION } from '../../infra/kv/kv.module';
import { AiJobHandlers, AiJobRunner, BullAiJobRunner, InlineAiJobRunner, startAiWorker } from './ai-jobs';
import { AiProvider, FakeAiProvider, OpenAiProvider } from './ai.provider';
import { AiService } from './ai.service';

/** modules/ai (M4-T2). The provider is chosen by AI_PROVIDER; production refuses `fake`. */
@Global()
@Module({
  providers: [
    AiService,
    AiJobHandlers,
    {
      provide: AiProvider,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): AiProvider => {
        if (c.AI_PROVIDER === 'openai' && c.OPENAI_API_KEY) return new OpenAiProvider(c.OPENAI_API_KEY);
        // Plan personalisation reports `not_configured` instead of showing made-up output (PLAN-GEN).
        new Logger('AiModule').warn(
          c.AI_PROVIDER === 'openai'
            ? 'AI_PROVIDER=openai but OPENAI_API_KEY is empty: AI features run on the fake provider and plan tips are switched off'
            : 'AI_PROVIDER=fake: AI features run on the fake provider and plan tips are switched off (set AI_PROVIDER=openai and OPENAI_API_KEY)',
        );
        return new FakeAiProvider();
      },
    },
    {
      provide: AiJobRunner,
      inject: [REDIS_CONNECTION, AiJobHandlers],
      useFactory: (redis: Redis | null, handlers: AiJobHandlers): AiJobRunner =>
        redis ? new BullAiJobRunner(redis) : new InlineAiJobRunner(handlers),
    },
  ],
  exports: [AiService, AiProvider, AiJobHandlers, AiJobRunner],
})
export class AiModule {}

@Injectable()
class AiWorker implements OnModuleInit, OnApplicationShutdown {
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

/** Worker role: processes queue `ai` (meal parse, onboarding extraction). */
@Module({ providers: [AiWorker] })
export class AiWorkerModule {}
