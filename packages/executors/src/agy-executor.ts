import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { promptWithOutputSchema } from './output-schema-prompt.js';

export interface AgyCliExecutorOptions {
  reportConfiguredModel?: boolean;
  newProject?: boolean;
}

export class AgyCliExecutor extends BaseCliExecutor {
  readonly provider = 'agy' as const;
  protected readonly command = 'agy';

  constructor(
    maxOutputBytes: number,
    private readonly options: AgyCliExecutorOptions = {},
  ) {
    super(maxOutputBytes);
  }

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    const seconds = Math.max(30, Math.ceil(request.timeoutMs / 1000));
    const metadataDirectory = this.options.reportConfiguredModel
      ? await mkdtemp(join(tmpdir(), 'agent-foundry-agy-metadata-'))
      : undefined;
    const metadataFile = metadataDirectory
      ? join(metadataDirectory, 'agy.metadata.log')
      : undefined;
    const args = [
      ...(this.options.newProject ? ['--new-project'] : []),
      '--sandbox',
      ...(metadataFile ? ['--log-file', metadataFile] : []),
      '--mode',
      request.mutatesWorkspace ? 'accept-edits' : 'plan',
      '--print-timeout',
      `${seconds}s`,
    ];
    if (request.model.trim()) args.push('--model', request.model);
    args.push('--print', promptWithOutputSchema(request, 'AGY'));

    return {
      command: this.command,
      args,
      ...(metadataFile && metadataDirectory ? { metadataFile, metadataDirectory } : {}),
    };
  }
}
