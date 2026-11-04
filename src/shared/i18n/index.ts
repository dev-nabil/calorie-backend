import type { ErrorCode } from '../errors';
import { DEFAULT_LOCALE, type LocaleCode } from '../locales';
import { bn, bnErrors } from './bn';
import { en, enErrors, type MessageKey } from './en';
import type { ErrMsg, Msg } from './types';

export type { MessageKey } from './en';
export type { ErrMsg, Msg } from './types';
export type Params = Record<string, string | number>;
/** Turns a catalog key into text in one fixed language. Domain code receives one of these. */
export type Translator = (key: MessageKey, params?: Params) => string;

interface Catalog {
  messages: Record<MessageKey, Msg>;
  errors: Record<ErrorCode, ErrMsg>;
}

/** One entry per supported language (see shared/locales.ts). A missing key is a compile error. */
export const CATALOGS: Record<LocaleCode, Catalog> = {
  en: { messages: en, errors: enErrors },
  bn: { messages: bn, errors: bnErrors },
};

export function translatorFor(locale: LocaleCode): Translator {
  const messages = CATALOGS[locale]?.messages ?? CATALOGS[DEFAULT_LOCALE].messages;
  return (key, params = {}) => {
    const m = messages[key] ?? CATALOGS[DEFAULT_LOCALE].messages[key];
    return typeof m === 'function' ? m(params) : m;
  };
}

export const tr = translatorFor(DEFAULT_LOCALE);

/** Localised text for an error code, for non-default languages only (English keeps the specific message the code raised). */
export function localizedError(locale: LocaleCode, code: string, details: Record<string, unknown>): string | undefined {
  if (locale === DEFAULT_LOCALE) return undefined;
  const m = CATALOGS[locale]?.errors[code as ErrorCode];
  return m === undefined ? undefined : typeof m === 'function' ? m(details) : m;
}
