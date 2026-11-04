/**
 * Per-feature circuit breaker (plan 8.10): opens after ≥50% errors over 1 minute with at least
 * 20 calls; after 30 s one half-open probe is allowed; a successful probe closes it.
 */
export interface BreakerOptions {
  windowMs: number;
  minCalls: number;
  errorRate: number;
  openMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = { windowMs: 60_000, minCalls: 20, errorRate: 0.5, openMs: 30_000 };

export type BreakerState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private events: { at: number; ok: boolean }[] = [];
  private openedAt: number | null = null;
  private probing = false;

  constructor(
    private readonly opts: BreakerOptions = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}

  state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.opts.openMs ? 'half_open' : 'open';
  }

  /** Seconds until a call may be tried again (0 when allowed). */
  retryAfterSec(): number {
    if (this.openedAt === null) return 0;
    return Math.max(0, Math.ceil((this.openedAt + this.opts.openMs - this.now()) / 1000));
  }

  /** True when a call may go ahead; in half-open only one probe at a time. */
  allow(): boolean {
    const s = this.state();
    if (s === 'closed') return true;
    if (s === 'half_open' && !this.probing) {
      this.probing = true;
      return true;
    }
    return false;
  }

  record(ok: boolean): void {
    const t = this.now();
    if (this.probing) {
      this.probing = false;
      if (ok) {
        this.openedAt = null;
        this.events = [];
      } else {
        this.openedAt = t;
      }
      return;
    }
    this.events = this.events.filter((e) => t - e.at < this.opts.windowMs);
    this.events.push({ at: t, ok });
    const errors = this.events.filter((e) => !e.ok).length;
    if (this.events.length >= this.opts.minCalls && errors / this.events.length >= this.opts.errorRate) {
      this.openedAt = t;
      this.events = [];
    }
  }
}
