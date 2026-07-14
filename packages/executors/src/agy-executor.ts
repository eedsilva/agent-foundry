import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';

const MAX_OUTPUT_SCHEMA_BYTES = 32 * 1024;

export class AgyCliExecutor extends BaseCliExecutor {
  readonly provider = 'agy' as const;
  protected readonly command = 'agy';

  constructor(
    maxOutputBytes: number,
    private readonly reportConfiguredModel = false,
  ) {
    super(maxOutputBytes);
  }

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    const seconds = Math.max(30, Math.ceil(request.timeoutMs / 1000));
    const metadataFile = join(
      request.cwd,
      '.orchestrator',
      'runs',
      request.runId,
      'agy.metadata.log',
    );
    const args = [
      '--sandbox',
      ...(this.reportConfiguredModel ? ['--log-file', metadataFile] : []),
      '--mode',
      request.mutatesWorkspace ? 'accept-edits' : 'plan',
      '--print-timeout',
      `${seconds}s`,
    ];
    if (request.model.trim()) args.push('--model', request.model);
    args.push('--print', promptWithOutputSchema(request));

    return {
      command: this.command,
      args,
      ...(this.reportConfiguredModel ? { metadataFile } : {}),
    };
  }
}

function promptWithOutputSchema(request: AgentExecutionRequest): string {
  if (request.outputSchema === undefined) return request.prompt;

  const outputSchema = JSON.stringify(request.outputSchema);
  if (Buffer.byteLength(outputSchema, 'utf8') > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new RangeError(`AGY output schema exceeds ${String(MAX_OUTPUT_SCHEMA_BYTES)} bytes`);
  }

  return `${request.prompt}\n\nOutput JSON Schema:\n${outputSchema}`;
}
