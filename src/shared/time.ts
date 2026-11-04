/** Calendar helpers that are safe in browsers and Node (no dependencies). */
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `value` is a real calendar date in YYYY-MM-DD form. */
export function isValidDayKey(value: string): boolean {
  const m = DAY_KEY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const tzCache = new Map<string, boolean>();
/** True when `tz` is an IANA zone known to the runtime's Intl database. */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  const cached = tzCache.get(tz);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  tzCache.set(tz, ok);
  return ok;
}
