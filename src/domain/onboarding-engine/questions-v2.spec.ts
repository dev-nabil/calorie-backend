import { loadContentJson } from '../../../test/fixtures/onboarding/load-content';
import {
  applicableQuestions,
  applyAnswers,
  deferredQuestions,
  deferUnanswered,
  loadFlowTurns,
  loadQuestionSet,
  nextFlowTurn,
  nextQuestion,
  openQuestions,
  profileFromAnswers,
  volunteerableQuestions,
  type AnswerUpdate,
  type EngineContext,
} from './index';

const v1 = loadQuestionSet(loadContentJson('questions.v1.json'));
const v2 = loadQuestionSet(loadContentJson('questions.v2.json'));
const today = '2026-11-03';
const ctx = (route: EngineContext['route']): EngineContext => ({ route, today });
const a = (questionId: string, value: AnswerUpdate['value'], detail?: AnswerUpdate['detail']): AnswerUpdate => ({ questionId, status: 'answered', value, detail });

const ADULT_LOSE: AnswerUpdate[] = [
  a('q01', 'lose'),
  a('q06', { mode: 'age', age: 34 }),
  a('q07', 'female'),
  a('q08', { cm: 168, unit: 'cm' }),
  a('q09', { kg: 82, unit: 'kg', isEstimate: false }),
  a('q10', 'light'),
];

describe('questions v2', () => {
  it('keeps every v1 question, field key, type and option id', () => {
    for (const q1 of v1.questions) {
      const q2 = v2.byId[q1.id];
      expect(q2).toBeDefined();
      expect(q2!.fieldKey).toBe(q1.fieldKey);
      expect(q2!.type).toBe(q1.type);
      for (const o of q1.options) expect(q2!.options.map((x) => x.id)).toContain(o.id);
    }
    expect(v2.questions).toHaveLength(v1.questions.length + 3);
  });

  it('puts allergies on the basic route (safety relevant) but not the timeframe', () => {
    expect(v2.routes.basic.questionIds).toContain('q36');
    expect(v2.routes.basic.questionIds).not.toContain('q35');
    expect(v2.routes.detailed.questionIds).toEqual(v2.questions.map((q) => q.id));
  });

  it('asks the timeframe only once a target weight exists', () => {
    const noTarget = applyAnswers(v2, {}, ADULT_LOSE, ctx('detailed')).answers;
    expect(applicableQuestions(v2, noTarget, ctx('detailed'))).not.toContain('q35');
    const withTarget = applyAnswers(v2, noTarget, [a('target_weight', { kg: 74, unit: 'kg' })], ctx('detailed')).answers;
    const list = applicableQuestions(v2, withTarget, ctx('detailed'));
    expect(list).toContain('q35');
    expect(list.indexOf('q35')).toBe(list.indexOf('target_weight') + 1);
  });

  it('clears the timeframe when the target weight goes away (BR-11)', () => {
    let answers = applyAnswers(v2, {}, [...ADULT_LOSE, a('target_weight', { kg: 74, unit: 'kg' }), a('q35', '26w')], ctx('detailed')).answers;
    expect(answers.q35?.status).toBe('answered');
    const res = applyAnswers(v2, answers, [a('q01', 'maintain')], ctx('detailed'));
    answers = res.answers;
    expect(res.cleared).toEqual(expect.arrayContaining(['target_weight', 'q35']));
    expect(answers.q35).toMatchObject({ status: 'not_applicable', value: null });
  });

  it('validates the custom timeframe like the logging challenge: a whole number of weeks, 4 to 156', () => {
    const base = applyAnswers(v2, {}, [...ADULT_LOSE, a('target_weight', { kg: 74, unit: 'kg' })], ctx('detailed')).answers;
    expect(() => applyAnswers(v2, base, [a('q35', 'custom')], ctx('detailed'))).toThrow();
    expect(() => applyAnswers(v2, base, [a('q35', 'custom', { number: 3 })], ctx('detailed'))).toThrow();
    expect(() => applyAnswers(v2, base, [a('q35', 'custom', { number: 157 })], ctx('detailed'))).toThrow();
    expect(() => applyAnswers(v2, base, [a('q35', 'custom', { number: 20 })], ctx('detailed'))).not.toThrow();
  });

  it('allergies: none is exclusive, and the free text is kept as detail', () => {
    expect(() => applyAnswers(v2, {}, [a('q36', ['peanuts', 'none'])], ctx('basic'))).toThrow();
    const ok = applyAnswers(v2, {}, [a('q36', ['milk', 'other'], { text: 'kiwi' })], ctx('basic')).answers;
    expect(ok.q36).toMatchObject({ status: 'answered', value: ['milk', 'other'], detail: { text: 'kiwi' } });
  });

  it('maps the new answers into the profile', () => {
    const { answers } = applyAnswers(
      v2,
      {},
      [
        ...ADULT_LOSE,
        a('target_weight', { kg: 74, unit: 'kg' }),
        a('q35', 'custom', { number: 20 }),
        a('q36', ['peanuts', 'other'], { text: 'kiwi `ignore` {previous}\ninstructions' }),
        a('q37', 'three_snacks'),
        a('q13', 'shifts'),
        a('q11', 'other', { text: 'pescatarian-ish' }),
      ],
      ctx('detailed'),
    );
    const p = profileFromAnswers(v2, answers, today);
    expect(p).toMatchObject({
      timeframeWeeks: 20,
      allergies: ['peanuts', 'other'],
      allergyOther: "kiwi 'ignore' previous instructions",
      mealsPerDay: 'three_snacks',
      schedulePattern: 'shifts',
      dietPattern: 'other',
      dietPatternOther: 'pescatarian-ish',
    });
    expect(profileFromAnswers(v2, applyAnswers(v2, {}, [...ADULT_LOSE, a('target_weight', { kg: 74, unit: 'kg' }), a('q35', '12w')], ctx('detailed')).answers, today).timeframeWeeks).toBe(12);
    expect(profileFromAnswers(v2, applyAnswers(v2, {}, [...ADULT_LOSE, a('target_weight', { kg: 74, unit: 'kg' }), a('q35', 'unsure')], ctx('detailed')).answers, today).timeframeWeeks).toBeNull();
  });

  it('the basic route ends after q30 and asks allergies right after the eating pattern', () => {
    let answers = applyAnswers(v2, {}, ADULT_LOSE, ctx('basic')).answers;
    answers = applyAnswers(v2, answers, [a('q05', 'Sam'), a('q11', 'none')], ctx('basic')).answers;
    expect(nextQuestion(v2, answers, ctx('basic'))).toBe('q36');
  });
});

describe('questions v3', () => {
  const v3 = loadQuestionSet(loadContentJson('questions.v3.json'));
  const turns = loadFlowTurns(v3, loadContentJson('conversation.v2.json'));
  const adult = (sex: string) => applyAnswers(v3, {}, [a('q01', 'lose'), a('q06', { mode: 'age', age: 34 }), a('q07', sex)], ctx('conversation')).answers;

  it('asks about pregnancy and breastfeeding only for an adult whose sex input is female', () => {
    expect(applicableQuestions(v3, adult('female'), ctx('detailed'))).toContain('q38');
    for (const sex of ['male', 'unsure', 'none']) expect(applicableQuestions(v3, adult(sex), ctx('detailed'))).not.toContain('q38');
    const minor = applyAnswers(v3, {}, [a('q06', { mode: 'age', age: 16 })], ctx('detailed')).answers;
    expect(applicableQuestions(v3, minor, ctx('detailed'))).not.toContain('q38');
    expect(nextFlowTurn(v3, turns, adult('male'), {}, ctx('conversation'))?.turn.id).toBe('name_goal');
  });

  it('marks the question not applicable and drops its value when the sex input changes (BR-11)', () => {
    const female = applyAnswers(v3, adult('female'), [a('q38', 'pregnant')], ctx('detailed')).answers;
    const res = applyAnswers(v3, female, [a('q07', 'male')], ctx('detailed'));
    expect(res.cleared).toContain('q38');
    expect(res.answers.q38).toMatchObject({ status: 'not_applicable', value: null });
    expect(profileFromAnswers(v3, res.answers, today).lifeStage).toBeNull();
  });

  it('a decline is kept apart from a question never asked', () => {
    const skipped = applyAnswers(v3, adult('female'), [{ questionId: 'q38', status: 'skipped' }], ctx('detailed')).answers;
    expect(profileFromAnswers(v3, skipped, today).lifeStage).toBe('declined');
    expect(profileFromAnswers(v3, adult('female'), today).lifeStage).toBeNull();
  });

  it('never asks for a target weight while pregnant or breastfeeding', () => {
    const base = applyAnswers(v3, adult('female'), [a('q08', { cm: 168, unit: 'cm' }), a('q09', { kg: 82, unit: 'kg', isEstimate: false })], ctx('detailed')).answers;
    expect(applicableQuestions(v3, applyAnswers(v3, base, [a('q38', 'none')], ctx('detailed')).answers, ctx('detailed'))).toContain('target_weight');
    expect(applicableQuestions(v3, applyAnswers(v3, base, [a('q38', 'pregnant')], ctx('detailed')).answers, ctx('detailed'))).not.toContain('target_weight');
  });

  it('asks the sex input before height and weight, so nothing said is dropped when none is chosen', () => {
    const ids = turns.map((t) => t.id);
    expect(ids.indexOf('sex_input')).toBeLessThan(ids.indexOf('body'));
    const none = adult('none');
    expect(nextFlowTurn(v3, turns, { ...none, q05: { value: 'Sam', status: 'answered' } }, {}, ctx('conversation'))?.turn.id).toBe('food');
  });

  it('completion stores what does not apply, so it can never block', () => {
    const { answers } = deferUnanswered(v3, adult('male'), ctx('conversation'));
    expect(answers.q38).toMatchObject({ status: 'not_applicable', value: null });
    expect(answers.q08).toMatchObject({ status: 'deferred' });
    expect(deferredQuestions(v3, answers, ctx('conversation'))).not.toContain('q38');
  });

  it('does not ask for weight on its own once height is declined', () => {
    const answers = applyAnswers(v3, adult('male'), [{ questionId: 'q08', status: 'skipped' }], ctx('conversation')).answers;
    const body = turns.find((t) => t.id === 'body')!;
    expect(openQuestions(v3, body, answers, {}, ctx('conversation'))).toEqual([]);
  });

  it('listens for later answers, but never for the questions that always get their own turn', () => {
    const later = volunteerableQuestions(v3, turns, {}, {}, ctx('conversation'), ['q05', 'q01']);
    expect(later).toEqual(expect.arrayContaining(['q06', 'q08', 'q09', 'q10', 'q11', 'q36']));
    expect(later).not.toContain('q07');
    expect(later).not.toContain('q38');
    expect(later).not.toContain('q05');
    const minor = applyAnswers(v3, {}, [a('q06', { mode: 'age', age: 15 })], ctx('conversation')).answers;
    expect(volunteerableQuestions(v3, turns, minor, {}, ctx('conversation'), [])).not.toContain('q09');
  });
});

describe('questions v4 (decision 0017)', () => {
  const v3 = loadQuestionSet(loadContentJson('questions.v3.json'));
  const v4 = loadQuestionSet(loadContentJson('questions.v4.json'));
  const v4bn = loadQuestionSet(loadContentJson('questions.v4.bn.json'));
  const d = ctx('detailed');
  const body: AnswerUpdate[] = [a('q06', { mode: 'age', age: 34 }), a('q07', 'male'), a('q08', { cm: 180, unit: 'cm' }), a('q09', { kg: 82, unit: 'kg', isEstimate: false })];
  const adult = (goal: string, ...more: AnswerUpdate[]) => applyAnswers(v4, {}, [a('q01', goal), ...body, ...more], d).answers;
  const optionIds = (id: string) => v4.questions.find((q) => q.id === id)!.options.map((o) => o.id);

  it('adds q39, q40 and q41 and changes no earlier question or option', () => {
    expect(v4.version).toBe(4);
    expect(v4.questions.map((q) => q.id).filter((id) => !v3.questions.some((q) => q.id === id))).toEqual(['q39', 'q40', 'q41']);
    for (const q3 of v3.questions) {
      const q4 = v4.questions.find((q) => q.id === q3.id)!;
      expect([q4.id, q4.fieldKey, q4.type, q4.options.map((o) => o.id)]).toEqual([q3.id, q3.fieldKey, q3.type, q3.options.map((o) => o.id)]);
    }
    expect(v4.questions.filter((q) => ['q39', 'q40', 'q41'].includes(q.id)).map((q) => [q.id, q.fieldKey, q.type, q.required])).toEqual([
      ['q39', 'day_activity', 'single', false],
      ['q40', 'exercise_frequency', 'single', false],
      ['q41', 'goal_pace', 'single', false],
    ]);
    expect(optionIds('q39')).toEqual(['seated', 'standing', 'moving', 'physical']);
    expect(optionIds('q40')).toEqual(['none', 'one_two', 'three_four', 'five_plus']);
    expect(optionIds('q41')).toEqual(['gentle', 'steady', 'faster']);
    // No "not sure" on the behaviour questions: everybody can answer them.
    expect([...optionIds('q39'), ...optionIds('q40')]).not.toContain('unsure');
    // The Bangla file has the same ids and rules.
    expect(v4bn.questions.map((q) => [q.id, q.options.map((o) => o.id)])).toEqual(v4.questions.map((q) => [q.id, q.options.map((o) => o.id)]));
    // The app's old goal route and the voice route are untouched (owner rule).
    const raw4 = loadContentJson('questions.v4.json') as { routes: Record<string, { questionIds: string[] }> };
    const raw3 = loadContentJson('questions.v3.json') as { routes: Record<string, { questionIds: string[] }> };
    expect(raw4.routes.basic).toEqual(raw3.routes.basic);
    expect(raw4.routes.conversation).toEqual(raw3.routes.conversation);
  });

  it('asks the usual day and exercise where q10 was asked, then the target weight and the pace', () => {
    const order = v4.questions.map((q) => q.id);
    expect(order.slice(order.indexOf('q09'), order.indexOf('q35') + 1)).toEqual(['q09', 'q39', 'q40', 'q10', 'target_weight', 'q41', 'q35']);
    // Same condition as q10: an adult with a sex input, height and weight.
    expect(applicableQuestions(v4, adult('maintain'), d)).toEqual(expect.arrayContaining(['q39', 'q40', 'q10']));
    const noWeight = applyAnswers(v4, {}, [a('q01', 'lose'), a('q06', { mode: 'age', age: 34 }), a('q07', 'male'), a('q08', { cm: 180, unit: 'cm' })], d).answers;
    for (const id of ['q39', 'q40', 'q10', 'q41']) expect(applicableQuestions(v4, noWeight, d)).not.toContain(id);
    const minor = applyAnswers(v4, {}, [a('q01', 'lose'), a('q06', { mode: 'age', age: 16 })], d).answers;
    for (const id of ['q39', 'q40', 'q41']) expect(applicableQuestions(v4, minor, d)).not.toContain(id);
    expect(nextQuestion(v4, adult('lose', a('q02', ['energy']), a('q03', 'proud'), a('q04', ['logging']), a('q05', 'Sam')), d)).toBe('q39');
  });

  it('hides and clears q10 once q39 and q40 are both answered: the two-part answer wins', () => {
    const old = adult('maintain', a('q10', 'intense'));
    expect(profileFromAnswers(v4, old, today)).toMatchObject({ activityLevel: 'intense', dayActivity: null, exerciseFrequency: null });
    // One half alone changes nothing.
    const half = applyAnswers(v4, old, [a('q39', 'seated')], d);
    expect(half.cleared).not.toContain('q10');
    expect(applicableQuestions(v4, half.answers, d)).toContain('q10');
    expect(profileFromAnswers(v4, half.answers, today)).toMatchObject({ activityLevel: 'intense', dayActivity: 'seated', exerciseFrequency: null });
    // Both: q10 goes, and the level other features read is derived from the factor (1.2 + 0.15 = 1.35 → light).
    const both = applyAnswers(v4, half.answers, [a('q40', 'three_four')], d);
    expect(both.cleared).toContain('q10');
    // Hiding q10 this way is not an incomplete calculation: its own rule (BR-Q10TWOPART) carries no effect.
    expect(both.effects).not.toContain('calculation_incomplete');
    expect(v4.rulesByQuestion.q10!.map((r) => [r.id, r.onHide?.effects])).toEqual([['BR-Q10', ['calculation_incomplete']], ['BR-Q10TWOPART', []]]);
    expect(v4.rulesByQuestion.q10![0]!.when).toEqual(v3.rulesByQuestion.q10![0]!.when);
    expect(both.answers.q10).toMatchObject({ status: 'not_applicable', value: null });
    expect(applicableQuestions(v4, both.answers, d)).not.toContain('q10');
    expect(profileFromAnswers(v4, both.answers, today)).toMatchObject({ activityLevel: 'light', dayActivity: 'seated', exerciseFrequency: 'three_four' });
    // An app that only knows q10 still gets asked q10 while the pair is open.
    expect(applicableQuestions(v4, adult('maintain'), ctx('basic'))).toContain('q10');
    // The v3 rule still reports an incomplete calculation when the weight goes (it hides q10, q39 and q40 alike).
    const noWeight = applyAnswers(v4, both.answers, [{ questionId: 'q09', status: 'skipped' }], d);
    expect(noWeight.effects).toContain('calculation_incomplete');
    expect(noWeight.cleared).toEqual(expect.arrayContaining(['q39', 'q40']));
    expect(profileFromAnswers(v4, noWeight.answers, today)).toMatchObject({ activityLevel: null, dayActivity: null, exerciseFrequency: null });
  });

  it('asks the pace only for a lose or gain goal, never while pregnant or breastfeeding', () => {
    for (const goal of ['lose', 'gain']) expect(applicableQuestions(v4, adult(goal), d)).toEqual(expect.arrayContaining(['target_weight', 'q41']));
    for (const goal of ['maintain', 'habits', 'patterns', 'decide']) expect(applicableQuestions(v4, adult(goal), d)).not.toContain('q41');
    const female = (stage: string) => applyAnswers(v4, {}, [a('q01', 'lose'), ...body, a('q07', 'female'), a('q38', stage)], d).answers;
    expect(applicableQuestions(v4, female('none'), d)).toContain('q41');
    expect(applicableQuestions(v4, female('pregnant'), d)).not.toContain('q41');
    expect(applicableQuestions(v4, female('breastfeeding'), d)).not.toContain('q41');
    // Changing the goal drops the pace (BR-11).
    const paced = applyAnswers(v4, adult('lose'), [a('q41', 'faster')], d).answers;
    expect(profileFromAnswers(v4, paced, today).goalPace).toBe('faster');
    const res = applyAnswers(v4, paced, [a('q01', 'maintain')], d);
    expect(res.cleared).toContain('q41');
    expect(profileFromAnswers(v4, res.answers, today).goalPace).toBeNull();
    // A skipped pace is not a pace.
    const skipped = applyAnswers(v4, adult('lose'), [{ questionId: 'q41', status: 'skipped' }], d).answers;
    expect(profileFromAnswers(v4, skipped, today).goalPace).toBeNull();
  });

  it('the usual day also opens the movement question (q27)', () => {
    expect(applicableQuestions(v4, adult('maintain'), d)).not.toContain('q27');
    expect(applicableQuestions(v4, adult('maintain', a('q39', 'moving')), d)).toContain('q27');
  });

  it('rejects an option the bank does not have', () => {
    expect(() => applyAnswers(v4, adult('lose'), [a('q39', 'unsure')], d)).toThrow();
    expect(() => applyAnswers(v4, adult('lose'), [a('q41', 'gradual')], d)).toThrow();
  });
});
