import { requestLocale } from '../../../common/http/request-context';
import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ERROR_CODES, type AnswerInput, type AnswerValue, type MiloReply, type TurnRequest } from '../../../shared';
import {
  evaluateCondition,
  loadFlowTurns,
  nextFlowTurn,
  rulesPass,
  settleProvisional,
  toStoredValue,
  validateAnswer,
  volunteerableQuestions,
  type AnswerMap,
  type EngineContext,
  type FlowTurn,
  type QuestionSet,
} from '../../../domain/onboarding-engine';
import { ApiError } from '../../../common/errors/api-error';
import { AiJobRunner } from '../../ai/ai-jobs';
import { ContentService } from '../../content/content.service';
import { OnboardingService } from '../../onboarding/onboarding.service';
import type { ConversationDoc, MessageDoc, PendingAnswer } from '../schemas/conversations.schema';
import { EXTRACT_JOB, EXTRACT_TIMEOUT_MS } from '../extraction.handler';
import type { ExtractionOutput } from '../../../shared';

const LOW_CONFIDENCE = 0.7; // plan 8.5 rule 4

interface ConvContent {
  turns: FlowTurn[];
  raw: {
    confirm?: { template?: string; summaryItem?: string; summaryJoiner?: string; chips?: { label: string }[]; onChange?: string };
    final?: { text?: string; textNoName?: string; habitsOnly?: string; habitsOnlyNoName?: string };
    synonyms?: Record<string, unknown>;
    fallbackAcks?: string[];
    turns: { id: string; ackAfter?: string }[];
  };
}

type Reply = Omit<MiloReply, 'conversationId' | 'messageId'>;

export interface RealtimeStart {
  sessionKind: 'start' | 'resume';
  turnId: string;
  /** What the model does first: greet and ask, or welcome the user back and ask. */
  firstInstruction: string;
  knownName: string;
  openQuestionsJson: string;
  synonymsJson: string;
}

/**
 * Onboarding conversation turns (M5-T3): server-driven walk over the turn groups, model extraction
 * in the worker, confirmation for multi-answer or low-confidence turns. A reply may also answer later
 * questions; those are saved (or held until their rules show them), so Milo never asks them again.
 */
@Injectable()
export class OnboardingTurnsService {
  constructor(
    @InjectModel('Conversation') private readonly conversations: Model<ConversationDoc>,
    @InjectModel('Message') private readonly messages: Model<MessageDoc>,
    private readonly onboarding: OnboardingService,
    private readonly content: ContentService,
    private readonly runner: AiJobRunner,
  ) {}

  private async conv(): Promise<ConvContent> {
    const c = await this.content.conversation();
    const { set } = await this.content.questionSet();
    if (!c) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Conversation content is not published', HttpStatus.SERVICE_UNAVAILABLE);
    return { turns: loadFlowTurns(set, c.data), raw: c.data as ConvContent['raw'] };
  }

  /** Opening line: the intro turn with its chips. */
  async opening(): Promise<Reply> {
    const { turns } = await this.conv();
    const intro = turns.find((t) => t.questionIds.length === 0) ?? turns[0]!;
    return this.reply(intro.miloLine, intro, [], 'speaking');
  }

  private reply(line: string, turn: FlowTurn | null, questionIds: string[], miloState: MiloReply['miloState'], extra: Partial<Reply> = {}): Reply {
    return {
      reply: line,
      miloState,
      turnId: turn?.id ?? null,
      questionIds,
      chips: chipsFor(turn, questionIds),
      extracted: [],
      needsConfirmation: false,
      done: false,
      quickAction: null,
      replyAudio: null,
      caption: null,
      ...extra,
    };
  }

  async turn(conv: ConversationDoc, req: TurnRequest): Promise<Reply> {
    const { turns, raw } = await this.conv();
    const snap = await this.onboarding.snapshot(conv.userId.toString(), 'conversation');
    if (!conv.started) {
      await this.conversations.updateOne({ _id: conv._id }, { $set: { started: true } });
      const intro = raw.turns.find((t) => t.ackAfter);
      return this.advance(conv, turns, raw, snap, intro?.ackAfter ?? '');
    }
    const current = turns.find((t) => t.id === conv.turnId) ?? null;
    const step = nextFlowTurn(snap.set, turns, snap.answers, conv.held ?? {}, snap.ctx);
    const open = step && current && step.turn.id === current.id ? step.open : (step?.open ?? []);
    const turn = step?.turn ?? current;
    if (!turn) return this.done(conv, raw, snap);

    if (req.chipIndex !== undefined) {
      const chip = turn.chips[req.chipIndex];
      if (!chip) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Unknown chip');
      // Only what is still open: a chip never overwrites an answer the user already gave.
      const answers: PendingAnswer[] = Object.entries(chip.sets ?? {})
        .filter(([questionId]) => open.includes(questionId))
        .map(([questionId, value]) => ({ questionId, value, confidence: 1, held: false }));
      const saved = await this.apply(conv, snap.set, snap.ctx, answers, (chip.skips ?? []).filter((id) => open.includes(id)), 'chip');
      return { ...(await this.advance(conv, turns, raw, await this.onboarding.snapshot(conv.userId.toString(), 'conversation'), '')), ...saved };
    }

    const recent = await this.messages.find({ conversationId: conv._id }).sort({ createdAt: -1 }).skip(1).limit(2).lean<MessageDoc[]>(); // skip the reply being handled
    const out = await this.runner.run<ExtractionOutput>(
      EXTRACT_JOB,
      {
        values: {
          turnId: turn.id,
          turnNumber: String(turn.turn),
          miloLine: turn.miloLine,
          isAdult: String(evaluateCondition({ age: { gte: 18 } }, snap.answers, snap.ctx, snap.set)),
          knownName: typeof snap.answers.q05?.value === 'string' ? snap.answers.q05.value : '',
          inputMethod: req.inputMethod,
          locale: requestLocale(),
          openQuestionsJson: JSON.stringify(listeningViews(snap.set, open, volunteerableQuestions(snap.set, turns, snap.answers, conv.held ?? {}, snap.ctx, open))),
          synonymsJson: JSON.stringify(Object.fromEntries(open.filter((id) => raw.synonyms?.[id]).map((id) => [id, raw.synonyms![id]]))),
          recentMessages: recent.reverse().map((m) => `${m.role === 'assistant' ? 'Milo' : 'User'}: ${m.text}`).join('\n'),
          text: req.text ?? '',
        },
      },
      EXTRACT_TIMEOUT_MS + 5000,
    );
    return (await this.finishExtraction(conv, turns, raw, snap, turn, open, out, req.inputMethod, true)).reply;
  }

  /**
   * Everything after the model has read a reply: drop what is not open or not valid, ask for a yes or no
   * when needed, save, and move to the next question. Shared by typed/chip turns (the extraction job) and
   * by the Realtime voice tools (the voice model is the reader). `confirmMultiple`: a reply with more than
   * one answer needs a Yes/Change first; the voice conversation reads the answers back aloud instead, so it
   * only asks for a yes or no when an answer is uncertain (confidence below 0.7).
   */
  private async finishExtraction(
    conv: ConversationDoc,
    turns: FlowTurn[],
    raw: ConvContent['raw'],
    snap: Awaited<ReturnType<OnboardingService['snapshot']>>,
    turn: FlowTurn,
    open: string[],
    out: ExtractionOutput,
    inputMethod: 'typed' | 'voice' | 'chip',
    confirmMultiple: boolean,
  ): Promise<{ reply: Reply; outcome: 'clarify' | 'confirm' | 'saved' }> {
    const ack = out.ack;
    const listening = [...open, ...volunteerableQuestions(snap.set, turns, snap.answers, conv.held ?? {}, snap.ctx, open)];
    const { answers, declined } = this.postProcess(snap.set, snap.answers, snap.ctx, listening, out);
    if (out.userQuestion || (!answers.length && !declined.length)) {
      const line = out.clarify ?? (open[0] ? (turn.askOne[open[0]] ?? turn.miloLine) : turn.miloLine);
      return { reply: this.reply(join(ack, line), turn, open, 'speaking'), outcome: 'clarify' };
    }
    if ((confirmMultiple && answers.length > 1) || answers.some((a) => a.confidence < LOW_CONFIDENCE)) {
      await this.conversations.updateOne({ _id: conv._id }, { $set: { pending: { answers, declined, turnId: turn.id, inputMethod } } });
      const c = raw.confirm ?? {};
      const summary = answers
        .map((a) => (c.summaryItem ?? '{reviewLabel}: {valueLabel}').replace('{reviewLabel}', String(snap.set.byId[a.questionId]?.reviewLabel ?? a.questionId)).replace('{valueLabel}', valueLabel(snap.set, a.questionId, a.value)))
        .join(c.summaryJoiner ?? '; ');
      const line = (c.template ?? "Here's what I noted: {summary}. Is that right?").replace('{summary}', summary);
      return {
        reply: {
          ...this.reply(join(ack, line), turn, open, 'speaking'),
          chips: (c.chips ?? [{ label: 'Yes' }, { label: 'Change' }]).map((ch, index) => ({ index, label: ch.label })),
          extracted: answers,
          needsConfirmation: true,
        },
        outcome: 'confirm',
      };
    }
    const saved = await this.apply(conv, snap.set, snap.ctx, answers, declined, inputMethod);
    const next = await this.advance(conv, turns, raw, await this.onboarding.snapshot(conv.userId.toString(), 'conversation'), ack);
    return { reply: { ...next, ...saved }, outcome: 'saved' };
  }

  async confirm(conv: ConversationDoc, accept: boolean): Promise<Reply> {
    if (!conv.pending) throw ApiError.conflict(ERROR_CODES.NOTHING_TO_CONFIRM, 'There is nothing to confirm');
    const { turns, raw } = await this.conv();
    const snap = await this.onboarding.snapshot(conv.userId.toString(), 'conversation');
    const pending = conv.pending;
    await this.conversations.updateOne({ _id: conv._id }, { $set: { pending: null } });
    if (!accept) {
      const turn = turns.find((t) => t.id === pending.turnId) ?? null;
      return this.reply(raw.confirm?.onChange ?? 'No problem. What should I change?', turn, turn?.questionIds ?? [], 'listening');
    }
    // QA B15: confirmed answers keep the input method of the reply they came from.
    const saved = await this.apply(conv, snap.set, snap.ctx, pending.answers, pending.declined, pending.inputMethod ?? 'typed');
    return { ...(await this.advance(conv, turns, raw, await this.onboarding.snapshot(conv.userId.toString(), 'conversation'), '')), ...saved };
  }

  // ---- Realtime voice (Gemini Live over a WebSocket) ---------------------------------------------

  /**
   * What the Realtime model needs at the start of a session: whether this is a fresh start or a resume,
   * the question to open with and the open questions with their options. The walk itself stays here:
   * the model reads and speaks, the tools below validate and save (same engine as typed and chip turns).
   */
  async realtimeStart(conv: ConversationDoc): Promise<RealtimeStart> {
    const { turns, raw } = await this.conv();
    const snap = await this.onboarding.snapshot(conv.userId.toString(), 'conversation');
    const step = nextFlowTurn(snap.set, turns, snap.answers, conv.held ?? {}, snap.ctx);
    if (!step) throw ApiError.conflict(ERROR_CODES.CONFLICT, 'Every question is already answered');
    await this.conversations.updateOne({ _id: conv._id }, { $set: { turnId: step.turn.id } });
    const resume = Boolean(conv.started);
    const partial = step.open.length < step.turn.questionIds.length;
    const line = partial ? (step.turn.askOne[step.open[0]!] ?? step.turn.miloLine) : step.turn.miloLine;
    const intro = (await this.opening()).reply;
    const firstInstruction = resume
      ? `The conversation was already under way. Welcome the user back in a few words, then ask this question in your own words: "${line}"`
      : `Greet the user warmly in one short sentence that carries the idea of this opening: "${intro}" Then, in the same breath, ask this question in your own words: "${line}" Do not ask if they are ready.`;
    return {
      sessionKind: resume ? 'resume' : 'start',
      turnId: step.turn.id,
      firstInstruction,
      knownName: typeof snap.answers.q05?.value === 'string' ? snap.answers.q05.value : '',
      openQuestionsJson: JSON.stringify(listeningViews(snap.set, step.open, volunteerableQuestions(snap.set, turns, snap.answers, conv.held ?? {}, snap.ctx, step.open))),
      synonymsJson: JSON.stringify(Object.fromEntries(step.open.filter((id) => raw.synonyms?.[id]).map((id) => [id, raw.synonyms![id]]))),
    };
  }

  /** The `record_answers` tool: the voice model's reading of the user's reply, validated like an extraction. */
  async realtimeRecord(conv: ConversationDoc, answers: ExtractionOutput['answers']): Promise<{ reply: Reply; outcome: 'clarify' | 'confirm' | 'saved' }> {
    const { turns, raw } = await this.conv();
    if (!conv.started || conv.pending) {
      await this.conversations.updateOne({ _id: conv._id }, { $set: { started: true, pending: null } });
      conv.started = true;
      conv.pending = null;
    }
    const snap = await this.onboarding.snapshot(conv.userId.toString(), 'conversation');
    const current = turns.find((t) => t.id === conv.turnId) ?? null;
    const step = nextFlowTurn(snap.set, turns, snap.answers, conv.held ?? {}, snap.ctx);
    const turn = step?.turn ?? current;
    if (!turn) return { reply: await this.done(conv, raw, snap), outcome: 'saved' };
    return this.finishExtraction(conv, turns, raw, snap, turn, step?.open ?? [], { answers, ack: '', clarify: null, userQuestion: null }, 'voice', false);
  }

  /** The JSON the model gets back from a tool: what happened and what to say next. */
  async realtimeToolOutput(conv: ConversationDoc, reply: Reply, outcome: 'clarify' | 'confirm' | 'saved' | 'discarded'): Promise<Record<string, unknown>> {
    if (reply.done) {
      return { status: 'complete', say: reply.reply, guidance: 'Everything needed is saved. Say this warmly in one or two short sentences, in the reply language, and stop. Ask nothing else and call no more tools.' };
    }
    const { turns, raw } = await this.conv();
    const snap = await this.onboarding.snapshot(conv.userId.toString(), 'conversation');
    const noted = reply.extracted.map((a) => `${String(snap.set.byId[a.questionId]?.reviewLabel ?? a.questionId)}: ${valueLabel(snap.set, a.questionId, a.value)}`);
    if (reply.needsConfirmation) {
      return {
        status: 'needs_confirmation',
        noted,
        say: reply.reply,
        guidance: 'These answers are not saved yet. Read them back in one short sentence, in the reply language, and ask if that is right. If yes, call confirm_answers with accept true. If the user wants to change something, call it with accept false and ask what to change.',
      };
    }
    const next = {
      say: reply.reply,
      questions: listeningViews(snap.set, reply.questionIds, volunteerableQuestions(snap.set, turns, snap.answers, conv.held ?? {}, snap.ctx, reply.questionIds)),
      synonyms: Object.fromEntries(reply.questionIds.filter((id) => raw.synonyms?.[id]).map((id) => [id, raw.synonyms![id]])),
    };
    if (outcome === 'discarded') {
      return { status: 'discarded', next, guidance: 'Those answers were dropped. Say "no problem" in your own words and ask what to change, in one short sentence, then record the corrected answer.' };
    }
    if (outcome === 'clarify') {
      return { status: 'nothing_saved', next, guidance: 'Nothing valid was recorded. Do not mention an error. Ask once more, more simply, in one short sentence. If you already asked this twice, say they can type it instead, and wait.' };
    }
    return {
      status: 'saved',
      saved: noted,
      next,
      guidance: 'Acknowledge in at most three words, or not at all, without judging or repeating the answer. Then ask next.say in your own words and stop. Use next.questions for the option IDs when you record the answer.',
    };
  }

  /** Drops anything outside the open questions, converts and validates values (prompt post-processing rules). */
  postProcess(set: QuestionSet, answers: AnswerMap, ctx: EngineContext, open: string[], out: ExtractionOutput): { answers: PendingAnswer[]; declined: string[] } {
    const result: PendingAnswer[] = [];
    const declined: string[] = [];
    for (const a of out.answers) {
      const q = set.byId[a.questionId];
      if (!q || !open.includes(a.questionId)) continue;
      const value = toStoredValue(q, a.value);
      if (value === undefined) continue;
      if (value === null) {
        declined.push(a.questionId);
        continue;
      }
      const v = validateAnswer(set, a.questionId, value, undefined, ctx.today);
      if (!v.ok) continue;
      const held = !rulesPass(set, a.questionId, answers, ctx);
      result.push({ questionId: a.questionId, value: v.value as AnswerValue, confidence: Math.max(0, Math.min(1, a.confidence)), held });
    }
    return { answers: result, declined };
  }

  /** Saves a turn and returns what changed, so the app can mirror every saved answer (chips and committed held ones too). */
  private async apply(conv: ConversationDoc, set: QuestionSet, ctx: EngineContext, answers: PendingAnswer[], declined: string[], inputMethod: 'typed' | 'voice' | 'chip'): Promise<{ extracted: PendingAnswer[]; skipped: string[] }> {
    const method = inputMethod === 'chip' ? 'chip' : inputMethod;
    const held: Record<string, AnswerValue> = { ...(conv.held ?? {}) };
    const inputs: AnswerInput[] = [];
    for (const a of answers) {
      if (a.held) held[a.questionId] = a.value;
      else inputs.push({ questionId: a.questionId, value: a.value, status: 'answered', inputMethod: method });
    }
    for (const id of declined) {
      if (id in held) delete held[id];
      else if (set.byId[id]) inputs.push({ questionId: id, status: 'skipped', inputMethod: method });
    }
    const userId = conv.userId.toString();
    if (inputs.length) await this.onboarding.save(userId, inputs, 'conversation');
    const snap = await this.onboarding.snapshot(userId, 'conversation');
    const settled = settleProvisional(set, snap.answers, held, ctx);
    if (settled.commit.length) {
      await this.onboarding.save(userId, settled.commit.map((c) => ({ questionId: c.questionId, value: c.value, status: 'answered', inputMethod: method })), 'conversation');
    }
    await this.conversations.updateOne({ _id: conv._id }, { $set: { held: settled.keep } });
    conv.held = settled.keep;
    const extracted = new Map(answers.map((a) => [a.questionId, a]));
    for (const c of settled.commit) extracted.set(c.questionId, { questionId: c.questionId, value: c.value as AnswerValue, confidence: 1, held: false });
    for (const id of settled.drop) extracted.delete(id);
    return { extracted: [...extracted.values()], skipped: declined };
  }

  private async advance(conv: ConversationDoc, turns: FlowTurn[], raw: ConvContent['raw'], snap: Awaited<ReturnType<OnboardingService['snapshot']>>, ack: string): Promise<Reply> {
    const step = nextFlowTurn(snap.set, turns, snap.answers, conv.held ?? {}, snap.ctx);
    if (!step) return this.done(conv, raw, snap, ack);
    const sameTurn = conv.turnId === step.turn.id;
    await this.conversations.updateOne({ _id: conv._id }, { $set: { turnId: step.turn.id } });
    conv.turnId = step.turn.id;
    // Part of a turn is already answered (a volunteered answer): ask only what is left.
    const partial = sameTurn || step.open.length < step.turn.questionIds.length;
    const line = partial ? (step.turn.askOne[step.open[0]!] ?? step.turn.miloLine) : step.turn.miloLine;
    return this.reply(join(ack, line), step.turn, step.open, 'speaking');
  }

  private async done(conv: ConversationDoc, raw: ConvContent['raw'], snap: Awaited<ReturnType<OnboardingService['snapshot']>>, ack = ''): Promise<Reply> {
    await this.conversations.updateOne({ _id: conv._id }, { $set: { status: 'completed', turnId: null } });
    const name = typeof snap.answers.q05?.value === 'string' ? snap.answers.q05.value : '';
    const f = raw.final ?? {};
    const habits = snap.mode === 'habits_only';
    const template = habits ? (name ? f.habitsOnly : f.habitsOnlyNoName) : name ? f.text : f.textNoName;
    return this.reply(join(ack, (template ?? 'I have what I need.').replace('{name}', name)), null, [], 'celebrating', { done: true });
  }
}

function join(ack: string, line: string): string {
  return [ack.trim(), line.trim()].filter(Boolean).join(' ');
}

/** Chips for the questions still open, keeping their index in the turn; a chip that sets nothing (the intro) always shows. */
function chipsFor(turn: FlowTurn | null, open: string[]): { index: number; label: string }[] {
  const out: { index: number; label: string }[] = [];
  (turn?.chips ?? []).forEach((c, index) => {
    const targets = [...Object.keys(c.sets ?? {}), ...(c.skips ?? [])];
    if (!targets.length || targets.some((id) => open.includes(id))) out.push({ index, label: c.label });
  });
  return out;
}

/** Options that need a number (q35 custom) stay on the form: a spoken or typed reply cannot carry that detail. */
function openQuestionView(set: QuestionSet, id: string, askNow = true) {
  const q = set.byId[id]!;
  const options = q.options.filter((o) => !o.input).map((o) => ({ id: o.id, label: (o as { label?: string }).label }));
  return { id, askNow, type: q.type, max: q.max, exclusive: q.exclusive, options, limits: q.limits };
}

/** What the model listens for: the open questions (askNow) and the later ones the user may answer ahead of time. */
function listeningViews(set: QuestionSet, open: string[], later: string[]) {
  return [...open.map((id) => openQuestionView(set, id)), ...later.map((id) => openQuestionView(set, id, false))];
}

function valueLabel(set: QuestionSet, id: string, value: AnswerValue): string {
  const q = set.byId[id];
  const label = (oid: string) => (q?.options.find((o) => o.id === oid) as { label?: string } | undefined)?.label ?? oid;
  if (typeof value === 'string') return q?.options.length ? label(value) : value;
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('age' in v) return `${String(v.age)} years`;
    if (v.mode === 'none') return 'Prefer not to say';
    if ('cm' in v) return `${String(v.cm)} cm`;
    if ('kg' in v) return `${String(v.kg)} kg${v.isEstimate ? ' (estimate)' : ''}`;
  }
  return String(value);
}
