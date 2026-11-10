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
import type { SettingKey } from '../../src/modules/settings/settings.registry';
import { SettingsService } from '../../src/modules/settings/settings.service';

export interface TestApp {
  app: INestApplication;
  config: AppConfig;
  http: () => ReturnType<typeof request>;
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

/** Admin settings every test app starts with (sign-in audiences of the test tokens). */
const TEST_SETTINGS: Partial<Record<SettingKey, unknown>> = { 'auth.google.clientIds': ['test-google-client'], 'auth.apple.bundleId': 'app.nouri.test' };

/** Boots the full API against the shared in-memory replica set, one database per call. `settings` are admin settings stored before the first request. */
export async function createTestApp(
  env: Record<string, string> = {},
  customise?: (b: TestingModuleBuilder) => TestingModuleBuilder,
  settings: Partial<Record<SettingKey, unknown>> = {},
): Promise<TestApp> {
  const base = process.env.TEST_MONGO_URI;
  if (!base) throw new Error('TEST_MONGO_URI missing: run e2e tests through jest (global setup)');
  const db = `nouri_test_${randomUUID().slice(0, 8)}`;
  const uploads = join(tmpdir(), db);
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: base.replace('/?', `/${db}?`),
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
  const store = app.get(SettingsService);
  for (const [key, value] of Object.entries({ ...TEST_SETTINGS, ...settings })) await store.set(key as SettingKey, value);
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
