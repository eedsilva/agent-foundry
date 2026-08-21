import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { ECONOMY_PROFILE_LUNA_MODEL, type AgentExecutionRequest } from '@agent-foundry/contracts';
import { errorMessage } from '@agent-foundry/domain';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';
import { createCodexStreamMapper } from './codex-stream-events.js';
import { promptWithOutputSchema } from './output-schema-prompt.js';
import { safeSpawnEnv } from './safe-environment.js';

/**
 * Sibling of `projects/`, not inside any of them — same convention as
 * `claude-executor.ts`'s `RUN_TMP_DIRNAME`. `FileWorkspaceManager` never
 * walks this directory, so nothing here interacts with a project's own git
 * history.
 */
const RUN_TMP_DIRNAME = '.agent-foundry-run-tmp';

/**
 * Codex authenticates via `~/.codex/auth.json`, not an env var — this
 * repo's `safe-env-allowlist.json` carries no `OPENAI_API_KEY` or similar,
 * so nothing here ever passes a credential through the environment
 * (#637). Denying these mirrors `claude-executor.ts`'s
 * `DENIED_CREDENTIAL_FILES`: srt's default read policy is "allow
 * everywhere except denyRead," so without this list every one of these
 * stays readable to the sandboxed process.
 */
const DENIED_CREDENTIAL_RELATIVE_PATHS = [
  '.ssh',
  '.aws/credentials',
  '.claude/.credentials.json',
  '.netrc',
  '.docker/config.json',
  '.npmrc',
  '.git-credentials',
  '.config/gh/hosts.yml',
];

/**
 * Static allowlist only — copied from docs/adr/0076's own enumeration
 * ("the selected model provider's authentication and inference endpoints"
 * + "the public registry.npmjs.org"), not guessed. `chatgpt.com`/
 * `ab.chatgpt.com` and `api.openai.com` are both listed because this
 * repo's own code never selects between them: nothing in
 * `safe-env-allowlist.json` or `CodexCliExecutor` passes an API key or
 * picks an auth mode, so the operator's own `codex login` state decides
 * which endpoint is actually used (docs/adr/0081). `github.com` and
 * `developers.openai.com`, observed in a live run's traffic but not
 * authorized by 0076, are deliberately excluded — reproduced with both
 * blocked and a full mutating task completing normally, confirming
 * neither is load-bearing (docs/adr/0081, "Review round").
 */
const CODEX_STATIC_NETWORK_ALLOWLIST = [
  'chatgpt.com',
  'ab.chatgpt.com',
  'api.openai.com',
  'registry.npmjs.org',
];

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

async function resolveExistingOrDeclared(declared: string): Promise<string> {
  try {
    return await realpath(declared);
  } catch {
    // Doesn't exist (yet). Fine for a write-allow entry (nothing to widen
    // access to) and fine for a deny entry (nothing to protect) — the
    // literal path is kept so a later-created file still matches.
    return declared;
  }
}

/**
 * OS-level (Seatbelt/bubblewrap) confinement for the Codex CLI process,
 * via `@anthropic-ai/sandbox-runtime` (`srt`) — the same primitive Claude
 * Code's own sandbox uses, wrapped around the whole process rather than
 * just a Bash tool (docs/adr/0081). `denyRead` mirrors
 * `claude-executor.ts`'s `claudeSandboxSettings`: the shared workspaces
 * root and the OS temp root, plus this repo's credential file list, since
 * srt has no equivalent to Claude Code's separate `credentials.files`
 * block — everything goes in the one `denyRead` array. `~/.codex` needs no
 * explicit `allowRead` entry: srt's read default is "allow everywhere
 * except denyRead," and `~/.codex` isn't denied by anything above, so it's
 * already readable. `allowWrite` does need `realCodexHome` explicitly —
 * write is deny-by-default in srt. Unlike Claude Code's sandbox, which
 * only wraps the Bash tool and leaves the `claude` process itself
 * unsandboxed, srt wraps the Codex process that owns its own
 * authentication, so this scoped `~/.codex` write carve-out is what makes
 * Codex able to authenticate and run at all, not an incidental grant
 * (docs/adr/0081, "Review round" — measured, not the single `auth.json`
 * file alone).
 *
 * `network.allowedDomains` adds `127.0.0.1`/`localhost` with
 * `allowLocalBinding: true` — loopback is in the critical path (a
 * DB-form implementation task writes and runs a test against the local
 * Supabase/Postgres instance), verified with a real Postgres connection
 * under this exact sandbox. This ships with **loopback fully open, not
 * port-scoped**: measured that srt's `:port` suffix on an `allowedDomains`
 * entry does not actually restrict the port once `allowLocalBinding` is
 * set — a second, unrelated loopback listener on a different port was
 * still reachable. The finer-grained boundary docs/adr/0076 asks for
 * ("exact loopback... services") is not expressible with this mechanism;
 * this is a named residual risk, not a silent gap — see docs/adr/0081.
 * With loopback fully open, the sandboxed process can also reach this
 * repo's own control-plane API, which has no authenticated local session
 * on `main` yet (#597 closes that path; #637 does not fix it, since
 * Codex already has unrestricted network access today and this is not a
 * regression).
 */
function codexSandboxSettings(
  realWorkspaceRoot: string,
  realTmpdir: string,
  realCwd: string,
  realRunTempDir: string,
  realCodexHome: string,
  deniedCredentialPaths: string[],
): string {
  const denyRead = [...new Set([realWorkspaceRoot, realTmpdir, ...deniedCredentialPaths])];
  return JSON.stringify({
    filesystem: {
      denyRead,
      allowRead: [realCwd, realRunTempDir],
      allowWrite: [realCwd, realRunTempDir, realCodexHome],
      denyWrite: [],
    },
    network: {
      allowedDomains: [...CODEX_STATIC_NETWORK_ALLOWLIST, '127.0.0.1', 'localhost'],
      deniedDomains: [],
      allowLocalBinding: true,
    },
  });
}

export class CodexCliExecutor extends BaseCliExecutor {
  readonly provider = 'codex' as const;
  protected readonly command = 'codex';
  private readonly workspaceRoot: string;

  constructor(
    maxOutputBytes: number,
    workspaceRoot: string,
    private readonly reportConfiguredModel = false,
  ) {
    super(maxOutputBytes);
    this.workspaceRoot = resolve(workspaceRoot);
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

    const [realWorkspaceRoot, realTmpdir, realCwd] = await Promise.all([
      realpath(this.workspaceRoot),
      realpath(tmpdir()),
      realpath(request.cwd),
    ]);

    const declaredRunTempRoot = join(realWorkspaceRoot, RUN_TMP_DIRNAME);
    await mkdir(declaredRunTempRoot, { recursive: true });
    // Equality check, not just realpath(): realpath() alone follows a
    // symlink instead of rejecting it, so a replaced RUN_TMP_DIRNAME would
    // silently redirect this run's whole sandbox root — see
    // claude-executor.ts's identical guard and docs/adr/0071's "Second
    // review round" for the reproduced bypass this closes.
    const runTempRoot = await realpath(declaredRunTempRoot);
    if (runTempRoot !== declaredRunTempRoot) {
      throw new Error(
        `${RUN_TMP_DIRNAME} resolved to a different path (${runTempRoot}) than declared (${declaredRunTempRoot}) — refusing to use a symlinked run-temp root.`,
      );
    }
    const runTempDir = await mkdtemp(join(runTempRoot, 'run-'));
    const realRunTempDir = await realpath(runTempDir);
    const outputFile = join(realRunTempDir, 'codex.final.json');

    const [realCodexHome, deniedCredentialPaths] = await Promise.all([
      resolveExistingOrDeclared(join(homedir(), '.codex')),
      Promise.all(
        DENIED_CREDENTIAL_RELATIVE_PATHS.map((relativePath) =>
          resolveExistingOrDeclared(join(homedir(), relativePath)),
        ),
      ),
    ]);

    const settingsPath = join(realRunTempDir, 'srt-settings.json');
    await writeFile(
      settingsPath,
      codexSandboxSettings(
        realWorkspaceRoot,
        realTmpdir,
        realCwd,
        realRunTempDir,
        realCodexHome,
        deniedCredentialPaths,
      ),
    );

    const args = [
      // Debug mode is required, not cosmetic: it's the only channel srt
      // gives us for the network-denial audit log in auditStderr() below —
      // without it, a boundary denial reaches the model as an opaque
      // "fetch failed" with no host, and (docs/adr/0076) no in-band record
      // of what was blocked (#637).
      '-d',
      '-s',
      settingsPath,
      '--',
      'codex',
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
      command: 'srt',
      args,
      input,
      outputFile,
      outputDirectory: realRunTempDir,
      outputDirectoryRoot: runTempRoot,
      environment: {
        ...this.environment,
        // `allowWrite` is deny-by-default under srt and does not cover
        // `~/.npm/_cacache` — measured against real srt: an `npm install`
        // in `cwd` dies with EPERM writing npm's cache, even though
        // `registry.npmjs.org` is reachable, unless npm's cache and the
        // process's own temp dir are redirected into the run's own
        // allowWrite'd temp directory. Verified fixed against real srt
        // (docs/adr/0081) rather than left as an argv-only assumption.
        TMPDIR: realRunTempDir,
        TEMP: realRunTempDir,
        TMP: realRunTempDir,
        npm_config_cache: realRunTempDir,
        ...(this.reportConfiguredModel ? { RUST_LOG: 'codex_core::session::session=debug' } : {}),
      },
    };
  }

  protected override createStreamMapper() {
    return createCodexStreamMapper();
  }

  protected override auditStderr(stderr: string, request: AgentExecutionRequest): void {
    const pattern = /\[SandboxDebug] Connection blocked to (\S+)/g;
    for (const match of stderr.matchAll(pattern)) {
      // Host and role only — never more of stderr than this one capture
      // group, which can otherwise carry the wrapped command's own output
      // (srt's debug log echoes the full command string on a separate
      // line).
      console.error(
        `codex sandbox denied network destination: ${match[1]} (role: ${request.role})`,
      );
    }
  }

  /**
   * `this.command` stays `'codex'` — the CLI health() otherwise probes below
   * — but production actually spawns `srt` (#637); `srt` missing from PATH
   * (the exact situation docs/adr/0081 documents as expected in this repo's
   * own Dockerfile, which doesn't install it) must not report
   * `available: true` and let the router keep dispatching to a command that
   * then fails every run on ENOENT.
   */
  protected override async wrapperUnavailableReason(): Promise<string | null> {
    try {
      const result = await execa('srt', ['--version'], {
        reject: false,
        timeout: 10_000,
        ...safeSpawnEnv(process.env, this.environment),
      });
      return result.exitCode === 0
        ? null
        : `srt (sandbox wrapper) returned exit code ${String(result.exitCode)}`;
    } catch (error) {
      return `srt (sandbox wrapper) is not available: ${errorMessage(error)}`;
    }
  }
}
