import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { FileWorkspaceManager } from './workspace-manager.js';

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

    const { written } = await manager.applyScaffold('project-1', [
      { path: 'lib/supabase/client.ts', content: 'export const marker = "scaffold";\n' },
      { path: 'middleware.ts', content: 'export const config = {};\n' },
    ]);

    expect(written.sort()).toEqual(['lib/supabase/client.ts', 'middleware.ts']);
    const workspace = manager.workspacePath('project-1');
    await expect(readFile(join(workspace, 'lib/supabase/client.ts'), 'utf8')).resolves.toBe(
      'export const marker = "scaffold";\n',
    );
    await expect(readFile(join(workspace, 'middleware.ts'), 'utf8')).resolves.toBe(
      'export const config = {};\n',
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
