import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import {
  ERROR_CODES,
  type ActionRequest,
  type ActionResult,
  type ChatDraft,
  type InterpretOp,
  type MealCategory,
  type MemoryCategory,
  type ReminderInput,
  type ServerActionType,
} from '../../../shared';
import { applyModelOps, mealRequestFor } from '../../../domain/chat-draft';
import { actionResultCard, containsHealthKeys, defaultCategory, type ActionSpec } from '../../../domain/buddy-cards';
import { dayKeyFor } from '../../../domain/day-keys';
import { localMinutes } from '../../../domain/nudges';
import { clock } from '../../../common/clock';
import { ApiError } from '../../../common/errors/api-error';
import { CoachMemoryService } from '../../coach-preferences/coach-memory.service';
import { RecipesService } from '../../recipes/recipes.service';
import { RemindersService } from '../../reminders/reminders.service';
import type { MealDoc } from '../../tracking/schemas/tracking.schema';
import { MealsService } from '../../tracking/services/meals.service';
import { UsersService } from '../../users/users.service';
import type { ChatActionDoc } from '../schemas/conversations.schema';
import { DraftsService } from './drafts.service';

/** A card's buttons work for a week (then 410 ACTION_EXPIRED); the rows go after 30 days. */
const USABLE_MS = 7 * 86_400_000;
const KEEP_MS = 30 * 86_400_000;
/** A parallel run of the same action waits this long for the first one to finish. */
const WAIT_MS = 5000;

export interface ExecuteOptions {
  /** Where the request came from: a card tap (the app's day/slot) or the person's explicit words in a turn. */
  source: 'text' | 'voice';
  /** Sensitive memories need the card tap (consent); an explicit "remember that" of a non-sensitive fact does not. */
  consented: boolean;
}

/**
 * The only way Milo chat changes saved data (contract §3). Each action is stored when its card is built, with everything it
 * needs, so the client only names it. It runs once: a repeat (double tap, retry, a model repeating "add it") replays the
 * stored result. Writes go through the same services as the rest of the app (MealsService, RecipesService,
 * RemindersService, CoachMemoryService); success is returned only after they committed.
 */
@Injectable()
export class ActionsService {
  constructor(
    @InjectModel('ChatAction') private readonly actions: Model<ChatActionDoc>,
    @InjectModel('Meal') private readonly meals: Model<MealDoc>,
    private readonly drafts: DraftsService,
    private readonly mealsService: MealsService,
    private readonly recipes: RecipesService,
    private readonly reminders: RemindersService,
    private readonly memory: CoachMemoryService,
    private readonly users: UsersService,
  ) {}

  /** Stores the actions of freshly built cards (the same id twice keeps the first row). */
  async register(userId: Types.ObjectId, conversationId: Types.ObjectId, specs: readonly ActionSpec[]): Promise<void> {
    if (!specs.length) return;
    const now = clock.now();
    await this.actions.bulkWrite(
      specs.map((s) => ({
        updateOne: {
          filter: { _id: s.id, userId },
          update: {
            $setOnInsert: {
              _id: s.id,
              userId,
              conversationId,
              type: s.type,
              draftId: s.draftId,
              draftVersion: s.draftVersion,
              payload: s.payload,
              status: 'open',
              result: null,
              claimedAt: null,
              usableUntil: new Date(now.getTime() + USABLE_MS),
              expiresAt: new Date(now.getTime() + KEEP_MS),
            },
          },
          upsert: true,
        },
      })),
    );
  }

  /** Meals of a draft's logs that were deleted since (undo): the next card offers a fresh log action. */
  async deletedLogMeals(userId: Types.ObjectId, d: ChatDraft | null): Promise<string[]> {
    const ids = (d?.logs ?? []).map((l) => l.mealId).filter((id) => Types.ObjectId.isValid(id));
    if (!ids.length) return [];
    const live = await this.meals.find({ userId, _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, deletedAt: null }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
    const alive = new Set(live.map((m) => m._id.toString()));
    return ids.filter((id) => !alive.has(id));
  }

  async execute(userId: string, conversationId: string, actionId: string, body: ActionRequest, opts: ExecuteOptions = { source: 'text', consented: true }): Promise<ActionResult> {
    const user = await this.users.requireActive(userId);
    const uid = user._id;
    let row = await this.actions.findOne({ _id: actionId, userId: uid, conversationId: new Types.ObjectId(conversationId) }).lean<ChatActionDoc>();
    if (!row) throw ApiError.notFound(ERROR_CODES.ACTION_NOT_FOUND, 'That button no longer works');
    if (row.status === 'done') return row.result as ActionResult;
    if (clock.now() > row.usableUntil) throw new ApiError(ERROR_CODES.ACTION_EXPIRED, 'That card is too old to use', 410);
    // Claim it: one run at a time. A parallel request waits for the first one's result.
    const claimed = await this.actions.findOneAndUpdate({ _id: actionId, userId: uid, status: 'open' }, { $set: { status: 'running', claimedAt: clock.now() } }, { returnDocument: 'after' }).lean<ChatActionDoc>();
    if (!claimed) {
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        row = await this.actions.findOne({ _id: actionId, userId: uid }).lean<ChatActionDoc>();
        if (row?.status === 'done') return row.result as ActionResult;
        if (row?.status === 'open') return this.execute(userId, conversationId, actionId, body, opts);
      }
      throw ApiError.conflict(ERROR_CODES.CONFLICT, 'This is already being saved');
    }
    try {
      const result = await this.run(uid, user.timezone, claimed, body, opts);
      if (containsHealthKeys(result)) throw new Error('health numbers in an action result');
      await this.actions.updateOne({ _id: actionId, userId: uid }, { $set: { status: 'done', result } });
      return result;
    } catch (e) {
      await this.actions.updateOne({ _id: actionId, userId: uid, status: 'running' }, { $set: { status: 'open', claimedAt: null } });
      throw e;
    }
  }

  private async draftFor(uid: Types.ObjectId, row: ChatActionDoc, body: ActionRequest): Promise<ChatDraft> {
    const draft = row.draftId ? await this.drafts.get(uid, row.draftId) : null;
    if (!draft || draft.status === 'discarded') throw new ApiError(ERROR_CODES.ACTION_EXPIRED, 'That card was discarded', 410);
    const shown = body.draftVersion ?? row.draftVersion;
    if (draft.version !== shown || draft.version !== row.draftVersion) throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'The card changed; this is the current version', { draft });
    return draft;
  }

  private async run(uid: Types.ObjectId, tz: string, row: ChatActionDoc, body: ActionRequest, opts: ExecuteOptions): Promise<ActionResult> {
    const type = row.type as ServerActionType;
    const base = { actionId: row._id, type, status: 'done' as const, meal: null, recipe: null, reminders: null, memory: null, draft: null };
    const userId = uid.toString();
    switch (type) {
      case 'log_meal':
      case 'log_portion': {
        const draft = await this.draftFor(uid, row, body);
        const now = clock.now();
        const timezone = body.timezone ?? tz;
        const date = body.date ?? dayKeyFor(now, timezone);
        const category: MealCategory = body.category ?? defaultCategory(Math.floor(localMinutes(now, timezone) / 60));
        // The same draft version already in the diary (and not undone): that meal, not a second one.
        const deleted = new Set(await this.deletedLogMeals(uid, draft));
        const same = draft.logs.find((l) => l.draftVersion === draft.version && !deleted.has(l.mealId));
        if (same) {
          const meal = await this.mealsService.list(userId, same.date, same.date).then((ms) => ms.find((m) => m.id === same.mealId) ?? null);
          return { ...base, meal, draft, card: actionResultCard(type, { actionId: row._id, mealId: same.mealId, date: same.date, category: same.category }) };
        }
        const req = mealRequestFor(draft, { date, timezone, loggedAt: body.loggedAt ?? now.toISOString(), category, source: opts.source });
        if (!req.ok) throw new ApiError(ERROR_CODES.ACTION_BLOCKED, 'A detail is still missing before this can be saved', 422, { blockedBy: req.blockedBy });
        const meal = await this.mealsService.create(userId, req.request, now, { recipeId: draft.kind === 'recipe' ? draft.savedRecipeId : null });
        const logs = [...draft.logs, { actionId: row._id, mealId: meal.id, date: meal.date, category: meal.category, draftVersion: draft.version }];
        const noted = await this.drafts.note(uid, draft.id, { logs, status: draft.status === 'saved' ? 'saved' : 'logged' });
        return { ...base, meal, draft: noted, card: actionResultCard(type, { actionId: row._id, mealId: meal.id, date: meal.date, category: meal.category }) };
      }
      case 'save_recipe':
      case 'update_recipe': {
        const draft = await this.draftFor(uid, row, body);
        const recipe = type === 'update_recipe' && draft.savedRecipeId ? await this.recipes.updateFromDraft(userId, draft.savedRecipeId, draft) : await this.recipes.createFromDraft(userId, draft);
        const noted = await this.drafts.note(uid, draft.id, { savedRecipeId: recipe.id, status: draft.status === 'logged' ? 'logged' : 'saved' });
        return { ...base, recipe, draft: noted, card: actionResultCard(type, { actionId: row._id, recipeId: recipe.id }) };
      }
      case 'apply_changes': {
        const draft = await this.draftFor(uid, row, body);
        const ops = ((row.payload as { ops?: InterpretOp[] })?.ops ?? []) as InterpretOp[];
        const res = applyModelOps(draft, ops, this.drafts.context(row.conversationId.toString()));
        if (!res.changed || !res.draft || res.draft.id !== draft.id) throw new ApiError(ERROR_CODES.ACTION_BLOCKED, 'These changes no longer fit the recipe', 422, { blockedBy: 'clarification' });
        if (!(await this.drafts.save(uid, row.conversationId, res.draft, draft.version))) {
          throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'The card changed; this is the current version', { draft: await this.drafts.get(uid, draft.id) });
        }
        return { ...base, draft: res.draft, card: actionResultCard(type, { actionId: row._id }) };
      }
      case 'discard_draft': {
        const draft = await this.draftFor(uid, row, body);
        await this.drafts.lifecycle(uid, row.conversationId, { action: 'discard', version: draft.version });
        return { ...base, card: actionResultCard(type, { actionId: row._id }) };
      }
      case 'save_memory': {
        const p = row.payload as { text: string; category: MemoryCategory; sensitive: boolean };
        const memory = await this.memory.add(userId, { text: p.text, category: p.category, sensitive: p.sensitive, conversationId: row.conversationId.toString() }, opts.consented);
        return { ...base, memory, card: actionResultCard(type, { actionId: row._id, memoryId: memory.id }) };
      }
      case 'create_reminder': {
        const p = row.payload as { reminder: ReminderInput };
        const { response, reminderId } = await this.reminders.upsertOne(userId, p.reminder, body.timezone);
        return { ...base, reminders: response, card: actionResultCard(type, { actionId: row._id, reminderId }) };
      }
    }
  }

  async deleteForConversations(userId: Types.ObjectId, conversationIds: Types.ObjectId[]): Promise<void> {
    await this.actions.deleteMany({ userId, conversationId: { $in: conversationIds } });
  }
}
