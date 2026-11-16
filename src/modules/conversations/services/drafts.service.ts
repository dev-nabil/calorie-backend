import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { BUDDY_LIMITS, ERROR_CODES, type ChatDraft, type DraftLifecycleRequest, type DraftState, type PatchDraftRequest } from '../../../shared';
import { applyEdits, type DraftContext } from '../../../domain/chat-draft';
import { clock } from '../../../common/clock';
import { ApiError } from '../../../common/errors/api-error';
import { FoodRecordsService } from '../../content/food-records.service';
import type { ChatDraftDoc } from '../schemas/conversations.schema';

const KEEP_MS = 30 * 86_400_000;

/**
 * Chat drafts (Milo buddy, contract §2): one active draft per conversation, up to three parked ones. Every content change
 * bumps the version and is written with compare-and-set, so an AI answer computed from an older version can never
 * overwrite a newer card edit (the caller gets `null` and reports a conflict).
 */
@Injectable()
export class DraftsService {
  constructor(
    @InjectModel('ChatDraft') private readonly drafts: Model<ChatDraftDoc>,
    private readonly records: FoodRecordsService,
  ) {}

  context(conversationId: string, now = clock.now()): DraftContext {
    return { records: this.records.index, newId: () => `d_${randomUUID().replace(/-/g, '')}`, conversationId, now };
  }

  async active(userId: Types.ObjectId, conversationId: Types.ObjectId): Promise<ChatDraft | null> {
    const doc = await this.drafts.findOne({ userId, conversationId, active: true }).sort({ updatedAt: -1 }).lean<ChatDraftDoc>();
    return doc ? (doc.data as ChatDraft) : null;
  }

  async get(userId: Types.ObjectId, draftId: string): Promise<ChatDraft | null> {
    const doc = await this.drafts.findOne({ _id: draftId, userId }).lean<ChatDraftDoc>();
    return doc ? (doc.data as ChatDraft) : null;
  }

  async state(userId: Types.ObjectId, conversationId: Types.ObjectId): Promise<DraftState> {
    const docs = await this.drafts.find({ userId, conversationId }).sort({ updatedAt: -1 }).limit(BUDDY_LIMITS.parkedDrafts + 1).lean<ChatDraftDoc[]>();
    const active = docs.find((d) => d.active);
    return {
      draft: active ? (active.data as ChatDraft) : null,
      parked: docs
        .filter((d) => !d.active)
        .slice(0, BUDDY_LIMITS.parkedDrafts)
        .map((d) => {
          const x = d.data as ChatDraft;
          return { id: x.id, kind: x.kind, name: x.name, status: x.status, updatedAt: x.updatedAt };
        }),
    };
  }

  /**
   * Writes a draft. `expected` is the version it was computed from (null for a new draft). Returns false when the stored
   * draft moved on in between (conflict: nothing written).
   */
  async save(userId: Types.ObjectId, conversationId: Types.ObjectId, draft: ChatDraft, expected: number | null): Promise<boolean> {
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + KEEP_MS);
    if (expected === null) {
      await this.drafts.updateMany({ userId, conversationId, active: true, _id: { $ne: draft.id } }, { $set: { active: false } });
      try {
        await this.drafts.create({ _id: draft.id, userId, conversationId, active: true, version: draft.version, data: draft, expiresAt });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) return false;
        throw e;
      }
      await this.trimParked(userId, conversationId);
      return true;
    }
    const res = await this.drafts.updateOne({ _id: draft.id, userId, version: expected }, { $set: { version: draft.version, data: draft, expiresAt, active: true } });
    return res.modifiedCount === 1;
  }

  /** Bookkeeping that does not change the draft's content (logs, saved recipe, status): no version bump, no conflict. */
  async note(userId: Types.ObjectId, draftId: string, patch: Partial<Pick<ChatDraft, 'logs' | 'savedRecipeId' | 'status'>>): Promise<ChatDraft | null> {
    const set: Record<string, unknown> = { 'data.updatedAt': clock.now().toISOString() };
    for (const [k, v] of Object.entries(patch)) set[`data.${k}`] = v;
    const doc = await this.drafts.findOneAndUpdate({ _id: draftId, userId }, { $set: set }, { returnDocument: 'after' }).lean<ChatDraftDoc>();
    return doc ? (doc.data as ChatDraft) : null;
  }

  async park(userId: Types.ObjectId, draftId: string): Promise<void> {
    await this.drafts.updateOne({ _id: draftId, userId }, { $set: { active: false } });
  }

  private async trimParked(userId: Types.ObjectId, conversationId: Types.ObjectId): Promise<void> {
    const parked = await this.drafts.find({ userId, conversationId, active: false }, { _id: 1 }).sort({ updatedAt: -1 }).skip(BUDDY_LIMITS.parkedDrafts).lean<{ _id: string }[]>();
    if (parked.length) await this.drafts.deleteMany({ userId, _id: { $in: parked.map((p) => p._id) } });
  }

  /** Card edits: all or nothing, one version bump; 409 with the current draft when the card is stale. */
  async patch(userId: Types.ObjectId, conversationId: Types.ObjectId, body: PatchDraftRequest): Promise<ChatDraft> {
    const current = await this.active(userId, conversationId);
    if (!current) throw ApiError.notFound(ERROR_CODES.DRAFT_NOT_FOUND, 'There is no card to edit');
    if (current.version !== body.version) throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'The card changed; this is the current version', { draft: current });
    const res = applyEdits(current, body.ops, clock.now());
    if (!res.ok) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Edit not possible: ${res.reason}`, 422, { field: res.field, reason: res.reason });
    if (!(await this.save(userId, conversationId, res.draft, current.version))) {
      throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'The card changed; this is the current version', { draft: await this.active(userId, conversationId) });
    }
    return res.draft;
  }

  /** new: parks the active draft; resume: makes a parked one active; discard: drops the active one. */
  async lifecycle(userId: Types.ObjectId, conversationId: Types.ObjectId, body: DraftLifecycleRequest): Promise<DraftState> {
    const current = await this.active(userId, conversationId);
    if (body.action === 'new') {
      if (current) await this.park(userId, current.id);
    } else if (body.action === 'discard') {
      if (current) {
        if (body.version !== undefined && body.version !== current.version) throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'The card changed; this is the current version', { draft: current });
        await this.drafts.updateOne({ _id: current.id, userId }, { $set: { active: false, 'data.status': 'discarded' } });
      }
    } else {
      if (!body.draftId) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'draftId is required to resume', 400, { field: 'draftId' });
      const target = await this.drafts.findOne({ _id: body.draftId, userId, conversationId }).lean<ChatDraftDoc>();
      if (!target || (target.data as ChatDraft).status === 'discarded') throw ApiError.notFound(ERROR_CODES.DRAFT_NOT_FOUND, 'That card could not be found');
      if (current && current.id !== target._id) await this.park(userId, current.id);
      await this.drafts.updateOne({ _id: target._id, userId }, { $set: { active: true } });
    }
    return this.state(userId, conversationId);
  }

  async deleteForConversations(userId: Types.ObjectId, conversationIds: Types.ObjectId[]): Promise<void> {
    await this.drafts.deleteMany({ userId, conversationId: { $in: conversationIds } });
  }
}
