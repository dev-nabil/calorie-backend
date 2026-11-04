import { inQuietHours, localToUtc, nextFireAt, offsetMs, validateReminders } from './index';

describe('reminders scheduling (M9-T1)', () => {
  it('converts local times across zones', () => {
    expect(localToUtc('2026-11-02', '08:00', 'Europe/London').toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(localToUtc('2026-07-01', '08:00', 'Europe/London').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(localToUtc('2026-11-02', '08:00', 'Asia/Tokyo').toISOString()).toBe('2026-11-01T23:00:00.000Z');
    expect(offsetMs('America/New_York', Date.UTC(2026, 0, 1))).toBe(-5 * 3600_000);
  });

  it('handles the spring-forward gap and the fall-back repeat (Europe/London 2026)', () => {
    // 29 March: 01:00 → 02:00. 01:30 does not exist: fire at 02:30 BST (01:30Z).
    expect(localToUtc('2026-03-29', '01:30', 'Europe/London').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // 25 October: 01:00–02:00 happens twice. Fire at the first one (BST, 00:30Z).
    expect(localToUtc('2026-10-25', '01:30', 'Europe/London').toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(localToUtc('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('computes the next fire time on selected weekdays', () => {
    const rule = { time: '12:30', days: ['mon', 'wed'] as ('mon' | 'wed')[], timezone: 'Europe/London' };
    expect(nextFireAt(rule, new Date('2026-11-02T10:00:00Z'))!.toISOString()).toBe('2026-11-02T12:30:00.000Z'); // Monday
    expect(nextFireAt(rule, new Date('2026-11-02T12:30:00Z'))!.toISOString()).toBe('2026-11-04T12:30:00.000Z'); // Wednesday
    expect(nextFireAt({ ...rule, days: [] }, new Date('2026-11-02T13:00:00Z'))!.toISOString()).toBe('2026-11-03T12:30:00.000Z');
    // Travel: same rule in Tokyo
    expect(nextFireAt({ ...rule, timezone: 'Asia/Tokyo' }, new Date('2026-11-02T00:00:00Z'))!.toISOString()).toBe('2026-11-02T03:30:00.000Z');
  });

  it('enforces quiet hours and at most 3 per day', () => {
    expect(inQuietHours('23:00')).toBe(true);
    expect(inQuietHours('06:59')).toBe(true);
    expect(inQuietHours('07:00')).toBe(false);
    expect(inQuietHours('12:00', { start: '12:00', end: '13:00' })).toBe(true);
    expect(validateReminders([{ time: '23:30', days: [], enabled: true }])).toMatchObject({ ok: false, reason: 'quiet_hours' });
    expect(validateReminders([{ time: '23:30', days: [], enabled: false }])).toEqual({ ok: true });
    expect(validateReminders([{ time: '25:00', days: [], enabled: true }])).toMatchObject({ ok: false, reason: 'time' });
    const four = ['08:00', '12:00', '15:00', '18:00'].map((time) => ({ time, days: ['mon' as const], enabled: true }));
    expect(validateReminders(four)).toMatchObject({ ok: false, reason: 'max_per_day', details: { day: 'mon', count: 4 } });
    expect(validateReminders(four.slice(0, 3))).toEqual({ ok: true });
  });
});
