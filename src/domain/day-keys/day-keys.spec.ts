import {
  addDays,
  dayKeyFor,
  dayRange,
  diffDays,
  isoWeekday,
  isValidDayKey,
  isValidTimeZone,
  resolveEntryDay,
  startOfWeek,
} from './index';
import { DomainError } from '../errors';

describe('day-keys (BR-07)', () => {
  it('Tokyo 23:50 and London 00:10 land on the correct distinct days', () => {
    // 2026-11-02 23:50 in Tokyo (UTC+9) = 14:50Z on 2 Nov
    const tokyo = new Date('2026-11-02T14:50:00Z');
    // 2026-11-03 00:10 in London (UTC+0 in November) = 00:10Z on 3 Nov
    const london = new Date('2026-11-03T00:10:00Z');
    expect(dayKeyFor(tokyo, 'Asia/Tokyo')).toBe('2026-11-02');
    expect(dayKeyFor(london, 'Europe/London')).toBe('2026-11-03');
    // the Tokyo instant is still 2 Nov in London and the London instant is 3 Nov in Tokyo
    expect(dayKeyFor(tokyo, 'Europe/London')).toBe('2026-11-02');
    expect(dayKeyFor(london, 'Asia/Tokyo')).toBe('2026-11-03');
  });

  it('a traveller logging the same instant gets the day of the zone it was logged in', () => {
    const instant = new Date('2026-07-01T02:30:00Z');
    expect(dayKeyFor(instant, 'Europe/London')).toBe('2026-07-01'); // 03:30 BST
    expect(dayKeyFor(instant, 'America/Los_Angeles')).toBe('2026-06-30'); // 19:30 PDT
    expect(dayKeyFor(instant, 'Pacific/Kiritimati')).toBe('2026-07-01'); // 16:30 +14
  });

  it('handles DST spring-forward and fall-back in Europe/London', () => {
    // Spring forward 2026-03-29 01:00Z; 23:30 local on 28th = 23:30Z
    expect(dayKeyFor(new Date('2026-03-28T23:30:00Z'), 'Europe/London')).toBe('2026-03-28');
    // 23:30 BST on 29th = 22:30Z
    expect(dayKeyFor(new Date('2026-03-29T22:30:00Z'), 'Europe/London')).toBe('2026-03-29');
    expect(dayKeyFor(new Date('2026-03-29T23:30:00Z'), 'Europe/London')).toBe('2026-03-30');
    // Fall back 2026-10-25 01:00Z; 00:30 BST on 25th = 23:30Z on 24th
    expect(dayKeyFor(new Date('2026-10-24T23:30:00Z'), 'Europe/London')).toBe('2026-10-25');
    expect(dayKeyFor(new Date('2026-10-25T23:30:00Z'), 'Europe/London')).toBe('2026-10-25');
  });

  it('handles DST in America/New_York', () => {
    // Spring forward 2026-03-08 07:00Z. 23:59 EDT on 8th = 03:59Z on 9th
    expect(dayKeyFor(new Date('2026-03-09T03:59:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(dayKeyFor(new Date('2026-03-09T04:00:00Z'), 'America/New_York')).toBe('2026-03-09');
    // Fall back 2026-11-01 06:00Z. 23:59 EST on 1st = 04:59Z on 2nd
    expect(dayKeyFor(new Date('2026-11-02T04:59:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(dayKeyFor(new Date('2026-11-02T05:00:00Z'), 'America/New_York')).toBe('2026-11-02');
  });

  it('rejects unknown timezones', () => {
    expect(() => dayKeyFor(new Date(), 'Mars/Olympus')).toThrow(DomainError);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('does calendar arithmetic across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-03-28', '2026-03-30')).toBe(2);
    expect(diffDays('2026-03-30', '2026-03-28')).toBe(-2);
    expect(dayRange('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(dayRange('2026-01-02', '2026-01-01')).toEqual([]);
    expect(() => addDays('2026-02-30', 1)).toThrow(DomainError);
    expect(isValidDayKey('2028-02-29')).toBe(true);
    expect(isValidDayKey('2027-02-29')).toBe(false);
  });

  it('computes Monday week start', () => {
    expect(isoWeekday('2026-11-02')).toBe(1); // Monday
    expect(isoWeekday('2026-11-08')).toBe(7); // Sunday
    expect(startOfWeek('2026-11-08')).toBe('2026-11-02');
    expect(startOfWeek('2026-11-02')).toBe('2026-11-02');
    expect(startOfWeek('2027-01-01')).toBe('2026-12-28');
  });

  describe('resolveEntryDay', () => {
    const now = new Date('2026-11-02T14:50:00Z');

    it('defaults to the day of loggedAt in the entry timezone', () => {
      expect(resolveEntryDay({ loggedAt: now, timeZone: 'Asia/Tokyo', now })).toEqual({
        date: '2026-11-02',
        timezone: 'Asia/Tokyo',
      });
      expect(
        resolveEntryDay({ loggedAt: new Date('2026-11-02T15:10:00Z'), timeZone: 'Asia/Tokyo', now: new Date('2026-11-02T15:10:00Z') }).date,
      ).toBe('2026-11-03');
    });

    it('accepts an explicit past date', () => {
      expect(resolveEntryDay({ loggedAt: now, timeZone: 'Europe/London', date: '2026-11-01', now }).date).toBe(
        '2026-11-01',
      );
    });

    it('rejects a future date for the device timezone', () => {
      expect(() =>
        resolveEntryDay({ loggedAt: now, timeZone: 'Europe/London', date: '2026-11-03', now }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_DAY_KEY' }));
      // but in Tokyo it is already late on the 2nd, the 3rd is still future
      expect(() => resolveEntryDay({ loggedAt: now, timeZone: 'Asia/Tokyo', date: '2026-11-03', now })).toThrow(
        DomainError,
      );
    });

    it('rejects invalid and too-old dates and unknown zones', () => {
      expect(() => resolveEntryDay({ loggedAt: now, timeZone: 'Europe/London', date: '2026-13-01', now })).toThrow(
        expect.objectContaining({ code: 'INVALID_DAY_KEY' }),
      );
      expect(() =>
        resolveEntryDay({ loggedAt: now, timeZone: 'Europe/London', date: '2026-10-01', now, maxPastDays: 7 }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_DAY_KEY' }));
      expect(() => resolveEntryDay({ loggedAt: now, timeZone: 'Nowhere/Zone', now })).toThrow(
        expect.objectContaining({ code: 'INVALID_TIMEZONE' }),
      );
    });
  });
});
