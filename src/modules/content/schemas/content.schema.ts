import { Schema, type InferSchemaType } from 'mongoose';

export const CONTENT_KINDS = ['onboarding_questions', 'conversation', 'milo_lines'] as const;

/** content_versions: published content, one document per kind and version (plan section 6). */
export const ContentVersionSchema = new Schema(
  {
    // Base kinds, plus `<kind>.<lang>` for translated copies (decision 0007).
    kind: { type: String, match: new RegExp(`^(${CONTENT_KINDS.join('|')})(\\.[a-z]{2,3})?$`), required: true },
    version: { type: Number, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    publishedAt: { type: Date, required: true },
    source: { type: String, default: 'seed' },
  },
  { collection: 'content_versions', timestamps: true, minimize: false },
);
ContentVersionSchema.index({ kind: 1, version: -1 }, { unique: true });
export type ContentVersionDoc = InferSchemaType<typeof ContentVersionSchema>;

/** ai_prompts: prompt registry, static prefix first for prompt caching (S-18). */
export const AiPromptSchema = new Schema(
  {
    key: { type: String, required: true },
    version: { type: Number, required: true },
    content: { type: String, required: true },
    staticPrefix: { type: String, required: true },
    dynamicTemplate: { type: String, default: '' },
    meta: { type: Schema.Types.Mixed, default: {} },
    model: { type: String, default: null },
    params: { type: Schema.Types.Mixed, default: {} },
    active: { type: Boolean, default: false },
    notes: { type: String, default: '' },
    activatedAt: { type: Date, default: null },
    createdBy: { type: String, default: 'seed' },
  },
  { collection: 'ai_prompts', timestamps: true, minimize: false },
);
AiPromptSchema.index({ key: 1, version: 1 }, { unique: true });
AiPromptSchema.index({ key: 1, active: 1 });
export type AiPromptDoc = InferSchemaType<typeof AiPromptSchema>;

/** app_config: flags, limits, kill switches, experiments, min app version. */
export const AppConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, default: null },
    description: { type: String, default: '' },
    reason: { type: String, default: null },
    updatedBy: { type: String, default: 'system' },
  },
  { collection: 'app_config', timestamps: true, minimize: false },
);
export type AppConfigDoc = InferSchemaType<typeof AppConfigSchema>;
