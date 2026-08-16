import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('skips an optional script the project has not defined yet', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: { typecheck: 'node -e ""' },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    }).verify({
      workspacePath: cwd,
      scripts: ['typecheck'],
      optionalScripts: ['lint', 'test'],
      includeGitDiffCheck: false,
    });

    expect(report.approved).toBe(true);
    for (const name of ['lint', 'test']) {
      expect(report.commands.find((command) => command.name === name)).toMatchObject({
        skipped: true,
        skipReason: expect.stringContaining('not defined'),
      });
    }
  });

  it('gates on an optional script once the project defines it', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: { lint: 'node -e "process.exit(1)"' },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    }).verify({
      workspacePath: cwd,
      scripts: [],
      optionalScripts: ['lint'],
      includeGitDiffCheck: false,
    });

    expect(report.approved).toBe(false);
    expect(report.commands.find((command) => command.name === 'lint')).toMatchObject({
      skipped: false,
      exitCode: 1,
    });
  });

  it('runs required scripts before optional scripts in the declared pre-optional seam', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: {
          required: "node -e \"require('fs').appendFileSync('order', 'required')\"",
          before: "node -e \"require('fs').appendFileSync('order', 'before')\"",
          optional: "node -e \"require('fs').appendFileSync('order', 'optional')\"",
        },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    }).verify({
      workspacePath: cwd,
      scripts: ['required'],
      beforeOptionalScripts: ['before'],
      optionalScripts: ['optional'],
      includeGitDiffCheck: false,
    });

    expect(report.approved).toBe(true);
    expect(await readFile(join(cwd, 'order'), 'utf8')).toBe('requiredbeforeoptional');
  });

  it('runs the auto-fix pre-pass before the checks without letting it gate', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: {
          format: "node -e \"require('fs').writeFileSync('formatted', '')\"",
          'lint:fix': 'node -e "process.exit(1)"',
          // Red unless the formatter ran first: the check reads what it wrote.
          typecheck: "node -e \"require('fs').readFileSync('formatted')\"",
        },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    }).verify({
      workspacePath: cwd,
      scripts: ['typecheck'],
      autofixScripts: ['format', 'lint:fix'],
      includeGitDiffCheck: false,
    });

    // `lint:fix` exited non-zero and the report is still green: an auto-fix
    // pass is not a check, so a machine-unfixable failure is the only thing
    // that reaches repair.
    expect(report.approved).toBe(true);
    expect(report.commands.find((command) => command.name === 'lint:fix')).toMatchObject({
      advisory: true,
      exitCode: 1,
    });
    expect(report.commands.find((command) => command.name === 'typecheck')).toMatchObject({
      advisory: false,
      exitCode: 0,
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

  it('classifies a command killed by the timeout and names the limit in stderr', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: { build: 'node -e "setTimeout(() => {}, 60_000)"' },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 1_000,
      maxOutputBytes: 1_000_000,
    }).verify({ workspacePath: cwd, scripts: ['build'], includeGitDiffCheck: false });

    expect(report.approved).toBe(false);
    const build = report.commands.find((command) => command.name === 'build');
    expect(build?.failureKind).toBe('timeout');
    expect(build?.exitCode).not.toBe(0);
    expect(build?.stderr).toContain('1000ms');
    expect(build?.stderr).toContain('never ran to completion');
  });

  it('classifies a plain non-zero exit as a real defect and leaves its stderr alone', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: { build: 'node -e "console.error(\'type error\'); process.exit(1)"' },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    }).verify({ workspacePath: cwd, scripts: ['build'], includeGitDiffCheck: false });

    const build = report.commands.find((command) => command.name === 'build');
    expect(build?.failureKind).toBe('check');
    expect(build?.stderr).toContain('type error');
    expect(build?.stderr).not.toContain('never ran to completion');
  });

  it('leaves failureKind unset when the command succeeds', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: { build: 'node -e ""' },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    }).verify({ workspacePath: cwd, scripts: ['build'], includeGitDiffCheck: false });

    expect(report.approved).toBe(true);
    expect(
      report.commands.find((command) => command.name === 'build')?.failureKind,
    ).toBeUndefined();
  });

  it('classifies output that overran the buffer instead of reporting it green', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: { build: 'node -e "console.log(\'x\'.repeat(50_000))"' },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 30_000,
      maxOutputBytes: 16,
    }).verify({ workspacePath: cwd, scripts: ['build'], includeGitDiffCheck: false });

    const build = report.commands.find((command) => command.name === 'build');
    expect(build?.failureKind).toBe('max-output');
    expect(build?.exitCode).not.toBe(0);
    expect(build?.stderr).toContain('16');
    expect(report.approved).toBe(false);
  });

  it('classifies a heap exhaustion as out-of-memory rather than a defect', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: 'npm@10',
        scripts: {
          build:
            'node -e "console.error(\'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\'); process.exit(134)"',
        },
      }),
    );

    const report = await new WorkspaceVerifier({
      autoInstallDependencies: false,
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    }).verify({ workspacePath: cwd, scripts: ['build'], includeGitDiffCheck: false });

    const build = report.commands.find((command) => command.name === 'build');
    expect(build?.failureKind).toBe('out-of-memory');
    expect(build?.stderr).toContain('never ran to completion');
    expect(report.approved).toBe(false);
  });

  it('records the commit the report was produced over', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ private: true, packageManager: 'npm@10', scripts: {} }),
    );
    await execa('git', ['add', '-A'], { cwd });
    await execa('git', ['commit', '-m', 'initial'], { cwd });
    const { stdout: head } = await execa('git', ['rev-parse', 'HEAD'], { cwd });

    const report = await verifier().verify({
      workspacePath: cwd,
      scripts: [],
      includeGitDiffCheck: false,
    });

    expect(report.commit).toBe(head.trim());
  });

  it('omits the commit when the workspace is not a git repository', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-foundry-verifier-nogit-'));
    temporaryDirectories.push(cwd);
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ private: true, packageManager: 'npm@10', scripts: {} }),
    );

    const report = await verifier().verify({
      workspacePath: cwd,
      scripts: [],
      includeGitDiffCheck: false,
    });

    expect(report.commit).toBeUndefined();
    expect(report.approved).toBe(true);
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
