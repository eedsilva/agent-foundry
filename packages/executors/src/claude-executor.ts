import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { createClaudeStreamMapper } from './claude-stream-events.js';

/**
 * Sibling of `projects/`, not inside any of them — `FileWorkspaceManager`
 * never walks this directory, so nothing here interacts with a project's
 * own git history.
 */
const RUN_TMP_DIRNAME = '.agent-foundry-run-tmp';

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
 * a file this sandbox layer can reach).
 *
 * This is a named deny list, not an allowlist: everything else under
 * `$HOME` outside `filesystem.denyRead` (e.g. `~/.kube`, `~/.gnupg`,
 * `~/Documents`) stays readable by design (docs/adr/0071 already rejected
 * `denyRead: ["/"]` — it breaks the toolchain). Extend this list when a new
 * credential-shaped file needs covering; don't read its presence as "host
 * secrets are covered."
 */
const DENIED_CREDENTIAL_FILES = [
  '~/.ssh',
  '~/.aws/credentials',
  '~/.claude/.credentials.json',
  '~/.netrc',
  '~/.docker/config.json',
  '~/.npmrc',
  // git — the toolchain this repo's own MUTATING_BASH_ALLOWLIST relies on
  // most.
  '~/.git-credentials',
  // gh — holds the GitHub token in plaintext (mode 0600, same host user the
  // sandbox runs as).
  '~/.config/gh/hosts.yml',
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
 * `workspaceRoot`, `cwd`, and `runTempDir` must already be realpath-resolved,
 * not just `path.resolve`d: verified empirically that when any of them
 * traverses a symlink (a routine case — `/tmp` itself is a symlink to
 * `/private/tmp` on macOS), the sandbox silently fails to enforce the
 * boundary at all rather than erroring, because deny/allow rules are
 * matched against the real filesystem path the OS resolves, not the literal
 * string handed to `--settings`. This is the same bug class fixed in
 * `FileWorkspaceManager.readWorkspaceFile` — see docs/adr/0071.
 *
 * `runTempDir` is a narrower `allowRead` re-opened inside the
 * `workspaceRoot` deny, not folded into `cwd`: it must live outside the run's
 * worktree (`cwd`), because `FileWorkspaceManager.checkpoint`/`commit`/
 * `preserveDraft`/`ensureGit` all run `git add -A` there — a temp file
 * inside the worktree gets staged, checkpointed, and on `integrateWorktree`
 * merged into the primary, landing in the generated app's own history. The
 * repo already paid for this exact mistake once, with a shared node_modules
 * symlink (`workspace-manager.ts`, `#excludeNodeModules`'s doc comment).
 */
function claudeSandboxSettings(
  realWorkspaceRoot: string,
  realTmpdir: string,
  realCwd: string,
  realRunTempDir: string,
): string {
  const denyRead = [...new Set([realWorkspaceRoot, realTmpdir])];
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead,
        allowRead: [realCwd, realRunTempDir],
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
    // Own directory, not the shared host tmpdir denied above: `pnpm`/`git`/
    // `node` see $TMPDIR (below) and round-trip files through it — writing
    // to a directory this run can't read back would silently break that
    // toolchain (#565 review). Rooted under workspaceRoot, a sibling of
    // `projects/`, so it's outside the worktree `git add -A` walks and
    // outside every other project's own tree.
    const declaredRunTempRoot = join(realWorkspaceRoot, RUN_TMP_DIRNAME);
    await mkdir(declaredRunTempRoot, { recursive: true });
    // realpath'd separately from workspaceRoot: this exact value becomes
    // outputDirectoryRoot below, the boundary BaseCliExecutor's cleanup
    // guard trusts before its recursive rm. workspaceRoot itself (the whole
    // Data Directory, containing every project's worktree) would make that
    // guard accept any project's directory as "contained" — verified: a
    // narrower root here is what makes the guard mean anything (#565
    // review).
    //
    // realpath() here does NOT itself make this fail closed against a
    // symlinked .agent-foundry-run-tmp — it follows the symlink, so
    // runTempRoot becomes the symlink's target and mkdtemp below creates
    // the run's temp dir there, contained by construction; the guard would
    // still approve. The explicit equality check is what actually fails
    // closed: refuses to proceed rather than silently trusting wherever a
    // replaced directory now points (#565 review).
    const runTempRoot = await realpath(declaredRunTempRoot);
    if (runTempRoot !== declaredRunTempRoot) {
      throw new Error(
        `${RUN_TMP_DIRNAME} resolved to a different path (${runTempRoot}) than declared (${declaredRunTempRoot}) — refusing to use a symlinked run-temp root.`,
      );
    }
    const runTempDir = await mkdtemp(join(runTempRoot, 'run-'));
    const realRunTempDir = await realpath(runTempDir);
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
      claudeSandboxSettings(realWorkspaceRoot, realTmpdir, realCwd, realRunTempDir),
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
      environment: {
        ...this.environment,
        TMPDIR: realRunTempDir,
        TEMP: realRunTempDir,
        TMP: realRunTempDir,
      },
      outputDirectory: realRunTempDir,
      outputDirectoryRoot: runTempRoot,
    };
  }

  protected override createStreamMapper() {
    return createClaudeStreamMapper();
  }
}
