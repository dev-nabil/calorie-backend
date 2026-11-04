import { z } from 'zod';
import {
  AUTH_PROVIDERS,
  ENTITLEMENT_PERIODS,
  ENTITLEMENT_PLANS,
  ENTITLEMENT_SOURCES,
  USER_STATUSES,
} from '../enums';
import { ENERGY_UNITS, HEIGHT_UNITS, WATER_UNITS, WEIGHT_UNITS } from '../units';
import { IsoDateTimeSchema, TimeZoneSchema } from './common';

export const UnitsSchema = z
  .object({
    weight: z.enum(WEIGHT_UNITS),
    height: z.enum(HEIGHT_UNITS),
    energy: z.enum(ENERGY_UNITS),
    water: z.enum(WATER_UNITS),
  })
  .meta({ id: 'Units' });

export const EntitlementSchema = z
  .object({
    plan: z.enum(ENTITLEMENT_PLANS),
    isPlus: z.boolean().describe('BR-03: plan is plus and activeUntil is in the future'),
    period: z.enum(ENTITLEMENT_PERIODS).nullable(),
    activeUntil: IsoDateTimeSchema.nullable(),
    source: z.enum(ENTITLEMENT_SOURCES).nullable(),
  })
  .meta({ id: 'Entitlement' });
export type Entitlement = z.infer<typeof EntitlementSchema>;

export const FreeScansSchema = z
  .object({ allowance: z.number().int(), used: z.number().int(), remaining: z.number().int() })
  .meta({ id: 'FreeScans' });

export const ConsentsSchema = z
  .object({
    termsVersion: z.string().nullable(),
    termsAt: IsoDateTimeSchema.nullable(),
    privacyVersion: z.string().nullable(),
    privacyAt: IsoDateTimeSchema.nullable(),
    healthDataAt: IsoDateTimeSchema.nullable(),
    marketingAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'Consents' });

export const MeSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    authProviders: z.array(z.enum(AUTH_PROVIDERS)),
    displayName: z.string().nullable(),
    locale: z.string(),
    timezone: z.string(),
    units: UnitsSchema,
    status: z.enum(USER_STATUSES),
    entitlement: EntitlementSchema,
    freeScans: FreeScansSchema,
    consents: ConsentsSchema,
    flags: z.object({ analyticsOptOut: z.boolean(), voiceReplies: z.boolean() }),
    experiments: z.record(z.string(), z.string()),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof MeSchema>;

export const UpdateMeRequestSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(50).nullable().optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Expected a locale like en-GB')
      .optional(),
    timezone: TimeZoneSchema.optional(),
    units: UnitsSchema.partial().strict().optional(),
    flags: z
      .strictObject({ analyticsOptOut: z.boolean().optional(), voiceReplies: z.boolean().optional() })
      .optional(),
    consents: z
      .strictObject({
        termsVersion: z.string().min(1).max(32).optional(),
        privacyVersion: z.string().min(1).max(32).optional(),
        healthData: z.literal(true).optional().describe('Explicit consent to process health data'),
        marketing: z.boolean().optional(),
      })
      .optional(),
  })
  .meta({ id: 'UpdateMeRequest' });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;

export const DeleteMeResponseSchema = z
  .object({ status: z.literal('pending_deletion'), purgeAfter: IsoDateTimeSchema })
  .meta({ id: 'DeleteMeResponse' });
export type DeleteMeResponse = z.infer<typeof DeleteMeResponseSchema>;
