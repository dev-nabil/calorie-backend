/**
 * `pnpm start:local`: the whole API on one machine without Docker (developer and QA use only).
 * - MongoDB: in-process replica set (mongodb-memory-server) with a persistent dbPath in $LOCAL_DATA_DIR/mongo (default .local)
 * - Redis: in-memory fallback; scans run inline (no BullMQ worker needed)
 * - Email: console driver (codes printed and served by GET /v1/dev/last-otp)
 * - AI: FakeAiProvider; uploads: local disk driver under .local/uploads
 * - Binds 0.0.0.0:3000 so the iOS simulator (localhost) and Android emulator (10.0.2.2) reach it.
 */
import 'reflect-metadata';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AppModule } from '../app.module';
import { configureApp } from '../bootstrap';
import { loadConfig } from '../config/env';

export const LOCAL_MONGO_PORT = 27027;

async function main(): Promise<void> {
  const root = resolve(__dirname, '..', '..');
  // LOCAL_DATA_DIR lets QA run a private instance (../nouri-docs/README.md "Local ports").
  const dataDir = resolve(root, process.env.LOCAL_DATA_DIR ?? '.local');
  const dbPath = resolve(dataDir, 'mongo');
  mkdirSync(dbPath, { recursive: true });
  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbPath, port: Number(process.env.LOCAL_MONGO_PORT ?? LOCAL_MONGO_PORT), storageEngine: 'wiredTiger', args: ['--setParameter', 'indexBuildMinAvailableDiskSpaceMB=0'] }],
  });
  const config = loadConfig({
    PORT: '3000',
    HOST: '0.0.0.0',
    LOG_LEVEL: 'info',
    ...process.env,
    NODE_ENV: 'development',
    MONGODB_URI: replSet.getUri().replace('/?', '/nouri?'),
    REDIS_URL: '',
    EMAIL_DRIVER: 'console',
    AI_PROVIDER: 'fake',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: resolve(dataDir, 'uploads'),
    DEV_ROUTES: 'true',
  });
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  configureApp(app);
  await app.listen(config.PORT, config.HOST);
  console.warn(
    [
      '',
      `  Nouri API (local) on http://${config.HOST}:${config.PORT}/v1   docs: http://localhost:${config.PORT}/docs`,
      `  iOS simulator: http://localhost:${config.PORT}   Android emulator: http://10.0.2.2:${config.PORT}`,
      `  MongoDB: ${config.MONGODB_URI} (data in ${dbPath})`,
      '  Sign-in codes are printed here and served by GET /v1/dev/last-otp?email=…',
      '',
    ].join('\n'),
  );
  const stop = async () => {
    await app.close();
    await replSet.stop({ doCleanup: false, force: false });
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
