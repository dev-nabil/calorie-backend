import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import {
  ERROR_CODES,
  PLAN_GENERATIONS_PER_DAY,
  PLAN_MODEL_ATTEMPTS_PER_DAY,
  WATER_DEFAULT_TARGET_ML,
  type ConfirmPlanRequest,
  type EligibilityAttestation,
  type GeneratePlanRequest,
  type Plan,
  type PlanAiInfo,
  type PlanAssessment,
  type PlanDraft,
  type PlanPreview,
  type PlanReadiness,
} from '../../shared';
import { DomainError } from '../../domain/errors';
import { assessEligibility, calculatePlan, validateTargets, type PlanInputs } from '../../domain/plan-calculator';
import { assessPlan, buildBasis, estimateTimeframe, noticeFor, retimeFrame, type AssessInputs } from '../../domain/plan-assessment';
import { buildNarrativeContext, makeLabeler, planInputHash } from '../../domain/plan-narrative';
import { isVerifiedAccount } from '../../domain/entitlements';
import { ApiError } from '../../common/errors/api-error';
import { requestLocale } from '../../common/http/request-context';
import { DailyQuota } from '../../common/rate-limit/daily-quota';
import { translatorFor, type Translator } from '../../shared/i18n';
import { DEFAULT_LOCALE, parseLocale, type LocaleCode } from '../../shared/locales';
import { KvStore } from '../../infra/kv/kv-store';
import { AiJobRunner } from '../ai/ai-jobs';
import { ContentService } from '../content/content.service';
import type { ProfileDoc } from '../onboarding/schemas/onboarding.schema';
import { UsersService } from '../users/users.service';
import { PLAN_NARRATIVE_BUDGET_MS, PLAN_NARRATIVE_JOB, type PlanNarrativeJob, type PlanNarrativeResult } from './plan-narrative.handler';
import type { PlanDraftDoc, PlanDoc } from './schemas/plans.schema';

export function planInputsFrom(profile: ProfileDoc | null, attestation?: EligibilityAttestation | null): PlanInputs {
  return {
    ageYears: profile?.ageYears ?? null,
    calculationSex: profile?.calculationSex ?? null,
    heightCm: profile?.heightCm ?? null,
    weightKg: profile?.weightKg ?? null,
    activityLevel: profile?.activityLevel ?? null,
    goal: profile?.primaryGoal ?? null,
    targetWeightKg: profile?.targetWeightKg ?? null,
    attestation: attestation ?? profile?.attestation ?? null,
    waterMl: WATER_DEFAULT_TARGET_ML,
  };
}

export function assessInputsFrom(profile: ProfileDoc | null, attestation?: EligibilityAttestation | null): AssessInputs {
  return {
    ...planInputsFrom(profile, attestation),
    weightIsEstimate: Boolean(profile?.weightIsEstimate),
    allergies: (profile?.allergies as string[] | null | undefined) ?? null,
    mealsPerDay: profile?.mealsPerDay ?? null,
    schedulePattern: profile?.schedulePattern ?? null,
    mealSource: profile?.mealSource ?? null,
    dietPattern: profile?.dietPattern ?? null,
  };
}

const DRAFT_TTL_DAYS = 30;
const LOCK_SEC = Math.ceil(PLAN_NARRATIVE_BUDGET_MS / 1000) + 15;
const ESSENTIAL_REASONS = ['sex_input_missing', 'height_missing', 'weight_missing', 'activity_missing'];

/** The preview with every number removed: used when the outcome is anything but `ready`. */
function withoutNumbers(p: PlanPreview, reasons: string[]): PlanPreview {
  return {
    ...p,
    eligible: false,
    reasons,
    method: null,
    inputs: null,
    bmrKcal: null,
    activityFactor: null,
    tdeeKcal: null,
    adjustmentPct: null,
    floorKcal: null,
    calculated: null,
    bounds: null,
    // No weight-focused goal is shown or stored for a draft that is not a calorie plan.
    goal: { type: p.goal.type, startWeightKg: null, targetWeightKg: null, pace: null },
  };
}

const reasonsOf = (a: PlanAssessment): string[] =>
  a.outcome === 'needs_input'
    ? [...a.missing.map((m) => m.field), ...a.issues.filter((i) => i.severity === 'blocking').map((i) => i.code)]
    : a.guidanceReasons;

/**
 * M2-T5 plus PLAN-GEN: readiness check, plan generation (validated numbers + AI wording), review drafts,
 * confirm (with the reviewed draft or the legacy calculated / adjusted / manual / none) and read the active plan.
 * Texts are written in the language of the request (decision 0007) and stored with the draft.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger('PlansService');

  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectModel('Plan') private readonly plans: Model<PlanDoc>,
    @InjectModel('PlanDraft') private readonly drafts: Model<PlanDraftDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    private readonly content: ContentService,
    private readonly runner: AiJobRunner,
    private readonly quota: DailyQuota,
    private readonly kv: KvStore,
    private readonly users: UsersService,
  ) {}

  async preview(userId: string, attestation?: EligibilityAttestation): Promise<PlanPreview> {
    if (attestation) {
      await this.profiles.updateOne({ userId: new Types.ObjectId(userId) }, { $set: { attestation } }, { upsert: true });
    }
    const profile = await this.profiles.findOne({ userId: new Types.ObjectId(userId) }).lean<ProfileDoc>();
    const inputs = assessInputsFrom(profile, attestation);
    const numbers = calculatePlan(inputs);
    // Contradictory answers (implausible BMI, target on the wrong side of the weight) get no numbers here either.
    const assessment = assessPlan(inputs);
    if (numbers.eligible && assessment.outcome !== 'ready') return withoutNumbers(numbers, reasonsOf(assessment));
    return numbers;
  }

  private async profileOf(userId: string): Promise<ProfileDoc | null> {
    return this.profiles.findOne({ userId: new Types.ObjectId(userId) }).lean<ProfileDoc>();
  }

  // ── Readiness ──────────────────────────────────────────────────────────────────────────────────

  /** What a plan could be made from right now, without calling any model. */
  async readiness(userId: string): Promise<PlanReadiness> {
    const profile = await this.profileOf(userId);
    const attestation = profile?.attestation ?? null;
    const inputs = assessInputsFrom(profile, attestation);
    const assessment = assessPlan(inputs, translatorFor(requestLocale()));
    const hash = planInputHash(profile ?? {}, attestation);
    const e = assessEligibility(inputs);
    const essentialsMissing = e.reasons.some((r) => ESSENTIAL_REASONS.includes(r));
    const latest = await this.drafts.findOne({ userId: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).lean<PlanDraftDoc>();
    return {
      ...assessment,
      inputHash: hash,
      attestationOnFile: !e.reasons.includes('eligibility_unconfirmed'),
      attestationNeeded: e.reasons.includes('eligibility_unconfirmed') && e.adult && !essentialsMissing,
      latestDraftId: latest ? latest._id.toString() : null,
      latestDraftCurrent: latest ? latest.inputHash === hash : false,
    };
  }

  // ── Generate ───────────────────────────────────────────────────────────────────────────────────

  async generate(userId: string, req: GeneratePlanRequest): Promise<PlanDraft> {
    const user = await this.users.requireActive(userId);
    const uid = new Types.ObjectId(userId);
    if (req.eligibility) {
      await this.profiles.updateOne({ userId: uid }, { $set: { attestation: req.eligibility } }, { upsert: true });
    }
    const profile = await this.profileOf(userId);
    const attestation = req.eligibility ?? profile?.attestation ?? null;
    const inputs = assessInputsFrom(profile, attestation);
    const hash = planInputHash(profile ?? {}, attestation);
    const locale = requestLocale();
    const tr = translatorFor(locale);
    const assessment = assessPlan(inputs, tr);

    // Same answers in another language are a different draft: the tips and every message are in the language they were made in.
    const sameLanguage = locale === DEFAULT_LOCALE ? { $or: [{ locale }, { locale: { $exists: false } }, { locale: null }] } : { locale };
    const previous = await this.drafts.find({ userId: uid, inputHash: hash, ...sameLanguage }).sort({ createdAt: -1 }).limit(20).lean<PlanDraftDoc[]>();
    const latest = previous[0];
    // Same answers, nothing to improve: show the draft again instead of paying for another model call.
    if (latest && !req.regenerate && (latest.status !== 'ready' || latest.ai.status === 'ok')) return this.toDraft(latest, false);

    const lockKey = `plan-gen:${userId}`;
    const lockToken = randomUUID();
    if (!(await this.kv.setIfAbsent(lockKey, lockToken, LOCK_SEC))) {
      throw new ApiError(ERROR_CODES.PLAN_GENERATION_IN_PROGRESS, 'Your plan is already being prepared. Give it a moment.', HttpStatus.CONFLICT, { retryAfterSec: 5 }, { 'Retry-After': '5' });
    }
    try {
      const numbers = calculatePlan(inputs);
      const timeframe =
        assessment.outcome === 'ready' && numbers.eligible && numbers.calculated && numbers.tdeeKcal !== null && inputs.weightKg
          ? estimateTimeframe(
              {
                goal: inputs.goal,
                weightKg: inputs.weightKg,
                targetWeightKg: inputs.targetWeightKg ?? null,
                tdeeKcal: numbers.tdeeKcal,
                energyKcal: numbers.calculated.energyKcal,
                requestedWeeks: profile?.timeframeWeeks ?? null,
              },
              tr,
            )
          : null;
      const issues = [...assessment.issues];
      if (timeframe && (timeframe.verdict === 'faster_than_safe' || timeframe.verdict === 'faster_than_plan')) {
        issues.push({ code: 'timeframe_too_fast', severity: 'warning', message: timeframe.message, questionIds: ['q35'] });
      }
      const final: PlanAssessment = { ...assessment, issues };
      const ready = final.outcome === 'ready';
      // A declaration made after a plan was confirmed (pregnancy, eating-disorder concern, ...) ends the calorie plan (BR-18).
      if (final.outcome === 'professional_guidance' || final.outcome === 'habits_only') await this.enforceHabitsOnly(userId);
      const preview = ready ? numbers : withoutNumbers(numbers, reasonsOf(final));

      let ai: PlanAiInfo = { status: 'skipped', message: null, retryable: false, model: null };
      let narrative: PlanDraft['narrative'] = null;
      if (ready) {
        const result = await this.personalise(user, uid, profile!, preview, timeframe, final, Boolean(req.regenerate), locale, tr);
        ai = { status: result.status, message: result.message, retryable: result.retryable, model: result.model };
        narrative = result.narrative;
      }

      const doc = await this.drafts.create({
        userId: uid,
        inputHash: hash,
        status: final.outcome,
        assessment: final,
        preview,
        timeframe,
        basis: ready ? buildBasis(preview, inputs, timeframe, tr) : [],
        narrative,
        ai,
        notice: noticeFor(final, tr),
        locale,
        regenerations: previous.length,
        expiresAt: new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000),
      });
      return this.toDraft(doc.toObject() as PlanDraftDoc, false);
    } finally {
      // Only the owner releases: after the TTL another request may legitimately hold the lock.
      if ((await this.kv.get(lockKey)) === lockToken) await this.kv.del(lockKey);
    }
  }

  /** The model call, behind the daily limit, the verified-account rule and the worker queue. Never throws for AI trouble. */
  private async personalise(
    user: Awaited<ReturnType<UsersService['requireActive']>>,
    uid: Types.ObjectId,
    profile: ProfileDoc,
    preview: PlanPreview,
    timeframe: PlanDraft['timeframe'],
    assessment: PlanAssessment,
    regenerate: boolean,
    locale: LocaleCode,
    tr: Translator,
  ): Promise<PlanNarrativeResult> {
    if (!isVerifiedAccount(user)) {
      return { status: 'skipped', narrative: null, message: tr('plan.ai.skipped_unverified'), retryable: false, model: null, rejected: [] };
    }
    const userId = uid.toString();
    const unavailable = (message: string): PlanNarrativeResult => ({ status: 'unavailable', narrative: null, message, retryable: false, model: null, rejected: [] });
    // Successful personalisations are rationed per day (the refresh button); the first plan is checked too, so editing one answer
    // over and over cannot buy unlimited model calls. A second, hard cap counts every attempt, failures included.
    try {
      await this.quota.assertAvailable('plan', userId, user.timezone, PLAN_GENERATIONS_PER_DAY, true, tr('plan.ai.refresh_limit'));
      await this.quota.assertAvailable('plan_attempt', userId, user.timezone, PLAN_MODEL_ATTEMPTS_PER_DAY, true, tr('plan.ai.attempts_cap'));
    } catch (e) {
      if (regenerate) throw e;
      return unavailable(tr('plan.ai.limit_today'));
    }
    await this.quota.consume('plan_attempt', userId, user.timezone);
    // The model reads the English labels (stable, and what the allergen checks use); only its reply is in the user's language.
    const { set } = await this.content.questionSet(DEFAULT_LOCALE);
    const facts = buildNarrativeContext({ profile, preview, timeframe, assessment, label: makeLabeler(set), locale });
    const job: PlanNarrativeJob = { facts: facts.context, avoidTerms: facts.avoidTerms, locale };
    let result: PlanNarrativeResult;
    try {
      result = await this.runner.run<PlanNarrativeResult>(PLAN_NARRATIVE_JOB, job, PLAN_NARRATIVE_BUDGET_MS + 5_000);
    } catch (e) {
      this.logger.warn({ userId, err: (e as Error).message }, 'plan narrative job failed');
      return { status: 'unavailable', narrative: null, message: tr('plan.ai.unavailable'), retryable: true, model: null, rejected: [] };
    }
    // Rule hits can quote the user's allergens: log only how often the model was rejected.
    if (result.rejected?.length) this.logger.warn({ userId, rejectedAttempts: result.rejected.length, status: result.status }, 'plan narrative rejected');
    if (result.status === 'ok') await this.quota.consume('plan', userId, user.timezone);
    return result;
  }

  async latestDraft(userId: string): Promise<PlanDraft> {
    const profile = await this.profileOf(userId);
    const hash = planInputHash(profile ?? {}, profile?.attestation ?? null);
    const doc = await this.drafts.findOne({ userId: new Types.ObjectId(userId) }).sort({ createdAt: -1 }).lean<PlanDraftDoc>();
    if (!doc) throw ApiError.notFound(ERROR_CODES.PLAN_DRAFT_NOT_FOUND, 'No plan has been prepared yet');
    return this.toDraft(doc, doc.inputHash !== hash);
  }

  // ── Confirm ────────────────────────────────────────────────────────────────────────────────────

  async confirm(userId: string, req: ConfirmPlanRequest): Promise<Plan> {
    if (req.draftId) return this.confirmDraft(userId, req, req.draftId);
    const preview = await this.preview(userId);
    const result = validateTargets(preview, req);
    if (!result.ok) throw new DomainError(result.code, result.message, result.details);
    if (req.targetWeightKg != null && preview.mode !== 'full') {
      throw new DomainError(ERROR_CODES.PLAN_NOT_ELIGIBLE, 'A target weight is only available in full mode (OQ-15)');
    }
    const t = result.targets;
    const doc = await this.activate(userId, {
      source: req.source,
      energyKcal: t?.energyKcal ?? null,
      proteinG: t?.proteinG ?? null,
      carbsG: t?.carbsG ?? null,
      fatG: t?.fatG ?? null,
      waterMl: req.waterMl ?? preview.waterMl,
      method: t ? preview.method : null,
      goal: {
        ...preview.goal,
        targetWeightKg: req.targetWeightKg === undefined ? preview.goal.targetWeightKg : req.targetWeightKg,
      },
      inputs: preview.inputs,
      calculated: preview.calculated,
      confirmedAt: new Date(),
    });
    return this.toPlan(doc);
  }

  /** Confirms what the user reviewed. The same draft twice gives the same plan, never a second version. */
  private async confirmDraft(userId: string, req: ConfirmPlanRequest, draftId: string): Promise<Plan> {
    const uid = new Types.ObjectId(userId);
    const draft = await this.drafts.findOne({ _id: new Types.ObjectId(draftId), userId: uid }).lean<PlanDraftDoc>();
    if (!draft) throw ApiError.notFound(ERROR_CODES.PLAN_DRAFT_NOT_FOUND, 'That plan could not be found. Prepare it again.');
    const profile = await this.profileOf(userId);
    if (draft.inputHash !== planInputHash(profile ?? {}, profile?.attestation ?? null)) {
      throw ApiError.conflict(ERROR_CODES.PLAN_DRAFT_STALE, 'Your answers changed after this plan was prepared. Prepare it again before confirming.');
    }
    const active = await this.active(userId);
    const sameChoice = (a: PlanDoc): boolean =>
      a.source === req.source &&
      (req.source === 'none' || req.source === 'calculated' || (a.energyKcal === req.energyKcal && (req.proteinG === undefined || a.proteinG === req.proteinG)));
    if (active?.draftId?.toString() === draftId && sameChoice(active)) return this.toPlan(active);

    if (req.source !== 'none' && draft.status !== 'ready') {
      throw new DomainError(ERROR_CODES.PLAN_NOT_ELIGIBLE, 'Energy targets are not available for this profile', { reasons: reasonsOf(draft.assessment) });
    }
    const result = validateTargets(draft.preview, req);
    if (!result.ok) throw new DomainError(result.code, result.message, result.details);
    const t = result.targets;
    const preview = draft.preview;
    // The target weight can only change through the answers (and a new draft), never at confirm time: it was checked when the draft was made.
    if (req.targetWeightKg !== undefined && req.targetWeightKg !== preview.goal.targetWeightKg) {
      throw new DomainError(ERROR_CODES.VALIDATION_FAILED, 'The target weight changes through your answers, then the plan is prepared again', { field: 'targetWeightKg' });
    }
    // No calorie plan, no weight goal: habits-only (including a ready draft the user turns down) keeps no weights.
    const habits = !t || draft.status !== 'ready';
    const draftLocale = parseLocale(draft.locale) ?? DEFAULT_LOCALE;
    const trDraft = translatorFor(draftLocale);
    const timeframe = t && draft.timeframe && preview.tdeeKcal !== null ? retimeFrame(draft.timeframe, preview.tdeeKcal, t.energyKcal, trDraft) : null;
    // Adjusted targets: the stored basis describes what the user confirmed, in the language the draft was made in.
    const basis = t ? (req.source === 'calculated' ? draft.basis : buildBasis(preview, assessInputsFrom(profile, profile?.attestation), timeframe, trDraft, t.energyKcal)) : [];

    const doc = await this.activate(userId, {
      source: req.source,
      energyKcal: t?.energyKcal ?? null,
      proteinG: t?.proteinG ?? null,
      carbsG: t?.carbsG ?? null,
      fatG: t?.fatG ?? null,
      waterMl: req.waterMl ?? preview.waterMl,
      method: t ? preview.method : null,
      goal: habits ? { type: 'habits', startWeightKg: null, targetWeightKg: null, pace: null } : preview.goal,
      inputs: t ? preview.inputs : null,
      calculated: t ? preview.calculated : null,
      confirmedAt: new Date(),
      draftId: draft._id,
      timeframe,
      narrative: t ? draft.narrative : null,
      basis,
      ai: t ? draft.ai : null,
      locale: draftLocale,
    });
    await this.drafts.updateOne({ _id: draft._id }, { $set: { confirmedAt: new Date() } });
    return this.toPlan(doc);
  }

  /** Writes a new plan version and makes it the only active one, in one transaction. */
  private async activate(
    userId: string,
    fields: Omit<PlanDoc, '_id' | 'userId' | 'active' | 'version' | 'createdAt' | 'draftId' | 'timeframe' | 'narrative' | 'basis' | 'ai' | 'locale'> &
      Partial<Pick<PlanDoc, 'draftId' | 'timeframe' | 'narrative' | 'basis' | 'ai' | 'locale'>>,
  ): Promise<PlanDoc> {
    const uid = new Types.ObjectId(userId);
    let created: PlanDoc | undefined;
    const write = () =>
      this.conn.transaction(async (session) => {
        const latest = await this.plans.findOne({ userId: uid }).sort({ version: -1 }).session(session).lean<PlanDoc>();
        await this.plans.updateMany({ userId: uid, active: true }, { $set: { active: false } }, { session });
        const [doc] = await this.plans.create(
          [{ draftId: null, timeframe: null, narrative: null, basis: [], ai: null, locale: null, ...fields, userId: uid, active: true, version: (latest?.version ?? 0) + 1 }],
          { session },
        );
        created = doc!.toObject() as PlanDoc;
      });
    try {
      await write();
    } catch (e) {
      const code = (e as { code?: number }).code;
      const labels = (e as { errorLabels?: string[] }).errorLabels ?? [];
      if (code !== 11000 && !labels.includes('TransientTransactionError')) throw e;
      try {
        await write(); // a concurrent confirm took the version number: try once more with the new latest
      } catch {
        throw ApiError.conflict(ERROR_CODES.CONFLICT, 'Your plan was changed at the same moment. Check it and try again.');
      }
    }
    return created!;
  }

  /** BR-11 / plan 8.8 rule 3: habits-only users never keep energy targets; never reuse an old target. */
  async enforceHabitsOnly(userId: string): Promise<void> {
    const active = await this.plans.findOne({ userId: new Types.ObjectId(userId), active: true }).lean<PlanDoc>();
    if (!active || active.energyKcal === null) return;
    await this.activate(userId, {
      source: 'none',
      energyKcal: null,
      proteinG: null,
      carbsG: null,
      fatG: null,
      waterMl: active.waterMl,
      method: null,
      goal: { type: active.goal.type, startWeightKg: null, targetWeightKg: null, pace: null },
      inputs: null,
      calculated: null,
      confirmedAt: new Date(),
    });
  }

  async active(userId: string): Promise<PlanDoc | null> {
    return this.plans.findOne({ userId: new Types.ObjectId(userId), active: true }).lean<PlanDoc>();
  }

  async get(userId: string): Promise<Plan> {
    const doc = await this.active(userId);
    if (!doc) throw ApiError.notFound(ERROR_CODES.PLAN_NOT_FOUND, 'No plan has been confirmed yet');
    return this.toPlan(doc);
  }

  toPlan(d: PlanDoc): Plan {
    return {
      id: d._id.toString(),
      version: d.version,
      active: d.active,
      source: d.source,
      energyKcal: d.energyKcal,
      proteinG: d.proteinG,
      carbsG: d.carbsG,
      fatG: d.fatG,
      waterMl: d.waterMl,
      method: d.method,
      goal: {
        type: d.goal.type,
        startWeightKg: d.goal.startWeightKg ?? null,
        targetWeightKg: d.goal.targetWeightKg ?? null,
        pace: d.goal.pace ?? null,
      },
      calculated: d.calculated ?? null,
      confirmedAt: d.confirmedAt ? d.confirmedAt.toISOString() : null,
      createdAt: new Date(d.createdAt).toISOString(),
      draftId: d.draftId ? d.draftId.toString() : null,
      timeframe: d.timeframe ?? null,
      narrative: d.narrative ?? null,
      basis: d.basis ?? [],
      ai: d.ai ?? null,
      locale: d.locale ?? null,
    };
  }

  private toDraft(d: PlanDraftDoc, stale: boolean): PlanDraft {
    return {
      id: d._id.toString(),
      status: d.status,
      inputHash: d.inputHash,
      stale,
      createdAt: new Date(d.createdAt).toISOString(),
      assessment: d.assessment,
      preview: d.preview,
      timeframe: d.timeframe ?? null,
      basis: d.basis ?? [],
      narrative: d.narrative ?? null,
      ai: d.ai,
      notice: d.notice ?? null,
      regenerations: d.regenerations ?? 0,
      confirmed: Boolean(d.confirmedAt),
      locale: d.locale ?? DEFAULT_LOCALE,
    };
  }
}
