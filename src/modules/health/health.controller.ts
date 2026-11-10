import { Controller, Get, Inject } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import type { Connection } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';
import { HealthResponseSchema, type HealthResponse } from '../../shared';
import { Public } from '../../common/auth/auth.decorators';
import { ZResponse } from '../../common/zod/decorators';

export async function healthOf(config: AppConfig, conn: Connection): Promise<HealthResponse> {
  let mongo: 'up' | 'down' = 'down';
  try {
    if (conn.readyState === 1 && conn.db) {
      await conn.db.admin().ping();
      mongo = 'up';
    }
  } catch {
    mongo = 'down';
  }
  return { status: mongo === 'up' ? 'ok' : 'degraded', version: config.APP_VERSION, uptimeSec: Math.round(process.uptime()), checks: { mongo } };
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectConnection() private readonly conn: Connection,
  ) {}

  @Public()
  @Get()
  @ZResponse(200, HealthResponseSchema)
  health(): Promise<HealthResponse> {
    return healthOf(this.config, this.conn);
  }
}
