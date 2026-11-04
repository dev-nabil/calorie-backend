import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { loadConfig, type AppConfig } from '../../src/config/env';

export interface TestApp {
  app: INestApplication;
  config: AppConfig;
  http: () => ReturnType<typeof request>;
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

/** Boots the full API against the shared in-memory replica set, one database per call. */
export async function createTestApp(
  env: Record<string, string> = {},
  customise?: (b: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  const base = process.env.TEST_MONGO_URI;
  if (!base) throw new Error('TEST_MONGO_URI missing: run e2e tests through jest (global setup)');
  const db = `nouri_test_${randomUUID().slice(0, 8)}`;
  const uploads = join(tmpdir(), db);
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: base.replace('/?', `/${db}?`),
    EMAIL_DRIVER: 'memory',
    GOOGLE_CLIENT_IDS: 'test-google-client',
    APPLE_BUNDLE_ID: 'app.nouri.test',
    LOCAL_STORAGE_DIR: uploads,
    ...env,
  });
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] });
  if (customise) builder = customise(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  configureApp(app);
  await app.init();
  const conn = app.get<Connection>(getConnectionToken());
  await conn.syncIndexes();
  return {
    app,
    config,
    http: () => request(app.getHttpServer()),
    get: <T>(token: unknown) => app.get(token as never) as T,
    close: async () => {
      await conn.dropDatabase();
      await app.close();
      rmSync(uploads, { recursive: true, force: true });
    },
  };
}
