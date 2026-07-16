import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  PreviewCommandPlanSchema,
  type PackageManager,
  type PreviewCommandPlan,
  type PreviewCommandResult,
  type ProjectPolicy,
} from '@agent-foundry/contracts';
import { detectPackageManager, scriptCommand } from './package-manager.js';

/**
 * Plans install/build/dev commands for a workspace without executing
 * anything. A missing script, a policy-blocked script, or an undetectable
 * package manager produces a diagnostic PreviewCommandResult rather than
 * guessing a shell command.
 */
export async function resolvePreviewCommandPlan(
  workspacePath: string,
  policy?: ProjectPolicy,
): Promise<PreviewCommandPlan> {
  const packageManager = await detectPackageManager(workspacePath);
  const packageJson = await readPackageJson(workspacePath);
  const scripts = isRecord(packageJson?.scripts)
    ? (packageJson.scripts as Record<string, unknown>)
    : {};
  const devDefault = typeof scripts.dev === 'string' ? 'dev' : 'start';

  return PreviewCommandPlanSchema.parse({
    packageManager,
    install: resolveInstall(packageManager),
    build: resolveScript(
      packageManager,
      'build',
      policy?.previewCommands?.build ?? 'build',
      scripts,
      policy,
    ),
    dev: resolveScript(packageManager, 'dev', policy?.previewCommands?.dev ?? devDefault, scripts, policy),
    detectedAt: new Date().toISOString(),
  });
}

function resolveInstall(packageManager: PackageManager): PreviewCommandResult {
  switch (packageManager) {
    case 'npm':
      return { ok: true, command: 'npm', args: ['ci'] };
    case 'pnpm':
      return { ok: true, command: 'pnpm', args: ['install', '--frozen-lockfile'] };
    case 'yarn':
      return { ok: true, command: 'yarn', args: ['install', '--frozen-lockfile'] };
    case 'bun':
      return { ok: true, command: 'bun', args: ['install', '--frozen-lockfile'] };
    case 'unknown':
      return {
        ok: false,
        reason:
          'No supported lockfile or packageManager field found; cannot pick a reproducible install command.',
      };
  }
}

function resolveScript(
  packageManager: PackageManager,
  role: 'build' | 'dev',
  scriptName: string,
  scripts: Record<string, unknown>,
  policy?: ProjectPolicy,
): PreviewCommandResult {
  if (policy?.allowedCommands && !policy.allowedCommands.includes(scriptName)) {
    return {
      ok: false,
      reason: `Script '${scriptName}' is not allowed by policy ${policy.id}@v${policy.version}.`,
    };
  }
  if (typeof scripts[scriptName] !== 'string') {
    return {
      ok: false,
      reason: `package.json is missing a '${scriptName}' script required for ${role}.`,
    };
  }
  return { ok: true, ...scriptCommand(packageManager, scriptName) };
}

export interface PreviewInstallOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  versions?: { node: string; packageManager?: string };
}

/** Executes the plan's reproducible install command; never falls back to a different command. */
export async function runReproducibleInstall(
  plan: PreviewCommandPlan,
  cwd: string,
  options: { timeoutMs: number; maxOutputBytes: number },
): Promise<PreviewInstallOutcome> {
  if (!plan.install.ok) {
    return { ok: false, exitCode: 1, stdout: '', stderr: plan.install.reason };
  }
  try {
    const result = await execa(plan.install.command, plan.install.args, {
      cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      reject: false,
    });
    const exitCode = result.exitCode ?? 1;
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      versions: exitCode === 0 ? await probeVersions(plan.install.command) : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeVersions(
  packageManagerCommand: string,
): Promise<{ node: string; packageManager?: string }> {
  try {
    const { stdout } = await execa(packageManagerCommand, ['--version']);
    return { node: process.version, packageManager: stdout.trim() };
  } catch {
    return { node: process.version };
  }
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
