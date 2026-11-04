import { acceptLanguageCodes, DEFAULT_LOCALE, LOCALE_CODES, localeTag, parseLocale, resolveLocale } from './locales';

describe('locales', () => {
  it('lists English and Bangla, English first', () => {
    expect(LOCALE_CODES).toEqual(['en', 'bn']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(localeTag('bn')).toBe('bn-BD');
    expect(localeTag('en')).toBe('en-GB');
  });

  it.each([
    ['bn', 'bn'],
    ['bn-BD', 'bn'],
    ['bn_BD', 'bn'],
    ['BN', 'bn'],
    ['en-GB', 'en'],
    ['en_US', 'en'],
  ])('parses %s as %s', (input, code) => expect(parseLocale(input)).toBe(code));

  it.each([[''], [null], [undefined], ['fr'], ['hi-IN'], ['*']])('does not know %p', (input) => expect(parseLocale(input as string)).toBeNull());

  it('reads Accept-Language by quality and skips unsupported languages', () => {
    expect(acceptLanguageCodes('fr-FR, bn;q=0.8, en;q=0.5, *;q=0.1')).toEqual(['fr-FR', 'bn', 'en']);
    expect(resolveLocale('fr-FR, bn;q=0.8, en;q=0.5')).toBe('bn');
    expect(resolveLocale('en;q=0.4, bn;q=0.9')).toBe('bn');
    expect(resolveLocale('fr, de')).toBe('en');
  });

  it('prefers the first supported candidate in order (query, app header, Accept-Language)', () => {
    expect(resolveLocale(undefined, 'bn-BD', 'en')).toBe('bn');
    expect(resolveLocale('en', 'bn-BD', 'bn')).toBe('en');
    expect(resolveLocale('fr', null, 'bn')).toBe('bn');
    expect(resolveLocale()).toBe('en');
  });
});
