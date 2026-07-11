import { join } from 'node:path';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';

export class CodexCliExecutor extends BaseCliExecutor {
  readonly provider = 'codex' as const;
  protected readonly command = 'codex';

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    const runDir = join(request.cwd, '.orchestrator', 'runs', request.runId);
    const schemaPath = join(runDir, 'output.schema.json');
    const outputFile = join(runDir, 'codex.final.json');
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--color',
      'never',
      '--sandbox',
      request.mutatesWorkspace ? 'workspace-write' : 'read-only',
      '--ask-for-approval',
      'never',
      '--skip-git-repo-check',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputFile,
    ];
    if (request.model.trim()) args.push('--model', request.model);
    args.push('-');

    return {
      command: this.command,
      args,
      input: request.prompt,
      outputFile,
    };
  }
}
