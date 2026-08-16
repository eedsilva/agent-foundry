import { join } from 'node:path';
import { execa } from 'execa';
import {
  VerificationReportSchema,
  type PackageManager,
  type ProjectPolicy,
  type VerificationCommandResult,
  type VerificationReport,
} from '@agent-foundry/contracts';
import type { VerificationService } from '@agent-foundry/domain';
import { RunCancelledError } from '@agent-foundry/domain';
import {
  detectPackageManager,
  isRecord,
  pathExists,
  readPackageJsonAt,
  scriptCommand,
} from './package-manager.js';
import { terminateProcessTree } from './process-tree.js';

const EMPTY_GIT_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** How long a terminated group has to exit on SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 2_000;

/** V8's fatal out-of-memory prose, in both the forms it prints. */
const OUT_OF_MEMORY = /JavaScript heap out of memory|FATAL ERROR:.*Allocation failed/;

/** The run failing rather than the code. */
type InfrastructureFailure = Exclude<
  NonNullable<VerificationCommandResult['failureKind']>,
  'check'
>;

export interface WorkspaceVerifierOptions {
  autoInstallDependencies: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export class WorkspaceVerifier implements VerificationService {
  constructor(private readonly options: WorkspaceVerifierOptions) {}

  async verify(
    input: {
      workspacePath: string;
      scripts: string[];
      includeGitDiffCheck: boolean;
      autofixScripts?: string[] | undefined;
      beforeOptionalScripts?: string[] | undefined;
      optionalScripts?: string[] | undefined;
      environment?: Record<string, string> | undefined;
      policy?: ProjectPolicy | undefined;
    },
    signal?: AbortSignal,
  ): Promise<VerificationReport> {
    if (signal?.aborted) throw new RunCancelledError();
    const packageManager = await detectPackageManager(input.workspacePath);
    const commands: VerificationCommandResult[] = [];
    const packageJson = await readPackageJsonAt(input.workspacePath);
    const commit = await headCommit(input.workspacePath);

    if (!packageJson) {
      return VerificationReportSchema.parse({
        schemaVersion: '1',
        approved: false,
        packageManager,
        summary: 'No package.json exists in the generated workspace.',
        commands: [],
        createdAt: new Date().toISOString(),
        ...(commit ? { commit } : {}),
      });
    }

    if (
      this.options.autoInstallDependencies &&
      !(await pathExists(join(input.workspacePath, 'node_modules')))
    ) {
      commands.push(await this.runInstall(packageManager, input.workspacePath, signal));
    }

    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    // The auto-fix pre-pass runs first and never gates, so repair is only
    // asked for what a machine could not fix (#324).
    for (const script of input.autofixScripts ?? []) {
      if (signal?.aborted) throw new RunCancelledError();
      const result = await this.runConfigured(script, packageManager, scripts, input, true, signal);
      commands.push({ ...result, advisory: true });
    }
    for (const script of input.scripts) {
      if (signal?.aborted) throw new RunCancelledError();
      commands.push(
        await this.runConfigured(script, packageManager, scripts, input, false, signal),
      );
    }
    for (const script of input.beforeOptionalScripts ?? []) {
      if (signal?.aborted) throw new RunCancelledError();
      commands.push(
        await this.runConfigured(script, packageManager, scripts, input, false, signal),
      );
    }
    for (const script of input.optionalScripts ?? []) {
      if (signal?.aborted) throw new RunCancelledError();
      commands.push(await this.runConfigured(script, packageManager, scripts, input, true, signal));
    }

    if (input.policy) commands.push(dependencyPolicyCheck(input.policy, packageJson));

    if (input.includeGitDiffCheck) {
      if (signal?.aborted) throw new RunCancelledError();
      commands.push(
        await this.run(
          'git-committed-tree-check',
          'git',
          ['diff', '--check', EMPTY_GIT_TREE, 'HEAD'],
          input.workspacePath,
          signal,
        ),
      );
      commands.push(
        await this.run(
          'git-working-tree-check',
          'git',
          ['diff', '--check', 'HEAD'],
          input.workspacePath,
          signal,
        ),
      );
    }

    if (signal?.aborted) throw new RunCancelledError();

    const failed = commands.filter(
      (command) => !command.skipped && !command.advisory && command.exitCode !== 0,
    );
    // The kind rides along, so the timeline and the repair prompt lead with
    // "this build never finished" instead of burying it at the end of a
    // truncated stderr.
    const names = failed.map((item) =>
      item.failureKind && item.failureKind !== 'check'
        ? `${item.name} (${item.failureKind})`
        : item.name,
    );
    return VerificationReportSchema.parse({
      schemaVersion: '1',
      approved: failed.length === 0,
      packageManager,
      summary:
        failed.length === 0
          ? 'All configured deterministic checks passed.'
          : `${failed.length} configured check(s) failed: ${names.join(', ')}`,
      commands,
      createdAt: new Date().toISOString(),
      ...(commit ? { commit } : {}),
    });
  }

  /**
   * One configured script. `optional` decides what an undefined script means:
   * a required check the project never defined is a red report, an optional
   * one is simply a check this project does not have yet.
   */
  private async runConfigured(
    script: string,
    packageManager: PackageManager,
    scripts: Record<string, unknown>,
    input: {
      workspacePath: string;
      environment?: Record<string, string> | undefined;
      policy?: ProjectPolicy | undefined;
    },
    optional: boolean,
    signal?: AbortSignal,
  ): Promise<VerificationCommandResult> {
    if (input.policy?.allowedCommands && !input.policy.allowedCommands.includes(script)) {
      return syntheticResult(
        script,
        'policy',
        `Script '${script}' is not allowed by policy ${input.policy.id}@v${input.policy.version}.`,
      );
    }
    if (typeof scripts[script] !== 'string') {
      if (!optional) {
        return syntheticResult(
          script,
          packageManager,
          `Required package.json script is missing: ${script}`,
        );
      }
      return {
        ...syntheticResult(script, packageManager, '', 0),
        skipped: true,
        skipReason: `Script '${script}' is not defined in package.json.`,
      };
    }
    return this.runScript(packageManager, script, input.workspacePath, signal, input.environment);
  }

  private async runInstall(
    packageManager: PackageManager,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<VerificationCommandResult> {
    switch (packageManager) {
      case 'pnpm':
        return this.run('install', 'pnpm', ['install', '--frozen-lockfile=false'], cwd, signal);
      case 'yarn':
        return this.run('install', 'yarn', ['install'], cwd, signal);
      case 'bun':
        return this.run('install', 'bun', ['install'], cwd, signal);
      case 'npm':
        return this.run('install', 'npm', ['install'], cwd, signal);
      case 'unknown':
        return syntheticResult(
          'install',
          packageManager,
          'No supported lockfile or packageManager field found; cannot pick a reproducible install command.',
        );
    }
  }

  private async runScript(
    packageManager: PackageManager,
    script: string,
    cwd: string,
    signal?: AbortSignal,
    environment?: Record<string, string>,
  ): Promise<VerificationCommandResult> {
    if (packageManager === 'unknown') {
      return syntheticResult(
        script,
        packageManager,
        'No supported lockfile or packageManager field found; cannot pick a reproducible install command.',
      );
    }
    const { command, args } = scriptCommand(packageManager, script);
    return this.run(script, command, args, cwd, signal, environment);
  }

  private async run(
    name: string,
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    environment?: Record<string, string>,
  ): Promise<VerificationCommandResult> {
    const startedAt = Date.now();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const subprocess = execa(command, args, {
        cwd,
        maxBuffer: this.options.maxOutputBytes,
        reject: false,
        // Own process group on POSIX. A generated app's check is
        // `npm run build` -> `next build` -> Turbopack workers, and execa's own
        // `timeout` and `cancelSignal` signal the direct child only: the
        // descendants keep running with the pipes open, so the command never
        // settles and the leaked workers contend with the next build.
        detached: process.platform !== 'win32',
        ...(environment ? { env: { ...process.env, ...environment } } : {}),
      });
      const terminate = async (): Promise<void> => {
        await terminateProcessTree(subprocess, KILL_GRACE_MS);
        // A descendant that escaped the group could still hold the pipes open
        // after the group is gone; closing them lets the command settle.
        subprocess.stdout?.destroy();
        subprocess.stderr?.destroy();
      };
      timer = setTimeout(() => {
        timedOut = true;
        void terminate();
      }, this.options.timeoutMs);
      if (signal) {
        onAbort = () => void terminate();
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const result = await subprocess;
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const failureKind = classify(result, stderr, timedOut);
      return {
        name,
        command,
        args,
        // A failure always reports non-zero: execa reports a `maxBuffer`
        // overrun as failed with exit code 0, and a killed process with no
        // exit code at all. Either would otherwise land in the report as a pass.
        exitCode: failureKind ? result.exitCode || 1 : 0,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr:
          failureKind && failureKind !== 'check'
            ? this.diagnose(stderr, failureKind, result.signal)
            : stderr,
        skipped: false,
        advisory: false,
        ...(failureKind ? { failureKind } : {}),
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
        advisory: false,
        failureKind: 'spawn',
      };
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** One line the persisted log and the repair prompt both carry. */
  private diagnose(stderr: string, kind: InfrastructureFailure, signal?: string): string {
    const reason = {
      timeout: `killed after the ${this.options.timeoutMs}ms verification timeout`,
      'max-output': `killed after its output passed the ${this.options.maxOutputBytes} byte limit`,
      'out-of-memory': 'killed after running out of memory',
      signal: `terminated by ${signal ?? 'a signal'}`,
      spawn: 'could not be started',
    }[kind];
    const line = `${kind}: command ${reason} — it never ran to completion, so this result says nothing about the code.`;
    return `${[stderr.trimEnd(), line].filter(Boolean).join('\n')}\n`;
  }
}

function classify(
  result: {
    failed: boolean;
    isMaxBuffer: boolean;
    exitCode?: number | undefined;
    signal?: string | undefined;
  },
  stderr: string,
  timedOut: boolean,
): VerificationCommandResult['failureKind'] {
  if (!result.failed) return undefined;
  // Ours, not execa's: the deadline is enforced by terminating the process
  // group, which reaches the command as a signal rather than as `timedOut`.
  if (timedOut) return 'timeout';
  if (result.isMaxBuffer) return 'max-output';
  // ponytail: V8 prints this, it is not a machine-readable status, and 137 is
  // any SIGKILL rather than the OOM killer specifically. Only stderr is
  // scanned, so a check that merely prints the phrase stays a `check`; run the
  // build under a wrapper reporting rusage if that stops being enough.
  if (result.exitCode === 137 || OUT_OF_MEMORY.test(stderr)) return 'out-of-memory';
  if (result.exitCode === undefined) return result.signal ? 'signal' : 'spawn';
  return 'check';
}

/** The tree the report judged. Undefined outside a git repo or before the first commit. */
async function headCommit(cwd: string): Promise<string | undefined> {
  const result = await execa('git', ['rev-parse', 'HEAD'], { cwd, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

/** A check decided without running anything — policy blocks and missing scripts. */
function syntheticResult(
  name: string,
  command: string,
  stderr: string,
  exitCode = 1,
): VerificationCommandResult {
  return {
    name,
    command,
    args: [],
    exitCode,
    durationMs: 0,
    stdout: '',
    stderr,
    skipped: false,
    advisory: false,
  };
}

// ponytail: exact-name match over package.json manifests only; scan the
// lockfile for transitive dependencies if policy evasion ever matters.
function dependencyPolicyCheck(
  policy: ProjectPolicy,
  packageJson: Record<string, unknown>,
): VerificationCommandResult {
  const declared = ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((field) => {
    const section = packageJson[field];
    return isRecord(section) ? Object.keys(section) : [];
  });
  const violations = [
    ...new Set(declared.filter((name) => policy.forbiddenDependencies.includes(name))),
  ].sort();
  return syntheticResult(
    'policy-dependency-check',
    'policy',
    violations.length === 0
      ? ''
      : `Forbidden dependencies declared: ${violations.join(', ')} (policy ${policy.id}@v${policy.version}).`,
    violations.length === 0 ? 0 : 1,
  );
}
