import { createHash } from 'node:crypto';

/**
 * Rule 7 (R-10): rule-based scan reaction, no model call. Rules, keywords and line ids come from
 * content/milo/lines.v1.json `scanReactions` (product-owned; thresholds pending OQ-03/OQ-26).
 * Categories are evaluated in content order; the first whose rule holds wins. The variant is
 * SHA-256(scanId) first 8 hex digits mod the variant count, so a retry shows the same line.
 */
export interface ScanReactionContent {
  order: string[];
  keywords: { vegetable: string[]; sweet: string[] };
  categories: Record<string, { variants: { id: string }[] }>;
}

export interface ReactionItem {
  name: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  excluded?: boolean;
}

export interface ReactionInput {
  /** Items at 1× portion. */
  items: ReactionItem[];
  mode: 'full' | 'habits_only';
  /** Active target minus eaten today before this meal; null without a target. */
  remainingBefore: number | null;
  scanId: string;
}

export interface ReactionFacts {
  mealKcal: number;
  proteinShare: number;
  carbsShare: number;
  sweetShare: number;
  hasVegetable: boolean;
}

/**
 * Whole-word match for Latin keywords; other scripts (Bangla) match at the left edge only, because case endings attach to the
 * word (সবজির). Letters on either side of a Latin keyword, or before a Bangla stem, mean it is part of another word.
 */
function keywordPattern(words: string[]): RegExp {
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const clean = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
  const latin = clean.filter((w) => /^\p{ASCII}+$/u.test(w)).map(esc);
  const other = clean.filter((w) => !/^\p{ASCII}+$/u.test(w)).map(esc);
  const parts: string[] = [];
  if (latin.length) parts.push(`(?<![\\p{L}\\p{M}])(?:${latin.join('|')})(?![\\p{L}\\p{M}])`);
  if (other.length) parts.push(`(?<![\\p{L}\\p{M}])(?:${other.join('|')})`);
  return new RegExp(parts.join('|') || '(?!)', 'iu');
}

export function reactionFacts(content: ScanReactionContent, items: ReactionItem[]): ReactionFacts {
  const included = items.filter((i) => !i.excluded);
  const veg = keywordPattern(content.keywords.vegetable);
  const sweet = keywordPattern(content.keywords.sweet);
  const mealKcal = included.reduce((s, i) => s + i.kcal, 0);
  const share = (n: number) => (mealKcal > 0 ? n / mealKcal : 0);
  return {
    mealKcal,
    proteinShare: share(4 * included.reduce((s, i) => s + i.proteinG, 0)),
    carbsShare: share(4 * included.reduce((s, i) => s + i.carbsG, 0)),
    sweetShare: share(included.filter((i) => sweet.test(i.name)).reduce((s, i) => s + i.kcal, 0)),
    hasVegetable: included.some((i) => veg.test(i.name)),
  };
}

type Rule = (f: ReactionFacts, i: ReactionInput) => boolean;

/** The `when` prose of each category in lines.v1.json, as code. */
export const REACTION_RULES: Readonly<Record<string, Rule>> = {
  heavy: (f, i) => i.mode === 'full' && i.remainingBefore !== null && i.remainingBefore > 0 && f.mealKcal >= 0.6 * i.remainingBefore,
  sweet: (f) => f.sweetShare >= 0.5,
  balanced: (f) => f.hasVegetable && f.proteinShare >= 0.15 && f.proteinShare <= 0.35 && f.carbsShare >= 0.25,
  high_protein: (f) => f.proteinShare >= 0.3,
  light: (f) => f.mealKcal < 300,
  neutral: () => true,
};

export function reactionCategory(content: ScanReactionContent, input: ReactionInput): string | null {
  const facts = reactionFacts(content, input.items);
  for (const category of content.order) {
    const rule = REACTION_RULES[category];
    if (rule && content.categories[category]?.variants.length && rule(facts, input)) return category;
  }
  return null;
}

export function variantIndex(scanId: string, count: number): number {
  const hex = createHash('sha256').update(scanId).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % count;
}

/** The line id to show, e.g. `scan.reaction.balanced.2`, or null when content has no match. */
export function chooseReactionLine(content: ScanReactionContent, input: ReactionInput): string | null {
  const category = reactionCategory(content, input);
  if (!category) return null;
  const variants = content.categories[category]!.variants;
  return variants[variantIndex(input.scanId, variants.length)]!.id;
}
