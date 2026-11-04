import type Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../infra/kv/kv.module';
import { BullScanQueue, InlineScanQueue, ScanQueue } from './scan-queue';
import { StorageImageUrlResolver, ImageUrlResolver, ScanProcessor } from './services/scan.processor';

export const SWEEP_EVERY_MS = 30_000;

/** Providers shared by the API and worker roles. */
export const scanCoreProviders = [
  ScanProcessor,
  { provide: ImageUrlResolver, useClass: StorageImageUrlResolver },
  {
    provide: ScanQueue,
    inject: [REDIS_CONNECTION, ScanProcessor],
    useFactory: (redis: Redis | null, processor: ScanProcessor): ScanQueue =>
      redis ? new BullScanQueue(redis) : new InlineScanQueue((id) => processor.process(id)),
  },
];
