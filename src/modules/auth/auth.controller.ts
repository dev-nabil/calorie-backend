import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  AppleSignInRequestSchema,
  AuthSessionSchema,
  EmailStartRequestSchema,
  EmailStartResponseSchema,
  EmailVerifyRequestSchema,
  GoogleSignInRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  type AppleSignInRequest,
  type AuthSession,
  type DeviceInfo,
  type EmailStartResponse,
  type GoogleSignInRequest,
  type LogoutRequest,
  type RefreshRequest,
} from '../../shared';
import { CurrentUser, Public, type AuthUser } from '../../common/auth/auth.decorators';
import { RequireIntegrity } from '../../common/integrity/integrity';
import { ApiErrors, ZBody, ZResponse } from '../../common/zod/decorators';
import { AuthService, type RequestMeta } from './auth.service';

type EmailVerifyBody = { email: string; code: string; device?: DeviceInfo };

const meta = (req: Request): RequestMeta => ({ ip: req.ip ?? 'unknown', deviceId: req.header('X-Device-Id') ?? undefined });

/** M1: sign-in endpoints. Auth POSTs do not create user resources and are not idempotency-keyed. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RequireIntegrity()
  @Post('email/start')
  @HttpCode(200)
  @ApiHeader({ name: 'X-Device-Id', required: false, description: 'Stable device id for per-device rate limits' })
  @ZResponse(200, EmailStartResponseSchema, 'Code sent (6 digits, 10 minutes)')
  @ApiErrors(400, 403, 422, 429)
  async start(@ZBody(EmailStartRequestSchema) body: { email: string }, @Req() req: Request): Promise<EmailStartResponse> {
    const r = await this.auth.startEmail(body.email, meta(req));
    return { sent: true, ...r };
  }

  @Public()
  @Post('email/verify')
  @HttpCode(200)
  @ZResponse(200, AuthSessionSchema)
  @ApiErrors(400, 401, 403, 429)
  verify(
    @ZBody(EmailVerifyRequestSchema) body: EmailVerifyBody,
    @Req() req: Request,
  ): Promise<AuthSession> {
    return this.auth.verifyEmail(body.email, body.code, body.device, meta(req));
  }

  @Public()
  @Post('google')
  @HttpCode(200)
  @ZResponse(200, AuthSessionSchema)
  @ApiErrors(400, 401, 403, 409)
  google(@ZBody(GoogleSignInRequestSchema) body: GoogleSignInRequest): Promise<AuthSession> {
    return this.auth.signInWithGoogle(body.idToken, body.device);
  }

  @Public()
  @Post('apple')
  @HttpCode(200)
  @ZResponse(200, AuthSessionSchema)
  @ApiErrors(400, 401, 403, 409)
  apple(@ZBody(AppleSignInRequestSchema) body: AppleSignInRequest): Promise<AuthSession> {
    return this.auth.signInWithApple(body.identityToken, body.nonce, body.displayName, body.device);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ZResponse(200, AuthSessionSchema, 'Rotated tokens; the old refresh token stops working')
  @ApiErrors(400, 401, 403)
  refresh(@ZBody(RefreshRequestSchema) body: RefreshRequest): Promise<AuthSession> {
    return this.auth.refresh(body.refreshToken);
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  @ZResponse(204, null, 'Signed out (allDevices: everywhere)')
  @ApiErrors(400, 401)
  async logout(@CurrentUser() user: AuthUser, @ZBody(LogoutRequestSchema) body: LogoutRequest): Promise<void> {
    await this.auth.logout(user.id, user.sessionId, Boolean(body.allDevices), body.refreshToken);
  }
}
