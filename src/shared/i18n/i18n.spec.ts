import { ERROR_CODES } from '../errors';
import { LOCALE_CODES } from '../locales';
import { CATALOGS, localizedError, translatorFor } from './index';
import { type MessageKey } from './en';
import { en } from './en';

const SAMPLE = { n: 12, unit: 'weeks', a: 10, b: '12 weeks', verb: 'losing', verbNoun: 'losing', change: '8', eta: 'about 10 weeks', req: '6 months', safeMin: '10 weeks', maxPace: '0.8', bmr: 1500, activity: 'x', factor: 1.4, tdee: 2100, pct: 10, kcal: 1900, floor: 1200, kcalPerKg: '7,700', code: '123456' };
const BENGALI = /[ঀ-৿]/;
const BENGALI_DIGITS = /[০-৯]/;

describe('catalogs', () => {
  it('has a catalog for every supported language, with every key', () => {
    for (const code of LOCALE_CODES) {
      expect(Object.keys(CATALOGS[code].messages).sort()).toEqual(Object.keys(en).sort());
      expect(Object.keys(CATALOGS[code].errors).sort()).toEqual(Object.values(ERROR_CODES).sort());
    }
  });

  it('every message renders to non-empty text with no leftover placeholders or "undefined"', () => {
    for (const code of LOCALE_CODES) {
      const tr = translatorFor(code);
      for (const key of Object.keys(en) as MessageKey[]) {
        const text = tr(key, SAMPLE);
        expect(text.trim().length).toBeGreaterThan(key.startsWith('plan.verb.') ? 1 : 3);
        expect(text).not.toMatch(/undefined|\[object|\$\{|NaN/);
      }
    }
  });

  it('Bangla texts are in Bangla script, use the danda, and keep digits ASCII (the app localises them)', () => {
    const tr = translatorFor('bn');
    for (const key of Object.keys(en) as MessageKey[]) {
      const text = tr(key, SAMPLE);
      if (key.startsWith('email.otp.subject')) continue;
      expect(text).toMatch(BENGALI);
      expect(text).not.toMatch(BENGALI_DIGITS);
    }
    for (const msg of Object.values(CATALOGS.bn.errors)) {
      const text = typeof msg === 'function' ? msg({ min: 1000, max: 2000 }) : msg;
      expect(text).toMatch(BENGALI);
      expect(text).not.toMatch(BENGALI_DIGITS);
    }
  });

  it('the English plural logic still reads naturally', () => {
    const tr = translatorFor('en');
    expect(tr('plan.duration', { n: 1, unit: 'weeks' })).toBe('1 week');
    expect(tr('plan.duration', { n: 12, unit: 'weeks' })).toBe('12 weeks');
    expect(tr('plan.duration', { n: 6, unit: 'months' })).toBe('6 months');
    expect(tr('plan.duration', { n: 1.5, unit: 'years' })).toBe('1.5 years');
  });

  it('error messages: English keeps the raised message, other languages use the catalog', () => {
    expect(localizedError('en', 'OTP_INVALID', {})).toBeUndefined();
    expect(localizedError('bn', 'OTP_INVALID', {})).toMatch(BENGALI);
    expect(localizedError('bn', 'PLAN_OUT_OF_BOUNDS', { min: 1200, max: 2500 })).toContain('1200 থেকে 2500');
    expect(localizedError('bn', 'NO_SUCH_CODE', {})).toBeUndefined();
  });
});
