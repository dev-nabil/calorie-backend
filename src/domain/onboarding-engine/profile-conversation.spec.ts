import { loadContentJson } from '../../../test/fixtures/onboarding/load-content';
import {
  applyAnswers,
  conversationTurns,
  loadQuestionSet,
  nextTurn,
  profileFromAnswers,
  QuestionSetError,
  type AnswerUpdate,
  type EngineContext,
} from './index';

const set = loadQuestionSet(loadContentJson('questions.v1.json'));
const conversationJson = loadContentJson('conversation.v1.json');
const today = '2026-11-02';
const ctx: EngineContext = { route: 'conversation', today };
const a = (questionId: string, value: AnswerUpdate['value']): AnswerUpdate => ({ questionId, status: 'answered', value });

describe('profileFromAnswers', () => {
  it('maps answered values by field key', () => {
    const { answers } = applyAnswers(
      set,
      {},
      [
        a('q01', 'lose'),
        a('q02', ['energy']),
        a('q03', 'proud'),
        a('q04', ['logging']),
        a('q05', 'Alex'),
        a('q06', { mode: 'dob', dob: '1998-05-04' }),
        a('q07', 'female'),
        a('q08', { cm: 170, unit: 'cm' }),
        a('q09', { kg: 78, unit: 'kg', isEstimate: true }),
        a('q10', 'intense'),
        a('target_weight', { kg: 72, unit: 'kg' }),
        a('q11', 'veg'),
        a('q12', 'home'),
        a('q17', 'some'),
        a('q20', 'ready'),
        a('q21', ['water']),
        a('q30', ['photo', 'voice']),
      ],
      { route: 'detailed', today },
    );
    expect(profileFromAnswers(set, answers, today)).toEqual({
      primaryGoal: 'lose',
      supportingGoals: ['energy'],
      personalMotivation: 'proud',
      requestedFeatures: ['logging'],
      displayName: 'Alex',
      ageYears: 28,
      birthDate: '1998-05-04',
      calculationSex: 'female',
      heightCm: 170,
      weightKg: 78,
      weightIsEstimate: true,
      targetWeightKg: 72,
      activityLevel: 'intense',
      dietPattern: 'veg',
      mealSource: 'home',
      nutritionFamiliarity: 'some',
      startingMood: 'ready',
      habitPriorities: ['water'],
      loggingMethods: ['photo', 'voice'],
      // Plan personalisation inputs not asked above stay empty, never guessed.
      timeframeWeeks: null,
      allergies: null,
      allergyOther: null,
      dietPatternOther: null,
      mealsPerDay: null,
      schedulePattern: null,
      higherIntakePattern: null,
      trackingExperience: null,
      routineBarriers: [],
      eatingCues: [],
    });
  });

  it('ignores skipped, deferred and cleared values; never infers', () => {
    const { answers } = applyAnswers(
      set,
      {},
      [a('q01', 'habits'), a('q06', { mode: 'age', age: 16 }), a('q07', 'unsure'), { questionId: 'q05', status: 'skipped' }],
      { route: 'detailed', today },
    );
    const p = profileFromAnswers(set, answers, today);
    expect(p).toMatchObject({
      primaryGoal: 'habits',
      displayName: null,
      ageYears: 16,
      birthDate: null,
      calculationSex: null,
      heightCm: null,
      weightKg: null,
      weightIsEstimate: false,
      activityLevel: null,
      supportingGoals: [],
    });
  });
});

describe('conversation turns (plan 8.5)', () => {
  const turns = conversationTurns(set, conversationJson);

  it('loads the product turn groups', () => {
    expect(turns.map((t) => t.id)).toEqual([
      'intro',
      'name_goal',
      'about_you',
      'sex_input',
      'target_weight',
      'activity',
      'food',
      'barriers',
      'logging',
    ]);
    expect(turns[3]?.skipWhen).toEqual({ not: { age: { gte: 18 } } });
  });

  it('falls back to one turn per conversation question', () => {
    const fallback = conversationTurns(set);
    expect(fallback.map((t) => t.id)).toEqual(set.routes.conversation.questionIds);
    expect(fallback[0]).toEqual({ id: 'q05', questionIds: ['q05'], skipWhen: null });
  });

  it('rejects malformed conversation files', () => {
    expect(() => conversationTurns(set, { turns: 'x' })).toThrow(QuestionSetError);
    expect(() => conversationTurns(set, { turns: [{ id: 1 }] })).toThrow(QuestionSetError);
    expect(() => conversationTurns(set, { turns: [{ id: 't', questionIds: ['ghost'] }] })).toThrow(/ghost/);
    expect(() => conversationTurns(set, { turns: [{ id: 't', questionIds: [], skipWhen: { foo: 1 } }] })).toThrow(
      QuestionSetError,
    );
  });

  it('walks the adult path with grouped and partial turns', () => {
    expect(nextTurn(set, turns, {}, ctx)).toMatchObject({ id: 'name_goal', questionIds: ['q05', 'q01'] });
    let answers = applyAnswers(set, {}, [a('q01', 'lose')], ctx).answers;
    expect(nextTurn(set, turns, answers, ctx)).toMatchObject({ id: 'name_goal', questionIds: ['q05'] });
    answers = applyAnswers(set, answers, [a('q05', 'Alex')], ctx).answers;
    // about_you: q06 only until sex input and height make q08/q09 applicable
    expect(nextTurn(set, turns, answers, ctx)).toMatchObject({ id: 'about_you', questionIds: ['q06'] });
    answers = applyAnswers(set, answers, [a('q06', { mode: 'age', age: 28 })], ctx).answers;
    expect(nextTurn(set, turns, answers, ctx)).toMatchObject({ id: 'sex_input', questionIds: ['q07'] });
    answers = applyAnswers(
      set,
      answers,
      [a('q07', 'male'), a('q08', { cm: 172, unit: 'cm' }), a('q09', { kg: 78, unit: 'kg' })],
      ctx,
    ).answers;
    expect(nextTurn(set, turns, answers, ctx)).toMatchObject({ id: 'target_weight' });
    answers = applyAnswers(set, answers, [{ questionId: 'target_weight', status: 'skipped' }], ctx).answers;
    expect(nextTurn(set, turns, answers, ctx)).toMatchObject({ id: 'activity' });
  });

  it('under 18 skips turns 4–6', () => {
    const answers = applyAnswers(set, {}, [a('q01', 'lose'), a('q05', 'Sam'), a('q06', { mode: 'age', age: 15 })], ctx).answers;
    expect(nextTurn(set, turns, answers, ctx)).toMatchObject({ id: 'food', questionIds: ['q11', 'q12'] });
  });

  it('returns null when every turn is settled', () => {
    const answers = applyAnswers(
      set,
      {},
      [
        a('q01', 'habits'),
        a('q05', 'Sam'),
        a('q06', { mode: 'none' }),
        a('q11', 'none'),
        a('q12', 'home'),
        a('q22', ['busy']),
        a('q30', ['photo']),
      ],
      ctx,
    ).answers;
    expect(nextTurn(set, turns, answers, ctx)).toBeNull();
  });
});
