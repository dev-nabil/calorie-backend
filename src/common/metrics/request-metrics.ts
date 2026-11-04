import { metrics } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';

// No-op unless the OTel SDK is started (telemetry.ts); exported for SLO burn-rate alerts.
const histogram = metrics.getMeter('nouri-api').createHistogram('nouri.http.duration', { unit: 'ms', description: 'Request duration by SLO class' });

/** SLO classes from plan section 15. */
export type RequestClass = 'read' | 'write' | 'other';

export function classify(method: string, path: string): RequestClass {
  if (method === 'GET' && /^\/v1\/(days|meals|progress)(\/|$)/.test(path)) return 'read';
  if (method === 'POST' && (/^\/v1\/meals\/?$/.test(path) || /^\/v1\/days\/[^/]+\/water$/.test(path))) return 'write';
  return 'other';
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/**
 * In-process request metrics for GET /v1/admin/metrics/slo: last 5,000 latencies per class and
 * 5xx counts since start. Per instance only; production SLOs come from OpenTelemetry/edge metrics.
 */
export class RequestMetrics {
  private readonly samples: Record<RequestClass, number[]> = { read: [], write: [], other: [] };
  total = 0;
  errors5xx = 0;
  readonly since = Date.now();

  record(cls: RequestClass, ms: number, status: number): void {
    const s = this.samples[cls];
    s.push(ms);
    if (s.length > 5000) s.shift();
    this.total++;
    if (status >= 500) this.errors5xx++;
  }

  p95(cls: RequestClass): number | null {
    return percentile([...this.samples[cls]].sort((a, b) => a - b), 95);
  }

  count(cls: RequestClass): number {
    return this.samples[cls].length;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const cls = classify(req.method, req.path);
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        this.record(cls, ms, res.statusCode);
        histogram.record(ms, { class: cls, status_class: `${Math.floor(res.statusCode / 100)}xx` });
      });
      next();
    };
  }
}

export const requestMetrics = new RequestMetrics();
