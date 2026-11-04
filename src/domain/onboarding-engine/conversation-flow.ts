/**
 * Conversation walk with provisional questions (content/onboarding/conversation.v1.json rules):
 * turns run in order; a turn is asked while it has open questions; q08/q09 are asked before q07
 * (provisional), held without saving, and committed once the branching rules show them, or dropped
 * when they can no longer apply (under 18, age declined, q07 unsure/none). Pure functions.
 */
import { evaluateCondition, hasValue } from './conditions';
import { isSettled, rulesPass } from './engine';
import { parseCondition, QuestionSetError } from './load';
import type { AnswerMap, AnswerUpdate, AnswerValue, Condition, EngineContext, QuestionDef, QuestionSet } from './types';

export interface FlowChip {
  label: string;
  action?: string;
  sets?: Record<string, AnswerValue>;
  skips?: string[];
}

export interface FlowTurn {
  id: string;
  turn: number;
  questionIds: string[];
  provisional: string[];
  skipWhen: Condition | null;
  miloLine: string;
  askOne: Record<string, string>;
  chips: FlowChip[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function loadFlowTurns(set: QuestionSet, json: unknown): FlowTurn[] {
  if (!isObject(json) || !Array.isArray(json.turns)) throw new QuestionSetError('conversation: expected { turns: [] }');
  return json.turns.map((raw, i) => {
    if (!isObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.questionIds)) {
      throw new QuestionSetError(`conversation.turns[${i}]: expected { id, questionIds }`);
    }
    for (const q of raw.questionIds) if (typeof q !== 'string' || !set.byId[q]) throw new QuestionSetError(`conversation.turns[${i}]: unknown question ${String(q)}`);
    return {
      id: raw.id,
      turn: typeof raw.turn === 'number' ? raw.turn : i + 1,
      questionIds: raw.questionIds as string[],
      provisional: Array.isArray(raw.provisional) ? (raw.provisional as string[]) : [],
      skipWhen: raw.skipWhen ? parseCondition(raw.skipWhen, `conversation.turns[${i}].skipWhen`) : null,
      miloLine: typeof raw.miloLine === 'string' ? raw.miloLine : '',
      askOne: isObject(raw.askOne) ? (raw.askOne as Record<string, string>) : {},
      chips: Array.isArray(raw.chips) ? (raw.chips as FlowChip[]) : [],
    };
  });
}

/**
 * A provisional question (q08/q09) can still apply unless age is settled and not adult (or
 * declined) or the sex input was answered with something other than female/male.
 */
export function provisionalViable(set: QuestionSet, answers: AnswerMap, ctx: EngineContext): boolean {
  const ageId = set.ageQuestionId;
  if (ageId && isSettled(answers[ageId]) && !evaluateCondition({ age: { gte: 18 } } as Condition, answers, ctx, set)) return false;
  const sex = answers.q07;
  if (sex && isSettled(sex) && sex.value !== 'female' && sex.value !== 'male') return false;
  return true;
}

export function openQuestions(set: QuestionSet, turn: FlowTurn, answers: AnswerMap, held: Record<string, unknown>, ctx: EngineContext): string[] {
  const viable = provisionalViable(set, answers, ctx);
  return turn.questionIds.filter((id) => {
    if (isSettled(answers[id])) return false;
    if (turn.provisional.includes(id) && !rulesPass(set, id, answers, ctx)) return viable && !(id in held);
    return rulesPass(set, id, answers, ctx);
  });
}

/** First turn after `afterTurn` (inclusive when `stay`) with open questions; null when the walk is done. */
export function nextFlowTurn(
  set: QuestionSet,
  turns: FlowTurn[],
  answers: AnswerMap,
  held: Record<string, unknown>,
  ctx: EngineContext,
): { turn: FlowTurn; open: string[] } | null {
  for (const turn of turns) {
    if (!turn.questionIds.length) continue;
    if (turn.skipWhen && evaluateCondition(turn.skipWhen, answers, ctx, set)) continue;
    const open = openQuestions(set, turn, answers, held, ctx);
    if (open.length) return { turn, open };
  }
  return null;
}

/** Splits held provisional values into ones to save now, ones to drop and ones to keep holding. */
export function settleProvisional(
  set: QuestionSet,
  answers: AnswerMap,
  held: Record<string, AnswerValue>,
  ctx: EngineContext,
): { commit: AnswerUpdate[]; drop: string[]; keep: Record<string, AnswerValue> } {
  const viable = provisionalViable(set, answers, ctx);
  const commit: AnswerUpdate[] = [];
  const drop: string[] = [];
  const keep: Record<string, AnswerValue> = {};
  const trial: AnswerMap = { ...answers };
  const order = set.questions.map((q) => q.id).filter((id) => id in held);
  for (const id of order) {
    if (rulesPass(set, id, trial, ctx)) {
      commit.push({ questionId: id, status: 'answered', value: held[id]!, inputMethod: 'voice' });
      trial[id] = { value: held[id]!, status: 'answered' };
    } else if (!viable) drop.push(id);
    else keep[id] = held[id]!;
  }
  return { commit, drop, keep };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Converts an extraction value (onboarding-extract.v1.md schema) to the stored value format of
 * questions.v1.json `valueFormats`. Returns undefined when it cannot be converted; null is a decline.
 */
export function toStoredValue(q: QuestionDef, value: unknown): AnswerValue | undefined {
  if (value === null) return null;
  if (q.type === 'age') {
    if (!isObject(value)) return undefined;
    if (value.mode === 'none') return { mode: 'none' };
    if (value.mode === 'age' && num(value.age) !== null) return { mode: 'age', age: num(value.age)! };
    if (value.mode === 'dob' && typeof value.dob === 'string') return { mode: 'dob', dob: value.dob };
    return undefined;
  }
  if (q.type === 'height') {
    if (!isObject(value)) return undefined;
    if (value.unit === 'cm' && num(value.value) !== null) return { cm: round1(num(value.value)!), unit: 'cm' };
    if (value.unit === 'm' && num(value.value) !== null) return { cm: round1(num(value.value)! * 100), unit: 'cm' };
    if (value.unit === 'ft_in' && num(value.feet) !== null) return { cm: round1(((num(value.feet) ?? 0) * 12 + (num(value.inches) ?? 0)) * 2.54), unit: 'ft_in' };
    return undefined;
  }
  if (q.type === 'weight') {
    if (!isObject(value)) return undefined;
    let kg: number | null = null;
    let unit: 'kg' | 'lb' = 'kg';
    if (value.unit === 'kg') kg = num(value.value);
    else if (value.unit === 'lb' && num(value.value) !== null) [kg, unit] = [num(value.value)! * 0.45359237, 'lb'];
    else if (value.unit === 'st_lb' && num(value.stone) !== null) [kg, unit] = [((num(value.stone) ?? 0) * 14 + (num(value.pounds) ?? 0)) * 0.45359237, 'lb'];
    if (kg === null) return undefined;
    const estimate = q.limits?.estimateFlag === false ? {} : { isEstimate: value.isEstimate === true };
    return { kg: round1(kg), unit, ...estimate };
  }
  if (q.type === 'text') return typeof value === 'string' && value.trim() ? value.trim().slice(0, 50) : undefined;
  if (q.type === 'multi' || q.type === 'days') return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
  if (typeof value === 'string' && hasValue(value)) return value;
  return undefined;
}
