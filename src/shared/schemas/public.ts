import { z } from 'zod';

const email = z.email().max(254).transform((v) => v.trim().toLowerCase());
const turnstileToken = z.string().min(1).max(4096).describe('Cloudflare Turnstile token (any value accepted in development)');

export const WaitlistRequestSchema = z
  .strictObject({
    email,
    turnstileToken,
    source: z.string().max(64).optional(),
    utm: z.record(z.string().max(32), z.string().max(200)).optional(),
  })
  .meta({ id: 'WaitlistRequest' });
export type WaitlistRequest = z.input<typeof WaitlistRequestSchema>;

export const WaitlistResponseSchema = z
  .object({ status: z.enum(['joined', 'already_joined']) })
  .meta({ id: 'WaitlistResponse' });
export type WaitlistResponse = z.infer<typeof WaitlistResponseSchema>;

export const DeletionRequestSchema = z
  .strictObject({ email, turnstileToken, reason: z.string().max(500).optional() })
  .meta({ id: 'DeletionRequest' });
export type DeletionRequest = z.input<typeof DeletionRequestSchema>;

export const DeletionRequestResponseSchema = z
  .object({ status: z.literal('received') })
  .meta({ id: 'DeletionRequestResponse', description: 'Always the same response; no account enumeration' });

export const AppConfigResponseSchema = z
  .object({
    flags: z.record(z.string(), z.boolean()),
    experiments: z.record(z.string(), z.string()).describe('This user\'s variants; empty when signed out'),
    limits: z.record(z.string(), z.unknown()),
    minAppVersion: z.object({ ios: z.string(), android: z.string() }),
    legal: z.record(z.string(), z.string()),
    killSwitches: z.object({ vision: z.boolean(), chat: z.boolean(), extract: z.boolean(), tts: z.boolean() }),
    contentVersions: z.object({ onboardingQuestions: z.number().int().nullable(), conversation: z.number().int().nullable(), miloLines: z.number().int().nullable() }),
  })
  .meta({ id: 'AppConfigResponse' });
export type AppConfigResponse = z.infer<typeof AppConfigResponseSchema>;

export const BillingEntitlementSchema = z
  .object({
    plan: z.enum(['free', 'plus']),
    isPlus: z.boolean(),
    period: z.enum(['monthly', 'yearly']).nullable(),
    activeUntil: z.string().nullable(),
    source: z.enum(['app_store', 'play_store', 'promo']).nullable(),
    freeScans: z.object({ allowance: z.number().int(), used: z.number().int(), remaining: z.number().int() }),
    products: z.object({ monthly: z.string(), yearly: z.string() }),
  })
  .meta({ id: 'BillingEntitlement' });
export type BillingEntitlement = z.infer<typeof BillingEntitlementSchema>;

export const BillingSyncRequestSchema = z
  .strictObject({ platform: z.enum(['ios', 'android']).optional() })
  .meta({ id: 'BillingSyncRequest' });

export const UPLOAD_KINDS = {
  meal_photo: { contentTypes: ['image/jpeg'], maxBytes: 1_500_000, ext: 'jpg' },
  voice_note: { contentTypes: ['audio/aac', 'audio/mp4', 'audio/m4a'], maxBytes: 2_000_000, ext: 'm4a' },
} as const;

export const PresignRequestSchema = z
  .strictObject({
    kind: z.enum(['meal_photo', 'voice_note']),
    contentType: z.string().max(64),
    bytes: z.number().int().positive().optional().describe('Planned size; rejected early when over maxBytes'),
  })
  .meta({ id: 'PresignRequest' });
export type PresignRequest = z.infer<typeof PresignRequestSchema>;

export const PresignResponseSchema = z
  .object({
    uploadUrl: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()).describe('Send exactly these headers with the PUT'),
    key: z.string().describe('Pass as imageKey to POST /scans'),
    maxBytes: z.number().int(),
    expiresAt: z.string(),
  })
  .meta({ id: 'PresignResponse' });
export type PresignResponse = z.infer<typeof PresignResponseSchema>;
