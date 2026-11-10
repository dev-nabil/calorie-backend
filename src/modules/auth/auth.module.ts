import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { SettingsService } from '../settings/settings.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  AppleTokenVerifier,
  ConsoleEmailSender,
  EmailSender,
  GoogleAuthLibraryVerifier,
  GoogleTokenVerifier,
  JoseAppleVerifier,
  MemoryEmailSender,
  ResendEmailSender,
} from './providers';

/** Sign-in. Client IDs and the email sender are admin settings, read per call; the Resend key is a secret in the environment. */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: EmailSender,
      inject: [APP_CONFIG, SettingsService],
      useFactory: (c: AppConfig, settings: SettingsService): EmailSender =>
        c.emailDriver === 'resend'
          ? new ResendEmailSender(c.EMAIL_API_KEY ?? '', () => settings.get('email.from'))
          : c.emailDriver === 'memory'
            ? new MemoryEmailSender()
            : new ConsoleEmailSender(),
    },
    { provide: GoogleTokenVerifier, inject: [SettingsService], useFactory: (settings: SettingsService) => new GoogleAuthLibraryVerifier(() => settings.get('auth.google.clientIds')) },
    {
      provide: AppleTokenVerifier,
      inject: [SettingsService],
      useFactory: (settings: SettingsService) =>
        new JoseAppleVerifier(async () => {
          const s = await settings.many(['auth.apple.bundleId', 'auth.apple.serviceId']);
          return [s['auth.apple.bundleId'], s['auth.apple.serviceId']].filter(Boolean);
        }),
    },
  ],
  exports: [EmailSender],
})
export class AuthModule {}
