import * as os from 'node:os';
import { Module } from '@nestjs/common';
import mongoose from 'mongoose';

// BI-6: documents serialise without Mongo internals.
mongoose.set('toJSON', { versionKey: false, virtuals: true, transform: (_doc, ret: Record<string, unknown>) => { delete ret._id; return ret; } });
import { MongooseModule } from '@nestjs/mongoose';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env';

/** MongoDB connection (DEC-03). Transactions need a replica set, locally too. */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        uri: config.MONGODB_URI,
        lazyConnection: config.MONGODB_LAZY,
        autoIndex: !config.isProduction,
        serverSelectionTimeoutMS: 5000,
        // mongodb 7 loads `os` with a dynamic import(), which fails in Jest's CommonJS sandbox
        // and leaves the handshake metadata empty. Passing it explicitly is harmless elsewhere.
        runtimeAdapters: { os },
      }),
    }),
  ],
})
export class MongoModule {}
