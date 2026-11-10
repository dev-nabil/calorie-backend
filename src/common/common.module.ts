import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccessTokenGuard } from './auth/access-token.guard';
import { TokenService } from './auth/token.service';
import { ErrorFilter } from './errors/error.filter';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { SanitizeInterceptor } from './http/sanitize.interceptor';
import { IntegrityVerifier } from './integrity/integrity';
import { IntegrityGuard } from './integrity/integrity.guard';
import { IntegritySettings, SettingsIntegrityVerifier } from './integrity/integrity-settings';
import { RateLimiter } from './rate-limit/rate-limiter.service';
import { DailyQuota } from './rate-limit/daily-quota';

/** Cross-cutting HTTP concerns: auth guard, integrity guard, idempotency, error shape. */
@Global()
@Module({
  providers: [
    TokenService,
    RateLimiter,
    DailyQuota,
    IntegritySettings,
    { provide: IntegrityVerifier, inject: [IntegritySettings], useFactory: (source: IntegritySettings) => new SettingsIntegrityVerifier(source) },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: IntegrityGuard },
    { provide: APP_INTERCEPTOR, useClass: SanitizeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
  exports: [TokenService, RateLimiter, DailyQuota, IntegrityVerifier, IntegritySettings],
})
export class CommonModule {}
