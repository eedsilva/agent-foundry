import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import type { CliInvocation } from './base-cli-executor.js';
import { ClaudeCliExecutor } from './claude-executor.js';
import { CodexCliExecutor } from './codex-executor.js';

class AuditableCodexExecutor extends CodexCliExecutor {
  audit(stderr: string, req: AgentExecutionRequest): void {
    this.auditStderr(stderr, req);
  }
}

/** Matches `<root>/.agent-foundry-run-tmp/run-<mkdtemp suffix>`. */
function runTempDirPattern(root: string): RegExp {
  return new RegExp(
    `^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.agent-foundry-run-tmp/run-`,
  );
}

class InspectableCodexExecutor extends CodexCliExecutor {
  inspect(request: AgentExecutionRequest): Promise<CliInvocation> {
    return this.invocation(request);
  }
}

class InspectableClaudeExecutor extends ClaudeCliExecutor {
  inspect(request: AgentExecutionRequest): Promise<CliInvocation> {
    return this.invocation(request);
  }
}

// The Claude sandbox settings builder realpath()s workspaceRoot/cwd/tmpdir
// (#565: a symlinked path silently defeats the sandbox rather than
// erroring — see docs/adr/0071), so these must be real, existing
// directories, not synthetic strings, or invocation() throws ENOENT.
let TEST_WORKSPACE_ROOT: string;
let TEST_CWD: string;
let OTHER_CWD: string;
let REAL_TMPDIR: string;

beforeAll(async () => {
  TEST_WORKSPACE_ROOT = await realpath(
    await mkdtemp(join(tmpdir(), 'agent-foundry-cli-executors-')),
  );
  TEST_CWD = join(TEST_WORKSPACE_ROOT, 'projects', 'proj-1', 'workspace');
  await mkdir(TEST_CWD, { recursive: true });
  OTHER_CWD = join(TEST_WORKSPACE_ROOT, 'projects', 'proj-2', 'workspace');
  await mkdir(OTHER_CWD, { recursive: true });
  REAL_TMPDIR = await realpath(tmpdir());
});

afterAll(async () => {
  await rm(TEST_WORKSPACE_ROOT, { recursive: true, force: true });
});

function request(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    runId: '01KX9B14GCCJ4R93SD739PHBW4',
    stepRunId: '01KX9B14GCCJ4R93SD739PHBW6',
    attemptId: '01KX9B14GCCJ4R93SD739PHBW7',
    projectId: '01KX9B14GCCJ4R93SD739PHBW5',
    stepId: 'implement',
    role: 'developer',
    taskKind: 'implementation',
    provider: 'codex',
    model: '',
    prompt: 'Open the request file.',
    cwd: TEST_CWD,
    mutatesWorkspace: true,
    timeoutMs: 120_000,
    outputSchema: { type: 'object' },
    ...overrides,
  };
}

describe('CLI executor contracts', () => {
  it('wraps Codex in srt, using stdin and workspace-write sandbox for mutating runs (#637)', async () => {
    const invocation = await new InspectableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request(),
    );
    try {
      // srt (@anthropic-ai/sandbox-runtime) is the command that actually
      // spawns now — codex is an argument after the `--` separator, not
      // the executable, since Codex has no equivalent to Claude Code's own
      // built-in --settings sandbox and needs an external OS-level wrapper
      // around the whole process (docs/adr/0081).
      expect(invocation.command).toBe('srt');
      expect(invocation.args[0]).toBe('-d');
      expect(invocation.args[1]).toBe('-s');
      expect(invocation.args[3]).toBe('--');
      expect(invocation.args.slice(4, 6)).toEqual(['codex', 'exec']);
      expect(invocation.input).toBe(
        'Open the request file.\n\nOutput JSON Schema:\n{"type":"object"}',
      );
      expect(invocation.args).toContain('workspace-write');
      expect(invocation.args).not.toContain('--ask-for-approval');
      expect(invocation.args).not.toContain('--output-schema');
      expect(invocation.args).not.toContain('--model');
      expect(invocation.outputFile).toContain('codex.final.json');
      expect(invocation.outputFile?.startsWith(TEST_CWD)).toBe(false);

      const settingsPath = invocation.args[2] as string;
      const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        filesystem: {
          denyRead: string[];
          allowRead: string[];
          allowWrite: string[];
          denyWrite: string[];
        };
        network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding: boolean };
      };
      expect(settings.filesystem.denyRead).toEqual(
        expect.arrayContaining([TEST_WORKSPACE_ROOT, REAL_TMPDIR]),
      );
      // Codex's own credential list, mirroring Claude's DENIED_CREDENTIAL_FILES
      // — srt has no separate credentials.files block, so these land in the
      // same denyRead array.
      expect(settings.filesystem.denyRead.some((path) => path.endsWith('/.ssh'))).toBe(true);
      expect(settings.filesystem.denyRead.some((path) => path.endsWith('/.git-credentials'))).toBe(
        true,
      );
      expect(settings.filesystem.allowRead).toEqual(expect.arrayContaining([TEST_CWD]));
      expect(settings.filesystem.allowWrite).toEqual(expect.arrayContaining([TEST_CWD]));
      // ~/.codex must be write-allowed (srt is write-deny-by-default) —
      // Codex owns its own auth state, unlike Claude's Bash-tool-scoped
      // sandbox which never touches the claude CLI's own credential store
      // (docs/adr/0081, "Review round").
      expect(settings.filesystem.allowWrite.some((path) => path.endsWith('/.codex'))).toBe(true);
      // Static allowlist copied from docs/adr/0076, not guessed — both auth
      // families plus the npm registry, and loopback fully open (named
      // residual risk, not port-scoped — see docs/adr/0081).
      expect(settings.network.allowedDomains).toEqual(
        expect.arrayContaining([
          'chatgpt.com',
          'ab.chatgpt.com',
          'api.openai.com',
          'registry.npmjs.org',
          '127.0.0.1',
          'localhost',
        ]),
      );
      expect(settings.network.allowLocalBinding).toBe(true);
      // github.com/developers.openai.com are deliberately absent — observed
      // in real traffic but not authorized by 0076, and a full mutating
      // task completed with both blocked (docs/adr/0081).
      expect(settings.network.allowedDomains).not.toContain('github.com');
      expect(settings.network.allowedDomains).not.toContain('developers.openai.com');
      // `allowWrite` doesn't cover `~/.npm/_cacache` — measured against real
      // srt to die with EPERM on `npm install` otherwise (docs/adr/0081).
      // Redirecting npm's cache and the process's own temp dir into the
      // run's own allowWrite'd temp directory is what makes dependency
      // installation work inside the sandbox at all.
      expect(invocation.environment?.TMPDIR).toBe(invocation.outputDirectory);
      expect(invocation.environment?.TEMP).toBe(invocation.outputDirectory);
      expect(invocation.environment?.TMP).toBe(invocation.outputDirectory);
      expect(invocation.environment?.npm_config_cache).toBe(invocation.outputDirectory);
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('pins Luna reasoning effort to high before invoking Codex', async () => {
    const luna = {
      ...request({ model: 'gpt-5.6-luna' }),
      reasoningEffort: 'high',
    } as AgentExecutionRequest & { reasoningEffort: 'high' };
    const invocation = await new InspectableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      luna,
    );
    try {
      expect(invocation.args).toEqual(
        expect.arrayContaining(['-c', 'model_reasoning_effort=high']),
      );
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it.each([undefined, 'low', 'medium'])(
    'rejects Luna reasoning effort %s before invoking Codex',
    async (reasoningEffort) => {
      const luna = {
        ...request({ model: 'gpt-5.6-luna' }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      } as AgentExecutionRequest & { reasoningEffort?: string };

      await expect(
        new InspectableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(luna),
      ).rejects.toThrow(/Luna.*high/i);
    },
  );

  it('refuses a Codex output schema that exceeds the bounded prompt contract', async () => {
    const before = await temporaryEntries('agent-foundry-codex-output-');
    await expect(
      new InspectableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
        request({ outputSchema: { description: 'x'.repeat(32_768) } }),
      ),
    ).rejects.toThrow(/output schema exceeds/i);
    expect(await temporaryEntries('agent-foundry-codex-output-')).toEqual(before);
  });

  it('requests configured-session metadata only for explicit Codex evidence runs', async () => {
    const invocation = await new InspectableCodexExecutor(
      1_000_000,
      TEST_WORKSPACE_ROOT,
      true,
    ).inspect(request());
    try {
      expect(invocation.environment).toMatchObject({
        RUST_LOG: 'codex_core::session::session=debug',
      });
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('resolves a symlinked Codex workspaceRoot to its real path, not the literal symlink string (#637)', async () => {
    // Same defect class as the Claude test below (#565): srt enforces
    // against the real filesystem path, so a denyRead/allowRead entry
    // written in symlink form would silently fail to match anything.
    const realRoot = await mkdtemp(join(tmpdir(), 'agent-foundry-cli-executors-codex-real-'));
    const realCwd = join(realRoot, 'workspace');
    await mkdir(realCwd, { recursive: true });
    const linkedRoot = join(tmpdir(), `agent-foundry-cli-executors-codex-link-${process.pid}`);
    await symlink(realRoot, linkedRoot);
    try {
      const linkedCwd = join(linkedRoot, 'workspace');
      const invocation = await new InspectableCodexExecutor(1_000_000, linkedRoot).inspect(
        request({ cwd: linkedCwd }),
      );
      const settingsPath = invocation.args[2] as string;
      const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        filesystem: { denyRead: string[]; allowRead: string[] };
      };
      expect(settings.filesystem.denyRead).not.toContain(linkedRoot);
      expect(settings.filesystem.denyRead).toContain(await realpath(realRoot));
      expect(settings.filesystem.allowRead).toContain(await realpath(realCwd));
    } finally {
      await rm(linkedRoot, { force: true });
      await rm(realRoot, { recursive: true, force: true });
    }
  });

  it('refuses a Codex run when .agent-foundry-run-tmp itself is a symlink (#637)', async () => {
    // Mirrors the Claude regression test below (#565 review): realpath()
    // alone follows the symlink instead of rejecting it, so without the
    // explicit equality check this would silently redirect the run's whole
    // sandbox root instead of erroring.
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), 'agent-foundry-cli-executors-codex-symlinked-'),
    );
    const elsewhere = await mkdtemp(join(tmpdir(), 'agent-foundry-cli-executors-codex-elsewhere-'));
    await symlink(elsewhere, join(workspaceRoot, '.agent-foundry-run-tmp'));
    try {
      await expect(
        new InspectableCodexExecutor(1_000_000, workspaceRoot).inspect(request({ cwd: TEST_CWD })),
      ).rejects.toThrow(/resolved to a different path/);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('logs a blocked network destination with its host and role, never the raw sandbox stderr (#637)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const executor = new AuditableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT);
      const stderr =
        '[SandboxDebug] running command: codex exec --json --sandbox workspace-write\n' +
        '[SandboxDebug] Connection blocked to evil.example:443 by network policy\n' +
        'some unrelated line that must never reach console.error verbatim\n';
      executor.audit(stderr, request({ role: 'developer' }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        'codex sandbox denied network destination: evil.example:443 (role: developer)',
      );
      // The full stderr — including the unrelated line and the echoed
      // command — must never be handed to console.error as-is.
      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain('unrelated line');
        expect(call.join(' ')).not.toContain('running command');
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('logs nothing when no [SandboxDebug] denial is present (#637)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const executor = new AuditableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT);
      executor.audit('[SandboxDebug] running command: codex exec\nno denial here\n', request());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("reports health() unavailable when srt (the process #637 actually spawns) is missing, even though 'codex' stays this.command", async () => {
    // health() must not report available just because `codex` itself would
    // resolve — production never invokes `codex` directly, only through
    // `srt`. A PATH with no `srt` at all (an empty directory only) is the
    // exact "srt not installed in this image" scenario docs/adr/0081
    // documents as expected.
    const emptyPathDir = await mkdtemp(join(tmpdir(), 'agent-foundry-cli-executors-no-srt-'));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyPathDir;
    try {
      const health = await new CodexCliExecutor(1_000_000, TEST_WORKSPACE_ROOT).health();
      expect(health.available).toBe(false);
      expect(health.message).toContain('srt');
    } finally {
      process.env.PATH = originalPath;
      await rm(emptyPathDir, { recursive: true, force: true });
    }
  });

  it('reports health() available when srt is present and reports its own version, not codex exit status alone', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'agent-foundry-cli-executors-fake-srt-'));
    await writeFile(
      join(binDir, 'srt'),
      '#!/usr/bin/env node\nprocess.stdout.write("1.2.3\\n");\nprocess.exit(0);\n',
    );
    await execa('chmod', ['+x', join(binDir, 'srt')]);
    const originalPath = process.env.PATH;
    // `codex` also has to resolve for the base health() check that runs
    // after wrapperUnavailableReason() passes — reuse the real `node`/repo
    // toolchain PATH plus the fake srt directory prepended, rather than
    // faking `codex` too, since this test is only exercising the srt gate.
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      const health = await new CodexCliExecutor(1_000_000, TEST_WORKSPACE_ROOT).health();
      // Whatever `codex --version` itself does on this machine (installed or
      // not) is irrelevant here — the point is srt no longer short-circuits
      // the check to `available: false` with an srt-specific message.
      expect(health.message).not.toContain('srt');
    } finally {
      process.env.PATH = originalPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('uses plan permission mode and structured JSON for read-only Claude runs', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({ provider: 'claude', model: 'sonnet', mutatesWorkspace: false }),
    );
    try {
      expect(invocation.command).toBe('claude');
      expect(invocation.args).not.toContain('--bare');
      expect(invocation.args).toContain('--safe-mode');
      expect(invocation.args).toContain('--verbose');
      expect(invocation.args).toContain('stream-json');
      expect(invocation.args).toEqual(expect.arrayContaining(['--prompt-suggestions', 'false']));
      expect(invocation.args).toContain('plan');
      expect(invocation.args).toContain('--json-schema');
      expect(invocation.args).toContain('sonnet');
      // Read-only runs get no Bash allowlist — there is nothing to pre-approve.
      expect(invocation.args.some((arg) => arg.startsWith('--allowedTools'))).toBe(false);
      expect(invocation.args.at(-1)).toBe('Open the request file.');
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it("confines the Bash sandbox to this run's cwd for both read-only and mutating Claude runs", async () => {
    for (const mutatesWorkspace of [false, true]) {
      const invocation = await new InspectableClaudeExecutor(
        1_000_000,
        TEST_WORKSPACE_ROOT,
      ).inspect(request({ provider: 'claude', mutatesWorkspace }));
      try {
        const flagIndex = invocation.args.indexOf('--settings');
        expect(flagIndex).toBeGreaterThanOrEqual(0);
        const settings = JSON.parse(invocation.args[flagIndex + 1] ?? '{}') as {
          sandbox: {
            enabled: boolean;
            failIfUnavailable: boolean;
            allowUnsandboxedCommands: boolean;
            filesystem: { denyRead: string[]; allowRead: string[] };
            credentials: { files: Array<{ path: string; mode: string }> };
            network: { allowedDomains: string[] };
            excludedCommands: string[];
          };
        };
        expect(settings.sandbox.enabled).toBe(true);
        // Default-deny: a missing sandbox dependency must fail the run, not
        // silently execute the model's tools unconfined.
        expect(settings.sandbox.failIfUnavailable).toBe(true);
        expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
        // Deny the shared workspaces root and the OS temp root, then re-open
        // only this run's own cwd — sibling projects/worktrees under the same
        // root, other processes' temp files, and every host path outside
        // both, stay unreadable to the Bash tool's child processes
        // (docs/adr/0071).
        expect(settings.sandbox.filesystem.denyRead.sort()).toEqual(
          [TEST_WORKSPACE_ROOT, REAL_TMPDIR].sort(),
        );
        // cwd, plus this run's own ephemeral temp dir — a second allowRead
        // entry, not folded into cwd (it must live outside the worktree;
        // see the dedicated checkpoint test below).
        expect(settings.sandbox.filesystem.allowRead).toHaveLength(2);
        expect(settings.sandbox.filesystem.allowRead[0]).toBe(TEST_CWD);
        expect(settings.sandbox.filesystem.allowRead[1]).toMatch(
          runTempDirPattern(TEST_WORKSPACE_ROOT),
        );
        // The sandbox's own default read policy still allows credential files
        // like ~/.ssh and ~/.aws/credentials even with denyRead set elsewhere
        // — this closes that gap explicitly (docs/adr/0071).
        expect(settings.sandbox.credentials.files).toEqual(
          expect.arrayContaining([
            { path: '~/.ssh', mode: 'deny' },
            { path: '~/.claude/.credentials.json', mode: 'deny' },
            { path: '~/.git-credentials', mode: 'deny' },
            { path: '~/.config/gh/hosts.yml', mode: 'deny' },
          ]),
        );
        // #565 is a filesystem-boundary fix, not a network policy change.
        expect(settings.sandbox.network.allowedDomains).toEqual(['*']);
        // docker can't run inside this sandbox at all (docs/adr/0071); it
        // stays exactly as unconfined as it was before this change.
        expect(settings.sandbox.excludedCommands).toEqual(['docker *']);
      } finally {
        if (invocation.outputDirectory) {
          await rm(invocation.outputDirectory, { force: true, recursive: true });
        }
      }
    }
  });

  it('scopes the Bash sandbox to a different cwd per request, not a fixed path', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({ provider: 'claude', cwd: OTHER_CWD }),
    );
    try {
      const flagIndex = invocation.args.indexOf('--settings');
      const settings = JSON.parse(invocation.args[flagIndex + 1] ?? '{}') as {
        sandbox: { filesystem: { allowRead: string[] } };
      };
      expect(settings.sandbox.filesystem.allowRead[0]).toBe(OTHER_CWD);
      expect(settings.sandbox.filesystem.allowRead[1]).toMatch(
        runTempDirPattern(TEST_WORKSPACE_ROOT),
      );
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it("keeps this run's temp dir outside the worktree, so checkpointing the workspace never stages it (#565 review)", async () => {
    // Mansur's finding: a temp dir nested inside cwd would get swept up by
    // `git add -A`, the exact command FileWorkspaceManager.checkpoint/
    // commit/preserveDraft/ensureGit all run against the workspace — and the
    // repo already paid for this once with a shared node_modules symlink
    // (workspace-manager.ts, #excludeNodeModules's doc comment). This
    // reproduces the workspace side of that risk directly with git, without
    // depending on the persistence package (architecture boundary: executors
    // and persistence are siblings, neither depends on the other).
    const invocation = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({ provider: 'claude' }),
    );
    try {
      expect(invocation.outputDirectory).toBeDefined();
      const runTempDir = invocation.outputDirectory as string;
      expect(runTempDir.startsWith(TEST_CWD)).toBe(false);

      // outputDirectoryRoot must be the narrow .agent-foundry-run-tmp dir,
      // not workspaceRoot itself: workspaceRoot is the whole Data
      // Directory, containing every project's own worktree
      // (workspacePath() = <dataDir>/projects/<id>), so declaring it as the
      // "safe root" would make BaseCliExecutor's cleanup guard accept any
      // project's directory as contained — the guard existing but not
      // actually narrowing anything (#565 review).
      expect(invocation.outputDirectoryRoot).toBe(
        join(TEST_WORKSPACE_ROOT, '.agent-foundry-run-tmp'),
      );
      expect(runTempDir.startsWith(invocation.outputDirectoryRoot as string)).toBe(true);

      // Simulate the exact failure mode: a toolchain command reads $TMPDIR
      // from the environment this invocation built and round-trips a file
      // through it.
      const tmpdirEnv = invocation.environment?.TMPDIR;
      expect(tmpdirEnv).toBe(runTempDir);
      const toolchainTempFile = join(runTempDir, 'pnpm-store-staging.json');
      await writeFile(toolchainTempFile, '{"staged":true}');
      expect(await readFile(toolchainTempFile, 'utf8')).toContain('staged');

      // Now checkpoint the workspace the way FileWorkspaceManager does.
      await execa('git', ['init', '--quiet'], { cwd: TEST_CWD });
      await execa('git', ['config', 'user.name', 'Test'], { cwd: TEST_CWD });
      await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: TEST_CWD });
      await writeFile(join(TEST_CWD, 'app-file.txt'), 'real project content');
      await execa('git', ['add', '-A'], { cwd: TEST_CWD });
      const status = await execa('git', ['status', '--porcelain'], { cwd: TEST_CWD });
      expect(status.stdout).toContain('app-file.txt');
      expect(status.stdout).not.toContain('pnpm-store-staging.json');
      expect(status.stdout).not.toContain('agent-foundry-run-tmp');
      const diff = await execa('git', ['diff', '--cached', '--name-only'], { cwd: TEST_CWD });
      expect(diff.stdout).not.toContain('pnpm-store-staging.json');
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
      await rm(join(TEST_CWD, '.git'), { recursive: true, force: true });
      await rm(join(TEST_CWD, 'app-file.txt'), { force: true });
    }
  });

  it('resolves a symlinked workspaceRoot/cwd to their real paths, not the literal symlink string (#565)', async () => {
    // Verified empirically against the real CLI: a denyRead/allowRead entry
    // written in symlink form silently fails to match anything at all — the
    // sandbox enforces against the real filesystem path the OS resolves,
    // not the literal string in --settings. path.resolve() alone (the prior
    // implementation) can't catch this; only realpath() can. See
    // docs/adr/0071.
    const realRoot = await mkdtemp(join(tmpdir(), 'agent-foundry-cli-executors-real-'));
    const realCwd = join(realRoot, 'workspace');
    await mkdir(realCwd, { recursive: true });
    const linkedRoot = join(tmpdir(), `agent-foundry-cli-executors-link-${process.pid}`);
    await symlink(realRoot, linkedRoot);
    try {
      const linkedCwd = join(linkedRoot, 'workspace');
      const invocation = await new InspectableClaudeExecutor(1_000_000, linkedRoot).inspect(
        request({ provider: 'claude', cwd: linkedCwd }),
      );
      const flagIndex = invocation.args.indexOf('--settings');
      const settings = JSON.parse(invocation.args[flagIndex + 1] ?? '{}') as {
        sandbox: { filesystem: { denyRead: string[]; allowRead: string[] } };
      };
      expect(settings.sandbox.filesystem.denyRead).not.toContain(linkedRoot);
      expect(settings.sandbox.filesystem.denyRead).toContain(await realpath(realRoot));
      expect(settings.sandbox.filesystem.allowRead[0]).toBe(await realpath(realCwd));
      expect(settings.sandbox.filesystem.allowRead[1]).toMatch(
        runTempDirPattern(await realpath(realRoot)),
      );
    } finally {
      await rm(linkedRoot, { force: true });
      await rm(realRoot, { recursive: true, force: true });
    }
  });

  it('refuses to proceed when .agent-foundry-run-tmp itself is a symlink, rather than silently following it (#565 review)', async () => {
    // realpath() alone does not fail closed here: it follows the symlink,
    // so the "root" and the mkdtemp'd directory inside it would both
    // resolve consistently through the same redirect, and the containment
    // guard would approve by construction — verified this would happen
    // before adding the explicit equality check below (see docs/adr/0071,
    // "Third review round"). No claim that this is exploitable today; the
    // point is the code should not silently trust a replaced directory.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-foundry-cli-executors-symlinked-'));
    const elsewhere = await mkdtemp(join(tmpdir(), 'agent-foundry-cli-executors-elsewhere-'));
    await symlink(elsewhere, join(workspaceRoot, '.agent-foundry-run-tmp'));
    try {
      await expect(
        new InspectableClaudeExecutor(1_000_000, workspaceRoot).inspect(
          request({ provider: 'claude', cwd: TEST_CWD }),
        ),
      ).rejects.toThrow(/resolved to a different path/);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('pre-approves a scoped Bash allowlist for mutating Claude runs', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({ provider: 'claude', model: 'sonnet', mutatesWorkspace: true }),
    );
    try {
      expect(invocation.args).toContain('acceptEdits');
      // A single `--allowedTools=` token, not two separate argv entries: the
      // flag is variadic, so a bare `--allowedTools <value>` pair would
      // swallow the positional prompt that follows it (verified against the
      // real CLI — see docs/adr/0063).
      expect(invocation.args).toContain(
        '--allowedTools=Bash(pnpm *),Bash(npm *),Bash(npx *),Bash(node *),Bash(git *),Bash(docker *),Bash(supabase *),Bash(psql *)',
      );
      expect(invocation.args.filter((arg) => arg.startsWith('--allowedTools'))).toHaveLength(1);
      expect(invocation.args.at(-1)).toBe('Open the request file.');
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('removes unsupported Draft 2020-12 metadata from Claude schemas', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({
        provider: 'claude',
        outputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          'x-agent-foundry-runtime-validation': { internal: true },
        },
      }),
    );
    try {
      const schemaIndex = invocation.args.indexOf('--json-schema');
      expect(schemaIndex).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(invocation.args[schemaIndex + 1] ?? '')).toEqual({ type: 'object' });
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('leaves Claude args untouched when systemPrompt is absent', async () => {
    // The run-temp path embeds a random mkdtemp suffix per invocation, so
    // normalize it out before comparing two separately built invocations —
    // same reasoning as the Codex outputFile normalization below.
    const normalize = (invocation: CliInvocation) => {
      const settingsIndex = invocation.args.indexOf('--settings');
      if (settingsIndex === -1) return invocation.args;
      const args = [...invocation.args];
      args[settingsIndex + 1] = (args[settingsIndex + 1] ?? '').replace(
        /"\/[^"]*\/\.agent-foundry-run-tmp\/run-[^/"]+"/,
        '"<runTempDir>"',
      );
      return args;
    };
    const withPrompt = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request(),
    );
    const without = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({ systemPrompt: undefined }),
    );
    try {
      expect(normalize(without)).toEqual(normalize(withPrompt));
      expect(without.args).not.toContain('--append-system-prompt');
    } finally {
      if (withPrompt.outputDirectory) {
        await rm(withPrompt.outputDirectory, { force: true, recursive: true });
      }
      if (without.outputDirectory) {
        await rm(without.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('appends --append-system-prompt when systemPrompt is present', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({ systemPrompt: '# System prompt: Developer\n\nBe terse.' }),
    );
    try {
      const flagIndex = invocation.args.indexOf('--append-system-prompt');
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(invocation.args[flagIndex + 1]).toBe('# System prompt: Developer\n\nBe terse.');
      // The prompt (last arg) must still follow, unaffected by the appended flag.
      expect(invocation.args.at(-1)).toBe('Open the request file.');
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('leaves Codex args untouched when systemPrompt is absent', async () => {
    // Both the output-file path and the srt settings-file path embed a
    // random mkdtemp suffix per invocation (both live under the same
    // per-run outputDirectory), so normalize any arg rooted there before
    // comparing two separately built invocations.
    const normalize = (invocation: CliInvocation) =>
      invocation.args.map((arg) =>
        invocation.outputDirectory && arg.startsWith(invocation.outputDirectory)
          ? `<runTempDir>${arg.slice(invocation.outputDirectory.length)}`
          : arg,
      );
    const withoutA = await new InspectableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request(),
    );
    const withoutB = await new InspectableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({ systemPrompt: undefined }),
    );
    try {
      expect(normalize(withoutA)).toEqual(normalize(withoutB));
      expect(withoutA.args).not.toContain('-c');
    } finally {
      if (withoutA.outputDirectory)
        await rm(withoutA.outputDirectory, { force: true, recursive: true });
      if (withoutB.outputDirectory)
        await rm(withoutB.outputDirectory, { force: true, recursive: true });
    }
  });

  it('appends a -c developer_instructions TOML literal string when systemPrompt is present', async () => {
    const content = 'Say "hi" then \\n do it — a real\nnewline, a quote " and a backslash \\.';
    const invocation = await new InspectableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({ systemPrompt: content }),
    );
    try {
      const flagIndex = invocation.args.indexOf('-c');
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      const value = invocation.args[flagIndex + 1];
      expect(value).toBe(`developer_instructions='''${content}'''`);
      // TOML literal strings do zero escape processing: the verbatim content
      // (quote, backslash, real newline) must round-trip unchanged.
      expect(value).toContain(content);
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('throws a clear error when systemPrompt contains a TOML literal-string delimiter', async () => {
    const before = await temporaryEntries('agent-foundry-codex-output-');
    await expect(
      new InspectableCodexExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
        request({ systemPrompt: "before '''  after" }),
      ),
    ).rejects.toThrow(/'''/);
    expect(await temporaryEntries('agent-foundry-codex-output-')).toEqual(before);
  });

  it('removes unsupported tuple keywords from nested Claude schemas', async () => {
    const invocation = await new InspectableClaudeExecutor(1_000_000, TEST_WORKSPACE_ROOT).inspect(
      request({
        provider: 'claude',
        outputSchema: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { type: 'string' },
              prefixItems: [{ type: 'string' }],
            },
          },
        },
      }),
    );
    try {
      const schemaIndex = invocation.args.indexOf('--json-schema');
      const schema = JSON.parse(invocation.args[schemaIndex + 1] ?? '') as {
        properties: { data: Record<string, unknown> };
      };
      expect(schema.properties.data).not.toHaveProperty('prefixItems');
      expect(schema.properties.data.items).toEqual({ type: 'string' });
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });
});

async function temporaryEntries(prefix: string): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)).sort();
}
