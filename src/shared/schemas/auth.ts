import { z } from 'zod';
import { AUTH_PROVIDERS, PLATFORMS } from '../enums';
import { MeSchema } from './me';
import { IsoDateTimeSchema } from './common';

export const EmailSchema = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

export const DeviceInfoSchema = z
  .strictObject({
    deviceId: z.string().min(1).max(128),
    platform: z.enum(PLATFORMS),
    appVersion: z.string().max(32).optional(),
  })
  .meta({ id: 'DeviceInfo' });
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const EmailStartRequestSchema = z
  .strictObject({ email: EmailSchema })
  .meta({ id: 'EmailStartRequest' });
export type EmailStartRequest = z.input<typeof EmailStartRequestSchema>;

export const EmailStartResponseSchema = z
  .object({ sent: z.literal(true), expiresInSec: z.number().int(), resendAfterSec: z.number().int() })
  .meta({ id: 'EmailStartResponse' });
export type EmailStartResponse = z.infer<typeof EmailStartResponseSchema>;

export const EmailVerifyRequestSchema = z
  .strictObject({
    email: EmailSchema,
    code: z.string().regex(/^\d{6}$/, 'Expected 6 digits'),
    device: DeviceInfoSchema.optional(),
  })
  .meta({ id: 'EmailVerifyRequest' });
export type EmailVerifyRequest = z.input<typeof EmailVerifyRequestSchema>;

export const GoogleSignInRequestSchema = z
  .strictObject({ idToken: z.string().min(10).max(8192), device: DeviceInfoSchema.optional() })
  .meta({ id: 'GoogleSignInRequest' });
export type GoogleSignInRequest = z.infer<typeof GoogleSignInRequestSchema>;

export const AppleSignInRequestSchema = z
  .strictObject({
    identityToken: z.string().min(10).max(8192),
    nonce: z.string().max(256).optional().describe('Raw nonce; its SHA-256 must match the token nonce'),
    displayName: z.string().trim().min(1).max(50).optional().describe('Only sent by Apple on first sign-in'),
    device: DeviceInfoSchema.optional(),
  })
  .meta({ id: 'AppleSignInRequest' });
export type AppleSignInRequest = z.infer<typeof AppleSignInRequestSchema>;

export const RefreshRequestSchema = z
  .strictObject({ refreshToken: z.string().min(20).max(512) })
  .meta({ id: 'RefreshRequest' });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = z
  .strictObject({
    refreshToken: z.string().min(20).max(512).optional(),
    allDevices: z.boolean().optional().describe('Sign out everywhere'),
  })
  .meta({ id: 'LogoutRequest' });
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const AuthSessionSchema = z
  .object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string(),
    accessTokenExpiresAt: IsoDateTimeSchema,
    refreshToken: z.string(),
    refreshTokenExpiresAt: IsoDateTimeSchema,
    isNewUser: z.boolean(),
    provider: z.enum(AUTH_PROVIDERS),
    user: MeSchema,
  })
  .meta({ id: 'AuthSession' });
export type AuthSession = z.infer<typeof AuthSessionSchema>;
