/**
 * Milo buddy cards (decision 0016): the structured results under a chat reply. Pure. Numbers come from the diary
 * (DayResponse), the recap stats and the draft calculator; the model only proposes names, amounts and per-100 g bases,
 * which go through the same food-nutrition code. Health numbers from the phone appear only in the live response:
 * `stripHealth` removes them before anything is stored.
 */
import { createHash } from 'node:crypto';
import { computeMealTotals, matchFoodRecord, nutrientsForGrams, recordSource, sanitisePer100g, AI_ESTIMATE, type FoodIndex } from '../food-nutrition';
import { applyModelOps, portionFraction, type DraftContext } from '../chat-draft';
import { avoidedTermsIn } from '../plan-narrative';
import {
  BUDDY_LIMITS,
  MEAL_CATEGORIES,
  type CardAction,
  type ChatCard,
  type ChatCardOf,
  type ChatDraft,
  type DayResponse,
  type InterpretOutput,
  type InterpretOp,
  type MealCategory,
  type MealTotals,
  type MemoryCategory,
  type RecapStats,
  type ReminderInput,
  type ServerActionType,
  type TurnBudget,
} from '../../shared';
import type { LocaleCode } from '../../shared/locales';

const round1 = (n: number): number => Math.round(n * 10) / 10;
const trimTo = (s: string | null | undefined, max: number): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Deterministic action ids: the same card for the same draft version gets the same id, so a repeat cannot run twice. */
export function actionIdFor(...parts: Array<string | number | null | undefined>): string {
  return `a_${createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 24)}`;
}

export function cardIdFor(...parts: Array<string | number | null | undefined>): string {
  return `c_${createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 16)}`;
}

/** What the server stores for a server action (chat_actions), so executing it never trusts the client. */
export interface ActionSpec {
  id: string;
  type: ServerActionType;
  draftId: string | null;
  draftVersion: number | null;
  payload: Record<string, unknown>;
}

const serverAction = (id: string, type: ServerActionType, blockedBy: CardAction['blockedBy'] = null): CardAction => ({ id, type, enabled: blockedBy === null, blockedBy, payload: null });
const clientAction = (type: CardAction['type'], payload: Record<string, unknown> | null = null): CardAction => ({ id: null, type, enabled: true, blockedBy: null, payload });

/** The meal slot for a local hour when the person did not pick one. */
export function defaultCategory(localHour: number): MealCategory {
  if (localHour >= 4 && localHour < 11) return 'breakfast';
  if (localHour >= 11 && localHour < 16) return 'lunch';
  if (localHour >= 16 && localHour < 22) return 'dinner';
  return 'snack';
}

// ── Draft cards ───────────────────────────────────────────────────────────────────────────────────

export interface DraftCardOptions {
  conversationId: string;
  date: string;
  category: MealCategory;
  /** Meals logged from this draft that were deleted since (undo): a fresh log action is offered. */
  deletedLogMealIds?: readonly string[];
}

/** Recipe + portion cards, or a meal card, with their actions. */
export function draftCards(d: ChatDraft, o: DraftCardOptions): { cards: ChatCard[]; actions: ActionSpec[] } {
  if (!d.items.length || d.status === 'discarded') return { cards: [], actions: [] };
  const actions: ActionSpec[] = [];
  const liveLogs = d.logs.filter((l) => !(o.deletedLogMealIds ?? []).includes(l.mealId));
  const logSeq = d.logs.length - liveLogs.length; // a log undone since gives a new id
  const logType: ServerActionType = d.kind === 'recipe' ? 'log_portion' : 'log_meal';
  const logId = actionIdFor(o.conversationId, logType, d.id, d.version, logSeq);
  const { fraction, pending } = portionFraction(d);
  actions.push({ id: logId, type: logType, draftId: d.id, draftVersion: d.version, payload: {} });
  const logAction = serverAction(logId, logType, fraction === null ? (pending ?? 'portion') : null);
  if (d.kind === 'meal') {
    const card: ChatCardOf<'meal'> = {
      id: cardIdFor(d.id, d.version, 'meal'),
      type: 'meal',
      draftId: d.id,
      version: d.version,
      name: d.name,
      items: d.items,
      totals: d.portionTotals ?? d.totals,
      assumptions: d.assumptions,
      date: o.date,
      category: o.category,
      actions: [clientAction('edit_items'), logAction],
    };
    return { cards: [card], actions };
  }
  const saveType: ServerActionType = d.savedRecipeId ? 'update_recipe' : 'save_recipe';
  const saveId = actionIdFor(o.conversationId, saveType, d.id, d.version);
  actions.push({ id: saveId, type: saveType, draftId: d.id, draftVersion: d.version, payload: { recipeId: d.savedRecipeId } });
  const recipeCard: ChatCardOf<'recipe'> = {
    id: cardIdFor(d.id, d.version, 'recipe'),
    type: 'recipe',
    draftId: d.id,
    version: d.version,
    name: d.name,
    items: d.items,
    servings: d.recipe?.servings ?? null,
    cookedYieldG: d.recipe?.cookedYieldG ?? null,
    rawWeightG: d.recipe?.rawWeightG ?? 0,
    totals: d.totals,
    assumptions: d.assumptions,
    savedRecipeId: d.savedRecipeId,
    actions: [clientAction('edit_items'), clientAction('change_portion'), serverAction(saveId, saveType)],
  };
  const portionCard: ChatCardOf<'portion'> = {
    id: cardIdFor(d.id, d.version, 'portion'),
    type: 'portion',
    draftId: d.id,
    version: d.version,
    name: d.name,
    portion: d.portion,
    servingsTotal: d.recipe?.servings ?? null,
    grams: d.portionGrams,
    gramsBasis: d.gramsBasis,
    totals: d.portionTotals,
    date: o.date,
    category: o.category,
    actions: [clientAction('change_portion'), logAction],
  };
  return { cards: [recipeCard, portionCard], actions };
}

// ── Day summary ───────────────────────────────────────────────────────────────────────────────────

export interface DaySummaryOptions {
  today: string;
  habitsOnly: boolean;
  /** From the phone, this turn only. Applied only for today and when the toggle added something. */
  budget: TurnBudget | null;
}

/**
 * What was logged on a day against the goal. Slots with no meal have no kcal (never 0): missing logs are not "skipped".
 * The activity adjustment is the one the app already added to the base goal; nothing is added on top of it here.
 */
export function daySummaryCard(day: DayResponse, o: DaySummaryOptions): ChatCardOf<'day_summary'> {
  const isToday = day.date === o.today;
  const habits = o.habitsOnly || day.targets.energyKcal === null;
  const base = habits ? null : day.targets.energyKcal;
  const adj = !habits && isToday && o.budget?.addActivity && o.budget.activityAdjustmentKcal > 0 ? o.budget.activityAdjustmentKcal : 0;
  const goal = base === null ? null : base + adj;
  const t = day.targets;
  const slots = MEAL_CATEGORIES.map((category) => {
    const c = day.categories.find((x) => x.category === category);
    const mealCount = c?.mealCount ?? 0;
    return { category, mealCount, kcal: habits || mealCount === 0 ? null : Math.round(c!.totals.kcal) };
  });
  return {
    id: cardIdFor('day', day.date),
    type: 'day_summary',
    date: day.date,
    isToday,
    mode: habits ? 'habits_only' : 'full',
    logged: {
      meals: day.meals.length,
      kcal: habits ? null : Math.round(day.totals.kcal),
      proteinG: habits ? null : round1(day.totals.proteinG),
      carbsG: habits ? null : round1(day.totals.carbsG),
      fatG: habits ? null : round1(day.totals.fatG),
    },
    slots,
    baseKcal: base,
    budget: adj > 0 && goal !== null ? { activityAdjustmentKcal: adj, goalKcal: goal } : null,
    budgetBasis: adj > 0 ? 'adjusted' : 'base',
    remaining: habits
      ? null
      : {
          kcal: goal === null ? null : Math.round(goal - day.totals.kcal),
          proteinG: t.proteinG === null ? null : round1(t.proteinG - day.totals.proteinG),
          carbsG: t.carbsG === null ? null : round1(t.carbsG - day.totals.carbsG),
          fatG: t.fatG === null ? null : round1(t.fatG - day.totals.fatG),
        },
    water: { totalMl: day.water.totalMl, targetMl: day.water.targetMl },
    basis: 'logged',
    actions: [],
  };
}

/**
 * Removes every health-derived number before a card is stored (message snapshots, turn replays). A day summary falls back
 * to the base goal: the adjusted remaining minus the adjustment is exactly the base remaining.
 */
export function stripHealth(cards: readonly ChatCard[]): ChatCard[] {
  return cards.map((c) => {
    if (c.type !== 'day_summary' || !c.budget) return c;
    const adj = c.budget.activityAdjustmentKcal;
    return {
      ...c,
      budget: null,
      budgetBasis: 'base',
      remaining: c.remaining ? { ...c.remaining, kcal: c.remaining.kcal === null ? null : c.remaining.kcal - adj } : null,
    };
  });
}

const HEALTH_KEYS = ['activityAdjustmentKcal', 'activeKcal', 'addActivity'];
/** True when any key of the object tree is a health number from the phone (tests and a last check before storing). */
export function containsHealthKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsHealthKeys);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => HEALTH_KEYS.includes(k) || containsHealthKeys(v));
}

// ── Weekly review ─────────────────────────────────────────────────────────────────────────────────

export interface WeeklyReviewInput {
  range: 'last' | 'this';
  weekStart: string;
  weekEnd: string;
  habitsOnly: boolean;
  stats: RecapStats;
  /** Every day of the range with whether something was logged. */
  days: readonly { date: string; logged: boolean }[];
  /** Weight entries inside the range, oldest first. */
  weights: readonly { date: string; weightKg: number }[];
}

const dayNumber = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;

/** The week as the recap computes it, with the days that have nothing logged and a weight trend only when there is enough. */
export function weeklyReviewCard(i: WeeklyReviewInput): ChatCardOf<'weekly_review'> {
  const missingDays = i.days.filter((d) => !d.logged).map((d) => d.date);
  const first = i.weights[0];
  const last = i.weights.at(-1);
  const enough = Boolean(first && last && i.weights.length >= 2 && dayNumber(last.date) - dayNumber(first.date) >= 3);
  return {
    id: cardIdFor('week', i.range, i.weekStart, i.weekEnd),
    type: 'weekly_review',
    range: i.range,
    weekStart: i.weekStart,
    weekEnd: i.weekEnd,
    mode: i.habitsOnly ? 'habits_only' : 'full',
    stats: i.stats,
    missingDays,
    limitedData: i.stats.loggedDays < Math.min(4, i.stats.daysInRange),
    weight: i.habitsOnly
      ? null
      : {
          entries: i.weights.length,
          firstKg: first ? round1(first.weightKg) : null,
          lastKg: last ? round1(last.weightKg) : null,
          changeKg: enough ? round1(last!.weightKg - first!.weightKg) : null,
          enough,
        },
    actions: [],
  };
}

// ── Suggestions and comparisons ───────────────────────────────────────────────────────────────────

const NO_RECORDS: FoodIndex = { byAlias: new Map(), sources: {} };

function valuesFor(name: string, en: string, grams: number, n: InterpretOutput['suggestions'][number]['n'], records: FoodIndex) {
  const record = matchFoodRecord(records, [en, name], 'unknown') ?? matchFoodRecord(records, [en, name], 'mixed');
  const per100g = record?.per100g ?? sanitisePer100g({ kcal: n?.kcal ?? null, proteinG: n?.p ?? null, carbsG: n?.c ?? null, fatG: n?.f ?? null, fiberG: n?.fib ?? null, sugarG: n?.sug ?? null, sodiumMg: n?.na ?? null }).per100g;
  return { values: nutrientsForGrams(per100g, grams), source: record ? recordSource(records, record) : AI_ESTIMATE };
}

export interface SuggestionOptions {
  habitsOnly: boolean;
  /** Lower-case allergen and diet-pattern terms (plan-narrative avoidTermsFor). */
  avoidTerms: readonly string[];
  locale: LocaleCode;
  records?: FoodIndex;
  basis: 'remaining' | 'ingredients' | 'general';
}

/** At most three options; any that names a declared allergen or goes against the diet pattern is dropped, never shown. */
export function suggestionsCard(raw: InterpretOutput['suggestions'], o: SuggestionOptions): { card: ChatCardOf<'suggestions'> | null; dropped: number } {
  let dropped = 0;
  const options: ChatCardOf<'suggestions'>['options'] = [];
  for (const s of raw) {
    const name = trimTo(s.name, 80);
    if (!name || options.length >= BUDDY_LIMITS.suggestions) continue;
    const text = [name, s.en, ...s.uses, ...s.extra].join('. ');
    if (o.avoidTerms.length && avoidedTermsIn(text, o.avoidTerms, o.locale).length) {
      dropped++;
      continue;
    }
    const grams = typeof s.g === 'number' && s.g > 0 && s.g <= 2000 ? round1(s.g) : null;
    const v = grams === null ? null : valuesFor(name, s.en, grams, s.n, o.records ?? NO_RECORDS).values;
    options.push({
      name,
      why: trimTo(s.why, 160),
      grams,
      kcal: o.habitsOnly || !v ? null : v.kcal,
      proteinG: v?.proteinG ?? null,
      carbsG: v?.carbsG ?? null,
      fatG: v?.fatG ?? null,
      minutes: typeof s.minutes === 'number' && s.minutes > 0 && s.minutes <= 600 ? Math.round(s.minutes) : null,
      uses: s.uses.map((u) => trimTo(u, 60)).filter(Boolean).slice(0, 10),
      extra: s.extra.map((u) => trimTo(u, 60)).filter(Boolean).slice(0, 10),
    });
  }
  if (!options.length) return { card: null, dropped };
  return { card: { id: cardIdFor('sugg', ...options.map((x) => x.name)), type: 'suggestions', basis: o.basis, options, actions: [] }, dropped };
}

export function comparisonCard(raw: InterpretOutput['compare'], records: FoodIndex = NO_RECORDS): ChatCardOf<'comparison'> | null {
  const usable = raw.filter((c) => trimTo(c.name, 80)).slice(0, BUDDY_LIMITS.compareItems);
  if (usable.length < 2) return null;
  const allPortions = usable.every((c) => typeof c.g === 'number' && c.g > 0 && c.g <= 2000);
  const items = usable.map((c) => {
    const grams = allPortions ? round1(c.g!) : 100;
    const { values, source } = valuesFor(c.name, c.en, grams, c.n, records);
    return { name: trimTo(c.name, 80), grams, kcal: values.kcal, proteinG: values.proteinG, carbsG: values.carbsG, fatG: values.fatG, fiberG: values.fiberG, source };
  });
  return { id: cardIdFor('cmp', ...items.map((i) => i.name)), type: 'comparison', per: allPortions ? 'portion' : '100g', items, actions: [] };
}

const delta = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : round1(b - a));

/** A suggested change to the recipe, shown with its effect; applied only when the person agrees (apply_changes). */
export function recipeChangeCard(d: ChatDraft, proposed: readonly InterpretOp[], ctx: DraftContext, labels: readonly string[]): { card: ChatCardOf<'recipe_change'>; action: ActionSpec } | null {
  if (!proposed.length || !d.items.length) return null;
  const after = applyModelOps(d, proposed, ctx);
  if (!after.changed || !after.draft || after.draft.id !== d.id || after.ambiguous) return null;
  const before: MealTotals = d.totals;
  const next: MealTotals = after.draft.totals;
  const id = actionIdFor(ctx.conversationId, 'apply_changes', d.id, d.version, JSON.stringify(proposed));
  return {
    card: {
      id: cardIdFor('chg', d.id, d.version, id),
      type: 'recipe_change',
      draftId: d.id,
      baseVersion: d.version,
      changes: labels.map((label) => ({ label: trimTo(label, 120) })).filter((c) => c.label),
      before,
      after: next,
      delta: { kcal: delta(before.kcal, next.kcal), proteinG: delta(before.proteinG, next.proteinG), carbsG: delta(before.carbsG, next.carbsG), fatG: delta(before.fatG, next.fatG) },
      actions: [serverAction(id, 'apply_changes')],
    },
    action: { id, type: 'apply_changes', draftId: d.id, draftVersion: d.version, payload: { ops: proposed } },
  };
}

/** A human label per proposed op for the recipe_change card ("Oil: 20 g"). */
export function changeLabels(d: ChatDraft, ops: readonly InterpretOp[]): string[] {
  return ops.map((op) => {
    const item = op.itemId ? d.items.find((i) => i.id === op.itemId) : undefined;
    const amount = op.qty !== null && op.unit ? `${op.qty} ${op.unit}` : op.g !== null ? `${op.g} g` : '';
    if (op.op === 'remove_item') return `− ${item?.name ?? op.name ?? ''}`.trim();
    if (op.op === 'add_item') return `+ ${op.name ?? op.en ?? ''} ${amount}`.trim();
    if (op.op === 'update_item') return `${item?.name ?? op.name ?? ''}: ${amount}`.trim();
    return op.op;
  });
}

// ── Proposals and results ─────────────────────────────────────────────────────────────────────────

export function memoryProposalCard(conversationId: string, m: { text: string; category: MemoryCategory; sensitive: boolean }, canSave: boolean): { card: ChatCardOf<'memory_proposal'>; action: ActionSpec } {
  const text = trimTo(m.text, BUDDY_LIMITS.memoryMaxChars);
  const id = actionIdFor(conversationId, 'save_memory', text.toLowerCase());
  return {
    card: { id: cardIdFor('mem', id), type: 'memory_proposal', proposalId: id, text, category: m.category, sensitive: m.sensitive, actions: [serverAction(id, 'save_memory', canSave ? null : 'plus')] },
    action: { id, type: 'save_memory', draftId: null, draftVersion: null, payload: { text, category: m.category, sensitive: m.sensitive } },
  };
}

export function reminderProposalCard(conversationId: string, reminder: ReminderInput, overCap: boolean): { card: ChatCardOf<'reminder_proposal'>; action: ActionSpec } {
  const id = actionIdFor(conversationId, 'create_reminder', JSON.stringify(reminder));
  return {
    card: { id: cardIdFor('rem', id), type: 'reminder_proposal', reminder, actions: [serverAction(id, 'create_reminder', overCap ? 'limit' : null), clientAction('open_reminders')] },
    action: { id, type: 'create_reminder', draftId: null, draftVersion: null, payload: { reminder } },
  };
}

export function actionResultCard(
  type: ServerActionType,
  r: { actionId: string; mealId?: string | null; recipeId?: string | null; reminderId?: string | null; memoryId?: string | null; date?: string | null; category?: MealCategory | null },
): ChatCardOf<'action_result'> {
  const actions: CardAction[] = [];
  if (r.mealId) actions.push(clientAction('open_meal', { mealId: r.mealId }), clientAction('undo', { mealId: r.mealId }));
  if (r.reminderId) actions.push(clientAction('open_reminders'));
  if (r.memoryId) actions.push(clientAction('open_memory'));
  return {
    id: cardIdFor('done', r.actionId),
    type: 'action_result',
    actionType: type,
    status: 'done',
    mealId: r.mealId ?? null,
    recipeId: r.recipeId ?? null,
    reminderId: r.reminderId ?? null,
    memoryId: r.memoryId ?? null,
    date: r.date ?? null,
    category: r.category ?? null,
    actions,
  };
}

/** Totals of nothing (a card that has no draft yet). */
export const NO_TOTALS: MealTotals = computeMealTotals([]);
