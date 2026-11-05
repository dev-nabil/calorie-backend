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

/**
 * The reply-language rule of the coach (owner request 5 Nov 2026): Milo answers in the language the person writes in, any
 * language, not only the app's. The app language is the fallback for messages with no language signal and for chip taps,
 * whose quick-action text is already written in it. It goes at the start of the dynamic context, like `languageDirective`.
 */
export function coachLanguageDirective(appLocale: LocaleCode, previousReply?: string | null): string {
  const app = localeInfo(appLocale);
  const earlier = previousReply?.replace(/\s+/g, ' ').trim().slice(0, 120);
  return [
    'Reply language rule (it wins over any language or spelling instruction above):',
    '- Reply in the same language and script as the user message below, whatever language it is. If they mix languages, use the one they use most.',
    '- A language typed in Latin letters is answered in Latin letters, never in its own script. Example: "ami ajke ki khabo" is Bangla in Latin letters (Banglish), so reply in Banglish with no Bengali script at all. The same goes for Hindi, Arabic or any other language typed in Latin letters.',
    earlier
      ? `- If the message gives no language signal (a number, a name, "ok", an emoji, a food word shared by many languages), reply in the same language and the same script (Bengali script stays Bengali script) as your previous reply, which began: "${earlier}". Do not switch because of the app’s language.`
      : '- If the message gives no language signal (a number, a name, "ok", an emoji, a food word shared by many languages), use the fallback language.',
    // With an earlier reply it decides (the opening greeting is in the app language anyway); a second candidate only competes with it.
    ...(earlier ? [] : [`- Fallback language: ${app.aiName}.`]),
    '- Never switch language inside a reply, and never mention which language you detected.',
    '- Use ASCII digits 0-9 and keep units as the context gives them.',
    '',
    '',
  ].join('\n');
}
