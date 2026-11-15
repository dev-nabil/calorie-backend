/**
 * `pnpm transcribe:smoke [--fake] [--keep <dir>]`
 * Real Gemini check of spoken food logging, end to end without a phone: Gemini TTS speaks a sentence (English, Bangla,
 * Banglish), the exact meal-transcribe prompt turns the recording back into text, and that text goes through the
 * meal-describe prompt and normaliser like a typed message. Also a silent clip, and the same recording as AAC/M4A
 * (macOS afconvert) to check the compressed format. Never prints the key. Exit code 0 only when every check passed.
 * About 12 short calls (well under a cent).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../config/env';
import { buildFoodIndex, type FoodRecord } from '../domain/food-nutrition';
import { normaliseDescribe } from '../domain/nutrition-validator';
import { AiProvider, FakeAiProvider } from '../modules/ai/ai.provider';
import { DEFAULT_TEXT_MODEL, DEFAULT_TTS_MODEL } from '../modules/ai/ai-models';
import { GeminiProvider } from '../modules/ai/providers/gemini.provider';
import { defaultContentDir, latestVersionedFile, loadContentBundle } from '../modules/content/content.loader';
import { describeContext, MEAL_DESCRIBE_TIMEOUT_MS } from '../modules/meal-parse/meal-describe.handler';
import { MEAL_TRANSCRIBE_TIMEOUT_MS } from '../modules/meal-parse/meal-transcribe.handler';
import { MealDescribeOutputSchema, MealTranscribeOutputSchema } from '../shared';
import type { LocaleCode } from '../shared/locales';

interface Scenario {
  name: string;
  say: string | null; // null: a silent clip
  locale: LocaleCode;
  text: RegExp[];
  status?: 'ok' | 'silence';
  grams?: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'English, explicit grams', say: 'I ate two hundred and fifteen grams of chicken pizza and a can of Coke.', locale: 'en', text: [/215/, /pizza/i, /gram|\bg\b/i], grams: 215 },
  { name: 'Bangla, grams in words', say: 'আমি দুইশো পনেরো গ্রাম চিকেন পিজ্জা খেয়েছি।', locale: 'bn', text: [/215|২১৫/, /পিজ্জা|পিৎজা|pizza/i, /গ্রাম/], grams: 215 },
  { name: 'Bangla, three foods at lunch', say: 'দুপুরে ভাত, মুরগির তরকারি আর ডাল খেয়েছি।', locale: 'bn', text: [/ভাত/, /ডাল/, /মুরগি/] },
  { name: 'Banglish mix', say: 'Ami duita boiled egg ar ek glass milk kheyechi.', locale: 'en', text: [/egg|ডিম/i, /milk|দুধ/i] },
  { name: 'Silence', say: null, locale: 'en', text: [], status: 'silence' },
];

function silentWav(seconds: number): Buffer {
  const samples = 16000 * seconds;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const fake = process.argv.includes('--fake');
  const ki = process.argv.indexOf('--keep');
  const dir = ki >= 0 ? process.argv[ki + 1]! : mkdtempSync(join(tmpdir(), 'nouri-voice-'));
  let provider: AiProvider;
  if (fake) provider = new FakeAiProvider();
  else {
    if (!config.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set (.env). Use --fake to check the script only.');
      process.exit(1);
    }
    provider = new GeminiProvider(config.GEMINI_API_KEY);
  }
  const bundle = loadContentBundle(config.CONTENT_DIR);
  const latest = (key: string) => bundle.prompts.filter((p) => p.key === key).sort((a, b) => b.version - a.version)[0];
  const tp = latest('meal-transcribe');
  const dp = latest('meal-describe');
  if (!tp || !dp) throw new Error('meal-transcribe / meal-describe prompt files are missing');
  const recordsFile = latestVersionedFile(join(config.CONTENT_DIR ?? defaultContentDir(), 'food-records'), 'food-records');
  const data = recordsFile ? (JSON.parse(readFileSync(recordsFile, 'utf8')) as { records: FoodRecord[]; sources: Record<string, { name: string }> }) : { records: [], sources: {} };
  const records = buildFoodIndex(data.records, data.sources);
  console.warn(`\nTranscribe smoke test: provider=${provider.name}, model=${DEFAULT_TEXT_MODEL}, prompt=meal-transcribe.v${tp.version}, audio in ${dir}\n`);

  const transcribe = async (audio: Buffer, mimeType: string) => {
    const res = await provider.structured({ task: 'meal_transcribe', model: DEFAULT_TEXT_MODEL, instructions: tp.staticPrefix, context: tp.dynamicTemplate.trim(), audio: { bytes: audio, mimeType }, timeoutMs: MEAL_TRANSCRIBE_TIMEOUT_MS, maxOutputTokens: 400 });
    const p = MealTranscribeOutputSchema.safeParse(res.output);
    if (!p.success) throw new Error(`schema: ${p.error.issues[0]?.message}`);
    return p.data;
  };

  let failures = 0;
  for (const [i, s] of SCENARIOS.entries()) {
    const started = Date.now();
    try {
      const wav = s.say === null ? silentWav(2) : (await provider.speech({ model: DEFAULT_TTS_MODEL, voice: 'Kore', text: s.say, timeoutMs: 30_000 })).audio;
      writeFileSync(join(dir, `${i + 1}.wav`), wav);
      const t = await transcribe(wav, 'audio/wav');
      const problems: string[] = [];
      if (!fake) {
        if ((s.status ?? 'ok') !== t.status) problems.push(`status ${t.status}, expected ${s.status ?? 'ok'}`);
        for (const re of s.text) if (!re.test(t.text)) problems.push(`text misses ${re}`);
      }
      console.warn(`${problems.length ? 'FAIL' : 'ok  '} ${i + 1}. ${s.name} (${((Date.now() - started) / 1000).toFixed(1)}s, ${(wav.length / 1024).toFixed(0)} KB wav)`);
      if (s.say) console.warn(`     said:  ${s.say}`);
      console.warn(`     heard: [${t.status}${t.language ? `, ${t.language}` : ''}] ${t.text}`);
      // The same recording as AAC in an MP4 container, the phone's compact format.
      if (s.say && i === 0 && process.platform === 'darwin' && !fake) {
        const m4a = join(dir, `${i + 1}.m4a`);
        execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '32000', join(dir, `${i + 1}.wav`), m4a]);
        const audio = readFileSync(m4a);
        const tm = await transcribe(audio, 'audio/mp4');
        const ok = tm.status === 'ok' && /215/.test(tm.text);
        if (!ok) problems.push(`m4a: [${tm.status}] ${tm.text}`);
        console.warn(`     m4a (${(audio.length / 1024).toFixed(0)} KB, audio/mp4): [${tm.status}] ${tm.text}`);
      }
      // Then the words go through text logging, as Send does.
      if (t.status === 'ok' && t.text) {
        const res = await provider.structured({ task: 'meal_describe', model: DEFAULT_TEXT_MODEL, instructions: dp.staticPrefix, context: describeContext(dp.dynamicTemplate, { text: t.text, inputMethod: 'voice' }, s.locale), timeoutMs: MEAL_DESCRIBE_TIMEOUT_MS, maxOutputTokens: 1600 });
        const parsed = MealDescribeOutputSchema.safeParse(res.output);
        if (!parsed.success) problems.push('describe output rejected');
        else {
          const r = normaliseDescribe(parsed.data, { records, text: t.text });
          console.warn(`     → ${r.status} · ${r.totals.kcal} kcal · ${r.items.map((it) => `${it.name} ${it.grams} g`).join(', ')}`);
          if (s.grams && !fake && !r.items.some((it) => it.grams === s.grams)) problems.push(`no item at ${s.grams} g`);
        }
      }
      for (const p of problems) console.warn(`     ! ${p}`);
      failures += problems.length ? 1 : 0;
    } catch (err) {
      failures++;
      const e = err as { status?: number; message?: string };
      console.warn(`FAIL ${i + 1}. ${s.name}: ${e.status ? `HTTP ${e.status} ` : ''}${e.message ?? String(err)}`);
    }
    console.warn('');
  }
  console.warn(failures ? `${failures} scenario(s) failed.` : 'OK: every scenario passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(`FAILED: ${(err as { message?: string }).message ?? String(err)}`);
  process.exit(1);
});
