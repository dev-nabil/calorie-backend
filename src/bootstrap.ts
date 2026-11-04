import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { APP_CONFIG } from './config/config.module';
import type { AppConfig } from './config/env';
import { zodComponents } from './common/zod/openapi';
import { requestContextMiddleware } from './common/http/request-context';
import { requestMetrics } from './common/metrics/request-metrics';
import { DEVICE_INTEGRITY_HEADER, IDEMPOTENCY_KEY_HEADER, REQUEST_ID_HEADER } from './shared';

export const API_PREFIX = 'v1';

/** Shared HTTP setup for main.ts, e2e tests and the openapi script. */
export function configureApp(app: INestApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);
  const express = app as NestExpressApplication;
  express.useLogger(app.get(Logger));
  // P1 (QA): only trust X-Forwarded-For from configured proxies, or per-IP limits can be bypassed.
  express.set('trust proxy', config.trustProxy);
  express.disable('x-powered-by');
  express.useBodyParser('json', { limit: '256kb' });
  // Local upload driver only: raw photo/audio bodies (presigned PUT to /v1/dev/uploads).
  express.useBodyParser('raw', { type: ['image/*', 'audio/*'], limit: '2mb' });
  app.use(requestContextMiddleware);
  app.use(requestMetrics.middleware());
  app.setGlobalPrefix(API_PREFIX, { exclude: ['docs', 'docs-json'] });
  app.enableCors({
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After', 'ETag', 'Idempotent-Replayed'],
    allowedHeaders: ['Authorization', 'Content-Type', IDEMPOTENCY_KEY_HEADER, DEVICE_INTEGRITY_HEADER, REQUEST_ID_HEADER, 'If-None-Match', 'X-CSRF-Token', 'X-Device-Id'],
  });
  app.enableShutdownHooks();
  if (config.swaggerEnabled) {
    SwaggerModule.setup('docs', app, buildOpenApi(app), { jsonDocumentUrl: 'docs-json' });
  }
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Nouri API')
      .setDescription(
        'Nouri v1 API. Errors are { error: { code, message, details } }. Creating POSTs need an Idempotency-Key header (DEC-20).',
      )
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addCookieAuth('__Host-nouri_admin', { type: 'apiKey', in: 'cookie', name: '__Host-nouri_admin', description: 'Admin session (POST /v1/admin/auth/totp)' }, 'adminSession')
      .addSecurityRequirements('bearer')
      .build(),
  );
  doc.components = { ...doc.components, schemas: { ...zodComponents(), ...(doc.components?.schemas ?? {}) } };
  const errorRef = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
  const publicAdmin = new Set(['/v1/admin/auth/login', '/v1/admin/auth/totp', '/v1/admin/auth/accept-invite']);
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item as Record<string, { parameters?: { name?: string }[]; security?: unknown; responses?: Record<string, unknown> }>)) {
      // BI-5: the CSRF header belongs to admin writes only.
      if (op.parameters && (method === 'get' || !path.startsWith('/v1/admin/'))) op.parameters = op.parameters.filter((p) => p.name !== 'X-CSRF-Token');
      // QA B18: admin operations use the session cookie and document 401/403.
      if (path.startsWith('/v1/admin/') && !publicAdmin.has(path)) {
        op.security = [{ adminSession: [] }];
        op.responses = { ...op.responses, '401': op.responses?.['401'] ?? errorRef, '403': op.responses?.['403'] ?? errorRef };
      }
      // QA B24: every operation with a body can answer 400, and every secured operation 401.
      if ((op as { requestBody?: unknown }).requestBody && !op.responses?.['400']) op.responses = { ...op.responses, '400': errorRef };
      const security = (op.security ?? doc.security) as Record<string, unknown>[] | undefined;
      if (security?.some((s) => Object.keys(s).length > 0) && !op.responses?.['401']) op.responses = { ...op.responses, '401': errorRef };
    }
  }
  return doc;
}
