import { fillTemplate } from '../../content/content.loader';

/** The whole streamed reply must arrive in this time (a long answer in a script that costs many tokens needs more than a short one). */
export const COACH_TIMEOUT_MS = 25_000;
/** A rephrase of a quick-action template, in any script. */
export const REPHRASE_MAX_TOKENS = 300;

/** Used only when no `coach` prompt is stored (a database that was never seeded). */
export const FALLBACK_INSTRUCTIONS =
  "You are Milo, a nutrition and habit coach. Reply in the language of the user's message with clear, practical, personalised guidance in plain text. You are not a doctor.";

/** Keys a model has been seen to wrap the reply in, most specific first. */
const WRAPPER_KEYS = ['reply', 'text', 'message', 'stream', 'content', 'answer'] as const;

/** True when a reply starts like a wrapper (JSON or a code fence) instead of the words themselves. */
export function looksWrapped(text: string): boolean {
  return /^\s*(\{|```)/.test(text);
}

function pickText(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || depth > 2) return null;
  const obj = value as Record<string, unknown>;
  for (const k of WRAPPER_KEYS) {
    const hit = typeof obj[k] === 'string' ? (obj[k] as string).trim() : null;
    if (hit) return hit;
  }
  for (const v of Object.values(obj)) {
    const hit = typeof v === 'object' ? pickText(v, depth + 1) : null;
    if (hit) return hit;
  }
  return null;
}

/**
 * The reply as the person should read it. The model is told to write plain text, but it sometimes wraps the answer in JSON
 * (`{"stream": "...", "storedMessage": {...}}`) or a code fence; this unwraps it. Plain text comes back unchanged.
 */
export function plainCoachReply(raw: string): string {
  const text = raw.trim();
  if (!looksWrapped(text)) return raw;
  const unfenced = text.replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  if (!unfenced.startsWith('{')) return unfenced;
  try {
    return pickText(JSON.parse(unfenced)) ?? unfenced;
  } catch {
    // Cut short or not quite JSON: take the first string value of a known key.
    for (const k of WRAPPER_KEYS) {
      const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(unfenced);
      if (m?.[1]) {
        try {
          return (JSON.parse(`"${m[1]}"`) as string).trim();
        } catch {
          return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
        }
      }
    }
    return unfenced;
  }
}

/**
 * The last user message of a coach request: the reply-language rule, then the prompt's dynamic context (the person's data,
 * the conversation summary and the message). Shared by the service and `pnpm coach:smoke`, so the smoke test sends exactly
 * what the app does.
 */
export function coachUserMessage(dynamicTemplate: string | undefined, directive: string, vars: Record<string, string | number | null | undefined>): string {
  return directive + fillTemplate(dynamicTemplate ?? '{{text}}', vars);
}
