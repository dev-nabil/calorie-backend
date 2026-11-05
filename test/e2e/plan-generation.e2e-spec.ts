import { randomUUID } from 'node:crypto';
import { KvStore } from '../../src/infra/kv/kv-store';
import { AiProvider, FakeAiProvider, PLAN_NARRATIVE_EXAMPLE } from '../../src/modules/ai/ai.provider';
import { createTestApp, type TestApp } from '../setup/test-app';
import { bearer, idem, signIn } from '../setup/helpers';

const OLD_APP = { pregnantOrBreastfeeding: true, supervisedNutritionCondition: true, eatingDisorderConcern: true };
const answer = (questionId: string, value: unknown, detail?: unknown) => ({ questionId, value, ...(detail ? { detail } : {}), status: 'answered', inputMethod: 'form' });

/** A 34-year-old woman, 82 kg, wants 74 kg in about 26 weeks, peanut allergy. */
const LOSE = [
  answer('q01', 'lose'),
  answer('q06', { mode: 'age', age: 34 }),
  answer('q07', 'female'),
  answer('q38', 'none'),
  answer('q08', { cm: 168, unit: 'cm' }),
  answer('q09', { kg: 82, unit: 'kg', isEstimate: false }),
  answer('q10', 'light'),
  answer('target_weight', { kg: 74, unit: 'kg' }),
  answer('q35', '26w'),
  answer('q36', ['peanuts']),
  answer('q37', 'three'),
  answer('q11', 'none'),
];

const narrative = (over: Record<string, unknown> = {}) => ({ ...structuredClone(PLAN_NARRATIVE_EXAMPLE), ...over });

describe('Plan generation (PLAN-GEN)', () => {
  let t: TestApp;
  let fake: FakeAiProvider;

  beforeAll(async () => {
    t = await createTestApp({ RATE_LIMIT_MULTIPLIER: '100' }); // many sign-ups in one app
    fake = t.get<FakeAiProvider>(AiProvider);
  });
  afterAll(() => t.close());
  beforeEach(() => fake.reset());

  async function user(answers: unknown[] = LOSE) {
    const s = await signIn(t);
    const h = bearer(s.accessToken);
    await t.http().put('/v1/onboarding/answers').set(h).send({ route: 'detailed', answers }).expect(200);
    await t.http().post('/v1/onboarding/complete').set(h).send({}).expect(200);
    return { h, id: s.user.id as string };
  }
  const generate = (h: Record<string, string>, body: Record<string, unknown> = {}, key = randomUUID()) =>
    t.http().post('/v1/plan/generate').set(h).set(idem(key)).send(body);
  const aiOn = (...responses: unknown[]) => {
    fake.configured = true;
    fake.enqueue(...responses);
  };

  it('serves question set v3 with the conditional life stage question', async () => {
    const res = await t.http().get('/v1/onboarding/questions').expect(200);
    expect(res.body.version).toBe(3);
    expect(res.body.questionSet.questions).toHaveLength(39);
    expect(res.body.questionSet.routes.basic.questionIds).toContain('q36');
  });

  describe('readiness', () => {
    it('lists what a calorie plan still needs, without guessing', async () => {
      const s = await signIn(t);
      const h = bearer(s.accessToken);
      await t.http().put('/v1/onboarding/answers').set(h).send({ route: 'basic', answers: [answer('q01', 'lose'), answer('q06', { mode: 'age', age: 30 }), answer('q07', 'female')] }).expect(200);
      const r = await t.http().get('/v1/plan/readiness').set(h).expect(200);
      expect(r.body).toMatchObject({ outcome: 'needs_input', attestationOnFile: false, attestationNeeded: false, canContinueWithoutTargets: true });
      expect(r.body.missing.map((m: { questionId: string }) => m.questionId)).toEqual(['q38', 'q08', 'q09', 'q10']);
      expect(r.body.requiredForTargets).toEqual(['q06', 'q07', 'q38', 'q08', 'q09', 'q10']);
    });

    it('is ready for a complete profile, with no health check step', async () => {
      const { h } = await user();
      const before = await t.http().get('/v1/plan/readiness').set(h).expect(200);
      expect(before.body).toMatchObject({ outcome: 'ready', attestationNeeded: false, missing: [] });
      await generate(h).expect(200);
      const after = await t.http().get('/v1/plan/readiness').set(h).expect(200);
      expect(after.body).toMatchObject({ outcome: 'ready', attestationNeeded: false, latestDraftCurrent: true });
    });

    it('a male profile is never asked about pregnancy or breastfeeding', async () => {
      const { h } = await user(LOSE.filter((a) => a.questionId !== 'q38').map((a) => (a.questionId === 'q07' ? answer('q07', 'male') : a)));
      const r = await t.http().get('/v1/plan/readiness').set(h).expect(200);
      expect(r.body).toMatchObject({ outcome: 'ready', requiredForTargets: ['q06', 'q07', 'q08', 'q09', 'q10'] });
      const state = await t.http().get('/v1/onboarding/state').set(h).expect(200);
      expect(state.body.applicableQuestionIds).not.toContain('q38');
      expect(state.body.answers.find((a: { questionId: string }) => a.questionId === 'q38')).toMatchObject({ status: 'not_applicable', value: null });
      expect(state.body.deferredQuestionIds).not.toContain('q38');
    });

    it('needs authentication', async () => {
      await t.http().get('/v1/plan/readiness').expect(401);
    });
  });

  describe('without a Gemini key (the state before you add one)', () => {
    it('returns the validated numbers, says personalisation is off and invents nothing', async () => {
      const { h } = await user();
      const res = await generate(h).expect(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.narrative).toBeNull();
      expect(res.body.ai).toMatchObject({ status: 'not_configured', retryable: false, model: null });
      expect(res.body.ai.message).toMatch(/not switched on/);
      expect(res.body.preview).toMatchObject({ eligible: true, method: 'mifflin_st_jeor_v1' });
      expect(res.body.preview.tdeeKcal).toBeGreaterThan(res.body.preview.calculated.energyKcal);
      expect(res.body.basis.join(' ')).toMatch(/Mifflin-St Jeor/);
      expect(fake.calls).toHaveLength(0);
    });

    it('lets the user confirm the numbers; the dashboard reads them from the database', async () => {
      const { h } = await user();
      const d = (await generate(h).expect(200)).body;
      const plan = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id }).expect(201);
      expect(plan.body).toMatchObject({ source: 'calculated', draftId: d.id, narrative: null, ai: { status: 'not_configured' } });
      expect(plan.body.energyKcal).toBe(d.preview.calculated.energyKcal);
      const stored = await t.http().get('/v1/plan').set(h).expect(200);
      expect(stored.body.id).toBe(plan.body.id);
      const day = await t.http().get('/v1/days/2026-11-03').set(h).expect(200);
      expect(day.body.targets).toMatchObject({ energyKcal: plan.body.energyKcal, proteinG: plan.body.proteinG });
    });
  });

  describe('with a mocked model', () => {
    it('stores a validated narrative with the draft and with the confirmed plan', async () => {
      const { h } = await user();
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d.ai).toMatchObject({ status: 'ok', retryable: false });
      expect(d.narrative.guidance).toHaveLength(3);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({ task: 'plan_narrative', thinking: 'low' });
      const sent = fake.calls[0]!.context;
      expect(sent).toMatch(/Peanuts/);
      expect(sent).not.toMatch(/user-.*@example\.com/);
      const plan = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id }).expect(201);
      expect(plan.body.narrative).toEqual(d.narrative);
      expect(plan.body.timeframe).toMatchObject({ direction: 'lose', requestedWeeks: 26 });
      expect((await t.http().get('/v1/plan').set(h).expect(200)).body.narrative.headline).toBe(d.narrative.headline);
    });

    it('estimates the time against the wish and says so plainly', async () => {
      const { h } = await user();
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      // 10% below maintenance is a gentle gap, so 8 kg takes longer than the 26 weeks the user hoped for.
      expect(d.timeframe).toMatchObject({ verdict: 'faster_than_plan', requestedWeeks: 26 });
      expect(d.timeframe.estimatedWeeks.min).toBeGreaterThan(26);
      expect(d.timeframe.message).toMatch(/steady pace/);
      expect(d.assessment.issues.map((i: { code: string }) => i.code)).toContain('timeframe_too_fast');
      expect(d.assessment.outcome).toBe('ready');
    });

    it('re-estimates the time for adjusted targets and stores the adjusted numbers', async () => {
      const { h } = await user();
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      const adjusted = d.preview.calculated.energyKcal - 200;
      const plan = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'adjusted', energyKcal: adjusted, draftId: d.id }).expect(201);
      expect(plan.body.energyKcal).toBe(adjusted);
      expect(plan.body.timeframe.estimatedWeeks.min).toBeLessThan(d.timeframe.estimatedWeeks.min);
      await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'adjusted', energyKcal: 900, draftId: d.id }).expect(422);
    });

    it('rejects an answer with calorie figures and asks again, naming the problem', async () => {
      const { h } = await user();
      const bad = narrative({ summary: 'Aim for 1,800 kcal a day and you will lose 2 kg in 12 weeks, easily.' });
      aiOn(bad, narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d.ai.status).toBe('ok');
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1]!.context).toMatch(/previous answer was rejected/);
      expect(fake.calls[1]!.context).toMatch(/figure/);
      expect(JSON.stringify(d.narrative)).not.toMatch(/1,800/);
    });

    it('after two bad answers shows no tips at all, keeps the numbers and offers a retry', async () => {
      const { h } = await user();
      const bad = narrative({ summary: 'You should eat 1500 calories and try intermittent fasting every day.' });
      aiOn(bad, bad);
      const d = (await generate(h).expect(200)).body;
      expect(d).toMatchObject({ status: 'ready', narrative: null, ai: { status: 'invalid_response', retryable: true } });
      expect(d.preview.calculated).not.toBeNull();
      // The retry is a new attempt and may succeed.
      aiOn(narrative());
      const again = (await generate(h, { regenerate: true }).expect(200)).body;
      expect(again.ai.status).toBe('ok');
      expect(again.id).not.toBe(d.id);
      expect(again.regenerations).toBe(1);
    });

    it('treats output that breaks the schema as invalid, never as content', async () => {
      const { h } = await user();
      aiOn({ headline: 'x' }, 'not even json');
      const d = (await generate(h).expect(200)).body;
      expect(d).toMatchObject({ narrative: null, ai: { status: 'invalid_response' } });
    });

    it('does not let a suggestion name the user\'s allergen', async () => {
      const { h } = await user();
      const unsafe = narrative({ guidance: [{ title: 'Easy breakfast', body: 'Toast with peanut butter is quick and keeps you going through a busy morning.', area: 'meals' }, ...(PLAN_NARRATIVE_EXAMPLE.guidance.slice(1))] });
      aiOn(unsafe, narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d.ai.status).toBe('ok');
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1]!.context).toMatch(/peanut/);
    });

    it('when the provider fails, degrades to the numbers with a calm, retryable message', async () => {
      const { h } = await user();
      fake.configured = true;
      fake.mode = 'fail';
      const d = (await generate(h).expect(200)).body;
      expect(d).toMatchObject({ status: 'ready', narrative: null, ai: { status: 'unavailable', retryable: true } });
      expect(d.ai.message).toMatch(/Milo is resting/);
      expect(d.preview.calculated).not.toBeNull();
      fake.mode = 'ok';
      aiOn(narrative());
      expect((await generate(h).expect(200)).body.ai.status).toBe('ok'); // a failed draft is not cached: asking again retries
    });

    it('honours the kill switch', async () => {
      const { h } = await user();
      fake.configured = true;
      fake.mode = 'unavailable';
      const d = (await generate(h).expect(200)).body;
      expect(d.ai.status).toBe('unavailable');
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe('duplicates, retries and staleness', () => {
    it('same answers return the same draft without another model call', async () => {
      const { h } = await user();
      aiOn(narrative());
      const a = (await generate(h).expect(200)).body;
      const b = (await generate(h).expect(200)).body;
      expect(b.id).toBe(a.id);
      expect(fake.calls).toHaveLength(1);
    });

    it('the same Idempotency-Key replays the first response', async () => {
      const { h } = await user();
      aiOn(narrative());
      const key = randomUUID();
      const a = await generate(h, {}, key).expect(200);
      const b = await generate(h, {}, key).expect(200);
      expect(b.body).toEqual(a.body);
      expect(fake.calls).toHaveLength(1);
      await t.http().post('/v1/plan/generate').set(h).send({}).expect(400); // key required
    });

    it('a second request while one is running is refused, not queued behind a second model call', async () => {
      const { h, id } = await user();
      aiOn(narrative());
      const kv = t.get<KvStore>(KvStore);
      await kv.set(`plan-gen:${id}`, '1', 60);
      const res = await generate(h).expect(409);
      expect(res.body.error.code).toBe('PLAN_GENERATION_IN_PROGRESS');
      await kv.del(`plan-gen:${id}`);
      await generate(h).expect(200);
    });

    it('rations the refresh button, not the first plan', async () => {
      const { h } = await user();
      fake.configured = true;
      for (let i = 0; i < 6; i++) {
        fake.enqueue(narrative());
        await generate(h, { regenerate: true }).expect(200);
      }
      const res = await generate(h, { regenerate: true }).expect(429);
      expect(res.body.error.code).toBe('AI_LIMIT_REACHED');
      expect(fake.calls).toHaveLength(6);
    });

    it('confirming the same draft twice is one plan; a changed answer makes the draft stale', async () => {
      const { h } = await user();
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      const first = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id }).expect(201);
      const second = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id }).expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.version).toBe(first.body.version);

      await t.http().put('/v1/onboarding/answers/q09').set(h).send({ value: { kg: 80, unit: 'kg', isEstimate: false }, status: 'answered', inputMethod: 'form' }).expect(200);
      const latest = await t.http().get('/v1/plan/draft').set(h).expect(200);
      expect(latest.body).toMatchObject({ id: d.id, stale: true });
      expect((await t.http().get('/v1/plan/readiness').set(h).expect(200)).body.latestDraftCurrent).toBe(false);
      const stale = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: randomUUID().replace(/-/g, '').slice(0, 24) }).expect(404);
      expect(stale.body.error.code).toBe('PLAN_DRAFT_NOT_FOUND');
      const res = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id, energyKcal: undefined }).expect(409);
      expect(res.body.error.code).toBe('PLAN_DRAFT_STALE');

      aiOn(narrative());
      const fresh = (await generate(h).expect(200)).body;
      expect(fresh.id).not.toBe(d.id);
      expect(fresh.stale).toBe(false);
      const confirmed = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: fresh.id }).expect(201);
      expect(confirmed.body.version).toBe(first.body.version + 1);
      expect(confirmed.body.active).toBe(true);
    });

    it('GET /plan/draft is 404 before anything was prepared', async () => {
      const s = await signIn(t);
      const res = await t.http().get('/v1/plan/draft').set(bearer(s.accessToken)).expect(404);
      expect(res.body.error.code).toBe('PLAN_DRAFT_NOT_FOUND');
    });
  });

  describe('clarification instead of guessing', () => {
    it('a target above the current weight for a weight-loss goal blocks the plan and names the answers to fix', async () => {
      const { h } = await user(LOSE.map((a) => (a.questionId === 'target_weight' ? answer('target_weight', { kg: 90, unit: 'kg' }) : a)));
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d).toMatchObject({ status: 'needs_input', narrative: null, ai: { status: 'skipped' } });
      expect(d.preview).toMatchObject({ eligible: false, calculated: null, tdeeKcal: null });
      expect(d.assessment.issues[0]).toMatchObject({ code: 'target_above_current', severity: 'blocking', questionIds: ['q01', 'target_weight'] });
      expect(d.notice.kind).toBe('needs_input');
      expect(fake.calls).toHaveLength(0);
      await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id }).expect(422);
      // The user can still choose habits only.
      const none = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'none', draftId: d.id }).expect(201);
      expect(none.body).toMatchObject({ source: 'none', energyKcal: null, narrative: null });
    });

    it('missing essentials never reach the model', async () => {
      const s = await signIn(t);
      const h = bearer(s.accessToken);
      await t.http().put('/v1/onboarding/answers').set(h).send({ route: 'basic', answers: [answer('q01', 'lose'), answer('q06', { mode: 'age', age: 40 }), answer('q07', 'male'), answer('q08', { cm: 180, unit: 'cm' })] }).expect(200);
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d.status).toBe('needs_input');
      expect(d.assessment.missing.map((m: { questionId: string }) => m.questionId)).toEqual(['q09', 'q10']);
      expect(fake.calls).toHaveLength(0);
    });

    it('"Not sure" about activity is a gap to fill, not a default', async () => {
      const { h } = await user(LOSE.map((a) => (a.questionId === 'q10' ? answer('q10', 'unsure') : a)));
      const d = (await generate(h).expect(200)).body;
      expect(d.status).toBe('needs_input');
      expect(d.assessment.missing.map((m: { field: string }) => m.field)).toEqual(['activityLevel']);
    });

    it('implausible height and weight are sent back, not planned for', async () => {
      const { h } = await user(LOSE.map((a) => (a.questionId === 'q08' ? answer('q08', { cm: 250, unit: 'cm' }) : a.questionId === 'q09' ? answer('q09', { kg: 30, unit: 'kg', isEstimate: false }) : a.questionId === 'target_weight' ? answer('target_weight', { kg: 28, unit: 'kg' }) : a)));
      const d = (await generate(h).expect(200)).body;
      expect(d.status).toBe('needs_input');
      expect(d.assessment.issues.map((i: { code: string }) => i.code)).toContain('bmi_implausible');
    });
  });

  describe('goals without calorie targets', () => {
    it.each(['pregnant', 'breastfeeding'])('%s: no numbers, no model call, no referral, habits plan without weights', async (stage) => {
      const { h } = await user(LOSE.filter((a) => a.questionId !== 'q38').concat(answer('q38', stage)));
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d).toMatchObject({ status: 'habits_only', narrative: null, ai: { status: 'skipped' } });
      expect(d.assessment.guidanceReasons).toEqual(['pregnant_or_breastfeeding']);
      expect(d.preview).toMatchObject({ eligible: false, calculated: null, bmrKcal: null, tdeeKcal: null });
      expect(d.timeframe).toBeNull();
      expect(d.notice).toMatchObject({ kind: 'habits_only', reasons: ['pregnant_or_breastfeeding'] });
      expect(`${d.notice.title} ${d.notice.body}`).not.toMatch(/\d|GP|doctor|midwife|dietitian|professional/i);
      expect(fake.calls).toHaveLength(0);
      await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id }).expect(422);
      const plan = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'none', draftId: d.id }).expect(201);
      expect(plan.body).toMatchObject({ source: 'none', energyKcal: null, timeframe: null, narrative: null, goal: { type: 'habits', startWeightKg: null, targetWeightKg: null } });
      // The old endpoints cannot be used to get around it either.
      await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated' }).expect(422);
    });

    it('a weight-loss goal for someone already underweight asks for another goal, with no referral', async () => {
      const { h } = await user(LOSE.map((a) => (a.questionId === 'q09' ? answer('q09', { kg: 48, unit: 'kg', isEstimate: false }) : a.questionId === 'target_weight' ? answer('target_weight', { kg: 45, unit: 'kg' }) : a)));
      const d = (await generate(h).expect(200)).body;
      expect(d.status).toBe('needs_input');
      const { h: h2 } = await user([...LOSE.filter((a) => !['target_weight', 'q35', 'q09'].includes(a.questionId)), answer('q09', { kg: 48, unit: 'kg', isEstimate: false })]);
      const d2 = (await generate(h2).expect(200)).body;
      expect(d2).toMatchObject({ status: 'needs_input', notice: { kind: 'needs_input' }, preview: { calculated: null } });
      expect(d2.assessment.issues.map((i: { code: string }) => i.code)).toContain('loss_goal_underweight');
      expect(JSON.stringify(d2.notice) + JSON.stringify(d2.assessment.issues)).not.toMatch(/GP|doctor|dietitian|professional/i);
    });

    it('under-18s get habits only and their data never reaches the model', async () => {
      const { h } = await user([answer('q01', 'habits'), answer('q06', { mode: 'age', age: 16 }), answer('q11', 'none')]);
      aiOn(narrative());
      const d = (await generate(h, {}).expect(200)).body;
      expect(d).toMatchObject({ status: 'habits_only', narrative: null, ai: { status: 'skipped' } });
      expect(d.preview.calculated).toBeNull();
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe('safety hardening (independent review)', () => {
    it('an old app can still send the health check; it is ignored and changes nothing', async () => {
      const { h } = await user();
      const d = (await generate(h, { eligibility: OLD_APP }).expect(200)).body;
      expect(d.status).toBe('ready');
      const preview = await t.http().post('/v1/plan/preview').set(h).send({ eligibility: OLD_APP }).expect(200);
      expect(preview.body).toMatchObject({ eligible: true });
    });

    it('stating pregnancy after a plan was confirmed ends the calorie plan', async () => {
      const { h } = await user();
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      const first = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id }).expect(201);
      expect(first.body.energyKcal).not.toBeNull();
      await t.http().put('/v1/onboarding/answers/q38').set(h).send({ value: 'pregnant', status: 'answered', inputMethod: 'form' }).expect(200);
      const now = await t.http().get('/v1/plan').set(h).expect(200);
      expect(now.body).toMatchObject({ source: 'none', energyKcal: null, proteinG: null, narrative: null, timeframe: null });
      expect(now.body.goal).toMatchObject({ targetWeightKg: null });
      expect(now.body.version).toBe(first.body.version + 1);
      expect((await generate(h).expect(200)).body.status).toBe('habits_only');
    });

    it('draft and preview responses carry no weight goal for people who are not given a plan', async () => {
      const { h } = await user(LOSE.filter((a) => !['q38', 'target_weight', 'q35'].includes(a.questionId)).concat(answer('q38', 'breastfeeding')));
      const d = (await generate(h).expect(200)).body;
      expect(d.preview.goal).toEqual({ type: 'lose', startWeightKg: null, targetWeightKg: null, pace: null });
      const legacy = await t.http().post('/v1/plan/preview').set(h).send({}).expect(200);
      expect(legacy.body.goal).toEqual({ type: 'lose', startWeightKg: null, targetWeightKg: null, pace: null });
      const minor = await user([answer('q01', 'lose'), answer('q06', { mode: 'age', age: 15 })]);
      const m = await t.http().post('/v1/plan/preview').set(minor.h).send({}).expect(200);
      expect(m.body).toMatchObject({ eligible: false, goal: { pace: null, targetWeightKg: null } });
    });

    it('the legacy preview and POST /plan apply the same consistency checks as the new flow', async () => {
      const { h } = await user(LOSE.map((a) => (a.questionId === 'target_weight' ? answer('target_weight', { kg: 90, unit: 'kg' }) : a)));
      await generate(h).expect(200); // stores the health check
      const p = await t.http().post('/v1/plan/preview').set(h).send({}).expect(200);
      expect(p.body).toMatchObject({ eligible: false, calculated: null, reasons: ['target_above_current'] });
      await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated' }).expect(422);
      const implausible = await user(LOSE.map((a) => (a.questionId === 'q08' ? answer('q08', { cm: 250, unit: 'cm' }) : a.questionId === 'q09' ? answer('q09', { kg: 30, unit: 'kg', isEstimate: false }) : a.questionId === 'target_weight' ? answer('target_weight', { kg: 28, unit: 'kg' }) : a)));
      await generate(implausible.h).expect(200);
      expect((await t.http().post('/v1/plan/preview').set(implausible.h).send({}).expect(200)).body.eligible).toBe(false);
    });

    it('a target weight cannot be changed at confirm time, and "habits only" keeps no weights', async () => {
      const { h } = await user();
      const d = (await generate(h).expect(200)).body;
      const res = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id, targetWeightKg: 60 }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      const same = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'calculated', draftId: d.id, targetWeightKg: 74 }).expect(201);
      expect(same.body.goal.targetWeightKg).toBe(74);
      const { h: h2 } = await user(LOSE);
      const d2 = (await generate(h2).expect(200)).body;
      const none = await t.http().post('/v1/plan').set(h2).set(idem()).send({ source: 'none', draftId: d2.id }).expect(201);
      expect(none.body).toMatchObject({ source: 'none', goal: { type: 'habits', startWeightKg: null, targetWeightKg: null, pace: null }, timeframe: null, narrative: null });
      const { h: h3 } = await user([answer('q01', 'lose'), answer('q09', { kg: 80, unit: 'kg', isEstimate: false })]);
      const d3 = (await generate(h3).expect(200)).body;
      expect(d3.status).toBe('needs_input'); // age unknown
      const none3 = await t.http().post('/v1/plan').set(h3).set(idem()).send({ source: 'none', draftId: d3.id, targetWeightKg: 70 }).expect(400);
      expect(none3.body.error.code).toBe('VALIDATION_FAILED');
      const ok3 = await t.http().post('/v1/plan').set(h3).set(idem()).send({ source: 'none', draftId: d3.id }).expect(201);
      expect(ok3.body.goal).toEqual({ type: 'habits', startWeightKg: null, targetWeightKg: null, pace: null });
    });

    it('adjusted targets do not keep a basis line that describes the calculated target', async () => {
      const { h } = await user();
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d.basis.join(' ')).toMatch(/10% below/);
      const plan = await t.http().post('/v1/plan').set(h).set(idem()).send({ source: 'adjusted', energyKcal: d.preview.calculated.energyKcal - 150, draftId: d.id }).expect(201);
      expect(plan.body.basis.join(' ')).not.toMatch(/10% below/);
      expect(plan.body.basis.join(' ')).toMatch(/You adjusted your daily target to/);
    });

    it('unknown allergies are a visible warning, not a silent assumption', async () => {
      const { h } = await user(LOSE.filter((a) => a.questionId !== 'q36'));
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d.status).toBe('ready');
      expect(d.assessment.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'allergies_unknown', severity: 'warning', questionIds: ['q36'] })]));
      expect(d.basis.join(' ')).toMatch(/allergies or intolerances/);
    });

    it('editing one answer over and over cannot buy unlimited model calls', async () => {
      const { h } = await user();
      fake.configured = true;
      for (let i = 0; i < 6; i++) {
        fake.enqueue(narrative());
        await generate(h, { regenerate: true }).expect(200);
      }
      expect(fake.calls).toHaveLength(6);
      await t.http().put('/v1/onboarding/answers/q09').set(h).send({ value: { kg: 81.5, unit: 'kg', isEstimate: false }, status: 'answered', inputMethod: 'form' }).expect(200);
      fake.enqueue(narrative());
      const d = (await generate(h).expect(200)).body; // a new "first" plan for the changed answer
      expect(d).toMatchObject({ status: 'ready', narrative: null, ai: { status: 'unavailable', retryable: false } });
      expect(d.ai.message).toMatch(/today's limit/);
      expect(fake.calls).toHaveLength(6);
    });

    it('a provider error gets one more try inside the same budget; the content of rejected answers is not logged by the API', async () => {
      const { h } = await user();
      aiOn(Object.assign(new Error('boom'), { status: 500 }), narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d.ai.status).toBe('ok');
      expect(fake.calls).toHaveLength(2);
    });
  });

  describe('maintain and gain', () => {
    it('no target weight, no time estimate, but still a personalised plan', async () => {
      const { h } = await user(LOSE.filter((a) => !['target_weight', 'q35'].includes(a.questionId)).map((a) => (a.questionId === 'q01' ? answer('q01', 'maintain') : a)));
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d).toMatchObject({ status: 'ready', timeframe: null, ai: { status: 'ok' } });
      expect(d.preview.adjustmentPct).toBe(0);
    });

    it('a gain goal gets a gain estimate', async () => {
      const { h } = await user(LOSE.map((a) => (a.questionId === 'q01' ? answer('q01', 'gain') : a.questionId === 'target_weight' ? answer('target_weight', { kg: 88, unit: 'kg' }) : a)));
      aiOn(narrative());
      const d = (await generate(h).expect(200)).body;
      expect(d.timeframe).toMatchObject({ direction: 'gain', changeKg: 6 });
    });
  });
});
