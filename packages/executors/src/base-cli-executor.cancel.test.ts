import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRequest, Provider } from '@agent-foundry/contracts';
import { RunCancelledError } from '@agent-foundry/domain';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { MockAgentExecutor } from './mock-executor.js';

class NodeScriptExecutor extends BaseCliExecutor {
  readonly provider: Provider = 'codex';
  protected readonly command = 'node';

  constructor(private readonly script: string) {
    super(1_000_000, 250);
  }

  protected invocation(): Promise<CliInvocation> {
    return Promise.resolve({ command: 'node', args: ['-e', this.script] });
  }
}

function request(cwd: string): AgentExecutionRequest {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    attemptId: 'attempt-1',
    projectId: 'project-1',
    stepId: 'implement',
    role: 'developer',
    taskKind: 'implementation',
    provider: 'codex',
    model: 'test-model',
    prompt: 'irrelevant',
    cwd,
    mutatesWorkspace: true,
    timeoutMs: 30_000,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform !== 'win32')('BaseCliExecutor cancellation', () => {
  it('SIGTERMs the process group and SIGKILLs the whole tree after the grace period', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'executor-cancel-test-'));
    const pidFile = join(directory, 'pids');
    // Child ignores SIGTERM (forcing the SIGKILL path) and spawns a grandchild
    // that only a process-group kill can reach.
    const script = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + grandchild.pid);
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    try {
      const controller = new AbortController();
      const execution = new NodeScriptExecutor(script).execute(
        request(directory),
        controller.signal,
      );
      const rejection = expect(execution).rejects.toThrow(RunCancelledError);
      await vi.waitFor(() => access(pidFile), { timeout: 10_000 });
      const [childPid, grandchildPid] = (await readFile(pidFile, 'utf8'))
        .trim()
        .split(' ')
        .map(Number);
      expect(isAlive(childPid!)).toBe(true);
      expect(isAlive(grandchildPid!)).toBe(true);

      controller.abort();
      await rejection;
      await vi.waitFor(
        () => {
          expect(isAlive(childPid!)).toBe(false);
          expect(isAlive(grandchildPid!)).toBe(false);
        },
        { timeout: 10_000 },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets a cooperative CLI exit gracefully on SIGTERM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'executor-cancel-test-'));
    const readyFile = join(directory, 'ready');
    const sigtermFile = join(directory, 'sigterm');
    const script = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(sigtermFile)}, 'graceful');
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    `;
    try {
      const controller = new AbortController();
      const execution = new NodeScriptExecutor(script).execute(
        request(directory),
        controller.signal,
      );
      const rejection = expect(execution).rejects.toThrow(RunCancelledError);
      await vi.waitFor(() => access(readyFile), { timeout: 10_000 });

      controller.abort();
      await rejection;
      await expect(readFile(sigtermFile, 'utf8')).resolves.toBe('graceful');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('MockAgentExecutor cancellation', () => {
  it('refuses to execute when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new MockAgentExecutor().execute(request('/tmp/nowhere'), controller.signal),
    ).rejects.toThrow(RunCancelledError);
  });
});
