import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { loadConfig } from '../../src/config/env';
import { WorkerModule } from '../../src/worker.module';
import { ScanProcessor } from '../../src/modules/scans/services/scan.processor';
import { IndexBuilder } from '../../src/jobs/indexes';

describe('ROLE=worker (DEC-02)', () => {
  it('boots the worker context with the scan processor and shuts down cleanly', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ROLE: 'worker',
      LOG_LEVEL: 'silent',
      MONGODB_URI: process.env.TEST_MONGO_URI!.replace('/?', `/worker_${randomUUID().slice(0, 8)}?`),
    });
    const ref = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config)] }).compile();
    const app = ref;
    await app.init();
    expect(app.get(ScanProcessor)).toBeInstanceOf(ScanProcessor);
    expect(await app.get(ScanProcessor).sweep()).toBe(0);
    expect(await app.get(IndexBuilder).build()).toBeGreaterThan(20);
    await app.close();
  });
});
