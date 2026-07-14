import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { RunCancelledError } from '@agent-foundry/domain';
import { WorkspaceVerifier } from './verifier.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-foundry-verifier-'));
  temporaryDirectories.push(cwd);
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.name', 'Verifier Test'], { cwd });
  await execa('git', ['config', 'user.email', 'verifier@example.test'], { cwd });
  return cwd;
}

describe('WorkspaceVerifier', () => {
  it('fails when a configured script is missing', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true, scripts: {} }));
    await execa('git', ['add', '-A'], { cwd });
    await execa('git', ['commit', '-m', 'initial'], { cwd });

    const verifier = new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
    const report = await verifier.verify({
      workspacePath: cwd,
      scripts: ['test'],
      includeGitDiffCheck: true,
    });

    expect(report.approved).toBe(false);
    expect(report.commands.find((command) => command.name === 'test')).toMatchObject({
      exitCode: 1,
      skipped: false,
    });
  });

  it('checks committed files for whitespace errors', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ private: true, scripts: { test: 'node --test' } }),
    );
    await writeFile(join(cwd, 'bad.txt'), 'trailing whitespace   \n');
    await execa('git', ['add', '-A'], { cwd });
    await execa('git', ['commit', '-m', 'initial'], { cwd });

    const verifier = new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
    const report = await verifier.verify({
      workspacePath: cwd,
      scripts: ['test'],
      includeGitDiffCheck: true,
    });

    const gitCheck = report.commands.find((command) => command.name === 'git-committed-tree-check');
    expect(gitCheck?.exitCode).not.toBe(0);
    expect(report.approved).toBe(false);
  });

  it('throws RunCancelledError instead of producing a report when cancelled', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ private: true, scripts: {} }));

    const verifier = new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      verifier.verify(
        { workspacePath: cwd, scripts: ['test'], includeGitDiffCheck: true },
        controller.signal,
      ),
    ).rejects.toThrow(RunCancelledError);
  });
});
