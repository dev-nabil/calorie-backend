import { assessPlan, buildBasis, estimateTimeframe, humanDuration, noticeFor, retimeFrame, type AssessInputs } from './index';
import { calculatePlan } from '../plan-calculator';

const OK = { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false, eatingDisorderConcern: false };
const adult = (over: Partial<AssessInputs> = {}): AssessInputs => ({
  ageYears: 34,
  calculationSex: 'female',
  heightCm: 168,
  weightKg: 82,
  activityLevel: 'light',
  goal: 'lose',
  targetWeightKg: 74,
  attestation: OK,
  allergies: ['none'],
  mealsPerDay: 'three',
  schedulePattern: 'fixed',
  mealSource: 'home',
  dietPattern: 'none',
  ...over,
});

describe('assessPlan', () => {
  it('ready when everything essential is present and the health check is clean', () => {
    const a = assessPlan(adult());
    expect(a.outcome).toBe('ready');
    expect(a.missing).toEqual([]);
    expect(a.issues).toEqual([]);
    expect(a.optionalUnanswered).toEqual([]);
    expect(a.requiredForTargets).toEqual(['q06', 'q07', 'q08', 'q09', 'q10']);
  });

  it('under 18 gets habits only, with no questions about numbers', () => {
    const a = assessPlan(adult({ ageYears: 16 }));
    expect(a).toMatchObject({ outcome: 'habits_only', missing: [], guidanceReasons: ['under_18'], canContinueWithoutTargets: true });
  });

  it('unknown age asks for the age instead of guessing', () => {
    const a = assessPlan(adult({ ageYears: null }));
    expect(a.outcome).toBe('needs_input');
    expect(a.missing.map((m) => m.questionId)).toEqual(['q06']);
  });

  it('lists every missing essential and never fills one in', () => {
    const a = assessPlan(adult({ calculationSex: null, heightCm: null, weightKg: null, activityLevel: null }));
    expect(a.outcome).toBe('needs_input');
    expect(a.missing.map((m) => m.questionId)).toEqual(['q07', 'q08', 'q09', 'q10']);
    expect(a.canContinueWithoutTargets).toBe(true);
  });

  it('asks for the health check last, as a pseudo question', () => {
    const a = assessPlan(adult({ attestation: null }));
    expect(a.outcome).toBe('needs_input');
    expect(a.missing).toEqual([expect.objectContaining({ questionId: 'eligibility' })]);
  });

  it.each([
    ['pregnantOrBreastfeeding', 'pregnant_or_breastfeeding'],
    ['supervisedNutritionCondition', 'supervised_condition'],
    ['eatingDisorderConcern', 'eating_disorder_concern'],
  ] as const)('%s means professional guidance', (flag, reason) => {
    const a = assessPlan(adult({ attestation: { ...OK, [flag]: true } }));
    expect(a.outcome).toBe('professional_guidance');
    expect(a.guidanceReasons).toEqual([reason]);
    expect(noticeFor(a)?.kind).toBe('professional_guidance');
  });

  it('puts the eating-disorder concern first when several apply', () => {
    const a = assessPlan(adult({ attestation: { pregnantOrBreastfeeding: true, supervisedNutritionCondition: true, eatingDisorderConcern: true } }));
    expect(a.guidanceReasons[0]).toBe('eating_disorder_concern');
    expect(noticeFor(a)?.title).toBe('Support first, numbers later');
  });

  it('refers an underweight person with a weight-loss goal to a professional, but not one who wants to gain', () => {
    expect(assessPlan(adult({ weightKg: 50, targetWeightKg: null })).outcome).toBe('professional_guidance');
    expect(assessPlan(adult({ weightKg: 50, targetWeightKg: null })).guidanceReasons).toEqual(['underweight_loss_goal']);
    expect(assessPlan(adult({ weightKg: 50, goal: 'gain', targetWeightKg: 56 })).outcome).toBe('ready');
  });

  it('flags contradictions and implausible numbers as blocking', () => {
    const code = (over: Partial<AssessInputs>) => assessPlan(adult(over)).issues.find((i) => i.severity === 'blocking')?.code;
    expect(code({ targetWeightKg: 90 })).toBe('target_above_current');
    expect(code({ goal: 'gain', targetWeightKg: 70 })).toBe('target_below_current');
    expect(code({ targetWeightKg: 82 })).toBe('target_equals_current');
    expect(code({ targetWeightKg: 50 })).toBe('target_bmi_low');
    expect(code({ heightCm: 250, weightKg: 25 })).toBe('bmi_implausible');
    expect(assessPlan(adult({ targetWeightKg: 90 })).outcome).toBe('needs_input');
  });

  it('warns, without blocking, about estimated weights and big changes', () => {
    const a = assessPlan(adult({ weightIsEstimate: true, weightKg: 100, targetWeightKg: 70 }));
    expect(a.outcome).toBe('ready');
    expect(a.issues.map((i) => i.code).sort()).toEqual(['large_change', 'weight_is_estimate']);
    expect(a.issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('lists the optional answers that would sharpen the plan', () => {
    const a = assessPlan(adult({ allergies: null, mealsPerDay: null, dietPattern: null }));
    expect(a.optionalUnanswered).toEqual(['q11', 'q36', 'q37']);
  });
});

describe('estimateTimeframe', () => {
  const base = { goal: 'lose', weightKg: 82, targetWeightKg: 74, tdeeKcal: 2200, energyKcal: 1980, requestedWeeks: null as number | null };

  it('estimates from the energy gap and widens the upper end', () => {
    const t = estimateTimeframe(base)!;
    // gap 220 kcal/day = 1540 kcal/week = 0.2 kg/week; 8 kg => 40 weeks
    expect(t.paceKgPerWeek).toBe(0.2);
    expect(t.changeKg).toBe(8);
    expect(t.estimatedWeeks).toEqual({ min: 40, max: 50 });
    expect(t.verdict).toBe('no_request');
    expect(t.message).toMatch(/estimate, not a deadline/);
    expect(t.safeMinWeeks).toBe(10); // 1% of 82 kg = 0.82 kg/week
  });

  it('checks the wish against the plan pace and the safe pace', () => {
    expect(estimateTimeframe({ ...base, requestedWeeks: 45 })!.verdict).toBe('realistic');
    expect(estimateTimeframe({ ...base, requestedWeeks: 26 })!.verdict).toBe('faster_than_plan');
    expect(estimateTimeframe({ ...base, requestedWeeks: 6 })!.verdict).toBe('faster_than_safe');
    expect(estimateTimeframe({ ...base, requestedWeeks: 80 })!.verdict).toBe('slower_than_plan');
    expect(estimateTimeframe({ ...base, requestedWeeks: 6 })!.message).toMatch(/at least/);
  });

  it('caps the safe loss pace at 1 kg a week and gain at 0.5 kg', () => {
    expect(estimateTimeframe({ ...base, weightKg: 150, targetWeightKg: 100 })!.safeMinWeeks).toBe(50);
    expect(estimateTimeframe({ goal: 'gain', weightKg: 60, targetWeightKg: 66, tdeeKcal: 2000, energyKcal: 2200, requestedWeeks: null })!.safeMinWeeks).toBe(12);
  });

  it('returns nothing when there is no target, no gap or the direction is wrong', () => {
    expect(estimateTimeframe({ ...base, targetWeightKg: null })).toBeNull();
    expect(estimateTimeframe({ ...base, goal: 'maintain' })).toBeNull();
    expect(estimateTimeframe({ ...base, energyKcal: 2200 })).toBeNull();
    expect(estimateTimeframe({ ...base, targetWeightKg: 90 })).toBeNull();
    expect(estimateTimeframe({ ...base, targetWeightKg: 81.8 })).toBeNull();
  });

  it('re-estimates for adjusted targets', () => {
    const t = estimateTimeframe(base)!;
    const faster = retimeFrame(t, 2200, 1780)!;
    expect(faster.estimatedWeeks.min).toBeLessThan(t.estimatedWeeks.min);
    expect(faster.requestedWeeks).toBeNull();
    expect(retimeFrame(t, 2200, 2300)).toBeNull();
  });

  it('speaks in weeks, then months, then years', () => {
    expect(humanDuration(1)).toBe('1 week');
    expect(humanDuration(12)).toBe('12 weeks');
    expect(humanDuration(26)).toBe('6 months');
    expect(humanDuration(104)).toBe('2 years');
  });
});

describe('buildBasis and noticeFor', () => {
  it('explains the estimate in plain words, with honest caveats', () => {
    const inputs = adult({ allergies: null, weightIsEstimate: true });
    const preview = calculatePlan(inputs);
    const timeframe = estimateTimeframe({ goal: 'lose', weightKg: 82, targetWeightKg: 74, tdeeKcal: preview.tdeeKcal!, energyKcal: preview.calculated!.energyKcal, requestedWeeks: null });
    const text = buildBasis(preview, inputs, timeframe).join('\n');
    expect(text).toMatch(/Mifflin-St Jeor/);
    expect(text).toMatch(/10% below/);
    expect(text).toMatch(/never go below/);
    expect(text).toMatch(/estimates/);
    expect(text).toMatch(/weight as an estimate/);
    expect(text).toMatch(/allergies or intolerances/);
    expect(text).toMatch(/not a deadline/);
  });

  it('has nothing to say when there are no numbers', () => {
    expect(buildBasis(calculatePlan(adult({ attestation: null })), adult(), null)).toEqual([]);
  });

  it('needs_input and habits_only get static, number-free notices', () => {
    for (const a of [assessPlan(adult({ heightCm: null })), assessPlan(adult({ ageYears: 15 }))]) {
      const n = noticeFor(a)!;
      expect(`${n.title} ${n.body}`).not.toMatch(/\d/);
    }
    expect(noticeFor(assessPlan(adult()))).toBeNull();
  });
});
