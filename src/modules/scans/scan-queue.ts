import { Logger } from '@nestjs/common';

/**
 * Runs a queued scan in this process right after POST /scans answers 202. The scan row in MongoDB is
 * the durable part: if the process stops mid-scan, ScanSweep picks the scan up again.
 */
export class ScanQueue {
  private readonly logger = new Logger('ScanQueue');
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly run: (scanId: string) => Promise<void>) {}

  async enqueue(scanId: string): Promise<void> {
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(scanId))
      .catch((e: unknown) => this.logger.warn({ scanId, err: (e as Error).message }, 'scan job failed'))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Tests and shutdown: wait for queued scans. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
