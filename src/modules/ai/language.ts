import { DEFAULT_LOCALE, localeInfo, type LocaleCode } from '../../shared/locales';

/**
 * The reply-language instruction every AI call carries (decision 0007). It goes at the start of the dynamic context, so the
 * cached prompt prefix is shared by all languages. English adds nothing: the prompts already say UK English.
 */
export function languageDirective(locale: LocaleCode): string {
  if (locale === DEFAULT_LOCALE) return '';
  const lang = localeInfo(locale);
  return [
    `Reply language: ${lang.aiName}.`,
    `Write every word the user will read (replies, questions, notes, tips, names of foods and dishes, clarifying questions) in ${lang.name} (${lang.native}), in its own script. This overrides any instruction above about UK English spelling.`,
    'Keep JSON keys, enum values, ids and schema field names exactly as the schema defines them (they are not translated). Keep units as the schema expects them. Use ASCII digits 0-9; the app shows them in the reader\'s numerals.',
    'Understand the user\'s messages in any language, including Banglish (Bangla written in Latin letters), and answer in the reply language.',
    '',
    '',
  ].join('\n');
}
