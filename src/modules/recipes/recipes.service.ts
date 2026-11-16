import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { BUDDY_LIMITS, ERROR_CODES, type ChatDraft, type CreateRecipeRequest, type DraftItem, type Recipe, type UpdateRecipeRequest } from '../../shared';
import { USER_ENTERED, sanitisePer100g } from '../../domain/food-nutrition';
import { recipeFieldsOf, recipeValues } from '../../domain/chat-draft';
import { ApiError } from '../../common/errors/api-error';
import type { RecipeDoc } from './schemas/recipes.schema';

type ItemInput = CreateRecipeRequest['items'][number];

/** An ingredient sent directly (no AI): its per-100 g basis is the client's, marked user-entered; values come from it. */
function itemFromInput(i: ItemInput, n: number): DraftItem {
  const per100g = sanitisePer100g({ kcal: i.per100g.kcal, proteinG: i.per100g.proteinG, carbsG: i.per100g.carbsG, fatG: i.per100g.fatG, fiberG: i.per100g.fiberG, sugarG: i.per100g.sugarG, sodiumMg: i.per100g.sodiumMg }).per100g;
  return {
    id: `i${n + 1}`,
    name: i.name,
    canonicalName: null,
    quantity: { value: i.quantity?.value ?? i.grams, unit: i.quantity?.unit ?? 'g', text: i.quantity?.text ?? `${i.grams} g` },
    grams: Math.round(i.grams * 10) / 10,
    quantityStated: true,
    state: i.state ?? null,
    bone: i.bone ?? null,
    preparation: null,
    processing: null,
    kcal: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
    fiberG: null,
    sugarG: null,
    sodiumMg: null,
    per100g,
    source: USER_ENTERED,
    assumption: null,
  };
}

/** Saved recipes (Milo buddy, contract §5). Every write recomputes the values with the draft calculator. */
@Injectable()
export class RecipesService {
  constructor(@InjectModel('Recipe') private readonly recipes: Model<RecipeDoc>) {}

  toRecipe(d: RecipeDoc): Recipe {
    return {
      id: d._id.toString(),
      name: d.name,
      items: d.items,
      servings: d.servings ?? null,
      cookedYieldG: d.cookedYieldG ?? null,
      rawWeightG: d.rawWeightG,
      totals: d.totals,
      per100gCooked: d.per100gCooked ?? null,
      version: d.version,
      createdFrom: d.createdFrom ?? null,
      createdAt: new Date(d.createdAt).toISOString(),
      updatedAt: new Date(d.updatedAt).toISOString(),
    };
  }

  async list(userId: string): Promise<Recipe[]> {
    const docs = await this.recipes.find({ userId: new Types.ObjectId(userId) }).sort({ updatedAt: -1 }).limit(100).lean<RecipeDoc[]>();
    return docs.map((d) => this.toRecipe(d));
  }

  /** Names for the model (load_recipe): at most 20, newest first. */
  async names(userId: Types.ObjectId): Promise<{ id: string; name: string }[]> {
    const docs = await this.recipes.find({ userId }, { name: 1 }).sort({ updatedAt: -1 }).limit(20).lean<Pick<RecipeDoc, '_id' | 'name'>[]>();
    return docs.map((d) => ({ id: d._id.toString(), name: d.name }));
  }

  async find(userId: string, id: string): Promise<RecipeDoc> {
    if (!Types.ObjectId.isValid(id)) throw ApiError.notFound(ERROR_CODES.RECIPE_NOT_FOUND, 'Recipe not found');
    const doc = await this.recipes.findOne({ _id: id, userId: new Types.ObjectId(userId) }).lean<RecipeDoc>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.RECIPE_NOT_FOUND, 'Recipe not found');
    return doc;
  }

  async get(userId: string, id: string): Promise<Recipe> {
    return this.toRecipe(await this.find(userId, id));
  }

  private async assertRoom(uid: Types.ObjectId): Promise<void> {
    if ((await this.recipes.countDocuments({ userId: uid })) >= BUDDY_LIMITS.recipesPerUser) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `At most ${BUDDY_LIMITS.recipesPerUser} saved recipes; delete one first`, 422, { reason: 'recipe_limit' });
    }
  }

  async create(userId: string, body: CreateRecipeRequest): Promise<Recipe> {
    const uid = new Types.ObjectId(userId);
    await this.assertRoom(uid);
    const cooked = body.cookedYieldG ?? null;
    const v = recipeValues(body.items.map(itemFromInput), cooked);
    const doc = await this.recipes.create({ userId: uid, name: body.name, items: v.items, servings: body.servings ?? null, cookedYieldG: cooked, rawWeightG: v.rawWeightG, totals: v.totals, per100gCooked: v.per100gCooked, version: 1, createdFrom: null });
    return this.toRecipe(doc.toObject() as RecipeDoc);
  }

  /** save_recipe from a chat draft (the action executor makes it run once). */
  async createFromDraft(userId: string, draft: ChatDraft): Promise<Recipe> {
    const uid = new Types.ObjectId(userId);
    await this.assertRoom(uid);
    const f = recipeFieldsOf(draft);
    const v = recipeValues(f.items, f.cookedYieldG);
    const doc = await this.recipes.create({
      userId: uid,
      name: f.name,
      items: v.items,
      servings: f.servings,
      cookedYieldG: f.cookedYieldG,
      rawWeightG: v.rawWeightG,
      totals: v.totals,
      per100gCooked: v.per100gCooked,
      version: 1,
      createdFrom: { conversationId: draft.conversationId, draftId: draft.id },
    });
    return this.toRecipe(doc.toObject() as RecipeDoc);
  }

  /** update_recipe from a chat draft that was loaded from (or saved as) this recipe: the person tapped Update. */
  async updateFromDraft(userId: string, id: string, draft: ChatDraft): Promise<Recipe> {
    const current = await this.find(userId, id);
    const f = recipeFieldsOf(draft);
    const v = recipeValues(f.items, f.cookedYieldG);
    const doc = await this.recipes
      .findOneAndUpdate(
        { _id: current._id, userId: current.userId },
        { $set: { name: f.name, items: v.items, servings: f.servings, cookedYieldG: f.cookedYieldG, rawWeightG: v.rawWeightG, totals: v.totals, per100gCooked: v.per100gCooked }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      .lean<RecipeDoc>();
    return this.toRecipe(doc!);
  }

  async update(userId: string, id: string, body: UpdateRecipeRequest): Promise<Recipe> {
    const current = await this.find(userId, id);
    if (current.version !== body.version) throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'The recipe changed since it was loaded', { recipe: this.toRecipe(current) });
    const items = body.items ? body.items.map(itemFromInput) : current.items;
    const cooked = body.cookedYieldG === undefined ? current.cookedYieldG : body.cookedYieldG;
    const v = recipeValues(items, cooked);
    const doc = await this.recipes
      .findOneAndUpdate(
        { _id: current._id, userId: current.userId, version: body.version },
        {
          $set: {
            name: body.name ?? current.name,
            items: v.items,
            servings: body.servings === undefined ? current.servings : body.servings,
            cookedYieldG: cooked,
            rawWeightG: v.rawWeightG,
            totals: v.totals,
            per100gCooked: v.per100gCooked,
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after' },
      )
      .lean<RecipeDoc>();
    if (!doc) throw ApiError.conflict(ERROR_CODES.VERSION_CONFLICT, 'The recipe changed since it was loaded', { recipe: this.toRecipe(await this.find(userId, id)) });
    return this.toRecipe(doc);
  }

  async remove(userId: string, id: string): Promise<void> {
    const doc = await this.find(userId, id);
    await this.recipes.deleteOne({ _id: doc._id, userId: doc.userId });
  }
}
