import { assignExperiments, bucketOf, pickVariant } from './index';

describe('experiments (S-20)', () => {
  const def = { active: true, variants: [{ id: 'on', weight: 50 }, { id: 'off', weight: 50 }] };

  it('buckets deterministically into 0–9999', () => {
    expect(bucketOf('u1', 'k')).toBe(bucketOf('u1', 'k'));
    const b = bucketOf('u2', 'k');
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(10000);
  });

  it('splits roughly by weight', () => {
    let on = 0;
    for (let i = 0; i < 2000; i++) if (pickVariant(`user-${i}`, 'paywall.onboarding', def) === 'on') on++;
    expect(on).toBeGreaterThan(850);
    expect(on).toBeLessThan(1150);
    expect(pickVariant('x', 'k', { active: true, variants: [{ id: 'a', weight: 0 }, { id: 'b', weight: 1 }] })).toBe('b');
  });

  it('respects the allocation share', () => {
    let inside = 0;
    for (let i = 0; i < 2000; i++) if (pickVariant(`u-${i}`, 'k', { ...def, allocationPct: 10 }) !== null) inside++;
    expect(inside).toBeGreaterThan(120);
    expect(inside).toBeLessThan(280);
    expect(pickVariant('x', 'k', { ...def, allocationPct: 0 })).toBeNull();
  });

  it('returns null for inactive or empty experiments', () => {
    expect(pickVariant('x', 'k', { ...def, active: false })).toBeNull();
    expect(pickVariant('x', 'k', { active: true, variants: [] })).toBeNull();
  });

  it('keeps existing assignments and only adds new ones', () => {
    const r = assignExperiments('u', { a: 'off', gone: 'x' }, { a: def, b: def, c: { ...def, active: false } });
    expect(r.assignments.a).toBe('off');
    expect(Object.keys(r.added)).toEqual(['b']);
    expect(r.assignments.c).toBeUndefined();
    const reassigned = assignExperiments('u', { a: 'removed-variant' }, { a: def });
    expect(Object.keys(reassigned.added)).toEqual(['a']);
  });

  it('B22: leaves out stopped experiments even for users already bucketed', () => {
    const r = assignExperiments('u', { a: 'on' }, { a: { ...def, active: false } });
    expect(r.assignments).toEqual({});
    expect(r.added).toEqual({});
  });
});
