import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loadRuntimeConfig } from './config.js';

const root = resolve(import.meta.dirname, '../../..');
const base = { REPO_ROOT: root, NODE_ENV: 'test' } satisfies NodeJS.ProcessEnv;

describe('runtime exposure policy', () => {
  it('binds to loopback by default', () => {
    const config = loadRuntimeConfig(base);
    expect(config.apiHost).toBe('127.0.0.1');
    expect(config.allowUnsafeRemoteRealExecution).toBe(false);
  });

  it('refuses real executors on a non-loopback host', () => {
    expect(() =>
      loadRuntimeConfig({ ...base, EXECUTOR_MODE: 'real', API_HOST: '0.0.0.0' }),
    ).toThrow(/Refusing to expose real CLI execution/);
  });

  it('requires an explicit unsafe override for remote real execution', () => {
    const config = loadRuntimeConfig({
      ...base,
      EXECUTOR_MODE: 'real',
      API_HOST: '0.0.0.0',
      ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'true',
    });
    expect(config.allowUnsafeRemoteRealExecution).toBe(true);
  });

  it('permits mock mode on a container-facing host', () => {
    expect(loadRuntimeConfig({ ...base, EXECUTOR_MODE: 'mock', API_HOST: '0.0.0.0' }).apiHost).toBe(
      '0.0.0.0',
    );
  });
});

describe('policies directory', () => {
  it('defaults POLICIES_DIR to <root>/policies and honors overrides', () => {
    expect(loadRuntimeConfig(base).policiesDir).toBe(resolve(root, 'policies'));
    expect(loadRuntimeConfig({ ...base, POLICIES_DIR: 'custom/policies' }).policiesDir).toBe(
      resolve(root, 'custom/policies'),
    );
  });
});

describe('preview service configuration', () => {
  it('uses the preview lifecycle defaults', () => {
    expect(loadRuntimeConfig(base)).toMatchObject({
      previewTtlSeconds: 1_800,
      previewStartupTimeoutMs: 10_000,
      previewHealthPath: '/',
      previewHealthIntervalMs: 1_000,
      previewHealthFailureThreshold: 3,
      previewMaxRestarts: 2,
      previewReapIntervalMs: 5_000,
      previewLogMaxBytes: 1_000_000,
    });
  });

  it('honors preview lifecycle overrides', () => {
    expect(
      loadRuntimeConfig({
        ...base,
        PREVIEW_TTL_SECONDS: '60',
        PREVIEW_STARTUP_TIMEOUT_MS: '20',
        PREVIEW_HEALTH_PATH: '/healthz',
        PREVIEW_HEALTH_INTERVAL_MS: '30',
        PREVIEW_HEALTH_FAILURE_THRESHOLD: '4',
        PREVIEW_MAX_RESTARTS: '5',
        PREVIEW_REAP_INTERVAL_MS: '40',
        PREVIEW_LOG_MAX_BYTES: '50',
      }),
    ).toMatchObject({
      previewTtlSeconds: 60,
      previewStartupTimeoutMs: 20,
      previewHealthPath: '/healthz',
      previewHealthIntervalMs: 30,
      previewHealthFailureThreshold: 4,
      previewMaxRestarts: 5,
      previewReapIntervalMs: 40,
      previewLogMaxBytes: 50,
    });
  });
});

describe('artifact retention configuration', () => {
  it('defaults artifact size and retention limits', () => {
    expect(loadRuntimeConfig(base)).toMatchObject({
      artifactMaxScreenshotBytes: 5_000_000,
      artifactMaxTraceBytes: 20_000_000,
      artifactMaxVideoBytes: 50_000_000,
      artifactRetentionSeconds: 604_800,
      artifactReapIntervalMs: 60_000,
    });
  });

  it('honors overrides for each artifact limit', () => {
    const config = loadRuntimeConfig({
      ...base,
      ARTIFACT_MAX_SCREENSHOT_BYTES: '1000',
      ARTIFACT_MAX_TRACE_BYTES: '2000',
      ARTIFACT_MAX_VIDEO_BYTES: '3000',
      ARTIFACT_RETENTION_SECONDS: '3600',
      ARTIFACT_REAP_INTERVAL_MS: '5000',
    });
    expect(config.artifactMaxScreenshotBytes).toBe(1000);
    expect(config.artifactMaxTraceBytes).toBe(2000);
    expect(config.artifactMaxVideoBytes).toBe(3000);
    expect(config.artifactRetentionSeconds).toBe(3600);
    expect(config.artifactReapIntervalMs).toBe(5000);
  });
});

describe('OpenTelemetry configuration', () => {
  it('defaults to no endpoint/service name, ratio 1, a 60s slow-run threshold', () => {
    const config = loadRuntimeConfig(base);
    expect(config.otelExporterOtlpEndpoint).toBeUndefined();
    expect(config.otelServiceName).toBeUndefined();
    expect(config.otelTracesSamplerRatio).toBe(1);
    expect(config.otelSlowRunThresholdMs).toBe(60_000);
  });

  it('honors OTEL_* overrides', () => {
    const config = loadRuntimeConfig({
      ...base,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_SERVICE_NAME: 'agent-foundry-api',
      OTEL_TRACES_SAMPLER_RATIO: '0.25',
      OTEL_SLOW_RUN_THRESHOLD_MS: '30000',
    });
    expect(config.otelExporterOtlpEndpoint).toBe('http://localhost:4318');
    expect(config.otelServiceName).toBe('agent-foundry-api');
    expect(config.otelTracesSamplerRatio).toBe(0.25);
    expect(config.otelSlowRunThresholdMs).toBe(30_000);
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.9.8.7', '::1', '[::1]'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '192.168.1.5', 'example.com', '::', ''])('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('Loopback Binding Validation', () => {
  it('accepts real mode on loopback', () => {
    const config = loadRuntimeConfig({
      ...base,
      EXECUTOR_MODE: 'real',
      API_HOST: '127.0.0.1',
      ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'false',
    });
    expect(config.executorMode).toBe('real');
    expect(config.apiHost).toBe('127.0.0.1');
  });

  it('accepts real mode on localhost', () => {
    const config = loadRuntimeConfig({
      ...base,
      EXECUTOR_MODE: 'real',
      API_HOST: 'localhost',
      ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'false',
    });
    expect(config.executorMode).toBe('real');
    expect(config.apiHost).toBe('localhost');
  });

  it('accepts real mode on ::1 (IPv6 loopback)', () => {
    const config = loadRuntimeConfig({
      ...base,
      EXECUTOR_MODE: 'real',
      API_HOST: '::1',
      ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'false',
    });
    expect(config.executorMode).toBe('real');
    expect(config.apiHost).toBe('::1');
  });

  it('rejects real mode on non-loopback without override', () => {
    expect(() => {
      loadRuntimeConfig({
        ...base,
        EXECUTOR_MODE: 'real',
        API_HOST: '0.0.0.0',
        ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'false',
      });
    }).toThrow('Refusing to expose real CLI execution on a non-loopback API host');
  });

  it('rejects real mode on non-loopback IP without override', () => {
    expect(() => {
      loadRuntimeConfig({
        ...base,
        EXECUTOR_MODE: 'real',
        API_HOST: '192.168.1.100',
        ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'false',
      });
    }).toThrow('Refusing to expose real CLI execution on a non-loopback API host');
  });

  it('allows real mode on non-loopback with explicit override', () => {
    const config = loadRuntimeConfig({
      ...base,
      EXECUTOR_MODE: 'real',
      API_HOST: '0.0.0.0',
      ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'true',
    });
    expect(config.executorMode).toBe('real');
    expect(config.apiHost).toBe('0.0.0.0');
    expect(config.allowUnsafeRemoteRealExecution).toBe(true);
  });

  it('accepts mock mode on any host', () => {
    const config = loadRuntimeConfig({
      ...base,
      EXECUTOR_MODE: 'mock',
      API_HOST: '0.0.0.0',
      ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'false',
    });
    expect(config.executorMode).toBe('mock');
    expect(config.apiHost).toBe('0.0.0.0');
  });

  it('computes deployment profile correctly', () => {
    const config = loadRuntimeConfig({
      ...base,
      EXECUTOR_MODE: 'real',
      API_HOST: '127.0.0.1',
      ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'false',
    });
    expect(config.deploymentProfile).toBe('real-local-trusted');
  });

  it("marks custom configuration when profile doesn't match", () => {
    const config = loadRuntimeConfig({
      ...base,
      EXECUTOR_MODE: 'real',
      API_HOST: '192.168.1.100',
      ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: 'true',
    });
    expect(config.deploymentProfile).toBe('custom');
  });
});
