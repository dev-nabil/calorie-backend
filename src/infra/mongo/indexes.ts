import { Inject, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';

/**
 * Production runs with autoIndex off; the process creates every schema index once on boot
 * (createIndexes only adds, never drops; index changes are additive, see runbook §5).
 */
@Injectable()
export class IndexBuilder implements OnApplicationBootstrap {
  private readonly logger = new Logger('Indexes');
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectConnection() private readonly conn: Connection,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.isProduction) await this.build();
  }

  async build(): Promise<number> {
    let n = 0;
    for (const model of Object.values(this.conn.models)) {
      await model.createIndexes();
      n++;
    }
    this.logger.log(`indexes ensured for ${n} collections`);
    return n;
  }
}

@Module({ providers: [IndexBuilder], exports: [IndexBuilder] })
export class IndexesModule {}
