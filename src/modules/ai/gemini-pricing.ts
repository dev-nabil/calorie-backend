/** Paid-tier standard prices, USD per million tokens, from https://ai.google.dev/gemini-api/docs/pricing (read 4 Nov 2026). */
export interface GeminiPrice {
  inputPerM: number;
  cachedPerM: number;
  /** Thinking tokens bill at this rate too. */
  outputPerM: number;
}

const PRICES: Record<string, GeminiPrice> = {
  // Standard paid prices through 31 Dec 2026; Google doubles the two below from 1 Jan 2027, when these numbers need updating.
  'gemini-3.8-flash': { inputPerM: 0.75, cachedPerM: 0.075, outputPerM: 3.75 },
  'gemini-3.6-flash': { inputPerM: 0.75, cachedPerM: 0.075, outputPerM: 3.75 },
  'gemini-3.5-flash-lite': { inputPerM: 0.3, cachedPerM: 0.03, outputPerM: 2.5 },
  'gemini-3.1-flash-lite': { inputPerM: 0.25, cachedPerM: 0.025, outputPerM: 1.5 },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, cachedPerM: 0.01, outputPerM: 0.4 },
};

export const knownGeminiPrice = (model: string): GeminiPrice | null => PRICES[model] ?? null;

export interface GeminiTokens {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

export function geminiCostUsd(u: GeminiTokens, p: GeminiPrice): number {
  const fresh = Math.max(0, u.inputTokens - u.cachedTokens);
  return (fresh * p.inputPerM + u.cachedTokens * p.cachedPerM + (u.outputTokens + u.thoughtTokens) * p.outputPerM) / 1_000_000;
}
