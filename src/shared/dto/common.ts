import { z } from 'zod';
import { isValidDayKey, isValidTimeZone } from '../time';

export const DayKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine(isValidDayKey, 'Not a calendar date')
  .describe('Day key YYYY-MM-DD in the entry timezone');

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'Unknown IANA timezone')
  .describe('IANA timezone, e.g. Europe/London');

export const ObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'Expected an id');
export const UuidSchema = z.uuid();
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()),
    }),
  })
  .meta({ id: 'ErrorResponse' });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    role: z.enum(['api', 'worker']),
    version: z.string(),
    uptimeSec: z.number(),
    checks: z.object({
      mongo: z.enum(['up', 'down']),
      redis: z.enum(['up', 'down', 'memory']),
    }),
  })
  .meta({ id: 'HealthResponse' });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
