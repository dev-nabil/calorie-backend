import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Queue, QueueEvents, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { ApiError } from '../../common/errors/api-error';

export const AI_QUEUE = 'ai';

type Outcome = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; status: number; details: Record<string, unknown> } };
type Handler = (payload: unknown) => Promise<unknown>;

/** Named AI jobs (meal parse, onboarding extraction). Errors travel as data so codes survive the worker hop. */
@Injectable()
export class AiJobHandlers {
  private readonly handlers = new Map<string, Handler>();

  register(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  async dispatch(name: string, payload: unknown): Promise<Outcome> {
    const handler = this.handlers.get(name);
    if (!handler) return { ok: false, error: { code: 'INTERNAL', message: `No AI job handler ${name}`, status: 500, details: {} } };
    try {
      return { ok: true, value: await handler(payload) };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false, error: { code: e.code, message: e.message, status: e.getStatus(), details: e.details } };
      throw e;
    }
  }
}

function unwrap<T>(o: Outcome): T {
  if (o.ok) return o.value as T;
  throw new ApiError(o.error.code as never, o.error.message, o.error.status as HttpStatus, o.error.details, 'retryAfterSec' in o.error.details ? { 'Retry-After': String(o.error.details.retryAfterSec) } : {});
}

/**
 * Runs an AI job and waits for its result (plan section 4: model calls run in the worker, except
 * coach streaming). With Redis the job goes through BullMQ queue `ai`; without it, in-process.
 */
export abstract class AiJobRunner {
  abstract run<T>(name: string, payload: unknown, timeoutMs: number): Promise<T>;
  async close(): Promise<void> {}
}

export class InlineAiJobRunner extends AiJobRunner {
  constructor(private readonly handlers: AiJobHandlers) {
    super();
  }
  async run<T>(name: string, payload: unknown): Promise<T> {
    return unwrap<T>(await this.handlers.dispatch(name, payload));
  }
}

export class BullAiJobRunner extends AiJobRunner {
  private readonly queue: Queue;
  private readonly events: QueueEvents;
  constructor(connection: Redis) {
    super();
    this.queue = new Queue(AI_QUEUE, { connection });
    this.events = new QueueEvents(AI_QUEUE, { connection: connection.duplicate() });
  }
  async run<T>(name: string, payload: unknown, timeoutMs: number): Promise<T> {
    const job = await this.queue.add(name, payload, { removeOnComplete: { age: 3600, count: 500 }, removeOnFail: { age: 3600, count: 500 }, attempts: 1 });
    try {
      return unwrap<T>((await job.waitUntilFinished(this.events, timeoutMs)) as Outcome);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('AI_UNAVAILABLE', 'Milo is resting. Try again soon.', HttpStatus.SERVICE_UNAVAILABLE, { retryAfterSec: 30 }, { 'Retry-After': '30' });
    }
  }
  override async close(): Promise<void> {
    await this.events.close();
    await this.queue.close();
  }
}

/** Worker side of queue `ai`. */
export function startAiWorker(connection: Redis, handlers: AiJobHandlers, logger: Logger): Worker {
  const worker = new Worker(AI_QUEUE, async (job) => handlers.dispatch(job.name, job.data), { connection, concurrency: 16 });
  logger.log('ai worker started');
  return worker;
}
