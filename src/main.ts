// Telemetry must load before the instrumented libraries (http, express, mongodb, ioredis).
import { startTelemetry } from './telemetry';
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) startTelemetry();
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { KvStore } from './infra/kv/kv-store';
import { healthOf } from './modules/health/health.controller';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config/env';
import { WorkerModule } from './worker.module';

/** One codebase, two deployables (DEC-02): ROLE=api serves HTTP, ROLE=worker runs BullMQ processors. */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  if (config.ROLE === 'worker') {
    const ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { bufferLogs: true });
    ctx.enableShutdownHooks();
    // Cloud Run needs every container to listen on PORT; the worker answers only GET /v1/health.
    const server = createServer((req, res) => {
      if (req.url !== '/v1/health') {
        res.writeHead(404).end();
        return;
      }
      void healthOf(config, ctx.get<Connection>(getConnectionToken()), ctx.get(KvStore)).then((h) => {
        res.writeHead(h.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(h));
      });
    });
    server.listen(config.PORT, config.HOST);
    process.once('SIGTERM', () => server.close());
    return;
  }
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  configureApp(app);
  await app.listen(config.PORT, config.HOST);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
