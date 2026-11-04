/** Onboarding engine (plan section 10; BR-10, BR-11). */
export * from './types';
export { ageFromAnswer, evaluateCondition, hasValue } from './conditions';
export { loadQuestionSet, parseCondition, QuestionSetError } from './load';
export { validateAnswer, type AnswerValidation } from './validate';
export {
  applicableQuestions,
  applyAnswers,
  clearStale,
  deferredQuestions,
  deferUnanswered,
  isApplicable,
  isSettled,
  nextQuestion,
  rulesPass,
  type ApplyResult,
} from './engine';
export { profileFromAnswers, type ProfileFields } from './profile';
export { conversationTurns, nextTurn, type ConversationTurn } from './conversation';
export {
  loadFlowTurns,
  nextFlowTurn,
  openQuestions,
  provisionalViable,
  settleProvisional,
  toStoredValue,
  type FlowChip,
  type FlowTurn,
} from './conversation-flow';
