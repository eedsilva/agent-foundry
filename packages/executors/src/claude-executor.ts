import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
 * Common host credential locations the sandbox's default read policy does
 * NOT cover — its own docs say so explicitly: the default still allows
 * reading `~/.aws/credentials` and `~/.ssh/`. Denying the workspaces root
 * (below) says nothing about these, since none of them live under it.
 * `~/.claude/.credentials.json` matters specifically because it's this same
 * `claude` CLI's own credential store (Linux/WSL2 — Keychain on macOS isn't
 * a file this sandbox layer can reach). Not exhaustive; extend when a new
 * credential-shaped file needs covering.
 */
const DENIED_CREDENTIAL_FILES = [
  '~/.ssh',
  '~/.aws/credentials',
  '~/.claude/.credentials.json',
  '~/.netrc',
  '~/.docker/config.json',
  '~/.npmrc',
];

/**
 * OS-level (Seatbelt/bubblewrap) confinement for the Bash tool and its child
 * processes — the only layer that also covers a subprocess reading files
 * directly (`node -e "readFileSync(...)"`), which Read/Edit permission rules
 * never see (docs/adr/0071). `denyRead` on the shared workspaces root and the
 * OS temp root, plus a narrower `allowRead` on this run's own cwd, re-opens
 * just that subtree — sibling projects/worktrees under the same root, other
 * processes' temp files, and host paths outside both stay unreadable, while
 * normal toolchain reads (system libs, this project's own files) keep
 * working. `credentials.files` closes the gap the sandbox's own docs name
 * explicitly: its default read policy still allows `~/.ssh`/
 * `~/.aws/credentials` even with `denyRead` set elsewhere. `network.
 * allowedDomains: ['*']` keeps egress exactly as unrestricted as before this
 * change — #565 is a filesystem-boundary issue, not a network policy
 * change, and guessing a registry/host allowlist wrong would silently break
 * every mutating run's `npm install`/`git push`/`psql`. `docker` can't run
 * inside this sandbox at all (verified empirically, see docs/adr/0071) so
 * it's excluded and stays exactly as unconfined as it always was.
 *
 * `workspaceRoot` and `cwd` must already be realpath-resolved, not just
 * `path.resolve`d: verified empirically that when either traverses a
 * symlink (a routine case — `/tmp` itself is a symlink to `/private/tmp` on
 * macOS), the sandbox silently fails to enforce the boundary at all rather
 * than erroring, because deny/allow rules are matched against the real
 * filesystem path the OS resolves, not the literal string handed to
 * `--settings`. This is the same bug class fixed in
 * `FileWorkspaceManager.readWorkspaceFile` — see docs/adr/0071.
 */
function claudeSandboxSettings(
  realWorkspaceRoot: string,
  realTmpdir: string,
  realCwd: string,
): string {
  const denyRead = [...new Set([realWorkspaceRoot, realTmpdir])];
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead,
        allowRead: [realCwd],
      },
      credentials: {
        files: DENIED_CREDENTIAL_FILES.map((path) => ({ path, mode: 'deny' })),
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
    const [realWorkspaceRoot, realTmpdir, realCwd] = await Promise.all([
      realpath(this.workspaceRoot),
      realpath(tmpdir()),
      realpath(request.cwd),
    ]);
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
      claudeSandboxSettings(realWorkspaceRoot, realTmpdir, realCwd),
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
