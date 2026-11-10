import { z } from 'zod';
import type { AppConfig } from '../../config/env';
import { DEFAULT_REALTIME_MODEL, DEFAULT_TEXT_MODEL } from '../ai/ai-models';

/**
 * Every runtime setting an admin can change (GET/PUT /v1/admin/settings). Each key is its own app_config
 * document; an unset key uses the default below. Secrets and the database URL never live here: they stay
 * in the environment (src/config/env.ts).
 *
 * Adding a setting: add it here with a schema and a default, then read it with SettingsService.get(key).
 * Renaming a key loses the stored value, so add a new key instead.
 */

export type SettingKind = 'string' | 'number' | 'boolean' | 'enum' | 'list';

export const SETTING_GROUPS = {
  scans: { label: 'Food photo scans', description: 'Gemini photo and label scans. Daily caps cover the whole service and sit outside the monthly AI budget.' },
  ai: { label: 'AI models', description: 'Models for plan tips and the live voice. Coach, parse and other models are on the AI settings page.' },
  signIn: { label: 'Sign-in and email', description: 'Public client IDs for Google and Apple sign-in, and the sender of sign-in emails.' },
  integrity: { label: 'Device integrity', description: 'App Attest (iOS) and Play Integrity (Android) checks on AI and scan routes.' },
  foods: { label: 'Barcode lookups', description: 'Packaged foods by barcode from Open Food Facts (free, keyless).' },
  admin: { label: 'Admin panel', description: 'Links sent in admin emails.' },
} as const;
export type SettingGroup = keyof typeof SETTING_GROUPS;

interface SettingDef<T> {
  group: SettingGroup;
  label: string;
  description: string;
  kind: SettingKind;
  schema: z.ZodType<T>;
  default: T | ((config: AppConfig) => T);
  options?: readonly string[];
  min?: number;
  max?: number;
}

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const text = (max = 200) => z.string().trim().max(max);
const geminiModel = z
  .string()
  .trim()
  .regex(/^gemini-[a-z0-9.-]+$/, 'must be a Gemini model id, for example gemini-3.5-flash-lite');
const optionalGeminiModel = z.union([z.literal(''), geminiModel]);
const httpUrl = z
  .url({ protocol: /^https?$/ })
  .transform((v) => v.replace(/\/+$/, ''));

function setting<T>(def: SettingDef<T>): SettingDef<T> {
  return def;
}
function num(group: SettingGroup, label: string, description: string, def: number, min: number, max: number, decimals = false): SettingDef<number> {
  return setting({ group, label, description, kind: 'number', schema: decimals ? z.number().min(min).max(max) : int(min, max), default: def, min, max });
}
function choice<const O extends readonly [string, ...string[]]>(group: SettingGroup, label: string, description: string, options: O, def: O[number] | ((c: AppConfig) => O[number])): SettingDef<O[number]> {
  return setting<O[number]>({ group, label, description, kind: 'enum', schema: z.enum(options) as unknown as z.ZodType<O[number]>, default: def, options });
}

export const SETTINGS = {
  // ── Food photo scans ──────────────────────────────────────────────────────
  'scan.model': setting({
    group: 'scans',
    label: 'Scan model',
    description: 'Gemini model for photo and label scans. Only models with a known price (built in, or ai.price.<model>) are accepted, so the spending cap keeps working.',
    kind: 'string',
    schema: geminiModel,
    default: DEFAULT_TEXT_MODEL,
  }),
  'scan.dailyRequestCap': num('scans', 'Daily request cap', 'Gemini scan calls per UTC day for the whole service, retries included. 0 stops scans.', 500, 0, 1_000_000),
  'scan.dailySpendUsd': num('scans', 'Daily spending cap (USD)', 'Gemini scan spend per UTC day for the whole service. Each call reserves its worst case first, so the cap is never passed.', 1, 0, 1000, true),
  'scan.thinkingLevel': choice('scans', 'Thinking level', 'How much the model may think before answering. Thinking bills as output.', ['minimal', 'low', 'medium', 'high'], 'minimal'),
  'scan.imageResolution': choice('scans', 'Image resolution', 'Image token charge on Gemini 3: about 280 / 560 / 1120 tokens, whatever the file size.', ['low', 'medium', 'high'], 'high'),
  'scan.imageMaxEdgePx': num('scans', 'Image longest edge (px)', 'The photo is resized to this before it is sent.', 1024, 512, 2048),
  'scan.maxOutputTokens': num('scans', 'Max output tokens', 'Thinking included. About 110 tokens per food item; 15 items fit in 2,560.', 4096, 512, 16_384),
  'scan.timeoutMs': num('scans', 'Timeout per attempt (ms)', 'The app stops waiting at 40 s; all attempts fit in 38 s.', 20_000, 1000, 60_000),
  'scan.maxAttempts': num('scans', 'Attempts per scan', 'Transient errors only, first attempt included, with backoff.', 3, 1, 5),

  // ── AI models ─────────────────────────────────────────────────────────────
  'ai.model.plan': setting({
    group: 'ai',
    label: 'Plan tips model',
    description: "Model for personalised plan wording. Empty = the plan prompt's own model, else the default text model.",
    kind: 'string',
    schema: optionalGeminiModel,
    default: '',
  }),
  'ai.model.realtime': setting({
    group: 'ai',
    label: 'Live voice model',
    description: 'Model for the Gemini Live voice conversation. Switch the feature off with the flag voice.realtime.',
    kind: 'string',
    schema: geminiModel,
    default: DEFAULT_REALTIME_MODEL,
  }),

  // ── Sign-in and email ─────────────────────────────────────────────────────
  'auth.google.clientIds': setting({
    group: 'signIn',
    label: 'Google client IDs',
    description: "ID-token audiences accepted for Google sign-in. The apps pass the Firebase project's web client as serverClientId, so that one is needed.",
    kind: 'list',
    schema: z.array(text(200).min(1)).max(10),
    default: ['110926860028-6mpqr1u59dl1hnl7olnhckel3beak0b2.apps.googleusercontent.com'],
  }),
  'auth.apple.bundleId': setting({ group: 'signIn', label: 'Apple bundle ID', description: 'Audience of Sign in with Apple tokens from the iOS app. Also part of the App Attest app id. Empty = Apple sign-in is off.', kind: 'string', schema: text(200), default: 'app.nouri' }),
  'auth.apple.serviceId': setting({ group: 'signIn', label: 'Apple service ID', description: 'Audience of Sign in with Apple tokens from the web. Optional.', kind: 'string', schema: text(200), default: '' }),
  'email.from': setting({
    group: 'signIn',
    label: 'Email sender',
    description: 'From address of sign-in codes and exports. Its domain must be verified in Resend.',
    kind: 'string',
    schema: text(200).min(3),
    default: 'Nouri <hello@example.com>',
  }),

  // ── Device integrity ──────────────────────────────────────────────────────
  'integrity.mode': choice('integrity', 'Integrity checks', 'device = verify App Attest / Play Integrity assertions; allow = accept any non-empty header (development).', ['allow', 'device'], (c) => (c.isProduction ? 'device' : 'allow')),
  'integrity.enforce': setting({ group: 'integrity', label: 'Enforce integrity', description: 'On = guarded routes refuse requests that fail the check. Off = failures are only logged.', kind: 'boolean', schema: z.boolean(), default: (c) => c.isProduction }),
  'integrity.apple.teamId': setting({ group: 'integrity', label: 'Apple team ID', description: 'Needed for App Attest. Empty = iOS assertions cannot be verified.', kind: 'string', schema: text(20), default: '' }),
  'integrity.apple.allowDevelopment': setting({ group: 'integrity', label: 'Accept development App Attest', description: 'Accept attestations from development builds.', kind: 'boolean', schema: z.boolean(), default: (c) => !c.isProduction }),
  'integrity.android.package': setting({ group: 'integrity', label: 'Android package', description: 'Play Integrity package name. Also needs PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON in the environment.', kind: 'string', schema: text(200), default: 'app.nouri' }),

  // ── Barcode lookups ───────────────────────────────────────────────────────
  'foods.barcode.enabled': setting({ group: 'foods', label: 'Barcode lookups', description: 'Off = GET /foods/barcode answers that lookups are unavailable.', kind: 'boolean', schema: z.boolean(), default: true }),
  'foods.barcode.baseUrl': setting({ group: 'foods', label: 'Product database URL', description: 'Open Food Facts base URL.', kind: 'string', schema: httpUrl, default: 'https://world.openfoodfacts.org' }),
  'foods.barcode.userAgent': setting({ group: 'foods', label: 'User agent', description: 'Open Food Facts asks every client to name itself. Never put a personal email here.', kind: 'string', schema: text(200).min(3), default: 'Nouri/1.0 (nutrition app)' }),
  'foods.barcode.timeoutMs': num('foods', 'Timeout (ms)', 'Per lookup.', 4000, 500, 15_000),

  // ── Admin panel ───────────────────────────────────────────────────────────
  'admin.appUrl': setting({ group: 'admin', label: 'Admin panel URL', description: 'Base of the links in admin invite emails, including /nouri-admin.', kind: 'string', schema: httpUrl, default: 'http://localhost:3001/nouri-admin' }),
} satisfies Record<string, SettingDef<string> | SettingDef<number> | SettingDef<boolean> | SettingDef<string[]>>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K] extends SettingDef<infer T> ? T : never;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export function settingDefault<K extends SettingKey>(key: K, config: AppConfig): SettingValue<K> {
  const def = SETTINGS[key].default as SettingValue<K> | ((c: AppConfig) => SettingValue<K>);
  return typeof def === 'function' ? (def as (c: AppConfig) => SettingValue<K>)(config) : def;
}
