import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { promptWithOutputSchema } from './output-schema-prompt.js';

export class CodexCliExecutor extends BaseCliExecutor {
  readonly provider = 'codex' as const;
  protected readonly command = 'codex';

  constructor(
    maxOutputBytes: number,
    private readonly reportConfiguredModel = false,
  ) {
    super(maxOutputBytes);
  }

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    const input = promptWithOutputSchema(request, 'Codex');
    const outputDirectory = await mkdtemp(join(tmpdir(), 'agent-foundry-codex-output-'));
    const outputFile = join(outputDirectory, 'codex.final.json');
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--color',
      'never',
      '--sandbox',
      request.mutatesWorkspace ? 'workspace-write' : 'read-only',
      '--skip-git-repo-check',
      '--output-last-message',
      outputFile,
    ];
    if (request.model.trim()) args.push('--model', request.model);
    args.push('-');

    return {
      command: this.command,
      args,
      input,
      outputFile,
      outputDirectory,
      ...(this.reportConfiguredModel
        ? { environment: { RUST_LOG: 'codex_core::session::session=debug' } }
        : {}),
    };
  }
}
