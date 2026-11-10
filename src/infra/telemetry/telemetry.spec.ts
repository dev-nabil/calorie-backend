import { startTelemetry } from './telemetry';

describe('telemetry (DEC-13)', () => {
  it('is a no-op without an OTLP endpoint and in tests', () => {
    expect(startTelemetry({})).toBeNull();
    expect(startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318', NODE_ENV: 'test' })).toBeNull();
  });
  it('starts the SDK when an endpoint is configured', async () => {
    const sdk = startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/', NODE_ENV: 'development' });
    expect(sdk).not.toBeNull();
    await sdk!.shutdown().catch(() => undefined);
  });
});
