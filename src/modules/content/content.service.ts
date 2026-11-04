import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { conversationTurns, loadQuestionSet, type ConversationTurn, type QuestionSet } from '../../domain/onboarding-engine';
import type { ScanReactionContent } from '../../domain/nutrition-validator/reactions';
import { requestLocale } from '../../common/http/request-context';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { defaultContentDir, loadContentBundle, type ContentBundle, type PromptFile } from './content.loader';
import type { AiPromptDoc, ContentVersionDoc } from './schemas/content.schema';

type Kind = 'onboarding_questions' | 'conversation' | 'milo_lines';
const CACHE_MS = 60_000; // admin publishes take effect within 60 s (M7)

interface Cached {
  version: number;
  data: unknown;
  at: number;
}

/**
 * Product content from content/ (questions, conversation, Milo lines, prompts). Seeds
 * content_versions and ai_prompts on boot without overwriting published versions, then serves the
 * latest published version from the database with a short in-process cache.
 */
@Injectable()
export class ContentService implements OnApplicationBootstrap {
  private readonly logger = new Logger('ContentService');
  private readonly warned = new Set<string>();
  private bundle!: ContentBundle;
  private readonly cache = new Map<string, Cached>();
  private readonly parsedSets = new Map<LocaleCode, { version: number; set: QuestionSet }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel('ContentVersion') private readonly versions: Model<ContentVersionDoc>,
    @InjectModel('AiPrompt') private readonly prompts: Model<AiPromptDoc>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.bundle = loadContentBundle(this.config.CONTENT_DIR ?? defaultContentDir());
    loadQuestionSet(this.bundle.questions); // fail fast on a broken question bank
    for (const c of Object.values(this.bundle.locales)) if (c?.questions) loadQuestionSet(c.questions);
    await this.seed();
  }

  /** Inserts file content as published versions when missing; never overwrites (admin edits win). */
  async seed(): Promise<void> {
    const now = new Date();
    const entries: Array<[string, unknown]> = [
      ['onboarding_questions', this.bundle.questions],
      ['conversation', this.bundle.conversation],
      ['milo_lines', this.bundle.miloLines],
    ];
    // Translated copies are separate kinds (`milo_lines.bn`) with their own version numbers: no index change needed.
    for (const [lang, c] of Object.entries(this.bundle.locales)) {
      entries.push([`onboarding_questions.${lang}`, c?.questions ?? null], [`conversation.${lang}`, c?.conversation ?? null], [`milo_lines.${lang}`, c?.miloLines ?? null]);
    }
    for (const [kind, data] of entries) {
      if (!data) continue;
      const version = Number((data as { version?: number }).version ?? 1);
      await this.versions.updateOne(
        { kind, version },
        { $setOnInsert: { kind, version, data, publishedAt: now, source: 'seed' } },
        { upsert: true },
      );
    }
    for (const p of this.bundle.prompts) await this.seedPrompt(p);
    this.logger.log(`content seeded: ${entries.filter((e) => e[1]).length} kinds, ${this.bundle.prompts.length} prompts`);
  }

  private async seedPrompt(p: PromptFile): Promise<void> {
    await this.prompts.updateOne(
      { key: p.key, version: p.version },
      {
        $setOnInsert: {
          key: p.key,
          version: p.version,
          content: p.raw,
          staticPrefix: p.staticPrefix,
          dynamicTemplate: p.dynamicTemplate,
          meta: p.meta,
          params: { maxOutputTokens: Number(p.meta.maxOutputTokens ?? 0) || null, timeoutSec: Number(p.meta.timeoutSec ?? 0) || null },
          active: false,
          createdBy: 'seed',
        },
      },
      { upsert: true },
    );
    if (!(await this.prompts.exists({ key: p.key, active: true }))) {
      const latest = await this.prompts.findOne({ key: p.key }).sort({ version: -1 });
      if (latest) await this.prompts.updateOne({ _id: latest._id }, { $set: { active: true } });
    }
  }

  /** Newest published version of a kind in a language; null when that language has none. */
  async latest(kind: Kind, locale: LocaleCode = DEFAULT_LOCALE): Promise<{ version: number; data: unknown } | null> {
    const dbKind = locale === DEFAULT_LOCALE ? kind : `${kind}.${locale}`;
    const hit = this.cache.get(dbKind);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const doc = await this.versions.findOne({ kind: dbKind }).sort({ version: -1 }).lean();
    if (!doc) return null;
    const entry = { version: doc.version, data: doc.data, at: Date.now() };
    this.cache.set(dbKind, entry);
    return entry;
  }

  /** The language a kind is really served in: the requested one if published, else English (logged once per kind). */
  private async pick(kind: Kind, locale: LocaleCode): Promise<{ locale: LocaleCode; version: number; data: unknown } | null> {
    if (locale !== DEFAULT_LOCALE) {
      const own = await this.latest(kind, locale);
      if (own) return { locale, ...own };
      const key = `${kind}.${locale}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.logger.warn(`no ${locale} content for ${kind}: serving English`);
      }
    }
    const en = await this.latest(kind, DEFAULT_LOCALE);
    return en ? { locale: DEFAULT_LOCALE, ...en } : null;
  }

  /** Question bank in the request's language (or the given one). `locale` in the result is the language actually served. */
  async questionSet(locale: LocaleCode = requestLocale()): Promise<{ version: number; set: QuestionSet; raw: unknown; locale: LocaleCode }> {
    const picked = await this.pick('onboarding_questions', locale);
    const raw = picked?.data ?? this.bundle.questions;
    const served = picked?.locale ?? DEFAULT_LOCALE;
    const version = picked?.version ?? Number((raw as { version?: number }).version ?? 1);
    let parsed = this.parsedSets.get(served);
    if (!parsed || parsed.version !== version) {
      parsed = { version, set: loadQuestionSet(raw) };
      this.parsedSets.set(served, parsed);
    }
    return { version, set: parsed.set, raw, locale: served };
  }

  async conversation(locale: LocaleCode = requestLocale()): Promise<{ version: number; data: unknown; turns: ConversationTurn[]; locale: LocaleCode } | null> {
    const picked = await this.pick('conversation', locale);
    if (!picked) return null;
    const { set } = await this.questionSet(picked.locale);
    return { version: picked.version, data: picked.data, turns: conversationTurns(set, picked.data), locale: picked.locale };
  }

  async miloLines(locale: LocaleCode = requestLocale()): Promise<{ version: number; data: unknown; locale: LocaleCode } | null> {
    return this.pick('milo_lines', locale);
  }

  async scanReactions(locale: LocaleCode = requestLocale()): Promise<ScanReactionContent | null> {
    const lines = await this.miloLines(locale);
    return ((lines?.data as { scanReactions?: ScanReactionContent } | undefined)?.scanReactions ?? null);
  }

  async activePrompt(key: string): Promise<AiPromptDoc | null> {
    return this.prompts.findOne({ key, active: true }).lean();
  }

  /** Test hook: drop in-process caches. */
  clearCache(): void {
    this.cache.clear();
    this.parsedSets.clear();
  }
}
