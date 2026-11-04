import { Global, Module } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import type { DeviceDoc } from '../modules/users/schemas/users.schema';
import { AppAttestVerifier } from './integrity/app-attest';
import { DeviceIntegrityVerifier } from './integrity/device-verifier';
import { googlePlayDecoder } from './integrity/play-integrity';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessTokenGuard } from './auth/access-token.guard';
import { TokenService } from './auth/token.service';
import { ErrorFilter } from './errors/error.filter';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { SanitizeInterceptor } from './http/sanitize.interceptor';
import { AllowIntegrityVerifier, IntegrityGuard, IntegrityVerifier } from './integrity/integrity';
import { RateLimiter } from './rate-limit/rate-limiter.service';
import { DailyQuota } from './rate-limit/daily-quota';

/** Cross-cutting HTTP concerns: auth guard, integrity guard, idempotency, error shape. */
@Global()
@Module({
  providers: [
    TokenService,
    RateLimiter,
    DailyQuota,
    {
      provide: AppAttestVerifier,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        new AppAttestVerifier(`${c.APPLE_APP_ATTEST_TEAM_ID ?? 'TEAMID'}.${c.APPLE_BUNDLE_ID ?? 'app.nouri'}`, c.APP_ATTEST_ROOT_PEM, c.APP_ATTEST_ALLOW_DEVELOPMENT ? c.APP_ATTEST_ALLOW_DEVELOPMENT === 'true' : !c.isProduction),
    },
    {
      provide: IntegrityVerifier,
      inject: [APP_CONFIG, getModelToken('Device'), AppAttestVerifier],
      useFactory: (c: AppConfig, devices: Model<DeviceDoc>, appAttest: AppAttestVerifier): IntegrityVerifier =>
        c.INTEGRITY_DRIVER === 'device'
          ? new DeviceIntegrityVerifier(
              devices,
              c.APPLE_APP_ATTEST_TEAM_ID ? appAttest : null,
              c.PLAY_INTEGRITY_PACKAGE && c.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON
                ? { packageName: c.PLAY_INTEGRITY_PACKAGE, decode: googlePlayDecoder(c.PLAY_INTEGRITY_PACKAGE, c.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON) }
                : null,
            )
          : new AllowIntegrityVerifier(),
    },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: IntegrityGuard },
    { provide: APP_INTERCEPTOR, useClass: SanitizeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
  exports: [TokenService, RateLimiter, DailyQuota, IntegrityVerifier, AppAttestVerifier],
})
export class CommonModule {}
