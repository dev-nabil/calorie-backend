import { DynamicModule, Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import { ConfigModule } from './config/config.module';
import { loadConfig, type AppConfig } from './config/env';
import { KvModule } from './infra/kv/kv.module';
import { IndexesModule } from './infra/mongo/indexes';
import { ModelsModule } from './infra/mongo/models.module';
import { MongoModule } from './infra/mongo/mongo.module';
import { StorageModule } from './infra/storage/storage.module';
import { JobsModule } from './jobs/jobs.module';
import { DevModule } from './modules/dev/dev.module';
import { FEATURE_MODULES } from './modules/feature-modules';
import { LocalUploadsModule } from './modules/uploads/local-uploads.module';

/**
 * The whole backend in one process: HTTP API, background jobs (MongoDB queue), scan processing and
 * schedules. No Redis and no separate worker.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule,
        MongoModule,
        ModelsModule,
        IndexesModule,
        KvModule,
        StorageModule,
        JobsModule,
        CommonModule,
        ...FEATURE_MODULES,
        // Local disk storage needs its file endpoints whatever DEV_ROUTES says (production requires S3).
        ...(config.storageDriver === 'local' ? [LocalUploadsModule] : []),
        ...(config.devRoutes ? [DevModule] : []),
      ],
    };
  }
}
