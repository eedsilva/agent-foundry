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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import type { CliInvocation } from './base-cli-executor.js';
import { ClaudeCliExecutor } from './claude-executor.js';
import { CodexCliExecutor } from './codex-executor.js';

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
  it('uses stdin and workspace-write sandbox for mutating Codex runs', async () => {
    const invocation = await new InspectableCodexExecutor(1_000_000).inspect(request());
    try {
      expect(invocation.command).toBe('codex');
      expect(invocation.input).toBe(
        'Open the request file.\n\nOutput JSON Schema:\n{"type":"object"}',
      );
      expect(invocation.args).toContain('workspace-write');
      expect(invocation.args).not.toContain('--ask-for-approval');
      expect(invocation.args).not.toContain('--output-schema');
      expect(invocation.args).not.toContain('--model');
      expect(invocation.outputFile).toContain('codex.final.json');
      expect(invocation.outputFile?.startsWith(TEST_CWD)).toBe(false);
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
    }
  });

  it('refuses a Codex output schema that exceeds the bounded prompt contract', async () => {
    const before = await temporaryEntries('agent-foundry-codex-output-');
    await expect(
      new InspectableCodexExecutor(1_000_000).inspect(
        request({ outputSchema: { description: 'x'.repeat(32_768) } }),
      ),
    ).rejects.toThrow(/output schema exceeds/i);
    expect(await temporaryEntries('agent-foundry-codex-output-')).toEqual(before);
  });

  it('requests configured-session metadata only for explicit Codex evidence runs', async () => {
    const invocation = await new InspectableCodexExecutor(1_000_000, true).inspect(request());
    try {
      expect(invocation.environment).toEqual({
        RUST_LOG: 'codex_core::session::session=debug',
      });
    } finally {
      if (invocation.outputDirectory) {
        await rm(invocation.outputDirectory, { force: true, recursive: true });
      }
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
    // The output-file path embeds a random mkdtemp suffix per invocation, so
    // normalize it out before comparing two separately built invocations.
    const normalize = (invocation: CliInvocation) =>
      invocation.args.map((arg) => (arg === invocation.outputFile ? '<outputFile>' : arg));
    const withoutA = await new InspectableCodexExecutor(1_000_000).inspect(request());
    const withoutB = await new InspectableCodexExecutor(1_000_000).inspect(
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
    const invocation = await new InspectableCodexExecutor(1_000_000).inspect(
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
      new InspectableCodexExecutor(1_000_000).inspect(
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
