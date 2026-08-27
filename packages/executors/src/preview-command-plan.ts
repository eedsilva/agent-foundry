import { execa } from 'execa';
import {
  PreviewCommandPlanSchema,
  type PackageManager,
  type PreviewCommandPlan,
  type PreviewCommandResult,
  type PreviewToolVersions,
  type ProjectPolicy,
} from '@agent-foundry/contracts';
import {
  detectPackageManager,
  isRecord,
  readPackageJsonAt,
  scriptCommand,
} from './package-manager.js';

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
  const packageJson = await readPackageJsonAt(workspacePath);
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
    dev: resolveScript(
      packageManager,
      'dev',
      policy?.previewCommands?.dev ?? devDefault,
      scripts,
      policy,
    ),
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
  if (packageManager === 'unknown') {
    return {
      ok: false,
      reason:
        'No supported lockfile or packageManager field found; cannot pick a reproducible install command.',
    };
  }
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
  versions?: PreviewToolVersions;
  /**
   * The install never ran: the container daemon was unreachable, or the
   * package manager the plan pins is not on this host. Set here, where the
   * cause is known, because a failed install alone does not say whether the
   * environment or the generated app is at fault (#659).
   */
  infrastructure?: boolean;
}

export interface PreviewInstaller {
  install(input: {
    plan: PreviewCommandPlan;
    workspacePath: string;
    signal?: AbortSignal;
  }): Promise<PreviewInstallOutcome>;
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
    const subprocess = execa(plan.install.command, plan.install.args, {
      cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      reject: false,
    });
    const result = await subprocess;
    // `reject: false` resolves even when the command never ran. The pid is
    // what says which happened: it exists as soon as the process does, and
    // never for a package manager missing from this host — an environment
    // fault, not a workspace the install rejected (#659). A missing exit code
    // cannot serve, because an install killed by a signal reports none either
    // and that one is not this host's fault to claim.
    const neverRan = subprocess.pid === undefined;
    const exitCode = result.exitCode ?? 1;
    const versions = exitCode === 0 ? await probeVersions(plan.install.command) : undefined;
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: result.stdout ?? '',
      // A command that never ran writes nothing to stderr, so its own
      // failure message is the only evidence of why (#658).
      stderr: result.stderr || (neverRan ? (result.shortMessage ?? '') : ''),
      ...(versions ? { versions } : {}),
      ...(neverRan ? { infrastructure: true } : {}),
    };
  } catch (error) {
    // execa only throws here when the command never ran — the package manager
    // is missing from this host, or is not executable. A package manager that
    // ran and rejected the workspace comes back as a non-zero exit above.
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      infrastructure: true,
    };
  }
}

async function probeVersions(packageManagerCommand: string): Promise<PreviewToolVersions> {
  try {
    const { stdout } = await execa(packageManagerCommand, ['--version']);
    return { node: process.version, packageManager: stdout.trim() };
  } catch {
    return { node: process.version };
  }
}
