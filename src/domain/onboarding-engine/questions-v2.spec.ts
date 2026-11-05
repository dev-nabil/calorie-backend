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
