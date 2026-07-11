import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  VerificationReportSchema,
  type VerificationCommandResult,
  type VerificationReport,
} from '@agent-foundry/contracts';
import type { VerificationService } from '@agent-foundry/domain';

const EMPTY_GIT_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface WorkspaceVerifierOptions {
  autoInstallDependencies: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export class WorkspaceVerifier implements VerificationService {
  constructor(private readonly options: WorkspaceVerifierOptions) {}

  async verify(input: {
    workspacePath: string;
    scripts: string[];
    includeGitDiffCheck: boolean;
  }): Promise<VerificationReport> {
    const packageManager = await detectPackageManager(input.workspacePath);
    const commands: VerificationCommandResult[] = [];
    const packageJson = await readPackageJson(input.workspacePath);

    if (!packageJson) {
      return VerificationReportSchema.parse({
        schemaVersion: '1',
        approved: false,
        packageManager,
        summary: 'No package.json exists in the generated workspace.',
        commands: [],
        createdAt: new Date().toISOString(),
      });
    }

    if (
      this.options.autoInstallDependencies &&
      !(await pathExists(join(input.workspacePath, 'node_modules')))
    ) {
      commands.push(await this.runInstall(packageManager, input.workspacePath));
    }

    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    for (const script of input.scripts) {
      if (typeof scripts[script] !== 'string') {
        commands.push({
          name: script,
          command: packageManager,
          args: [],
          exitCode: 1,
          durationMs: 0,
          stdout: '',
          stderr: `Required package.json script is missing: ${script}`,
          skipped: false,
        });
        continue;
      }
      commands.push(await this.runScript(packageManager, script, input.workspacePath));
    }

    if (input.includeGitDiffCheck) {
      commands.push(
        await this.run(
          'git-committed-tree-check',
          'git',
          ['diff', '--check', EMPTY_GIT_TREE, 'HEAD'],
          input.workspacePath,
        ),
      );
      commands.push(
        await this.run(
          'git-working-tree-check',
          'git',
          ['diff', '--check', 'HEAD'],
          input.workspacePath,
        ),
      );
    }

    const failed = commands.filter((command) => !command.skipped && command.exitCode !== 0);
    return VerificationReportSchema.parse({
      schemaVersion: '1',
      approved: failed.length === 0,
      packageManager,
      summary:
        failed.length === 0
          ? 'All configured deterministic checks passed.'
          : `${failed.length} configured check(s) failed: ${failed.map((item) => item.name).join(', ')}`,
      commands,
      createdAt: new Date().toISOString(),
    });
  }

  private async runInstall(
    packageManager: VerificationReport['packageManager'],
    cwd: string,
  ): Promise<VerificationCommandResult> {
    switch (packageManager) {
      case 'pnpm':
        return this.run('install', 'pnpm', ['install', '--frozen-lockfile=false'], cwd);
      case 'yarn':
        return this.run('install', 'yarn', ['install'], cwd);
      case 'bun':
        return this.run('install', 'bun', ['install'], cwd);
      case 'npm':
      case 'unknown':
        return this.run('install', 'npm', ['install'], cwd);
    }
  }

  private async runScript(
    packageManager: VerificationReport['packageManager'],
    script: string,
    cwd: string,
  ): Promise<VerificationCommandResult> {
    switch (packageManager) {
      case 'pnpm':
        return this.run(script, 'pnpm', ['run', script], cwd);
      case 'yarn':
        return this.run(script, 'yarn', [script], cwd);
      case 'bun':
        return this.run(script, 'bun', ['run', script], cwd);
      case 'npm':
      case 'unknown':
        return this.run(script, 'npm', ['run', script], cwd);
    }
  }

  private async run(
    name: string,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<VerificationCommandResult> {
    const startedAt = Date.now();
    try {
      const result = await execa(command, args, {
        cwd,
        timeout: this.options.timeoutMs,
        maxBuffer: this.options.maxOutputBytes,
        reject: false,
      });
      return {
        name,
        command,
        args,
        exitCode: result.exitCode ?? 1,
        durationMs: Date.now() - startedAt,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        skipped: false,
      };
    } catch (error) {
      return {
        name,
        command,
        args,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        skipped: false,
      };
    }
  }
}

async function detectPackageManager(cwd: string): Promise<VerificationReport['packageManager']> {
  if (await pathExists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(join(cwd, 'yarn.lock'))) return 'yarn';
  if ((await pathExists(join(cwd, 'bun.lockb'))) || (await pathExists(join(cwd, 'bun.lock'))))
    return 'bun';
  if (await pathExists(join(cwd, 'package-lock.json'))) return 'npm';
  return 'npm';
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
