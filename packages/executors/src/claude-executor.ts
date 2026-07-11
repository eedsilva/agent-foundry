import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';

export class ClaudeCliExecutor extends BaseCliExecutor {
  readonly provider = 'claude' as const;
  protected readonly command = 'claude';

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    const args = [
      '--bare',
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
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
    };
  }
}
