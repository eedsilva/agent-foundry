import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { FileWorkspaceManager } from './workspace-manager.js';

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

    expect(result).toEqual({ draftBranch: 'draft/run-1' });
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
});
