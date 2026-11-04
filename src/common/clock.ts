/**
 * Server clock with a development-only offset (POST /v1/dev/clock) so QA can test day rollover,
 * streaks, the 7-day restore window and plan dates. The offset can only be set through dev routes,
 * which are never mounted in production.
 */
let offsetMs = 0;

export const clock = {
  now(): Date {
    return new Date(Date.now() + offsetMs);
  },
  offsetMs(): number {
    return offsetMs;
  },
  setOffset(ms: number): void {
    offsetMs = ms;
  },
};
