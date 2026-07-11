import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';

export class AgyCliExecutor extends BaseCliExecutor {
  readonly provider = 'agy' as const;
  protected readonly command = 'agy';

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    const seconds = Math.max(30, Math.ceil(request.timeoutMs / 1000));
    const args = [
      '--sandbox',
      '--mode',
      request.mutatesWorkspace ? 'accept-edits' : 'plan',
      '--print-timeout',
      `${seconds}s`,
    ];
    if (request.model.trim()) args.push('--model', request.model);
    args.push('--print', request.prompt);

    return {
      command: this.command,
      args,
    };
  }
}
