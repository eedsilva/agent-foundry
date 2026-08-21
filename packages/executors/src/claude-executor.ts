import { resolve } from 'node:path';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { createClaudeStreamMapper } from './claude-stream-events.js';

/**
 * Bash allowlist for mutating runs — the toolchain this repo's generated
 * apps actually need (#537: a denied `pnpm db:types` etc. left a task's only
 * deliverable unproduced). Extend this list to cover a new binary; see
 * docs/adr/0063 for the security tradeoffs before adding one.
 *
 * `docker` stays on the list even though the OS sandbox below can't wrap it
 * (docs/adr/0071) — it runs unsandboxed for anyone on this list, same as
 * every entry did before #565, and it stays useless in the containerized
 * deployment (no docker.sock there) while remaining functional for the
 * trusted local-dev fallback (local-execution-plane.ts).
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

/**
 * OS-level (Seatbelt/bubblewrap) confinement for the Bash tool and its child
 * processes — the only layer that also covers a subprocess reading files
 * directly (`node -e "readFileSync(...)"`), which Read/Edit permission rules
 * never see (docs/adr/0071). `denyRead` on the shared workspaces root plus a
 * narrower `allowRead` on this run's own cwd re-opens just that subtree, so
 * sibling projects/worktrees under the same root and host paths outside it
 * stay unreadable while normal toolchain reads (system libs, this
 * project's own files) keep working. `network.allowedDomains: ['*']` keeps
 * egress exactly as unrestricted as before this change — #565 is a
 * filesystem-boundary issue, not a network policy change, and guessing a
 * registry/host allowlist wrong would silently break every mutating run's
 * `npm install`/`git push`/`psql`. `docker` can't run inside this sandbox at
 * all (verified empirically, see docs/adr/0071) so it's excluded and stays
 * exactly as unconfined as it always was.
 */
function claudeSandboxSettings(workspaceRoot: string, cwd: string): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [workspaceRoot],
        allowRead: [cwd],
      },
      network: { allowedDomains: ['*'] },
      excludedCommands: ['docker *'],
    },
  });
}

export class ClaudeCliExecutor extends BaseCliExecutor {
  readonly provider = 'claude';
  protected readonly command = 'claude';
  private readonly workspaceRoot: string;

  constructor(maxOutputBytes: number, workspaceRoot: string) {
    super(maxOutputBytes);
    this.workspaceRoot = resolve(workspaceRoot);
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
      '--settings',
      claudeSandboxSettings(this.workspaceRoot, request.cwd),
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
