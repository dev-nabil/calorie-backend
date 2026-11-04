import { randomBytes } from 'node:crypto';
import { Controller, Delete, Get, HttpCode, Module, Post } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import {
  AttestChallengeSchema,
  AttestRequestSchema,
  DeviceSchema,
  ERROR_CODES,
  ExportResponseSchema,
  RegisterDeviceRequestSchema,
  type AttestRequest,
  type RegisterDeviceRequest,
} from '../../shared';
import { CurrentUser, type AuthUser } from '../../common/auth/auth.decorators';
import { ApiError } from '../../common/errors/api-error';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { AppAttestVerifier } from '../../common/integrity/app-attest';
import { ApiErrors, ZBody, ZParam, ZResponse } from '../../common/zod/decorators';
import { KvStore } from '../../infra/kv/kv-store';
import type { DeviceDoc } from '../users/users.schemas';
import { UsersService } from '../users/users.service';
import { AccountService } from './account.service';

const CHALLENGE_SEC = 300;

function toDevice(d: DeviceDoc) {
  return {
    deviceId: d.deviceId,
    platform: d.platform,
    appVersion: d.appVersion ?? null,
    pushEnabled: Boolean(d.pushToken),
    integrity: { verifiedAt: d.integrity?.verifiedAt ? new Date(d.integrity.verifiedAt).toISOString() : null, keyId: d.integrity?.keyId ?? null },
    lastSeenAt: new Date(d.lastSeenAt).toISOString(),
  };
}

@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
class DevicesController {
  constructor(
    @InjectModel('Device') private readonly devices: Model<DeviceDoc>,
    private readonly users: UsersService,
    private readonly kv: KvStore,
    private readonly attest: AppAttestVerifier,
  ) {}

  @Post()
  @Idempotent()
  @ZResponse(201, DeviceSchema, 'Registers or updates a device and its push token (M1-T8, DEC-12)')
  @ApiErrors(400, 401)
  async register(@CurrentUser() u: AuthUser, @ZBody(RegisterDeviceRequestSchema) body: RegisterDeviceRequest) {
    await this.users.requireActive(u.id);
    const set: Record<string, unknown> = { platform: body.platform, lastSeenAt: new Date() };
    if (body.appVersion !== undefined) set.appVersion = body.appVersion;
    if (body.pushToken !== undefined) set.pushToken = body.pushToken;
    const d = await this.devices.findOneAndUpdate({ userId: new Types.ObjectId(u.id), deviceId: body.deviceId }, { $set: set }, { upsert: true, returnDocument: 'after' }).lean<DeviceDoc>();
    return toDevice(d!);
  }

  @Delete(':deviceId')
  @HttpCode(204)
  @ZResponse(204, null, 'Removed')
  @ApiErrors(401)
  async remove(@CurrentUser() u: AuthUser, @ZParam('deviceId', z.string().min(1).max(128)) deviceId: string): Promise<void> {
    await this.devices.deleteOne({ userId: new Types.ObjectId(u.id), deviceId });
  }

  @Get('attest-challenge')
  @ZResponse(200, AttestChallengeSchema, 'One-time challenge for App Attest key registration (5 minutes)')
  async challenge(@CurrentUser() u: AuthUser) {
    const challenge = randomBytes(32).toString('base64url');
    await this.kv.set(`attest:chal:${u.id}:${challenge}`, '1', CHALLENGE_SEC);
    return { challenge, expiresInSec: CHALLENGE_SEC };
  }

  @Post('attest')
  @HttpCode(200)
  @ZResponse(200, DeviceSchema, 'Verifies an App Attest attestation and stores the key for later assertions (DEC-19)')
  @ApiErrors(400, 401, 403)
  async attestKey(@CurrentUser() u: AuthUser, @ZBody(AttestRequestSchema) body: AttestRequest) {
    const ckey = `attest:chal:${u.id}:${body.challenge}`;
    if (!(await this.kv.get(ckey))) throw ApiError.forbidden(ERROR_CODES.INTEGRITY_INVALID, 'Challenge expired; ask for a new one');
    await this.kv.del(ckey);
    const result = this.attest.verifyAttestation(Buffer.from(body.attestation, 'base64'), body.keyId, Buffer.from(body.challenge));
    if (!result.valid) throw ApiError.forbidden(ERROR_CODES.INTEGRITY_INVALID, 'Attestation could not be verified', { reason: result.reason });
    const d = await this.devices
      .findOneAndUpdate(
        { userId: new Types.ObjectId(u.id), deviceId: body.deviceId },
        { $set: { platform: 'ios', lastSeenAt: new Date(), integrity: { verifiedAt: new Date(), keyId: body.keyId, publicKeyPem: result.publicKeyPem, counter: 0, env: result.env } } },
        { upsert: true, returnDocument: 'after' },
      )
      .lean<DeviceDoc>();
    return toDevice(d!);
  }
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
class ExportController {
  constructor(
    private readonly account: AccountService,
    private readonly users: UsersService,
  ) {}

  @Get('export')
  @HttpCode(202)
  @ZResponse(202, ExportResponseSchema, 'Builds the JSON export in the worker and emails a 24-hour link')
  @ApiErrors(401, 403, 429)
  async export(@CurrentUser() u: AuthUser) {
    await this.users.requireActive(u.id);
    const { exportId } = await this.account.requestExport(u.id);
    return { status: 'queued' as const, exportId, message: 'We are preparing your data and will email you a download link.' };
  }
}

@Module({ controllers: [DevicesController, ExportController], providers: [AccountService], exports: [AccountService] })
export class AccountModule {}

/** Worker role: export and purge handlers. */
@Module({ providers: [AccountService] })
export class AccountWorkerModule {}
