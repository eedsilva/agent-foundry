import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { AgentExecutionRequest, Provider } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

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

  protected override async responseText(
    _invocation: CliInvocation,
    _stdout: string,
  ): Promise<string> {
    return this.provider === 'codex'
      ? JSON.stringify(completedArtifact)
      : JSON.stringify({ type: 'result', output: completedArtifact });
  }
}

class RawOutputFixtureExecutor extends FixtureExecutor {
  protected override async responseText(
    _invocation: CliInvocation,
    stdout: string,
  ): Promise<string> {
    return stdout;
  }
}

class OutputFixtureExecutor extends BaseCliExecutor {
  readonly provider = 'codex';
  protected readonly command = 'fixture-cli';

  protected async invocation(): Promise<CliInvocation> {
    return { command: this.command, args: [] };
  }

  readResponse(outputFile: string, stdout: string): Promise<string> {
    return this.responseText({ command: this.command, args: [], outputFile }, stdout);
  }
}

const completedArtifact = {
  schemaVersion: '1',
  status: 'completed',
  summary: 'Done.',
  data: {},
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
};

const request: AgentExecutionRequest = {
  runId: 'run-1',
  stepRunId: 'step-run-1',
  attemptId: 'attempt-1',
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
        type: 'turn.completed',
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    });

    const result = await new FixtureExecutor(1_000_000).execute(request);

    expect(result.model).toBe('selected-alias');
    expect(result.executedModel).toBe('gpt-5.3-codex');
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      sourceQuality: 'provider-reported',
    });
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

describe('BaseCliExecutor rate limit (issue #62)', () => {
  it('surfaces the last observed rate limit in health()', async () => {
    const executor = new FixtureExecutor(1_000_000);
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
      stdout: fixture('claude.rate-limited.stdout.json'),
    });

    await executor.execute(request);

    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'claude-cli 1.0.0', stderr: '' });
    const health = await executor.health();

    expect(health.rateLimit).toEqual({
      limit: 100,
      remaining: 0,
      resetAt: '2026-07-18T13:00:00.000Z',
    });
  });

  it('keeps a rate limit reported with a non-zero exit in health()', async () => {
    const executor = new FixtureExecutor(1_000_000, undefined, 'claude');
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stderr: 'rate limited',
      stdout: fixture('claude.rate-limited.stdout.json'),
    });

    await expect(executor.execute(request)).rejects.toThrow('CLI exited with code 1');
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'claude-cli 1.0.0', stderr: '' });
    await expect(executor.health()).resolves.toMatchObject({
      rateLimit: { limit: 100, remaining: 0, resetAt: '2026-07-18T13:00:00.000Z' },
    });
  });

  it('keeps a rate limit reported with an error artifact in health()', async () => {
    const executor = new RawOutputFixtureExecutor(1_000_000, undefined, 'claude');
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        rate_limit: { limit: 2, remaining: 0, reset_at: '2026-07-20T12:00:00.000Z' },
      }),
    });

    await expect(executor.execute(request)).rejects.toThrow(
      'Agent did not return a valid artifact',
    );
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'claude-cli 1.0.0', stderr: '' });
    await expect(executor.health()).resolves.toMatchObject({
      rateLimit: { limit: 2, remaining: 0, resetAt: '2026-07-20T12:00:00.000Z' },
    });
  });
});

describe('BaseCliExecutor stream tap', () => {
  it('invokes onEvent with events produced by the subclass stream mapper as stdout arrives', async () => {
    const { PassThrough } = await import('node:stream');
    const stdout = new PassThrough();

    class StreamingExecutor extends BaseCliExecutor {
      readonly provider = 'claude' as const;
      protected readonly command = 'fixture-cli';

      protected async invocation(): Promise<CliInvocation> {
        return { command: this.command, args: [] };
      }

      protected override async responseText(): Promise<string> {
        return JSON.stringify({ type: 'result', result: JSON.stringify(completedArtifact) });
      }

      protected override createStreamMapper() {
        return (line: string) =>
          line.includes('hello') ? [{ type: 'status' as const, phase: 'hello' }] : [];
      }
    }

    const resultPromise = new Promise<{ exitCode: number; stdout: string }>((resolve) => {
      execaMock.mockImplementationOnce(() => {
        const promise = Promise.resolve().then(() => {
          stdout.write('{"line":"hello"}\n');
          stdout.write('{"line":"world"}\n');
          stdout.end();
          return { exitCode: 0, stdout: '', stderr: '' };
        });
        Object.assign(promise, { stdout, stderr: null, pid: 1, kill: () => true });
        resolve(promise as unknown as { exitCode: number; stdout: string });
        return promise;
      });
    });
    void resultPromise;

    const events: unknown[] = [];
    const executor = new StreamingExecutor(1_000_000);
    await executor.execute(request, undefined, (event) => events.push(event));

    expect(events).toEqual([{ type: 'status', phase: 'hello' }]);
  });
});

describe('BaseCliExecutor output', () => {
  it('reads the output file directly and falls back to stdout when it is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'executor-output-test-'));
    const outputFile = join(directory, 'provider-output.json');
    const executor = new OutputFixtureExecutor(1_000_000);

    try {
      await writeFile(outputFile, 'file output');
      await expect(executor.readResponse(outputFile, 'stdout output')).resolves.toBe('file output');

      await rm(outputFile);
      await expect(executor.readResponse(outputFile, 'stdout output')).resolves.toBe(
        'stdout output',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// The orchestrator's mock-executor test harness never reaches this file (see
// tracing-integration.test.ts), so the foundry.cli span is exercised here
// directly against a stubbed execa process instead.
describe('BaseCliExecutor foundry.cli span', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
  });

  afterEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('records the command name only, never args, and succeeds', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify(completedArtifact),
    });

    await new FixtureExecutor(1_000_000).execute(request);

    const spans = exporter.getFinishedSpans();
    const cliSpan = spans.find((span) => span.name === 'foundry.cli');
    expect(cliSpan).toBeDefined();
    expect(cliSpan?.attributes).toEqual({
      'foundry.provider': 'codex',
      'foundry.cli.command': 'fixture-cli',
    });
    expect(cliSpan?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks the span ERROR on a nonzero exit without leaking stdout/stderr into attributes', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 1, stderr: 'boom', stdout: '' });

    await expect(new FixtureExecutor(1_000_000).execute(request)).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    const cliSpan = spans.find((span) => span.name === 'foundry.cli');
    expect(cliSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(Object.keys(cliSpan?.attributes ?? {})).toEqual([
      'foundry.provider',
      'foundry.cli.command',
    ]);
  });
});

describe('BaseCliExecutor environment isolation', () => {
  it('never inherits the control plane process env into the CLI subprocess', async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://control-plane-only-leak-canary';
    try {
      execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
      await new FixtureExecutor(1_000_000).execute(request);

      const [, , options] = execaMock.mock.calls[0]!;
      expect(options.env).toBeDefined();
      expect(options.env).not.toHaveProperty('DATABASE_URL');
      expect(Object.keys(options.env).length).toBeGreaterThan(0);
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });
});
