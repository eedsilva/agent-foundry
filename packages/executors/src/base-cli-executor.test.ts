import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRequest, Provider } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

class FixtureExecutor extends BaseCliExecutor {
  protected readonly command = 'fixture-cli';

  constructor(
    maxOutputBytes: number,
    private readonly metadataFile?: string,
    readonly provider: Provider = 'codex',
    private readonly metadataDirectory?: string,
  ) {
    super(maxOutputBytes);
  }

  protected async invocation(): Promise<CliInvocation> {
    return {
      command: this.command,
      args: [],
      ...(this.metadataFile ? { metadataFile: this.metadataFile } : {}),
      ...(this.metadataDirectory ? { metadataDirectory: this.metadataDirectory } : {}),
    };
  }
}

const request: AgentExecutionRequest = {
  runId: 'run-1',
  projectId: 'project-1',
  stepId: 'implement',
  role: 'developer',
  taskKind: 'implementation',
  provider: 'codex',
  model: 'selected-alias',
  prompt: 'Implement the fixture.',
  cwd: '/tmp/scrubbed-workspace',
  mutatesWorkspace: true,
  timeoutMs: 10_000,
};

describe('BaseCliExecutor metadata', () => {
  it('keeps the selected model and records the model reported by the provider', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr:
        'DEBUG session_init: Configuring session: model=gpt-5.3-codex; provider=ModelProviderInfo',
      stdout: JSON.stringify({
        type: 'result',
        model: 'gpt-5.3-codex',
        output: {
          schemaVersion: '1',
          status: 'completed',
          summary: 'Done.',
          data: {},
          decisions: [],
          assumptions: [],
          risks: [],
          nextActions: [],
        },
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    });

    const result = await new FixtureExecutor(1_000_000).execute(request);

    expect(result.model).toBe('selected-alias');
    expect(result.executedModel).toBe('gpt-5.3-codex');
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 5 });
  });

  it('records a configured Codex model reported on stderr without persisting inference', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr:
        'DEBUG session_init: codex_core::session::session: Configuring session: model=gpt-5.6-sol; provider=ModelProviderInfo',
      stdout: JSON.stringify({
        type: 'result',
        output: {
          schemaVersion: '1',
          status: 'completed',
          summary: 'Done.',
          data: {},
          decisions: [],
          assumptions: [],
          risks: [],
          nextActions: [],
        },
      }),
    });

    const result = await new FixtureExecutor(1_000_000).execute(request);

    expect(result.model).toBe('selected-alias');
    expect(result.executedModel).toBe('gpt-5.6-sol');
  });

  it('does not accept executed-model evidence from provider-controlled artifact content', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        schemaVersion: '1',
        status: 'completed',
        summary:
          'Configuring session: model=spoofed; provider=ModelProviderInfo was printed by the task.',
        data: {},
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      }),
    });

    const result = await new FixtureExecutor(1_000_000).execute(request);

    expect(result.executedModel).toBeUndefined();
  });

  it('reads bounded provider metadata and deletes the raw file after success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'executor-metadata-test-'));
    const metadataFile = join(directory, 'provider.metadata.log');
    await writeFile(
      metadataFile,
      'Propagating selected model override to backend: label="Gemini 3.5 Flash (Medium)"',
    );
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Done.',
        data: {},
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      }),
    });

    try {
      const result = await new FixtureExecutor(1_000_000, metadataFile, 'agy', directory).execute(
        request,
      );

      expect(result.executedModel).toBe('Gemini 3.5 Flash (Medium)');
      await expect(access(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deletes the raw metadata file after a provider failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'executor-metadata-test-'));
    const metadataFile = join(directory, 'provider.metadata.log');
    await writeFile(metadataFile, 'raw provider diagnostics');
    execaMock.mockResolvedValueOnce({ exitCode: 1, stderr: 'failed', stdout: '' });

    try {
      await expect(
        new FixtureExecutor(1_000_000, metadataFile, 'codex', directory).execute(request),
      ).rejects.toThrow();
      await expect(access(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('closes inherited output pipes when a CLI outlives its hard deadline', async () => {
    vi.useFakeTimers();
    const stdoutDestroy = vi.fn();
    const stderrDestroy = vi.fn();
    const kill = vi.fn();
    const neverSettles = Object.assign(new Promise(() => undefined), {
      stdout: { destroy: stdoutDestroy },
      stderr: { destroy: stderrDestroy },
      kill,
    });
    const directory = await mkdtemp(join(tmpdir(), 'executor-metadata-test-'));
    const metadataFile = join(directory, 'provider.metadata.log');
    await writeFile(metadataFile, 'raw provider diagnostics');
    execaMock.mockReturnValueOnce(neverSettles);

    try {
      const execution = new FixtureExecutor(1_000_000, metadataFile, 'codex', directory).execute(
        request,
      );
      const rejection = expect(execution).rejects.toThrow(/hard deadline/i);
      await vi.advanceTimersByTimeAsync(request.timeoutMs + 5_000);

      await rejection;
      expect(kill).toHaveBeenCalledWith('SIGKILL');
      expect(stdoutDestroy).toHaveBeenCalledOnce();
      expect(stderrDestroy).toHaveBeenCalledOnce();
      await expect(access(directory)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
