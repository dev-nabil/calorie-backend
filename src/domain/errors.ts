import type { ErrorCode } from '../shared';

/** Error thrown by pure domain modules; the API maps it to { error: { code, message, details } }. */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
