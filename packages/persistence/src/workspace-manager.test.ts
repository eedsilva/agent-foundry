import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { FileWorkspaceManager } from './workspace-manager.js';

describe('FileWorkspaceManager project-directory reservation (#599)', () => {
  function manager(dataDir: string): FileWorkspaceManager {
    return new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
  }

  it('reserves the exact canonical empty directory and rejects a concurrent second project', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const parent = await mkdtemp(join(tmpdir(), 'agent-foundry-projects-'));
    const selected = join(parent, 'generated-app');
    const workspaces = manager(dataDir);

    const attempts = await Promise.allSettled([
      workspaces.reserveProjectDirectory('project-1', selected),
      workspaces.reserveProjectDirectory('project-2', selected),
    ]);
    const winnerIndex = attempts.findIndex((attempt) => attempt.status === 'fulfilled');
    const winner = attempts[winnerIndex] as PromiseFulfilledResult<string>;

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(winner.value).toBe(await realpath(selected));
    expect(workspaces.workspacePath(`project-${winnerIndex + 1}`)).toBe(await realpath(selected));
  });

  it('serializes concurrent aliases that resolve to the same directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const parent = await mkdtemp(join(tmpdir(), 'agent-foundry-projects-'));
    const upper = join(parent, 'Generated-App');
    const lower = join(parent, 'generated-app');
    const probe = join(parent, 'case-probe');
    await mkdir(probe);
    const aliasesSame = await lstat(join(parent, 'CASE-PROBE')).then(
      () => true,
      () => false,
    );
    await rm(probe, { recursive: true });
    if (!aliasesSame) return;
    const workspaces = manager(dataDir);

    const attempts = await Promise.allSettled([
      workspaces.reserveProjectDirectory('project-1', upper),
      workspaces.reserveProjectDirectory('project-2', lower),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(await realpath(upper)).toBe(await realpath(lower));
  });

  it('rejects a non-empty directory without changing it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const selected = await mkdtemp(join(tmpdir(), 'agent-foundry-project-'));
    const sentinel = join(selected, 'keep.txt');
    await writeFile(sentinel, 'operator work\n');

    await expect(manager(dataDir).reserveProjectDirectory('project-1', selected)).rejects.toThrow(
      /empty/i,
    );
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('operator work\n');
  });

  it('rejects a directory whose parent has not been chosen or created', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));

    await expect(
      manager(dataDir).reserveProjectDirectory(
        'project-1',
        join(dataDir, 'missing', 'generated-app'),
      ),
    ).rejects.toThrow(/parent must already exist/i);
  });

  it('rejects a directory inside DATA_DIR before creating or reserving it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const selected = join(dataDir, 'generated-app');

    await expect(manager(dataDir).reserveProjectDirectory('project-1', selected)).rejects.toThrow(
      /outside DATA_DIR/i,
    );
    await expect(lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases pre-persistence artifacts so the selected directory can be reused', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const parent = await mkdtemp(join(tmpdir(), 'agent-foundry-projects-'));
    const selected = join(parent, 'generated-app');
    const workspaces = manager(dataDir);

    await workspaces.reserveProjectDirectory('project-1', selected);
    await workspaces.ensure('project-1');
    await workspaces.writePrd('project-1', 'Build the generated application.');
    await workspaces.applyScaffold('project-1', [
      { path: 'src/app.ts', content: 'export const app = true;\n' },
    ]);
    await workspaces.releaseProjectDirectory('project-1', [
      { path: 'PRD.md', content: 'Build the generated application.\n' },
      { path: 'src/app.ts', content: 'export const app = true;\n' },
    ]);

    await expect(workspaces.reserveProjectDirectory('project-2', selected)).resolves.toBe(
      await realpath(selected),
    );
  });

  it('preserves an external edit made before pre-persistence rollback', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const parent = await mkdtemp(join(tmpdir(), 'agent-foundry-projects-'));
    const selected = join(parent, 'generated-app');
    const workspaces = manager(dataDir);

    await workspaces.reserveProjectDirectory('project-1', selected);
    await workspaces.writePrd('project-1', 'Generated PRD.');
    await writeFile(join(selected, 'PRD.md'), 'Operator edit.\n');
    await workspaces.releaseProjectDirectory('project-1', [
      { path: 'PRD.md', content: 'Generated PRD.\n' },
    ]);

    await expect(readFile(join(selected, 'PRD.md'), 'utf8')).resolves.toBe('Operator edit.\n');
  });

  it('does not follow an intermediate symlink while rolling back generated files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const parent = await mkdtemp(join(tmpdir(), 'agent-foundry-projects-'));
    const external = await mkdtemp(join(tmpdir(), 'agent-foundry-external-'));
    const selected = join(parent, 'generated-app');
    const workspaces = manager(dataDir);
    const generated = 'export const app = true;\n';

    await workspaces.reserveProjectDirectory('project-1', selected);
    await workspaces.applyScaffold('project-1', [{ path: 'src/app.ts', content: generated }]);
    await rm(join(selected, 'src'), { recursive: true });
    await writeFile(join(external, 'app.ts'), generated);
    await symlink(external, join(selected, 'src'), 'dir');

    await expect(
      workspaces.releaseProjectDirectory('project-1', [{ path: 'src/app.ts', content: generated }]),
    ).resolves.toBeUndefined();

    await expect(readFile(join(external, 'app.ts'), 'utf8')).resolves.toBe(generated);
  });

  it('releases the marker when an external edit replaces a generated file with a directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const parent = await mkdtemp(join(tmpdir(), 'agent-foundry-projects-'));
    const selected = join(parent, 'generated-app');
    const workspaces = manager(dataDir);

    await workspaces.reserveProjectDirectory('project-1', selected);
    await workspaces.applyScaffold('project-1', [
      { path: 'src/app.ts', content: 'export const app = true;\n' },
    ]);
    await rm(join(selected, 'src', 'app.ts'));
    await mkdir(join(selected, 'src', 'app.ts'));
    await workspaces.releaseProjectDirectory('project-1', [
      { path: 'src/app.ts', content: 'export const app = true;\n' },
    ]);

    await expect(workspaces.reserveProjectDirectory('project-2', selected)).rejects.toThrow(
      /new or empty/i,
    );
  });

  it('keeps a durable reservation after a manager restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-data-'));
    const parent = await mkdtemp(join(tmpdir(), 'agent-foundry-projects-'));
    const selected = join(parent, 'generated-app');

    await manager(dataDir).reserveProjectDirectory('project-1', selected);
    const restarted = manager(dataDir);

    expect(restarted.workspacePath('project-1')).toBe(await realpath(selected));
    await expect(restarted.reserveProjectDirectory('project-2', selected)).rejects.toThrow(
      /already reserved/i,
    );
  });
});

describe('FileWorkspaceManager run inputs', () => {
  it('materializes a project knowledge input in the attempt context for a CLI child tool', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const inputPath = 'knowledge/design/v2.png';
    const bytes = Buffer.from('exact-v2-png-bytes');
    const { requestPath, inputPaths } = await manager.writeRunContext({
      projectId: 'project-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      requestMarkdown: 'Read the execution input.',
      outputSchema: {},
      inputFiles: [{ path: inputPath, content: bytes }],
    });

    const expectedPath = join(dirname(requestPath), 'inputs', inputPath);
    expect(inputPaths).toEqual([expectedPath]);
    expect(isAbsolute(expectedPath)).toBe(true);
    expect(expectedPath.startsWith(manager.workspacePath('project-1'))).toBe(true);
    await expect(readFile(expectedPath)).resolves.toEqual(bytes);

    const cli = await execa(process.execPath, [
      '-e',
      [
        "const { spawnSync } = require('node:child_process');",
        "const tool = spawnSync(process.execPath, ['-e', \"process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('hex'))\", process.argv[1]], { encoding: 'utf8' });",
        'if (tool.status !== 0) throw new Error(tool.stderr);',
        'process.stdout.write(tool.stdout);',
      ].join('\n'),
      expectedPath,
    ]);
    expect(cli.stdout).toBe(bytes.toString('hex'));
    await expect(readFile(requestPath, 'utf8')).resolves.toBe('Read the execution input.');
  });
});

describe('FileWorkspaceManager.isClean', () => {
  it('detects tracked and untracked baseline changes without mutating them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);

    expect(await manager.isClean(projectId)).toBe(true);
    await writeFile(join(workspace, 'untracked.txt'), 'keep me\n');
    expect(await manager.isClean(projectId)).toBe(false);
    expect(await readFile(join(workspace, 'untracked.txt'), 'utf8')).toBe('keep me\n');
  });
});

describe('FileWorkspaceManager.ensureGit', () => {
  it('writes the git identity only when it initializes the repository', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    await manager.ensureGit('project-1');
    const workspace = manager.workspacePath('project-1');
    const configPath = join(workspace, '.git', 'config');
    const beforeMtime = (await stat(configPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Rewriting the same value still takes `.git/config.lock` and still
    // rewrites the file, so an unchanged mtime is the evidence that no second
    // write happened at all — which is what makes concurrent worktree
    // checkpoints safe (#520).
    await manager.ensureGit('project-1');

    expect((await stat(configPath)).mtimeMs).toBe(beforeMtime);
    const name = await execa('git', ['config', 'user.name'], { cwd: workspace });
    expect(name.stdout.trim()).toBe('Test Agent');
  });

  it('survives concurrent checkpoints from parallel task worktrees (#520)', async () => {
    // `checkpoint(projectId, label, worktree)` calls `ensureGit` against the
    // primary repo whatever worktree it targets. While `ensureGit` rewrote the
    // git identity on every call, two of these racing lost `.git/config.lock`
    // and failed the run.
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const labels = ['a', 'b', 'c', 'd'];
    await manager.ensureGit('project-1');
    for (const label of labels) await manager.createWorktree('project-1', label);

    const checkpoints = await Promise.all(
      labels.map((label) => manager.checkpoint('project-1', label, label)),
    );

    expect(checkpoints).toHaveLength(4);
    expect(checkpoints.every((sha) => /^[0-9a-f]{40}$/.test(sha))).toBe(true);
  });
});

describe('FileWorkspaceManager nested repository boundary', () => {
  it('initializes a workspace repository instead of using an ancestor checkout', async () => {
    const dataDir = await mkdtemp(join(process.cwd(), '.workspace-manager-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });

    try {
      await manager.ensureGit('project-1');
      const workspace = manager.workspacePath('project-1');
      const topLevel = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: workspace });

      expect(topLevel.stdout.trim()).toBe(workspace);
      expect(await manager.checkpoint('project-1', 'isolated')).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('FileWorkspaceManager.preserveDraft', () => {
  it('preserves failed work on a draft branch and restores the verified checkpoint', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'verified.txt'), 'verified\n');
    const verified = await manager.checkpoint(projectId, 'verified');

    await writeFile(join(workspace, 'verified.txt'), 'failed change\n');
    await writeFile(join(workspace, 'untracked.txt'), 'failed untracked\n');

    const result = await manager.preserveDraft(projectId, 'run-1', verified);

    expect(result).toEqual({
      draftBranch: 'draft/run-1',
      draftCommit: expect.any(String),
      created: true,
    });
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout).toBe(verified);
    expect(await readFile(join(workspace, 'verified.txt'), 'utf8')).toBe('verified\n');
    await expect(readFile(join(workspace, 'untracked.txt'), 'utf8')).rejects.toThrow();
    expect(
      (await execa('git', ['show', 'draft/run-1:verified.txt'], { cwd: workspace })).stdout,
    ).toBe('failed change');
    expect(
      (await execa('git', ['show', 'draft/run-1:untracked.txt'], { cwd: workspace })).stdout,
    ).toBe('failed untracked');
  });

  it('reuses a failed commit when replay starts before the draft ref was created', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    await manager.ensureGit('project-1');
    const workspace = manager.workspacePath('project-1');
    await writeFile(join(workspace, 'work.txt'), 'verified\n');
    const verified = await manager.checkpoint('project-1', 'verified');
    await writeFile(join(workspace, 'work.txt'), 'failed\n');
    const failed = await manager.commit('project-1', 'simulated crash after draft commit');

    await manager.preserveDraft('project-1', 'run-1', verified);

    expect((await execa('git', ['rev-parse', 'draft/run-1'], { cwd: workspace })).stdout).toBe(
      failed,
    );
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout).toBe(verified);
    expect((await execa('git', ['status', '--porcelain'], { cwd: workspace })).stdout).toBe('');
  });

  it('keeps an existing draft ref when replay starts before workspace restore', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    await manager.ensureGit('project-1');
    const workspace = manager.workspacePath('project-1');
    await writeFile(join(workspace, 'work.txt'), 'verified\n');
    const verified = await manager.checkpoint('project-1', 'verified');
    await writeFile(join(workspace, 'work.txt'), 'failed\n');
    const failed = await manager.commit('project-1', 'simulated draft commit');
    await execa('git', ['branch', 'draft/run-1', 'HEAD'], { cwd: workspace });

    await manager.preserveDraft('project-1', 'run-1', verified);

    expect((await execa('git', ['rev-parse', 'draft/run-1'], { cwd: workspace })).stdout).toBe(
      failed,
    );
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout).toBe(verified);
    expect((await execa('git', ['status', '--porcelain'], { cwd: workspace })).stdout).toBe('');
  });

  it('rejects a stale existing draft from an unexpected clean HEAD without changing work', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    await manager.ensureGit('project-1');
    const workspace = manager.workspacePath('project-1');
    await writeFile(join(workspace, 'work.txt'), 'verified\n');
    const verified = await manager.checkpoint('project-1', 'verified');
    await execa('git', ['branch', 'draft/run-1', verified], { cwd: workspace });
    await writeFile(join(workspace, 'work.txt'), 'unexpected\n');
    const unexpected = await manager.commit('project-1', 'unrelated work');

    await expect(manager.preserveDraft('project-1', 'run-1', verified)).rejects.toThrow(
      'existing draft/run-1 is not a safe replay',
    );

    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout).toBe(unexpected);
    expect((await execa('git', ['rev-parse', 'draft/run-1'], { cwd: workspace })).stdout).toBe(
      verified,
    );
    expect(await readFile(join(workspace, 'work.txt'), 'utf8')).toBe('unexpected\n');
    expect((await execa('git', ['status', '--porcelain'], { cwd: workspace })).stdout).toBe('');
  });

  it('rejects an existing draft from a dirty worktree without resetting or cleaning it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    await manager.ensureGit('project-1');
    const workspace = manager.workspacePath('project-1');
    await writeFile(join(workspace, 'work.txt'), 'verified\n');
    const verified = await manager.checkpoint('project-1', 'verified');
    await execa('git', ['branch', 'draft/run-1', verified], { cwd: workspace });
    await writeFile(join(workspace, 'work.txt'), 'dirty\n');
    await writeFile(join(workspace, 'untracked.txt'), 'keep me\n');

    await expect(manager.preserveDraft('project-1', 'run-1', verified)).rejects.toThrow(
      'existing draft/run-1 is not a safe replay',
    );

    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout).toBe(verified);
    expect((await execa('git', ['rev-parse', 'draft/run-1'], { cwd: workspace })).stdout).toBe(
      verified,
    );
    expect(await readFile(join(workspace, 'work.txt'), 'utf8')).toBe('dirty\n');
    expect(await readFile(join(workspace, 'untracked.txt'), 'utf8')).toBe('keep me\n');
    expect((await execa('git', ['status', '--porcelain'], { cwd: workspace })).stdout).not.toBe('');
  });

  it('refuses to discard an owned draft after its ref moved', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    await manager.ensureGit('project-1');
    const workspace = manager.workspacePath('project-1');
    await writeFile(join(workspace, 'work.txt'), 'verified\n');
    const verified = await manager.checkpoint('project-1', 'verified');
    await writeFile(join(workspace, 'work.txt'), 'failed\n');
    const { draftCommit } = await manager.preserveDraft('project-1', 'run-1', verified);
    await writeFile(join(workspace, 'work.txt'), 'new owner\n');
    const moved = await manager.checkpoint('project-1', 'new owner');
    await execa('git', ['branch', '-f', 'draft/run-1', moved], { cwd: workspace });

    await expect(manager.discardDraft('project-1', 'run-1', draftCommit)).rejects.toThrow(
      'draft/run-1 no longer points to the owned commit',
    );

    expect((await execa('git', ['rev-parse', 'draft/run-1'], { cwd: workspace })).stdout).toBe(
      moved,
    );
  });
});

describe('FileWorkspaceManager applyScaffold', () => {
  it('writes scaffold files verbatim into the project workspace root', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });

    await manager.applyScaffold('project-1', [
      { path: 'lib/supabase/client.ts', content: 'export const marker = "scaffold";\n' },
      { path: 'middleware.ts', content: 'export const config = {};\n' },
    ]);

    const workspace = manager.workspacePath('project-1');
    await expect(readFile(join(workspace, 'lib/supabase/client.ts'), 'utf8')).resolves.toBe(
      'export const marker = "scaffold";\n',
    );
    await expect(readFile(join(workspace, 'middleware.ts'), 'utf8')).resolves.toBe(
      'export const config = {};\n',
    );
  });

  // A scaffold that ships its own .gitignore silently replaces this one, and
  // the workspace stops ignoring orchestrator run context — which `checkpoint`
  // (`git add -A`) would then commit into the generated app's history.
  it('keeps the workspace .gitignore it owns when a scaffold is applied', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });

    await manager.applyScaffold('project-1', [{ path: 'package.json', content: '{}\n' }]);

    const gitignore = await readFile(
      join(manager.workspacePath('project-1'), '.gitignore'),
      'utf8',
    );
    expect(gitignore.split('\n')).toEqual(
      expect.arrayContaining([
        'node_modules/',
        '.env*',
        '!.env.example',
        '.orchestrator/',
        '*.log',
        'supabase/.temp/',
      ]),
    );
  });

  it('rejects an absolute scaffold path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });

    await expect(
      manager.applyScaffold('project-1', [{ path: '/etc/passwd', content: 'x' }]),
    ).rejects.toThrow('Unsafe scaffold path');
  });
});

describe('FileWorkspaceManager version primitives', () => {
  it('diff returns a non-empty diff between two commits with different content and an empty diff comparing a ref to itself', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'work.txt'), 'first\n');
    const first = await manager.checkpoint(projectId, 'first');
    await writeFile(join(workspace, 'work.txt'), 'second\n');
    const second = await manager.checkpoint(projectId, 'second');

    const changed = await manager.diff(projectId, first, second);
    const unchanged = await manager.diff(projectId, second, second);

    expect(changed).not.toBe('');
    expect(changed).toContain('work.txt');
    expect(unchanged).toBe('');
  });

  it('restoreTree puts old file content back in the working tree without moving HEAD', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'work.txt'), 'old\n');
    const old = await manager.checkpoint(projectId, 'old');
    await writeFile(join(workspace, 'work.txt'), 'new\n');
    const latest = await manager.checkpoint(projectId, 'new');

    await manager.restoreTree(projectId, old);

    expect(await readFile(join(workspace, 'work.txt'), 'utf8')).toBe('old\n');
    expect(await manager.head(projectId)).toBe(latest);
  });

  it('restoreTree removes a file that was added after the target ref', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'a.txt'), 'a\n');
    const old = await manager.checkpoint(projectId, 'a-only');
    await writeFile(join(workspace, 'b.txt'), 'b\n');
    await manager.checkpoint(projectId, 'adds-b');

    await manager.restoreTree(projectId, old);

    await expect(readFile(join(workspace, 'b.txt'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('a\n');
  });

  it('createBranch creates a branch pointing at an old commit without moving the current branch', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'work.txt'), 'old\n');
    const old = await manager.checkpoint(projectId, 'old');
    await writeFile(join(workspace, 'work.txt'), 'new\n');
    const latest = await manager.checkpoint(projectId, 'new');

    const result = await manager.createBranch(projectId, old, 'revert-branch-1');

    expect(result).toBe(old);
    expect(await manager.head(projectId)).toBe(latest);
    expect((await execa('git', ['rev-parse', 'revert-branch-1'], { cwd: workspace })).stdout).toBe(
      old,
    );
  });

  it('createBranch accepts a hierarchical name containing a slash', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'work.txt'), 'old\n');
    const old = await manager.checkpoint(projectId, 'old');

    const result = await manager.createBranch(projectId, old, 'branch/my-feature');

    expect(result).toBe(old);
    expect(
      (await execa('git', ['rev-parse', 'branch/my-feature'], { cwd: workspace })).stdout,
    ).toBe(old);
  });

  it('createBranch rejects a name that escapes the refs namespace', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'work.txt'), 'old\n');
    const old = await manager.checkpoint(projectId, 'old');

    await expect(manager.createBranch(projectId, old, '../escape')).rejects.toThrow();
    await expect(manager.createBranch(projectId, old, 'a/../../escape')).rejects.toThrow();
  });
});

describe('FileWorkspaceManager.listFiles', () => {
  it('lists files recursively, respecting the project gitignore', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(join(workspace, 'src'), { recursive: true });
    await mkdir(join(workspace, 'node_modules', 'react'), { recursive: true });
    await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
    await writeFile(join(workspace, 'README.md'), '# hi\n');
    await writeFile(join(workspace, 'src', 'App.tsx'), 'export {}\n');
    await writeFile(join(workspace, 'node_modules', 'react', 'index.js'), '// noop\n');

    const files = await manager.listFiles(projectId);

    expect(files).toEqual(['.gitignore', 'README.md', 'src/App.tsx']);
  });

  it('excludes .env files even when there is no gitignore at all', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, '.env'), 'SECRET=shh\n');
    await writeFile(join(workspace, 'README.md'), '# hi\n');

    expect(await manager.listFiles(projectId)).toEqual(['README.md']);
  });

  it('excludes .git internals even when there is no gitignore at all', async () => {
    // A real, git-initialized workspace (this manager's own workspaces
    // always are) has a .git directory nobody's own .gitignore ever
    // mentions — without a hardcoded exclude, every raw object blob and hook
    // sample leaks into the Files tab.
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(join(workspace, '.git', 'objects', '4f'), { recursive: true });
    await writeFile(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(workspace, '.git', 'objects', '4f', '034a7e'), Buffer.from([0x78, 0x01]));
    await writeFile(join(workspace, 'README.md'), '# hi\n');

    expect(await manager.listFiles(projectId)).toEqual(['README.md']);
  });
});

describe('FileWorkspaceManager.readWorkspaceFile', () => {
  it('reads a listable file by its workspace-relative path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'App.tsx'), 'export {}\n');

    await expect(manager.readWorkspaceFile(projectId, 'src/App.tsx')).resolves.toBe('export {}\n');
  });

  it('rejects a path that escapes the workspace', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await mkdir(manager.workspacePath(projectId), { recursive: true });

    await expect(manager.readWorkspaceFile(projectId, '../../etc/passwd')).rejects.toThrow();
  });

  it('rejects a symlink inside the workspace whose target resolves outside it (#565)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(workspace, { recursive: true });
    const outsideSecret = join(dataDir, 'outside-secret.txt');
    await writeFile(outsideSecret, 'host secret\n');
    await symlink(outsideSecret, join(workspace, 'escape.txt'));

    // resolveWorkspaceRelativePath alone only checks the literal string
    // path, which stays inside the workspace — this proves the realpath
    // check catches what that check alone would miss.
    await expect(manager.readWorkspaceFile(projectId, 'escape.txt')).rejects.toThrow();
  });

  it('still reads a symlink whose target stays inside the workspace', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'App.tsx'), 'export {}\n');
    await symlink(join(workspace, 'src', 'App.tsx'), join(workspace, 'App-link.tsx'));

    await expect(manager.readWorkspaceFile(projectId, 'App-link.tsx')).resolves.toBe('export {}\n');
  });

  it('rejects a .env file even by direct path, mirroring listFiles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, '.env'), 'SECRET=shh\n');

    await expect(manager.readWorkspaceFile(projectId, '.env')).rejects.toThrow();
  });

  it('rejects a file over the display size cap instead of loading it fully', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'huge.txt'), 'x'.repeat(6 * 1024 * 1024));

    await expect(manager.readWorkspaceFile(projectId, 'huge.txt')).rejects.toThrow(
      /exceeds the .* limit/,
    );
  });

  it('rejects a file containing a NUL byte as not text', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    const workspace = manager.workspacePath(projectId);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x0d]));

    await expect(manager.readWorkspaceFile(projectId, 'image.png')).rejects.toThrow(/binary/);
  });
});

describe('FileWorkspaceManager.workspacePath worktree parameter', () => {
  it('resolves a worktree path under projectRoot/worktrees/<label>, primary path unaffected', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });

    expect(manager.workspacePath('project-1', 'task-a')).toBe(
      join(manager.projectRoot('project-1'), 'worktrees', 'task-a'),
    );
    expect(manager.workspacePath('project-1')).toBe(
      join(manager.projectRoot('project-1'), 'workspace'),
    );
  });
});

describe('FileWorkspaceManager worktree lifecycle (#520)', () => {
  it('createWorktree creates a real git worktree at HEAD', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'base.txt'), 'base\n');
    await manager.checkpoint(projectId, 'base');

    await manager.createWorktree(projectId, 'task-a');

    const worktreePath = manager.workspacePath(projectId, 'task-a');
    const topLevel = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: worktreePath });
    // `git rev-parse` resolves symlinks (macOS aliases /tmp -> /private/tmp);
    // resolve both sides the same way before comparing.
    expect(await realpath(topLevel.stdout.trim())).toBe(await realpath(worktreePath));
    await expect(readFile(join(worktreePath, 'base.txt'), 'utf8')).resolves.toBe('base\n');
  });

  it('keeps a commit made inside a worktree out of the primary checkout until integrateWorktree', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'base.txt'), 'base\n');
    await manager.checkpoint(projectId, 'base');
    await manager.createWorktree(projectId, 'task-a');
    const worktreePath = manager.workspacePath(projectId, 'task-a');
    await writeFile(join(worktreePath, 'feature-a.txt'), 'feature a\n');
    await manager.commit(projectId, 'add feature a', 'task-a');

    await expect(readFile(join(workspace, 'feature-a.txt'), 'utf8')).rejects.toThrow();

    await manager.integrateWorktree(projectId, 'task-a');

    await expect(readFile(join(workspace, 'feature-a.txt'), 'utf8')).resolves.toBe('feature a\n');
  });

  it('integrateWorktree merges two worktrees that touched different files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'base.txt'), 'base\n');
    await manager.checkpoint(projectId, 'base');
    await manager.createWorktree(projectId, 'task-a');
    await manager.createWorktree(projectId, 'task-b');
    const a = manager.workspacePath(projectId, 'task-a');
    const b = manager.workspacePath(projectId, 'task-b');
    await writeFile(join(a, 'a.txt'), 'a\n');
    await manager.commit(projectId, 'add a', 'task-a');
    await writeFile(join(b, 'b.txt'), 'b\n');
    await manager.commit(projectId, 'add b', 'task-b');

    await manager.integrateWorktree(projectId, 'task-a');
    await manager.integrateWorktree(projectId, 'task-b');

    await expect(readFile(join(workspace, 'a.txt'), 'utf8')).resolves.toBe('a\n');
    await expect(readFile(join(workspace, 'b.txt'), 'utf8')).resolves.toBe('b\n');
  });

  it('integrateWorktree throws on a genuine conflict and leaves the primary checkout clean', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'shared.txt'), 'base\n');
    await manager.checkpoint(projectId, 'base');
    await manager.createWorktree(projectId, 'task-a');
    await manager.createWorktree(projectId, 'task-b');
    const a = manager.workspacePath(projectId, 'task-a');
    const b = manager.workspacePath(projectId, 'task-b');
    await writeFile(join(a, 'shared.txt'), 'from a\n');
    await manager.commit(projectId, 'edit from a', 'task-a');
    await writeFile(join(b, 'shared.txt'), 'from b\n');
    await manager.commit(projectId, 'edit from b', 'task-b');
    await manager.integrateWorktree(projectId, 'task-a');

    await expect(manager.integrateWorktree(projectId, 'task-b')).rejects.toThrow('task-b');

    expect(await manager.isClean(projectId)).toBe(true);
    const mergeHead = await execa('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      cwd: workspace,
      reject: false,
    });
    expect(mergeHead.exitCode).not.toBe(0);
  });

  it('removeWorktree is idempotent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    await manager.createWorktree(projectId, 'task-a');
    const worktreePath = manager.workspacePath(projectId, 'task-a');

    await manager.removeWorktree(projectId, 'task-a');

    await expect(stat(worktreePath)).rejects.toThrow();
    await expect(manager.removeWorktree(projectId, 'task-a')).resolves.toBeUndefined();
  });

  it('createWorktree reclaims a stale branch when a prior worktree directory was removed without deleting it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await manager.createWorktree(projectId, 'task-a');
    const worktreePath = manager.workspacePath(projectId, 'task-a');
    // Simulates a crashed/killed run: the worktree directory is gone (e.g. via
    // `git worktree remove`) but its branch `af/task/task-a` was never deleted.
    await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: workspace });
    await expect(
      execa('git', ['rev-parse', '--verify', 'refs/heads/af/task/task-a'], { cwd: workspace }),
    ).resolves.toBeDefined();

    await expect(manager.createWorktree(projectId, 'task-a')).resolves.toBeUndefined();

    const topLevel = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: worktreePath });
    expect(await realpath(topLevel.stdout.trim())).toBe(await realpath(worktreePath));
  });

  it('makes the primary node_modules reachable from a new worktree', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await mkdir(join(workspace, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(
      join(workspace, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = 1;\n',
    );

    await manager.createWorktree(projectId, 'task-a');

    const worktreePath = manager.workspacePath(projectId, 'task-a');
    await expect(
      readFile(join(worktreePath, 'node_modules', 'left-pad', 'index.js'), 'utf8'),
    ).resolves.toBe('module.exports = 1;\n');
  });

  it('never commits or merges the worktree node_modules symlink back into the primary install', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await mkdir(join(workspace, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(
      join(workspace, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = 1;\n',
    );

    await manager.createWorktree(projectId, 'task-a');
    const worktreePath = manager.workspacePath(projectId, 'task-a');
    // The scheduler's very first act after forking: a checkpoint whose only
    // candidate change is the symlink `createWorktree` just made.
    await manager.checkpoint(projectId, 'fork', 'task-a');
    await writeFile(join(worktreePath, 'feature.txt'), 'feature\n');
    await manager.checkpoint(projectId, 'work', 'task-a');
    await manager.integrateWorktree(projectId, 'task-a');

    const tree = await execa('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: workspace });
    expect(tree.stdout.split('\n')).not.toContain('node_modules');
    expect(await manager.isClean(projectId)).toBe(true);
    // The primary's install survived the merge as a real directory.
    const primaryNodeModules = await lstat(join(workspace, 'node_modules'));
    expect(primaryNodeModules.isSymbolicLink()).toBe(false);
    expect(primaryNodeModules.isDirectory()).toBe(true);
    await expect(
      readFile(join(workspace, 'node_modules', 'left-pad', 'index.js'), 'utf8'),
    ).resolves.toBe('module.exports = 1;\n');
    // And the task's actual work still landed.
    await expect(readFile(join(workspace, 'feature.txt'), 'utf8')).resolves.toBe('feature\n');
  });

  it('cleanup removes worktrees along with the workspace since they live under projectRoot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    await manager.createWorktree(projectId, 'task-a');
    const worktreePath = manager.workspacePath(projectId, 'task-a');
    await writeFile(join(worktreePath, 'in-worktree.txt'), 'still here?\n');
    await expect(readFile(join(worktreePath, 'in-worktree.txt'), 'utf8')).resolves.toBe(
      'still here?\n',
    );

    await manager.cleanup(projectId);

    await expect(stat(worktreePath)).rejects.toThrow();
  });
});

describe('FileWorkspaceManager per-task git methods (#520 checkpoint/rollback/head/isClean)', () => {
  it('checkpoint, rollback, head, and isClean operate on the worktree, not the primary, when given a worktree label', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    const workspace = manager.workspacePath(projectId);
    await writeFile(join(workspace, 'base.txt'), 'base\n');
    const primaryHead = await manager.checkpoint(projectId, 'base');
    await manager.createWorktree(projectId, 'task-a');
    const worktreePath = manager.workspacePath(projectId, 'task-a');

    expect(await manager.isClean(projectId, 'task-a')).toBe(true);
    expect(await manager.head(projectId, 'task-a')).toBe(primaryHead);

    await writeFile(join(worktreePath, 'work.txt'), 'dirty\n');
    expect(await manager.isClean(projectId, 'task-a')).toBe(false);

    const worktreeCheckpoint = await manager.checkpoint(projectId, 'wip', 'task-a');
    expect(worktreeCheckpoint).not.toBe(primaryHead);
    expect(await manager.head(projectId, 'task-a')).toBe(worktreeCheckpoint);
    // The primary checkout is untouched by any worktree-scoped call above.
    expect(await manager.head(projectId)).toBe(primaryHead);
    expect(await manager.isClean(projectId)).toBe(true);

    await writeFile(join(worktreePath, 'work.txt'), 'more changes\n');
    expect(await manager.isClean(projectId, 'task-a')).toBe(false);

    await manager.rollback(projectId, worktreeCheckpoint, 'task-a');

    expect(await manager.isClean(projectId, 'task-a')).toBe(true);
    await expect(readFile(join(worktreePath, 'work.txt'), 'utf8')).resolves.toBe('dirty\n');
  });
});

describe('FileWorkspaceManager.writeRunContext worktree parameter', () => {
  it('writes REQUEST.md under the worktree path when a worktree label is given', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-workspace-'));
    const manager = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    const projectId = 'project-1';
    await manager.ensureGit(projectId);
    await manager.createWorktree(projectId, 'task-a');

    const { requestPath } = await manager.writeRunContext(
      {
        projectId,
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        requestMarkdown: 'Do the task.',
        outputSchema: {},
      },
      'task-a',
    );

    expect(requestPath.startsWith(manager.workspacePath(projectId, 'task-a'))).toBe(true);
    await expect(readFile(requestPath, 'utf8')).resolves.toBe('Do the task.');
  });
});
