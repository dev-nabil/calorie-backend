/** Evaluation of the declarative branching grammar (questions.v1.json conditionGrammar). */
import { diffDays, isValidDayKey } from '../day-keys';
import type { AgeComparison, AnswerMap, AnswerRecord, AnswerValue, Condition, EngineContext, QuestionSet } from './types';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the value is non-empty: non-blank string, non-empty array, object or number. */
export function hasValue(v: AnswerValue | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Saved value of an answered question, else undefined (a blank is never read as "no"). */
function savedValue(rec: AnswerRecord | undefined): AnswerValue | undefined {
  if (!rec || rec.status !== 'answered' || !hasValue(rec.value)) return undefined;
  return rec.value;
}

/**
 * Age in completed years from a q06 value. mode "age": stated age; mode "dob": completed
 * years on `today`; mode "none", invalid or future dates: unknown (null).
 */
export function ageFromAnswer(value: AnswerValue | undefined, today: string): number | null {
  if (!isObject(value)) return null;
  if (value.mode === 'age') {
    const age = value.age;
    return typeof age === 'number' && Number.isFinite(age) && age >= 0 ? Math.floor(age) : null;
  }
  if (value.mode === 'dob') {
    const dob = value.dob;
    if (typeof dob !== 'string' || !isValidDayKey(dob) || !isValidDayKey(today)) return null;
    if (diffDays(dob, today) < 0) return null;
    const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
    const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
    let age = ty - by;
    if (tm < bm || (tm === bm && td < bd)) age--;
    return age;
  }
  return null;
}

function compareAge(age: number | null, cmp: AgeComparison): boolean {
  if (age === null) return false;
  if (cmp.gte !== undefined && !(age >= cmp.gte)) return false;
  if (cmp.gt !== undefined && !(age > cmp.gt)) return false;
  if (cmp.lte !== undefined && !(age <= cmp.lte)) return false;
  if (cmp.lt !== undefined && !(age < cmp.lt)) return false;
  return true;
}

/** `in`: single value is one of the ids; on an array value (task alias) any overlap. */
function matchesIn(value: AnswerValue | undefined, ids: string[]): boolean {
  if (typeof value === 'string') return ids.includes(value);
  if (Array.isArray(value)) return value.some((v) => ids.includes(v));
  return false;
}

export function evaluateCondition(
  cond: Condition,
  answers: AnswerMap,
  ctx: EngineContext,
  set?: Pick<QuestionSet, 'ageQuestionId'>,
): boolean {
  const ageQ = set?.ageQuestionId ?? 'q06';
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, answers, ctx, set));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, answers, ctx, set));
  if ('not' in cond) return !evaluateCondition(cond.not, answers, ctx, set);
  if ('age' in cond) return compareAge(ageFromAnswer(savedValue(answers[ageQ]), ctx.today), cond.age);
  if ('ageGte' in cond) return compareAge(ageFromAnswer(savedValue(answers[ageQ]), ctx.today), { gte: cond.ageGte });
  if ('route' in cond) {
    return typeof cond.route === 'string' ? ctx.route === cond.route : cond.route.in.includes(ctx.route);
  }
  const value = savedValue(answers[cond.q]);
  if ('answered' in cond) return cond.answered ? value !== undefined : value === undefined;
  if ('eq' in cond) return typeof value === 'string' && value === cond.eq;
  if ('in' in cond) return matchesIn(value, typeof cond.in === 'string' ? [cond.in] : cond.in);
  if ('includes' in cond) return Array.isArray(value) && value.includes(cond.includes);
  // eqSet: multi value contains exactly these ids, order ignored
  if (!Array.isArray(value)) return false;
  const want = new Set(cond.eqSet);
  const have = new Set(value);
  return want.size === have.size && [...want].every((id) => have.has(id));
}

/** Question ids referenced by a condition (for load-time validation). */
export function referencedQuestions(cond: Condition): string[] {
  if ('all' in cond) return cond.all.flatMap(referencedQuestions);
  if ('any' in cond) return cond.any.flatMap(referencedQuestions);
  if ('not' in cond) return referencedQuestions(cond.not);
  if ('q' in cond) return [cond.q];
  return [];
}
