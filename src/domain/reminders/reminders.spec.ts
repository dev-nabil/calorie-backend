import { localToUtc, nextFireAt, offsetMs, ringTimes, validateReminders } from './index';

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

  it('allows any time of day and at most 3 per day', () => {
    for (const time of ['00:00', '03:00', '06:59', '22:00', '23:30']) {
      expect(validateReminders([{ time, days: [], enabled: true }])).toEqual({ ok: true });
    }
    expect(validateReminders([{ time: '23:30', days: [], enabled: false }])).toEqual({ ok: true });
    expect(validateReminders([{ time: '25:00', days: [], enabled: true }])).toMatchObject({ ok: false, reason: 'time' });
    const four = ['08:00', '12:00', '15:00', '18:00'].map((time) => ({ time, days: ['mon' as const], enabled: true }));
    expect(validateReminders(four)).toMatchObject({ ok: false, reason: 'max_per_day', details: { day: 'mon', count: 4 } });
    expect(validateReminders(four.slice(0, 3))).toEqual({ ok: true });
  });

  it('repeats every few hours from the start time up to the end time', () => {
    expect(ringTimes({ time: '08:00', everyHours: 2, endTime: '20:00' })).toEqual(['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00']);
    expect(ringTimes({ time: '08:30', everyHours: 2, endTime: '13:00' })).toEqual(['08:30', '10:30', '12:30']);
    expect(ringTimes({ time: '08:00', everyHours: null, endTime: '20:00' })).toEqual(['08:00']);
    expect(ringTimes({ time: '09:00', everyHours: 3, endTime: '21:00' })).toEqual(['09:00', '12:00', '15:00', '18:00', '21:00']);
    expect(ringTimes({ time: '00:00', everyHours: 1, endTime: '23:59' })).toHaveLength(24);
    const rule = { time: '08:00', days: [], timezone: 'Europe/London', everyHours: 2, endTime: '12:00' };
    expect(nextFireAt(rule, new Date('2026-11-02T08:00:00Z'))!.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(nextFireAt(rule, new Date('2026-11-02T10:30:00Z'))!.toISOString()).toBe('2026-11-02T12:00:00.000Z');
    // After the last ring: tomorrow's first one.
    expect(nextFireAt(rule, new Date('2026-11-02T12:00:00Z'))!.toISOString()).toBe('2026-11-03T08:00:00.000Z');
  });

  it('a repeating reminder needs an interval of 1 to 12 hours (the user picks it) and a later end time, and counts once toward the cap', () => {
    const r = { time: '08:00', days: [], enabled: true };
    for (const everyHours of [1, 2, 3, 5, 12]) expect(validateReminders([{ ...r, everyHours, endTime: '22:00' }])).toEqual({ ok: true });
    expect(validateReminders([{ ...r, everyHours: 0, endTime: '22:00' }])).toMatchObject({ ok: false, reason: 'every_hours' });
    expect(validateReminders([{ ...r, everyHours: 1.5, endTime: '22:00' }])).toMatchObject({ ok: false, reason: 'every_hours' });
    expect(validateReminders([{ ...r, everyHours: 13, endTime: '22:00' }])).toMatchObject({ ok: false, reason: 'every_hours' });
    expect(validateReminders([{ ...r, everyHours: 2 }])).toMatchObject({ ok: false, reason: 'end_time' });
    expect(validateReminders([{ ...r, everyHours: 2, endTime: '08:00' }])).toMatchObject({ ok: false, reason: 'end_time' });
    expect(validateReminders([{ ...r, everyHours: 2, endTime: '07:00' }])).toMatchObject({ ok: false, reason: 'end_time' });
    const three = ['08:00', '12:00', '18:00'].map((time) => ({ time, days: [], enabled: true, everyHours: 2, endTime: '23:00' }));
    expect(validateReminders(three)).toEqual({ ok: true });
  });
});
