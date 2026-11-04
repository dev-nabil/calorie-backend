/**
 * Conversation turn groups (plan 8.5, section 10; content/onboarding/conversation.v1.json).
 * The server drives the order; the model only handles language.
 */
import { evaluateCondition } from './conditions';
import { isSettled, rulesPass } from './engine';
import { parseCondition, QuestionSetError } from './load';
import type { AnswerMap, Condition, EngineContext, QuestionSet } from './types';

export interface ConversationTurn {
  id: string;
  questionIds: string[];
  /** When true the whole turn is skipped (conversation rules.skipWhen). */
  skipWhen: Condition | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Turn groups from conversation.v1.json, or one turn per question of the conversation
 * route when the file is absent.
 */
export function conversationTurns(set: QuestionSet, conversationJson?: unknown): ConversationTurn[] {
  if (conversationJson === undefined || conversationJson === null) {
    return set.routes.conversation.questionIds.map((id) => ({ id, questionIds: [id], skipWhen: null }));
  }
  if (!isObject(conversationJson) || !Array.isArray(conversationJson.turns)) {
    throw new QuestionSetError('conversation: expected { turns: [] }');
  }
  return conversationJson.turns.map((raw, i) => {
    if (!isObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.questionIds)) {
      throw new QuestionSetError(`conversation.turns[${i}]: expected { id, questionIds }`);
    }
    const questionIds = raw.questionIds.map((q) => {
      if (typeof q !== 'string' || !set.byId[q]) {
        throw new QuestionSetError(`conversation.turns[${i}] references unknown question ${String(q)}`);
      }
      return q;
    });
    const skipWhen =
      raw.skipWhen === undefined || raw.skipWhen === null
        ? null
        : parseCondition(raw.skipWhen, `conversation.turns[${i}].skipWhen`);
    return { id: raw.id, questionIds, skipWhen };
  });
}

/**
 * First turn with at least one applicable, unsettled question, narrowed to those questions.
 * Turns without questions (the intro) and turns whose skipWhen holds are passed over.
 */
export function nextTurn(
  set: QuestionSet,
  turns: ConversationTurn[],
  answers: AnswerMap,
  ctx: EngineContext,
): ConversationTurn | null {
  for (const turn of turns) {
    if (turn.skipWhen && evaluateCondition(turn.skipWhen, answers, ctx, set)) continue;
    const pending = turn.questionIds.filter((id) => rulesPass(set, id, answers, ctx) && !isSettled(answers[id]));
    if (pending.length > 0) return { ...turn, questionIds: pending };
  }
  return null;
}
