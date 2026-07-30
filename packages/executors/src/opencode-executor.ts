import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutionRequest, ExecutorHealth } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { promptWithOutputSchema } from './output-schema-prompt.js';

/**
 * OpenCode is the agentic harness for local Ollama models. It stays on the
 * cheap verification rung until real task outcomes justify broader routing.
 */
export class OpenCodeCliExecutor extends BaseCliExecutor {
  readonly provider = 'opencode' as const;
  protected readonly command = 'opencode';

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    const localModel = request.model.replace(/^ollama\//, '');
    const model = `ollama/${localModel}`;
    const configDirectory = await mkdtemp(join(tmpdir(), 'agent-foundry-opencode-'));
    const configPath = join(configDirectory, 'opencode.json');
    const permission = {
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      external_directory: 'deny',
      ...(request.mutatesWorkspace ? { edit: 'allow' } : {}),
    };

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          provider: {
            ollama: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Ollama (local)',
              options: { baseURL: `${ollamaHost()}/v1` },
              models: { [localModel]: { name: localModel } },
            },
          },
          permission,
        }),
      );
    } catch (error) {
      await rm(configDirectory, { force: true, recursive: true });
      throw error;
    }

    const args = [
      'run',
      '--format',
      'json',
      '--dir',
      request.cwd,
      '--model',
      model,
      '--agent',
      request.mutatesWorkspace ? 'build' : 'plan',
      ...(request.mutatesWorkspace ? ['--auto'] : []),
      promptWithOutputSchema(request, 'OpenCode'),
    ];

    return {
      command: this.command,
      args,
      environment: { OPENCODE_CONFIG: configPath },
      outputDirectory: configDirectory,
    };
  }

  override async health(): Promise<ExecutorHealth> {
    const cli = await super.health();
    if (!cli.available) return cli;

    try {
      const response = await fetch(`${ollamaHost()}/api/tags`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        return {
          ...cli,
          available: false,
          message: `OpenCode is available, but Ollama returned HTTP ${String(response.status)}.`,
        };
      }
      return { ...cli, message: 'OpenCode and the Ollama endpoint are ready.' };
    } catch {
      return {
        ...cli,
        available: false,
        message: 'OpenCode is available, but the Ollama endpoint is unreachable.',
      };
    }
  }
}

export function ollamaHost(value = process.env.OLLAMA_HOST): string {
  const host = value?.trim() || 'http://127.0.0.1:11434';
  let normalized = host.includes('://') ? host : `http://${host}`;
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized.endsWith('/v1')) normalized = normalized.slice(0, -3);
  return normalized;
}
