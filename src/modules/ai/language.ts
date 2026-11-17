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

const SCRIPTS = [
  ['Bengali', /\p{Script=Bengali}/gu],
  ['Latin', /\p{Script=Latin}/gu],
  ['Arabic', /\p{Script=Arabic}/gu],
  ['Devanagari', /\p{Script=Devanagari}/gu],
] as const;
export type MessageScript = (typeof SCRIPTS)[number][0];

/**
 * The script most of a message's letters are written in, or null when the message gives no clear signal (a number, "ok",
 * an emoji, a single short word, or a mix with no majority).
 */
export function messageScript(text: string): MessageScript | null {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  if (letters.length < 8 || words < 2) return null;
  for (const [name, re] of SCRIPTS) if ((text.match(re)?.length ?? 0) / letters.length >= 0.6) return name;
  return null;
}

// Small words only (food names are shared by both): "to" and "a" are left out because Banglish uses them too ("bolo to").
const ENGLISH_WORDS = new Set('i im i\'m me my you your it its is are was were be been am do does did have has had can could should would will what which how why when where who the an for of in on with and or but this that these those some any more less much many from at about after before if not eat ate eaten eating make made cook cooked give want need please today tonight now idea ideas suggest good healthy high low snack snacks dinner lunch breakfast meal meals'.split(' '));
const BANGLISH_WORDS = new Set('ami amar amake amra ajke aj ki kibhabe kivabe keno koto kototuku ta ti ekta duita dui ar aar na nai nei hobe hoy hoyeche kore korbo korsi korchi korechi korlam korte khabo khai khelam khaisi khaichi kheyechi khete khawa khabar khabe ache achhe achi chilo theke jonno er te ke bolo bolun bolen dao den apni apnar tumi tomar valo bhalo sokale sokal dupure dupur rate raat bikele ekhon kal kalke aro beshi besi kom lagbe chai pari parbo ei oi eta ota kono shob sob dim bhaji vaji mach maach murgi peyaj tel sobji shobji'.split(' '));

/**
 * English or Banglish for a message in Latin letters, from its small words; null when unsure (a dish name, a mix).
 * Counted by the server: after Banglish turns the model kept writing names in Banglish for an English question (16 Nov).
 */
export function latinLanguage(text: string): 'English' | 'Banglish' | null {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const en = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  const bn = words.filter((w) => BANGLISH_WORDS.has(w)).length;
  if (en >= 2 && en > 2 * bn) return 'English';
  if (bn >= 2 && bn > 2 * en) return 'Banglish';
  return null;
}

/**
 * The reply-language rule of the coach (owner request 5 Nov 2026): Milo answers in the language the person writes in, any
 * language, not only the app's. The app language is the fallback for messages with no language signal and for chip taps,
 * whose quick-action text is already written in it. It goes at the start of the dynamic context, like `languageDirective`.
 */
export function coachLanguageDirective(appLocale: LocaleCode, previousReply?: string | null, message?: string | null): string {
  const app = localeInfo(appLocale);
  const earlier = previousReply?.replace(/\s+/g, ' ').trim().slice(0, 120);
  const script = message ? messageScript(message) : null;
  const latin = script === 'Latin' ? latinLanguage(message!) : null;
  return [
    'Reply language rule (it wins over any language or spelling instruction above):',
    '- Reply in the same language and script as the user message below, whatever language it is. If they mix languages, use the one they use most.',
    '- A language typed in Latin letters is answered in Latin letters, never in its own script. Example: "ami ajke ki khabo" is Bangla in Latin letters (Banglish), so reply in Banglish with no Bengali script at all. The same goes for Hindi, Arabic or any other language typed in Latin letters.',
    // Counted by the server, because the model drifts to the script of its earlier replies or of the food names (live run, 16 Nov).
    ...(script === 'Latin'
      ? [
          '- The user message below is written in Latin letters, so every word you write is in Latin letters (no Bengali or other script), in the language of this message, not of earlier ones: an English message is answered in English, Bangla typed in Latin letters in Banglish.',
          ...(latin === 'English'
            ? ['- This message is in English: write every word in English, food and dish names too, even when earlier messages or your previous reply were in Banglish or Bangla.']
            : latin === 'Banglish'
              ? ['- This message is in Banglish (Bangla in Latin letters): write every word in Banglish, food and dish names too, with no Bengali script.']
              : []),
        ]
      : script
        ? [`- The user message below is written in ${script} script, so every word you write is in ${script} script, whatever script your earlier replies used.`]
        : []),
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
