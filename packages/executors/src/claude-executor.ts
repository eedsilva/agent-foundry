import type { AgentExecutionRequest, ExecutorHealth } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { createClaudeStreamMapper } from './claude-stream-events.js';

export interface ClaudeCliExecutorOptions {
  provider?: 'claude' | 'glm';
  environment?: NodeJS.ProcessEnv;
}

export function createGlmEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_BASE_URL: env.GLM_BASE_URL?.trim() || 'https://api.z.ai/api/anthropic',
    ...(env.GLM_API_KEY?.trim() ? { ANTHROPIC_AUTH_TOKEN: env.GLM_API_KEY.trim() } : {}),
  };
}

export class ClaudeCliExecutor extends BaseCliExecutor {
  readonly provider: 'claude' | 'glm';
  protected readonly command = 'claude';

  constructor(maxOutputBytes: number, options: ClaudeCliExecutorOptions = {}) {
    super(maxOutputBytes, undefined, options.environment);
    this.provider = options.provider ?? 'claude';
  }

  override async health(): Promise<ExecutorHealth> {
    if (this.provider === 'glm' && !this.environment.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return {
        provider: 'glm',
        available: false,
        message: 'GLM requires GLM_API_KEY for its Anthropic-compatible endpoint.',
      };
    }
    return super.health();
  }

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    const args = [
      '--safe-mode',
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      '--prompt-suggestions',
      'false',
      '--permission-mode',
      request.mutatesWorkspace ? 'acceptEdits' : 'plan',
      '--json-schema',
      JSON.stringify(request.outputSchema ?? {}),
    ];
    if (request.model.trim()) args.push('--model', request.model);
    args.push(request.prompt);

    return {
      command: this.command,
      args,
      ...(Object.keys(this.environment).length > 0 ? { environment: this.environment } : {}),
    };
  }

  protected override createStreamMapper() {
    return createClaudeStreamMapper();
  }
}
