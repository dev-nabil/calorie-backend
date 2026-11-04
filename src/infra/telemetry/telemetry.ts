/**
 * OpenTelemetry (DEC-13, M0-T3): traces and metrics over OTLP/HTTP when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set; a no-op otherwise (dev, tests). Imported first in main.ts so
 * HTTP, Express, MongoDB, ioredis and BullMQ calls are instrumented.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

export function startTelemetry(env: Record<string, string | undefined> = process.env): NodeSDK | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '');
  if (!endpoint || env.NODE_ENV === 'test') return null;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': env.ROLE === 'worker' ? 'nouri-worker' : 'nouri-api',
      'service.version': env.APP_VERSION ?? '0.1.0',
      'deployment.environment': env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }), exportIntervalMillis: 30_000 })],
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
  const stop = () => void sdk.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  return sdk;
}
