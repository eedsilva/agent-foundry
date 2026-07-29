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
    const model = request.model.includes('/') ? request.model : `ollama/${request.model}`;
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

    return { command: this.command, args };
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
  return host.includes('://') ? host.replace(/\/+$/, '') : `http://${host}`;
}
