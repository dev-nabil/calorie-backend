/**
 * BR-07: every meal, water entry and weigh-in stores the IANA timezone the device reported
 * and its day key (YYYY-MM-DD) in that timezone. Changing the profile timezone never moves
 * past entries. Pure functions over Intl; no dependencies.
 */
import { isValidDayKey, isValidTimeZone } from '../../shared';
import { DomainError } from '../errors';

export { isValidDayKey, isValidTimeZone };

const MS_PER_DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Day key of `instant` in `timeZone`. Throws INVALID_TIMEZONE for unknown zones. */
export function dayKeyFor(instant: Date, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) {
    throw new DomainError('INVALID_TIMEZONE', `Unknown timezone ${timeZone}`, { timeZone });
  }
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function toUtcMs(dayKey: string): number {
  if (!isValidDayKey(dayKey)) {
    throw new DomainError('INVALID_DAY_KEY', `Invalid day key ${dayKey}`, { date: dayKey });
  }
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar arithmetic on day keys (no timezone involved). */
export function addDays(dayKey: string, n: number): string {
  return fromUtcMs(toUtcMs(dayKey) + n * MS_PER_DAY);
}

/** Whole days from `from` to `to` (to minus from). */
export function diffDays(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

/** Inclusive list of day keys; empty when `to` is before `from`. */
export function dayRange(from: string, to: string): string[] {
  const n = diffDays(from, to);
  const out: string[] = [];
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

/** ISO weekday 1 (Monday) … 7 (Sunday). */
export function isoWeekday(dayKey: string): number {
  const dow = new Date(toUtcMs(dayKey)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Monday of the week containing `dayKey`. */
export function startOfWeek(dayKey: string): string {
  return addDays(dayKey, 1 - isoWeekday(dayKey));
}

export interface ResolveEntryDayInput {
  loggedAt: Date;
  timeZone: string;
  date?: string;
  now: Date;
  maxPastDays?: number;
}

/**
 * Day an entry belongs to (BR-07). With no explicit date it is the day of `loggedAt` in the
 * entry's timezone. An explicit date (adding to a past diary day) must not be after the
 * device's current date and not older than `maxPastDays`.
 */
export function resolveEntryDay(input: ResolveEntryDayInput): { date: string; timezone: string } {
  const { loggedAt, timeZone, date, now } = input;
  const maxPastDays = input.maxPastDays ?? 3650;
  const today = dayKeyFor(now, timeZone);
  const resolved = date ?? dayKeyFor(loggedAt, timeZone);
  if (!isValidDayKey(resolved)) {
    throw new DomainError('INVALID_DAY_KEY', `Invalid day key ${resolved}`, { date: resolved });
  }
  if (diffDays(today, resolved) > 0) {
    throw new DomainError('INVALID_DAY_KEY', 'Date is in the future for this timezone', {
      date: resolved,
      today,
    });
  }
  if (diffDays(resolved, today) > maxPastDays) {
    throw new DomainError('INVALID_DAY_KEY', 'Date is too far in the past', {
      date: resolved,
      maxPastDays,
    });
  }
  return { date: resolved, timezone: timeZone };
}
