import { loadConfig } from '../../config/env';
import { SETTINGS, SETTING_GROUPS, SETTING_KEYS, settingDefault } from './settings.registry';

const dev = loadConfig({ MONGODB_URI: 'mongodb://x/y' });
const prod = { ...dev, isProduction: true };

describe('settings registry', () => {
  it('gives every setting a valid default, a known group and a description', () => {
    for (const key of SETTING_KEYS) {
      const def = SETTINGS[key];
      expect(def.group in SETTING_GROUPS).toBe(true);
      expect(def.description.length).toBeGreaterThan(10);
      for (const c of [dev, prod]) expect(def.schema.safeParse(settingDefault(key, c)).success).toBe(true);
    }
  });

  it('keeps the former environment defaults', () => {
    expect(settingDefault('scan.model', dev)).toBe('gemini-3.8-flash');
    expect(settingDefault('scan.dailyRequestCap', dev)).toBe(500);
    expect(settingDefault('scan.dailySpendUsd', dev)).toBe(1);
    expect(settingDefault('scan.thinkingLevel', dev)).toBe('low');
  });

  it('turns integrity checks on by default in production only', () => {
    expect(settingDefault('integrity.mode', dev)).toBe('allow');
    expect(settingDefault('integrity.mode', prod)).toBe('device');
    expect(settingDefault('integrity.enforce', prod)).toBe(true);
    expect(settingDefault('integrity.apple.allowDevelopment', prod)).toBe(false);
  });

  it('refuses values outside the schema', () => {
    expect(SETTINGS['scan.maxAttempts'].schema.safeParse(9).success).toBe(false);
    expect(SETTINGS['scan.model'].schema.safeParse('gpt-4o').success).toBe(false);
    expect(SETTINGS['scan.thinkingLevel'].schema.safeParse('max').success).toBe(false);
    expect(SETTINGS['admin.appUrl'].schema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(SETTINGS['admin.appUrl'].schema.parse('https://nouri.app/nouri-admin/')).toBe('https://nouri.app/nouri-admin');
    expect(SETTINGS['ai.model.plan'].schema.safeParse('').success).toBe(true);
  });
});
