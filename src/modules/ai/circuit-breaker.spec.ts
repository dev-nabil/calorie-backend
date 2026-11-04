import { CircuitBreaker } from './circuit-breaker';

describe('CircuitBreaker (plan 8.10)', () => {
  let now = 0;
  const make = () => new CircuitBreaker(undefined, () => now);
  beforeEach(() => {
    now = 0;
  });

  it('stays closed below the minimum call count', () => {
    const b = make();
    for (let i = 0; i < 19; i++) b.record(false);
    expect(b.state()).toBe('closed');
    expect(b.allow()).toBe(true);
  });

  it('opens at 50% errors over at least 20 calls, then half-opens after 30 s', () => {
    const b = make();
    for (let i = 0; i < 10; i++) b.record(true);
    for (let i = 0; i < 10; i++) b.record(false);
    expect(b.state()).toBe('open');
    expect(b.allow()).toBe(false);
    expect(b.retryAfterSec()).toBe(30);
    now = 30_000;
    expect(b.state()).toBe('half_open');
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false); // one probe at a time
    b.record(true);
    expect(b.state()).toBe('closed');
  });

  it('re-opens when the probe fails and forgets old events', () => {
    const b = make();
    for (let i = 0; i < 20; i++) b.record(false);
    now = 31_000;
    expect(b.allow()).toBe(true);
    b.record(false);
    expect(b.state()).toBe('open');
    now = 200_000;
    b.allow();
    b.record(true);
    for (let i = 0; i < 15; i++) b.record(false);
    now = 270_000;
    for (let i = 0; i < 6; i++) b.record(false);
    expect(b.state()).toBe('closed'); // earlier errors fell out of the window
  });
});
