import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execa } from 'execa';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutorHealth,
  Provider,
} from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';
import { ExecutionError, errorMessage } from '@agent-foundry/domain';
import { extractUsage, parseAgentArtifact } from './json-output.js';

export interface CliInvocation {
  command: string;
  args: string[];
  input?: string;
  outputFile?: string;
  environment?: NodeJS.ProcessEnv;
}

interface CliResult {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: number;
}

export abstract class BaseCliExecutor implements AgentExecutor {
  abstract readonly provider: Provider;
  protected abstract readonly command: string;

  constructor(private readonly maxOutputBytes: number) {}

  protected abstract invocation(request: AgentExecutionRequest): Promise<CliInvocation>;

  protected async responseText(invocation: CliInvocation, stdout: string): Promise<string> {
    if (invocation.outputFile) {
      try {
        await access(invocation.outputFile, constants.R_OK);
        const { readFile } = await import('node:fs/promises');
        return await readFile(invocation.outputFile, 'utf8');
      } catch {
        // Fall through to stdout. Some CLI versions may omit the output file on partial success.
      }
    }
    return stdout;
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const startedAt = Date.now();
    const invocation = await this.invocation(request);
    let result: CliResult;

    try {
      result = await execa(invocation.command, invocation.args, {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        maxBuffer: this.maxOutputBytes,
        reject: false,
        all: false,
        windowsHide: true,
        encoding: 'utf8',
        ...(invocation.input !== undefined ? { input: invocation.input } : {}),
        ...(invocation.environment ? { env: cleanEnvironment(invocation.environment) } : {}),
      });
    } catch (error) {
      throw new ExecutionError(`${this.provider} CLI could not be executed: ${errorMessage(error)}`, {
        provider: this.provider,
        model: request.model,
        cause: error,
      });
    }

    const stdout = outputText(result.stdout);
    const stderr = outputText(result.stderr);
    if (result.exitCode !== 0) {
      throw new ExecutionError(
        `${this.provider} CLI exited with code ${String(result.exitCode)}`,
        {
          provider: this.provider,
          model: request.model,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          stdout: stdout.slice(0, 20_000),
          stderr: stderr.slice(0, 20_000),
        },
      );
    }

    const response = await this.responseText(invocation, stdout);
    const output = parseAgentArtifact(response);
    const usage = extractUsage(stdout);

    return {
      runId: request.runId,
      provider: this.provider,
      model: request.model,
      exitCode: result.exitCode ?? 0,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr,
      output,
      ...(usage ? { usage } : {}),
    };
  }

  async health(): Promise<ExecutorHealth> {
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
      };
    } catch (error) {
      return {
        provider: this.provider,
        available: false,
        message: errorMessage(error),
      };
    }
  }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(outputText).join('\n');
  return value == null ? '' : String(value);
}

function cleanEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
