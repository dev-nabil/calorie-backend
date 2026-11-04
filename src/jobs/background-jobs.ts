import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { REDIS_CONNECTION } from '../infra/kv/kv.module';

export const JOBS_QUEUE = 'jobs';
type Handler = (payload: unknown) => Promise<unknown>;

/** Named background jobs (export, purge, thumbnails, summaries, reminders, reconcile). */
@Injectable()
export class JobHandlers {
  private readonly handlers = new Map<string, Handler>();
  private readonly schedules = new Map<string, number>();

  register(name: string, handler: Handler, everyMs?: number): void {
    this.handlers.set(name, handler);
    if (everyMs) this.schedules.set(name, everyMs);
  }

  async dispatch(name: string, payload: unknown): Promise<unknown> {
    const h = this.handlers.get(name);
    if (!h) throw new Error(`No job handler ${name}`);
    return h(payload);
  }

  scheduled(): [string, number][] {
    return [...this.schedules.entries()];
  }
}

export abstract class JobQueue {
  abstract enqueue(name: string, payload: unknown, opts?: { jobId?: string; delayMs?: number }): Promise<void>;
  /** Tests: wait for inline jobs. */
  async drain(): Promise<void> {}
}

export class BullJobQueue extends JobQueue {
  private readonly queue: Queue;
  constructor(connection: Redis) {
    super();
    this.queue = new Queue(JOBS_QUEUE, { connection });
  }
  async enqueue(name: string, payload: unknown, opts: { jobId?: string; delayMs?: number } = {}): Promise<void> {
    await this.queue.add(name, payload, { jobId: opts.jobId, delay: opts.delayMs, attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 });
  }
  async schedule(name: string, everyMs: number): Promise<void> {
    await this.queue.upsertJobScheduler(name, { every: everyMs }, { name, data: {} });
  }
  async close(): Promise<void> {
    await this.queue.close();
  }
}

export class InlineJobQueue extends JobQueue {
  private readonly logger = new Logger('InlineJobQueue');
  private readonly pending = new Set<Promise<void>>();
  private readonly seen = new Set<string>();
  constructor(private readonly handlers: JobHandlers) {
    super();
  }
  async enqueue(name: string, payload: unknown, opts: { jobId?: string; delayMs?: number } = {}): Promise<void> {
    if (opts.jobId) {
      if (this.seen.has(opts.jobId)) return;
      this.seen.add(opts.jobId);
    }
    const p = new Promise<void>((r) => setTimeout(r, opts.delayMs ?? 0))
      .then(() => this.handlers.dispatch(name, payload))
      .then(() => undefined)
      .catch((e: unknown) => this.logger.warn({ job: name, err: (e as Error).message }, 'inline job failed'))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
  override async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}

/**
 * Runs schedules: with Redis the worker role creates BullMQ job schedulers; without Redis
 * (`start:local`) the API process runs them with timers. Never in NODE_ENV=test.
 */
@Injectable()
class JobRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private worker: Worker | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis | null,
    private readonly handlers: JobHandlers,
    private readonly queue: JobQueue,
  ) {}

  onModuleInit(): void {
    // Handlers register in their own onModuleInit; start after the event loop turn so all are present.
    setImmediate(() => void this.start());
  }

  private async start(): Promise<void> {
    if (this.config.NODE_ENV === 'test') return;
    if (this.redis && this.config.ROLE === 'worker') {
      this.worker = new Worker(JOBS_QUEUE, async (job) => this.handlers.dispatch(job.name, job.data), { connection: this.redis, concurrency: 4 });
      for (const [name, every] of this.handlers.scheduled()) await (this.queue as BullJobQueue).schedule(name, every);
      this.logger.log(`jobs worker started (${this.handlers.scheduled().length} schedules)`);
    } else if (!this.redis) {
      for (const [name, every] of this.handlers.scheduled()) {
        const t = setInterval(() => void this.queue.enqueue(name, {}), every);
        t.unref();
        this.timers.push(t);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.timers.forEach(clearInterval);
    await this.worker?.close();
  }
}

@Global()
@Module({
  providers: [
    JobHandlers,
    {
      provide: JobQueue,
      inject: [REDIS_CONNECTION, JobHandlers],
      useFactory: (redis: Redis | null, handlers: JobHandlers): JobQueue => (redis ? new BullJobQueue(redis) : new InlineJobQueue(handlers)),
    },
    JobRunner,
  ],
  exports: [JobHandlers, JobQueue],
})
export class JobsModule {}
