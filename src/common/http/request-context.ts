import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_LOCALE, resolveLocale, type LocaleCode } from '../../shared/locales';

interface Ctx {
  origin: string;
  locale: LocaleCode;
}
const store = new AsyncLocalStorage<Ctx>();

/**
 * Remembers the origin the client used (e.g. http://10.0.2.2:3000) so local URLs work from emulators, and the language
 * of the request: `?locale=` -> `X-App-Locale` -> `Accept-Language` -> English (decision 0007). Background work has no
 * request: it passes the user's language explicitly (`runWithLocale`).
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const query = typeof req.query.locale === 'string' ? req.query.locale : undefined;
  const locale = resolveLocale(query, req.get('x-app-locale'), req.get('accept-language'));
  res.vary('Accept-Language');
  res.vary('X-App-Locale');
  store.run({ origin: `${req.protocol}://${req.get('host') ?? 'localhost'}`, locale }, next);
}

export function requestOrigin(): string | undefined {
  return store.getStore()?.origin;
}

/** Language of the current request, or English outside a request. */
export function requestLocale(): LocaleCode {
  return store.getStore()?.locale ?? DEFAULT_LOCALE;
}

/** Runs `fn` with an explicit language (jobs, push reminders, pre-rendering). */
export function runWithLocale<T>(locale: LocaleCode, fn: () => T): T {
  return store.run({ origin: store.getStore()?.origin ?? '', locale }, fn);
}
