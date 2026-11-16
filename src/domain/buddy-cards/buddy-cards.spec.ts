import type { DayResponse, InterpretOutput } from '../../shared';
import { avoidTermsFor } from '../plan-narrative';
import { actionIdFor, comparisonCard, containsHealthKeys, daySummaryCard, defaultCategory, stripHealth, suggestionsCard, weeklyReviewCard } from './index';

const day = (over: Partial<DayResponse> = {}): DayResponse =>
  ({
    date: '2026-11-16',
    targets: { energyKcal: 2000, proteinG: 110, carbsG: 220, fatG: 60, waterMl: 2000 },
    totals: { kcal: 1400, proteinG: 70, carbsG: 150, fatG: 45 },
    remaining: { kcal: 600, proteinG: 40, carbsG: 70, fatG: 15, waterMl: 1000 },
    meals: [{}, {}],
    categories: [
      { category: 'breakfast', totals: { kcal: 500, proteinG: 20, carbsG: 60, fatG: 15 }, mealCount: 1 },
      { category: 'lunch', totals: { kcal: 900, proteinG: 50, carbsG: 90, fatG: 30 }, mealCount: 1 },
    ],
    water: { totalMl: 1000, targetMl: 2000 },
    streak: { current: 3, longest: 3 },
    nudge: null,
    ...over,
  }) as unknown as DayResponse;

describe('buddy cards (Milo buddy)', () => {
  it('day summary: activity adjustment the app already applied is shown once, never added again; missing slots have no kcal', () => {
    const live = daySummaryCard(day(), { today: '2026-11-16', habitsOnly: false, budget: { addActivity: true, activityAdjustmentKcal: 600, activeKcal: 917 } });
    expect(live).toMatchObject({ baseKcal: 2000, budget: { activityAdjustmentKcal: 600, goalKcal: 2600 }, budgetBasis: 'adjusted', remaining: { kcal: 1200 } });
    expect(live.slots).toEqual([
      { category: 'breakfast', mealCount: 1, kcal: 500 },
      { category: 'lunch', mealCount: 1, kcal: 900 },
      { category: 'dinner', mealCount: 0, kcal: null },
      { category: 'snack', mealCount: 0, kcal: null },
    ]);
    // Toggle off, another day, or habits-only: the base goal only.
    expect(daySummaryCard(day(), { today: '2026-11-16', habitsOnly: false, budget: { addActivity: false, activityAdjustmentKcal: 0, activeKcal: 917 } })).toMatchObject({ budget: null, remaining: { kcal: 600 } });
    expect(daySummaryCard(day(), { today: '2026-11-17', habitsOnly: false, budget: { addActivity: true, activityAdjustmentKcal: 600, activeKcal: 917 } }).budget).toBeNull();
    expect(daySummaryCard(day(), { today: '2026-11-16', habitsOnly: true, budget: null })).toMatchObject({ mode: 'habits_only', baseKcal: null, remaining: null, logged: { kcal: null } });
    // Stored copy: no health numbers, remaining back on the base goal.
    const [stored] = stripHealth([live]);
    expect(stored).toMatchObject({ budget: null, budgetBasis: 'base', remaining: { kcal: 600 } });
    expect(containsHealthKeys(stored)).toBe(false);
    expect(containsHealthKeys([live])).toBe(true);
    expect(containsHealthKeys({ a: [{ activeKcal: 1 }] })).toBe(true);
  });

  it('suggestions never include a declared allergen and compute values from per-100 g', () => {
    const raw: InterpretOutput['suggestions'] = [
      { name: 'Peanut chicken salad', en: 'peanut chicken salad', why: 'protein', g: 300, n: { kcal: 150, p: 12, c: 8, f: 8, fib: 2, sug: 3, na: 200 }, minutes: 15, uses: ['chicken'], extra: ['peanuts'] },
      { name: 'Egg bhurji with roti', en: 'scrambled eggs with roti', why: 'quick protein', g: 250, n: { kcal: 180, p: 10, c: 15, f: 9, fib: 2, sug: 1, na: 300 }, minutes: 10, uses: ['eggs'], extra: [] },
      { name: 'Dal and rice', en: 'lentils and rice', why: 'fits what is left', g: 350, n: { kcal: 130, p: 5, c: 24, f: 1.5, fib: 3, sug: 1, na: 150 }, minutes: 25, uses: [], extra: [] },
    ];
    const r = suggestionsCard(raw, { habitsOnly: false, avoidTerms: avoidTermsFor(['peanuts'], null, null, 'en'), locale: 'en', basis: 'remaining' });
    expect(r.dropped).toBe(1);
    expect(r.card!.options.map((o) => o.name)).toEqual(['Egg bhurji with roti', 'Dal and rice']);
    expect(r.card!.options[0]).toMatchObject({ grams: 250, kcal: 450, proteinG: 25 });
    expect(suggestionsCard(raw.slice(1, 2), { habitsOnly: true, avoidTerms: [], locale: 'en', basis: 'general' }).card!.options[0]!.kcal).toBeNull();
    expect(suggestionsCard([], { habitsOnly: false, avoidTerms: [], locale: 'en', basis: 'general' }).card).toBeNull();
  });

  it('comparisons need two foods; weekly review marks missing days and only shows a weight trend with enough data', () => {
    const cmp = comparisonCard([
      { name: 'Rice', en: 'cooked white rice', g: null, n: { kcal: 130, p: 2.7, c: 28, f: 0.3, fib: 0.4, sug: 0, na: 1 } },
      { name: 'Roti', en: 'roti', g: null, n: { kcal: 297, p: 9.6, c: 46, f: 7.5, fib: 4.9, sug: 1, na: 400 } },
    ]);
    expect(cmp).toMatchObject({ per: '100g', items: [{ name: 'Rice', grams: 100, kcal: 130 }, { name: 'Roti', kcal: 297 }] });
    expect(comparisonCard([{ name: 'Rice', en: 'rice', g: 100, n: null }])).toBeNull();
    const stats = { loggedDays: 3, daysInRange: 7, meals: 8, averageKcal: 1800, waterAvgMl: 1500, waterTargetMl: 2000, waterGoalDays: 1, proteinGoalDays: 2, streak: 2, favouriteFood: null };
    const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'].map((date, i) => ({ date, logged: i % 2 === 0 }));
    const w = weeklyReviewCard({ range: 'last', weekStart: '2026-11-09', weekEnd: '2026-11-15', habitsOnly: false, stats, days, weights: [{ date: '2026-11-09', weightKg: 80.2 }, { date: '2026-11-14', weightKg: 79.6 }] });
    expect(w).toMatchObject({ missingDays: ['2026-11-10', '2026-11-12', '2026-11-14'], limitedData: true, weight: { entries: 2, changeKg: -0.6, enough: true } });
    const thin = weeklyReviewCard({ range: 'last', weekStart: '2026-11-09', weekEnd: '2026-11-15', habitsOnly: false, stats, days, weights: [{ date: '2026-11-14', weightKg: 79.6 }] });
    expect(thin.weight).toMatchObject({ enough: false, changeKg: null });
    expect(weeklyReviewCard({ range: 'this', weekStart: '2026-11-16', weekEnd: '2026-11-16', habitsOnly: true, stats, days: [], weights: [] }).weight).toBeNull();
  });

  it('ids are deterministic; default meal slots follow the local hour', () => {
    expect(actionIdFor('c', 'log_meal', 'd1', 2, 0)).toBe(actionIdFor('c', 'log_meal', 'd1', 2, 0));
    expect(actionIdFor('c', 'log_meal', 'd1', 2, 0)).not.toBe(actionIdFor('c', 'log_meal', 'd1', 3, 0));
    expect(actionIdFor('c')).toMatch(/^a_[a-f0-9]{24}$/);
    expect([7, 13, 19, 23, 2].map(defaultCategory)).toEqual(['breakfast', 'lunch', 'dinner', 'snack', 'snack']);
  });
});
