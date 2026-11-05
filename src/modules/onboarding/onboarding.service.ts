import { clock } from '../../common/clock';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type AnyBulkWriteOperation, type Model } from 'mongoose';
import {
  ERROR_CODES,
  type AnswerInput,
  type CompleteOnboardingResponse,
  type OnboardingAnswer,
  type OnboardingRoute,
  type OnboardingState,
  type Profile,
} from '../../shared';
import { dayKeyFor } from '../../domain/day-keys';
import { DomainError } from '../../domain/errors';
import {
  applyAnswers,
  applicableQuestions,
  deferUnanswered,
  deferredQuestions,
  isSettled,
  nextQuestion,
  profileFromAnswers,
  type AnswerMap,
  type EngineContext,
  type QuestionSet,
} from '../../domain/onboarding-engine';
import { assessEligibility, isSafetyReason } from '../../domain/plan-calculator';
import { ContentService } from '../content/content.service';
import { planInputsFrom, PlansService } from '../plans/plans.service';
import type { WeightLogDoc } from '../tracking/schemas/tracking.schema';
import { UsersService } from '../users/users.service';
import type { UserDoc } from '../users/schemas/users.schema';
import type { OnboardingAnswerDoc, ProfileDoc } from './schemas/onboarding.schema';

interface Loaded {
  user: UserDoc;
  set: QuestionSet;
  version: number;
  profile: ProfileDoc;
  docs: Map<string, OnboardingAnswerDoc>;
  answers: AnswerMap;
  ctx: EngineContext;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** M2-T3: server side of onboarding; the engine in domain/onboarding-engine decides everything. */
@Injectable()
export class OnboardingService {
  constructor(
    @InjectModel('OnboardingAnswer') private readonly answers: Model<OnboardingAnswerDoc>,
    @InjectModel('Profile') private readonly profiles: Model<ProfileDoc>,
    @InjectModel('WeightLog') private readonly weights: Model<WeightLogDoc>,
    private readonly content: ContentService,
    private readonly users: UsersService,
    private readonly plans: PlansService,
  ) {}

  private async load(userId: string, route?: OnboardingRoute): Promise<Loaded> {
    const user = await this.users.requireActive(userId);
    const { set, version } = await this.content.questionSet();
    const uid = new Types.ObjectId(userId);
    const profile =
      (await this.profiles.findOne({ userId: uid }).lean<ProfileDoc>()) ??
      ((await this.profiles.findOneAndUpdate(
        { userId: uid },
        { $setOnInsert: { userId: uid, 'onboarding.questionSetVersion': version } },
        { upsert: true, returnDocument: 'after' },
      ).lean<ProfileDoc>()) as ProfileDoc);
    const docs = new Map((await this.answers.find({ userId: uid }).lean<OnboardingAnswerDoc[]>()).map((d) => [d.questionId, d]));
    const answers: AnswerMap = {};
    for (const [id, d] of docs) answers[id] = { value: d.value, status: d.status, detail: d.detail, inputMethod: d.inputMethod };
    const ctx: EngineContext = { route: route ?? profile.onboarding.route, today: dayKeyFor(clock.now(), user.timezone) };
    return { user, set, version, profile, docs, answers, ctx };
  }

  /** Engine inputs for the conversation turn handler. */
  async snapshot(userId: string, route?: OnboardingRoute): Promise<{ set: QuestionSet; answers: AnswerMap; ctx: EngineContext; user: UserDoc; mode: ProfileDoc['mode'] }> {
    const l = await this.load(userId, route);
    return { set: l.set, answers: l.answers, ctx: l.ctx, user: l.user, mode: l.profile.mode };
  }

  async state(userId: string): Promise<OnboardingState> {
    return this.toState(await this.load(userId), []);
  }

  async setRoute(userId: string, route: OnboardingRoute): Promise<OnboardingState> {
    await this.profiles.updateOne({ userId: new Types.ObjectId(userId) }, { $set: { 'onboarding.route': route } }, { upsert: true });
    return this.state(userId);
  }

  /** PUT one answer or the DEC-18 bulk upload. Stale dependents are cleared (BR-11). */
  async save(userId: string, inputs: AnswerInput[], route?: OnboardingRoute): Promise<OnboardingState> {
    if (route) {
      await this.profiles.updateOne({ userId: new Types.ObjectId(userId) }, { $set: { 'onboarding.route': route } }, { upsert: true });
    }
    const l = await this.load(userId, route);
    // "Not asked yet" never overwrites a real answer or a decline: a device that missed an answer cannot wipe it.
    const updates = inputs.filter((i) => i.status !== 'deferred' || !isSettled(l.answers[i.questionId]));
    const result = applyAnswers(
      l.set,
      l.answers,
      updates.map((i) => ({ questionId: i.questionId, status: i.status, value: i.value, detail: i.detail ?? null, inputMethod: i.inputMethod })),
      l.ctx,
    );
    const at = new Map(inputs.map((i) => [i.questionId, i.answeredAt ? new Date(i.answeredAt) : new Date()]));
    await this.persist(l, result.answers, at);
    const next = { ...l, answers: result.answers };
    await this.rebuildProfile(next);
    return this.toState(await this.load(userId), result.cleared);
  }

  private async persist(l: Loaded, next: AnswerMap, at: Map<string, Date>): Promise<void> {
    const uid = l.user._id;
    const ops: AnyBulkWriteOperation<OnboardingAnswerDoc>[] = [];
    for (const [questionId, rec] of Object.entries(next)) {
      const prev = l.answers[questionId];
      if (prev && same(prev.value, rec.value) && prev.status === rec.status && same(prev.detail, rec.detail)) continue;
      const q = l.set.byId[questionId]!;
      const old = l.docs.get(questionId);
      ops.push({
        updateOne: {
          filter: { userId: uid, questionId },
          update: {
            $set: {
              fieldKey: q.fieldKey,
              value: rec.value ?? null,
              detail: rec.detail ?? null,
              status: rec.status,
              inputMethod: rec.inputMethod ?? old?.inputMethod ?? 'form',
              questionVersion: Number(q.version ?? 1),
              answeredAt: at.get(questionId) ?? new Date(),
            },
            ...(old
              ? { $push: { history: { $each: [{ value: old.value, detail: old.detail, status: old.status, at: old.answeredAt }], $slice: -10 } } }
              : {}),
          },
          upsert: true,
        },
      });
    }
    if (ops.length) await this.answers.bulkWrite(ops, { ordered: false });
  }

  /** profiles hold the current active values; habits-only never keeps energy targets. */
  private async rebuildProfile(l: Loaded, extra: Record<string, unknown> = {}): Promise<ProfileDoc> {
    const fields = profileFromAnswers(l.set, l.answers, l.ctx.today);
    const { mode, ...eligibility } = assessEligibility(planInputsFrom({ ...l.profile, ...fields } as ProfileDoc));
    const completed = (extra['onboarding.status'] ?? l.profile.onboarding.status) === 'completed';
    const deferredCount = completed ? deferredQuestions(l.set, l.answers, { ...l.ctx, route: 'detailed' }).length : 0;
    const profile = await this.profiles
      .findOneAndUpdate(
        { userId: l.user._id },
        { $set: { ...fields, mode, eligibility, 'onboarding.deferredCount': deferredCount, 'onboarding.questionSetVersion': l.version, ...extra } },
        { upsert: true, returnDocument: 'after' },
      )
      .lean<ProfileDoc>();
    if (fields.displayName && fields.displayName !== l.user.displayName) {
      await this.users.users.updateOne({ _id: l.user._id }, { $set: { displayName: fields.displayName.slice(0, 50) } });
    }
    // Under 18 / unknown age, pregnant or breastfeeding, or underweight with a loss goal: no calorie plan stays active.
    if (mode === 'habits_only' || eligibility.reasons.some(isSafetyReason)) await this.plans.enforceHabitsOnly(l.user._id.toString());
    return profile!;
  }

  /** POST /onboarding/complete: defer what was not asked, build the profile and a plan preview. */
  async complete(userId: string): Promise<CompleteOnboardingResponse> {
    const l = await this.load(userId);
    if (l.answers.q01?.status !== 'answered') {
      throw new DomainError(ERROR_CODES.ANSWER_REQUIRED, 'The main goal (q01) is required before finishing (BR-10)', { questionId: 'q01' });
    }
    const { answers } = deferUnanswered(l.set, l.answers, { ...l.ctx, route: 'detailed' });
    await this.persist(l, answers, new Map());
    const next = { ...l, answers };
    const profile = await this.rebuildProfile(next, {
      'onboarding.status': 'completed',
      'onboarding.completedAt': l.profile.onboarding.completedAt ?? new Date(),
    });
    if (profile.weightKg != null) await this.seedWeight(l.user, profile);
    const preview = await this.plans.preview(userId);
    return { profile: this.toProfile(profile), preview };
  }

  /** The onboarding weight starts the weight history once (Progress goal card). */
  private async seedWeight(user: UserDoc, p: ProfileDoc): Promise<void> {
    const now = clock.now();
    await this.weights.updateOne(
      { userId: user._id, source: 'onboarding' },
      {
        $set: { weightKg: p.weightKg, isEstimate: p.weightIsEstimate },
        $setOnInsert: { date: dayKeyFor(now, user.timezone), timezone: user.timezone, loggedAt: now },
      },
      { upsert: true },
    );
  }

  async profile(userId: string): Promise<Profile> {
    const l = await this.load(userId);
    return this.toProfile(l.profile);
  }

  private toState(l: Loaded, cleared: string[]): OnboardingState {
    const completed = l.profile.onboarding.status === 'completed';
    const deferredIds = completed
      ? deferredQuestions(l.set, l.answers, { ...l.ctx, route: 'detailed' })
      : Object.entries(l.answers)
          .filter(([, r]) => r.status === 'deferred')
          .map(([id]) => id);
    const order = new Map(l.set.questions.map((q, i) => [q.id, i]));
    const answers: OnboardingAnswer[] = [...l.docs.values()]
      .sort((a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0))
      .map((d) => ({
        questionId: d.questionId,
        fieldKey: d.fieldKey,
        value: d.value ?? null,
        detail: d.detail ?? null,
        status: d.status,
        inputMethod: d.inputMethod,
        questionVersion: d.questionVersion,
        answeredAt: new Date(d.answeredAt).toISOString(),
      }));
    return {
      route: l.ctx.route,
      status: l.profile.onboarding.status,
      questionSetVersion: l.version,
      mode: l.profile.mode,
      answers,
      applicableQuestionIds: applicableQuestions(l.set, l.answers, l.ctx),
      nextQuestionId: nextQuestion(l.set, l.answers, l.ctx),
      deferredQuestionIds: deferredIds,
      deferredCount: deferredIds.length,
      cleared,
    };
  }

  toProfile(p: ProfileDoc): Profile {
    return {
      primaryGoal: p.primaryGoal ?? null,
      supportingGoals: p.supportingGoals ?? [],
      personalMotivation: p.personalMotivation ?? null,
      requestedFeatures: p.requestedFeatures ?? [],
      displayName: p.displayName ?? null,
      ageYears: p.ageYears ?? null,
      birthDate: p.birthDate ?? null,
      calculationSex: p.calculationSex ?? null,
      heightCm: p.heightCm ?? null,
      weightKg: p.weightKg ?? null,
      weightIsEstimate: Boolean(p.weightIsEstimate),
      targetWeightKg: p.targetWeightKg ?? null,
      activityLevel: p.activityLevel ?? null,
      dietPattern: p.dietPattern ?? null,
      mealSource: p.mealSource ?? null,
      nutritionFamiliarity: p.nutritionFamiliarity ?? null,
      startingMood: p.startingMood ?? null,
      habitPriorities: p.habitPriorities ?? [],
      loggingMethods: p.loggingMethods ?? [],
      mode: p.mode,
      eligibility: { adult: p.eligibility.adult, estimateAllowed: p.eligibility.estimateAllowed, reasons: p.eligibility.reasons },
      onboarding: {
        route: p.onboarding.route,
        status: p.onboarding.status,
        questionSetVersion: p.onboarding.questionSetVersion,
        completedAt: p.onboarding.completedAt ? new Date(p.onboarding.completedAt).toISOString() : null,
        deferredCount: p.onboarding.deferredCount,
      },
    };
  }
}
