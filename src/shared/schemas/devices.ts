import { z } from 'zod';
import { PLATFORMS } from '../enums';

export const RegisterDeviceRequestSchema = z
  .strictObject({
    deviceId: z.string().min(1).max(128),
    platform: z.enum(PLATFORMS),
    appVersion: z.string().max(32).optional(),
    pushToken: z.string().min(10).max(4096).nullable().optional().describe('FCM token; null removes it'),
  })
  .meta({ id: 'RegisterDeviceRequest' });
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

export const DeviceSchema = z
  .object({
    deviceId: z.string(),
    platform: z.enum(PLATFORMS),
    appVersion: z.string().nullable(),
    pushEnabled: z.boolean(),
    integrity: z.object({ verifiedAt: z.string().nullable(), keyId: z.string().nullable() }),
    lastSeenAt: z.string(),
  })
  .meta({ id: 'Device' });

export const AttestChallengeSchema = z.object({ challenge: z.string(), expiresInSec: z.number().int() }).meta({ id: 'AttestChallenge' });

export const AttestRequestSchema = z
  .strictObject({
    deviceId: z.string().min(1).max(128),
    keyId: z.string().min(10).max(200).describe('App Attest key id (base64)'),
    attestation: z.string().min(10).max(20000).describe('CBOR attestation object, base64'),
    challenge: z.string().min(10).max(200),
  })
  .meta({ id: 'AttestRequest' });
export type AttestRequest = z.infer<typeof AttestRequestSchema>;

export const ExportResponseSchema = z
  .object({ status: z.literal('queued'), exportId: z.string(), message: z.string() })
  .meta({ id: 'ExportResponse' });
