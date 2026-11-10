import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ERROR_CODES, FridgeChefOutputSchema, UPLOAD_KINDS, type FridgeChefResponse } from '../../shared';
import { DEFAULT_LOCALE, type LocaleCode } from '../../shared/locales';
import { describeAllergies, describeDietPattern, effectiveMode } from '../../domain/copy-rules';
import { normaliseFridgeChef } from '../../domain/fridge-chef';
import { avoidTermsFor } from '../../domain/plan-narrative';
import { ApiError } from '../../common/errors/api-error';
import { prepareScanImage, ScanImageError, validateScanImage } from '../../infra/media/scan-image';
import { StorageService } from '../../infra/storage/storage';
import { AiJobs } from '../ai/ai-jobs';
import { AiProvider } from '../ai/ai.provider';
import { DEFAULT_TEXT_MODEL } from '../ai/ai-models';
import { AiService, AiUnavailableError } from '../ai/ai.service';
import { languageDirective } from '../ai/language';
import { fillTemplate } from '../content/content.loader';
import { ContentService } from '../content/content.service';
import type { ProfileDoc } from '../onboarding/schemas/onboarding.schema';
import type { PlanDoc } from '../plans/schemas/plans.schema';
import { UsersService } from '../users/users.service';

export const FRIDGE_CHEF_JOB = 'fridge_chef';
export const FRIDGE_CHEF_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2500;
/** Longest edge of the photo sent to the model; the food scans use the same size. */
const IMAGE_MAX_EDGE = 1024;

/** Used only when no `fridge-chef` prompt is stored (a database that was never seeded). */
const FALLBACK_INSTRUCTIONS =
  'You are Milo in the Nouri nutrition app. List the foods you can see in the photo and suggest up to 3 simple dishes as JSON. Never use a food the person is allergic to or that their eating pattern rules out.';

export interface FridgeChefJob {
  userId: string;
  uploadKey: string;
  /** Reply language (the job runs outside the request context). */
  locale?: LocaleCode;
}

/**
 * An AI job (AiJobs): one Gemini vision call (structured JSON) through the monthly AI budget, then the domain
 * check (allergens, eating pattern, habits-only, sizes). The photo is deleted right after the call, whatever its outcome.
 */
@Injectable()
export class FridgeChefHandler implements OnModuleInit {
  private readonly logger = new Logger('FridgeChef');

  constructor(
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('Plan') private readonly plans: Model<PlanDoc>,
    private readonly handlers: AiJobs,
    private readonly ai: AiService,
    private readonly provider: AiProvider,
    private readonly content: ContentService,
    private readonly users: UsersService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(FRIDGE_CHEF_JOB, (p) => this.handle(p as FridgeChefJob));
  }

  async handle(job: FridgeChefJob): Promise<FridgeChefResponse> {
    try {
      return await this.run(job);
    } finally {
      await this.storage.delete(job.uploadKey).catch((e: unknown) => this.logger.warn({ err: (e as Error).message }, 'fridge photo not deleted'));
    }
  }

  private async run({ userId, uploadKey, locale = DEFAULT_LOCALE }: FridgeChefJob): Promise<FridgeChefResponse> {
    // No real model behind the provider: made-up ingredients would be worse than none.
    if (!this.provider.configured) throw new AiUnavailableError('not_configured', 3600);
    const user = await this.users.requireActive(userId);
    const uid = new Types.ObjectId(userId);
    const [profile, plan] = await Promise.all([
      this.profiles.findOne({ userId: uid }).lean<ProfileDoc>(),
      this.plans.findOne({ userId: uid, active: true }, { energyKcal: 1 }).lean<Pick<PlanDoc, 'energyKcal'>>(),
    ]);
    const image = await this.photo(uploadKey);
    const mode = effectiveMode(profile?.mode, plan?.energyKcal);
    const prompt = await this.content.activePrompt('fridge-chef');
    const model = prompt?.model || (await this.ai.modelFor('fridge', DEFAULT_TEXT_MODEL));
    const res = await this.ai.runOrUnavailable('fridge', () =>
      this.provider.structured({
        task: 'fridge_chef',
        model,
        instructions: prompt?.staticPrefix ?? FALLBACK_INSTRUCTIONS,
        context:
          languageDirective(locale) +
          fillTemplate(prompt?.dynamicTemplate ?? 'Mode: {{mode}}\nEating pattern: {{dietPattern}}\nAllergies: {{allergies}}', {
            mode,
            dietPattern: describeDietPattern(profile?.dietPattern, profile?.dietPatternOther),
            allergies: describeAllergies(profile?.allergies, profile?.allergyOther),
          }),
        image: { bytes: image, mimeType: 'image/jpeg', resolution: 'high' },
        timeoutMs: (prompt?.params?.timeoutSec ?? 0) * 1000 || FRIDGE_CHEF_TIMEOUT_MS,
        maxOutputTokens: prompt?.params?.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
      }),
    );
    const parsed = FridgeChefOutputSchema.safeParse(res.output);
    if (!parsed.success) {
      this.logger.warn({ model: res.model, issues: parsed.error.issues.slice(0, 3).map((i) => i.message) }, 'fridge chef: answer does not match the schema');
      throw new ApiError(ERROR_CODES.AI_UNAVAILABLE, 'The photo could not be read. Try again.', HttpStatus.BAD_GATEWAY);
    }
    const out = normaliseFridgeChef(parsed.data, { mode, locale, avoidTerms: avoidTermsFor(profile?.allergies, profile?.allergyOther, profile?.dietPattern, locale) });
    if (out.dropped.length) this.logger.warn({ userId: user._id.toString(), model: res.model, kept: out.ideas.length, dropped: out.dropped }, 'fridge chef: ideas dropped');
    return { notFood: out.notFood, ingredients: out.ingredients, ideas: out.ideas };
  }

  /** The upload as the scans read it: real type, size, dimensions and a full decode, then re-encoded without metadata. */
  private async photo(key: string): Promise<Buffer> {
    const maxBytes = UPLOAD_KINDS.meal_photo.maxBytes;
    const size = await this.storage.size(key);
    if (size !== null && size > maxBytes) throw new ApiError(ERROR_CODES.IMAGE_INVALID, 'That photo could not be used', HttpStatus.BAD_REQUEST, { reason: 'too_large' });
    const bytes = await this.storage.get(key);
    if (!bytes) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Upload the photo with POST /uploads/presign first', HttpStatus.BAD_REQUEST, { field: 'uploadKey' });
    try {
      await validateScanImage(bytes, { maxBytes });
    } catch (e) {
      if (e instanceof ScanImageError) throw new ApiError(ERROR_CODES.IMAGE_INVALID, 'That photo could not be used', HttpStatus.BAD_REQUEST, { reason: e.reason });
      throw e;
    }
    return prepareScanImage(bytes, IMAGE_MAX_EDGE);
  }
}
