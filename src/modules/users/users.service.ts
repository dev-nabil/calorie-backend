import { clock } from '../../common/clock';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { ERROR_CODES, type Me, type UpdateMeRequest } from '../../shared';
import { entitlementView, freeScansRemaining, hmacEmail, isVerifiedAccount } from '../../domain/entitlements';
import { ApiError } from '../../common/errors/api-error';
import { LOCALES, localeTag, parseLocale } from '../../shared/locales';
import { TokenService } from '../../common/auth/token.service';
import type { ScanLedgerDoc, UserDoc } from './users.schemas';

export const DELETION_GRACE_DAYS = 30; // BR-13

@Injectable()
export class UsersService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectModel('User') readonly users: Model<UserDoc>,
    @InjectModel('ScanLedger') private readonly ledger: Model<ScanLedgerDoc>,
    @InjectModel('Session') private readonly sessions: Model<{ userId: Types.ObjectId; revokedAt: Date | null }>,
    private readonly tokens: TokenService,
  ) {}

  ledgerKey(email: string): string {
    return hmacEmail(email, this.config.LEDGER_PEPPER);
  }

  async ledgerUsed(email: string): Promise<number> {
    const doc = await this.ledger.findOne({ emailHmac: this.ledgerKey(email) }).lean();
    return doc?.freeScansUsed ?? 0;
  }

  async findById(id: string): Promise<UserDoc | null> {
    return Types.ObjectId.isValid(id) ? this.users.findById(id).lean<UserDoc>() : null;
  }

  /** Loads the signed-in user; deleted or disabled accounts are refused (BR-13). */
  async requireActive(id: string): Promise<UserDoc> {
    const user = await this.findById(id);
    if (!user) throw ApiError.unauthenticated();
    if (user.status === 'disabled') throw ApiError.forbidden(ERROR_CODES.ACCOUNT_DISABLED, 'This account is disabled');
    if (user.status !== 'active') throw ApiError.forbidden(ERROR_CODES.ACCOUNT_DELETED, 'This account is being deleted');
    return user;
  }

  /** A new account starts with the free-scan count already used by this email (BR-01). */
  async create(input: {
    email: string;
    emailVerified: boolean;
    provider: { provider: 'email' | 'google' | 'apple'; subject: string; emailVerified: boolean };
    displayName?: string | null;
  }): Promise<UserDoc> {
    const now = clock.now();
    const used = await this.ledgerUsed(input.email);
    const doc = await this.users.create({
      email: input.email,
      emailVerifiedAt: input.emailVerified ? now : null,
      authProviders: [{ ...input.provider, linkedAt: now }],
      displayName: input.displayName ?? null,
      freeScans: { allowance: this.config.FREE_SCANS, used },
    });
    return doc.toObject() as UserDoc;
  }

  toMe(user: UserDoc, now = clock.now()): Me {
    const ledgerUsed = user.freeScans.used;
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    return {
      id: user._id.toString(),
      email: user.email,
      emailVerified: isVerifiedAccount(user),
      authProviders: [...new Set(user.authProviders.map((p) => p.provider))],
      displayName: user.displayName ?? null,
      locale: user.locale,
      timezone: user.timezone,
      units: user.units,
      status: user.status,
      entitlement: entitlementView(user.entitlement, now),
      freeScans: {
        allowance: user.freeScans.allowance,
        used: user.freeScans.used,
        remaining: freeScansRemaining({ allowance: user.freeScans.allowance, used: user.freeScans.used, ledgerUsed }),
      },
      consents: {
        termsVersion: user.consents.termsVersion ?? null,
        termsAt: iso(user.consents.termsAt),
        privacyVersion: user.consents.privacyVersion ?? null,
        privacyAt: iso(user.consents.privacyAt),
        healthDataAt: iso(user.consents.healthDataAt),
        marketingAt: iso(user.consents.marketingAt),
      },
      flags: { analyticsOptOut: Boolean(user.flags?.analyticsOptOut), voiceReplies: Boolean(user.flags?.voiceReplies) },
      experiments: Object.fromEntries(
        user.experiments instanceof Map ? user.experiments : Object.entries(user.experiments ?? {}),
      ),
      createdAt: new Date(user.createdAt).toISOString(),
    };
  }

  async update(id: string, patch: UpdateMeRequest): Promise<UserDoc> {
    await this.requireActive(id);
    const now = clock.now();
    const set: Record<string, unknown> = {};
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.locale) {
      const code = parseLocale(patch.locale);
      if (!code) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'That language is not supported yet', HttpStatus.BAD_REQUEST, { field: 'locale', supported: LOCALES.map((l) => l.tag) });
      set.locale = localeTag(code);
    }
    if (patch.timezone) set.timezone = patch.timezone;
    for (const [k, v] of Object.entries(patch.units ?? {})) set[`units.${k}`] = v;
    for (const [k, v] of Object.entries(patch.flags ?? {})) set[`flags.${k}`] = v;
    const c = patch.consents;
    if (c?.termsVersion) Object.assign(set, { 'consents.termsVersion': c.termsVersion, 'consents.termsAt': now });
    if (c?.privacyVersion) Object.assign(set, { 'consents.privacyVersion': c.privacyVersion, 'consents.privacyAt': now });
    if (c?.healthData) set['consents.healthDataAt'] = now;
    if (c?.marketing !== undefined) set['consents.marketingAt'] = c.marketing ? now : null;
    const user = await this.users.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after' }).lean<UserDoc>();
    if (patch.timezone) await this.onTimezoneChange?.(user!._id, patch.timezone);
    return user!;
  }

  /** BR-13: sign out at once, block sign-in, purge after 30 days (worker job). */
  async requestDeletion(id: string, now = clock.now()): Promise<{ purgeAfter: Date }> {
    await this.requireActive(id);
    await this.users.updateOne({ _id: id }, { $set: { status: 'pending_deletion', deletionRequestedAt: now } });
    await this.tokens.revokeAllAccess(id, now);
    await this.sessions.updateMany({ userId: new Types.ObjectId(id), revokedAt: null }, { $set: { revokedAt: now } });
    return { purgeAfter: new Date(now.getTime() + DELETION_GRACE_DAYS * 86_400_000) };
  }

  /** Set by the reminders module: recompute reminder times when the timezone changes (S-09). */
  onTimezoneChange?: (userId: Types.ObjectId, timezone: string) => Promise<void>;

  async touch(id: string): Promise<void> {
    await this.users.updateOne({ _id: id }, { $set: { lastActiveAt: new Date() } });
  }
}
