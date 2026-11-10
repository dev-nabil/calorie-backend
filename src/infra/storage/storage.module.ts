import { Global, Module } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { LocalStorageService, S3StorageService, StorageService } from './storage';

@Global()
@Module({
  providers: [
    {
      provide: StorageService,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): StorageService =>
        c.storageDriver === 's3'
          ? new S3StorageService({
              endpoint: c.S3_ENDPOINT ?? `https://s3.${c.S3_REGION ?? 'us-east-1'}.amazonaws.com`,
              region: c.S3_REGION ?? 'auto',
              bucket: c.S3_BUCKET ?? 'nouri',
              accessKeyId: c.S3_ACCESS_KEY_ID ?? '',
              secretAccessKey: c.S3_SECRET_ACCESS_KEY ?? '',
            }, c.CDN_BASE_URL && c.CDN_SIGNING_KEY ? { base: c.CDN_BASE_URL, key: c.CDN_SIGNING_KEY } : null)
          : new LocalStorageService(
              c.LOCAL_STORAGE_DIR,
              createHash('sha256').update(`storage:${c.JWT_ACCESS_SECRET}`).digest('hex'),
              `http://localhost:${c.PORT}`,
            ),
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
