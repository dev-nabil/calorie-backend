import { z } from 'zod';

const reason = z.string().trim().min(5).max(500).describe('Audit reason (required on every admin write)');
const role = z.enum(['owner', 'admin', 'support', 'editor', 'analyst']);

export const AdminLoginRequestSchema = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(200) }).meta({ id: 'AdminLoginRequest' });
export const AdminTotpRequestSchema = z.strictObject({ challengeId: z.string().min(10).max(200), code: z.string().regex(/^\d{6}$/) }).meta({ id: 'AdminTotpRequest' });
export const AdminSessionSchema = z
  .object({ adminId: z.string(), email: z.string(), role, expiresAt: z.string(), idleTimeoutSec: z.number().int() })
  .meta({ id: 'AdminSession' });
/** TOTP on: a challenge to answer at auth/totp. TOTP off (ADMIN_TOTP_REQUIRED=false, dev only): the session is already set. */
export const AdminLoginResponseSchema = z
  .discriminatedUnion('totpRequired', [
    z.object({ totpRequired: z.literal(true), challengeId: z.string() }),
    z.object({ totpRequired: z.literal(false), session: AdminSessionSchema }),
  ])
  .meta({ id: 'AdminLoginResponse' });

const entitlement = z.object({
  plan: z.enum(['free', 'plus']),
  period: z.enum(['monthly', 'yearly']).optional(),
  activeUntil: z.string().optional(),
  source: z.enum(['app_store', 'play_store', 'promo']).optional(),
});
export const AdminUserSummarySchema = z
  .object({
    id: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    status: z.enum(['active', 'disabled', 'pending_deletion', 'deleted']),
    entitlement,
    freeScans: z.object({ allowance: z.number().int(), used: z.number().int() }),
    platform: z.enum(['ios', 'android']),
    createdAt: z.string(),
    lastActiveAt: z.string().nullable(),
  })
  .meta({ id: 'AdminUserSummary' });
export const AdminUserListSchema = z.object({ items: z.array(AdminUserSummarySchema), nextCursor: z.string().nullable(), total: z.number().int() }).meta({ id: 'AdminUserList' });
export const AdminUserDetailSchema = AdminUserSummarySchema.extend({
  timezone: z.string(),
  units: z.enum(['metric', 'imperial']),
  emailVerified: z.boolean(),
  authProviders: z.array(z.enum(['email', 'google', 'apple'])),
  onboarding: z.object({ route: z.enum(['basic', 'detailed', 'conversation']).nullable(), completedAt: z.string().nullable(), deferredCount: z.number().int() }),
  plan: z.object({ mode: z.enum(['targets', 'habits_only']), energyKcal: z.number().nullable() }).nullable(),
  usage: z.object({ scansTotal: z.number().int(), scansThisMonth: z.number().int(), coachTurns30d: z.number().int(), mealsLogged30d: z.number().int(), streakDays: z.number().int() }),
  devices: z.array(z.object({ deviceId: z.string(), platform: z.enum(['ios', 'android']), appVersion: z.string(), lastSeenAt: z.string(), integrityVerifiedAt: z.string().nullable(), pushEnabled: z.boolean() })),
  recentActivity: z.array(z.object({ at: z.string(), kind: z.string(), summary: z.string() })),
  deletionRequestedAt: z.string().nullable(),
}).meta({ id: 'AdminUserDetail' });

export const AdminUserListQuerySchema = z.strictObject({
  query: z.string().max(100).optional(),
  plan: z.enum(['free', 'plus']).optional(),
  status: z.enum(['active', 'disabled', 'pending_deletion', 'deleted']).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const AdminPatchUserRequestSchema = z.strictObject({ reason, status: z.enum(['active', 'disabled']) }).meta({ id: 'AdminPatchUserRequest' });
export const AdminGrantEntitlementRequestSchema = z.strictObject({ reason, plan: z.literal('plus'), days: z.number().int().min(1).max(400) }).meta({ id: 'AdminGrantEntitlementRequest' });
export const AdminFreeScansRequestSchema = z.strictObject({ reason, count: z.number().int().min(1).max(100) }).meta({ id: 'AdminFreeScansRequest' });
export const AdminReasonRequestSchema = z.strictObject({ reason }).meta({ id: 'AdminReasonRequest' });

export const AdminContentPutSchema = z
  .strictObject({ reason, baseVersion: z.number().int().min(1), data: z.record(z.string(), z.unknown()) })
  .meta({ id: 'AdminContentPut', description: 'Copy-only edit; 409 CONFLICT when baseVersion is not the latest' });
export const AdminContentDocSchema = z
  .object({ kind: z.enum(['onboarding_questions', 'conversation', 'milo_lines']), version: z.number().int(), data: z.record(z.string(), z.unknown()), publishedAt: z.string(), publishedBy: z.string() })
  .meta({ id: 'AdminContentDoc' });

export const AdminFlagSchema = z.object({ key: z.string(), description: z.string(), enabled: z.boolean(), updatedAt: z.string(), updatedBy: z.string() }).meta({ id: 'AdminFlag' });
export const AdminPutFlagRequestSchema = z.strictObject({ reason, key: z.string().min(1).max(64), enabled: z.boolean() }).meta({ id: 'AdminPutFlagRequest' });

export const AdminExperimentSchema = z
  .object({
    key: z.string(),
    description: z.string(),
    status: z.enum(['draft', 'running', 'stopped']),
    allocationPct: z.number().min(0).max(100),
    variants: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(100), value: z.union([z.string(), z.number(), z.boolean()]) })),
    startedAt: z.string().nullable(),
    stoppedAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: 'AdminExperiment' });
export const AdminPutExperimentRequestSchema = z
  .strictObject({
    reason,
    experiment: z.strictObject({
      key: z.string().min(1).max(64),
      status: z.enum(['draft', 'running', 'stopped']),
      allocationPct: z.number().min(0).max(100),
      variants: z.array(z.strictObject({ id: z.string().min(1).max(32), weight: z.number().min(0).max(100), value: z.union([z.string(), z.number(), z.boolean()]) })).min(1).max(10),
    }),
  })
  .meta({ id: 'AdminPutExperimentRequest' });

export const AdminMinAppVersionSchema = z.object({ ios: z.string(), android: z.string(), updatedAt: z.string(), updatedBy: z.string() }).meta({ id: 'AdminMinAppVersion' });
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'Expected x.y.z');
export const AdminPutMinAppVersionRequestSchema = z.strictObject({ reason, ios: semver, android: semver }).meta({ id: 'AdminPutMinAppVersionRequest' });

export const AdminKillSwitchRequestSchema = z
  .strictObject({ reason, key: z.enum(['ai.kill.vision', 'ai.kill.chat', 'ai.kill.extract', 'ai.kill.tts']), enabled: z.boolean() })
  .meta({ id: 'AdminKillSwitchRequest' });

export const AdminPageQuerySchema = z.strictObject({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  query: z.string().max(100).optional(),
  format: z.enum(['json', 'csv']).optional(),
});
export const AdminAuditQuerySchema = z.strictObject({
  action: z.string().max(64).optional(),
  actor: z.string().max(64).optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const AdminWaitlistEntrySchema = z
  .object({ id: z.string(), email: z.string(), source: z.string(), utm: z.record(z.string(), z.string()), createdAt: z.string(), confirmedAt: z.string().nullable() })
  .meta({ id: 'AdminWaitlistEntry' });
export const AdminAuditLogSchema = z
  .object({
    id: z.string(),
    actorType: z.enum(['admin', 'system']),
    actorId: z.string(),
    actorEmail: z.string().nullable(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string().nullable(),
    reason: z.string().nullable(),
    diff: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'AdminAuditLog' });
export const AdminMetricsOverviewSchema = z.record(z.string(), z.unknown()).meta({ id: 'AdminMetricsOverview', description: 'See nouri-frontend MetricsOverview' });

export const AdminKillSwitchSchema = z
  .object({ key: z.string(), label: z.string(), enabled: z.boolean(), reason: z.string().nullable(), updatedAt: z.string(), updatedBy: z.string() })
  .meta({ id: 'AdminKillSwitch' });

const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export const AdminStatusResultSchema = z.object({ status: z.string() }).meta({ id: 'AdminStatusResult' });
export const AdminDeleteUserResultSchema = z.object({ status: z.literal('pending_deletion'), purgeAfter: z.string() }).meta({ id: 'AdminDeleteUserResult' });
export const AdminEntitlementResultSchema = z
  .object({ id: z.string(), entitlement: z.object({ plan: z.literal('plus'), activeUntil: z.string(), source: z.literal('promo') }) })
  .meta({ id: 'AdminEntitlementResult' });
export const AdminFreeScansResultSchema = z.object({ id: z.string(), freeScans: z.object({ allowance: z.number().int(), used: z.number().int() }) }).meta({ id: 'AdminFreeScansResult' });
export const AdminUserMealListSchema = page(
  z.object({ id: z.string(), loggedAt: z.string(), dayKey: z.string(), category: z.string(), name: z.string(), kcal: z.number(), source: z.string() }),
).meta({ id: 'AdminUserMealList' });
export const AdminUserScanListSchema = page(
  z.object({ id: z.string(), status: z.string(), queuedAt: z.string(), finishedAt: z.string().nullable(), kcal: z.number().nullable(), confidence: z.number().nullable() }),
).meta({ id: 'AdminUserScanList' });
export const AdminAdminUserSchema = z
  .object({ id: z.string(), email: z.string(), role: z.string(), status: z.string(), totpEnabled: z.boolean(), lastLoginAt: z.string().nullable(), createdAt: z.string() })
  .meta({ id: 'AdminAdminUser' });
export const AdminSubscriptionListSchema = page(
  z.object({
    id: z.string(),
    userId: z.string(),
    userEmail: z.string(),
    product: z.enum(['plus_monthly', 'plus_yearly']),
    store: z.enum(['app_store', 'play_store', 'promo']),
    status: z.string(),
    autoRenew: z.boolean(),
    startedAt: z.string().nullable(),
    currentPeriodEnd: z.string().nullable(),
    gracePeriodEndsAt: z.string().nullable(),
  }),
).meta({ id: 'AdminSubscriptionList' });
export const AdminBillingEventListSchema = page(
  z.object({
    id: z.string(),
    externalId: z.string(),
    userId: z.string(),
    type: z.string(),
    store: z.enum(['app_store', 'play_store']),
    product: z.enum(['plus_monthly', 'plus_yearly']),
    receivedAt: z.string().nullable(),
    processedAt: z.string().nullable(),
    status: z.enum(['processed', 'failed', 'pending']),
    error: z.string().nullable(),
  }),
).meta({ id: 'AdminBillingEventList' });

const planLimits = z.object({ scans: z.number().int().min(0), describePerDay: z.number().int().min(0), coachPerDay: z.number().int().min(0), spokenRepliesPerDay: z.number().int().min(0), maxReplyTokens: z.number().int().min(50).max(4000) });
export const AdminAiSettingsBodySchema = z.object({
  models: z.record(z.enum(['vision', 'extract', 'chat', 'stt', 'tts', 'moderation']), z.string().min(1).max(100)),
  limits: z.object({
    free: planLimits.extend({ scansLifetime: z.number().int().min(0).max(100) }),
    plus: planLimits.extend({ scansPerMonthSoftCap: z.number().int().min(0) }),
    image: z.object({ maxEdgePx: z.number().int().min(256).max(4096), maxBytes: z.number().int().min(100_000).max(10_000_000) }),
  }),
  budget: z.object({ monthlyLimitUsd: z.number().min(0), alertPct: z.number().min(1).max(100), downgradePct: z.number().min(1).max(100) }),
});
export const AdminAiSettingsSchema = AdminAiSettingsBodySchema.extend({
  killSwitches: z.array(AdminKillSwitchSchema),
  updatedAt: z.string(),
  updatedBy: z.string(),
}).meta({ id: 'AdminAiSettings' });
export const AdminPutAiSettingsSchema = AdminAiSettingsBodySchema.extend({ reason }).strict().meta({ id: 'AdminPutAiSettings' });

export const PROMPT_KEYS = ['meal-scan', 'meal-parse', 'onboarding-extract', 'coach'] as const;
const promptParams = z.object({ temperature: z.number().min(0).max(2), maxOutputTokens: z.number().int().min(16).max(8000) });
export const AdminPromptSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    version: z.number().int(),
    staticPrefix: z.string(),
    content: z.string(),
    model: z.string(),
    params: promptParams,
    active: z.boolean(),
    notes: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
    activatedAt: z.string().nullable(),
  })
  .meta({ id: 'AdminPrompt' });
export const AdminCreatePromptSchema = z
  .strictObject({ reason, key: z.enum(PROMPT_KEYS), staticPrefix: z.string().min(1).max(60_000), content: z.string().min(1).max(60_000), model: z.string().max(100), params: promptParams, notes: z.string().max(2000) })
  .meta({ id: 'AdminCreatePrompt' });
export const AdminPatchPromptSchema = z
  .strictObject({ reason, notes: z.string().max(2000).optional(), content: z.string().min(1).max(60_000).optional(), staticPrefix: z.string().min(1).max(60_000).optional(), params: promptParams.optional(), model: z.string().max(100).optional() })
  .meta({ id: 'AdminPatchPrompt' });
export const AdminPromptTestSchema = z.strictObject({ promptId: z.string().regex(/^[a-f0-9]{24}$/), input: z.string().min(1).max(4000) }).meta({ id: 'AdminPromptTest' });
export const AdminPromptTestResultSchema = z
  .object({ output: z.string(), latencyMs: z.number().int(), usage: z.object({ inputTokens: z.number(), cachedTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }) })
  .meta({ id: 'AdminPromptTestResult' });
export const AdminScanListSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        userId: z.string(),
        status: z.string(),
        model: z.string(),
        promptKey: z.string(),
        promptVersion: z.number().int(),
        error: z.object({ code: z.string(), message: z.string() }).nullable(),
        confidence: z.number().nullable(),
        attempts: z.number().int(),
        queuedAt: z.string(),
        finishedAt: z.string().nullable(),
        costUsd: z.number(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'AdminScanList' });
export const AdminAiUsageSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    days: z.array(z.object({ date: z.string(), feature: z.string(), model: z.string(), requests: z.number(), inputTokens: z.number(), cachedTokens: z.number(), outputTokens: z.number(), costUsd: z.number() })),
    monthlyBudgetUsd: z.number(),
    monthToDateUsd: z.number(),
  })
  .meta({ id: 'AdminAiUsage' });
export const AdminSloReportSchema = z
  .object({
    generatedAt: z.string(),
    items: z.array(z.object({ key: z.string(), name: z.string(), target: z.string(), current: z.string(), status: z.enum(['ok', 'at_risk', 'breached']), budgetRemainingPct: z.number() })),
  })
  .meta({ id: 'AdminSloReport' });
export const AdminUserConversationListSchema = z
  .object({ items: z.array(z.object({ id: z.string(), kind: z.enum(['onboarding', 'coach']), startedAt: z.string(), turns: z.number().int() })), nextCursor: z.string().nullable() })
  .meta({ id: 'AdminUserConversationList' });
export const AdminInviteSchema = z.strictObject({ reason, email: z.email().max(254), role }).meta({ id: 'AdminInvite' });
export const AdminPatchAdminUserSchema = z
  .strictObject({ reason, role: role.optional(), status: z.enum(['active', 'invited', 'deactivated']).optional() })
  .meta({ id: 'AdminPatchAdminUser' });
export const AdminAcceptInviteSchema = z.strictObject({ token: z.string().min(20).max(200), password: z.string().min(12).max(200) }).meta({ id: 'AdminAcceptInvite' });
export const AdminAcceptInviteResultSchema = z.object({ email: z.string(), totpSecret: z.string(), otpauthUrl: z.string() }).meta({ id: 'AdminAcceptInviteResult' });
