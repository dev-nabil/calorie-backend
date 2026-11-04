import {
  ACTIVITY_FACTORS,
  assessEligibility,
  calculatePlan,
  goalAdjustmentPct,
  macrosForEnergy,
  mapActivityOption,
  mifflinStJeor,
  proteinBounds,
  validateTargets,
  type PlanInputs,
} from './index';

const ok = { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false, eatingDisorderConcern: false };
const male: PlanInputs = {
  ageYears: 30,
  calculationSex: 'male',
  heightCm: 180,
  weightKg: 80,
  activityLevel: 'active',
  goal: 'lose',
  targetWeightKg: 72,
  attestation: ok,
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
      method: 'mifflin_st_jeor_v1',
      bmrKcal: 1780,
      activityFactor: 1.55,
      tdeeKcal: 2759,
      adjustmentPct: -10,
      floorKcal: 1780,
      // 2759 × 0.9 = 2483.1; protein 128 g (20.6%); fat 670.41 kcal; carbs (2483−512−670.41)/4
      calculated: { energyKcal: 2483, proteinG: 128, fatG: 74, carbsG: 325 },
      bounds: { energyKcal: { min: 1780, max: 3311 }, proteinG: { min: 94, max: 186 } },
      waterMl: 2500,
      goal: { type: 'lose', startWeightKg: 80, targetWeightKg: 72, pace: 'gradual' },
    });
    expect(p.inputs).toEqual({ ageYears: 30, calculationSex: 'male', heightCm: 180, weightKg: 80, activityLevel: 'active' });
  });

  it('female 28y 165 cm 60 kg seated, maintain (above floor)', () => {
    const p = calculatePlan({
      ageYears: 28,
      calculationSex: 'female',
      heightCm: 165,
      weightKg: 60,
      activityLevel: 'seated',
      goal: 'maintain',
      attestation: ok,
      waterMl: 2000,
    });
    expect(p.bmrKcal).toBe(1330);
    expect(p.tdeeKcal).toBe(1596);
    expect(p.calculated).toEqual({ energyKcal: 1596, proteinG: 96, fatG: 48, carbsG: 195 });
    expect(p.goal).toEqual({ type: 'maintain', startWeightKg: 60, targetWeightKg: null, pace: null });
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
      attestation: ok,
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
      expect(macrosForEnergy(2000, 150)).toEqual({ energyKcal: 2000, proteinG: 150, fatG: 60, carbsG: 215 });
    });
    it('clamps protein up to 15% of energy', () => {
      // 1.6 × 40 = 64 g of 3000 kcal (8.5%) → min ceil(112.5) = 113
      expect(macrosForEnergy(3000, 40)).toEqual({ energyKcal: 3000, proteinG: 113, fatG: 90, carbsG: 435 });
    });
    it('uses the user protein when given', () => {
      expect(macrosForEnergy(2000, 80, 100).proteinG).toBe(100);
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
        reasons: ['sex_input_missing', 'height_missing', 'weight_missing', 'activity_missing', 'eligibility_unconfirmed'],
      });
    });
    it('blocks pregnancy, breastfeeding and supervised conditions', () => {
      expect(
        assessEligibility({ ...male, attestation: { pregnantOrBreastfeeding: true, supervisedNutritionCondition: true, eatingDisorderConcern: false } })
          .reasons,
      ).toEqual(['pregnant_or_breastfeeding', 'supervised_condition']);
    });
    it('ineligible adult preview keeps full mode, water and goal', () => {
      const p = calculatePlan({ ...male, attestation: null, goal: null });
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
  const base = { ageYears: 30, calculationSex: 'female' as const, heightCm: 168, weightKg: 70, activityLevel: 'light' as const, goal: 'lose' };
  const ok = { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false, eatingDisorderConcern: false };

  it('an eating-disorder concern blocks every estimate and shows no weight goal', () => {
    const p = calculatePlan({ ...base, targetWeightKg: 60, attestation: { ...ok, eatingDisorderConcern: true } });
    expect(p).toMatchObject({ eligible: false, calculated: null, reasons: ['eating_disorder_concern'] });
    expect(p.goal).toEqual({ type: 'lose', startWeightKg: null, targetWeightKg: null, pace: null });
    expect(calculatePlan({ ...base, attestation: ok }).eligible).toBe(true);
  });

  it('a health check that never answered the eating row is unconfirmed, never read as "no"', () => {
    const legacy = { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false } as never;
    expect(calculatePlan({ ...base, attestation: legacy })).toMatchObject({ eligible: false, reasons: ['eligibility_unconfirmed'] });
    expect(assessEligibility({ ...base, attestation: legacy }).estimateAllowed).toBe(false);
  });

  it('a weight-loss goal below BMI 18.5 gets no estimate, a gain goal does', () => {
    const light = { ...base, weightKg: 50, attestation: ok };
    expect(calculatePlan(light)).toMatchObject({ eligible: false, reasons: ['underweight_loss_goal'] });
    expect(calculatePlan({ ...light, goal: 'gain' }).eligible).toBe(true);
    expect(calculatePlan({ ...light, goal: 'maintain' }).eligible).toBe(true);
  });
});
