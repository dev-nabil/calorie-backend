import type {
  AnswerDetail,
  AnswerStatus,
  AnswerValue,
  InputMethod,
  OnboardingRoute,
} from '../../shared';

export type { AnswerDetail, AnswerValue };

/** Condition grammar of content/onboarding/questions.v1.json (conditionGrammar). */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { q: string; eq: string }
  | { q: string; in: string[] | string }
  | { q: string; includes: string }
  | { q: string; eqSet: string[] }
  | { q: string; answered: boolean }
  | { age: AgeComparison }
  /** Alias accepted from the task brief: { ageGte: 18 } ≡ { age: { gte: 18 } }. */
  | { ageGte: number }
  | { route: OnboardingRoute | { in: OnboardingRoute[] } };

export interface AgeComparison {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
}

export interface BranchRule {
  id?: string;
  show: string;
  when: Condition;
  onHide?: { clear?: string[]; effects?: string[] };
}

export interface OptionDef {
  id: string;
  freeText?: boolean;
  input?: { type: string; min?: number; max?: number; integer?: boolean };
  [key: string]: unknown;
}

export interface QuestionDef {
  id: string;
  fieldKey: string;
  type: 'single' | 'multi' | 'text' | 'age' | 'height' | 'weight' | 'days' | 'number';
  version: number;
  order?: number;
  stage?: number;
  required: boolean;
  max: number | null;
  exclusive: string[];
  options: OptionDef[];
  days: { id: string }[];
  limits: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface QuestionSet {
  version: number;
  questions: QuestionDef[];
  byId: Record<string, QuestionDef>;
  branching: BranchRule[];
  rulesByQuestion: Record<string, BranchRule[]>;
  routes: Record<OnboardingRoute, { questionIds: string[] }>;
  /** Id of the question whose value drives `age` conditions (type 'age', q06). */
  ageQuestionId: string | null;
}

export interface AnswerRecord {
  value: AnswerValue;
  status: AnswerStatus;
  detail?: AnswerDetail | null;
  inputMethod?: InputMethod;
}

export type AnswerMap = Record<string, AnswerRecord>;

export interface EngineContext {
  route: OnboardingRoute;
  /** Device's current day key (YYYY-MM-DD); used to derive age from a date of birth. */
  today: string;
}

export interface AnswerUpdate {
  questionId: string;
  status: 'answered' | 'skipped' | 'deferred';
  value?: AnswerValue;
  detail?: AnswerDetail | null;
  inputMethod?: InputMethod;
}
