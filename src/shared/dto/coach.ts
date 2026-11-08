import { z } from 'zod';
import { COACH_NOTE_MAX_CHARS, COACH_NOTES_MAX } from '../constants';
import { COACH_TONES } from '../enums';

/** Milo's style and memory (Plus). Stored per user; the coach uses it only while Plus is active. */
export const CoachPreferencesSchema = z
  .object({
    tone: z.enum(COACH_TONES).describe('warm (default, no extra rule) | cheerful | calm | direct'),
    notes: z.array(z.string()).describe('Things the person asked Milo to remember, in their own words'),
  })
  .meta({ id: 'CoachPreferences' });
export type CoachPreferences = z.infer<typeof CoachPreferencesSchema>;

/** Full replace (PUT), so repeating it is harmless. Notes are trimmed; whitespace inside is collapsed and duplicates are dropped. */
export const PutCoachPreferencesRequestSchema = z
  .strictObject({
    tone: z.enum(COACH_TONES),
    notes: z
      .array(z.string().trim().min(1).max(COACH_NOTE_MAX_CHARS))
      .max(COACH_NOTES_MAX)
      .describe(`At most ${COACH_NOTES_MAX} notes of 1 to ${COACH_NOTE_MAX_CHARS} characters each (after trimming); duplicates are dropped`),
  })
  .meta({ id: 'PutCoachPreferencesRequest' });
export type PutCoachPreferencesRequest = z.infer<typeof PutCoachPreferencesRequestSchema>;
