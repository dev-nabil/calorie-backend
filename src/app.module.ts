import { DynamicModule, Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import { ConfigModule } from './config/config.module';
import { loadConfig, type AppConfig } from './config/env';
import { DevModule } from './modules/dev/dev.module';
import { KvModule } from './infra/kv/kv.module';
import { ModelsModule } from './infra/mongo/models.module';
import { MongoModule } from './infra/mongo/mongo.module';
import { JobsModule } from './jobs/jobs.module';
import { StorageModule } from './infra/storage/storage.module';
import { FEATURE_MODULES } from './modules/feature-modules';
import { WORKER_MODULES } from './jobs/worker-modules';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule,
        KvModule,
        MongoModule,
        ModelsModule,
        StorageModule,
        JobsModule,
        CommonModule,
        ...FEATURE_MODULES,
        // ROLE=all: the queue processors run inside this process too (no separate `start:worker`).
        ...(config.ROLE === 'all' ? WORKER_MODULES : []),
        ...(config.devRoutes ? [DevModule] : []),
      ],
    };
  }
}
