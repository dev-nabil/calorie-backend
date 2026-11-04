import { loadContentJson } from '../../../test/fixtures/onboarding/load-content';
import grammar from '../../../test/fixtures/onboarding/grammar.fixture.json';
import { loadQuestionSet, validateAnswer } from './index';

const set = loadQuestionSet(loadContentJson('questions.v1.json'));
const today = '2026-11-02';
const v = (id: string, value: unknown, detail?: { text?: string; number?: number } | null) =>
  validateAnswer(set, id, value as never, detail, today);
const invalid = expect.objectContaining({ ok: false, code: 'ANSWER_INVALID' });

describe('validateAnswer (M2-T3)', () => {
  it('unknown question', () => {
    expect(v('nope', 'x')).toMatchObject({ ok: false, code: 'QUESTION_NOT_FOUND' });
  });

  it('requires a value', () => {
    expect(v('q01', undefined)).toEqual(invalid);
    expect(v('q01', null)).toEqual(invalid);
  });

  describe('single', () => {
    it('accepts known options and rejects others', () => {
      expect(v('q01', 'lose')).toEqual({ ok: true, value: 'lose', detail: null });
      expect(v('q01', 'fly')).toEqual(invalid);
      expect(v('q01', ['lose'])).toEqual(invalid);
    });
    it('free text only on freeText options', () => {
      expect(v('q03', 'personal', { text: '  For my kids ' })).toEqual({ ok: true, value: 'personal', detail: { text: 'For my kids' } });
      expect(v('q03', 'proud', { text: 'x' })).toEqual(invalid);
      expect(v('q03', 'personal', { text: 'x'.repeat(51) })).toEqual(invalid);
      expect(v('q03', 'personal', { text: '   ' })).toEqual(invalid);
      expect(v('q03', 'personal', {})).toEqual({ ok: true, value: 'personal', detail: null });
    });
    it('q33 custom needs a whole number of days within limits', () => {
      expect(v('q33', 'custom', { number: 21 })).toEqual({ ok: true, value: 'custom', detail: { number: 21 } });
      expect(v('q33', 'custom')).toEqual(invalid);
      expect(v('q33', 'custom', { number: 0 })).toEqual(invalid);
      expect(v('q33', 'custom', { number: 366 })).toEqual(invalid);
      expect(v('q33', 'custom', { number: 2.5 })).toEqual(invalid);
      expect(v('q33', '7', { number: 7 })).toEqual(invalid);
      expect(v('q33', '7')).toMatchObject({ ok: true });
    });
  });

  describe('multi', () => {
    it('validates options, uniqueness, exclusive and max', () => {
      expect(v('q21', ['portion', 'water', 'movement'])).toMatchObject({ ok: true });
      expect(v('q21', ['portion', 'water', 'movement', 'snack'])).toEqual(invalid);
      expect(v('q21', ['none'])).toMatchObject({ ok: true });
      expect(v('q21', ['none', 'water'])).toEqual(invalid);
      expect(v('q21', ['water', 'water'])).toEqual(invalid);
      expect(v('q21', ['flying'])).toEqual(invalid);
      expect(v('q21', 'water')).toEqual(invalid);
      expect(v('q21', [1])).toEqual(invalid);
      expect(v('q30', ['switch', 'later'])).toEqual(invalid);
      expect(v('q21', ['other'], { text: 'Cooking' })).toEqual({ ok: true, value: ['other'], detail: { text: 'Cooking' } });
      expect(v('q21', ['water'], { text: 'Cooking' })).toEqual(invalid);
    });
  });

  describe('days', () => {
    it('accepts weekdays or one exclusive option', () => {
      expect(v('q16', ['sat', 'sun'])).toEqual({ ok: true, value: ['sat', 'sun'], detail: null });
      expect(v('q16', ['changes'])).toMatchObject({ ok: true });
      expect(v('q16', ['changes', 'sat'])).toEqual(invalid);
      expect(v('q16', ['funday'])).toEqual(invalid);
      expect(v('q16', ['sat', 'sat'])).toEqual(invalid);
    });
  });

  describe('text', () => {
    it('trims and limits to 50 characters', () => {
      expect(v('q05', '  Alex ')).toEqual({ ok: true, value: 'Alex', detail: null });
      expect(v('q05', 'é'.repeat(50))).toMatchObject({ ok: true });
      expect(v('q05', 'x'.repeat(51))).toEqual(invalid);
      expect(v('q05', '  ')).toEqual(invalid);
      expect(v('q05', 5)).toEqual(invalid);
      expect(v('q05', 'Alex', { text: 'x' })).toEqual(invalid);
    });
  });

  describe('age', () => {
    it('accepts age, dob and none', () => {
      expect(v('q06', { mode: 'age', age: 28 })).toEqual({ ok: true, value: { mode: 'age', age: 28 }, detail: null });
      expect(v('q06', { mode: 'dob', dob: '1998-05-04' })).toMatchObject({ ok: true });
      expect(v('q06', { mode: 'none' })).toEqual({ ok: true, value: { mode: 'none' }, detail: null });
    });
    it('rejects out-of-range, future, malformed and extra fields', () => {
      expect(v('q06', { mode: 'age', age: 9 })).toEqual(invalid);
      expect(v('q06', { mode: 'age', age: 111 })).toEqual(invalid);
      expect(v('q06', { mode: 'age', age: 28.5 })).toEqual(invalid);
      expect(v('q06', { mode: 'age' })).toEqual(invalid);
      expect(v('q06', { mode: 'dob', dob: '2027-01-01' })).toEqual(invalid);
      expect(v('q06', { mode: 'dob', dob: '2020-01-01' })).toEqual(invalid);
      expect(v('q06', { mode: 'dob', dob: '1998-02-30' })).toEqual(invalid);
      expect(v('q06', { mode: 'dob' })).toEqual(invalid);
      expect(v('q06', { mode: 'guess' })).toEqual(invalid);
      expect(v('q06', { mode: 'none', age: 3 })).toEqual(invalid);
      expect(v('q06', 30)).toEqual(invalid);
    });
  });

  describe('height and weight', () => {
    it('validates height in cm with a display unit', () => {
      expect(v('q08', { cm: 172.44, unit: 'ft_in' })).toEqual({ ok: true, value: { cm: 172.4, unit: 'ft_in' }, detail: null });
      expect(v('q08', { cm: 172 })).toMatchObject({ ok: true, value: { cm: 172, unit: 'cm' } });
      expect(v('q08', { cm: 89 })).toEqual(invalid);
      expect(v('q08', { cm: 251 })).toEqual(invalid);
      expect(v('q08', { cm: '172' })).toEqual(invalid);
      expect(v('q08', { cm: 172, unit: 'm' })).toEqual(invalid);
      expect(v('q08', { cm: 172, inches: 3 })).toEqual(invalid);
      expect(v('q08', 'tall')).toEqual(invalid);
    });
    it('validates weight with an estimate flag', () => {
      expect(v('q09', { kg: 78, unit: 'lb', isEstimate: true })).toEqual({
        ok: true,
        value: { kg: 78, unit: 'lb', isEstimate: true },
        detail: null,
      });
      expect(v('q09', { kg: 78 })).toMatchObject({ value: { kg: 78, unit: 'kg', isEstimate: false } });
      expect(v('q09', { kg: 24 })).toEqual(invalid);
      expect(v('q09', { kg: 'x' })).toEqual(invalid);
      expect(v('q09', { kg: 78, unit: 'st' })).toEqual(invalid);
      expect(v('q09', { kg: 78, isEstimate: 'yes' })).toEqual(invalid);
      expect(v('q09', [78])).toEqual(invalid);
    });
    it('target weight never carries an estimate', () => {
      expect(v('target_weight', { kg: 72, unit: 'kg', isEstimate: true })).toMatchObject({
        ok: true,
        value: { kg: 72, unit: 'kg', isEstimate: false },
      });
    });
  });

  it('number questions (grammar fixture)', () => {
    const g = loadQuestionSet(grammar);
    expect(validateAnswer(g, 'n', 5)).toEqual({ ok: true, value: 5, detail: null });
    expect(validateAnswer(g, 'n', 10)).toMatchObject({ ok: false });
    expect(validateAnswer(g, 'n', 'five')).toMatchObject({ ok: false });
  });
});
