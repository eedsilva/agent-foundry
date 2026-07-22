import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectPolicySchema } from '@agent-foundry/contracts';
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

  it('does not choose npm when the package manager is unknown', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: { test: "node -e \"require('fs').writeFileSync('script-ran', '')\"" },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: true,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    }).verify({ workspacePath: cwd, scripts: ['test'], includeGitDiffCheck: false });

    expect(report.approved).toBe(false);
    expect(report.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'install', command: 'unknown', args: [] }),
        expect.objectContaining({ name: 'test', command: 'unknown', args: [] }),
      ]),
    );
    expect(existsSync(join(cwd, 'script-ran'))).toBe(false);
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

  const strictPolicy = ProjectPolicySchema.parse({
    schemaVersion: '1',
    id: 'strict',
    version: 2,
    forbiddenDependencies: ['left-pad'],
    allowedCommands: ['lint'],
  });

  function verifier(): WorkspaceVerifier {
    return new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
  }

  it('blocks scripts outside the policy allowlist without executing them', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          lint: 'node -e ""',
          evil: "node -e \"require('fs').writeFileSync('evil-ran','')\"",
        },
      }),
    );
    await execa('git', ['add', '-A'], { cwd });
    await execa('git', ['commit', '-m', 'initial'], { cwd });

    const report = await verifier().verify({
      workspacePath: cwd,
      scripts: ['lint', 'evil'],
      includeGitDiffCheck: false,
      policy: strictPolicy,
    });

    expect(report.approved).toBe(false);
    const blocked = report.commands.find((command) => command.name === 'evil');
    expect(blocked).toMatchObject({ command: 'policy', exitCode: 1 });
    expect(blocked?.stderr).toContain('not allowed by policy strict@v2');
    expect(existsSync(join(cwd, 'evil-ran'))).toBe(false);
  });

  it('fails the report when a forbidden dependency is declared', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ private: true, scripts: {}, dependencies: { 'left-pad': '1.3.0' } }),
    );

    const report = await verifier().verify({
      workspacePath: cwd,
      scripts: [],
      includeGitDiffCheck: false,
      policy: strictPolicy,
    });

    expect(report.approved).toBe(false);
    const check = report.commands.find((command) => command.name === 'policy-dependency-check');
    expect(check?.exitCode).toBe(1);
    expect(check?.stderr).toContain('left-pad');
  });

  it('passes the dependency check when nothing forbidden is declared', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ private: true, scripts: {}, dependencies: { react: '19.0.0' } }),
    );

    const report = await verifier().verify({
      workspacePath: cwd,
      scripts: [],
      includeGitDiffCheck: false,
      policy: strictPolicy,
    });

    const check = report.commands.find((command) => command.name === 'policy-dependency-check');
    expect(check?.exitCode).toBe(0);
  });

  it('adds no policy results when no policy is provided', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ private: true, scripts: {}, dependencies: { 'left-pad': '1.3.0' } }),
    );

    const report = await verifier().verify({
      workspacePath: cwd,
      scripts: [],
      includeGitDiffCheck: false,
    });

    expect(
      report.commands.find((command) => command.name === 'policy-dependency-check'),
    ).toBeUndefined();
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
