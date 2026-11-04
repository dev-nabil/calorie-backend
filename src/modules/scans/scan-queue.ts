import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';

export const SCANS_QUEUE = 'scans';

/** Hand-off from the API to the worker (S-01). */
export abstract class ScanQueue {
  abstract enqueue(scanId: string): Promise<void>;
  abstract close(): Promise<void>;
}

/** Production: BullMQ on Redis; jobId = scanId so a retry never enqueues twice. */
export class BullScanQueue extends ScanQueue {
  private readonly queue: Queue;
  constructor(connection: Redis) {
    super();
    this.queue = new Queue(SCANS_QUEUE, { connection });
  }
  async enqueue(scanId: string): Promise<void> {
    await this.queue.add('scan', { scanId }, {
      jobId: scanId,
      attempts: 8,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** Dev and tests without Redis: runs the processor in-process on the next tick. */
export class InlineScanQueue extends ScanQueue {
  private readonly logger = new Logger('InlineScanQueue');
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly run: (scanId: string) => Promise<void>) {
    super();
  }
  async enqueue(scanId: string): Promise<void> {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(scanId))
      .catch((e: unknown) => this.logger.warn({ scanId, err: (e as Error).message }, 'inline scan job failed'))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
  /** Test hook: wait for queued jobs. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
  async close(): Promise<void> {
    await this.drain();
  }
}
