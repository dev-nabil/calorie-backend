import { BeforeApplicationShutdown, Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import type { JobDoc, JobScheduleDoc } from './job.schema';

type Handler = (payload: unknown) => Promise<unknown>;

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 5_000;
/** A job still `running` after this (its process died) is picked up again. */
const LOCK_MS = 5 * 60_000;
const POLL_MS = 15_000;
const SCHEDULE_TICK_MS = 30_000;
const KEEP_DONE_MS = 24 * 3600_000;
const KEEP_FAILED_MS = 7 * 24 * 3600_000;

/** Named background jobs (export, purge, thumbnails, summaries, prerender, reminders, reconcile). */
@Injectable()
export class JobHandlers {
  private readonly handlers = new Map<string, Handler>();
  private readonly schedules = new Map<string, number>();

  /** `everyMs`: also run it on that interval (whole service, not per instance). */
  register(name: string, handler: Handler, everyMs?: number): void {
    this.handlers.set(name, handler);
    if (everyMs) this.schedules.set(name, everyMs);
  }

  get(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  /** Runs a handler right now, outside the queue (dev route POST /v1/dev/jobs/:name). */
  async run(name: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No job handler ${name}`);
    return handler(payload);
  }

  scheduled(): [string, number][] {
    return [...this.schedules.entries()];
  }
}

/**
 * Durable job queue in MongoDB (collection `jobs`), worked by the API process itself: no Redis, no
 * separate worker. A job runs right after it is enqueued; failures retry with backoff, and a job whose
 * process died is picked up again after its lock expires. The atomic claim keeps it safe with several
 * instances too.
 */
@Injectable()
export class JobQueue implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private readonly inflight = new Set<Promise<void>>();
  private pumping = false;
  private again = false;
  private stopped = false;
  private poll: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel('Job') private readonly jobs: Model<JobDoc>,
    private readonly handlers: JobHandlers,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.NODE_ENV === 'test') return; // tests run jobs on enqueue and wait with drain()
    this.poll = setInterval(() => this.kick(), POLL_MS);
    this.poll.unref();
    this.kick(); // jobs left over from the last run
  }

  /** Runs before the database connection closes, so a deploy (SIGTERM) lets running jobs finish. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    await Promise.allSettled([...this.inflight]);
  }

  /** `key` dedupes: a job with the same key that is queued, running or finished in the last day wins. */
  async enqueue(name: string, payload: unknown, opts: { key?: string } = {}): Promise<void> {
    try {
      await this.jobs.create({ name, payload, ...(opts.key ? { key: opts.key } : {}), status: 'queued', runAt: new Date(), attempts: 0 });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      return;
    }
    this.kick();
  }

  /** Tests: run every due job, including ones enqueued by other jobs, and wait for them. */
  async drain(): Promise<void> {
    for (;;) {
      // Never call pump() while one runs: re-flagging it every turn would keep it looping forever.
      if (!this.pumping) await this.pump();
      if (this.inflight.size) {
        await Promise.allSettled([...this.inflight]);
        continue;
      }
      if (this.pumping) {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      if (await this.jobs.exists(this.dueFilter(new Date()))) continue;
      return;
    }
  }

  private kick(): void {
    if (!this.stopped) setImmediate(() => void this.pump().catch((e: unknown) => this.logger.error({ err: e }, 'job pump failed')));
  }

  private dueFilter(now: Date) {
    return { $or: [{ status: 'queued' as const, runAt: { $lte: now } }, { status: 'running' as const, lockedUntil: { $lte: now } }] };
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        while (!this.stopped && this.inflight.size < CONCURRENCY) {
          const now = new Date();
          const job = await this.jobs
            .findOneAndUpdate(this.dueFilter(now), { $set: { status: 'running', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } }, { sort: { runAt: 1 }, returnDocument: 'after' })
            .lean<JobDoc>();
          if (!job) break;
          const p: Promise<void> = this.execute(job).finally(() => {
            this.inflight.delete(p);
            this.kick();
          });
          this.inflight.add(p);
        }
      } while (this.again && !this.stopped);
    } finally {
      this.pumping = false;
    }
  }

  private async execute(job: JobDoc): Promise<void> {
    const handler = this.handlers.get(job.name);
    try {
      if (!handler) throw new Error(`No job handler ${job.name}`);
      await handler(job.payload);
      await this.jobs.updateOne({ _id: job._id }, { $set: { status: 'done', lockedUntil: null, error: null, expiresAt: new Date(Date.now() + KEEP_DONE_MS) } });
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      const last = job.attempts >= MAX_ATTEMPTS;
      this.logger.warn({ job: job.name, id: job._id.toString(), attempt: job.attempts, error }, last ? 'job failed for good' : 'job failed, will retry');
      await this.jobs.updateOne(
        { _id: job._id },
        last
          ? { $set: { status: 'failed', lockedUntil: null, error, expiresAt: new Date(Date.now() + KEEP_FAILED_MS) } }
          : { $set: { status: 'queued', lockedUntil: null, error, runAt: new Date(Date.now() + BACKOFF_MS * 2 ** (job.attempts - 1)) } },
      );
    }
  }
}

/**
 * Repeating jobs. The last run of each lives in `job_schedules`, so a job that is due runs once on the
 * next tick wherever and whenever the process wakes up (a 24-hour timer would never fire on a server
 * that sleeps after 15 idle minutes). Never in NODE_ENV=test.
 */
@Injectable()
export class JobScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private readonly logger = new Logger('JobScheduler');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel('JobSchedule') private readonly schedules: Model<JobScheduleDoc>,
    private readonly handlers: JobHandlers,
    private readonly queue: JobQueue,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), SCHEDULE_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    for (const [name, every] of this.handlers.scheduled()) {
      try {
        if (await this.claim(name, every, now)) await this.queue.enqueue(name, {}, { key: `schedule:${name}:${now.getTime()}` });
      } catch (e) {
        this.logger.error({ job: name, err: e }, 'schedule tick failed');
      }
    }
  }

  /** True for exactly one caller once `every` has passed since the last run. */
  private async claim(name: string, every: number, now: Date): Promise<boolean> {
    try {
      // A row that is not due yet makes the upsert insert a duplicate _id, which fails.
      await this.schedules.updateOne({ _id: name, lastRunAt: { $lte: new Date(now.getTime() - every) } }, { $set: { lastRunAt: now } }, { upsert: true });
      return true;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
  }
}

@Global()
@Module({ providers: [JobHandlers, JobQueue, JobScheduler], exports: [JobHandlers, JobQueue] })
export class JobsModule {}
