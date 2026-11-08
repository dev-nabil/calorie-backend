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
  store.run({ origin: `${clientProtocol(req)}://${req.get('host') ?? 'localhost'}`, locale }, next);
}

/**
 * The scheme the client used. Behind a proxy that ends TLS (Render, Cloud Run) `req.protocol` is `http` unless
 * trust proxy is set, and an `http://` upload URL then gets a 307 redirect the app's PUT does not follow. The
 * origin only shapes URLs returned to this same client, so the header needs no proxy trust.
 */
function clientProtocol(req: Request): string {
  const forwarded = req.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol;
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
