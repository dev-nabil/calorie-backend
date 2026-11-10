import { Injectable } from '@nestjs/common';

type Handler = (payload: unknown) => Promise<unknown>;

/**
 * Named AI tasks (meal parse, onboarding extraction, plan tips, recap, fridge chef, speech). A handler
 * registers itself on boot and a caller runs it by name and waits for the answer, in the same process.
 * Handlers own their model timeouts and report failures as ApiError (usually AI_UNAVAILABLE).
 */
@Injectable()
export class AiJobs {
  private readonly handlers = new Map<string, Handler>();

  register(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  async run<T>(name: string, payload: unknown): Promise<T> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No AI job handler ${name}`);
    return (await handler(payload)) as T;
  }
}
