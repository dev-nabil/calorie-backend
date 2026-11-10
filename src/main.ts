// Telemetry must load before the instrumented libraries (http, express, mongodb).
import { startTelemetry } from './infra/telemetry/telemetry';
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) startTelemetry();
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadConfig } from './config/env';

/** One process serves the API and runs every background job (MongoDB queue): no Redis, no worker. */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  configureApp(app);
  await app.listen(config.PORT, config.HOST);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
