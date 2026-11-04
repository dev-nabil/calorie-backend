import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_LOCALE, LOCALE_CODES, type LocaleCode } from '../../shared/locales';

export const DYNAMIC_MARKER = '<!-- DYNAMIC CONTEXT BELOW: not cached -->';

export interface PromptFile {
  key: string;
  version: number;
  meta: Record<string, string | string[]>;
  /** Static prefix with includes resolved; identical for every request (S-18). */
  staticPrefix: string;
  /** Dynamic template with {{placeholders}}; empty for includes. */
  dynamicTemplate: string;
  raw: string;
}

export interface LocaleContent {
  questions: unknown | null;
  conversation: unknown | null;
  miloLines: unknown | null;
}

export interface ContentBundle {
  questions: unknown;
  conversation: unknown | null;
  miloLines: unknown | null;
  /** Translated copies of the three files, by language code (decision 0007). English lives in the fields above. */
  locales: Partial<Record<LocaleCode, LocaleContent>>;
  prompts: PromptFile[];
}

/** Default content folder at the repo root, valid from src/ and dist/. */
export function defaultContentDir(): string {
  return resolve(__dirname, '..', '..', '..', 'content');
}

function parseFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.trim();
    meta[kv[1]!] = /^\[.*\]$/.test(value)
      ? value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : value;
  }
  return { meta, body: m[2]! };
}

export function parsePrompts(files: Record<string, string>): PromptFile[] {
  const parsed = Object.entries(files).map(([name, text]) => ({ name, ...parseFrontMatter(text) }));
  const bodies = new Map(parsed.map((p) => [p.name.replace(/\.md$/, ''), p.body.trim()]));
  return parsed.map((p) => {
    const [prefix, dynamic = ''] = p.body.split(DYNAMIC_MARKER);
    const staticPrefix = prefix!.replace(/\[\[include ([\w.-]+)\]\]/g, (_all, ref: string) => {
      const included = bodies.get(ref);
      if (included === undefined) throw new Error(`Prompt ${p.name} includes unknown ${ref}`);
      return included;
    });
    return {
      key: String(p.meta.key ?? p.name.replace(/\.v\d+\.md$/, '')),
      version: Number(p.meta.version ?? /\.v(\d+)\.md$/.exec(p.name)?.[1] ?? 1),
      meta: p.meta,
      staticPrefix: staticPrefix.trim(),
      dynamicTemplate: dynamic.trim(),
      raw: p.body,
    };
  });
}

function readJson(path: string): unknown | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
}

/** Highest `<stem>.vN.json` in a folder (content versioning rule 3: structural changes add a new file). */
export function latestVersionedFile(dir: string, stem: string, lang?: string): string | null {
  if (!existsSync(dir)) return null;
  const re = new RegExp(`^${stem}\\.v(\\d+)${lang ? `\\.${lang}` : ''}\\.json$`);
  const found = readdirSync(dir)
    .map((name) => ({ name, v: Number(re.exec(name)?.[1] ?? 0) }))
    .filter((f) => f.v > 0)
    .sort((a, b) => b.v - a.v);
  return found[0] ? join(dir, found[0].name) : null;
}

/** Reads the product content folder (questions, conversation, Milo lines, prompts): the newest version of each. */
export function loadContentBundle(dir = defaultContentDir()): ContentBundle {
  const questionsFile = latestVersionedFile(join(dir, 'onboarding'), 'questions');
  if (!questionsFile) throw new Error(`Missing ${join(dir, 'onboarding', 'questions.vN.json')}`);
  const questions = readJson(questionsFile);
  const promptDir = join(dir, 'prompts');
  const promptFiles: Record<string, string> = {};
  if (existsSync(promptDir)) {
    for (const f of readdirSync(promptDir).filter((n) => /\.v\d+\.md$/.test(n))) {
      promptFiles[f] = readFileSync(join(promptDir, f), 'utf8');
    }
  }
  const conversationFile = latestVersionedFile(join(dir, 'onboarding'), 'conversation');
  const linesFile = latestVersionedFile(join(dir, 'milo'), 'lines');
  const locales: ContentBundle['locales'] = {};
  for (const lang of LOCALE_CODES) {
    if (lang === DEFAULT_LOCALE) continue;
    const q = latestVersionedFile(join(dir, 'onboarding'), 'questions', lang);
    const c = latestVersionedFile(join(dir, 'onboarding'), 'conversation', lang);
    const l = latestVersionedFile(join(dir, 'milo'), 'lines', lang);
    if (q || c || l) locales[lang] = { questions: q ? readJson(q) : null, conversation: c ? readJson(c) : null, miloLines: l ? readJson(l) : null };
  }
  return {
    questions,
    conversation: conversationFile ? readJson(conversationFile) : null,
    miloLines: linesFile ? readJson(linesFile) : null,
    locales,
    prompts: parsePrompts(promptFiles),
  };
}

export function fillTemplate(template: string, values: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_all, k: string) => {
    const v = values[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Single-brace placeholders used by content/milo/lines.v1.json (`{energyKcal}`); unknown keys stay as written. */
export function fillSingle(template: string, values: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (all, k: string) => {
    const v = values[k];
    return v === undefined || v === null ? all : String(v);
  });
}
