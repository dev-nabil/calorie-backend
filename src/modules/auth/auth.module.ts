import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
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

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: EmailSender,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): EmailSender =>
        c.EMAIL_DRIVER === 'resend'
          ? new ResendEmailSender(c.EMAIL_API_KEY ?? '', c.EMAIL_FROM)
          : c.EMAIL_DRIVER === 'memory'
            ? new MemoryEmailSender()
            : new ConsoleEmailSender(),
    },
    { provide: GoogleTokenVerifier, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new GoogleAuthLibraryVerifier(c.GOOGLE_CLIENT_IDS) },
    {
      provide: AppleTokenVerifier,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => new JoseAppleVerifier([c.APPLE_BUNDLE_ID, c.APPLE_SERVICE_ID].filter((v): v is string => Boolean(v))),
    },
  ],
  exports: [EmailSender],
})
export class AuthModule {}
