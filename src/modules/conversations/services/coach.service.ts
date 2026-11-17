import { randomUUID } from 'node:crypto';
import { clock } from '../../../common/clock';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { AI_LIMITS, BUDDY_LIMITS, type ActionResult, type ChatCard, type ChatDraft, type Clarify, type DayResponse, type MiloReply, type QuickActionName, type TurnBudget, type TurnRequest } from '../../../shared';
import { translatorFor } from '../../../shared/i18n';
import { avoidTermsFor } from '../../../domain/plan-narrative';
import { containsHealthKeys, stripHealth, weeklyReviewCard } from '../../../domain/buddy-cards';
import { KvStore } from '../../../infra/kv/kv-store';
import { CoachMemoryService } from '../../coach-preferences/coach-memory.service';
import { RecapService } from '../../recap/recap.service';
import { RemindersService } from '../../reminders/reminders.service';
import { WeightsService } from '../../tracking/services/weights.service';
import { BuddyService, cardFacts, type BuddyTurn } from './buddy.service';
import { dayKeyFor } from '../../../domain/day-keys';
import { isPlusActive } from '../../../domain/entitlements';
import { DailyQuota } from '../../../common/rate-limit/daily-quota';
import { AiProvider } from '../../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../../ai/ai-models';
import { AiService, AiUnavailableError } from '../../ai/ai.service';
import { AppConfigService } from '../../content/app-config.service';
import { requestLocale } from '../../../common/http/request-context';
import { coachLanguageDirective, languageDirective } from '../../ai/language';
import { localeInfo } from '../../../shared/locales';
import { buildCoachContext } from '../../../domain/coach-context';
import { coachStyleDirective } from '../../../domain/coach-style';
import { CoachPreferencesService } from '../../coach-preferences/coach-preferences.service';
import { COACH_TIMEOUT_MS, coachUserMessage, FALLBACK_INSTRUCTIONS, plainCoachReply, REPHRASE_MAX_TOKENS } from './coach-prompt';
import { fillSingle } from '../../content/content.loader';
import { inWindow, type NudgeContent } from '../../../domain/nudges';
import { localMinutes } from '../../../domain/nudges';
import type { OnboardingAnswerDoc } from '../../onboarding/schemas/onboarding.schema';
import { ContentService } from '../../content/content.service';
import type { ProfileDoc } from '../../onboarding/schemas/onboarding.schema';
import { DaysService } from '../../tracking/services/days.service';
import { UsersService } from '../../users/users.service';
import type { MessageDoc } from '../schemas/conversations.schema';
import type { ConversationDoc } from '../schemas/conversations.schema';

type Reply = Omit<MiloReply, 'conversationId' | 'messageId'>;

/** What the app sees before the words (SSE `state`): the draft and cards of this turn. */
export interface BuddyState {
  clientTurnId: string | null;
  draft: ChatDraft | null;
  cards: ChatCard[];
  executed: ActionResult[];
  draftConflict: boolean;
  clarify: Clarify | null;
}

export type CoachTurnResult = Reply & { cards: ChatCard[]; draft: ChatDraft | null; executed: ActionResult[]; clarify: Clarify | null; draftConflict: boolean };

/**
 * The selected day's budget with the activity adjustment the app already applied (never added again). The coach context's
 * kcalLeft then uses that goal. Habits-only people get no calorie numbers. Used in this turn's prompt only.
 */
export function applyBudget(context: Record<string, unknown>, day: DayResponse, budget: TurnBudget | null, habitsOnly: boolean): Record<string, unknown> | null {
  if (!budget) return null;
  if (habitsOnly || day.targets.energyKcal === null) return { activitySynced: true };
  const base = day.targets.energyKcal;
  const adj = budget.addActivity ? budget.activityAdjustmentKcal : 0;
  const goal = base + adj;
  if (adj > 0) {
    const today = context.today as Record<string, unknown> | undefined;
    if (today) today.kcalLeft = Math.round(goal - day.totals.kcal);
    const targets = context.dailyTargets as Record<string, unknown> | undefined;
    if (targets) targets.targetKcalWithActivity = goal;
  }
  return {
    baseGoalKcal: base,
    activityAdjustmentKcal: adj,
    goalKcal: goal,
    activeKcal: budget.activeKcal,
    addActivityToBudget: budget.addActivity,
    rule: 'goalKcal already includes activityAdjustmentKcal and kcalLeft already uses goalKcal. Never add active or burned calories again. activeKcal null means no data, not zero.',
  };
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const numbersOf = (text: string): number[] => (text.match(NUMBER) ?? []).map((n) => Number(n.replace(/,/g, ''))).filter(Number.isFinite);

/** The weekly review must only use numbers the card or template holds (and small list numbers): no invented figures. */
export function onlyAllowedNumbers(reply: string, template: string, cards: readonly ChatCard[]): boolean {
  const allowed = new Set([...numbersOf(template), ...numbersOf(JSON.stringify(cards)), 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  return numbersOf(reply).every((n) => allowed.has(n));
}
const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');

/**
 * Deterministic quick-action text from the user's own numbers (plan 8.6). Habits-only users never
 * see calorie numbers (plan 8.8 rule 3). Copy is a proposal pending product review.
 */
export type QuickAction = 'explain_macros' | 'review_day' | 'suggest_snack';

/** The chips of the opening reply, in order (`chipIndex` of a turn). */
export const CHIP_ACTIONS: readonly QuickAction[] = ['explain_macros', 'suggest_snack', 'review_day'];

/** How a quick action reads in the history the model sees (the stored text is a bracketed placeholder). */
const QUICK_ACTION_ASKED: Record<QuickActionName, string> = {
  explain_macros: 'Explain my macros',
  suggest_snack: 'Suggest a snack',
  review_day: 'Review my day',
  what_to_eat: 'What can I eat?',
  build_recipe: 'Build a recipe',
  weekly_review: 'Review my week',
};

/** How long step 2 of a coach turn is kept for a retry of the same clientTurnId (the finished reply is kept with the message). */
const BUDDY_STEP_TTL_SEC = 24 * 3600;

/** Older messages the model sees as chat turns; the rolling summary covers the rest. */
const HISTORY_MESSAGES = 20;
const HISTORY_MESSAGE_CHARS = 1500;
/** The quick action a turn asks for: the explicit one, else the chip that was tapped. */
export function quickActionOf(req: Pick<TurnRequest, 'quickAction' | 'chipIndex'>): QuickActionName | null {
  return req.quickAction ?? (req.chipIndex !== undefined ? (CHIP_ACTIONS[req.chipIndex] ?? null) : null);
}

interface Variant {
  id: string;
  when: string;
  text: string;
}
interface CoachContent {
  quickActions?: Partial<Record<QuickAction, { variants?: Variant[]; suffixes?: Variant[] }>>;
  fragments?: Record<string, { text: string }>;
  degraded?: { items?: { id: string; text: string }[] };
}

export interface QuickFacts {
  day: DayResponse;
  habitsOnly: boolean;
  vegan: boolean;
  noPhoto: boolean;
  /** Main meal of the current time window when not logged yet (Breakfast, Lunch, Dinner). */
  openSlot: string | null;
}

/**
 * Evaluates one `when` clause of coach.quickActions (content/milo/lines.v1.json, `selection` rules).
 * Unknown clauses are false, so a variant with a condition the server does not understand is skipped.
 */
export function clauseHolds(clause: string, f: QuickFacts): boolean {
  const c = clause.trim();
  const eaten = f.day.totals.kcal;
  const energy = f.day.targets.energyKcal;
  if (c === 'habitsOnly') return f.habitsOnly;
  if (c === 'full') return !f.habitsOnly;
  if (/^no meals today/.test(c)) return f.day.meals.length === 0;
  if (/^photo logging must not be promoted/.test(c)) return f.noPhoto;
  if (/^eatenKcal > energyKcal/.test(c)) return energy !== null && eaten > energy;
  const close = /^remainingKcal\s*≤\s*(\d+)/.exec(c);
  if (close) return energy !== null && energy - eaten <= Number(close[1]);
  if (/^q11 vegan/.test(c)) return f.vegan;
  if (/^a main meal for the current time window is not logged/.test(c)) return f.openSlot !== null && f.day.meals.length > 0;
  return false;
}

export const whenHolds = (when: string, f: QuickFacts): boolean => when.split(/\s+AND\s+/).every((c) => clauseHolds(c, f));

export function quickValues(f: QuickFacts, coach: CoachContent): Record<string, string> {
  const t = f.day.targets;
  const n = f.day.meals.length;
  const frag = (id: string, fallback: string) => coach.fragments?.[id]?.text ?? fallback;
  const left = t.energyKcal === null ? 0 : t.energyKcal - f.day.totals.kcal;
  return {
    energyKcal: fmt(t.energyKcal ?? 0),
    proteinG: String(t.proteinG ?? ''),
    carbsG: String(t.carbsG ?? ''),
    fatG: String(t.fatG ?? ''),
    eatenKcal: fmt(f.day.totals.kcal),
    eatenProteinG: fmt(f.day.totals.proteinG),
    eatenCarbsG: fmt(f.day.totals.carbsG),
    eatenFatG: fmt(f.day.totals.fatG),
    remainingKcal: fmt(Math.max(0, left)),
    waterMl: fmt(f.day.water.totalMl),
    n: String(n),
    mealsText: fillSingle(n === 1 ? frag('coach.qa.mealsOne', '1 meal') : frag('coach.qa.mealsMany', '{n} meals'), { n }),
    nextCategory: f.openSlot ?? '',
  };
}

/** Picks the first matching content variant (+ suffixes) and fills it; null when content is missing. */
export function quickActionFromContent(coach: CoachContent | undefined, action: QuickAction, f: QuickFacts): { id: string; text: string } | null {
  const spec = coach?.quickActions?.[action];
  const variant = spec?.variants?.find((v) => whenHolds(v.when, f));
  if (!variant) return null;
  const values = quickValues(f, coach!);
  const suffix = (spec?.suffixes ?? []).filter((s) => whenHolds(s.when, f)).map((s) => fillSingle(s.text, values));
  return { id: variant.id, text: [fillSingle(variant.text, values), ...suffix].join(' ') };
}

/**
 * Explain my macros and Review my day are answered from the template; the model only rephrases it
 * and must keep every number (content coach.quickActions.rephrase). Otherwise the template wins.
 */
export function keepNumbers(template: string, rephrased: string): string {
  const nums = template.match(/\d[\d,.]*/g) ?? [];
  const ok = rephrased.trim().length > 0 && nums.every((n) => rephrased.includes(n));
  return ok ? rephrased : template;
}

/** Last-resort wording when content cannot be loaded. */
export function quickActionTemplate(action: QuickAction, day: DayResponse, habitsOnly: boolean): string {
  const t = day.targets;
  if (action === 'explain_macros') {
    if (habitsOnly || t.energyKcal === null) {
      return 'Rather than numbers, aim for balanced plates: some protein, plenty of vegetables or fruit, and a source of energy like grains or potatoes.';
    }
    return `Your daily targets are ${fmt(t.energyKcal)} kcal with ${t.proteinG} g protein, ${t.carbsG} g carbs and ${t.fatG} g fat. Protein helps you feel full, carbs fuel your day and fat supports your body. So far today you've had ${fmt(day.totals.kcal)} kcal.`;
  }
  if (action === 'review_day') {
    const n = day.meals.length;
    if (n === 0) return 'Nothing logged yet today. A quick photo of your next meal is an easy start.';
    const meals = `${n} ${n === 1 ? 'meal' : 'meals'}`;
    if (habitsOnly || t.energyKcal === null) return `Today you've logged ${meals} and ${fmt(day.water.totalMl)} ml of water. Nice work keeping track.`;
    const left = t.energyKcal - day.totals.kcal;
    const remaining = left >= 0 ? `${fmt(left)} kcal left of your ${fmt(t.energyKcal)} kcal` : `a little over your ${fmt(t.energyKcal)} kcal target, which is fine`;
    return `Today you've logged ${meals} and ${fmt(day.totals.kcal)} kcal, with ${remaining}. Water so far: ${fmt(day.water.totalMl)} ml.`;
  }
  return 'A yoghurt with some fruit, a handful of nuts, or hummus with vegetable sticks all make an easy snack.';
}

/** Coach chat (M5-T4): context builder, templated quick actions, streaming, degraded templates. */
@Injectable()
export class CoachService {
  constructor(
    @InjectModel('Message') private readonly messages: Model<MessageDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('OnboardingAnswer') private readonly answers: Model<OnboardingAnswerDoc>,
    private readonly days: DaysService,
    private readonly users: UsersService,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
    private readonly appConfig: AppConfigService,
    private readonly quota: DailyQuota,
    private readonly coachPrefs: CoachPreferencesService,
    private readonly memory: CoachMemoryService,
    private readonly buddy: BuddyService,
    private readonly reminders: RemindersService,
    private readonly recap: RecapService,
    private readonly weights: WeightsService,
    private readonly kv: KvStore,
  ) {}

  private async lines(): Promise<{ lines?: Record<string, { text?: string }>; coach?: CoachContent; nudges?: NudgeContent } | undefined> {
    return (await this.content.miloLines())?.data as never;
  }

  /** Opening line: content coach.intro / coach.introNoName; chips from the quick-action label lines. */
  async opening(name: string | null): Promise<Reply> {
    const data = await this.lines();
    const intro = data?.lines?.[name ? 'coach.intro' : 'coach.introNoName']?.text;
    const label = (id: string, fallback: string) => data?.lines?.[id]?.text ?? fallback;
    return this.baseReply(intro ? fillSingle(intro, { name: name ?? '' }) : name ? `Hi ${name}, how can I help today?` : 'Hi, how can I help today?', [
      label('coach.quick.macros', 'Explain my macros'),
      label('coach.quick.snack', 'Suggest a snack'),
      label('coach.quick.review', 'Review my day'),
    ]);
  }

  private baseReply(reply: string, chips: string[]): Reply {
    return {
      reply,
      miloState: 'speaking',
      turnId: null,
      questionIds: [],
      chips: chips.map((label, index) => ({ index, label })),
      extracted: [],
      needsConfirmation: false,
      done: false,
      quickAction: null,
      replyAudio: null,
      caption: null,
    };
  }

  async turn(conv: ConversationDoc, req: TurnRequest, onDelta?: (text: string) => void, onState?: (state: BuddyState) => void): Promise<CoachTurnResult> {
    const userId = conv.userId.toString();
    const user = await this.users.requireActive(userId);
    const plus = isPlusActive(user.entitlement, clock.now());
    const quickAction = quickActionOf(req);
    const locale = requestLocale();
    const t = translatorFor(locale);
    // Build a recipe: Milo asks for the ingredients. No model call, no quota (a fixed line in the app language).
    if (quickAction === 'build_recipe') return { ...(await this.opening(null)), reply: t('buddy.buildRecipe'), quickAction, cards: [], draft: null, executed: [], clarify: null, draftConflict: false };

    const limits = await this.appConfig.get('limits', AI_LIMITS);
    const limit = plus ? limits.plus.coachPerDay : limits.free.coachPerDay;
    await this.quota.assertAvailable('coach', userId, user.timezone, limit, plus, 'You have reached today’s coach messages.');

    const now = clock.now();
    // The device's zone when it sent one (travel), else the profile's: "today", the local time and default meal slots follow it.
    const tz = req.timezone ?? user.timezone;
    const today = dayKeyFor(now, tz);
    const date = req.date ?? today;
    const day = await this.days.day(userId, date, now);
    const week = await this.days.progress(userId, 'week', today, now).catch(() => null);
    const profile = await this.profiles.findOne({ userId: user._id }).lean<ProfileDoc>();
    const habitsOnly = (profile?.mode ?? 'habits_only') === 'habits_only';
    const data = await this.lines();
    const opening = await this.opening(null);
    const facts = await this.facts(user._id, day, profile, habitsOnly || day.targets.energyKcal === null, now, tz, data?.nudges);
    const legacyAction = quickAction === 'explain_macros' || quickAction === 'review_day' || quickAction === 'suggest_snack' ? quickAction : null;
    const picked = legacyAction ? quickActionFromContent(data?.coach, legacyAction, facts) : null;
    const deterministic = quickAction === 'explain_macros' || quickAction === 'review_day';
    const text = req.text ?? (quickAction === 'what_to_eat' ? t('buddy.whatToEat') : quickAction ? quickAction.replace('_', ' ') : '');
    const memory = await this.memory.forTurn(user._id, text, true);
    const history = await this.history(conv, memory.contextResetAt);
    const budget = req.budget && date === today ? req.budget : null;
    if (req.text && !quickAction) {
      const refusal = await this.moderate(req.text, data);
      if (refusal) return { ...opening, reply: refusal, miloState: 'idle', moderation: 'flagged', cards: [], draft: null, executed: [], clarify: null, draftConflict: false };
    }

    // ── Step 2: read the message, change the draft, build cards (free text and "What can I eat?") ──
    let buddy: BuddyTurn | null = null;
    let cards: ChatCard[] = [];
    let template = legacyAction ? (picked?.text ?? quickActionTemplate(legacyAction, day, facts.habitsOnly)) : '';
    const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const avoid = avoidTermsFor(profile?.allergies ?? null, profile?.allergyOther ?? null, profile?.dietPattern ?? null, locale);
    if (!quickAction || quickAction === 'what_to_eat') {
      // A retry (same clientTurnId) of a turn that already did step 2 and then failed while answering reuses what step 2 did:
      // the message is not read again, so ops are not applied twice and a log does not run again under a new action id.
      const stepKey = req.clientTurnId ? `buddy-turn:${conv._id.toString()}:${req.clientTurnId}` : null;
      const saved = stepKey ? await this.kv.get(stepKey) : null;
      buddy = saved ? (JSON.parse(saved) as BuddyTurn) : await this.buddy.turn({
        conv,
        uid: user._id,
        plus,
        text,
        locale,
        previousReply: history.findLast((m) => m.role === 'assistant')?.content ?? null,
        today,
        date,
        localTime,
        localHour: Math.floor(localMinutes(now, tz) / 60),
        timezone: tz,
        category: req.category ?? null,
        day,
        habitsOnly: facts.habitsOnly,
        profile: { dietPattern: profile?.dietPattern ?? null, allergies: profile?.allergies ?? null, units: user.units },
        avoidTerms: avoid,
        recent: history.slice(-BUDDY_LIMITS.interpretHistory),
        memory,
        inputMethod: req.inputMethod,
        budget,
        turnKey: req.clientTurnId ?? randomUUID(),
      });
      if (stepKey && !saved) {
        const keep: BuddyTurn = { ...buddy, cards: stripHealth(buddy.cards) };
        if (!containsHealthKeys(keep)) await this.kv.set(stepKey, JSON.stringify(keep), BUDDY_STEP_TTL_SEC);
      }
      cards = buddy.cards;
    } else if (quickAction === 'review_day') {
      cards = [this.buddy.dayCard(day, today, facts.habitsOnly, budget)];
      await this.reminders.markReviewed(user._id, 'day', date).catch(() => undefined);
    } else if (quickAction === 'weekly_review') {
      const range = req.reviewRange ?? 'last';
      const w = await this.recap.weekForChat(userId, range, now);
      const weights = w.mode === 'habits_only' ? [] : (await this.weights.list(userId, { from: w.week.weekStart, to: w.week.weekEnd, limit: 50 })).map((x) => ({ date: x.date, weightKg: x.weightKg })).sort((a, b) => a.date.localeCompare(b.date));
      cards = [weeklyReviewCard({ range, weekStart: w.week.weekStart, weekEnd: w.week.weekEnd, habitsOnly: w.mode === 'habits_only', stats: w.stats, days: w.days, weights })];
      const st = w.stats;
      template =
        st.loggedDays === 0
          ? t('buddy.weekly.empty')
          : w.mode === 'full' && st.averageKcal !== null
            ? t('buddy.weekly.full', { from: w.week.weekStart, to: w.week.weekEnd, loggedDays: st.loggedDays, days: st.daysInRange, meals: st.meals, avg: st.averageKcal })
            : t('buddy.weekly.habits', { from: w.week.weekStart, to: w.week.weekEnd, loggedDays: st.loggedDays, days: st.daysInRange, meals: st.meals });
      await this.reminders.markReviewed(user._id, 'week', w.week.weekStart).catch(() => undefined);
    }
    const state: BuddyState = {
      clientTurnId: req.clientTurnId ?? null,
      draft: buddy?.draft ?? null,
      cards,
      executed: buddy?.executed ?? [],
      draftConflict: buddy?.draftConflict ?? false,
      clarify: buddy?.clarify ?? null,
    };
    if (buddy || cards.length) onState?.(state);
    const extra = { cards, draft: state.draft, executed: state.executed, clarify: state.clarify, draftConflict: state.draftConflict };

    // A clarification is the whole reply (no second model call); a conflict line comes from the server.
    if (buddy?.clarify && !buddy.draftConflict) {
      await this.quota.consume('coach', userId, user.timezone);
      onDelta?.(buddy.clarify.question);
      return { ...opening, reply: buddy.clarify.question, quickAction, ...extra };
    }

    // ── Step 4: the reply, explaining computed results ──
    const prompt = (await this.content.activePrompt('coach-buddy')) ?? (await this.content.activePrompt('coach'));
    const model = prompt?.model || (await this.ai.modelFor('chat', DEFAULT_TEXT_MODEL));
    // A meal this turn put in the diary ("add it to lunch") counts in what the reply says is eaten and left.
    const logged = buddy?.executed.some((r) => r.meal) ?? false;
    const replyDay = logged ? await this.days.day(userId, date, now) : day;
    const replyWeek = logged ? await this.days.progress(userId, 'week', today, now).catch(() => week) : week;
    const context = buildCoachContext({ name: user.displayName ?? profile?.displayName ?? null, mode: profile?.mode ?? 'habits_only', units: user.units, profile, day: replyDay, week: replyWeek });
    const budgetFacts = applyBudget(context, replyDay, budget, facts.habitsOnly);
    const style = plus ? await this.coachPrefs.styleFor(userId) : null;
    const directive =
      (quickAction ? languageDirective(locale) : coachLanguageDirective(locale, history.findLast((m) => m.role === 'assistant')?.content, req.text)) + coachStyleDirective(style);
    const replyQuick = quickAction === 'what_to_eat' ? null : quickAction;
    let streamed = false;
    try {
      // A reply that opens with `{` or a code fence is the model wrapping its answer (JSON, field names): nothing of it is
      // streamed, and the cleaned text goes out once at the end. Plain text streams as it arrives.
      let held = false;
      const res = await this.ai.runOrUnavailable('chat', async () => {
        let head = '';
        let gate: 'wait' | 'pass' | 'hold' = 'wait';
        held = false;
        const forward = (d: string) => {
          streamed = true;
          onDelta?.(d);
        };
        try {
          return await this.provider.streamChat(
            {
              model,
              instructions: prompt?.staticPrefix ?? FALLBACK_INSTRUCTIONS,
              messages: [
                ...history,
                {
                  role: 'user' as const,
                  content: coachUserMessage(prompt?.dynamicTemplate, directive, {
                    todayDate: today,
                    selectedDate: date,
                    localTime,
                    plan: plus ? 'plus' : 'free',
                    appLanguage: quickAction ? localeInfo(locale).aiName : 'not used for this message',
                    quickAction: replyQuick ?? 'null',
                    templateText: template,
                    userSummaryJson: JSON.stringify(context),
                    budgetJson: JSON.stringify(budgetFacts),
                    buddyJson: JSON.stringify(buddy?.facts ?? (cards.length ? { cards: cards.map(cardFacts) } : null)),
                    memoryJson: JSON.stringify(memory.memories.map((m) => ({ text: m.text, category: m.category }))),
                    replyLength: memory.replyLength,
                    conversationSummary: conv.summary || 'None',
                    recentMessages: '',
                    text,
                  }),
                },
              ],
              timeoutMs: COACH_TIMEOUT_MS,
              maxOutputTokens: deterministic ? REPHRASE_MAX_TOKENS : (plus ? limits.plus : limits.free).maxReplyTokens,
            },
            (d) => {
              if (gate === 'pass') {
                forward(d);
                return;
              }
              if (gate === 'hold') return;
              head += d;
              const first = head.trimStart()[0];
              if (first === undefined) return;
              gate = first === '{' || first === '`' ? 'hold' : 'pass';
              held = gate === 'hold';
              if (gate === 'pass') forward(head);
            },
          );
        } catch (e) {
          // Words already went to the phone: a retry would stream the answer a second time, so the failure stands.
          if (streamed) throw Object.assign(new Error('Coach stream interrupted'), { status: 499 });
          throw e;
        }
      });
      await this.quota.consume('coach', userId, user.timezone); // successful answers only (OQ-38)
      const output = plainCoachReply(String(res.output));
      let reply = deterministic ? keepNumbers(template, output) : output;
      if (quickAction === 'weekly_review') reply = onlyAllowedNumbers(reply, template, cards) ? reply : template;
      if (buddy?.draftConflict) reply = `${t('buddy.draftConflict')} ${reply}`.trim();
      if (held || (quickAction === 'weekly_review' && reply === template && !streamed)) onDelta?.(reply);
      return { ...opening, reply, quickAction, ...extra };
    } catch (e) {
      // Degraded mode (plan 8.10): quick actions answer from their template with the degraded caption; a turn that already
      // changed the draft keeps its cards with a resting line; other free chat reports AI_UNAVAILABLE.
      if (e instanceof AiUnavailableError && (quickAction || buddy?.cards.length)) {
        const line = quickAction && template ? template : t('buddy.unavailable');
        onDelta?.(line);
        const captionId = facts.habitsOnly ? 'coach.qa.degraded.captionHabits' : 'coach.qa.degraded.caption';
        const caption = data?.coach?.degraded?.items?.find((i) => i.id === captionId)?.text ?? 'Milo is resting, so this is a quick answer for now.';
        return { ...opening, reply: line, quickAction, caption, ...extra };
      }
      throw e;
    }
  }

  /**
   * The conversation so far as chat turns, oldest first. `ConversationsService` has already stored the turn being answered; it
   * goes last in the prompt with the context, so it is left out here (the model must not see it twice).
   */
  private async history(conv: ConversationDoc, resetAt: Date | null = null): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    // After a memory was deleted or edited, older messages are no longer sent to the model (they stay visible to the person).
    const filter = resetAt ? { userId: conv.userId, conversationId: conv._id, createdAt: { $gt: resetAt } } : { userId: conv.userId, conversationId: conv._id };
    const rows = (await this.messages.find(filter).sort({ createdAt: -1 }).limit(HISTORY_MESSAGES + 1).lean<MessageDoc[]>()).reverse();
    if (rows.at(-1)?.role === 'user') rows.pop();
    // A message that never got an answer (refused by the daily limit, cut off offline, then something else was asked) is
    // left out: the model answered it with the next one, in the wrong language (device test 16 Nov).
    return rows.filter((m, i) => m.role !== 'user' || rows[i + 1]?.role === 'assistant').map((m) => ({
      role: m.role,
      // A chip tap is stored as a bracketed placeholder (`[review_day]`); the model reads what it stood for.
      content: (m.role === 'user' && m.quickAction && m.text.startsWith('[') ? (QUICK_ACTION_ASKED[m.quickAction as QuickActionName] ?? m.text) : m.text).slice(0, HISTORY_MESSAGE_CHARS),
    }));
  }

  /**
   * Plan 8.8 rules 5–6: user text passes moderation first. Flagged input gets a refusal (or, for
   * self-harm, the caring support line) from content, with no chat model call.
   */
  private async moderate(text: string, data: Awaited<ReturnType<CoachService['lines']>>): Promise<string | null> {
    await this.ai.assertAvailable('chat');
    let result;
    try {
      result = await this.provider.moderate(text, await this.ai.modelFor('moderation', DEFAULT_TEXT_MODEL));
    } catch {
      throw new AiUnavailableError('circuit_open', 30);
    }
    if (!result.flagged) return null;
    const line = (id: string, fallback: string) => data?.lines?.[id]?.text ?? fallback;
    return result.categories.some((c) => c.startsWith('self-harm') || c.startsWith('self_harm'))
      ? line('safety.support', "I'm really glad you told me. You don't have to go through this alone; please reach out to someone you trust or a local support line.")
      : line('safety.refusal', "I can't help with that one. Shall we look at your meals or your day instead?");
  }

  private async facts(userId: Types.ObjectId, day: DayResponse, profile: ProfileDoc | null, habitsOnly: boolean, now: Date, tz: string, nudges?: NudgeContent): Promise<QuickFacts> {
    const q31 = await this.answers.findOne({ userId, questionId: 'q31' }).lean<OnboardingAnswerDoc>();
    const methods = profile?.loggingMethods ?? [];
    const noPhoto =
      (Array.isArray(q31?.value) && (q31.value as string[]).includes('privacy')) || (methods.length > 0 && !methods.includes('photo') && !methods.includes('switch'));
    const minutes = localMinutes(now, tz);
    const w = nudges?.timeWindows ?? {};
    const slot = (name: string) => (w[name] ? inWindow(minutes, w[name]) : false);
    const current = slot('morning') ? 'breakfast' : slot('midday') || slot('afternoon') ? 'lunch' : slot('evening') ? 'dinner' : null;
    const openSlot = current && !day.meals.some((m) => m.category === current) ? current[0]!.toUpperCase() + current.slice(1) : null;
    return { day, habitsOnly, vegan: profile?.dietPattern === 'vegan', noPhoto, openSlot };
  }
}
