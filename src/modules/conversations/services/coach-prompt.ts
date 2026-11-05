import { fillTemplate } from '../../content/content.loader';

/** The whole streamed reply must arrive in this time (a long answer in a script that costs many tokens needs more than a short one). */
export const COACH_TIMEOUT_MS = 25_000;
/** A rephrase of a quick-action template, in any script. */
export const REPHRASE_MAX_TOKENS = 300;

/** Used only when no `coach` prompt is stored (a database that was never seeded). */
export const FALLBACK_INSTRUCTIONS =
  "You are Milo, a nutrition and habit coach. Reply in the language of the user's message with clear, practical, personalised guidance in plain text. You are not a doctor.";

/**
 * The last user message of a coach request: the reply-language rule, then the prompt's dynamic context (the person's data,
 * the conversation summary and the message). Shared by the service and `pnpm coach:smoke`, so the smoke test sends exactly
 * what the app does.
 */
export function coachUserMessage(dynamicTemplate: string | undefined, directive: string, vars: Record<string, string | number | null | undefined>): string {
  return directive + fillTemplate(dynamicTemplate ?? '{{text}}', vars);
}
