/**
 * Default Gemini models per job. The admin settings `ai.model.<feature>` (and, for plan tips and the live voice,
 * GEMINI_PLAN_MODEL / GEMINI_REALTIME_MODEL) win over these. Prices live in gemini-pricing.ts.
 */
/** Extraction, meal parse, coach chat, summaries, plan tips and the moderation check: the cheapest current text model. */
export const DEFAULT_TEXT_MODEL = 'gemini-3.5-flash-lite';
/** Photo and nutrition-label scans: full Flash model for best food recognition and portion accuracy. */
export const DEFAULT_SCAN_MODEL = 'gemini-3.8-flash';
export const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
export const DEFAULT_REALTIME_MODEL = 'gemini-3.8-live';
