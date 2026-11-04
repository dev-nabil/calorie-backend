import { DynamicModule, Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import { ConfigModule } from './config/config.module';
import type { AppConfig } from './config/env';
import { KvModule } from './infra/kv/kv.module';
import { ModelsModule } from './infra/mongo/models.module';
import { MongoModule } from './infra/mongo/mongo.module';
import { JobsModule } from './jobs/background-jobs';
import { StorageModule } from './infra/storage/storage.module';
import { WORKER_MODULES } from './jobs';

/** ROLE=worker: no HTTP server; BullMQ processors and scheduled jobs only. */
@Module({})
export class WorkerModule {
  static forRoot(config?: AppConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [ConfigModule.forRoot(config), LoggingModule, KvModule, MongoModule, ModelsModule, StorageModule, JobsModule, CommonModule, ...WORKER_MODULES],
    };
  }
}
