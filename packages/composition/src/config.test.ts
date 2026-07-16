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
