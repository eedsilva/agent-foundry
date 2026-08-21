import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ECONOMY_PROFILE_LUNA_MODEL, type AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { createCodexStreamMapper } from './codex-stream-events.js';
import { promptWithOutputSchema } from './output-schema-prompt.js';

/**
 * TOML literal strings (`'''...'''`) take content verbatim — zero backslash or
 * quote escaping — which is exactly right for arbitrary markdown role content.
 * Their one constraint: the content itself cannot contain the delimiter.
 */
function developerInstructionsArg(systemPrompt: string): string {
  if (systemPrompt.includes("'''")) {
    throw new Error(
      "Codex system prompt cannot contain the TOML literal-string delimiter (''') — " +
        'it would break the developer_instructions -c argument.',
    );
  }
  return `developer_instructions='''${systemPrompt}'''`;
}

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
    if (request.model === ECONOMY_PROFILE_LUNA_MODEL && request.reasoningEffort !== 'high') {
      throw new Error('GPT Luna requires explicit reasoning effort high');
    }
    // Validate before mkdtemp so an invalid request never leaks a temp directory.
    const input = promptWithOutputSchema(request, 'Codex');
    const developerInstructions =
      request.systemPrompt !== undefined
        ? developerInstructionsArg(request.systemPrompt)
        : undefined;
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
    if (request.reasoningEffort !== undefined) {
      args.push('-c', `model_reasoning_effort=${request.reasoningEffort}`);
    }
    if (developerInstructions !== undefined) args.push('-c', developerInstructions);
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

  protected override createStreamMapper() {
    return createCodexStreamMapper();
  }
}
