import { assessPlan, buildBasis, estimateTimeframe, humanDuration, noticeFor, requiredForTargets, retimeFrame, runsOnLegacyActivity, type AssessInputs } from './index';
import { translatorFor } from '../../shared/i18n';
import { calculatePlan } from '../plan-calculator';

const adult = (over: Partial<AssessInputs> = {}): AssessInputs => ({
  ageYears: 34,
  calculationSex: 'female',
  heightCm: 168,
  weightKg: 82,
  activityLevel: 'light',
  goal: 'lose',
  targetWeightKg: 74,
  lifeStage: 'none',
  allergies: ['none'],
  mealsPerDay: 'three',
  schedulePattern: 'fixed',
  mealSource: 'home',
  dietPattern: 'none',
  ...over,
});

describe('assessPlan', () => {
  it('ready when everything essential is present', () => {
    const a = assessPlan(adult());
    expect(a.outcome).toBe('ready');
    expect(a.missing).toEqual([]);
    expect(a.issues).toEqual([]);
    expect(a.optionalUnanswered).toEqual([]);
    // This profile runs on an older q10 answer alone, so q10 is what its plan needs.
    expect(a.requiredForTargets).toEqual(['q06', 'q07', 'q38', 'q08', 'q09', 'q10']);
  });

  it('activity is the usual day (q39) and exercise (q40); a profile on an older q10 answer alone lists q10', () => {
    const twoPart = adult({ activityLevel: 'light', dayActivity: 'seated', exerciseFrequency: 'one_two' });
    expect(assessPlan(twoPart)).toMatchObject({ outcome: 'ready', missing: [], requiredForTargets: ['q06', 'q07', 'q38', 'q08', 'q09', 'q39', 'q40'] });
    expect(runsOnLegacyActivity(twoPart)).toBe(false);
    expect(runsOnLegacyActivity(adult())).toBe(true);
    expect(runsOnLegacyActivity(adult({ activityLevel: null }))).toBe(false);
    // Nothing answered yet: the new questions are the ones to ask.
    expect(requiredForTargets(adult({ calculationSex: 'male', activityLevel: null }))).toEqual(['q06', 'q07', 'q08', 'q09', 'q39', 'q40']);
    // One half answered beside an older q10 answer: the plan is ready on q10, and the list names the pair being completed.
    const half = assessPlan(adult({ dayActivity: 'seated' }));
    expect(half).toMatchObject({ outcome: 'ready', missing: [], requiredForTargets: ['q06', 'q07', 'q38', 'q08', 'q09', 'q39', 'q40'] });
  });

  it('missing activity points at q39 then q40, each only when unanswered', () => {
    const none = assessPlan(adult({ activityLevel: null }));
    expect(none.outcome).toBe('needs_input');
    expect(none.missing.map((m) => [m.questionId, m.field])).toEqual([['q39', 'dayActivity'], ['q40', 'exerciseFrequency']]);
    expect(none.missing.map((m) => m.reason).join(' ')).toMatch(/usual day.*how often you exercise/);
    expect(assessPlan(adult({ activityLevel: null, dayActivity: 'moving' })).missing.map((m) => m.questionId)).toEqual(['q40']);
    expect(assessPlan(adult({ activityLevel: null, exerciseFrequency: 'none' })).missing.map((m) => m.questionId)).toEqual(['q39']);
    // An option id the bank does not have counts as unanswered.
    expect(assessPlan(adult({ activityLevel: null, dayActivity: 'unsure', exerciseFrequency: 'none' })).missing.map((m) => m.questionId)).toEqual(['q39']);
    expect(assessPlan(adult({ activityLevel: null, dayActivity: 'moving', exerciseFrequency: 'none' })).outcome).toBe('ready');
    // In Bangla too, with ASCII digits.
    const bn = assessPlan(adult({ activityLevel: null }), translatorFor('bn'));
    expect(bn.missing.map((m) => m.reason).join(' ')).toMatch(/সাধারণ দিন.*ব্যায়াম/);
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
    expect(a.missing.map((m) => m.questionId)).toEqual(['q07', 'q08', 'q09', 'q39', 'q40']);
    expect(a.canContinueWithoutTargets).toBe(true);
  });

  it('only counts the life stage as needed when the sex input is female', () => {
    expect(assessPlan(adult({ calculationSex: 'male', lifeStage: null })).requiredForTargets).toEqual(['q06', 'q07', 'q08', 'q09', 'q10']);
    expect(assessPlan(adult({ calculationSex: 'male', lifeStage: null })).outcome).toBe('ready');
    const a = assessPlan(adult({ lifeStage: null }));
    expect(a.outcome).toBe('needs_input');
    expect(a.missing.map((m) => m.questionId)).toEqual(['q38']);
  });

  it('a declined life stage is the person\'s choice and does not block the goal', () => {
    expect(assessPlan(adult({ lifeStage: 'declined' })).outcome).toBe('ready');
  });

  it.each(['pregnant', 'breastfeeding'])('%s gets a habits goal with no referral and nothing else to answer', (lifeStage) => {
    const a = assessPlan(adult({ lifeStage, heightCm: null, weightKg: null, activityLevel: null }));
    expect(a).toMatchObject({ outcome: 'habits_only', missing: [], guidanceReasons: ['pregnant_or_breastfeeding'] });
    const n = noticeFor(a)!;
    expect(n.kind).toBe('habits_only');
    expect(`${n.title} ${n.body}`).not.toMatch(/GP|doctor|midwife|dietitian|professional|\d/i);
  });

  it('a weight-loss goal at an underweight BMI asks for another goal, with no referral; gaining is fine', () => {
    const a = assessPlan(adult({ weightKg: 50, targetWeightKg: null }));
    expect(a.outcome).toBe('needs_input');
    expect(a.guidanceReasons).toEqual([]);
    expect(a.issues).toEqual([expect.objectContaining({ code: 'loss_goal_underweight', severity: 'blocking', questionIds: ['q01', 'q09'] })]);
    expect(a.issues[0]!.message).not.toMatch(/GP|doctor|dietitian|professional/i);
    expect(assessPlan(adult({ weightKg: 50, goal: 'gain', targetWeightKg: null })).outcome).toBe('ready');
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
    expect(t.message).toMatch(/a guide, not a deadline/);
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
    expect(text).toMatch(/People differ by 10%/);
    expect(text).toMatch(/weight is not exact/);
    expect(text).not.toMatch(/estimat/i);
    expect(text).toMatch(/allergies or intolerances/);
    expect(text).toMatch(/not a deadline/);
  });

  it('an older q10 answer with no pace keeps the v1 wording, with the protein rule the plan really used', () => {
    const inputs = adult();
    const lines = buildBasis(calculatePlan(inputs), inputs, null);
    expect(lines[0]).toMatch(/Because you are lightly active, we multiplied it by 1\.375/);
    expect(lines[1]).toBe('Your daily target is 10% below that, a gentle gap that is meant to be sustainable.');
    // 168 cm, 82 kg is BMI 29: protein is counted on 25 × 1.68² = 70.56 → 71 kg.
    expect(lines.join('\n')).toMatch(/1\.6 g per kg of a reference weight for your height \(71 kg\)/);
    expect(lines.join('\n')).not.toMatch(/estimat/i);
  });

  it('names the usual day, the exercise, the pace and the weekly change for a two-part plan', () => {
    const inputs = adult({ heightCm: 180, weightKg: 80, calculationSex: 'male', activityLevel: null, dayActivity: 'standing', exerciseFrequency: 'three_four', goalPace: 'steady' });
    const preview = calculatePlan(inputs);
    const lines = buildBasis(preview, inputs, null);
    // BMR 800 + 1125 − 170 + 5 = 1760; × 1.5 = 2640; −15% = 2244; gap 396 kcal → 0.36 kg a week.
    expect(lines[0]).toMatch(/Your usual day \(on your feet some of the day\) and your exercise \(3–4 times a week\) together multiply it by 1\.5, so you use about 2640 kcal in a day\./);
    expect(lines[1]).toBe('Your daily target is 15% below that (steady pace), which works out at about 0.36 kg a week.');
    expect(lines[2]).toBe('Targets never go below 1760 kcal a day.');
    // BMI 24.7 and exercise 3–4 times a week: 1.8 g per kg of the actual weight.
    expect(lines[3]).toMatch(/^Protein is set at 1\.8 g per kg of body weight/);
    expect(lines.join('\n')).not.toMatch(/estimat|undefined|null/i);
    // Gain reads "above".
    const gain = { ...inputs, goal: 'gain', targetWeightKg: 85, goalPace: 'gentle' };
    expect(buildBasis(calculatePlan(gain), gain, null)[1]).toBe('Your daily target is 5% above that (gentle pace), which works out at about 0.12 kg a week.');
    // Maintain has no pace line.
    const keep = { ...inputs, goal: 'maintain', targetWeightKg: null };
    expect(buildBasis(calculatePlan(keep), keep, null)[1]).toMatch(/matches that number/);
    expect(buildBasis(calculatePlan(keep), keep, null).join('\n')).toMatch(/1\.6 g per kg of body weight/);
  });

  it('says why the pace is slower than the one asked for, without a diagnosis', () => {
    const older = adult({ ageYears: 68, heightCm: 160, weightKg: 75, targetWeightKg: 68, activityLevel: null, dayActivity: 'standing', exerciseFrequency: 'one_two', goalPace: 'faster' });
    const a = buildBasis(calculatePlan(older), older, null);
    expect(a[1]).toMatch(/From 65 a steady pace protects muscle and bone better/);
    expect(a[2]).toBe('Your daily target is 15% below that (steady pace), which works out at about 0.24 kg a week.');
    const lean = adult({ heightCm: 170, weightKg: 57.5, targetWeightKg: 55, activityLevel: null, dayActivity: 'standing', exerciseFrequency: 'three_four', goalPace: 'faster' });
    const b = buildBasis(calculatePlan(lean), lean, null);
    expect(b[1]).toMatch(/a gentle pace protects your muscle better/);
    expect(b[2]).toMatch(/10% below that \(gentle pace\)/);
    expect([...a, ...b].join('\n')).not.toMatch(/doctor|GP|diagnos|underweight|BMI|estimat/i);
    // In Bangla: Bangla script, ASCII digits, no banned words.
    const bn = buildBasis(calculatePlan(older), older, null, translatorFor('bn')).join('\n');
    expect(bn).toMatch(/মাঝারি গতি/);
    expect(bn).not.toMatch(/[০-৯]|আনুমানিক|অনুমান|আন্দাজ|undefined/);
  });

  it('says so when the floor, not the pace, set the target', () => {
    // Male 45 y, 175 cm, 110 kg, seated, no exercise, faster: −20% = 1895 is under the floor (BMR 1974).
    const inputs = adult({ ageYears: 45, calculationSex: 'male', heightCm: 175, weightKg: 110, targetWeightKg: 95, activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'none', goalPace: 'faster' });
    const lines = buildBasis(calculatePlan(inputs), inputs, null);
    expect(lines[1]).toBe('That pace would take you below your minimum, so your daily target is set at 1974 kcal instead.');
    expect(lines[2]).toBe('Targets never go below 1974 kcal a day.');
    expect(lines.join('\n')).not.toMatch(/20% below/);
    expect(lines.join('\n')).toMatch(/reference weight for your height \(77 kg\)/);
  });

  it('a man whose maintenance is under 1,500 kcal is never set above it: the floor line on a loss goal, "matches" on maintain', () => {
    // 70 y, 162 cm, 52 kg, seated, no exercise: BMR 1187.5, maintenance 1425 = the floor.
    const small = adult({ ageYears: 70, calculationSex: 'male', heightCm: 162, weightKg: 52, targetWeightKg: 50, activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'none', goalPace: null });
    const lose = buildBasis(calculatePlan(small), small, null);
    expect(lose[1]).toBe('That pace would take you below your minimum, so your daily target is set at 1425 kcal instead.');
    expect(lose[2]).toBe('Targets never go below 1425 kcal a day.');
    expect(lose.join('\n')).not.toMatch(/% below that|1500/);
    const keep = { ...small, goal: 'maintain', targetWeightKg: null };
    expect(buildBasis(calculatePlan(keep), keep, null)[1]).toMatch(/matches that number/);
  });

  it('says the minimum set the target when it sits above maintenance on a goal that is not a loss (v1 behaviour kept)', () => {
    // Female 70 y, 150 cm, 40 kg, seated, no exercise: BMR 826.5, maintenance 992, floor 1200.
    const tiny = adult({ ageYears: 70, heightCm: 150, weightKg: 40, targetWeightKg: null, goal: 'maintain', activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'none' });
    const preview = calculatePlan(tiny);
    expect(preview).toMatchObject({ tdeeKcal: 992, floorKcal: 1200, adjustmentPct: 0, calculated: { energyKcal: 1200 } });
    const lines = buildBasis(preview, tiny, null);
    expect(lines[0]).toMatch(/so you use about 992 kcal in a day\.$/);
    expect(lines[1]).toBe('That is under your minimum, so your daily target is set at 1200 kcal instead.');
    expect(lines[2]).toBe('Targets never go below 1200 kcal a day.');
    expect(lines.join('\n')).not.toMatch(/matches that number|% above|% below/);
    // A gain goal there: +10% = 1091 is still under the minimum, so the same line, not "10% above".
    const gain = { ...tiny, goal: 'gain', targetWeightKg: 45 };
    expect(buildBasis(calculatePlan(gain), gain, null)[1]).toBe('That is under your minimum, so your daily target is set at 1200 kcal instead.');
    const bn = buildBasis(preview, tiny, null, translatorFor('bn'));
    expect(bn[1]).toMatch(/সর্বনিম্ন সীমার নিচে.*1200 ক্যালরিতে/);
    expect(bn.join('\n')).not.toMatch(/[০-৯]|আনুমানিক|অনুমান|আন্দাজ|undefined/);
  });

  it('quotes the real percent when a daily cap changed the target', () => {
    // Male 25 y, 190 cm, 95 kg, moving + 5 sessions, gain faster: +15% = 530 kcal → capped at 500 = 14.2% of 3531.
    const big = adult({ ageYears: 25, calculationSex: 'male', heightCm: 190, weightKg: 95, targetWeightKg: 100, goal: 'gain', activityLevel: null, dayActivity: 'moving', exerciseFrequency: 'five_plus', goalPace: 'faster' });
    const lines = buildBasis(calculatePlan(big), big, null);
    expect(lines[1]).toBe('Your daily target is 14.2% above that (faster pace), which works out at about 0.45 kg a week.');
  });

  it('an adjusted target replaces the pace lines; a v1 draft keeps the v1 protein line', () => {
    const inputs = adult({ activityLevel: null, dayActivity: 'standing', exerciseFrequency: 'one_two', goalPace: 'faster' });
    const preview = calculatePlan(inputs);
    const adjusted = buildBasis(preview, inputs, null, undefined, preview.calculated!.energyKcal + 100).join('\n');
    expect(adjusted).toMatch(/You adjusted your daily target/);
    expect(adjusted).not.toMatch(/% below that/);
    const v1 = { ...calculatePlan(adult()), method: 'mifflin_st_jeor_v1' as const, weeklyChangeKg: undefined };
    expect(buildBasis(v1, adult(), null).join('\n')).toMatch(/Protein is set at 1\.6 g per kg of body weight \(kept between 15% and 30% of energy\)/);
  });

  it('has nothing to say when there are no numbers', () => {
    expect(buildBasis(calculatePlan(adult({ lifeStage: null })), adult(), null)).toEqual([]);
  });

  it('needs_input and habits_only get static, number-free notices', () => {
    for (const a of [assessPlan(adult({ heightCm: null })), assessPlan(adult({ ageYears: 15 }))]) {
      const n = noticeFor(a)!;
      expect(`${n.title} ${n.body}`).not.toMatch(/\d/);
    }
    expect(noticeFor(assessPlan(adult()))).toBeNull();
  });
});
