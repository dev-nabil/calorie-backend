/**
 * Supported app languages (decision 0007). Adding a language: one entry here, a catalog in
 * `shared/i18n/<code>.ts`, a rule pack in `domain/plan-narrative/locales/<code>.ts`, translated content
 * files, and the Flutter registry. Codes are ISO 639-1 language codes; `tag` is what the user record stores.
 */
export interface LocaleInfo {
  readonly code: string;
  readonly tag: string;
  readonly name: string;
  readonly native: string;
  /** How the model is told to write (names the language and the register). */
  readonly aiName: string;
}

export const LOCALES = [
  { code: 'en', tag: 'en-GB', name: 'English', native: 'English', aiName: 'British English (UK spelling)' },
  {
    code: 'bn',
    tag: 'bn-BD',
    name: 'Bangla',
    native: 'বাংলা',
    aiName: 'Bangla (বাংলা) in Bengali script, standard colloquial Bangladeshi usage (চলিত ভাষা), polite "আপনি" register',
  },
] as const satisfies readonly LocaleInfo[];

export type LocaleCode = (typeof LOCALES)[number]['code'];
export const DEFAULT_LOCALE: LocaleCode = 'en';
export const LOCALE_CODES: readonly LocaleCode[] = LOCALES.map((l) => l.code);

const byCode = new Map<string, LocaleInfo>(LOCALES.map((l) => [l.code, l]));

export function localeInfo(code: LocaleCode): LocaleInfo {
  return byCode.get(code)!;
}

/** `bn`, `bn-BD`, `bn_BD`, `BN` -> `bn`; null when the language is not supported. */
export function parseLocale(input: string | null | undefined): LocaleCode | null {
  if (!input) return null;
  const lang = input.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return byCode.has(lang) ? (lang as LocaleCode) : null;
}

/** Language codes of an Accept-Language header, best first (q-values, wildcards ignored). */
export function acceptLanguageCodes(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = Number(params.map((p) => p.trim()).find((p) => p.startsWith('q='))?.slice(2) ?? 1);
      return { tag: (tag ?? '').trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((x) => x.tag);
}

/** First supported language among the candidates (strings or Accept-Language lists), else the default. */
export function resolveLocale(...candidates: Array<string | null | undefined>): LocaleCode {
  for (const c of candidates) {
    for (const tag of c?.includes(',') ? acceptLanguageCodes(c) : [c]) {
      const hit = parseLocale(tag);
      if (hit) return hit;
    }
  }
  return DEFAULT_LOCALE;
}

/** The tag stored on the user record for a language (`bn` -> `bn-BD`). */
export function localeTag(code: LocaleCode): string {
  return localeInfo(code).tag;
}
