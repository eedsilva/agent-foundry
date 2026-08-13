import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { createClaudeStreamMapper } from './claude-stream-events.js';

/**
 * Bash allowlist for mutating runs — the toolchain this repo's generated
 * apps actually need (#537: a denied `pnpm db:types` etc. left a task's only
 * deliverable unproduced). Extend this list to cover a new binary; see
 * docs/adr/0063 for the security tradeoffs before adding one.
 */
const MUTATING_BASH_ALLOWLIST = ['pnpm', 'npm', 'npx', 'node', 'git', 'docker', 'supabase', 'psql'];

function claudeJsonSchema(schema: AgentExecutionRequest['outputSchema']): string {
  if (schema === undefined) return '{}';

  const compatibleSchema = JSON.parse(
    JSON.stringify(schema, (key, value: unknown) =>
      key === '$schema' || key === 'prefixItems' || key.startsWith('x-') ? undefined : value,
    ),
  ) as Record<string, unknown>;
  return JSON.stringify(compatibleSchema);
}

export class ClaudeCliExecutor extends BaseCliExecutor {
  readonly provider = 'claude';
  protected readonly command = 'claude';

  constructor(maxOutputBytes: number) {
    super(maxOutputBytes);
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
      claudeJsonSchema(request.outputSchema),
    ];
    if (request.mutatesWorkspace) {
      // Single `--allowedTools=` token, not `--allowedTools`, value: the
      // flag is variadic (`<tools...>`), so a separate space- or
      // comma-joined argv entry gets greedily consumed along with the
      // positional prompt that follows it, breaking the CLI with "Input
      // must be provided ... as a prompt argument" (confirmed empirically
      // — see docs/adr/0063).
      args.push(
        '--allowedTools=' + MUTATING_BASH_ALLOWLIST.map((bin) => `Bash(${bin} *)`).join(','),
      );
    }
    if (request.model.trim()) args.push('--model', request.model);
    if (request.systemPrompt !== undefined) {
      args.push('--append-system-prompt', request.systemPrompt);
    }
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
