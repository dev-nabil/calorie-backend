import { loadContentJson } from '../../../test/fixtures/onboarding/load-content';
import { DomainError } from '../errors';
import {
  applicableQuestions,
  applyAnswers,
  clearStale,
  deferredQuestions,
  deferUnanswered,
  isApplicable,
  loadQuestionSet,
  nextQuestion,
  type AnswerMap,
  type AnswerUpdate,
  type EngineContext,
} from './index';

const set = loadQuestionSet(loadContentJson('questions.v1.json'));
const today = '2026-11-02';
const detailed: EngineContext = { route: 'detailed', today };
const basic: EngineContext = { route: 'basic', today };
const conversation: EngineContext = { route: 'conversation', today };

const a = (questionId: string, value: AnswerUpdate['value'], extra: Partial<AnswerUpdate> = {}): AnswerUpdate => ({
  questionId,
  status: 'answered',
  value,
  inputMethod: 'form',
  ...extra,
});
const apply = (updates: AnswerUpdate[], answers: AnswerMap = {}, ctx = detailed) =>
  applyAnswers(set, answers, updates, ctx);

const adultProfile: AnswerUpdate[] = [
  a('q01', 'lose'),
  a('q06', { mode: 'age', age: 30 }),
  a('q07', 'male'),
  a('q08', { cm: 180, unit: 'cm' }),
  a('q09', { kg: 80, unit: 'kg', isEstimate: false }),
  a('q10', 'active'),
  a('target_weight', { kg: 72, unit: 'kg' }),
];

describe('onboarding-engine branching (plan section 10)', () => {
  it('row 1: age unknown or under 18 skips q07–q10 and target weight', () => {
    for (const age of [undefined, { mode: 'none' }, { mode: 'age', age: 16 }]) {
      const answers = age ? apply([a('q06', age)]).answers : {};
      const ids = applicableQuestions(set, answers, detailed);
      for (const q of ['q07', 'q08', 'q09', 'q10', 'target_weight']) expect(ids).not.toContain(q);
      expect(ids).toContain('q11');
    }
    const adult = apply([a('q06', { mode: 'age', age: 18 })]).answers;
    expect(applicableQuestions(set, adult, detailed)).toContain('q07');
    expect(applicableQuestions(set, adult, detailed)).not.toContain('q08');
  });

  it('row 1 change: becoming under 18 clears every profile value at once (cascade, BR-11)', () => {
    const { answers } = apply(adultProfile);
    const r = apply([a('q06', { mode: 'age', age: 15 })], answers);
    expect(r.cleared.sort()).toEqual(['q07', 'q08', 'q09', 'q10', 'target_weight']);
    expect(r.effects).toEqual(expect.arrayContaining(['habits_only_mode', 'disable_targets', 'never_reuse_old_target']));
    for (const q of r.cleared) expect(r.answers[q]).toMatchObject({ status: 'not_applicable', value: null });
    expect(r.answers.q01).toMatchObject({ status: 'answered', value: 'lose' });
    // input is never mutated
    expect(answers.q07?.status).toBe('answered');
  });

  it('row 2: q07 unsure or none skips q08–q10 and marks the calculation incomplete', () => {
    for (const sex of ['unsure', 'none']) {
      const { answers } = apply([a('q06', { mode: 'age', age: 30 }), a('q07', sex)]);
      const ids = applicableQuestions(set, answers, detailed);
      expect(ids).toContain('q07');
      for (const q of ['q08', 'q09', 'q10', 'target_weight']) expect(ids).not.toContain(q);
    }
    const { answers } = apply(adultProfile);
    const r = apply([a('q07', 'none')], answers);
    expect(r.cleared.sort()).toEqual(['q08', 'q09', 'q10', 'target_weight']);
    expect(r.effects).toContain('calculation_incomplete');
  });

  it('row 2: missing height hides weight and activity', () => {
    const { answers } = apply([a('q06', { mode: 'age', age: 30 }), a('q07', 'female'), { questionId: 'q08', status: 'skipped' }]);
    const ids = applicableQuestions(set, answers, detailed);
    expect(ids).toContain('q08');
    expect(ids).not.toContain('q09');
    expect(ids).not.toContain('q10');
  });

  it('row 3: q15 yes or varies shows q16; q15 becoming no clears flexible days', () => {
    expect(isApplicable(set, 'q16', apply([a('q15', 'yes')]).answers, detailed)).toBe(true);
    expect(isApplicable(set, 'q16', apply([a('q15', 'varies')]).answers, detailed)).toBe(true);
    expect(isApplicable(set, 'q16', apply([a('q15', 'skip')]).answers, detailed)).toBe(false);
    const { answers } = apply([a('q15', 'yes'), a('q16', ['sat', 'sun'])]);
    const r = apply([a('q15', 'no')], answers);
    expect(r.cleared).toEqual(['q16']);
    expect(r.answers.q16?.status).toBe('not_applicable');
  });

  it('row 4: q04 eating windows shows q19; removing it hides q19', () => {
    const { answers } = apply([a('q04', ['logging', 'fasting']), a('q19', 'curious')]);
    expect(applicableQuestions(set, answers, detailed)).toEqual(expect.arrayContaining(['q18', 'q19', 'q20']));
    const r = apply([a('q04', ['logging'])], answers);
    expect(r.cleared).toEqual(['q19']);
    expect(r.effects).toContain('disable_fasting_suggestions');
  });

  it('row 5: q04 activity or q21 movement shows q27', () => {
    expect(isApplicable(set, 'q27', {}, detailed)).toBe(false);
    expect(isApplicable(set, 'q27', apply([a('q04', ['movement'])]).answers, detailed)).toBe(true);
    expect(isApplicable(set, 'q27', apply([a('q21', ['movement', 'water'])]).answers, detailed)).toBe(true);
    const { answers } = apply([a('q04', ['movement']), a('q21', ['movement']), a('q27', ['walk'])]);
    // still shown while either remains
    const one = apply([a('q04', ['logging'])], answers);
    expect(one.cleared).toEqual([]);
    const none = apply([a('q21', ['water'])], one.answers);
    expect(none.cleared).toEqual(['q27']);
    expect(none.effects).toContain('hide_movement_setup');
  });

  it('row 6: q30 manual only shows q31 on the detailed route; hidden when other methods are added', () => {
    const manual = apply([a('q30', ['manual'])]).answers;
    expect(isApplicable(set, 'q31', manual, detailed)).toBe(true);
    expect(isApplicable(set, 'q31', manual, basic)).toBe(false);
    expect(isApplicable(set, 'q31', manual, conversation)).toBe(false);
    const { answers } = apply([a('q30', ['manual']), a('q31', ['privacy'])]);
    const r = apply([a('q30', ['manual', 'photo'])], answers);
    expect(r.cleared).toEqual(['q31']);
  });

  it('row 7: q01 lose or gain asks target weight after q10; maintain clears it', () => {
    const ids = applicableQuestions(set, apply(adultProfile).answers, detailed);
    expect(ids.indexOf('target_weight')).toBe(ids.indexOf('q10') + 1);
    const gain = apply([...adultProfile.filter((u) => u.questionId !== 'q01'), a('q01', 'gain')]).answers;
    expect(isApplicable(set, 'target_weight', gain, detailed)).toBe(true);
    for (const goal of ['maintain', 'habits']) {
      const r = apply([a('q01', goal)], apply(adultProfile).answers);
      expect(r.cleared).toEqual(['target_weight']);
    }
  });

  it('bulk updates are order independent', () => {
    const reversed = apply([...adultProfile].reverse());
    expect(reversed.cleared).toEqual([]);
    expect(reversed.answers.q10?.status).toBe('answered');
  });

  it('a stale question asked again counts as unset', () => {
    const young = apply([a('q06', { mode: 'age', age: 15 })], apply(adultProfile).answers).answers;
    const back = apply([a('q06', { mode: 'age', age: 30 })], young).answers;
    expect(back.q07?.status).toBe('not_applicable');
    expect(nextQuestion(set, back, basic)).toBe('q05');
    expect(clearStale(set, back, detailed).cleared).toEqual([]);
  });
});

describe('routes, next question and resume', () => {
  it('basic route asks Q01, Q05, Q06, applicable Q07–Q10, Q11, Q30', () => {
    expect(applicableQuestions(set, {}, basic)).toEqual(['q01', 'q05', 'q06', 'q11', 'q30']);
    const { answers } = apply(adultProfile, {}, basic);
    expect(applicableQuestions(set, answers, basic)).toEqual(['q01', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10', 'q11', 'q30']);
  });

  it('detailed route walks every question in order', () => {
    const ids = applicableQuestions(set, apply(adultProfile).answers, detailed);
    expect(ids[0]).toBe('q01');
    expect(ids[ids.length - 1]).toBe('q34');
    expect(ids).not.toContain('q16');
  });

  it('conversation route uses the conversation subset', () => {
    expect(applicableQuestions(set, {}, conversation)).toEqual(['q05', 'q01', 'q06', 'q11', 'q12', 'q22', 'q30']);
  });

  it('next question skips answered and skipped, re-asks deferred', () => {
    expect(nextQuestion(set, {}, basic)).toBe('q01');
    let answers = apply([a('q01', 'habits'), { questionId: 'q05', status: 'skipped' }], {}, basic).answers;
    expect(nextQuestion(set, answers, basic)).toBe('q06');
    answers = apply([{ questionId: 'q06', status: 'deferred' }], answers, basic).answers;
    expect(nextQuestion(set, answers, basic)).toBe('q06');
    answers = apply([a('q06', { mode: 'none' }), a('q11', 'veg'), a('q30', ['photo'])], answers, basic).answers;
    expect(nextQuestion(set, answers, basic)).toBeNull();
  });

  it('BR-10: only q01 is required', () => {
    expect(() => apply([{ questionId: 'q01', status: 'skipped' }])).toThrow(
      expect.objectContaining({ code: 'ANSWER_REQUIRED' }),
    );
    expect(() => apply([a('q01', 'habits'), { questionId: 'q02', status: 'skipped' }])).not.toThrow();
    // deferral of q01 is allowed (asked again on resume)
    expect(apply([{ questionId: 'q01', status: 'deferred' }]).answers.q01?.status).toBe('deferred');
  });

  it('empty multi, days or text commits save skipped', () => {
    const r = apply([a('q02', []), a('q05', '   '), a('q16', [])]);
    expect(r.answers.q02).toMatchObject({ status: 'skipped', value: null });
    expect(r.answers.q05).toMatchObject({ status: 'skipped', value: null });
    expect(() => apply([a('q01', [])])).toThrow(expect.objectContaining({ code: 'ANSWER_INVALID' }));
  });

  it('rejects unknown questions and invalid values', () => {
    expect(() => apply([a('q99', 'x')])).toThrow(expect.objectContaining({ code: 'QUESTION_NOT_FOUND' }));
    expect(() => apply([a('q01', 'fly')])).toThrow(DomainError);
  });

  it('keeps the input method', () => {
    expect(apply([a('q01', 'lose', { inputMethod: 'voice' })]).answers.q01?.inputMethod).toBe('voice');
    expect(apply([{ questionId: 'q02', status: 'skipped', inputMethod: 'chip' }]).answers.q02?.inputMethod).toBe('chip');
    expect(apply([{ questionId: 'q02', status: 'skipped' }]).answers.q02?.inputMethod).toBeUndefined();
  });
});

describe('deferral and the finish-setup card', () => {
  it('basic completion defers every unasked detailed question, q31 included', () => {
    const { answers } = apply([a('q01', 'habits'), a('q30', ['manual'])], {}, basic);
    const r = deferUnanswered(set, answers, basic);
    expect(r.deferred).toContain('q31');
    expect(r.deferred).toContain('q02');
    expect(r.deferred).not.toContain('q01');
    expect(r.deferred).not.toContain('q16');
    expect(r.answers.q02).toMatchObject({ status: 'deferred', value: null });
    expect(answers.q02).toBeUndefined();
    expect(deferredQuestions(set, r.answers, basic)).toEqual(r.deferred);
    // deferring again is a no-op
    expect(deferUnanswered(set, r.answers, basic).deferred).toEqual([]);
  });

  it('answering a deferred question removes it from the card', () => {
    const { answers } = deferUnanswered(set, apply([a('q01', 'habits')]).answers, conversation);
    const before = deferredQuestions(set, answers, conversation).length;
    const after = apply([a('q02', ['energy'])], answers).answers;
    expect(deferredQuestions(set, after, conversation)).toHaveLength(before - 1);
    expect(nextQuestion(set, after, detailed)).toBe('q03');
  });

  it('a leftover not_applicable record that applies again is deferred', () => {
    const young = apply([a('q06', { mode: 'age', age: 15 })], apply(adultProfile).answers).answers;
    const back = apply([a('q06', { mode: 'age', age: 30 })], { ...young, q07: { ...young.q07!, inputMethod: 'chip' } }).answers;
    const r = deferUnanswered(set, back, basic);
    expect(r.deferred).toContain('q07');
    expect(r.answers.q07).toMatchObject({ status: 'deferred', inputMethod: 'chip' });
    expect(deferredQuestions(set, back, basic)).toContain('q07');
  });
});
