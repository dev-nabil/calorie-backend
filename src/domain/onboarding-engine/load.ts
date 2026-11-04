/** Loading and structural validation of a question set (content/onboarding/questions.v1.json). */
import { ONBOARDING_ROUTES, type OnboardingRoute } from '../../shared';
import { z } from 'zod';
import { referencedQuestions } from './conditions';
import type { BranchRule, Condition, QuestionDef, QuestionSet } from './types';

const QUESTION_TYPES = ['single', 'multi', 'text', 'age', 'height', 'weight', 'days', 'number'] as const;

const OptionSchema = z.looseObject({
  id: z.string().min(1),
  freeText: z.boolean().optional(),
  input: z
    .looseObject({ type: z.string(), min: z.number().optional(), max: z.number().optional(), integer: z.boolean().optional() })
    .optional(),
});

const QuestionSchema = z.looseObject({
  id: z.string().min(1),
  fieldKey: z.string().min(1),
  type: z.enum(QUESTION_TYPES),
  version: z.number().int().min(1).default(1),
  order: z.number().optional(),
  stage: z.number().optional(),
  required: z.boolean().default(false),
  max: z.number().int().positive().nullable().default(null),
  exclusive: z.array(z.string()).default([]),
  options: z.array(OptionSchema).default([]),
  days: z.array(z.looseObject({ id: z.string() })).default([]),
  limits: z.record(z.string(), z.unknown()).nullable().default(null),
});

const RouteSchema = z.looseObject({ questionIds: z.array(z.string()) });

const SetSchema = z.looseObject({
  version: z.number().int().min(1),
  questions: z.array(QuestionSchema).min(1),
  branching: z.array(z.unknown()).default([]),
  routes: z.looseObject({ basic: RouteSchema, detailed: RouteSchema, conversation: RouteSchema }),
});

export class QuestionSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionSetError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const AGE_KEYS = new Set(['gte', 'gt', 'lte', 'lt']);

/** Validate one condition node; throws on unknown or malformed forms. */
export function parseCondition(raw: unknown, path = 'when'): Condition {
  if (!isObject(raw)) throw new QuestionSetError(`${path}: condition must be an object`);
  const keys = Object.keys(raw).sort().join(',');
  switch (keys) {
    case 'all':
    case 'any': {
      const list = raw[keys];
      if (!Array.isArray(list)) throw new QuestionSetError(`${path}.${keys}: expected an array`);
      const parsed = list.map((c, i) => parseCondition(c, `${path}.${keys}[${i}]`));
      return keys === 'all' ? { all: parsed } : { any: parsed };
    }
    case 'not':
      return { not: parseCondition(raw.not, `${path}.not`) };
    case 'eq,q':
      if (typeof raw.q === 'string' && typeof raw.eq === 'string') return { q: raw.q, eq: raw.eq };
      break;
    case 'in,q':
      if (typeof raw.q === 'string' && (typeof raw.in === 'string' || (isStringArray(raw.in) && raw.in.length > 0)))
        return { q: raw.q, in: raw.in };
      break;
    case 'includes,q':
      if (typeof raw.q === 'string' && typeof raw.includes === 'string') return { q: raw.q, includes: raw.includes };
      break;
    case 'eqSet,q':
      if (typeof raw.q === 'string' && isStringArray(raw.eqSet) && raw.eqSet.length > 0)
        return { q: raw.q, eqSet: raw.eqSet };
      break;
    case 'answered,q':
      if (typeof raw.q === 'string' && typeof raw.answered === 'boolean') return { q: raw.q, answered: raw.answered };
      break;
    case 'age': {
      const age = raw.age;
      if (
        isObject(age) &&
        Object.keys(age).length > 0 &&
        Object.entries(age).every(([k, v]) => AGE_KEYS.has(k) && typeof v === 'number')
      )
        return { age };
      break;
    }
    case 'ageGte':
      if (typeof raw.ageGte === 'number') return { ageGte: raw.ageGte };
      break;
    case 'route': {
      const r = raw.route;
      const isRoute = (x: unknown): x is OnboardingRoute => ONBOARDING_ROUTES.includes(x as OnboardingRoute);
      if (isRoute(r)) return { route: r };
      if (isObject(r) && Object.keys(r).join() === 'in' && Array.isArray(r.in) && r.in.length > 0 && r.in.every(isRoute))
        return { route: { in: r.in } };
      break;
    }
    default:
      throw new QuestionSetError(`${path}: unknown condition form {${keys}}`);
  }
  throw new QuestionSetError(`${path}: malformed {${keys}} condition`);
}

function parseRule(raw: unknown, i: number): BranchRule {
  if (!isObject(raw) || typeof raw.show !== 'string') {
    throw new QuestionSetError(`branching[${i}]: expected { show, when }`);
  }
  const rule: BranchRule = { show: raw.show, when: parseCondition(raw.when, `branching[${i}].when`) };
  if (typeof raw.id === 'string') rule.id = raw.id;
  if (isObject(raw.onHide)) {
    rule.onHide = {
      clear: isStringArray(raw.onHide.clear) ? raw.onHide.clear : [],
      effects: isStringArray(raw.onHide.effects) ? raw.onHide.effects : [],
    };
  }
  return rule;
}

/** Parse and validate a question set. Throws QuestionSetError on any structural problem. */
export function loadQuestionSet(json: unknown): QuestionSet {
  const parsed = SetSchema.safeParse(json);
  if (!parsed.success) {
    throw new QuestionSetError(
      `Invalid question set: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const data = parsed.data;
  const questions = data.questions as QuestionDef[];
  const byId: Record<string, QuestionDef> = {};
  for (const q of questions) {
    if (byId[q.id]) throw new QuestionSetError(`Duplicate question id ${q.id}`);
    byId[q.id] = q;
  }
  const known = (id: string, where: string): void => {
    if (!byId[id]) throw new QuestionSetError(`${where} references unknown question ${id}`);
  };

  const branching = data.branching.map(parseRule);
  const rulesByQuestion: Record<string, BranchRule[]> = {};
  branching.forEach((rule, i) => {
    known(rule.show, `branching[${i}].show`);
    referencedQuestions(rule.when).forEach((id) => known(id, `branching[${i}].when`));
    rule.onHide?.clear?.forEach((id) => known(id, `branching[${i}].onHide.clear`));
    (rulesByQuestion[rule.show] ??= []).push(rule);
  });

  const routes = {} as Record<OnboardingRoute, { questionIds: string[] }>;
  for (const r of ONBOARDING_ROUTES) {
    const ids = data.routes[r].questionIds;
    ids.forEach((id) => known(id, `routes.${r}`));
    routes[r] = { questionIds: [...ids] };
  }

  const ageQuestion = questions.find((q) => q.type === 'age');
  return {
    version: data.version,
    questions,
    byId,
    branching,
    rulesByQuestion,
    routes,
    ageQuestionId: ageQuestion?.id ?? null,
  };
}
