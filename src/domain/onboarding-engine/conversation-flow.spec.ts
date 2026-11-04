import { loadContentJson } from '../../../test/fixtures/onboarding/load-content';
import { loadQuestionSet } from './load';
import { loadFlowTurns, nextFlowTurn, openQuestions, provisionalViable, settleProvisional, toStoredValue } from './conversation-flow';
import type { AnswerMap, EngineContext } from './types';

const set = loadQuestionSet(loadContentJson('questions.v1.json'));
const turns = loadFlowTurns(set, loadContentJson('conversation.v1.json'));
const ctx: EngineContext = { route: 'conversation', today: '2026-11-02' };
const ans = (value: unknown, status: 'answered' | 'skipped' = 'answered') => ({ value: value as never, status });

describe('conversation flow (plan 8.5, conversation.v1.json)', () => {
  it('walks the turns, asking q08/q09 provisionally with q06', () => {
    const first = nextFlowTurn(set, turns, {}, {}, ctx);
    expect(first?.turn.id).toBe('name_goal');
    const a: AnswerMap = { q05: ans('Alex'), q01: ans('lose') };
    const step = nextFlowTurn(set, turns, a, {}, ctx);
    expect(step).toMatchObject({ turn: { id: 'about_you' }, open: ['q06', 'q08', 'q09'] });
    const held = nextFlowTurn(set, turns, { ...a, q06: ans({ mode: 'age', age: 28 }) }, { q08: {}, q09: {} }, ctx);
    expect(held?.turn.id).toBe('sex_input');
  });

  it('skips turns 4–6 for under-18 users and drops held values', () => {
    const a: AnswerMap = { q05: ans('Sam'), q01: ans('habits'), q06: ans({ mode: 'age', age: 16 }) };
    expect(provisionalViable(set, a, ctx)).toBe(false);
    expect(nextFlowTurn(set, turns, a, {}, ctx)?.turn.id).toBe('food');
    const s = settleProvisional(set, a, { q08: { cm: 170, unit: 'cm' } }, ctx);
    expect(s).toEqual({ commit: [], drop: ['q08'], keep: {} });
  });

  it('commits held q08/q09 once q07 is female or male, keeps them while unknown', () => {
    const held = { q08: { cm: 172, unit: 'cm' }, q09: { kg: 78, unit: 'kg', isEstimate: false } };
    const base: AnswerMap = { q01: ans('lose'), q06: ans({ mode: 'age', age: 28 }) };
    expect(settleProvisional(set, base, held, ctx).keep).toEqual(held);
    const s = settleProvisional(set, { ...base, q07: ans('male') }, held, ctx);
    expect(s.commit.map((c) => c.questionId)).toEqual(['q08', 'q09']);
    expect(settleProvisional(set, { ...base, q07: ans('unsure') }, held, ctx).drop).toEqual(['q08', 'q09']);
  });

  it('openQuestions ignores settled questions', () => {
    const t = turns.find((x) => x.id === 'food')!;
    expect(openQuestions(set, t, { q11: ans('veg') }, {}, ctx)).toEqual(['q12']);
  });

  it('converts extracted measurements to stored formats', () => {
    const q = (id: string) => set.byId[id]!;
    expect(toStoredValue(q('q06'), { kind: 'age', mode: 'age', age: 28, dob: null })).toEqual({ mode: 'age', age: 28 });
    expect(toStoredValue(q('q06'), { kind: 'age', mode: 'none', age: null, dob: null })).toEqual({ mode: 'none' });
    expect(toStoredValue(q('q06'), { kind: 'age', mode: 'dob', age: null, dob: '1998-04-02' })).toEqual({ mode: 'dob', dob: '1998-04-02' });
    expect(toStoredValue(q('q08'), { kind: 'height', unit: 'ft_in', value: null, feet: 5, inches: 9 })).toEqual({ cm: 175.3, unit: 'ft_in' });
    expect(toStoredValue(q('q08'), { kind: 'height', unit: 'm', value: 1.72, feet: null, inches: null })).toEqual({ cm: 172, unit: 'cm' });
    expect(toStoredValue(q('q09'), { kind: 'weight', unit: 'st_lb', value: null, stone: 11, pounds: 4, isEstimate: true })).toEqual({ kg: 71.7, unit: 'lb', isEstimate: true });
    expect(toStoredValue(q('target_weight'), { kind: 'weight', unit: 'kg', value: 72, stone: null, pounds: null, isEstimate: false })).toEqual({ kg: 72, unit: 'kg' });
    expect(toStoredValue(q('q05'), '  Alex ')).toBe('Alex');
    expect(toStoredValue(q('q30'), ['photo'])).toEqual(['photo']);
    expect(toStoredValue(q('q01'), 'lose')).toBe('lose');
    expect(toStoredValue(q('q01'), null)).toBeNull();
    expect(toStoredValue(q('q08'), 'tall')).toBeUndefined();
  });
});
