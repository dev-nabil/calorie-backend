/**
 * Reminder scheduling (M9-T1). Pure. Times are local wall-clock times in the reminder's timezone;
 * `nextFireAtUtc` is precomputed so the minute job is one indexed query (S-11).
 * DST: a time that does not exist (spring forward) fires at the same offset after the gap
 * (01:30 → 02:30); a repeated time (fall back) fires at its first occurrence.
 */
import { addDays, dayKeyFor, isoWeekday } from '../day-keys';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface ReminderRule {
  time: string; // HH:mm: the only ring of the day, or the first one when it repeats
  days: Weekday[]; // empty = every day
  timezone: string;
  /** Rings again every this many hours after `time`, up to `endTime`. Null/missing = once a day. */
  everyHours?: number | null;
  /** HH:mm, same day and later than `time`: no ring after it. Only read with `everyHours`. */
  endTime?: string | null;
}

/**
 * At most this many enabled reminders on one weekday. A reminder that repeats every few hours
 * counts once: the user asked for each of its rings when they picked the interval.
 */
export const MAX_PER_DAY = 3;
export const MIN_EVERY_HOURS = 1;
export const MAX_EVERY_HOURS = 12;

export function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The local times one reminder rings on a selected day: `time`, then every `everyHours` up to `endTime`. */
export function ringTimes(rule: Pick<ReminderRule, 'time' | 'everyHours' | 'endTime'>): string[] {
  if (!rule.everyHours || !rule.endTime) return [rule.time];
  const out: string[] = [];
  for (let m = minutes(rule.time); m <= minutes(rule.endTime); m += rule.everyHours * 60) out.push(hhmm(m));
  return out.length ? out : [rule.time];
}

/** UTC offset (ms) of a zone at an instant. */
export function offsetMs(timeZone: string, at: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
  const v = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(at / 1000) * 1000;
}

function localTime(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

/** The instant of a local date and time in a zone (see DST rules above). */
export function localToUtc(dayKey: string, time: string, timeZone: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const want = Date.UTC(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
  const candidates = [...new Set([want - offsetMs(timeZone, want - 86_400_000), want - offsetMs(timeZone, want + 86_400_000)])].sort((a, b) => a - b);
  const exact = candidates.find((c) => dayKeyFor(new Date(c), timeZone) === dayKey && localTime(c, timeZone) === time);
  return new Date(exact ?? Math.max(...candidates));
}

/** Next fire time strictly after `after`, or null when no day is selected. */
export function nextFireAt(rule: ReminderRule, after: Date): Date | null {
  const today = dayKeyFor(after, rule.timezone);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(today, i);
    const weekday = WEEKDAYS[isoWeekday(day) - 1]!;
    if (rule.days.length && !rule.days.includes(weekday)) continue;
    for (const time of ringTimes(rule)) {
      const at = localToUtc(day, time, rule.timezone);
      if (at.getTime() > after.getTime()) return at;
    }
  }
  return null;
}

/**
 * M9-T1 limit: at most 3 enabled reminders on any weekday. The user may pick any time of day (no quiet hours).
 * A repeating reminder needs a valid interval and an end time later the same day.
 */
export function validateReminders(
  rules: { time: string; days: Weekday[]; enabled: boolean; everyHours?: number | null; endTime?: string | null }[],
): { ok: true } | { ok: false; reason: string; details: Record<string, unknown> } {
  for (const r of rules) {
    if (!isValidTime(r.time)) return { ok: false, reason: 'time', details: { time: r.time } };
    if (r.everyHours == null) continue;
    if (!Number.isInteger(r.everyHours) || r.everyHours < MIN_EVERY_HOURS || r.everyHours > MAX_EVERY_HOURS) {
      return { ok: false, reason: 'every_hours', details: { everyHours: r.everyHours, min: MIN_EVERY_HOURS, max: MAX_EVERY_HOURS } };
    }
    if (!r.endTime || !isValidTime(r.endTime) || minutes(r.endTime) <= minutes(r.time)) {
      return { ok: false, reason: 'end_time', details: { time: r.time, endTime: r.endTime ?? null } };
    }
  }
  for (const day of WEEKDAYS) {
    const n = rules.filter((r) => r.enabled && (r.days.length === 0 || r.days.includes(day))).length;
    if (n > MAX_PER_DAY) return { ok: false, reason: 'max_per_day', details: { day, count: n, max: MAX_PER_DAY } };
  }
  return { ok: true };
}
