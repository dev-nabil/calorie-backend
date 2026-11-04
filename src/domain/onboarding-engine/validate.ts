/** Server-side answer validation (M2-T3): options, exclusive, max, limits and units. */
import { isValidDayKey } from '../day-keys';
import { ageFromAnswer } from './conditions';
import type { AnswerDetail, AnswerValue, OptionDef, QuestionDef, QuestionSet } from './types';

export type AnswerValidation =
  | { ok: true; value: AnswerValue; detail: AnswerDetail | null }
  | {
      ok: false;
      code: 'QUESTION_NOT_FOUND' | 'ANSWER_INVALID';
      message: string;
      details: Record<string, unknown>;
    };

class Invalid extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function limit(q: QuestionDef, key: string): number | undefined {
  return num(q.limits?.[key]);
}

function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Invalid(`Unknown fields: ${extra.join(', ')}`, { fields: extra });
}

function inRange(n: number, min: number | undefined, max: number | undefined, field: string): void {
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new Invalid(`${field} must be between ${min ?? '-∞'} and ${max ?? '∞'}`, { field, min, max });
  }
}

function optionOf(q: QuestionDef, id: string): OptionDef {
  const opt = q.options.find((o) => o.id === id);
  if (!opt) throw new Invalid(`Unknown option ${id}`, { option: id });
  return opt;
}

/** detail.text only on freeText options; detail.number only on options with a number input. */
function validateDetail(selected: OptionDef[], detail: AnswerDetail | null | undefined): AnswerDetail | null {
  const numberOpt = selected.find((o) => o.input?.type === 'number');
  if (numberOpt) {
    const n = detail?.number;
    if (n === undefined || !Number.isInteger(n)) {
      throw new Invalid(`Option ${numberOpt.id} needs a whole number in detail.number`, { field: 'detail.number' });
    }
    inRange(n, numberOpt.input?.min, numberOpt.input?.max, 'detail.number');
  } else if (detail?.number !== undefined) {
    throw new Invalid('detail.number is not allowed for this answer', { field: 'detail.number' });
  }
  if (detail?.text !== undefined) {
    if (!selected.some((o) => o.freeText)) {
      throw new Invalid('detail.text is only allowed with a free-text option', { field: 'detail.text' });
    }
    const text = detail.text.trim();
    if (text.length < 1 || [...text].length > 50) throw new Invalid('detail.text must be 1–50 characters');
  }
  if (!detail || (detail.text === undefined && detail.number === undefined)) return null;
  const out: AnswerDetail = {};
  if (detail.text !== undefined) out.text = detail.text.trim();
  if (detail.number !== undefined) out.number = detail.number;
  return out;
}

function validateSingle(q: QuestionDef, value: AnswerValue, detail?: AnswerDetail | null): [AnswerValue, AnswerDetail | null] {
  if (typeof value !== 'string') throw new Invalid('Expected an option id');
  return [value, validateDetail([optionOf(q, value)], detail)];
}

/** multi and days: unique known ids, exclusive options alone, at most `max`. */
function validateMulti(q: QuestionDef, value: AnswerValue, detail?: AnswerDetail | null): [AnswerValue, AnswerDetail | null] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Invalid('Expected an array of option ids');
  }
  if (new Set(value).size !== value.length) throw new Invalid('Duplicate selections');
  const dayIds = q.type === 'days' ? new Set(q.days.map((d) => d.id)) : new Set<string>();
  const selected: OptionDef[] = [];
  for (const id of value) {
    if (dayIds.has(id)) continue;
    selected.push(optionOf(q, id));
  }
  const exclusive = value.filter((v) => q.exclusive.includes(v));
  if (exclusive.length > 0 && value.length > 1) {
    throw new Invalid(`${exclusive.join(', ')} cannot be combined with other choices`, { exclusive });
  }
  if (q.max !== null && value.length > q.max) {
    throw new Invalid(`Choose at most ${q.max}`, { max: q.max });
  }
  return [[...value], validateDetail(selected, detail)];
}

function validateText(q: QuestionDef, value: AnswerValue): AnswerValue {
  if (typeof value !== 'string') throw new Invalid('Expected text');
  const text = value.trim();
  const max = limit(q, 'maxLength') ?? 50;
  if (text.length === 0 || [...text].length > max) throw new Invalid(`Text must be 1–${max} characters`, { max });
  return text;
}

function validateAge(q: QuestionDef, value: AnswerValue, today: string): AnswerValue {
  if (!isObject(value)) throw new Invalid('Expected { mode, … }');
  const min = limit(q, 'min');
  const max = limit(q, 'max');
  switch (value.mode) {
    case 'none':
      assertKeys(value, ['mode']);
      return { mode: 'none' };
    case 'age': {
      assertKeys(value, ['mode', 'age']);
      const age = num(value.age);
      if (age === undefined || !Number.isInteger(age)) throw new Invalid('age must be a whole number', { field: 'age' });
      inRange(age, min, max, 'age');
      return { mode: 'age', age };
    }
    case 'dob': {
      assertKeys(value, ['mode', 'dob']);
      if (typeof value.dob !== 'string' || !isValidDayKey(value.dob)) {
        throw new Invalid('dob must be YYYY-MM-DD', { field: 'dob' });
      }
      const age = ageFromAnswer(value, today);
      if (age === null) throw new Invalid('dob cannot be in the future', { field: 'dob' });
      inRange(age, min, max, 'age');
      return { mode: 'dob', dob: value.dob };
    }
    default:
      throw new Invalid('mode must be dob, age or none', { field: 'mode' });
  }
}

function validateHeight(q: QuestionDef, value: AnswerValue): AnswerValue {
  if (!isObject(value)) throw new Invalid('Expected { cm, unit }');
  assertKeys(value, ['cm', 'unit']);
  const cm = num(value.cm);
  if (cm === undefined) throw new Invalid('cm must be a number', { field: 'cm' });
  inRange(cm, limit(q, 'min'), limit(q, 'max'), 'cm');
  const unit = value.unit ?? 'cm';
  if (unit !== 'cm' && unit !== 'ft_in') throw new Invalid('unit must be cm or ft_in', { field: 'unit' });
  return { cm: Math.round(cm * 10) / 10, unit };
}

function validateWeight(q: QuestionDef, value: AnswerValue): AnswerValue {
  if (!isObject(value)) throw new Invalid('Expected { kg, unit, isEstimate }');
  assertKeys(value, ['kg', 'unit', 'isEstimate']);
  const kg = num(value.kg);
  if (kg === undefined) throw new Invalid('kg must be a number', { field: 'kg' });
  inRange(kg, limit(q, 'min'), limit(q, 'max'), 'kg');
  const unit = value.unit ?? 'kg';
  if (unit !== 'kg' && unit !== 'lb') throw new Invalid('unit must be kg or lb', { field: 'unit' });
  if (value.isEstimate !== undefined && typeof value.isEstimate !== 'boolean') {
    throw new Invalid('isEstimate must be a boolean', { field: 'isEstimate' });
  }
  // target_weight has no estimate flag (limits.estimateFlag false): always false.
  const estimateAllowed = q.limits?.estimateFlag !== false;
  return { kg: Math.round(kg * 10) / 10, unit, isEstimate: estimateAllowed ? value.isEstimate === true : false };
}

function validateNumber(q: QuestionDef, value: AnswerValue): AnswerValue {
  const n = num(value);
  if (n === undefined) throw new Invalid('Expected a number');
  inRange(n, limit(q, 'min'), limit(q, 'max'), 'value');
  return n;
}

const utcToday = (): string => new Date().toISOString().slice(0, 10);

/**
 * Validate and normalise one answered value. `today` is the device day key used for date of
 * birth checks (defaults to the UTC date).
 */
export function validateAnswer(
  set: QuestionSet,
  questionId: string,
  value: AnswerValue | undefined,
  detail?: AnswerDetail | null,
  today: string = utcToday(),
): AnswerValidation {
  const q = set.byId[questionId];
  if (!q) {
    return { ok: false, code: 'QUESTION_NOT_FOUND', message: `Unknown question ${questionId}`, details: { questionId } };
  }
  try {
    if (value === undefined || value === null) throw new Invalid('A value is required');
    let out: [AnswerValue, AnswerDetail | null];
    switch (q.type) {
      case 'single':
        out = validateSingle(q, value, detail);
        break;
      case 'multi':
      case 'days':
        out = validateMulti(q, value, detail);
        break;
      case 'text':
        out = [validateText(q, value), null];
        break;
      case 'age':
        out = [validateAge(q, value, today), null];
        break;
      case 'height':
        out = [validateHeight(q, value), null];
        break;
      case 'weight':
        out = [validateWeight(q, value), null];
        break;
      default:
        out = [validateNumber(q, value), null];
    }
    if (q.type !== 'single' && q.type !== 'multi' && q.type !== 'days' && detail && (detail.text ?? detail.number) !== undefined) {
      throw new Invalid('detail is not allowed for this question', { field: 'detail' });
    }
    return { ok: true, value: out[0], detail: out[1] };
  } catch (e) {
    if (!(e instanceof Invalid)) throw e;
    return { ok: false, code: 'ANSWER_INVALID', message: e.message, details: { questionId, ...e.details } };
  }
}
