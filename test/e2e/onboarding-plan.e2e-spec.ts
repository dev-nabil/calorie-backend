import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, signIn } from '../setup/helpers';

const ADULT = [
  { questionId: 'q01', value: 'lose', status: 'answered', inputMethod: 'chip' },
  { questionId: 'q05', value: 'Alex', status: 'answered', inputMethod: 'typed' },
  { questionId: 'q06', value: { mode: 'age', age: 30 }, status: 'answered', inputMethod: 'form' },
  { questionId: 'q07', value: 'male', status: 'answered', inputMethod: 'chip' },
  { questionId: 'q08', value: { cm: 180, unit: 'cm' }, status: 'answered', inputMethod: 'form' },
  { questionId: 'q09', value: { kg: 80, unit: 'kg', isEstimate: false }, status: 'answered', inputMethod: 'form' },
  { questionId: 'q10', value: 'active', status: 'answered', inputMethod: 'chip' },
  { questionId: 'q11', value: 'none', status: 'answered', inputMethod: 'chip' },
  { questionId: 'q36', value: ['none'], status: 'answered', inputMethod: 'chip' },
  { questionId: 'q30', value: ['photo'], status: 'answered', inputMethod: 'chip' },
];
const ATTEST = { pregnantOrBreastfeeding: false, supervisedNutritionCondition: false, eatingDisorderConcern: false };

describe('Onboarding (M2-T3)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('GET /onboarding/questions is public, versioned and cacheable', async () => {
    const res = await t.http().get('/v1/onboarding/questions').expect(200);
    expect(res.body.version).toBe(2);
    expect(res.body.questionSet.questions).toHaveLength(38);
    expect(res.body.conversation.turns.length).toBeGreaterThan(0);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    await t.http().get('/v1/onboarding/questions').set('If-None-Match', String(res.headers.etag)).expect(304);
  });

  it('starts at q01 on the detailed route', async () => {
    const s = await signIn(t);
    const res = await t.http().get('/v1/onboarding/state').set(bearer(s.accessToken)).expect(200);
    expect(res.body).toMatchObject({ route: 'detailed', status: 'in_progress', nextQuestionId: 'q01', answers: [], mode: 'habits_only' });
  });

  it('bulk upload (DEC-18) on the basic route finishes the route', async () => {
    const s = await signIn(t);
    const res = await t.http().put('/v1/onboarding/answers').set(bearer(s.accessToken)).send({ route: 'basic', answers: ADULT }).expect(200);
    expect(res.body.route).toBe('basic');
    expect(res.body.answers).toHaveLength(10);
    expect(res.body.nextQuestionId).toBeNull();
    expect(res.body.applicableQuestionIds).toEqual(['q01', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10', 'q11', 'q36', 'q30']);
    const me = await t.http().get('/v1/me').set(bearer(s.accessToken)).expect(200);
    expect(me.body.displayName).toBe('Alex');
  });

  it('changing age to under 18 clears q07–q10 at once (BR-11)', async () => {
    const s = await signIn(t);
    await t.http().put('/v1/onboarding/answers').set(bearer(s.accessToken)).send({ route: 'detailed', answers: ADULT }).expect(200);
    const res = await t
      .http()
      .put('/v1/onboarding/answers/q06')
      .set(bearer(s.accessToken))
      .send({ value: { mode: 'age', age: 16 }, status: 'answered', inputMethod: 'form' })
      .expect(200);
    expect(res.body.cleared.sort()).toEqual(['q07', 'q08', 'q09', 'q10']);
    expect(res.body.mode).toBe('habits_only');
    const q07 = res.body.answers.find((a: { questionId: string }) => a.questionId === 'q07');
    expect(q07).toMatchObject({ status: 'not_applicable', value: null });
  });

  it('shows q16 for q15 yes and clears it when q15 becomes no', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().put('/v1/onboarding/answers/q15').set(h).send({ value: 'yes', status: 'answered', inputMethod: 'chip' }).expect(200);
    await t.http().put('/v1/onboarding/answers/q16').set(h).send({ value: ['sat', 'sun'], status: 'answered', inputMethod: 'chip' }).expect(200);
    const res = await t.http().put('/v1/onboarding/answers/q15').set(h).send({ value: 'no', status: 'answered', inputMethod: 'chip' }).expect(200);
    expect(res.body.cleared).toEqual(['q16']);
  });

  it('validates answers server-side', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    const tooMany = await t
      .http()
      .put('/v1/onboarding/answers/q21')
      .set(h)
      .send({ value: ['portion', 'snack', 'balance', 'water'], status: 'answered', inputMethod: 'chip' })
      .expect(422);
    expect(tooMany.body.error.code).toBe('ANSWER_INVALID');
    const exclusive = await t
      .http()
      .put('/v1/onboarding/answers/q21')
      .set(h)
      .send({ value: ['portion', 'none'], status: 'answered', inputMethod: 'chip' })
      .expect(422);
    expect(exclusive.body.error.code).toBe('ANSWER_INVALID');
    const unknown = await t.http().put('/v1/onboarding/answers/q99').set(h).send({ value: 'x', status: 'answered', inputMethod: 'chip' }).expect(404);
    expect(unknown.body.error.code).toBe('QUESTION_NOT_FOUND');
    const required = await t.http().put('/v1/onboarding/answers/q01').set(h).send({ status: 'skipped', inputMethod: 'form' }).expect(422);
    expect(required.body.error.code).toBe('ANSWER_REQUIRED');
    await t.http().put('/v1/onboarding/answers/q01').set(h).send({ value: 'lose', status: 'not_applicable', inputMethod: 'form' }).expect(400);
    const custom = await t
      .http()
      .put('/v1/onboarding/answers/q33')
      .set(h)
      .send({ value: 'custom', detail: { number: 21 }, status: 'answered', inputMethod: 'form' })
      .expect(200);
    expect(custom.body.answers.find((a: { questionId: string }) => a.questionId === 'q33').detail).toEqual({ number: 21 });
  });

  it('POST /onboarding/route switches the route and the next question', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().put('/v1/onboarding/answers').set(h).send({ route: 'basic', answers: ADULT }).expect(200);
    const res = await t.http().post('/v1/onboarding/route').set(h).send({ route: 'detailed' }).expect(200);
    expect(res.body.nextQuestionId).toBe('q02');
  });

  it('complete requires q01, then defers the rest and returns a preview', async () => {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    const early = await t.http().post('/v1/onboarding/complete').set(h).send({}).expect(422);
    expect(early.body.error.code).toBe('ANSWER_REQUIRED');
    await t.http().put('/v1/onboarding/answers').set(h).send({ route: 'basic', answers: ADULT }).expect(200);
    const res = await t.http().post('/v1/onboarding/complete').set(h).send({ eligibility: ATTEST }).expect(200);
    expect(res.body.profile).toMatchObject({ mode: 'full', ageYears: 30, heightCm: 180, weightKg: 80, activityLevel: 'active', onboarding: { status: 'completed' } });
    expect(res.body.profile.onboarding.deferredCount).toBeGreaterThan(0);
    expect(res.body.preview).toMatchObject({ eligible: true, method: 'mifflin_st_jeor_v1', bmrKcal: 1780, tdeeKcal: 2759, adjustmentPct: -10, floorKcal: 1780 });
    expect(res.body.preview.calculated).toMatchObject({ energyKcal: 2483, proteinG: 128 });
    const state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
    expect(state.body.deferredQuestionIds).toContain('q02');
    expect(state.body.answers.find((a: { questionId: string }) => a.questionId === 'q02').status).toBe('deferred');
  });
});

describe('Plan (M2-T5)', () => {
  let t: TestApp;
  let h: Record<string, string>;
  beforeAll(async () => {
    t = await createTestApp();
    const s = await signIn(t);
    h = bearer(s.accessToken);
    await t.http().put('/v1/onboarding/answers').set(h).send({ route: 'basic', answers: ADULT }).expect(200);
    await t.http().post('/v1/onboarding/complete').set(h).send({ eligibility: ATTEST }).expect(200);
  });
  afterAll(() => t.close());

  it('GET /plan is 404 before confirmation', async () => {
    const res = await t.http().get('/v1/plan').set(h).expect(404);
    expect(res.body.error.code).toBe('PLAN_NOT_FOUND');
  });

  it('preview without attestation is not eligible', async () => {
    const s = await signIn(t);
    const res = await t.http().post('/v1/plan/preview').set(bearer(s.accessToken)).send({}).expect(200);
    expect(res.body).toMatchObject({ eligible: false, calculated: null, mode: 'habits_only' });
  });

  it('confirms the calculated plan and replays the same Idempotency-Key', async () => {
    const key = idem();
    const res = await t.http().post('/v1/plan').set(h).set(key).send({ source: 'calculated' }).expect(201);
    expect(res.body).toMatchObject({ source: 'calculated', energyKcal: 2483, proteinG: 128, waterMl: 2500, version: 1, active: true });
    const replay = await t.http().post('/v1/plan').set(h).set(key).send({ source: 'calculated' }).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(res.body.id);
    const reused = await t.http().post('/v1/plan').set(h).set(key).send({ source: 'none' }).expect(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const missing = await t.http().post('/v1/plan').set(h).send({ source: 'calculated' }).expect(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const got = await t.http().get('/v1/plan').set(h).expect(200);
    expect(got.body.id).toBe(res.body.id);
  });

  it('adjusts within bounds and refuses below the floor (BR-06)', async () => {
    const low = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'adjusted', energyKcal: 1500 }).expect(422);
    expect(low.body.error.code).toBe('PLAN_OUT_OF_BOUNDS');
    const noEnergy = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'adjusted' }).expect(400);
    expect(noEnergy.body.error.code).toBe('VALIDATION_FAILED');
    const ok = await t
      .http()
      .post('/v1/plan')
      .set(h)
      .set(idem())
      .send({ source: 'adjusted', energyKcal: 2300, proteinG: 140, targetWeightKg: 72 })
      .expect(201);
    expect(ok.body).toMatchObject({ source: 'adjusted', energyKcal: 2300, proteinG: 140, version: 2, goal: { targetWeightKg: 72 } });
    expect(ok.body.calculated.energyKcal).toBe(2483);
  });

  it('drops energy targets when the user becomes habits-only (plan 8.8 rule 3)', async () => {
    await t.http().put('/v1/onboarding/answers/q06').set(h).send({ value: { mode: 'none' }, status: 'answered', inputMethod: 'form' }).expect(200);
    const plan = await t.http().get('/v1/plan').set(h).expect(200);
    expect(plan.body).toMatchObject({ source: 'none', energyKcal: null });
    const refuse = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated' }).expect(422);
    expect(refuse.body.error.code).toBe('PLAN_NOT_ELIGIBLE');
    await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'none', waterMl: 2000 }).expect(201);
  });
});
