import {
  ACTIVITY_FACTORS,
  activityBandOf,
  activityFactorOf,
  activityLevelOf,
  assessEligibility,
  calculatePlan,
  energyBasisOf,
  energyFloor,
  goalAdjustmentPct,
  macrosForEnergy,
  mapActivityOption,
  mifflinStJeor,
  paceTarget,
  personalWaterMl,
  proteinBounds,
  proteinPerKg,
  proteinReferenceWeightKg,
  proteinRuleOf,
  resolvePace,
  validateTargets,
  weeklyChangeKg,
  type PlanInputs,
} from './index';

const male: PlanInputs = {
  ageYears: 30,
  calculationSex: 'male',
  heightCm: 180,
  weightKg: 80,
  activityLevel: 'active',
  goal: 'lose',
  targetWeightKg: 72,
};

describe('plan-calculator', () => {
  it('maps Q10 options to activity levels', () => {
    expect(mapActivityOption('seated')).toBe('seated');
    expect(mapActivityOption('light')).toBe('light');
    expect(mapActivityOption('active')).toBe('active');
    expect(mapActivityOption('intense')).toBe('intense');
    expect(mapActivityOption('very_active')).toBeNull();
    expect(mapActivityOption('unsure')).toBeNull();
    expect(mapActivityOption(null)).toBeNull();
    expect(mapActivityOption(undefined)).toBeNull();
    expect(ACTIVITY_FACTORS).toEqual({ seated: 1.2, light: 1.375, active: 1.55, intense: 1.725 });
  });

  it('recalculates the energy basis of a stored plan from its inputs, as the preview made it', () => {
    const p = calculatePlan(male);
    expect(energyBasisOf(p.inputs, p.method)).toEqual({ bmrKcal: p.bmrKcal, activityFactor: p.activityFactor, tdeeKcal: p.tdeeKcal });
    expect(energyBasisOf(p.inputs, p.method)).toEqual({ bmrKcal: 1780, activityFactor: 1.55, tdeeKcal: 2759 });
    // Habits-only, legacy and damaged inputs give no basis (never a guessed allowance).
    expect(energyBasisOf(null, null)).toBeNull();
    expect(energyBasisOf(p.inputs, null)).toBeNull();
    expect(energyBasisOf(p.inputs, 'some_other_method')).toBeNull();
    const { activityFactor: _stored, ...noFactor } = p.inputs!;
    expect(energyBasisOf({ ...noFactor, activityLevel: 'unsure' }, p.method)).toBeNull();
    expect(energyBasisOf({ ...noFactor, activityLevel: 'toString' }, p.method)).toBeNull();
    expect(energyBasisOf({ ...p.inputs, weightKg: 0 }, p.method)).toBeNull();
    expect(energyBasisOf({ ...p.inputs, calculationSex: null }, p.method)).toBeNull();
  });

  it('energy basis: v1 plans use the q10 table, v2 plans the factor stored with their inputs', () => {
    // A plan confirmed before decision 0017: no factor and no two-part answers in its inputs.
    const v1 = { ageYears: 30, calculationSex: 'male', heightCm: 180, weightKg: 80, activityLevel: 'active' };
    expect(energyBasisOf(v1, 'mifflin_st_jeor_v1')).toEqual({ bmrKcal: 1780, activityFactor: 1.55, tdeeKcal: 2759 });
    // v2 with the two-part activity: 1.35 + 0.15 = 1.5 → 1780 × 1.5 = 2670.
    const p = calculatePlan({ ...male, dayActivity: 'standing', exerciseFrequency: 'three_four' });
    expect(p.method).toBe('mifflin_st_jeor_v2');
    expect(p.inputs).toEqual({ ageYears: 30, calculationSex: 'male', heightCm: 180, weightKg: 80, activityLevel: 'active', dayActivity: 'standing', exerciseFrequency: 'three_four', activityFactor: 1.5 });
    expect(energyBasisOf(p.inputs, p.method)).toEqual({ bmrKcal: 1780, activityFactor: 1.5, tdeeKcal: 2670 });
    // The stored factor wins over everything else in the inputs.
    expect(energyBasisOf({ ...p.inputs, activityFactor: 1.6, activityLevel: 'seated' }, 'mifflin_st_jeor_v2')).toEqual({ bmrKcal: 1780, activityFactor: 1.6, tdeeKcal: 2848 });
    // A missing or damaged factor falls back to the answers kept with the plan: q39 + q40 first, then q10.
    for (const bad of [undefined, null, 0.9, 2.6, Number.NaN, '1.5']) {
      expect(energyBasisOf({ ...p.inputs, activityFactor: bad }, 'mifflin_st_jeor_v2')).toEqual({ bmrKcal: 1780, activityFactor: 1.5, tdeeKcal: 2670 });
      expect(energyBasisOf({ ...v1, activityFactor: bad }, 'mifflin_st_jeor_v2')).toEqual({ bmrKcal: 1780, activityFactor: 1.55, tdeeKcal: 2759 });
    }
  });

  it('uses the BR-04 equation and goal adjustments', () => {
    expect(mifflinStJeor('male', 80, 180, 30)).toBe(1780);
    expect(mifflinStJeor('female', 60, 165, 28)).toBe(1330.25);
    expect(goalAdjustmentPct('lose')).toBe(-10);
    expect(goalAdjustmentPct('gain')).toBe(10);
    expect(goalAdjustmentPct('maintain')).toBe(0);
    expect(goalAdjustmentPct('habits')).toBe(0);
    expect(goalAdjustmentPct(null)).toBe(0);
  });

  it('male 30y 180 cm 80 kg active, gradual loss', () => {
    const p = calculatePlan(male);
    expect(p).toMatchObject({
      eligible: true,
      mode: 'full',
      reasons: [],
      method: 'mifflin_st_jeor_v2',
      bmrKcal: 1780,
      activityFactor: 1.55,
      tdeeKcal: 2759,
      adjustmentPct: -10,
      floorKcal: 1780,
      // 2759 × 0.9 = 2483.1; protein 128 g (20.6%); fat 670.41 kcal; carbs (2483−512−670.41)/4
      calculated: { energyKcal: 2483, proteinG: 128, fatG: 74, carbsG: 325 },
      bounds: { energyKcal: { min: 1780, max: 3311 }, proteinG: { min: 94, max: 186 } },
      // 30 ml × 80 kg = 2400 → nearest 250
      waterMl: 2500,
      // (2759 − 2483) × 7 ÷ 7700
      weeklyChangeKg: 0.25,
      goal: { type: 'lose', startWeightKg: 80, targetWeightKg: 72, pace: 'gradual', paceLimitedBy: null },
    });
    // An older q10 answer: no two-part answers, the v1 factor is kept with the inputs.
    expect(p.inputs).toEqual({ ageYears: 30, calculationSex: 'male', heightCm: 180, weightKg: 80, activityLevel: 'active', dayActivity: null, exerciseFrequency: null, activityFactor: 1.55 });
  });

  it('female 28y 165 cm 60 kg seated, maintain (above floor)', () => {
    const p = calculatePlan({
      ageYears: 28,
      calculationSex: 'female',
      heightCm: 165,
      weightKg: 60,
      activityLevel: 'seated',
      goal: 'maintain',
      lifeStage: 'none',
      waterMl: 2000,
    });
    expect(p.bmrKcal).toBe(1330);
    expect(p.tdeeKcal).toBe(1596);
    // Maintain: 1.4 g × 60 kg = 84 g (21%); fat 430.92 kcal; carbs (1596 − 336 − 430.92) / 4
    expect(p.calculated).toEqual({ energyKcal: 1596, proteinG: 84, fatG: 48, carbsG: 207 });
    expect(p.goal).toEqual({ type: 'maintain', startWeightKg: 60, targetWeightKg: null, pace: null, paceLimitedBy: null });
    expect(p.weeklyChangeKg).toBeNull();
    expect(p.waterMl).toBe(2000);
  });

  it('applies the 1,200 kcal floor for a small, older adult losing weight', () => {
    // BMR 926.5, TDEE 1111.8, −10% = 1000.6 → floor max(926.5, 1200) = 1200
    const p = calculatePlan({
      ageYears: 60,
      calculationSex: 'female',
      heightCm: 150,
      weightKg: 45,
      activityLevel: 'seated',
      goal: 'lose',
      lifeStage: 'none',
    });
    expect(p.floorKcal).toBe(1200);
    expect(p.calculated).toEqual({ energyKcal: 1200, proteinG: 72, fatG: 36, carbsG: 147 });
    expect(p.bounds?.energyKcal).toEqual({ min: 1200, max: 1334 });
  });

  it('uses BMR as the floor when it is above 1,200 kcal', () => {
    const p = calculatePlan({ ...male, activityLevel: 'seated', goal: 'lose', weightKg: 150, heightCm: 200 });
    // BMR = 1500 + 1250 − 150 + 5 = 2605; TDEE 3126; −10% = 2813.4 → above floor
    expect(p.floorKcal).toBe(2605);
    expect(p.calculated?.energyKcal).toBe(2813);
  });

  it('gradual gain adds 10%', () => {
    const p = calculatePlan({ ...male, goal: 'gain', activityLevel: 'intense' });
    // 1780 × 1.725 = 3070.5 × 1.1 = 3377.55
    expect(p.tdeeKcal).toBe(3071);
    expect(p.calculated?.energyKcal).toBe(3378);
    expect(p.goal.pace).toBe('gradual');
  });

  describe('macrosForEnergy (BR-05)', () => {
    it('clamps protein down to 30% of energy', () => {
      // 1.6 × 150 = 240 g = 960 kcal of 2000 (48%) → max floor(0.3 × 2000 / 4) = 150
      expect(macrosForEnergy(2000, 1.6 * 150)).toEqual({ energyKcal: 2000, proteinG: 150, fatG: 60, carbsG: 215 });
    });
    it('clamps protein up to 15% of energy', () => {
      // 1.6 × 40 = 64 g of 3000 kcal (8.5%) → min ceil(112.5) = 113
      expect(macrosForEnergy(3000, 1.6 * 40)).toEqual({ energyKcal: 3000, proteinG: 113, fatG: 90, carbsG: 435 });
    });
    it('uses the user protein when given', () => {
      expect(macrosForEnergy(2000, 1.6 * 80, 100).proteinG).toBe(100);
    });
    it('computes protein bounds', () => {
      expect(proteinBounds(2000)).toEqual({ min: 75, max: 150 });
    });
  });

  describe('eligibility', () => {
    it('unknown age → habits only', () => {
      expect(assessEligibility({ ...male, ageYears: null })).toEqual({
        adult: false,
        estimateAllowed: false,
        reasons: ['age_unknown'],
        mode: 'habits_only',
      });
    });
    it('under 18 → habits only, no targets, no target weight', () => {
      const p = calculatePlan({ ...male, ageYears: 17 });
      expect(p).toMatchObject({ eligible: false, mode: 'habits_only', reasons: ['under_18'], calculated: null, bounds: null });
      expect(p.goal.targetWeightKg).toBeNull();
    });
    it('lists every missing input for adults', () => {
      const e = assessEligibility({
        ageYears: 40,
        calculationSex: null,
        heightCm: null,
        weightKg: 0,
        activityLevel: null,
        goal: null,
      });
      expect(e).toEqual({
        adult: true,
        estimateAllowed: false,
        mode: 'full',
        reasons: ['sex_input_missing', 'height_missing', 'weight_missing', 'activity_missing'],
      });
    });
    it('reads the life stage only when the sex input is female', () => {
      expect(assessEligibility({ ...male, lifeStage: 'pregnant' }).reasons).toEqual([]);
      const female = { ...male, calculationSex: 'female' as const };
      expect(assessEligibility(female).reasons).toEqual(['life_stage_missing']);
      expect(assessEligibility({ ...female, lifeStage: 'pregnant' }).reasons).toEqual(['pregnant_or_breastfeeding']);
      expect(assessEligibility({ ...female, lifeStage: 'breastfeeding' }).reasons).toEqual(['pregnant_or_breastfeeding']);
      expect(assessEligibility({ ...female, lifeStage: 'none' }).reasons).toEqual([]);
      expect(assessEligibility({ ...female, lifeStage: 'declined' }).reasons).toEqual([]);
    });
    it('ineligible adult preview keeps full mode, water and goal', () => {
      const p = calculatePlan({ ...male, activityLevel: null, goal: null });
      expect(p).toMatchObject({
        eligible: false,
        mode: 'full',
        method: null,
        inputs: null,
        bmrKcal: null,
        tdeeKcal: null,
        floorKcal: null,
        waterMl: 2500,
        goal: { type: 'habits', startWeightKg: 80, targetWeightKg: 72, pace: null },
      });
    });
  });

  describe('validateTargets (BR-06)', () => {
    const preview = calculatePlan(male);
    const ineligible = calculatePlan({ ...male, ageYears: 16 });

    it('always accepts none', () => {
      expect(validateTargets(ineligible, { source: 'none' })).toEqual({ ok: true, targets: null });
    });
    it('rejects targets for ineligible profiles', () => {
      expect(validateTargets(ineligible, { source: 'calculated' })).toMatchObject({ ok: false, code: 'PLAN_NOT_ELIGIBLE' });
      expect(validateTargets(ineligible, { source: 'manual', energyKcal: 2000 })).toMatchObject({
        ok: false,
        code: 'PLAN_NOT_ELIGIBLE',
      });
    });
    it('returns calculated targets', () => {
      expect(validateTargets(preview, { source: 'calculated' })).toEqual({ ok: true, targets: preview.calculated });
    });
    it('requires energy for adjusted and manual', () => {
      expect(validateTargets(preview, { source: 'adjusted' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    });
    it('never goes below the floor or above the upper bound', () => {
      expect(validateTargets(preview, { source: 'adjusted', energyKcal: 1779 })).toMatchObject({
        ok: false,
        code: 'PLAN_OUT_OF_BOUNDS',
        details: { field: 'energyKcal', min: 1780, max: 3311 },
      });
      expect(validateTargets(preview, { source: 'adjusted', energyKcal: 3312 })).toMatchObject({
        ok: false,
        code: 'PLAN_OUT_OF_BOUNDS',
      });
    });
    it('checks protein against the requested energy', () => {
      expect(validateTargets(preview, { source: 'adjusted', energyKcal: 2000, proteinG: 151 })).toMatchObject({
        ok: false,
        code: 'PLAN_OUT_OF_BOUNDS',
        details: { field: 'proteinG', min: 75, max: 150 },
      });
      expect(validateTargets(preview, { source: 'adjusted', energyKcal: 2000, proteinG: 74 })).toMatchObject({ ok: false });
    });
    it('recomputes macros for an accepted adjustment', () => {
      expect(validateTargets(preview, { source: 'adjusted', energyKcal: 2000, proteinG: 140 })).toEqual({
        ok: true,
        targets: { energyKcal: 2000, proteinG: 140, fatG: 60, carbsG: 225 },
      });
      expect(validateTargets(preview, { source: 'manual', energyKcal: 2000 })).toEqual({
        ok: true,
        targets: { energyKcal: 2000, proteinG: 128, fatG: 60, carbsG: 237 },
      });
    });
  });
});

describe('PLAN-GEN safety reasons', () => {
  const base = { ageYears: 30, calculationSex: 'female' as const, heightCm: 168, weightKg: 70, activityLevel: 'light' as const, goal: 'lose', lifeStage: 'none' };

  it('pregnant or breastfeeding: no estimate and no weight goal', () => {
    const p = calculatePlan({ ...base, targetWeightKg: 60, lifeStage: 'pregnant' });
    expect(p).toMatchObject({ eligible: false, calculated: null, reasons: ['pregnant_or_breastfeeding'] });
    expect(p.goal).toEqual({ type: 'lose', startWeightKg: null, targetWeightKg: null, pace: null, paceLimitedBy: null });
    expect(calculatePlan(base).eligible).toBe(true);
  });

  it('a life stage never asked is not read as "no"', () => {
    expect(calculatePlan({ ...base, lifeStage: null })).toMatchObject({ eligible: false, reasons: ['life_stage_missing'] });
  });

  it('a weight-loss goal below BMI 18.5 gets no estimate, a gain goal does', () => {
    const light = { ...base, weightKg: 50 };
    expect(calculatePlan(light)).toMatchObject({ eligible: false, reasons: ['underweight_loss_goal'] });
    expect(calculatePlan({ ...light, goal: 'gain' }).eligible).toBe(true);
    expect(calculatePlan({ ...light, goal: 'maintain' }).eligible).toBe(true);
  });
});

// ── Decision 0017: nutrition assessment v2 ───────────────────────────────────────────────────────

describe('two-part activity (decision 0017 §2)', () => {
  it('factor = min(1.9, base(usual day) + add(exercise)), to 3 decimals: the full matrix', () => {
    const matrix: Record<string, Record<string, number>> = {
      seated: { none: 1.2, one_two: 1.275, three_four: 1.35, five_plus: 1.45 },
      standing: { none: 1.35, one_two: 1.425, three_four: 1.5, five_plus: 1.6 },
      moving: { none: 1.5, one_two: 1.575, three_four: 1.65, five_plus: 1.75 },
      physical: { none: 1.7, one_two: 1.775, three_four: 1.85, five_plus: 1.9 }, // 1.95 is capped
    };
    for (const [dayActivity, row] of Object.entries(matrix)) {
      for (const [exerciseFrequency, factor] of Object.entries(row)) {
        expect([dayActivity, exerciseFrequency, activityFactorOf({ dayActivity, exerciseFrequency })]).toEqual([dayActivity, exerciseFrequency, factor]);
      }
    }
  });

  it('falls back to the q10 table when q39 and q40 are not both answered; both answered win', () => {
    expect(activityFactorOf({ activityLevel: 'seated' })).toBe(1.2);
    expect(activityFactorOf({ activityLevel: 'light' })).toBe(1.375);
    expect(activityFactorOf({ activityLevel: 'active' })).toBe(1.55);
    expect(activityFactorOf({ activityLevel: 'intense' })).toBe(1.725);
    // One half of the pair alone changes nothing.
    expect(activityFactorOf({ dayActivity: 'physical', activityLevel: 'light' })).toBe(1.375);
    expect(activityFactorOf({ exerciseFrequency: 'five_plus', activityLevel: 'light' })).toBe(1.375);
    expect(activityFactorOf({ dayActivity: 'seated', exerciseFrequency: 'none', activityLevel: 'intense' })).toBe(1.2);
    // Nothing usable: activity is missing, never guessed.
    expect(activityFactorOf({})).toBeNull();
    expect(activityFactorOf({ activityLevel: 'unsure' })).toBeNull();
    expect(activityFactorOf({ dayActivity: 'seated' })).toBeNull();
    expect(activityFactorOf({ dayActivity: 'unsure', exerciseFrequency: 'none' })).toBeNull();
    expect(activityFactorOf({ dayActivity: 'seated', exerciseFrequency: 'toString' })).toBeNull();
  });

  it('derives the four-value level from the factor', () => {
    expect([1.2, 1.275, 1.289].map(activityBandOf)).toEqual(['seated', 'seated', 'seated']);
    expect([1.29, 1.35, 1.425, 1.45, 1.459].map(activityBandOf)).toEqual(['light', 'light', 'light', 'light', 'light']);
    expect([1.46, 1.5, 1.575, 1.6, 1.639].map(activityBandOf)).toEqual(['active', 'active', 'active', 'active', 'active']);
    expect([1.64, 1.65, 1.75, 1.9].map(activityBandOf)).toEqual(['intense', 'intense', 'intense', 'intense']);
    expect(activityLevelOf({ dayActivity: 'seated', exerciseFrequency: 'three_four', activityLevel: 'intense' })).toBe('light');
    expect(activityLevelOf({ dayActivity: 'seated', activityLevel: 'intense' })).toBe('intense');
    expect(activityLevelOf({ activityLevel: 'unsure' })).toBeNull();
  });

  it('a calorie plan needs q39 + q40 or an older q10 answer', () => {
    const noActivity = { ...male, activityLevel: null };
    expect(assessEligibility(noActivity).reasons).toEqual(['activity_missing']);
    expect(assessEligibility({ ...noActivity, dayActivity: 'seated' }).reasons).toEqual(['activity_missing']);
    expect(assessEligibility({ ...noActivity, exerciseFrequency: 'none' }).reasons).toEqual(['activity_missing']);
    expect(assessEligibility({ ...noActivity, dayActivity: 'seated', exerciseFrequency: 'none' }).reasons).toEqual([]);
    // The two-part answers win over q10: 1780 × 1.2, not × 1.55.
    const p = calculatePlan({ ...male, dayActivity: 'seated', exerciseFrequency: 'none' });
    expect(p).toMatchObject({ activityFactor: 1.2, tdeeKcal: 2136 });
    expect(p.inputs?.activityLevel).toBe('seated');
  });
});

describe('goal pace (decision 0017 §3)', () => {
  // Male 30 y, 180 cm, 82 kg: BMR 820 + 1125 − 150 + 5 = 1800. Standing + 3–4 sessions: × 1.5 = 2700 kcal.
  const person: PlanInputs = { ageYears: 30, calculationSex: 'male', heightCm: 180, weightKg: 82, activityLevel: null, dayActivity: 'standing', exerciseFrequency: 'three_four', goal: 'lose' };

  it.each([
    ['lose', 'gentle', -10, 2430, 0.25],
    ['lose', 'steady', -15, 2295, 0.37],
    ['lose', 'faster', -20, 2160, 0.49],
    ['gain', 'gentle', 5, 2835, 0.12],
    ['gain', 'steady', 10, 2970, 0.25],
    ['gain', 'faster', 15, 3105, 0.37],
  ])('%s at a %s pace is %i%% of maintenance', (goal, goalPace, pct, energyKcal, weekly) => {
    const p = calculatePlan({ ...person, goal, goalPace });
    expect(p.tdeeKcal).toBe(2700);
    expect(p.adjustmentPct).toBe(pct);
    expect(p.calculated?.energyKcal).toBe(energyKcal);
    expect(p.weeklyChangeKg).toBe(weekly);
    expect(p.goal).toMatchObject({ type: goal, pace: goalPace, paceLimitedBy: null });
  });

  it('an unanswered pace keeps the v1 size: 10% either way, reported as gradual', () => {
    expect(calculatePlan({ ...person, goal: 'lose' })).toMatchObject({ adjustmentPct: -10, calculated: { energyKcal: 2430 }, goal: { pace: 'gradual', paceLimitedBy: null } });
    expect(calculatePlan({ ...person, goal: 'gain', goalPace: null })).toMatchObject({ adjustmentPct: 10, calculated: { energyKcal: 2970 }, goal: { pace: 'gradual' } });
    expect(calculatePlan({ ...person, goal: 'lose', goalPace: 'warp' })).toMatchObject({ adjustmentPct: -10, goal: { pace: 'gradual' } });
  });

  it('every other goal stays at maintenance, whatever pace is stored', () => {
    for (const goal of ['maintain', 'habits', 'patterns', 'decide', null]) {
      const p = calculatePlan({ ...person, goal, goalPace: 'faster' });
      expect(p).toMatchObject({ adjustmentPct: 0, calculated: { energyKcal: 2700 }, weeklyChangeKg: null, goal: { pace: null, paceLimitedBy: null } });
    }
  });

  it('limit 1: a loss goal with a BMI under 20 gets gentle at most', () => {
    expect(resolvePace({ goal: 'lose', goalPace: 'faster', ageYears: 30, bmi: 19.99 })).toEqual({ pace: 'gentle', limitedBy: 'low_bmi', pct: -10 });
    expect(resolvePace({ goal: 'lose', goalPace: 'steady', ageYears: 30, bmi: 19.99 })).toEqual({ pace: 'gentle', limitedBy: 'low_bmi', pct: -10 });
    expect(resolvePace({ goal: 'lose', goalPace: 'faster', ageYears: 30, bmi: 20 })).toEqual({ pace: 'faster', limitedBy: null, pct: -20 });
    // Already at or under the limit: nothing to say.
    expect(resolvePace({ goal: 'lose', goalPace: 'gentle', ageYears: 30, bmi: 19 })).toEqual({ pace: 'gentle', limitedBy: null, pct: -10 });
    expect(resolvePace({ goal: 'lose', goalPace: null, ageYears: 30, bmi: 19 })).toEqual({ pace: 'gradual', limitedBy: null, pct: -10 });
    // Gaining is not limited.
    expect(resolvePace({ goal: 'gain', goalPace: 'faster', ageYears: 30, bmi: 17 })).toEqual({ pace: 'faster', limitedBy: null, pct: 15 });
    // Through the calculator: 170 cm, 57.5 kg is BMI 19.9; 58 kg is BMI 20.1.
    const lean = { ...person, heightCm: 170, weightKg: 57.5, goalPace: 'faster' };
    expect(calculatePlan(lean)).toMatchObject({ adjustmentPct: -10, goal: { pace: 'gentle', paceLimitedBy: 'low_bmi' } });
    expect(calculatePlan({ ...lean, weightKg: 58 })).toMatchObject({ adjustmentPct: -20, goal: { pace: 'faster', paceLimitedBy: null } });
  });

  it('limit 2: a loss goal at 65 or over gets steady at most', () => {
    expect(resolvePace({ goal: 'lose', goalPace: 'faster', ageYears: 64, bmi: 27 })).toEqual({ pace: 'faster', limitedBy: null, pct: -20 });
    expect(resolvePace({ goal: 'lose', goalPace: 'faster', ageYears: 65, bmi: 27 })).toEqual({ pace: 'steady', limitedBy: 'age', pct: -15 });
    expect(resolvePace({ goal: 'lose', goalPace: 'steady', ageYears: 80, bmi: 27 })).toEqual({ pace: 'steady', limitedBy: null, pct: -15 });
    expect(resolvePace({ goal: 'gain', goalPace: 'faster', ageYears: 80, bmi: 27 })).toEqual({ pace: 'faster', limitedBy: null, pct: 15 });
    // Both limits apply in order: the BMI limit already brought the pace under the age limit.
    expect(resolvePace({ goal: 'lose', goalPace: 'faster', ageYears: 70, bmi: 19.5 })).toEqual({ pace: 'gentle', limitedBy: 'low_bmi', pct: -10 });
    expect(calculatePlan({ ...person, ageYears: 64, goalPace: 'faster' }).goal).toMatchObject({ pace: 'faster', paceLimitedBy: null });
    expect(calculatePlan({ ...person, ageYears: 65, goalPace: 'faster' }).goal).toMatchObject({ pace: 'steady', paceLimitedBy: 'age' });
  });

  it('limit 3: never more than 1,000 kcal below or 500 kcal above maintenance', () => {
    // Male 21 y, 200 cm, 150 kg: BMR 1500 + 1250 − 105 + 5 = 2650; heavy work + 5 sessions: × 1.9 = 5035.
    const big = { ...person, ageYears: 21, heightCm: 200, weightKg: 150, dayActivity: 'physical', exerciseFrequency: 'five_plus' };
    const lose = calculatePlan({ ...big, goal: 'lose', goalPace: 'faster' });
    expect(lose.tdeeKcal).toBe(5035);
    // 20% would be 1007 kcal: capped at 1000, which is 19.9% of 5035. The percent reported is the real one.
    expect(lose).toMatchObject({ adjustmentPct: -19.9, calculated: { energyKcal: 4035 }, weeklyChangeKg: 0.91, goal: { pace: 'faster', paceLimitedBy: null } });
    // 15% would be 755 kcal: capped at 500, which is 9.9%.
    expect(calculatePlan({ ...big, goal: 'gain', goalPace: 'faster' })).toMatchObject({ adjustmentPct: 9.9, calculated: { energyKcal: 5535 }, weeklyChangeKg: 0.45 });
    // Under the caps nothing changes: 10% of 5035 is 503.5 below, and the percent stays the pace percent.
    expect(calculatePlan({ ...big, goal: 'lose', goalPace: 'gentle' })).toMatchObject({ adjustmentPct: -10, calculated: { energyKcal: 4532 } });
  });

  it('adjustmentPct is the effective percent, to one decimal, when a daily cap changed the target', () => {
    // Male 25 y, 190 cm, 95 kg: BMR 950 + 1187.5 − 125 + 5 = 2017.5; moving + 5 sessions: × 1.75 = 3530.6.
    // Faster gain: +15% = 530 kcal → capped at 500 → 4030.6 → 4031. 500 ÷ 3530.6 = 14.2%. Gap 4031 − 3531 = 500 → 0.45 kg a week.
    const p = calculatePlan({ ageYears: 25, calculationSex: 'male', heightCm: 190, weightKg: 95, activityLevel: null, dayActivity: 'moving', exerciseFrequency: 'five_plus', goal: 'gain', goalPace: 'faster' });
    expect(p).toMatchObject({ bmrKcal: 2018, activityFactor: 1.75, tdeeKcal: 3531, adjustmentPct: 14.2, calculated: { energyKcal: 4031 }, weeklyChangeKg: 0.45, goal: { pace: 'faster', paceLimitedBy: null } });
    // The steady pace (+10% = 353 kcal) is under the cap: the pace percent, unchanged.
    expect(calculatePlan({ ageYears: 25, calculationSex: 'male', heightCm: 190, weightKg: 95, activityLevel: null, dayActivity: 'moving', exerciseFrequency: 'five_plus', goal: 'gain', goalPace: 'steady' })).toMatchObject({ adjustmentPct: 10, calculated: { energyKcal: 3884 } });
    expect(paceTarget(2000, -15)).toEqual({ energyKcal: 1700, pct: -15 });
    expect(paceTarget(2000, 0)).toEqual({ energyKcal: 2000, pct: 0 });
    expect(paceTarget(6000, -20)).toEqual({ energyKcal: 5000, pct: -16.7 });
    expect(paceTarget(4000, 15)).toEqual({ energyKcal: 4500, pct: 12.5 });
  });

  it('limit 4: floor = max(BMR, 1200, min(sex floor, TDEE)); the male 1,500 never sits above maintenance', () => {
    // Female input: max(BMR, 1200), as in v1.
    expect(energyFloor('female', 1000, 1100)).toBe(1200);
    expect(energyFloor('female', 1000, 1300)).toBe(1200);
    expect(energyFloor('female', 1420.25, 1917)).toBe(1420.25);
    // Male input: 1,500 once maintenance reaches it; under that, maintenance itself; never under 1,200 or BMR.
    expect(energyFloor('male', 1300, 1800)).toBe(1500);
    expect(energyFloor('male', 1250, 1500)).toBe(1500);
    expect(energyFloor('male', 1187.5, 1425)).toBe(1425);
    expect(energyFloor('male', 950, 1140)).toBe(1200);
    expect(energyFloor('male', 1973.75, 2368.5)).toBe(1973.75);

    // The same small, older body with each sex input. 70 y, 162 cm, 52 kg, seated, no exercise.
    const small = { ageYears: 70, heightCm: 162, weightKg: 52, activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'none', goal: 'lose' };
    // Female input: BMR 520 + 1012.5 − 350 − 161 = 1021.5; × 1.2 = 1225.8; −10% = 1103.2 → floor 1200 (unchanged from v1).
    const f = calculatePlan({ ...small, calculationSex: 'female', lifeStage: 'none' });
    expect(f).toMatchObject({ bmrKcal: 1022, tdeeKcal: 1226, floorKcal: 1200, calculated: { energyKcal: 1200 }, weeklyChangeKg: 0.02 });
    expect(f.bounds?.energyKcal).toEqual({ min: 1200, max: 1471 });
    // Male input: BMR 1187.5; × 1.2 = 1425, under 1,500, so maintenance is the floor. A loss goal (−10% = 1282.5)
    // lands on maintenance, never above it: no expected loss, and the plan says the floor set the target.
    const lose = calculatePlan({ ...small, calculationSex: 'male' });
    expect(lose).toMatchObject({ bmrKcal: 1188, tdeeKcal: 1425, floorKcal: 1425, adjustmentPct: -10, calculated: { energyKcal: 1425 }, weeklyChangeKg: null });
    expect(lose.bounds?.energyKcal).toEqual({ min: 1425, max: 1710 });
    const keep = calculatePlan({ ...small, calculationSex: 'male', goal: 'maintain' });
    expect(keep).toMatchObject({ tdeeKcal: 1425, floorKcal: 1425, adjustmentPct: 0, calculated: { energyKcal: 1425 }, weeklyChangeKg: null });
    // Adjust targets keeps the same floor: one kcal under maintenance is refused.
    expect(validateTargets(lose, { source: 'adjusted', energyKcal: 1424 })).toMatchObject({ ok: false, code: 'PLAN_OUT_OF_BOUNDS', details: { min: 1425, max: 1710 } });

    // A man whose maintenance is 1,500 or more and whose BMR is under 1,500 still gets the 1,500 floor.
    // 60 y, 165 cm, 58 kg: BMR 580 + 1031.25 − 300 + 5 = 1316.25; seated + 1–2 sessions: × 1.275 = 1678.2; −20% = 1342.6 → 1500.
    const m = calculatePlan({ ageYears: 60, calculationSex: 'male', heightCm: 165, weightKg: 58, activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'one_two', goal: 'lose', goalPace: 'faster' });
    expect(m).toMatchObject({ bmrKcal: 1316, tdeeKcal: 1678, floorKcal: 1500, adjustmentPct: -20, calculated: { energyKcal: 1500 }, weeklyChangeKg: 0.16 });
    expect(m.bounds?.energyKcal).toEqual({ min: 1500, max: 2014 });
    // The same body with a female input: floor max(BMR 1150.25, 1200) = 1200; TDEE 1466.6; −20% = 1173.3 → 1200.
    const w = calculatePlan({ ageYears: 60, calculationSex: 'female', lifeStage: 'none', heightCm: 165, weightKg: 58, activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'one_two', goal: 'lose', goalPace: 'faster' });
    expect(w).toMatchObject({ bmrKcal: 1150, tdeeKcal: 1467, floorKcal: 1200, calculated: { energyKcal: 1200 } });

    // v1 behaviour kept: a very small woman whose maintenance is under 1,200 kcal gets 1,200 on any goal.
    // 70 y, 150 cm, 40 kg: BMR 400 + 937.5 − 350 − 161 = 826.5; × 1.2 = 991.8.
    const tiny = calculatePlan({ ageYears: 70, calculationSex: 'female', lifeStage: 'none', heightCm: 150, weightKg: 40, activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'none', goal: 'maintain' });
    expect(tiny).toMatchObject({ bmrKcal: 827, tdeeKcal: 992, floorKcal: 1200, adjustmentPct: 0, calculated: { energyKcal: 1200 }, weeklyChangeKg: null });
  });

  it('weeklyChangeKg: gap × 7 ÷ 7700, two decimals, only for a gap in the goal direction', () => {
    expect(weeklyChangeKg('lose', 2700, 2295)).toBe(0.37);
    expect(weeklyChangeKg('gain', 2700, 2970)).toBe(0.25);
    expect(weeklyChangeKg('lose', 2000, 900)).toBe(1);
    expect(weeklyChangeKg('lose', 2000, 2000)).toBeNull();
    expect(weeklyChangeKg('lose', 2000, 2100)).toBeNull();
    expect(weeklyChangeKg('gain', 2000, 1900)).toBeNull();
    expect(weeklyChangeKg('maintain', 2000, 1500)).toBeNull();
    expect(weeklyChangeKg(null, 2000, 1500)).toBeNull();
  });
});

describe('protein and water (decision 0017 §4, §5)', () => {
  it('counts protein on the actual weight up to BMI 25, above that on the weight at BMI 25', () => {
    // 200 cm: BMI 25 is exactly 100 kg.
    expect(proteinReferenceWeightKg(90, 200)).toBe(90);
    expect(proteinReferenceWeightKg(100, 200)).toBe(100);
    expect(proteinReferenceWeightKg(101, 200)).toBe(100);
    expect(proteinReferenceWeightKg(150, 200)).toBe(100);
    // 175 cm: 25 × 1.75² = 76.5625 kg.
    expect(proteinReferenceWeightKg(110, 175)).toBe(76.5625);
    // Underweight: the actual weight.
    expect(proteinReferenceWeightKg(45, 165)).toBe(45);
  });

  it('1.6 g/kg for lose and gain, 1.4 for every other goal, +0.2 with exercise 3 or more times a week', () => {
    expect(proteinPerKg('lose')).toBe(1.6);
    expect(proteinPerKg('gain', 'none')).toBe(1.6);
    expect(proteinPerKg('lose', 'one_two')).toBe(1.6);
    expect(proteinPerKg('lose', 'three_four')).toBe(1.8);
    expect(proteinPerKg('gain', 'five_plus')).toBe(1.8);
    expect(proteinPerKg('maintain')).toBe(1.4);
    expect(proteinPerKg('habits', 'one_two')).toBe(1.4);
    expect(proteinPerKg('patterns', 'three_four')).toBe(1.6);
    expect(proteinPerKg(null, 'five_plus')).toBe(1.6);
  });

  it('applies the rule in a plan: bonus, reference weight and no bonus for an older q10 answer', () => {
    // Male 30 y, 180 cm, 80 kg (BMI 24.7), maintain, standing + 3–4: 1.6 × 80 = 128 g.
    const base: PlanInputs = { ageYears: 30, calculationSex: 'male', heightCm: 180, weightKg: 80, activityLevel: null, dayActivity: 'standing', exerciseFrequency: 'three_four', goal: 'maintain' };
    expect(calculatePlan(base).calculated?.proteinG).toBe(128);
    // Without the bonus: 1.4 × 80 = 112 g.
    expect(calculatePlan({ ...base, exerciseFrequency: 'one_two' }).calculated?.proteinG).toBe(112);
    // q10 only ('active', "regular exercise"): no bonus, the answer does not say how often.
    expect(calculatePlan({ ...base, dayActivity: null, exerciseFrequency: null, activityLevel: 'active' }).calculated?.proteinG).toBe(112);
    // 110 kg at 180 cm is BMI 34: 25 × 3.24 = 81 kg reference; lose 1.6 × 81 = 129.6 → 130 g (v1 gave 176).
    const heavy = calculatePlan({ ...base, weightKg: 110, goal: 'lose', exerciseFrequency: 'none' });
    expect(heavy.calculated?.proteinG).toBe(130);
    expect(proteinRuleOf(heavy)).toEqual({ gPerKg: 1.6, weightKg: 81, reference: true });
    expect(proteinRuleOf(calculatePlan(base))).toEqual({ gPerKg: 1.6, weightKg: 80, reference: false });
  });

  it('adjusted targets keep the protein rule their preview was made with', () => {
    const heavy = calculatePlan({ ageYears: 30, calculationSex: 'male', heightCm: 180, weightKg: 110, activityLevel: 'active', goal: 'lose' });
    // v2: 1.6 × 81 kg reference = 129.6 → 130 g.
    expect(validateTargets(heavy, { source: 'manual', energyKcal: 2600 })).toMatchObject({ ok: true, targets: { energyKcal: 2600, proteinG: 130 } });
    // A draft stored before decision 0017 (v1): 1.6 × 110 kg = 176 g, as it showed.
    const v1 = { ...heavy, method: 'mifflin_st_jeor_v1' as const };
    expect(proteinRuleOf(v1)).toEqual({ gPerKg: 1.6, weightKg: 110, reference: false });
    expect(validateTargets(v1, { source: 'manual', energyKcal: 2600 })).toMatchObject({ ok: true, targets: { energyKcal: 2600, proteinG: 176 } });
  });

  it('water is 30 ml per kg, to the nearest 250 ml, between 1,500 and 3,500 ml', () => {
    expect(personalWaterMl(70)).toBe(2000); // 2100
    expect(personalWaterMl(62.5)).toBe(2000); // 1875 is exactly half way: rounds up
    expect(personalWaterMl(58)).toBe(1750); // 1740
    expect(personalWaterMl(80)).toBe(2500); // 2400
    expect(personalWaterMl(110)).toBe(3250); // 3300
    expect(personalWaterMl(45)).toBe(1500); // 1350 → lower limit
    expect(personalWaterMl(50)).toBe(1500);
    expect(personalWaterMl(120)).toBe(3500); // 3600 → upper limit
    expect(personalWaterMl(200)).toBe(3500);
  });

  it('a calorie plan gets personal water; the person own target wins; no plan keeps 2,500 ml', () => {
    const base: PlanInputs = { ageYears: 30, calculationSex: 'male', heightCm: 180, weightKg: 70, activityLevel: 'light', goal: 'maintain' };
    expect(calculatePlan(base).waterMl).toBe(2000);
    expect(calculatePlan({ ...base, waterMl: 3000 }).waterMl).toBe(3000);
    expect(calculatePlan({ ...base, activityLevel: null }).waterMl).toBe(2500);
    expect(calculatePlan({ ...base, ageYears: 16 }).waterMl).toBe(2500);
  });
});

describe('worked examples (decision 0017), checked by hand', () => {
  it('(a) female 30 y, 165 cm, 70 kg, seated + 3–4 sessions, lose at a steady pace', () => {
    const p = calculatePlan({ ageYears: 30, calculationSex: 'female', lifeStage: 'none', heightCm: 165, weightKg: 70, activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'three_four', goal: 'lose', goalPace: 'steady' });
    // BMR 700 + 1031.25 − 150 − 161 = 1420.25. Factor 1.2 + 0.15 = 1.35. TDEE 1917.34.
    // −15% = 1629.7 → 1630 (floor 1420.25 does not bind). Gap 287 kcal → 0.26 kg a week.
    // Protein: BMI 25.7 → reference 25 × 1.65² = 68.06 kg × 1.8 = 122.5 → 123 g, cut to 30% of 1630 = 122 g.
    // Fat 0.27 × 1630 = 440.1 kcal → 49 g. Carbs (1630 − 488 − 440.1) / 4 = 175.5 → 175 g. Water 2100 → 2000 ml.
    expect(p).toEqual({
      eligible: true,
      mode: 'full',
      reasons: [],
      method: 'mifflin_st_jeor_v2',
      inputs: { ageYears: 30, calculationSex: 'female', heightCm: 165, weightKg: 70, activityLevel: 'light', dayActivity: 'seated', exerciseFrequency: 'three_four', activityFactor: 1.35 },
      bmrKcal: 1420,
      activityFactor: 1.35,
      tdeeKcal: 1917,
      adjustmentPct: -15,
      weeklyChangeKg: 0.26,
      floorKcal: 1420,
      calculated: { energyKcal: 1630, proteinG: 122, fatG: 49, carbsG: 175 },
      bounds: { energyKcal: { min: 1420, max: 2301 }, proteinG: { min: 62, max: 122 } },
      waterMl: 2000,
      goal: { type: 'lose', startWeightKg: 70, targetWeightKg: null, pace: 'steady', paceLimitedBy: null },
    });
  });

  it('(b) male 45 y, 175 cm, 110 kg, seated + no exercise, lose at the faster pace: the BMR floor sets the target', () => {
    const p = calculatePlan({ ageYears: 45, calculationSex: 'male', heightCm: 175, weightKg: 110, activityLevel: null, dayActivity: 'seated', exerciseFrequency: 'none', goal: 'lose', goalPace: 'faster' });
    // BMR 1100 + 1093.75 − 225 + 5 = 1973.75. Factor 1.2. TDEE 2368.5.
    // −20% = 1894.8, under the floor max(1973.75, 1500) → 1974. Gap 2369 − 1974 = 395 kcal → 0.36 kg a week.
    // Protein: BMI 35.9 → reference 25 × 1.75² = 76.56 kg × 1.6 = 122.5 → 123 g.
    // Fat 0.27 × 1974 = 532.98 kcal → 59 g. Carbs (1974 − 492 − 532.98) / 4 = 237.3 → 237 g. Water 3300 → 3250 ml.
    expect(p).toMatchObject({
      method: 'mifflin_st_jeor_v2',
      bmrKcal: 1974,
      activityFactor: 1.2,
      tdeeKcal: 2369,
      adjustmentPct: -20,
      weeklyChangeKg: 0.36,
      floorKcal: 1974,
      calculated: { energyKcal: 1974, proteinG: 123, fatG: 59, carbsG: 237 },
      bounds: { energyKcal: { min: 1974, max: 2842 }, proteinG: { min: 75, max: 148 } },
      waterMl: 3250,
      goal: { type: 'lose', pace: 'faster', paceLimitedBy: null },
    });
    expect(p.inputs).toMatchObject({ activityLevel: 'seated', activityFactor: 1.2 });
  });

  it('(c) female 68 y, 160 cm, 75 kg, standing + 1–2 sessions, asks for faster: steady because of age', () => {
    const p = calculatePlan({ ageYears: 68, calculationSex: 'female', lifeStage: 'none', heightCm: 160, weightKg: 75, activityLevel: null, dayActivity: 'standing', exerciseFrequency: 'one_two', goal: 'lose', goalPace: 'faster' });
    // BMR 750 + 1000 − 340 − 161 = 1249. Factor 1.35 + 0.075 = 1.425. TDEE 1779.8 → 1780.
    // Faster → steady (65 or over): −15% = 1512.9 → 1513. Floor 1249. Gap 267 kcal → 0.24 kg a week.
    // Protein: BMI 29.3 → reference 25 × 1.6² = 64 kg × 1.6 = 102.4 → 102 g.
    // Fat 0.27 × 1513 = 408.51 kcal → 45 g. Carbs (1513 − 408 − 408.51) / 4 = 174.1 → 174 g. Water 2250 ml.
    expect(p).toMatchObject({
      method: 'mifflin_st_jeor_v2',
      bmrKcal: 1249,
      activityFactor: 1.425,
      tdeeKcal: 1780,
      adjustmentPct: -15,
      weeklyChangeKg: 0.24,
      floorKcal: 1249,
      calculated: { energyKcal: 1513, proteinG: 102, fatG: 45, carbsG: 174 },
      bounds: { energyKcal: { min: 1249, max: 2136 }, proteinG: { min: 57, max: 113 } },
      waterMl: 2250,
      goal: { type: 'lose', pace: 'steady', paceLimitedBy: 'age' },
    });
    expect(p.inputs).toMatchObject({ activityLevel: 'light', activityFactor: 1.425 });
  });
});
