/**
 * Today nudge card (plan section 11, R-09). Items, windows and conditions come from
 * content/milo/lines.v1.json `nudges`; the first item in priority order whose conditions all hold
 * wins. Copy variants (subHabits, subNoPhoto, subIfBusy) are chosen by the app.
 */
import type { MealCategory } from '../../shared';

export interface NudgeItem {
  id: string;
  priority: number;
  when: {
    window?: string[];
    logged?: Partial<Record<MealCategory | 'any', boolean>>;
    mode?: 'full' | 'habits_only';
    overTarget?: boolean;
    pendingScan?: boolean;
    savedPhoto?: boolean;
  };
}

export interface NudgeContent {
  timeWindows: Record<string, string>;
  items: NudgeItem[];
}

export interface NudgeFacts {
  /** Device-local minutes since midnight. */
  localMinutes: number;
  logged: Record<MealCategory, boolean>;
  mode: 'full' | 'habits_only';
  overTarget: boolean;
  pendingScan: boolean;
  savedPhoto: boolean;
}

const CATEGORY_IN_ID: Array<[RegExp, MealCategory]> = [
  [/breakfast/i, 'breakfast'],
  [/lunch/i, 'lunch'],
  [/dinner/i, 'dinner'],
  [/snack/i, 'snack'],
];

/** Parses "05:00–10:59" (en dash or hyphen); ranges may wrap past midnight ("22:00–04:59"). */
export function parseWindow(range: string): { start: number; end: number } | null {
  const m = /^(\d{2}):(\d{2})\s*[–-]\s*(\d{2}):(\d{2})$/.exec(range.trim());
  if (!m) return null;
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}

export function inWindow(minutes: number, range: string): boolean {
  const w = parseWindow(range);
  if (!w) return false;
  return w.start <= w.end ? minutes >= w.start && minutes <= w.end : minutes >= w.start || minutes <= w.end;
}

export function matches(item: NudgeItem, facts: NudgeFacts, windows: Record<string, string>): boolean {
  const w = item.when;
  if (w.window && !w.window.some((name) => windows[name] !== undefined && inWindow(facts.localMinutes, windows[name]!))) return false;
  if (w.mode !== undefined && w.mode !== facts.mode) return false;
  if (w.overTarget !== undefined && w.overTarget !== facts.overTarget) return false;
  if (w.pendingScan !== undefined && w.pendingScan !== facts.pendingScan) return false;
  if (w.savedPhoto !== undefined && w.savedPhoto !== facts.savedPhoto) return false;
  for (const [cat, want] of Object.entries(w.logged ?? {})) {
    const has = cat === 'any' ? Object.values(facts.logged).some(Boolean) : facts.logged[cat as MealCategory];
    if (Boolean(has) !== want) return false;
  }
  return true;
}

export function chooseNudge(content: NudgeContent, facts: NudgeFacts): { id: string; category: MealCategory | null } | null {
  const item = [...content.items].sort((a, b) => a.priority - b.priority).find((i) => matches(i, facts, content.timeWindows));
  if (!item) return null;
  const category = CATEGORY_IN_ID.find(([re]) => re.test(item.id))?.[1] ?? null;
  return { id: item.id, category };
}

/** Minutes since local midnight for an instant in an IANA zone. */
export function localMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}
