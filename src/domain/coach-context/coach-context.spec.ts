import type { DayResponse, ProgressResponse } from '../../shared';
import { DEFAULT_UNITS } from '../../shared/units';
import { buildCoachContext, formatHeight, formatWeight, type CoachContextInput } from './index';

const day = (over: Partial<DayResponse> = {}): DayResponse =>
  ({
    date: '2026-11-05',
    targets: { energyKcal: 2000, proteinG: 130, carbsG: 220, fatG: 60, waterMl: 2500 },
    totals: { kcal: 1360.4, proteinG: 70, carbsG: 150, fatG: 40 },
    meals: [
      { category: 'breakfast', name: 'Eggs on toast', totals: { kcal: 420.2 } },
      { category: 'lunch', name: 'Rice and dal', totals: { kcal: null } },
    ],
    water: { totalMl: 1000, targetMl: 2500, stepMl: 250, entries: [] },
    streak: { current: 4 },
    ...over,
  }) as unknown as DayResponse;

const week = (): ProgressResponse =>
  ({
    loggedDays: 5,
    averageKcal: 1900,
    days: [
      { date: '2026-11-04', kcal: 1800, logged: true, waterMl: 0 },
      { date: '2026-11-03', kcal: 0, logged: false, waterMl: 0 },
    ],
    weights: [
      { date: '2026-10-30', weightKg: 83.4, isEstimate: false },
      { date: '2026-11-04', weightKg: 82.6, isEstimate: false },
    ],
    goal: { startWeightKg: 84, currentWeightKg: 82.6, targetWeightKg: 76 },
  }) as unknown as ProgressResponse;

const profile = {
  primaryGoal: 'lose',
  supportingGoals: ['energy'],
  personalMotivation: 'wedding in spring',
  ageYears: 34,
  calculationSex: 'female' as const,
  heightCm: 165,
  weightKg: 82.6,
  weightIsEstimate: false,
  targetWeightKg: 74,
  activityLevel: 'light' as const,
  lifeStage: 'none',
  dietPattern: 'vegetarian',
  allergies: ['peanut', 'other'],
  allergyOther: 'sesame',
  mealsPerDay: '3',
  routineBarriers: ['time'],
  nutritionFamiliarity: 'learning',
  startingMood: 'low',
  habitPriorities: ['protein'],
  timeframeWeeks: 24,
};

const input = (over: Partial<CoachContextInput> = {}): CoachContextInput => ({
  name: 'Amina',
  mode: 'full',
  units: DEFAULT_UNITS,
  profile,
  day: day(),
  week: week(),
  ...over,
});

/** The context is plain JSON for the prompt; the tests read it loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe('buildCoachContext', () => {
  it('carries the goal-setup answers, targets with the floor, today and the week in full mode', () => {
    const c = buildCoachContext(input()) as Json;
    expect(c.name).toBe('Amina');
    expect(c.mode).toBe('full');
    expect(c.goal).toEqual({ main: 'lose', alsoWants: ['energy'], inTheirWords: 'wedding in spring', timeframeWeeks: 24 });
    expect(c.about).toMatchObject({ ageYears: 34, sex: 'female', height: '165 cm', weight: '82.6 kg', targetWeight: '74 kg', activityLevel: 'light' });
    expect(c.dailyTargets).toMatchObject({ targetKcal: 2000, proteinG: 130, floorKcal: expect.any(Number), maintenanceKcal: expect.any(Number) });
    expect(c.dailyTargets.floorKcal).toBeGreaterThanOrEqual(1200);
    expect(c.preferences).toMatchObject({ dietPattern: 'vegetarian', mealsPerDay: '3', routineBarriers: ['time'], nutritionFamiliarity: 'learning', startingMood: 'low', habitPriorities: ['protein'] });
    expect(c.today).toMatchObject({ kcalLeft: 640, waterMl: 1000, streakDays: 4 });
    expect(c.today.meals).toEqual([
      { category: 'breakfast', name: 'Eggs on toast', kcal: 420 },
      { category: 'lunch', name: 'Rice and dal' }, // an unknown nutrient stays absent, never zero
    ]);
    expect(c.last7Days).toMatchObject({ loggedDays: 5, averageKcal: 1900, weightChange: '83.4 kg on 2026-10-30 to 82.6 kg on 2026-11-04' });
  });

  it('lists the allergies the person gave, with their own words for "other"', () => {
    expect((buildCoachContext(input()) as Json).preferences.allergies).toEqual(['peanut', 'sesame']);
  });

  it('leaves allergies out when they were never asked, so "unknown" is not read as "none"', () => {
    const c = buildCoachContext(input({ profile: { ...profile, allergies: null } })) as Json;
    expect(c.preferences).not.toHaveProperty('allergies');
  });

  it('gives a habits-only person no body data, no targets, no calories and no weight goal', () => {
    const c = buildCoachContext(input({ mode: 'habits_only', day: day({ targets: { energyKcal: null, proteinG: null, carbsG: null, fatG: null, waterMl: 2500 } }) })) as Json;
    expect(c.mode).toBe('habits_only');
    expect(c.about).toBeUndefined();
    expect(c.dailyTargets).toBeUndefined();
    expect(c.goal.main).toBeUndefined(); // a "lose" goal is not repeated
    expect(c.goal.timeframeWeeks).toBeUndefined();
    expect(JSON.stringify(c)).not.toMatch(/kcal|82\.6|kg|"totals"/i);
    expect(c.last7Days).toEqual({ loggedDays: 5, daysInRange: 2 });
  });

  it('treats a plan without an energy target as habits-only even when the profile says full', () => {
    const c = buildCoachContext(input({ day: day({ targets: { energyKcal: null, proteinG: null, carbsG: null, fatG: null, waterMl: 2500 } }) })) as Json;
    expect(c.mode).toBe('habits_only');
    expect(c.about).toBeUndefined();
  });

  it('keeps a habits goal for a habits-only person', () => {
    const c = buildCoachContext(input({ mode: 'habits_only', profile: { ...profile, primaryGoal: 'habits' } })) as Json;
    expect(c.goal.main).toBe('habits');
  });

  it('shows measurements in the person’s units', () => {
    const units = { ...DEFAULT_UNITS, weight: 'lb' as const, height: 'ft_in' as const };
    const c = buildCoachContext(input({ units })) as Json;
    expect(c.about).toMatchObject({ height: '5 ft 5 in', weight: '182 lb', targetWeight: '163 lb' });
    expect(formatWeight(70, DEFAULT_UNITS)).toBe('70 kg');
    expect(formatHeight(180, units)).toBe('5 ft 11 in');
  });

  it('survives a missing profile and a missing week', () => {
    const c = buildCoachContext(input({ profile: null, week: null, mode: 'habits_only' })) as Json;
    expect(c.name).toBe('Amina');
    expect(c.last7Days).toBeUndefined();
  });
});
