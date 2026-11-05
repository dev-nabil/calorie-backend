/**
 * Onboarding engine (plan section 10, BR-10, BR-11). Pure: never mutates its inputs.
 * The manual form, the conversation and the server share it.
 */
import { DomainError } from '../errors';
import { evaluateCondition, hasValue } from './conditions';
import { validateAnswer } from './validate';
import type { AnswerMap, AnswerRecord, AnswerUpdate, EngineContext, QuestionSet } from './types';

/** Branching rules only (no route-list membership). Questions without rules always pass. */
export function rulesPass(set: QuestionSet, questionId: string, answers: AnswerMap, ctx: EngineContext): boolean {
  return (set.rulesByQuestion[questionId] ?? []).every((r) => evaluateCondition(r.when, answers, ctx, set));
}

/** Applicable = in the active route list and every rule whose `show` is the question is true. */
export function isApplicable(set: QuestionSet, questionId: string, answers: AnswerMap, ctx: EngineContext): boolean {
  return set.routes[ctx.route].questionIds.includes(questionId) && rulesPass(set, questionId, answers, ctx);
}

/** Applicable questions in route order. */
export function applicableQuestions(set: QuestionSet, answers: AnswerMap, ctx: EngineContext): string[] {
  return set.routes[ctx.route].questionIds.filter((id) => rulesPass(set, id, answers, ctx));
}

/** A question is done when answered or skipped; deferred and not_applicable count as unset. */
export function isSettled(rec: AnswerRecord | undefined): boolean {
  return rec?.status === 'answered' || rec?.status === 'skipped';
}

/** Next question to ask: the first applicable question, in route order, that is not settled. */
export function nextQuestion(set: QuestionSet, answers: AnswerMap, ctx: EngineContext): string | null {
  return applicableQuestions(set, answers, ctx).find((id) => !isSettled(answers[id])) ?? null;
}

const MULTI_LIKE = new Set(['multi', 'days', 'text']);

function isEmptyCommit(type: string, value: AnswerUpdate['value']): boolean {
  return MULTI_LIKE.has(type) && !hasValue(value ?? null);
}

/** Validate one update and turn it into a stored record. */
function recordFor(set: QuestionSet, u: AnswerUpdate, ctx: EngineContext): AnswerRecord {
  const q = set.byId[u.questionId];
  if (!q) throw new DomainError('QUESTION_NOT_FOUND', `Unknown question ${u.questionId}`, { questionId: u.questionId });
  // engine.emptyCommit: continuing a multi, days or text question with no value saves skipped.
  const status = u.status === 'answered' && isEmptyCommit(q.type, u.value) ? 'skipped' : u.status;
  if (status === 'skipped' && q.required) {
    // BR-10: only Q01 is required.
    throw new DomainError('ANSWER_REQUIRED', `${u.questionId} is required`, { questionId: u.questionId });
  }
  const base = u.inputMethod ? { inputMethod: u.inputMethod } : {};
  if (status !== 'answered') return { ...base, value: null, status, detail: null };
  const v = validateAnswer(set, u.questionId, u.value, u.detail, ctx.today);
  if (!v.ok) throw new DomainError(v.code, v.message, v.details);
  return { ...base, value: v.value, status: 'answered', detail: v.detail };
}

export interface ApplyResult {
  answers: AnswerMap;
  /** Questions whose stale values were removed (BR-11). */
  cleared: string[];
  /** onHide effects of rules that hid a question, e.g. habits_only_mode. */
  effects: string[];
}

/**
 * Save answers, then re-evaluate every rule to a fixpoint (BR-11): a question with a status
 * that is no longer applicable becomes not_applicable and loses its value; onHide.clear and
 * onHide.effects of the hiding rules apply. Route-list membership is not used here, so
 * switching routes never wipes answers. Updates are applied before clearing, so the order
 * of a bulk upload does not matter.
 */
export function applyAnswers(
  set: QuestionSet,
  answers: AnswerMap,
  updates: AnswerUpdate[],
  ctx: EngineContext,
): ApplyResult {
  const next: AnswerMap = { ...answers };
  for (const u of updates) next[u.questionId] = recordFor(set, u, ctx);
  return clearStale(set, next, ctx);
}

/** BR-11 fixpoint over all rules. */
export function clearStale(set: QuestionSet, answers: AnswerMap, ctx: EngineContext): ApplyResult {
  const next: AnswerMap = { ...answers };
  const cleared = new Set<string>();
  const effects = new Set<string>();
  const hide = (id: string): boolean => {
    const rec = next[id];
    if (!rec || rec.status === 'not_applicable') return false;
    if (hasValue(rec.value)) cleared.add(id);
    next[id] = { ...rec, value: null, detail: null, status: 'not_applicable' };
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Object.keys(next)) {
      if (next[id]?.status === 'not_applicable' || rulesPass(set, id, next, ctx)) continue;
      changed = hide(id) || changed;
      for (const rule of set.rulesByQuestion[id] ?? []) {
        if (evaluateCondition(rule.when, next, ctx, set)) continue;
        rule.onHide?.effects?.forEach((e) => effects.add(e));
        rule.onHide?.clear?.forEach((c) => {
          changed = hide(c) || changed;
        });
      }
    }
  }
  return { answers: next, cleared: [...cleared], effects: [...effects] };
}

/** No record, or a not_applicable record left over from an earlier branch. */
const isUnset = (rec: AnswerRecord | undefined): boolean => !rec || rec.status === 'not_applicable';

const detailedCtx = (ctx: EngineContext): EngineContext => ({ ...ctx, route: 'detailed' });

/**
 * Questions applicable on the detailed route that are deferred or unset (no record or a
 * leftover not_applicable record). Drives the finish-setup card (deferredCount). The detailed route is used because
 * Finish setting up resumes there; this also keeps q31 deferred on basic and conversation.
 */
export function deferredQuestions(set: QuestionSet, answers: AnswerMap, ctx: EngineContext): string[] {
  const dctx = detailedCtx(ctx);
  return applicableQuestions(set, answers, dctx).filter((id) => {
    const rec = answers[id];
    return isUnset(rec) || rec?.status === 'deferred';
  });
}

/**
 * Finish later / Skip to my plan / completion: every question applicable on the detailed
 * route that is unset (no record or a leftover not_applicable) is stored as deferred
 * (engine.finishLater). A question the rules hide and nothing was recorded for is stored as
 * not_applicable, so it counts as dealt with and never blocks completion.
 */
export function deferUnanswered(
  set: QuestionSet,
  answers: AnswerMap,
  ctx: EngineContext,
): { answers: AnswerMap; deferred: string[] } {
  const next: AnswerMap = { ...answers };
  const deferred: string[] = [];
  for (const id of applicableQuestions(set, answers, detailedCtx(ctx))) {
    const rec = next[id];
    if (!isUnset(rec)) continue;
    next[id] = { ...(rec?.inputMethod ? { inputMethod: rec.inputMethod } : {}), value: null, status: 'deferred', detail: null };
    deferred.push(id);
  }
  for (const q of set.questions) {
    if (!next[q.id] && !rulesPass(set, q.id, answers, detailedCtx(ctx))) next[q.id] = { value: null, status: 'not_applicable', detail: null };
  }
  return { answers: next, deferred };
}
