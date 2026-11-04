import { classify, percentile, RequestMetrics } from './request-metrics';

describe('request metrics (SLO inputs)', () => {
  it('classifies the SLO routes', () => {
    expect(classify('GET', '/v1/days/2026-11-02')).toBe('read');
    expect(classify('GET', '/v1/progress')).toBe('read');
    expect(classify('POST', '/v1/meals')).toBe('write');
    expect(classify('POST', '/v1/days/2026-11-02/water')).toBe('write');
    expect(classify('POST', '/v1/meals/parse')).toBe('other');
  });
  it('computes p95 and 5xx counts', () => {
    const m = new RequestMetrics();
    for (let i = 1; i <= 100; i++) m.record('read', i, i === 100 ? 503 : 200);
    expect(m.p95('read')).toBe(95);
    expect(m.errors5xx).toBe(1);
    expect(m.count('read')).toBe(100);
    expect(percentile([], 95)).toBeNull();
  });
});
