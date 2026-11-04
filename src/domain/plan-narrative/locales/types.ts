/**
 * Everything the narrative check needs to know about one language (decision 0007). The English pack is the
 * reference; a new language adds a file here and an entry in `index.ts`. Regexes run on text with digits already
 * normalised to ASCII, so a pack never has to match Bengali (or other) numerals.
 */
export interface RulePack {
  /** A number followed by a calorie, macro, weight, percentage or time unit. */
  numberWithUnit: RegExp;
  /** Figures in words that look like a target ("fourteen hundred calories"). */
  spelledFigure: RegExp;
  bannedWording: RegExp;
  /** Cutting out a whole food group, daily weighing. */
  restriction: RegExp;
  fastingPlan: RegExp;
  medicalClaim: RegExp;
  /** A phrase that directly says "leave it out"; only this excuses naming an avoided food. */
  safeCue: RegExp;
  /** Words (stems) that point at each allergy option id of q36. */
  allergens: Record<string, string[]>;
  /** What each eating pattern (q11 id) rules out. */
  patterns: Record<string, string[]>;
}
