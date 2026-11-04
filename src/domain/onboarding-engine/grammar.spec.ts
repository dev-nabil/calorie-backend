import { loadContentJson } from '../../../test/fixtures/onboarding/load-content';
import grammar from '../../../test/fixtures/onboarding/grammar.fixture.json';
import {
  ageFromAnswer,
  applicableQuestions,
  evaluateCondition,
  hasValue,
  loadQuestionSet,
  parseCondition,
  QuestionSetError,
  type AnswerMap,
  type EngineContext,
} from './index';

const set = loadQuestionSet(grammar);
const ctx: EngineContext = { route: 'detailed', today: '2026-11-02' };
const ans = (v: Record<string, unknown>): AnswerMap =>
  Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value, status: 'answered' }])) as AnswerMap;

describe('onboarding-engine grammar', () => {
  it('loads the product question set', () => {
    const real = loadQuestionSet(loadContentJson('questions.v1.json'));
    expect(real.questions.length).toBeGreaterThanOrEqual(35);
    expect(real.ageQuestionId).toBe('q06');
    expect(real.rulesByQuestion.q16).toHaveLength(1);
  });

  describe('ageFromAnswer', () => {
    it('derives completed years', () => {
      expect(ageFromAnswer({ mode: 'age', age: 28.7 }, '2026-11-02')).toBe(28);
      expect(ageFromAnswer({ mode: 'dob', dob: '2008-11-02' }, '2026-11-02')).toBe(18);
      expect(ageFromAnswer({ mode: 'dob', dob: '2008-11-03' }, '2026-11-02')).toBe(17);
      expect(ageFromAnswer({ mode: 'dob', dob: '2008-12-01' }, '2026-11-02')).toBe(17);
    });
    it('is unknown for none, invalid, future and missing values', () => {
      expect(ageFromAnswer({ mode: 'none' }, '2026-11-02')).toBeNull();
      expect(ageFromAnswer({ mode: 'dob', dob: '2008-02-30' }, '2026-11-02')).toBeNull();
      expect(ageFromAnswer({ mode: 'dob', dob: '2027-01-01' }, '2026-11-02')).toBeNull();
      expect(ageFromAnswer({ mode: 'age', age: 'x' }, '2026-11-02')).toBeNull();
      expect(ageFromAnswer({ mode: 'age', age: -1 }, '2026-11-02')).toBeNull();
      expect(ageFromAnswer(null, '2026-11-02')).toBeNull();
      expect(ageFromAnswer(undefined, '2026-11-02')).toBeNull();
    });
  });

  it('treats blanks as missing', () => {
    expect(hasValue('  ')).toBe(false);
    expect(hasValue([])).toBe(false);
    expect(hasValue(null)).toBe(false);
    expect(hasValue(0)).toBe(true);
    expect(hasValue({})).toBe(true);
  });

  it('supports the ageGte alias and age comparisons', () => {
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 18 } }), ctx)).toContain('s1');
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 17 } }), ctx)).not.toContain('s1');
    expect(applicableQuestions(set, {}, ctx)).not.toContain('s1');
    // s2: 12 < age < 20 and a is not x
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 15 } }), ctx)).toContain('s2');
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 15 }, a: 'x' }), ctx)).not.toContain('s2');
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 20 } }), ctx)).not.toContain('s2');
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 12 } }), ctx)).not.toContain('s2');
    // s6: a unanswered and age <= 65
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 65 } }), ctx)).toContain('s6');
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 66 } }), ctx)).not.toContain('s6');
    expect(applicableQuestions(set, ans({ age: { mode: 'age', age: 30 }, a: 'y' }), ctx)).not.toContain('s6');
  });

  it('in on an array value means contains / any overlap (task alias)', () => {
    expect(applicableQuestions(set, ans({ m: ['p', 'q'] }), ctx)).toEqual(expect.arrayContaining(['s3', 's7']));
    expect(applicableQuestions(set, ans({ m: ['r'] }), ctx)).toEqual(expect.arrayContaining(['s7']));
    expect(applicableQuestions(set, ans({ m: ['r'] }), ctx)).not.toContain('s3');
    expect(applicableQuestions(set, {}, ctx)).not.toContain('s7');
  });

  it('in on a single value means membership; eq on arrays never matches', () => {
    expect(applicableQuestions(set, ans({ a: 'z' }), ctx)).toContain('s5');
    expect(applicableQuestions(set, ans({ a: 'x' }), ctx)).not.toContain('s5');
    expect(evaluateCondition({ q: 'm', eq: 'p' }, ans({ m: ['p'] }), ctx)).toBe(false);
    expect(evaluateCondition({ q: 'a', in: 'x' }, ans({ a: 'x' }), ctx)).toBe(true);
    expect(evaluateCondition({ q: 'a', in: ['x'] }, ans({ a: 5 }), ctx)).toBe(false);
  });

  it('eqSet requires exactly the set, order ignored', () => {
    expect(applicableQuestions(set, ans({ m: ['p', 'q'] }), ctx)).toContain('s4');
    expect(applicableQuestions(set, ans({ m: ['q', 'p', 'r'] }), ctx)).not.toContain('s4');
    expect(applicableQuestions(set, ans({ m: ['p'] }), ctx)).not.toContain('s4');
    expect(applicableQuestions(set, ans({ a: 'x' }), ctx)).not.toContain('s4');
  });

  it('route conditions use the active route', () => {
    expect(applicableQuestions(set, {}, { ...ctx, route: 'basic' })).toContain('s5');
    expect(applicableQuestions(set, {}, ctx)).not.toContain('s5');
  });

  it('includes, answered and missing values', () => {
    expect(evaluateCondition({ q: 'm', includes: 'p' }, ans({ m: ['p'] }), ctx)).toBe(true);
    expect(evaluateCondition({ q: 'a', includes: 'x' }, ans({ a: 'x' }), ctx)).toBe(false);
    expect(evaluateCondition({ q: 'a', answered: true }, ans({ a: 'x' }), ctx)).toBe(true);
    expect(evaluateCondition({ q: 'a', answered: true }, { a: { value: null, status: 'skipped' } }, ctx)).toBe(false);
    expect(evaluateCondition({ all: [] }, {}, ctx)).toBe(true);
    expect(evaluateCondition({ any: [] }, {}, ctx)).toBe(false);
  });

  describe('loadQuestionSet validation', () => {
    const base = () => JSON.parse(JSON.stringify(grammar));
    it('rejects bad shapes', () => {
      expect(() => loadQuestionSet({})).toThrow(QuestionSetError);
      expect(() => loadQuestionSet(null)).toThrow(QuestionSetError);
    });
    it('rejects duplicate ids and unknown references', () => {
      const dup = base();
      dup.questions.push({ ...dup.questions[0] });
      expect(() => loadQuestionSet(dup)).toThrow(/Duplicate/);
      const badShow = base();
      badShow.branching.push({ show: 'nope', when: { ageGte: 1 } });
      expect(() => loadQuestionSet(badShow)).toThrow(/unknown question nope/);
      const badRef = base();
      badRef.branching.push({ show: 'a', when: { q: 'ghost', eq: 'x' } });
      expect(() => loadQuestionSet(badRef)).toThrow(/ghost/);
      const badRoute = base();
      badRoute.routes.basic.questionIds.push('ghost');
      expect(() => loadQuestionSet(badRoute)).toThrow(/routes.basic/);
      const badClear = base();
      badClear.branching.push({ show: 'a', when: { ageGte: 1 }, onHide: { clear: ['ghost'] } });
      expect(() => loadQuestionSet(badClear)).toThrow(/onHide/);
    });
    it('rejects unknown and malformed condition forms', () => {
      expect(() => parseCondition({ q: 'a', like: 'x' })).toThrow(/unknown condition form/);
      expect(() => parseCondition('x')).toThrow(/must be an object/);
      expect(() => parseCondition({ all: 'x' })).toThrow(/expected an array/);
      expect(() => parseCondition({ q: 'a', eq: 1 })).toThrow(/malformed/);
      expect(() => parseCondition({ q: 'a', in: [] })).toThrow(/malformed/);
      expect(() => parseCondition({ q: 'a', includes: 1 })).toThrow(/malformed/);
      expect(() => parseCondition({ q: 'a', eqSet: [] })).toThrow(/malformed/);
      expect(() => parseCondition({ q: 'a', answered: 'yes' })).toThrow(/malformed/);
      expect(() => parseCondition({ age: { gte: '18' } })).toThrow(/malformed/);
      expect(() => parseCondition({ age: { between: 1 } })).toThrow(/malformed/);
      expect(() => parseCondition({ ageGte: '18' })).toThrow(/malformed/);
      expect(() => parseCondition({ route: 'elsewhere' })).toThrow(/malformed/);
      expect(() => parseCondition({ route: { in: [] } })).toThrow(/malformed/);
      expect(() => parseCondition({ branch: [] })).toThrow(QuestionSetError);
      const badRule = base();
      badRule.branching.push({ when: { ageGte: 1 } });
      expect(() => loadQuestionSet(badRule)).toThrow(/expected \{ show, when \}/);
    });
    it('parses every valid form', () => {
      expect(parseCondition({ route: { in: ['basic', 'detailed'] } })).toEqual({ route: { in: ['basic', 'detailed'] } });
      expect(parseCondition({ route: 'conversation' })).toEqual({ route: 'conversation' });
      expect(parseCondition({ not: { q: 'a', answered: true } })).toEqual({ not: { q: 'a', answered: true } });
      expect(parseCondition({ any: [{ q: 'm', includes: 'p' }] })).toEqual({ any: [{ q: 'm', includes: 'p' }] });
    });
  });
});
