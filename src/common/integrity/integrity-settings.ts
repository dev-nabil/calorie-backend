import { Inject, Injectable } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import type { DeviceDoc } from '../../modules/users/schemas/users.schema';
import { SettingsService } from '../../modules/settings/settings.service';
import { AppAttestVerifier } from './app-attest';
import { DeviceIntegrityVerifier } from './device-verifier';
import { AllowIntegrityVerifier, IntegrityVerifier, type IntegrityContext, type IntegrityResult } from './integrity';
import { googlePlayDecoder } from './play-integrity';

const KEYS = ['integrity.mode', 'integrity.enforce', 'integrity.apple.teamId', 'integrity.apple.allowDevelopment', 'integrity.android.package', 'auth.apple.bundleId'] as const;

/**
 * Builds the integrity verifiers from the admin settings `integrity.*` (plus the Play Integrity service
 * account from the environment) and rebuilds them when a setting changes.
 */
@Injectable()
export class IntegritySettings {
  private cached: { signature: string; appAttest: AppAttestVerifier; verifier: IntegrityVerifier; enforced: boolean } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(getModelToken('Device')) private readonly devices: Model<DeviceDoc>,
    private readonly settings: SettingsService,
  ) {}

  private async current() {
    const s = await this.settings.many(KEYS);
    const signature = JSON.stringify(s);
    if (this.cached?.signature === signature) return this.cached;
    const teamId = s['integrity.apple.teamId'];
    const pkg = s['integrity.android.package'];
    const serviceAccount = this.config.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON;
    const appAttest = new AppAttestVerifier(`${teamId || 'TEAMID'}.${s['auth.apple.bundleId'] || 'app.nouri'}`, this.config.APP_ATTEST_ROOT_PEM, s['integrity.apple.allowDevelopment']);
    const verifier =
      s['integrity.mode'] === 'device'
        ? new DeviceIntegrityVerifier(this.devices, teamId ? appAttest : null, pkg && serviceAccount ? { packageName: pkg, decode: googlePlayDecoder(pkg, serviceAccount) } : null)
        : new AllowIntegrityVerifier();
    this.cached = { signature, appAttest, verifier, enforced: s['integrity.enforce'] };
    return this.cached;
  }

  async appAttest(): Promise<AppAttestVerifier> {
    return (await this.current()).appAttest;
  }

  async enforced(): Promise<boolean> {
    return (await this.current()).enforced;
  }

  async verifier(): Promise<IntegrityVerifier> {
    return (await this.current()).verifier;
  }
}

/** The IntegrityVerifier everyone injects: delegates to the one the settings describe right now. */
export class SettingsIntegrityVerifier extends IntegrityVerifier {
  constructor(private readonly source: IntegritySettings) {
    super();
  }
  async verify(token: string, ctx: IntegrityContext): Promise<IntegrityResult> {
    return (await this.source.verifier()).verify(token, ctx);
  }
}
