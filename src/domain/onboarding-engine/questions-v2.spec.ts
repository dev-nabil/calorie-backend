import { loadContentJson } from '../../../test/fixtures/onboarding/load-content';
import { applicableQuestions, applyAnswers, loadQuestionSet, nextQuestion, profileFromAnswers, type AnswerUpdate, type EngineContext } from './index';

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
