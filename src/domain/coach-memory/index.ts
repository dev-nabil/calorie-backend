/**
 * "What Milo knows about me" (Milo buddy, decision 0016). Pure: cleaning memories, choosing the few that matter for one
 * message, and keeping temporary or unsafe statements out. The person's own words are data for the model, never rules.
 */
import { BUDDY_LIMITS, type MemoryCategory } from '../../shared';

export interface MemoryLike {
  id: string;
  text: string;
  category: MemoryCategory;
  sensitive: boolean;
  updatedAt: Date | string;
}

/** One line, NFC, no control characters, at most the limit; null when nothing is left. */
export function cleanMemoryText(raw: string): string | null {
  const t = String(raw ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || [...t].length > BUDDY_LIMITS.memoryMaxChars) return null;
  return t;
}

/** Words that mark a statement about now, not a lasting fact ("today", "right now", "আজ"). */
const TEMPORARY = /\b(today|tonight|right now|this (morning|evening|afternoon|week)|at the moment|currently|just now|yesterday)\b|আজ|এখন|গতকাল|এই মুহূর্তে/iu;
/** Health topics that need the person's explicit consent before they are kept (contract §6). */
const SENSITIVE = /\b(diabet\w*|pregnan\w*|breastfeed\w*|medication|medicine|insulin|tablet|pill|blood pressure|hypertension|cholesterol|kidney|liver|thyroid|pcos|ibs|celiac|coeliac|eating disorder|anorexi\w*|bulimi\w*|binge\w*|depress\w*|anxiety|surgery|cancer|heart|allerg\w*|intoleran\w*|symptom\w*|diagnos\w*)\b|ডায়াবেটিস|গর্ভ|ওষুধ|ইনসুলিন|প্রেশার|কোলেস্টেরল|কিডনি|থাইরয়েড|অ্যালার্জি|এলার্জি/iu;

export const looksTemporary = (text: string): boolean => TEMPORARY.test(text);
/** The model's flag or the server's word list: either one makes it sensitive (consent needed). */
export const isSensitive = (text: string, category: MemoryCategory, modelSaid: boolean): boolean => modelSaid || category === 'health' || SENSITIVE.test(text);

/** Same memory, ignoring case, spacing and punctuation. */
export const memoryKey = (text: string): string => text.toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

const words = (t: string): Set<string> => new Set(memoryKey(t).split(' ').filter((w) => [...w].length >= 3));

/**
 * The few memories that matter for one message: those sharing a word with it first, then the newest; preferences and
 * dislikes always count for food questions. At most `max` (8), never the whole list when it is long.
 */
export function relevantMemories<T extends MemoryLike>(all: readonly T[], message: string, opts: { food?: boolean; max?: number } = {}): T[] {
  const max = opts.max ?? 8;
  if (all.length <= max) return [...all];
  const q = words(message);
  const score = (m: T): number => {
    let s = 0;
    for (const w of words(m.text)) if (q.has(w)) s += 3;
    if (opts.food && (m.category === 'preference' || m.category === 'dislike')) s += 2;
    return s;
  };
  return [...all]
    .map((m) => ({ m, s: score(m), t: new Date(m.updatedAt).getTime() }))
    .sort((a, b) => b.s - a.s || b.t - a.t)
    .slice(0, max)
    .map((x) => x.m);
}
