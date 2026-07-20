import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('blob store configuration', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'agent-foundry-config-'));
    dirs.push(dir);
    return dir;
  }

  it('defaults to fs mode with a 300s-capable signing secret and the default GC grace period', async () => {
    const dataDir = await tempDataDir();
    const config = loadRuntimeConfig({ ...base, DATA_DIR: dataDir });
    expect(config.blobStoreMode).toBe('fs');
    expect(config.blobSigningSecret).toBeDefined();
    expect(config.blobSigningSecret!.length).toBeGreaterThanOrEqual(16);
    expect(config.blobGcGraceMs).toBe(86_400_000);
  });

  it('honors an explicit BLOB_SIGNING_SECRET instead of deriving one', () => {
    const config = loadRuntimeConfig({
      ...base,
      DATA_DIR: '.data-unused-for-this-test',
      BLOB_SIGNING_SECRET: 'x'.repeat(32),
    });
    expect(config.blobSigningSecret).toBe('x'.repeat(32));
  });

  it('derives a per-installation signing secret file once, then reuses it', async () => {
    const dataDir = await tempDataDir();
    const first = loadRuntimeConfig({ ...base, DATA_DIR: dataDir });
    const second = loadRuntimeConfig({ ...base, DATA_DIR: dataDir });
    expect(second.blobSigningSecret).toBe(first.blobSigningSecret);

    const secretPath = join(dataDir, 'blob-signing-secret');
    const stat = statSync(secretPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reads a secret another process already won the race to create, instead of overwriting it', async () => {
    const dataDir = await tempDataDir();
    mkdirSync(dataDir, { recursive: true });
    const secretPath = join(dataDir, 'blob-signing-secret');
    writeFileSync(secretPath, 'winner-secret', { mode: 0o600 });

    const config = loadRuntimeConfig({ ...base, DATA_DIR: dataDir });
    expect(config.blobSigningSecret).toBe('winner-secret');
  });

  it('honors a BLOB_GC_GRACE_MS override', () => {
    const config = loadRuntimeConfig({ ...base, BLOB_GC_GRACE_MS: '1000' });
    expect(config.blobGcGraceMs).toBe(1000);
  });

  it('accepts s3 mode when all required S3 vars are present, defaulting path-style on for a custom endpoint', () => {
    const config = loadRuntimeConfig({
      ...base,
      BLOB_STORE_MODE: 's3',
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'agent-foundry',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(config.blobStoreMode).toBe('s3');
    expect(config.s3Endpoint).toBe('http://minio:9000');
    expect(config.s3Region).toBe('us-east-1');
    expect(config.s3Bucket).toBe('agent-foundry');
    expect(config.s3AccessKeyId).toBe('key');
    expect(config.s3SecretAccessKey).toBe('secret');
    // A custom S3_ENDPOINT implies a non-AWS store (MinIO, Supabase Storage, ...),
    // which all require path-style addressing — defaulted on without an explicit env var.
    expect(config.s3ForcePathStyle).toBe(true);
    // s3 mode never needs the fs-mode signing secret file.
    expect(config.blobSigningSecret).toBeUndefined();
  });

  it('honors an explicit S3_FORCE_PATH_STYLE=false override even with a custom endpoint', () => {
    const config = loadRuntimeConfig({
      ...base,
      BLOB_STORE_MODE: 's3',
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'agent-foundry',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: 'false',
    });
    expect(config.s3ForcePathStyle).toBe(false);
  });

  it('defaults S3_FORCE_PATH_STYLE to false when BLOB_STORE_MODE is fs (no endpoint configured)', async () => {
    const dataDir = await tempDataDir();
    const config = loadRuntimeConfig({ ...base, DATA_DIR: dataDir });
    expect(config.s3ForcePathStyle).toBe(false);
  });

  it('rejects s3 mode missing required S3 vars', () => {
    expect(() => loadRuntimeConfig({ ...base, BLOB_STORE_MODE: 's3' })).toThrow();
  });

  it('reports each missing S3 var individually', () => {
    try {
      loadRuntimeConfig({
        ...base,
        BLOB_STORE_MODE: 's3',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'agent-foundry',
      });
      expect.unreachable('expected loadRuntimeConfig to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('S3_ENDPOINT');
      expect(message).toContain('S3_ACCESS_KEY_ID');
      expect(message).toContain('S3_SECRET_ACCESS_KEY');
    }
  });
});
