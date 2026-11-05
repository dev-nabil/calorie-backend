import { Controller, Get, Inject } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Connection } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { HealthResponseSchema, type HealthResponse } from '../../shared';
import { Public } from '../../common/auth/auth.decorators';
import { ZResponse } from '../../common/zod/decorators';
import { KvStore } from '../../infra/kv/kv-store';

export async function healthOf(config: AppConfig, conn: Connection, kv: KvStore): Promise<HealthResponse> {
  let mongo: 'up' | 'down' = 'down';
  try {
    if (conn.readyState === 1 && conn.db) {
      await conn.db.admin().ping();
      mongo = 'up';
    }
  } catch {
    mongo = 'down';
  }
  const redis = kv.kind === 'memory' ? 'memory' : (await kv.ping()) ? 'up' : 'down';
  return {
    status: mongo === 'up' && redis !== 'down' ? 'ok' : 'degraded',
    role: config.ROLE === 'worker' ? 'worker' : 'api', // `all` serves HTTP, so it reports as the API
    version: config.APP_VERSION,
    uptimeSec: Math.round(process.uptime()),
    checks: { mongo, redis },
  };
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectConnection() private readonly conn: Connection,
    private readonly kv: KvStore,
  ) {}

  @Public()
  @Get()
  @ZResponse(200, HealthResponseSchema)
  health(): Promise<HealthResponse> {
    return healthOf(this.config, this.conn, this.kv);
  }
}
