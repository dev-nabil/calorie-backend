import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { BUDDY_LIMITS, ERROR_CODES, type CoachMemory, type MemoryCategory, type MemoryItem, type PatchMemorySettingsRequest, type ReplyLength } from '../../shared';
import { cleanMemoryText, isSensitive, memoryKey, relevantMemories } from '../../domain/coach-memory';
import { isPlusActive } from '../../domain/entitlements';
import { clock } from '../../common/clock';
import { ApiError } from '../../common/errors/api-error';
import type { ConversationDoc } from '../conversations/schemas/conversations.schema';
import type { ProfileDoc } from '../onboarding/schemas/onboarding.schema';
import type { PlanDoc } from '../plans/schemas/plans.schema';
import { UsersService } from '../users/users.service';
import type { CoachMemoryEntry, CoachPreferenceDoc } from './schemas/coach-preferences.schema';

/** BR-14: coach messages are kept 12 months. */
export const CHAT_RETENTION_MONTHS = 12;

export interface TurnMemory {
  chatMemory: boolean;
  replyLength: ReplyLength;
  contextResetAt: Date | null;
  memories: CoachMemoryEntry[];
}

const view = (m: CoachMemoryEntry): MemoryItem => ({
  id: m.id,
  text: m.text,
  category: m.category,
  sensitive: m.sensitive,
  source: m.source,
  conversationId: m.conversationId,
  createdAt: new Date(m.createdAt).toISOString(),
  updatedAt: new Date(m.updatedAt).toISOString(),
});

/**
 * "What Milo knows about me" (Milo buddy): read-only profile facts, the Plus notes, and memories learned in chat. Saving a
 * new chat memory keeps the Plus rule of notes (OQ-48); viewing, editing, deleting and clearing are open to everyone. Deleting
 * or editing a memory resets derived context: conversation summaries are wiped and older messages stop going to the model.
 */
@Injectable()
export class CoachMemoryService {
  constructor(
    @InjectModel('CoachPreference') private readonly prefs: Model<CoachPreferenceDoc>,
    @InjectModel('Conversation') private readonly conversations: Model<ConversationDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('Plan') private readonly plans: Model<PlanDoc>,
    private readonly users: UsersService,
  ) {}

  private async doc(uid: Types.ObjectId): Promise<CoachPreferenceDoc | null> {
    return this.prefs.findOne({ userId: uid }).lean<CoachPreferenceDoc>();
  }

  private async upsert(uid: Types.ObjectId, update: Record<string, unknown>): Promise<CoachPreferenceDoc> {
    return (await this.prefs
      .findOneAndUpdate({ userId: uid }, { ...update, $setOnInsert: { userId: uid } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true })
      .lean<CoachPreferenceDoc>())!;
  }

  async view(userId: string): Promise<CoachMemory> {
    const user = await this.users.requireActive(userId);
    const [doc, profile, plan] = await Promise.all([
      this.doc(user._id),
      this.profiles.findOne({ userId: user._id }).lean<ProfileDoc>(),
      this.plans.findOne({ userId: user._id, active: true }).lean<PlanDoc>(),
    ]);
    const profileFacts: CoachMemory['profile'] = [];
    if (profile?.primaryGoal) profileFacts.push({ key: 'goal', value: profile.primaryGoal });
    if (profile?.dietPattern) profileFacts.push({ key: 'dietPattern', value: profile.dietPattern === 'other' ? (profile.dietPatternOther ?? 'other') : profile.dietPattern });
    if (profile?.allergies) profileFacts.push({ key: 'allergies', value: profile.allergyOther ? [...profile.allergies.filter((a) => a !== 'other'), profile.allergyOther] : profile.allergies });
    if (profile?.mealsPerDay) profileFacts.push({ key: 'mealsPerDay', value: profile.mealsPerDay });
    profileFacts.push({ key: 'units', value: user.units });
    if (plan && plan.energyKcal !== null && profile?.mode === 'full') profileFacts.push({ key: 'targets', value: { kcal: plan.energyKcal, proteinG: plan.proteinG ?? null } });
    profileFacts.push({ key: 'timezone', value: user.timezone });
    return {
      profile: profileFacts,
      notes: doc?.notes ?? [],
      memories: [...(doc?.memories ?? [])].reverse().map(view),
      settings: { chatMemory: doc?.chatMemory ?? true, replyLength: doc?.replyLength ?? 'normal' },
      canSave: isPlusActive(user.entitlement, clock.now()),
      retention: { chatMonths: CHAT_RETENTION_MONTHS },
    };
  }

  async patchSettings(userId: string, body: PatchMemorySettingsRequest): Promise<CoachMemory> {
    const user = await this.users.requireActive(userId);
    const set: Record<string, unknown> = {};
    if (body.chatMemory !== undefined) set.chatMemory = body.chatMemory;
    if (body.replyLength !== undefined) set.replyLength = body.replyLength;
    if (Object.keys(set).length) await this.upsert(user._id, { $set: set });
    return this.view(userId);
  }

  /** The person's own edit wins over what was learned; older context is no longer sent to the model. */
  async edit(userId: string, id: string, text: string): Promise<MemoryItem> {
    const user = await this.users.requireActive(userId);
    const clean = cleanMemoryText(text);
    if (!clean) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Memory text is empty or too long', 400, { field: 'text' });
    const doc = await this.doc(user._id);
    const hit = doc?.memories?.find((m) => m.id === id);
    if (!hit) throw ApiError.notFound(ERROR_CODES.MEMORY_NOT_FOUND, 'Memory not found');
    const now = clock.now();
    const next = { ...hit, text: clean, source: 'you' as const, updatedAt: now };
    await this.prefs.updateOne({ userId: user._id, 'memories.id': id }, { $set: { 'memories.$': next, contextResetAt: now } });
    await this.wipeSummaries(user._id);
    return view(next);
  }

  async remove(userId: string, id: string): Promise<void> {
    const user = await this.users.requireActive(userId);
    const res = await this.prefs.updateOne({ userId: user._id, 'memories.id': id }, { $pull: { memories: { id } }, $set: { contextResetAt: clock.now() } });
    if (!res.modifiedCount) throw ApiError.notFound(ERROR_CODES.MEMORY_NOT_FOUND, 'Memory not found');
    await this.wipeSummaries(user._id);
  }

  /** Clears every chat-learned memory. Notes, profile, diary and chat history are untouched. */
  async clear(userId: string): Promise<void> {
    const user = await this.users.requireActive(userId);
    await this.upsert(user._id, { $set: { memories: [], contextResetAt: clock.now() } });
    await this.wipeSummaries(user._id);
  }

  /** Summaries are derived from messages that may hold a deleted fact: they go, and are rebuilt only from newer messages. */
  private async wipeSummaries(uid: Types.ObjectId): Promise<void> {
    await this.conversations.updateMany({ userId: uid, type: 'coach' }, { $set: { summary: '' } });
  }

  /**
   * Saves one memory learned in chat (save_memory, or an explicit "remember that…"). Plus only (OQ-48); the same text twice
   * is one memory; sensitive ones must come through the consent card (`consented`).
   */
  async add(userId: string, m: { text: string; category: MemoryCategory; sensitive: boolean; conversationId: string | null }, consented: boolean): Promise<MemoryItem> {
    const user = await this.users.requireActive(userId);
    if (!isPlusActive(user.entitlement, clock.now())) throw new ApiError(ERROR_CODES.PLUS_REQUIRED, "Milo's memory is part of Nouri Plus", 402);
    const text = cleanMemoryText(m.text);
    if (!text) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Memory text is empty or too long', 422, { field: 'text' });
    const sensitive = isSensitive(text, m.category, m.sensitive);
    if (sensitive && !consented) throw new ApiError(ERROR_CODES.ACTION_BLOCKED, 'Sensitive memories need the consent card', 422, { blockedBy: 'clarification' });
    const doc = await this.doc(user._id);
    if (doc && doc.chatMemory === false) throw new ApiError(ERROR_CODES.ACTION_BLOCKED, 'Chat memory is switched off', 422, { blockedBy: 'clarification' });
    const existing = doc?.memories?.find((x) => memoryKey(x.text) === memoryKey(text));
    if (existing) return view(existing);
    if ((doc?.memories?.length ?? 0) >= BUDDY_LIMITS.memoriesMax) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Milo remembers at most 50 things; delete one first', 422, { reason: 'memory_limit' });
    const now = clock.now();
    const entry: CoachMemoryEntry = { id: `m_${randomUUID().replace(/-/g, '').slice(0, 20)}`, text, category: m.category, sensitive, source: 'chat', conversationId: m.conversationId, createdAt: now, updatedAt: now };
    await this.upsert(user._id, { $push: { memories: entry } });
    return view(entry);
  }

  /** What a turn may use: nothing from chat memory when it is switched off; the few memories relevant to the message. */
  async forTurn(uid: Types.ObjectId, message: string, food: boolean): Promise<TurnMemory> {
    const doc = await this.doc(uid);
    const chatMemory = doc?.chatMemory ?? true;
    return {
      chatMemory,
      replyLength: doc?.replyLength ?? 'normal',
      contextResetAt: doc?.contextResetAt ?? null,
      memories: chatMemory ? relevantMemories(doc?.memories ?? [], message, { food }) : [],
    };
  }

  /** Plus check without loading the user twice (the turn already has it). */
  static canSave(user: { entitlement: Parameters<typeof isPlusActive>[0] }): boolean {
    return isPlusActive(user.entitlement, clock.now());
  }
}
