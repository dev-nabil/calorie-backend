import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { KvStore } from '../../infra/kv/kv-store';
import type { Request } from 'express';
import { ApiError } from '../errors/api-error';
import { IS_PUBLIC, OPTIONAL_AUTH } from './auth.decorators';
import { TokenService } from './token.service';

/** Global guard: every route needs a valid, unrevoked access token unless marked @Public(). */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly kv: KvStore,
    @InjectModel('User') private readonly users: Model<{ lastActiveAt: Date | null }>,
  ) {}

  /** lastActiveAt for DAU/WAU/MAU, written at most once an hour per user. */
  private touch(userId: string): void {
    void this.kv
      .setIfAbsent(`active:${userId}`, '1', 3600)
      .then((fresh) => (fresh ? this.users.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date() } }) : null))
      .catch(() => undefined);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) {
      const header = req.headers.authorization;
      if (this.reflector.get<boolean>(OPTIONAL_AUTH, ctx.getHandler()) && header?.startsWith('Bearer ')) {
        req.authUser = await this.tokens.verifyAccess(header.slice(7).trim()).catch(() => undefined);
      }
      return true;
    }
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw ApiError.unauthenticated();
    req.authUser = await this.tokens.verifyAccess(header.slice(7).trim());
    this.touch(req.authUser.id);
    return true;
  }
}
