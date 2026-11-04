/**
 * BR-08: a day counts towards the streak when at least one meal is logged. A missed day
 * resets the current streak but never erases history. Computed server-side from
 * daily_logs.logged.
 */
import type { Streak } from '../../shared';
import { addDays, diffDays, isValidDayKey, startOfWeek } from '../day-keys';

export type StreakResult = Streak;

/**
 * @param loggedDays day keys with at least one meal (any order, duplicates allowed)
 * @param today the device's current day key
 */
export function computeStreak(loggedDays: Iterable<string>, today: string): StreakResult {
  const days = new Set<string>();
  for (const d of loggedDays) {
    // ignore invalid keys and days after today
    if (isValidDayKey(d) && diffDays(d, today) >= 0) days.add(d);
  }
  const loggedToday = days.has(today);

  // Today is not missed until it ends: count back from yesterday when today is not logged yet.
  let current = 0;
  let cursor = loggedToday ? today : addDays(today, -1);
  while (days.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  const sorted = [...days].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev !== null && diffDays(prev, d) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }

  const monday = startOfWeek(today);
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    return { date, logged: days.has(date) };
  });
  const loggedThisWeek = week.filter((w) => w.logged).length;

  return { current, longest, loggedToday, week, loggedThisWeek };
}
