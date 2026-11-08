import { clock } from '../../../common/clock';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { AI_LIMITS, type DayResponse, type MiloReply, type TurnRequest } from '../../../shared';
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
import { COACH_TIMEOUT_MS, coachUserMessage, FALLBACK_INSTRUCTIONS, REPHRASE_MAX_TOKENS } from './coach-prompt';
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
const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');

/**
 * Deterministic quick-action text from the user's own numbers (plan 8.6). Habits-only users never
 * see calorie numbers (plan 8.8 rule 3). Copy is a proposal pending product review.
 */
export type QuickAction = 'explain_macros' | 'review_day' | 'suggest_snack';

/** The chips of the opening reply, in order (`chipIndex` of a turn). */
export const CHIP_ACTIONS: readonly QuickAction[] = ['explain_macros', 'suggest_snack', 'review_day'];

/** How a quick action reads in the history the model sees (the stored text is a bracketed placeholder). */
const QUICK_ACTION_ASKED: Record<QuickAction, string> = {
  explain_macros: 'Explain my macros',
  suggest_snack: 'Suggest a snack',
  review_day: 'Review my day',
};

/** Older messages the model sees as chat turns; the rolling summary covers the rest. */
const HISTORY_MESSAGES = 20;
const HISTORY_MESSAGE_CHARS = 1500;
/** The quick action a turn asks for: the explicit one, else the chip that was tapped. */
export function quickActionOf(req: Pick<TurnRequest, 'quickAction' | 'chipIndex'>): QuickAction | null {
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

  async turn(conv: ConversationDoc, req: TurnRequest, onDelta?: (text: string) => void): Promise<Reply> {
    const userId = conv.userId.toString();
    const user = await this.users.requireActive(userId);
    const plus = isPlusActive(user.entitlement, clock.now());
    const limits = await this.appConfig.get('limits', AI_LIMITS);
    const limit = plus ? limits.plus.coachPerDay : limits.free.coachPerDay;
    await this.quota.assertAvailable('coach', userId, user.timezone, limit, plus, 'You have reached today’s coach messages.');

    const quickAction = quickActionOf(req);
    const now = clock.now();
    const today = dayKeyFor(now, user.timezone);
    const day = await this.days.day(userId, today, now);
    const week = await this.days.progress(userId, 'week', today, now).catch(() => null);
    const profile = await this.profiles.findOne({ userId: user._id }).lean<ProfileDoc>();
    const habitsOnly = (profile?.mode ?? 'habits_only') === 'habits_only';
    const data = await this.lines();
    const opening = await this.opening(null);
    const facts = await this.facts(user._id, day, profile, habitsOnly || day.targets.energyKcal === null, now, user.timezone, data?.nudges);
    const picked = quickAction ? quickActionFromContent(data?.coach, quickAction, facts) : null;
    const template = quickAction ? (picked?.text ?? quickActionTemplate(quickAction, day, facts.habitsOnly)) : '';
    const deterministic = quickAction === 'explain_macros' || quickAction === 'review_day';

    const prompt = await this.content.activePrompt('coach');
    const history = await this.history(conv);
    const model = prompt?.model || (await this.ai.modelFor('chat', DEFAULT_TEXT_MODEL));
    const text = req.text ?? (quickAction ? quickAction.replace('_', ' ') : '');
    if (req.text && !quickAction) {
      const refusal = await this.moderate(req.text, data);
      if (refusal) return { ...opening, reply: refusal, miloState: 'idle', moderation: 'flagged' } as Reply;
    }
    const locale = requestLocale();
    const context = buildCoachContext({ name: user.displayName ?? profile?.displayName ?? null, mode: profile?.mode ?? 'habits_only', units: user.units, profile, day, week });
    // Chips and quick actions come in the app language (their template is written in it); free text is answered in the
    // language the person wrote in. Plus adds the tone and notes the person chose, after the language rule; free users'
    // stored preferences are ignored.
    const style = plus ? await this.coachPrefs.styleFor(userId) : null;
    const directive =
      (quickAction ? languageDirective(locale) : coachLanguageDirective(locale, history.findLast((m) => m.role === 'assistant')?.content)) + coachStyleDirective(style);
    let streamed = false;
    try {
      const res = await this.ai.runOrUnavailable('chat', async () => {
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
                    localTime: new Intl.DateTimeFormat('en-GB', { timeZone: user.timezone, hour: '2-digit', minute: '2-digit' }).format(now),
                    plan: plus ? 'plus' : 'free',
                    appLanguage: quickAction ? localeInfo(locale).aiName : 'not used for this message',
                    quickAction: quickAction ?? 'null',
                    templateText: template,
                    userSummaryJson: JSON.stringify(context),
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
              streamed = true;
              onDelta?.(d);
            },
          );
        } catch (e) {
          // Words already went to the phone: a retry would stream the answer a second time, so the failure stands.
          if (streamed) throw Object.assign(new Error('Coach stream interrupted'), { status: 499 });
          throw e;
        }
      });
      await this.quota.consume('coach', userId, user.timezone); // successful answers only (OQ-38)
      return { ...opening, reply: deterministic ? keepNumbers(template, String(res.output)) : String(res.output), quickAction };
    } catch (e) {
      // Degraded mode (plan 8.10): quick actions answer from their template with the degraded caption;
      // free chat reports AI_UNAVAILABLE (the app shows coach.qa.degraded.chat).
      if (e instanceof AiUnavailableError && quickAction) {
        onDelta?.(template);
        const captionId = facts.habitsOnly ? 'coach.qa.degraded.captionHabits' : 'coach.qa.degraded.caption';
        const caption = data?.coach?.degraded?.items?.find((i) => i.id === captionId)?.text ?? 'Milo is resting, so this is a quick answer for now.';
        return { ...opening, reply: template, quickAction, caption };
      }
      throw e;
    }
  }

  /**
   * The conversation so far as chat turns, oldest first. `ConversationsService` has already stored the turn being answered; it
   * goes last in the prompt with the context, so it is left out here (the model must not see it twice).
   */
  private async history(conv: ConversationDoc): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const rows = (await this.messages.find({ conversationId: conv._id }).sort({ createdAt: -1 }).limit(HISTORY_MESSAGES + 1).lean<MessageDoc[]>()).reverse();
    if (rows.at(-1)?.role === 'user') rows.pop();
    return rows.map((m) => ({
      role: m.role,
      // A chip tap is stored as a bracketed placeholder (`[review_day]`); the model reads what it stood for.
      content: (m.role === 'user' && m.quickAction && m.text.startsWith('[') ? (QUICK_ACTION_ASKED[m.quickAction as QuickAction] ?? m.text) : m.text).slice(0, HISTORY_MESSAGE_CHARS),
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
