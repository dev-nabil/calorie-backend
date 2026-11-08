/**
 * Weekly recap (Plus): which week, the numbers of that week from the person's day logs, and the checks on the story cards
 * the model writes from those numbers. Pure: the service loads the documents.
 *
 * Rules: a habits-only person (mode habits_only, or no energy target) gets no calorie numbers at all; every number on a
 * card must be one of the stats, copied, never derived; no card judges a food, a day or the person; no card suggests a food
 * the person avoids. A card that breaks a rule is dropped; fewer than RECAP_MIN_CARDS good cards means no AI cards.
 */
import {
  RECAP_MAX_CARDS,
  RECAP_MIN_CARDS,
  RECAP_TEXT_MAX,
  RECAP_TITLE_MAX,
  type RecapCard,
  type RecapMiloState,
  type RecapRange,
  type RecapStats,
  type RecapTopic,
} from '../../shared';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { addDays, diffDays, startOfWeek } from '../day-keys';
import { charLength, cleanLine, copyProblems, fitSentences, withoutOwnWords } from '../copy-rules';
import { normaliseDigits } from '../plan-narrative/locales';

export type RecapMode = 'full' | 'habits_only';

export interface RecapWeek {
  weekStart: string;
  weekEnd: string;
  daysInRange: number;
}

/** `last`: the previous Monday to Sunday. `this`: Monday of the current week through today. `today` is the user's day key. */
export function recapWeek(range: RecapRange, today: string): RecapWeek {
  const monday = startOfWeek(today);
  const weekStart = range === 'last' ? addDays(monday, -7) : monday;
  const weekEnd = range === 'last' ? addDays(weekStart, 6) : today;
  return { weekStart, weekEnd, daysInRange: diffDays(weekStart, weekEnd) + 1 };
}

/** One day of `daily_logs`. */
export interface RecapDayLog {
  date: string;
  logged: boolean;
  mealsCount: number;
  kcal: number;
  proteinG: number;
  waterMl: number;
}

/** The item names of one meal (not deleted), in logging order. */
export interface RecapMealItems {
  date: string;
  items: ReadonlyArray<{ name: string; excluded?: boolean | null }>;
}

export interface RecapStatsInput {
  week: RecapWeek;
  mode: RecapMode;
  logs: readonly RecapDayLog[];
  meals: readonly RecapMealItems[];
  /** The active plan's targets: protein (full mode only) and water. */
  targets: { proteinG: number | null; waterMl: number | null };
  /** Current logging streak (Today's number). */
  streak: number;
}

const FAVOURITE_MIN_MEALS = 2;
const FAVOURITE_NAME_MAX = 80;

/** The food in the most meals of the week (each meal counts a food once); ties go to the one logged first. */
export function favouriteFood(meals: readonly RecapMealItems[]): { name: string; count: number } | null {
  const counts = new Map<string, { name: string; count: number; first: number }>();
  let order = 0;
  for (const meal of meals) {
    const seen = new Set<string>();
    for (const item of meal.items) {
      if (item.excluded) continue;
      const name = cleanLine(item.name);
      if (!name || charLength(name) > FAVOURITE_NAME_MAX) continue;
      const key = name.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { name, count: 0, first: order++ };
      entry.count++;
      counts.set(key, entry);
    }
  }
  let best: { name: string; count: number; first: number } | null = null;
  for (const c of counts.values()) if (!best || c.count > best.count || (c.count === best.count && c.first < best.first)) best = c;
  return best && best.count >= FAVOURITE_MIN_MEALS ? { name: best.name, count: best.count } : null;
}

const inWeek = (date: string, w: RecapWeek): boolean => date >= w.weekStart && date <= w.weekEnd;
const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** The recap numbers. Deterministic: the cards may only repeat these. */
export function buildRecapStats(i: RecapStatsInput): RecapStats {
  const byDate = new Map<string, RecapDayLog>();
  for (const l of i.logs) if (inWeek(l.date, i.week)) byDate.set(l.date, l);
  const days = [...byDate.values()];
  const logged = days.filter((d) => d.logged);
  const full = i.mode === 'full';
  const waterDays = days.filter((d) => d.waterMl > 0);
  const waterTarget = positive(i.targets.waterMl) ? Math.round(i.targets.waterMl) : null;
  const proteinTarget = full && positive(i.targets.proteinG) ? i.targets.proteinG : null;
  return {
    loggedDays: logged.length,
    daysInRange: i.week.daysInRange,
    meals: logged.reduce((s, d) => s + Math.max(0, Math.round(d.mealsCount)), 0),
    averageKcal: full && logged.length ? Math.round(logged.reduce((s, d) => s + d.kcal, 0) / logged.length) : null,
    waterAvgMl: waterDays.length ? Math.round(waterDays.reduce((s, d) => s + d.waterMl, 0) / waterDays.length / 10) * 10 : 0,
    waterTargetMl: waterTarget,
    waterGoalDays: waterTarget === null ? 0 : days.filter((d) => d.waterMl >= waterTarget).length,
    proteinGoalDays: proteinTarget === null ? null : logged.filter((d) => d.proteinG >= proteinTarget).length,
    streak: Math.max(0, Math.round(i.streak)),
    favouriteFood: favouriteFood(i.meals.filter((m) => inWeek(m.date, i.week))),
  };
}

// ── Card checks ──────────────────────────────────────────────────────────────────────────────────

/** Every number a card may state: the stats themselves. */
export function allowedNumbers(stats: RecapStats): Set<number> {
  const values = [
    stats.loggedDays,
    stats.daysInRange,
    stats.meals,
    stats.averageKcal,
    stats.waterAvgMl,
    stats.waterTargetMl,
    stats.waterGoalDays,
    stats.proteinGoalDays,
    stats.streak,
    stats.favouriteFood?.count,
  ];
  return new Set(values.filter((v): v is number => typeof v === 'number'));
}

/** Numbers written with digits (any script), thousands separators removed: "1,850 ml" gives 1850, "1.8 L" gives 1.8. */
export function numbersIn(text: string): number[] {
  const t = normaliseDigits(text);
  return (t.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
}

export interface RecapCardDraft {
  topic: RecapTopic;
  title: string;
  text: string;
  miloState: RecapMiloState;
}

export interface RecapCardOptions {
  mode: RecapMode;
  locale?: LocaleCode;
  /** Terms the person avoids (allergens, eating pattern): never suggested. */
  avoidTerms?: readonly string[];
}

export interface RecapCardCheck {
  /** Empty when fewer than RECAP_MIN_CARDS cards passed: the app then builds its own from the stats. */
  cards: RecapCard[];
  /** Why each dropped card was dropped (logged, never shown). */
  rejected: string[];
}

const CALORIE_TOPICS: ReadonlySet<RecapTopic> = new Set(['energy', 'protein']);

/** A card may only be about something the stats know; otherwise its facts would be made up. */
export function topicHasData(topic: RecapTopic, s: RecapStats): boolean {
  switch (topic) {
    case 'logging':
      return s.loggedDays > 0;
    case 'meals':
      return s.meals > 0;
    case 'energy':
      return s.averageKcal !== null;
    case 'protein':
      return s.proteinGoalDays !== null;
    case 'water':
      return s.waterAvgMl > 0;
    case 'streak':
      return s.streak > 0;
    case 'favourite':
      return s.favouriteFood !== null;
    case 'next_week':
      return true;
  }
}

/** Why a card may not be shown, or null. `text` is the card text already fitted to the length limit. */
function cardProblem(d: RecapCardDraft, title: string, text: string, stats: RecapStats, own: string[], o: RecapCardOptions): string | null {
  if (o.mode === 'habits_only' && CALORIE_TOPICS.has(d.topic)) return 'calorie or protein topic for a habits-only person';
  if (!topicHasData(d.topic, stats)) return 'topic with no data in the stats';
  const allowed = allowedNumbers(stats);
  const unknown = numbersIn(withoutOwnWords(`${title} ${text}`, own)).filter((n) => !allowed.has(n));
  if (unknown.length) return `numbers not in the stats (${unknown.join(', ')})`;
  const problems = copyProblems(`${title}\n${text}`, { locale: o.locale ?? DEFAULT_LOCALE, habitsOnly: o.mode === 'habits_only', avoidTerms: o.avoidTerms, own, strict: true });
  return problems.length ? problems.join(', ') : null;
}

/** Drops every card that breaks a rule, trims a text that runs long to whole sentences, and puts the one idea card last. */
export function checkRecapCards(drafts: readonly RecapCardDraft[], stats: RecapStats, o: RecapCardOptions): RecapCardCheck {
  const own = stats.favouriteFood ? [stats.favouriteFood.name] : [];
  const rejected: string[] = [];
  const kept: RecapCardDraft[] = [];
  for (const [index, d] of drafts.entries()) {
    const label = `card ${index + 1} (${d.topic})`;
    const title = cleanLine(d.title);
    const text = cleanLine(d.text);
    const fitted = text ? fitSentences(text, RECAP_TEXT_MAX) : null;
    const problem = !title || !text
      ? 'empty'
      : charLength(title) > RECAP_TITLE_MAX
        ? `title longer than ${RECAP_TITLE_MAX} characters`
        : !fitted
          ? `text longer than ${RECAP_TEXT_MAX} characters`
          : d.topic === 'next_week' && kept.some((k) => k.topic === 'next_week')
            ? 'a second idea card'
            : cardProblem(d, title, fitted, stats, own, o);
    if (problem) rejected.push(`${label}: ${problem}`);
    else kept.push({ ...d, title, text: fitted! });
  }
  const idea = kept.find((k) => k.topic === 'next_week');
  const others = kept.filter((k) => k.topic !== 'next_week');
  const capped = idea ? [...others.slice(0, RECAP_MAX_CARDS - 1), idea] : others.slice(0, RECAP_MAX_CARDS);
  if (capped.length < RECAP_MIN_CARDS) return { cards: [], rejected: [...rejected, `only ${capped.length} usable cards`] };
  const used = new Map<string, number>();
  const cards = capped.map((c) => {
    const n = (used.get(c.topic) ?? 0) + 1;
    used.set(c.topic, n);
    return { id: n === 1 ? c.topic : `${c.topic}-${n}`, title: c.title, text: c.text, miloState: c.miloState };
  });
  return { cards, rejected };
}
