import { open, readFile, rm } from 'node:fs/promises';
import { execa } from 'execa';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutorHealth,
  ExecutorStreamEvent,
  Provider,
  ProviderRateLimit,
} from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';
import { ExecutionError, RunCancelledError, errorMessage, withSpan } from '@agent-foundry/domain';
import {
  extractExecutedModel,
  extractRateLimit,
  extractUsage,
  parseAgentArtifact,
} from './json-output.js';
import { killProcessTree, terminateProcessTree } from './process-tree.js';
import { pickSafeEnvironment } from './safe-environment.js';

export interface CliInvocation {
  command: string;
  args: string[];
  input?: string;
  outputFile?: string;
  outputDirectory?: string;
  metadataFile?: string;
  metadataDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

interface CliResult {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: number;
}

interface CliSubprocess extends PromiseLike<CliResult> {
  pid?: number;
  kill?(signal?: NodeJS.Signals): boolean;
  stdout?: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): void;
    destroy(): void;
  } | null;
  stderr?: { destroy(): void } | null;
}

const HARD_TIMEOUT_GRACE_MS = 5_000;

export abstract class BaseCliExecutor implements AgentExecutor {
  abstract readonly provider: Provider;
  protected abstract readonly command: string;
  private lastRateLimit: ProviderRateLimit | undefined;

  constructor(
    private readonly maxOutputBytes: number,
    private readonly killGraceMs = HARD_TIMEOUT_GRACE_MS,
  ) {}

  protected abstract invocation(request: AgentExecutionRequest): Promise<CliInvocation>;

  /**
   * Providers with an incremental JSONL stdout format (Claude, Codex) override
   * this to return a per-invocation, stateful line mapper. Providers without
   * one (mock, agy) leave it undefined — onEvent is then simply never called,
   * and callers must already treat onEvent as optional.
   */
  protected createStreamMapper(): ((line: string) => ExecutorStreamEvent[]) | undefined {
    return undefined;
  }

  protected async responseText(invocation: CliInvocation, stdout: string): Promise<string> {
    if (invocation.outputFile) {
      try {
        return await readFile(invocation.outputFile, 'utf8');
      } catch {
        // Fall through to stdout. Some CLI versions may omit the output file on partial success.
      }
    }
    return stdout;
  }

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    if (signal?.aborted) throw new RunCancelledError(request.runId);
    const startedAt = Date.now();
    const invocation = await this.invocation(request);
    try {
      // Command name only — args/prompt text must never land on a span.
      return await withSpan(
        'foundry.cli',
        { 'foundry.provider': this.provider, 'foundry.cli.command': invocation.command },
        () => this.executeInvocation(request, invocation, startedAt, signal, onEvent),
      );
    } finally {
      const directories = new Set(
        [invocation.outputDirectory, invocation.metadataDirectory].filter((path): path is string =>
          Boolean(path),
        ),
      );
      await Promise.all([...directories].map((path) => rm(path, { force: true, recursive: true })));
      if (invocation.outputFile && !invocation.outputDirectory) {
        await rm(invocation.outputFile, { force: true });
      }
      if (invocation.metadataFile && !invocation.metadataDirectory) {
        await rm(invocation.metadataFile, { force: true });
      }
    }
  }

  private async executeInvocation(
    request: AgentExecutionRequest,
    invocation: CliInvocation,
    startedAt: number,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    let result: CliResult;
    let onAbort: (() => void) | undefined;

    try {
      const subprocess = execa(invocation.command, invocation.args, {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        maxBuffer: this.maxOutputBytes,
        reject: false,
        all: false,
        windowsHide: true,
        encoding: 'utf8',
        // Own process group on POSIX so cancellation can terminate the whole CLI tree.
        detached: process.platform !== 'win32',
        ...(invocation.input !== undefined ? { input: invocation.input } : {}),
        env: cleanEnvironment({ ...pickSafeEnvironment(), ...invocation.environment }),
      }) as unknown as CliSubprocess;
      if (onEvent) attachStreamTap(subprocess, this.createStreamMapper(), onEvent);
      if (signal) {
        onAbort = () => {
          void terminateProcessTree(subprocess, this.killGraceMs);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      result = await waitForCliResult(subprocess, request.timeoutMs + HARD_TIMEOUT_GRACE_MS);
    } catch (error) {
      if (signal?.aborted) throw new RunCancelledError(request.runId);
      throw new ExecutionError(
        `${this.provider} CLI could not be executed: ${errorMessage(error)}`,
        {
          provider: this.provider,
          model: request.model,
          cause: error,
        },
      );
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted) throw new RunCancelledError(request.runId);
    const stdout = outputText(result.stdout);
    const stderr = outputText(result.stderr);
    const rateLimit = extractRateLimit(this.provider, stdout);
    if (rateLimit) this.lastRateLimit = rateLimit;
    if (result.exitCode !== 0) {
      throw new ExecutionError(`${this.provider} CLI exited with code ${String(result.exitCode)}`, {
        provider: this.provider,
        model: request.model,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        stdout: stdout.slice(0, 20_000),
        stderr: stderr.slice(0, 20_000),
      });
    }

    const response = await this.responseText(invocation, stdout);
    const output = parseAgentArtifact(this.provider, response);
    const usage = extractUsage(this.provider, stdout);
    const metadata = invocation.metadataFile
      ? await readBoundedFile(invocation.metadataFile, this.maxOutputBytes)
      : '';
    const executedModel = extractExecutedModel(this.provider, { stdout, stderr, metadata });

    return {
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      provider: this.provider,
      model: request.model,
      exitCode: result.exitCode ?? 0,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr,
      output,
      ...(executedModel ? { executedModel } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  async health(): Promise<ExecutorHealth> {
    // ponytail: lastRateLimit is the value observed on the most recent run and is
    // never invalidated here; the router already gates on resetAt, so a past-reset
    // value is inert. Add TTL/eviction only if another health() consumer needs it.
    const rateLimit = this.lastRateLimit ? { rateLimit: this.lastRateLimit } : {};
    try {
      const result = await execa(this.command, ['--version'], {
        reject: false,
        timeout: 10_000,
      });
      const available = result.exitCode === 0;
      return {
        provider: this.provider,
        available,
        ...(available ? { version: outputText(result.stdout || result.stderr).trim() } : {}),
        message: available
          ? `${this.command} is available`
          : `${this.command} returned exit code ${String(result.exitCode)}`,
        ...rateLimit,
      };
    } catch (error) {
      return {
        provider: this.provider,
        available: false,
        message: errorMessage(error),
        ...rateLimit,
      };
    }
  }
}

async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  try {
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.max(1, maxBytes));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return '';
  }
}

function attachStreamTap(
  subprocess: CliSubprocess,
  mapLine: ((line: string) => ExecutorStreamEvent[]) | undefined,
  onEvent: (event: ExecutorStreamEvent) => void,
): void {
  if (!mapLine || !subprocess.stdout) return;
  let buffer = '';
  subprocess.stdout.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) for (const event of mapLine(line)) onEvent(event);
      newlineIndex = buffer.indexOf('\n');
    }
  });
}

function waitForCliResult(subprocess: CliSubprocess, hardTimeoutMs: number): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        killProcessTree(subprocess, 'SIGKILL');
        subprocess.stdout?.destroy();
        subprocess.stderr?.destroy();
        reject(new Error(`CLI exceeded its ${String(hardTimeoutMs)}ms hard deadline.`));
      });
    }, hardTimeoutMs);

    Promise.resolve(subprocess).then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(outputText).join('\n');
  return value == null ? '' : String(value);
}

function cleanEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
