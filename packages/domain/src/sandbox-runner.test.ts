import { describe, expect, it, vi } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import { runSandboxLifecycle, type SandboxRunner } from './sandbox-runner.js';

const spec: SandboxSpec = {
  image: 'sandbox:1',
  resources: { cpuMillis: 500, memoryMiB: 512, diskMiB: 1024, pids: 64 },
  network: { mode: 'none', allowedHosts: [] },
  mounts: [],
  ttlMs: 60_000,
  user: '1000:1000',
};

class FakeSandboxRunner implements SandboxRunner {
  readonly destroyed = new Set<string>();
  destroyCalls = 0;
  createCalls = 0;
  readonly signals: Array<AbortSignal | undefined> = [];
  constructor(
    private readonly failAt?: 'create' | 'exec' | 'snapshot',
    private readonly mutateSnapshotAllowlist = false,
    private readonly destroyFails = false,
  ) {}
  async create(_spec: SandboxSpec) {
    this.createCalls += 1;
    if (this.failAt === 'create') throw new Error('create failed');
    return { id: 'sandbox-1' };
  }
  async exec(
    _sandbox: { id: string },
    request: Parameters<SandboxRunner['exec']>[1],
    signal?: AbortSignal,
  ) {
    this.signals.push(signal);
    request.onOutput?.({ stream: 'stdout', text: 'running' });
    if (this.failAt === 'exec') throw new Error('exec failed');
    return { exitCode: 0, stdout: 'done', stderr: '' };
  }
  async snapshot(_sandbox: { id: string }, allowedPaths: readonly string[]) {
    if (this.failAt === 'snapshot') throw new Error('snapshot failed');
    if (this.mutateSnapshotAllowlist) (allowedPaths as string[]).push('secrets');
    return {
      files: [
        { path: 'src/index.ts', content: new Uint8Array([1]) },
        { path: 'secrets/.env', content: new Uint8Array([2]) },
        { path: 'src-secret/file', content: new Uint8Array([3]) },
        { path: 'src/../secrets/.env', content: new Uint8Array([4]) },
      ],
    };
  }
  async destroy(sandbox: { id: string }) {
    if (this.destroyed.has(sandbox.id)) return;
    this.destroyed.add(sandbox.id);
    this.destroyCalls += 1;
    if (this.destroyFails) throw new Error('destroy failed');
  }
}

describe('runSandboxLifecycle', () => {
  it('streams output, forwards the signal, exports only allowed paths, and destroys the sandbox', async () => {
    const runner = new FakeSandboxRunner();
    const output: string[] = [];
    const signal = new AbortController().signal;
    const result = await runSandboxLifecycle(
      runner,
      spec,
      {
        command: 'agent',
        args: ['run'],
        timeoutMs: 1_000,
        onOutput: (chunk) => output.push(chunk.text),
      },
      ['src'],
      signal,
    );
    expect(output).toEqual(['running']);
    expect(runner.signals).toEqual([signal]);
    expect(result.snapshot.files.map((file) => file.path)).toEqual(['src/index.ts']);
    expect(runner.destroyed).toEqual(new Set(['sandbox-1']));
  });

  it('keeps filtering against the validated allowlist when the runner mutates its copy', async () => {
    const runner = new FakeSandboxRunner(undefined, true);
    const result = await runSandboxLifecycle(
      runner,
      spec,
      { command: 'agent', args: [], timeoutMs: 1_000 },
      ['src'],
    );
    expect(result.snapshot.files.map((file) => file.path)).toEqual(['src/index.ts']);
  });

  it.each([
    ['exec', 'exec failed'],
    ['snapshot', 'snapshot failed'],
  ] as const)('destroys after a %s error', async (failAt, message) => {
    const runner = new FakeSandboxRunner(failAt);
    await expect(
      runSandboxLifecycle(runner, spec, { command: 'agent', args: [], timeoutMs: 1_000 }, ['src']),
    ).rejects.toThrow(message);
    expect(runner.destroyed).toEqual(new Set(['sandbox-1']));
  });

  it('keeps a successful lifecycle result when destroy fails', async () => {
    const runner = new FakeSandboxRunner(undefined, false, true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        runSandboxLifecycle(runner, spec, { command: 'agent', args: [], timeoutMs: 1_000 }, ['src']),
      ).resolves.toMatchObject({ result: { exitCode: 0 } });
      expect(consoleError).toHaveBeenCalledWith('Failed to destroy sandbox', expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the exec error when both exec and destroy fail', async () => {
    const runner = new FakeSandboxRunner('exec', false, true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        runSandboxLifecycle(runner, spec, { command: 'agent', args: [], timeoutMs: 1_000 }, ['src']),
      ).rejects.toThrow('exec failed');
      expect(consoleError).toHaveBeenCalledWith('Failed to destroy sandbox', expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not attempt destroy when create fails before yielding a handle', async () => {
    const runner = new FakeSandboxRunner('create');
    await expect(
      runSandboxLifecycle(runner, spec, { command: 'agent', args: [], timeoutMs: 1_000 }, ['src']),
    ).rejects.toThrow('create failed');
    expect(runner.destroyed).toEqual(new Set());
  });

  it('rejects an unsafe allowlist before creating a sandbox', async () => {
    const runner = new FakeSandboxRunner();
    await expect(
      runSandboxLifecycle(runner, spec, { command: 'agent', args: [], timeoutMs: 1_000 }, [
        '../secrets',
      ]),
    ).rejects.toThrow('Sandbox snapshot paths must be relative');
    expect(runner.createCalls).toBe(0);
  });

  it('requires idempotent destroy for a sandbox handle', async () => {
    const runner = new FakeSandboxRunner();
    const sandbox = await runner.create(spec);
    await runner.destroy(sandbox);
    await runner.destroy(sandbox);
    expect(runner.destroyCalls).toBe(1);
  });
});
