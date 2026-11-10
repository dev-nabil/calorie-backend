import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { ApiError } from '../../common/errors/api-error';
import { ERROR_CODES } from '../../shared';
import { knownGeminiPrice } from '../ai/gemini-pricing';
import { AppConfigService } from '../content/app-config.service';
import { SETTINGS, SETTING_GROUPS, SETTING_KEYS, isSettingKey, settingDefault, type SettingKey, type SettingValue } from './settings.registry';

export interface SettingView {
  key: SettingKey;
  group: keyof typeof SETTING_GROUPS;
  label: string;
  description: string;
  kind: (typeof SETTINGS)[SettingKey]['kind'];
  options: string[] | null;
  min: number | null;
  max: number | null;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * Typed access to the admin settings in app_config (registry: settings.registry.ts). Reads are cached
 * for 30 s by AppConfigService, so a change reaches every instance within half a minute. A stored value
 * that no longer passes its schema is ignored (default used) and logged, never thrown at a caller.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: AppConfigService,
  ) {}

  defaultOf<K extends SettingKey>(key: K): SettingValue<K> {
    return settingDefault(key, this.config);
  }

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const stored = await this.store.get<unknown>(key, undefined);
    if (stored === undefined || stored === null) return this.defaultOf(key);
    const parsed = SETTINGS[key].schema.safeParse(stored);
    if (parsed.success) return parsed.data as SettingValue<K>;
    this.logger.warn({ key }, 'stored setting is invalid: using the default');
    return this.defaultOf(key);
  }

  /** Several settings in one call, e.g. `const { a, b } = await settings.many(['a', 'b'])`. */
  async many<K extends SettingKey>(keys: readonly K[]): Promise<{ [P in K]: SettingValue<P> }> {
    const values = await Promise.all(keys.map((k) => this.get(k)));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as { [P in K]: SettingValue<P> };
  }

  /** Validates, stores and returns the parsed value. Throws VALIDATION_FAILED (400) for a bad value. */
  async set<K extends SettingKey>(key: K, value: unknown, updatedBy = 'system', reason?: string): Promise<SettingValue<K>> {
    const parsed = SETTINGS[key].schema.safeParse(value);
    if (!parsed.success) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `Invalid value for ${key}`, HttpStatus.BAD_REQUEST, { key, issues: parsed.error.issues.map((i) => i.message) });
    }
    const next = parsed.data as SettingValue<K>;
    await this.checkCrossRules(key, next);
    await this.store.set(key, next, updatedBy, SETTINGS[key].label, reason);
    return next;
  }

  async reset(key: SettingKey): Promise<void> {
    await this.store.unset(key);
  }

  async view(key: SettingKey): Promise<SettingView> {
    const def = SETTINGS[key];
    const [doc, value] = await Promise.all([this.store.getDoc(key), this.get(key)]);
    const defaultValue = this.defaultOf(key);
    const opt = def as { options?: readonly string[]; min?: number; max?: number };
    return {
      key,
      group: def.group,
      label: def.label,
      description: def.description,
      kind: def.kind,
      options: opt.options ? [...opt.options] : null,
      min: opt.min ?? null,
      max: opt.max ?? null,
      value,
      defaultValue,
      isDefault: !doc,
      updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
      updatedBy: doc ? doc.updatedBy : null,
    };
  }

  async list(): Promise<SettingView[]> {
    return Promise.all(SETTING_KEYS.map((k) => this.view(k)));
  }

  parseKey(key: string): SettingKey {
    if (!isSettingKey(key)) throw ApiError.notFound(ERROR_CODES.NOT_FOUND, `Unknown setting ${key}`);
    return key;
  }

  /** Rules a single schema cannot express. */
  private async checkCrossRules(key: SettingKey, value: unknown): Promise<void> {
    if (key === 'scan.model') {
      const model = value as string;
      // Without a price the daily spending cap cannot reserve anything and would never close.
      if (!knownGeminiPrice(model) && !(await this.store.get(`ai.price.${model}`, null))) {
        throw new ApiError(ERROR_CODES.VALIDATION_FAILED, `No price is known for ${model}`, HttpStatus.BAD_REQUEST, { key, hint: `add app_config ai.price.${model} first` });
      }
    }
  }
}
