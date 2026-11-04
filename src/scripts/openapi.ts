import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { buildOpenApi, configureApp } from '../app.setup';
import { loadConfig } from '../config/env';

/** Writes openapi/openapi.json without needing MongoDB or Redis (DEC-16 contract). */
async function run(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'development',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://example.invalid/nouri',
    MONGODB_LAZY: 'true',
    REDIS_URL: '',
    SWAGGER_ENABLED: 'false',
    DEV_ROUTES: 'false',
    LOG_LEVEL: 'silent',
  });
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  configureApp(app);
  // No app.init(): lifecycle hooks (content seeding) would need MongoDB; routes are known already.
  const doc = buildOpenApi(app);
  const out = resolve(__dirname, '..', '..', 'openapi', 'openapi.json');
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  console.warn(`wrote ${out} (${Object.keys(doc.paths).length} paths)`);
  process.exit(0);
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
