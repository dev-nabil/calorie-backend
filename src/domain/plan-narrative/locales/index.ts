import { DEFAULT_LOCALE, type LocaleCode } from '../../../shared/locales';
import { bnPack } from './bn';
import { enPack } from './en';
import type { RulePack } from './types';

export type { RulePack } from './types';

/** One entry per supported language. The compiler makes a missing entry an error. */
export const RULE_PACKS: Record<LocaleCode, RulePack> = { en: enPack, bn: bnPack };

/** The English pack always applies (models mix in English words); the language's own pack is added. */
export function packsFor(locale: LocaleCode): RulePack[] {
  return locale === DEFAULT_LOCALE ? [enPack] : [enPack, RULE_PACKS[locale]];
}

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
/** Bengali numerals to ASCII, so figure checks cannot be bypassed by writing "১৮০০ ক্যালরি". */
export function normaliseDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => String(BENGALI_DIGITS.indexOf(d)));
}
