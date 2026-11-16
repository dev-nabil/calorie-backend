import { z } from 'zod';
import { FOOD_PREPARATIONS, FOOD_PROCESSING, MEAL_CATEGORIES } from '../enums';
import { IsoDateTimeSchema, DayKeySchema, ObjectIdSchema, TimeZoneSchema } from './common';
import { MealSchema, MealTotalsSchema, NutrientValuesSchema, NutritionSourceSchema, Per100gInputSchema } from './meals';
import { RecapStatsSchema } from './recap';
import { ReminderInputSchema, RemindersResponseSchema } from './days';
import { DESCRIBE_UNITS } from './meal-describe';

/**
 * Milo buddy (16 Nov 2026, decision 0016, handoff/milo-buddy-contract.md): drafts built in chat, the cards under a reply and
 * the actions that save things. Every number here is computed by the server (domain/chat-draft, domain/buddy-cards);
 * null means unknown and is never shown as zero.
 */

export const DRAFT_KINDS = ['recipe', 'meal'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export const DRAFT_STATUSES = ['open', 'logged', 'saved', 'discarded'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export const ITEM_STATES = ['raw', 'cooked'] as const;
export const BONE_STATES = ['in', 'out'] as const;
export const PORTION_KINDS = ['servings', 'fraction', 'grams', 'all'] as const;
export type PortionKind = (typeof PORTION_KINDS)[number];
export const ASSUMPTION_CODES = ['amount_assumed', 'raw_share_weight', 'yield_unknown', 'bone_unknown', 'state_unknown', 'basis_assumed', 'text'] as const;
export type AssumptionCode = (typeof ASSUMPTION_CODES)[number];
export const BLOCKED_REASONS = ['portion', 'yield', 'clarification', 'plus', 'limit', 'empty'] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];
export const SERVER_ACTION_TYPES = ['log_meal', 'log_portion', 'save_recipe', 'update_recipe', 'apply_changes', 'save_memory', 'create_reminder', 'discard_draft'] as const;
export type ServerActionType = (typeof SERVER_ACTION_TYPES)[number];
export const CLIENT_ACTION_TYPES = ['edit_items', 'change_portion', 'open_meal', 'undo', 'open_reminders', 'open_memory'] as const;
export type ClientActionType = (typeof CLIENT_ACTION_TYPES)[number];
export const MEMORY_CATEGORIES = ['preference', 'dislike', 'routine', 'cooking', 'health', 'other'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export const REPLY_LENGTHS = ['short', 'normal', 'detailed'] as const;
export type ReplyLength = (typeof REPLY_LENGTHS)[number];
export const BUDGET_BASES = ['base', 'adjusted'] as const;

/** Limits of the buddy (the server enforces them; the model is told). */
export const BUDDY_LIMITS = {
  draftItems: 15,
  recipeItemGramsMax: 10_000,
  servingsMax: 50,
  cookedYieldMaxG: 20_000,
  parkedDrafts: 3,
  recipesPerUser: 200,
  memoriesMax: 50,
  memoryMaxChars: 200,
  interpretHistory: 6,
  interpretMessageChars: 400,
  suggestions: 3,
  compareItems: 3,
} as const;

// ── Drafts ─────────────────────────────────────────────────────────────────────────────────────────

export const DraftQuantitySchema = z
  .object({ value: z.number().nullable(), unit: z.enum(DESCRIBE_UNITS).nullable(), text: z.string().nullable() })
  .meta({ id: 'DraftQuantity' });

export const DraftItemSchema = z
  .object({
    id: z.string().describe('i1, i2, … stable inside the draft'),
    name: z.string(),
    canonicalName: z.string().nullable(),
    quantity: DraftQuantitySchema.describe('What the person said (or what was assumed, see quantityStated)'),
    grams: z.number(),
    quantityStated: z.boolean().describe('true: the person gave this amount ("you told me"); false: assumed'),
    state: z.enum(ITEM_STATES).nullable(),
    bone: z.enum(BONE_STATES).nullable(),
    preparation: z.enum(FOOD_PREPARATIONS).nullable(),
    processing: z.enum(FOOD_PROCESSING).nullable(),
    kcal: z.number().nullable(),
    proteinG: z.number().nullable(),
    carbsG: z.number().nullable(),
    fatG: z.number().nullable(),
    fiberG: z.number().nullable(),
    sugarG: z.number().nullable(),
    sodiumMg: z.number().nullable(),
    per100g: NutrientValuesSchema,
    source: NutritionSourceSchema.describe('verified_record = a published record; ai_estimate = an assumed per-100 g basis (never shown as "estimate")'),
    assumption: z.string().nullable().describe("Milo's short note in the reply language, for example \"assumed boneless\""),
  })
  .meta({ id: 'DraftItem' });
export type DraftItem = z.infer<typeof DraftItemSchema>;

export const PortionSchema = z
  .object({
    kind: z.enum(PORTION_KINDS),
    servings: z.number().nullable().describe('kind servings: servings eaten (of recipe.servings)'),
    fraction: z.number().nullable().describe('kind fraction: share of the whole recipe (0.5 = half)'),
    grams: z.number().nullable().describe('kind grams: cooked grams eaten; needs recipe.cookedYieldG'),
  })
  .meta({ id: 'Portion' });
export type Portion = z.infer<typeof PortionSchema>;

export const AssumptionSchema = z
  .object({ code: z.enum(ASSUMPTION_CODES), itemId: z.string().nullable(), text: z.string().nullable().describe('Only for code text') })
  .meta({ id: 'Assumption', description: 'The app words the codes itself; never "estimate"' });
export type Assumption = z.infer<typeof AssumptionSchema>;

export const DraftRecipeSchema = z
  .object({
    servings: z.number().int().nullable(),
    cookedYieldG: z.number().nullable().describe('Weight of the finished dish, only when the person said it'),
    rawWeightG: z.number().describe('Sum of the ingredient grams'),
    totals: MealTotalsSchema.describe('The WHOLE recipe'),
    per100gCooked: NutrientValuesSchema.nullable().describe('Only with cookedYieldG'),
  })
  .meta({ id: 'DraftRecipe' });

export const DraftLogSchema = z
  .object({ actionId: z.string(), mealId: z.string(), date: z.string(), category: z.enum(MEAL_CATEGORIES), draftVersion: z.number().int() })
  .meta({ id: 'DraftLog' });

export const DraftPendingSchema = z
  .object({ code: z.enum(['yield', 'portion', 'clarification']), itemId: z.string().nullable() })
  .meta({ id: 'DraftPending', description: 'What is still needed before the log action works (the reply asks for it)' });

export const ChatDraftSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    version: z.number().int().describe('Bumped on every change; send it back with turns, edits and actions'),
    kind: z.enum(DRAFT_KINDS),
    status: z.enum(DRAFT_STATUSES).describe('logged/saved drafts stay editable; edits never change the diary'),
    name: z.string(),
    items: z.array(DraftItemSchema),
    recipe: DraftRecipeSchema.nullable().describe('kind recipe only'),
    portion: PortionSchema.nullable().describe('What the person ate (recipe); kept apart from the recipe totals'),
    portionTotals: MealTotalsSchema.nullable().describe('The eaten portion (recipe) or the meal itself (kind meal); null when not computable yet'),
    portionGrams: z.number().nullable().describe('Grams of the eaten portion (cooked grams, or the raw-ingredient share when the cooked weight is unknown)'),
    gramsBasis: z.enum(['cooked', 'raw_share']).nullable(),
    totals: MealTotalsSchema.describe('kind meal: all items; kind recipe: the whole recipe'),
    assumptions: z.array(AssumptionSchema),
    pending: DraftPendingSchema.nullable(),
    savedRecipeId: z.string().nullable(),
    logs: z.array(DraftLogSchema),
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'ChatDraft' });
export type ChatDraft = z.infer<typeof ChatDraftSchema>;

export const DraftSummarySchema = z
  .object({ id: z.string(), kind: z.enum(DRAFT_KINDS), name: z.string(), status: z.enum(DRAFT_STATUSES), updatedAt: IsoDateTimeSchema })
  .meta({ id: 'DraftSummary' });

export const DraftStateSchema = z
  .object({ draft: ChatDraftSchema.nullable(), parked: z.array(DraftSummarySchema) })
  .meta({ id: 'DraftState' });
export type DraftState = z.infer<typeof DraftStateSchema>;

/** Card edits (PATCH /conversations/{id}/draft): deterministic, no AI call. Adding a food goes through chat. */
export const DraftEditOpSchema = z
  .strictObject({
    op: z.enum(['update_item', 'remove_item', 'rename_item', 'set_servings', 'set_yield', 'set_portion', 'rename']),
    itemId: z.string().max(8).optional(),
    grams: z.number().min(1).max(BUDDY_LIMITS.recipeItemGramsMax).optional().describe('update_item: new grams; set_yield: cooked weight'),
    name: z.string().trim().min(1).max(120).optional(),
    servings: z.number().int().min(1).max(BUDDY_LIMITS.servingsMax).optional(),
    portion: z
      .strictObject({
        kind: z.enum(PORTION_KINDS),
        servings: z.number().min(0.25).max(BUDDY_LIMITS.servingsMax).optional(),
        fraction: z.number().min(0.01).max(1).optional(),
        grams: z.number().min(1).max(BUDDY_LIMITS.cookedYieldMaxG).optional(),
      })
      .optional(),
  })
  .meta({ id: 'DraftEditOp' });
export type DraftEditOp = z.infer<typeof DraftEditOpSchema>;

export const PatchDraftRequestSchema = z
  .strictObject({ version: z.number().int().min(1), ops: z.array(DraftEditOpSchema).min(1).max(20) })
  .meta({ id: 'PatchDraftRequest' });
export type PatchDraftRequest = z.infer<typeof PatchDraftRequestSchema>;

export const DraftLifecycleRequestSchema = z
  .strictObject({ action: z.enum(['new', 'resume', 'discard']), draftId: z.string().max(64).optional(), version: z.number().int().optional() })
  .meta({ id: 'DraftLifecycleRequest' });
export type DraftLifecycleRequest = z.infer<typeof DraftLifecycleRequestSchema>;

// ── Cards and actions ──────────────────────────────────────────────────────────────────────────────

export const CardActionSchema = z
  .object({
    id: z.string().nullable().describe('Server action id for POST /conversations/{id}/actions/{actionId}; null for client-only actions'),
    type: z.enum([...SERVER_ACTION_TYPES, ...CLIENT_ACTION_TYPES]),
    enabled: z.boolean(),
    blockedBy: z.enum(BLOCKED_REASONS).nullable(),
    payload: z.record(z.string(), z.unknown()).nullable().describe('Client-only actions: mealId (open_meal, undo)'),
  })
  .meta({ id: 'CardAction' });
export type CardAction = z.infer<typeof CardActionSchema>;

const cardBase = { id: z.string(), actions: z.array(CardActionSchema) };
const macros = { kcal: z.number().nullable(), proteinG: z.number().nullable(), carbsG: z.number().nullable(), fatG: z.number().nullable() };

export const RecipeCardSchema = z
  .object({
    ...cardBase,
    type: z.literal('recipe'),
    draftId: z.string(),
    version: z.number().int(),
    name: z.string(),
    items: z.array(DraftItemSchema),
    servings: z.number().int().nullable(),
    cookedYieldG: z.number().nullable(),
    rawWeightG: z.number(),
    totals: MealTotalsSchema.describe('Whole recipe'),
    assumptions: z.array(AssumptionSchema),
    savedRecipeId: z.string().nullable(),
  })
  .meta({ id: 'RecipeCard' });

export const PortionCardSchema = z
  .object({
    ...cardBase,
    type: z.literal('portion'),
    draftId: z.string(),
    version: z.number().int(),
    name: z.string(),
    portion: PortionSchema.nullable(),
    servingsTotal: z.number().int().nullable(),
    grams: z.number().nullable(),
    gramsBasis: z.enum(['cooked', 'raw_share']).nullable(),
    totals: MealTotalsSchema.nullable().describe('The eaten portion; null until the portion is computable'),
    date: z.string(),
    category: z.enum(MEAL_CATEGORIES),
  })
  .meta({ id: 'PortionCard' });

export const MealCardSchema = z
  .object({
    ...cardBase,
    type: z.literal('meal'),
    draftId: z.string(),
    version: z.number().int(),
    name: z.string(),
    items: z.array(DraftItemSchema),
    totals: MealTotalsSchema,
    assumptions: z.array(AssumptionSchema),
    date: z.string(),
    category: z.enum(MEAL_CATEGORIES),
  })
  .meta({ id: 'MealCard' });

export const DaySummaryCardSchema = z
  .object({
    ...cardBase,
    type: z.literal('day_summary'),
    date: z.string(),
    isToday: z.boolean(),
    mode: z.enum(['full', 'habits_only']),
    logged: z.object({ meals: z.number().int(), ...macros }).describe('Only what was logged; habits_only: kcal and macros null'),
    slots: z.array(z.object({ category: z.enum(MEAL_CATEGORIES), mealCount: z.number().int(), kcal: z.number().nullable().describe('null when nothing is logged in the slot (never 0)') })),
    baseKcal: z.number().nullable().describe("The plan's daily goal"),
    budget: z
      .object({ activityAdjustmentKcal: z.number().int(), goalKcal: z.number().int() })
      .nullable()
      .describe('Live response only, when the app sent an activity adjustment; never stored, null in history and replays'),
    budgetBasis: z.enum(BUDGET_BASES),
    remaining: z.object(macros).nullable().describe('Against the goal of budgetBasis; null in habits_only mode'),
    water: z.object({ totalMl: z.number().int(), targetMl: z.number().int() }),
    basis: z.literal('logged'),
  })
  .meta({ id: 'DaySummaryCard' });

export const SuggestionOptionSchema = z
  .object({
    name: z.string(),
    why: z.string(),
    grams: z.number().nullable(),
    ...macros,
    minutes: z.number().int().nullable(),
    uses: z.array(z.string()),
    extra: z.array(z.string()),
  })
  .meta({ id: 'SuggestionOption' });

export const SuggestionsCardSchema = z
  .object({ ...cardBase, type: z.literal('suggestions'), basis: z.enum(['remaining', 'ingredients', 'general']), options: z.array(SuggestionOptionSchema) })
  .meta({ id: 'SuggestionsCard' });

export const ComparisonCardSchema = z
  .object({
    ...cardBase,
    type: z.literal('comparison'),
    per: z.enum(['portion', '100g']),
    items: z.array(z.object({ name: z.string(), grams: z.number(), ...macros, fiberG: z.number().nullable(), source: NutritionSourceSchema })),
  })
  .meta({ id: 'ComparisonCard' });

export const RecipeChangeCardSchema = z
  .object({
    ...cardBase,
    type: z.literal('recipe_change'),
    draftId: z.string(),
    baseVersion: z.number().int(),
    changes: z.array(z.object({ label: z.string() })),
    before: MealTotalsSchema,
    after: MealTotalsSchema,
    delta: z.object(macros),
  })
  .meta({ id: 'RecipeChangeCard' });

export const WeeklyReviewCardSchema = z
  .object({
    ...cardBase,
    type: z.literal('weekly_review'),
    range: z.enum(['last', 'this']),
    weekStart: z.string(),
    weekEnd: z.string(),
    mode: z.enum(['full', 'habits_only']),
    stats: RecapStatsSchema,
    missingDays: z.array(z.string()).describe('Days in the range with nothing logged (not "skipped")'),
    limitedData: z.boolean(),
    weight: z
      .object({ entries: z.number().int(), firstKg: z.number().nullable(), lastKg: z.number().nullable(), changeKg: z.number().nullable(), enough: z.boolean() })
      .nullable()
      .describe('null in habits_only mode'),
  })
  .meta({ id: 'WeeklyReviewCard' });

export const MemoryProposalCardSchema = z
  .object({ ...cardBase, type: z.literal('memory_proposal'), proposalId: z.string(), text: z.string(), category: z.enum(MEMORY_CATEGORIES), sensitive: z.boolean() })
  .meta({ id: 'MemoryProposalCard' });

export const ReminderProposalCardSchema = z
  .object({ ...cardBase, type: z.literal('reminder_proposal'), reminder: ReminderInputSchema })
  .meta({ id: 'ReminderProposalCard' });

export const ActionResultCardSchema = z
  .object({
    ...cardBase,
    type: z.literal('action_result'),
    actionType: z.enum(SERVER_ACTION_TYPES),
    status: z.literal('done'),
    mealId: z.string().nullable(),
    recipeId: z.string().nullable(),
    reminderId: z.string().nullable(),
    memoryId: z.string().nullable(),
    date: z.string().nullable(),
    category: z.enum(MEAL_CATEGORIES).nullable(),
  })
  .meta({ id: 'ActionResultCard' });

export const ChatCardSchema = z
  .discriminatedUnion('type', [
    RecipeCardSchema,
    PortionCardSchema,
    MealCardSchema,
    DaySummaryCardSchema,
    SuggestionsCardSchema,
    ComparisonCardSchema,
    RecipeChangeCardSchema,
    WeeklyReviewCardSchema,
    MemoryProposalCardSchema,
    ReminderProposalCardSchema,
    ActionResultCardSchema,
  ])
  .meta({ id: 'ChatCard' });
export type ChatCard = z.infer<typeof ChatCardSchema>;
export type ChatCardOf<T extends ChatCard['type']> = Extract<ChatCard, { type: T }>;

export const PatchDraftResponseSchema = z.object({ draft: ChatDraftSchema, cards: z.array(ChatCardSchema) }).meta({ id: 'PatchDraftResponse' });

export const ActionRequestSchema = z
  .strictObject({
    draftVersion: z.number().int().optional().describe('Required for draft actions: the version the card shows'),
    date: DayKeySchema.optional().describe('log_*: the day the card shows (default today)'),
    category: z.enum(MEAL_CATEGORIES).optional().describe('log_*: the slot the card shows'),
    timezone: TimeZoneSchema.optional(),
    loggedAt: IsoDateTimeSchema.optional(),
  })
  .meta({ id: 'ActionRequest' });
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const MemoryItemSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    category: z.enum(MEMORY_CATEGORIES),
    sensitive: z.boolean(),
    source: z.enum(['chat', 'you']).describe('chat: learned in a conversation (with consent); you: added or edited by the person'),
    conversationId: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'MemoryItem' });
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const RecipeItemSchema = DraftItemSchema.meta({ id: 'RecipeItem' });

export const RecipeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    items: z.array(DraftItemSchema),
    servings: z.number().int().nullable(),
    cookedYieldG: z.number().nullable(),
    rawWeightG: z.number(),
    totals: MealTotalsSchema,
    per100gCooked: NutrientValuesSchema.nullable(),
    version: z.number().int(),
    createdFrom: z.object({ conversationId: z.string(), draftId: z.string() }).nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Recipe' });
export type Recipe = z.infer<typeof RecipeSchema>;

export const ActionResultSchema = z
  .object({
    actionId: z.string(),
    type: z.enum(SERVER_ACTION_TYPES),
    status: z.literal('done'),
    meal: MealSchema.nullable(),
    recipe: RecipeSchema.nullable(),
    reminders: RemindersResponseSchema.nullable(),
    memory: MemoryItemSchema.nullable(),
    draft: ChatDraftSchema.nullable(),
    card: ActionResultCardSchema,
  })
  .meta({ id: 'ActionResult', description: 'Returned only after the write is committed; a repeat of a done action returns the same result' });
export type ActionResult = z.infer<typeof ActionResultSchema>;

// ── Recipes API ────────────────────────────────────────────────────────────────────────────────────

export const RecipeItemInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    grams: z.number().min(1).max(BUDDY_LIMITS.recipeItemGramsMax),
    per100g: Per100gInputSchema,
    state: z.enum(ITEM_STATES).nullable().optional(),
    bone: z.enum(BONE_STATES).nullable().optional(),
    quantity: z.strictObject({ value: z.number().nullable(), unit: z.enum(DESCRIBE_UNITS).nullable(), text: z.string().max(60).nullable() }).optional(),
  })
  .meta({ id: 'RecipeItemInput' });

export const CreateRecipeRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    items: z.array(RecipeItemInputSchema).min(1).max(BUDDY_LIMITS.draftItems),
    servings: z.number().int().min(1).max(BUDDY_LIMITS.servingsMax).nullable().optional(),
    cookedYieldG: z.number().min(1).max(BUDDY_LIMITS.cookedYieldMaxG).nullable().optional(),
  })
  .meta({ id: 'CreateRecipeRequest' });
export type CreateRecipeRequest = z.infer<typeof CreateRecipeRequestSchema>;

export const UpdateRecipeRequestSchema = z
  .strictObject({
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    items: z.array(RecipeItemInputSchema).min(1).max(BUDDY_LIMITS.draftItems).optional(),
    servings: z.number().int().min(1).max(BUDDY_LIMITS.servingsMax).nullable().optional(),
    cookedYieldG: z.number().min(1).max(BUDDY_LIMITS.cookedYieldMaxG).nullable().optional(),
  })
  .meta({ id: 'UpdateRecipeRequest' });
export type UpdateRecipeRequest = z.infer<typeof UpdateRecipeRequestSchema>;

export const RecipeListSchema = z.object({ items: z.array(RecipeSchema), nextCursor: z.string().nullable() }).meta({ id: 'RecipeList' });

// ── Memory API ─────────────────────────────────────────────────────────────────────────────────────

export const CoachMemorySchema = z
  .object({
    profile: z.array(z.object({ key: z.enum(['goal', 'dietPattern', 'allergies', 'units', 'targets', 'timezone', 'mealsPerDay']), value: z.unknown() })).describe('Read-only facts from goal setup and settings'),
    notes: z.array(z.string()).describe('Notes the person added (Plus), unchanged'),
    memories: z.array(MemoryItemSchema).describe('Learned in chat, newest first'),
    settings: z.object({ chatMemory: z.boolean(), replyLength: z.enum(REPLY_LENGTHS) }),
    canSave: z.boolean().describe('false for free users: they can view, edit, delete and clear only (OQ-48)'),
    retention: z.object({ chatMonths: z.number().int() }),
  })
  .meta({ id: 'CoachMemory' });
export type CoachMemory = z.infer<typeof CoachMemorySchema>;

export const PatchMemorySettingsRequestSchema = z
  .strictObject({ chatMemory: z.boolean().optional(), replyLength: z.enum(REPLY_LENGTHS).optional() })
  .meta({ id: 'PatchMemorySettingsRequest' });
export type PatchMemorySettingsRequest = z.infer<typeof PatchMemorySettingsRequestSchema>;

export const PatchMemoryRequestSchema = z
  .strictObject({ text: z.string().trim().min(1).max(BUDDY_LIMITS.memoryMaxChars) })
  .meta({ id: 'PatchMemoryRequest' });
export type PatchMemoryRequest = z.infer<typeof PatchMemoryRequestSchema>;

// ── Conversations: resume ──────────────────────────────────────────────────────────────────────────

export const LatestConversationSchema = z
  .object({
    id: z.string(),
    type: z.literal('coach'),
    status: z.enum(['active', 'completed']),
    createdAt: IsoDateTimeSchema,
    lastMessageAt: IsoDateTimeSchema.nullable(),
    messageCount: z.number().int(),
    draft: ChatDraftSchema.nullable(),
  })
  .meta({ id: 'LatestConversation' });
export type LatestConversation = z.infer<typeof LatestConversationSchema>;

export const LatestConversationQuerySchema = z.strictObject({ type: z.literal('coach') });
export const DeleteConversationsQuerySchema = z.strictObject({ type: z.literal('coach') });

// ── Health numbers from the phone (one turn only, never stored) ───────────────────────────────────

export const TurnBudgetSchema = z
  .strictObject({
    addActivity: z.boolean(),
    activityAdjustmentKcal: z.number().int().min(0).max(5000).describe('What the app already added to the base goal (0 when the toggle is off)'),
    activeKcal: z.number().int().min(0).max(20000).nullable().describe("Today's active kcal; null = no data (never 0 for no data)"),
  })
  .meta({ id: 'TurnBudget', description: 'Only for date = today and only when health sync is connected. Used for this turn only; never stored or logged' });
export type TurnBudget = z.infer<typeof TurnBudgetSchema>;

export const ClarifySchema = z
  .object({ question: z.string(), options: z.array(z.object({ label: z.string(), itemId: z.string() })) })
  .meta({ id: 'Clarify' });
export type Clarify = z.infer<typeof ClarifySchema>;

// ── Model output of the interpret step (content/prompts/coach-interpret.v1.md) ────────────────────

const per100 = z.number().nullable();
const InterpretNutrientsSchema = z
  .strictObject({ kcal: per100, p: per100, c: per100, f: per100, fib: per100, sug: per100, na: per100 })
  .describe('Values PER 100 g of the food as weighed (kcal; protein, carbs, fat, fibre, sugar in g; sodium in mg); null when unknown');

export const INTERPRET_INTENTS = ['chat', 'log_food', 'recipe', 'correction', 'portion', 'suggest', 'compare', 'modify_recipe', 'memory', 'reminder', 'health', 'other'] as const;
export const INTERPRET_OPS = ['start_draft', 'add_item', 'update_item', 'remove_item', 'set_servings', 'set_yield', 'set_portion', 'rename', 'load_recipe'] as const;
export const INTERPRET_READS = ['day', 'week', 'weights', 'memory', 'recipes'] as const;

export const InterpretOpSchema = z.strictObject({
  op: z.enum(INTERPRET_OPS),
  kind: z.enum(DRAFT_KINDS).nullable().describe('start_draft: recipe (cooked and divided / a dish with ingredients) or meal (foods eaten as they are)'),
  itemId: z.string().nullable().describe('update_item / remove_item: an id from the draft (i1, i2…); null when it is not clear which'),
  name: z.string().nullable().describe('Food name in the reply language; rename/start_draft: the new name'),
  en: z.string().nullable().describe('Plain lowercase English name, for looking up records'),
  qty: z.number().nullable().describe('The number the person said'),
  unit: z.enum(DESCRIBE_UNITS).nullable(),
  g: z.number().nullable().describe('Edible grams as weighed, for the whole amount'),
  stated: z.boolean().nullable().describe('true only when the person said this amount'),
  state: z.enum(ITEM_STATES).nullable().describe('raw or cooked weight, when said'),
  bone: z.enum(BONE_STATES).nullable(),
  prep: z.enum(FOOD_PREPARATIONS).nullable(),
  proc: z.enum(FOOD_PROCESSING).nullable(),
  n: InterpretNutrientsSchema.nullable(),
  assume: z.string().nullable().describe('A few words in the reply language when you assumed what the food is or how it was made'),
  count: z.number().nullable().describe('set_servings: number of equal servings'),
  portionKind: z.enum(PORTION_KINDS).nullable(),
  value: z.number().nullable().describe('set_portion: servings eaten, fraction (0.5) or grams; set_yield: cooked grams'),
  recipeId: z.string().nullable().describe('load_recipe: an id from the saved recipes list'),
});
export type InterpretOp = z.infer<typeof InterpretOpSchema>;

export const InterpretOutputSchema = z.strictObject({
  intent: z.enum(INTERPRET_INTENTS),
  ops: z.array(InterpretOpSchema).describe('Changes to the active draft, in order; empty when none'),
  reads: z.array(z.enum(INTERPRET_READS)).describe('Data the answer needs'),
  clarify: z
    .strictObject({ question: z.string().describe('One short question in the reply language'), itemIds: z.array(z.string()) })
    .nullable()
    .describe('Only when one missing detail changes the result a lot, or it is unclear which item is meant'),
  act: z
    .strictObject({ type: z.enum(['log', 'save_recipe']), category: z.enum(MEAL_CATEGORIES).nullable(), day: z.enum(['today', 'yesterday']).nullable() })
    .nullable()
    .describe('Only when the person clearly asked to add it to the diary or save the recipe in this message'),
  suggestions: z
    .array(
      z.strictObject({
        name: z.string(),
        en: z.string(),
        why: z.string(),
        g: z.number().nullable(),
        n: InterpretNutrientsSchema.nullable(),
        minutes: z.number().nullable(),
        uses: z.array(z.string()),
        extra: z.array(z.string()),
      }),
    )
    .describe('suggest: at most 3 options'),
  compare: z.array(z.strictObject({ name: z.string(), en: z.string(), g: z.number().nullable(), n: InterpretNutrientsSchema.nullable() })).describe('compare: 2 or 3 foods'),
  proposed: z.array(InterpretOpSchema).describe('modify_recipe: changes to suggest (not applied until the person agrees)'),
  memory: z
    .array(z.strictObject({ text: z.string(), category: z.enum(MEMORY_CATEGORIES), sensitive: z.boolean(), explicit: z.boolean().describe('true only when the person asked you to remember it') }))
    .describe('Lasting facts or preferences the person stated; never temporary ones'),
  reminder: z
    .strictObject({
      type: z.enum(['log_meal', 'water', 'habit', 'weekly_review', 'check_in']),
      time: z.string().describe('HH:mm, 24-hour'),
      days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])),
      category: z.enum(MEAL_CATEGORIES).nullable(),
      habit: z.enum(['fruit_veg', 'protein', 'movement', 'sleep', 'custom']).nullable(),
      label: z.string().nullable(),
    })
    .nullable(),
});
export type InterpretOutput = z.infer<typeof InterpretOutputSchema>;

export const EMPTY_INTERPRET: InterpretOutput = {
  intent: 'chat',
  ops: [],
  reads: ['day'],
  clarify: null,
  act: null,
  suggestions: [],
  compare: [],
  proposed: [],
  memory: [],
  reminder: null,
};

/** Draft ops written in the contract and accepted on recipes created from chat. */
export const ObjectIdParamSchema = ObjectIdSchema;
