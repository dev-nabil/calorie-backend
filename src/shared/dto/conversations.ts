import { z } from 'zod';
import { MILO_STATES } from '../enums';
import { IsoDateTimeSchema } from './common';
import { AnswerValueSchema } from './onboarding';

export const QUICK_ACTIONS = ['explain_macros', 'suggest_snack', 'review_day'] as const;

export const CreateConversationRequestSchema = z
  .strictObject({ type: z.enum(['onboarding', 'coach']) })
  .meta({ id: 'CreateConversationRequest' });
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const TurnRequestSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(1000).optional().describe('Typed text or the on-device transcript'),
    chipIndex: z.number().int().min(0).max(20).optional().describe('Index into the chips of the last reply'),
    inputMethod: z.enum(['typed', 'voice', 'chip']),
    quickAction: z.enum(QUICK_ACTIONS).optional().describe('Coach only'),
  })
  .refine((b) => b.text !== undefined || b.chipIndex !== undefined || b.quickAction !== undefined, 'Send text, chipIndex or quickAction')
  .meta({ id: 'TurnRequest' });
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

export const ConfirmRequestSchema = z
  .strictObject({ accept: z.boolean().describe('Yes saves the noted answers; false (Change) discards them') })
  .meta({ id: 'ConfirmRequest' });
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;

export const ExtractedAnswerSchema = z
  .object({ questionId: z.string(), value: AnswerValueSchema, confidence: z.number(), held: z.boolean().describe('Provisional, saved later') })
  .meta({ id: 'ExtractedAnswer' });

export const MiloReplySchema = z
  .object({
    conversationId: z.string(),
    messageId: z.string().nullable(),
    reply: z.string().describe('Milo line: short ack + canonical question line'),
    miloState: z.enum(MILO_STATES),
    turnId: z.string().nullable(),
    questionIds: z.array(z.string()).describe('Open questions of this turn (onboarding)'),
    chips: z.array(z.object({ index: z.number().int(), label: z.string() })),
    extracted: z.array(ExtractedAnswerSchema).describe('Answers this turn saved or held, chips included; the app mirrors them'),
    skipped: z.array(z.string()).optional().describe('Questions this turn saved as skipped (onboarding)'),
    needsConfirmation: z.boolean(),
    done: z.boolean().describe('Onboarding walk finished: open Review, then POST /onboarding/complete'),
    quickAction: z.enum(QUICK_ACTIONS).nullable(),
    replyAudio: z.string().nullable(),
    caption: z.string().nullable().describe('Degraded-mode caption under a templated answer (coach.qa.degraded.*)'),
    moderation: z.enum(['flagged']).optional().describe('Set when the input was refused by moderation (no model call)'),
  })
  .meta({ id: 'MiloReply' });
export type MiloReply = z.infer<typeof MiloReplySchema>;

export const ConversationSchema = z
  .object({
    id: z.string(),
    type: z.enum(['onboarding', 'coach']),
    status: z.enum(['active', 'completed']),
    createdAt: IsoDateTimeSchema,
    opening: MiloReplySchema,
  })
  .meta({ id: 'Conversation' });
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageSchema = z
  .object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), inputMethod: z.string().nullable(), createdAt: IsoDateTimeSchema })
  .meta({ id: 'Message' });

export const MessageListSchema = z.object({ items: z.array(MessageSchema), nextCursor: z.string().nullable() }).meta({ id: 'MessageList' });

/** Realtime voice (Gemini Live API over a WebSocket): the app talks to Google directly with this short-lived token. */
export const RealtimeSessionSchema = z
  .object({
    clientSecret: z.string().describe('Ephemeral Gemini auth token (auth_tokens/...). One use, valid only to open the call; never store it'),
    expiresAt: IsoDateTimeSchema.describe('Open the Live WebSocket before this time'),
    model: z.string(),
    voice: z.string(),
    callsUrl: z.string().describe('Live API WebSocket endpoint: connect to callsUrl + "?access_token=" + clientSecret, then send {"setup":{"model":"models/<model>"}}. Instructions, tools, voice and turn detection are locked into the token'),
    maxSeconds: z.number().int().describe('The app ends the session after this long'),
    sessionKind: z.enum(['start', 'resume']).describe('resume: the conversation was already under way'),
  })
  .meta({ id: 'RealtimeSession' });
export type RealtimeSession = z.infer<typeof RealtimeSessionSchema>;

export const REALTIME_TOOLS = ['record_answers', 'confirm_answers'] as const;

/** A tool call the live model made, forwarded by the app. `callId` is the idempotency key of the call. */
export const RealtimeToolRequestSchema = z
  .strictObject({
    callId: z.string().trim().min(1).max(100),
    name: z.enum(REALTIME_TOOLS),
    arguments: z.record(z.string(), z.unknown()).describe('record_answers: {answers:[{questionId,value,confidence}]}; confirm_answers: {accept}'),
  })
  .meta({ id: 'RealtimeToolRequest' });
export type RealtimeToolRequest = z.infer<typeof RealtimeToolRequestSchema>;

export const RealtimeToolResultSchema = z
  .object({
    output: z.string().describe('JSON text to return to the model as the function response'),
    reply: MiloReplySchema.describe('The same state as a normal turn: saved answers to mirror, chips, confirmation, done. Its `reply` text is a hint; the model speaks in its own words'),
  })
  .meta({ id: 'RealtimeToolResult' });
export type RealtimeToolResult = z.infer<typeof RealtimeToolResultSchema>;

const TokenCount = z.number().int().min(0).max(5_000_000);
/** Token counts the app read from the `usageMetadata` messages of a session (the call does not pass through the server). */
export const RealtimeUsageRequestSchema = z
  .strictObject({
    inputAudioTokens: TokenCount,
    inputTextTokens: TokenCount,
    cachedInputTokens: TokenCount,
    outputAudioTokens: TokenCount,
    outputTextTokens: TokenCount,
  })
  .meta({ id: 'RealtimeUsageRequest' });
export type RealtimeUsageRequest = z.infer<typeof RealtimeUsageRequestSchema>;

/** Raw extraction output (content/prompts/onboarding-extract.v1.md), validated loosely then post-processed. */
export const ExtractionOutputSchema = z.object({
  answers: z.array(z.object({ questionId: z.string(), value: z.unknown(), confidence: z.number() })),
  ack: z.string().max(400),
  clarify: z.string().max(200).nullable(),
  userQuestion: z.string().max(200).nullable(),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

export const SpeechRequestSchema = z
  .strictObject({ messageId: z.string().regex(/^[a-f0-9]{24}$/).describe('An assistant message of your coach conversation') })
  .meta({ id: 'SpeechRequest' });
export const SpeechResponseSchema = z.object({ url: z.string(), cached: z.boolean() }).meta({ id: 'SpeechResponse' });
export const AudioManifestSchema = z
  .object({ version: z.number().int().nullable(), locale: z.string().describe('Language of the audio (en, bn). Empty `lines` = none pre-rendered in this language: speak on the device'), lines: z.record(z.string(), z.string()).describe('lineId → signed URL of tts/[<lang>/]{version}/{lineId}.wav') })
  .meta({ id: 'AudioManifest' });
