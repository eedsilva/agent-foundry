import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
// The same list packages/executors/src/safe-environment.ts imports. The doctor
// must probe under the env a real execution gets, or it reports ready for a CLI
// that is unauthenticated the moment the orchestrator actually spawns it. Read
// as data, not code: the doctor has to work on an unbuilt tree.
import safeEnvAllowlist from '../packages/executors/src/safe-env-allowlist.json' with { type: 'json' };
import { fileVaultCheck, storageChecks } from './lib/environment-preflight.mjs';

const root = process.cwd();
const env = { ...readDotEnv(resolve(root, '.env')), ...process.env };
const probeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => safeEnvAllowlist.includes(key)),
);
const executorMode = env.EXECUTOR_MODE ?? 'mock';
const realMode = executorMode === 'real';
const dataDirectory = resolve(root, env.DATA_DIR ?? '.data');
const sourceRevision = sourceRevisionCheck();
const checks = [
  commandCheck('node', ['--version'], true, { minimumVersion: '22.0.0' }),
  commandCheck('git', ['--version'], true),
  sourceRevision,
  // `CodexCliExecutor` spawns `srt` (@anthropic-ai/sandbox-runtime), not
  // `codex`, as the real process in real mode (#637, docs/adr/0081) — the
  // `codex` probe below says nothing about whether the wrapper it actually
  // runs through is installed. Only required in real mode, same as the
  // provider probes: `srt` is never spawned in mock mode.
  commandCheck('srt', ['--version'], realMode, {
    missingMessage: 'install srt (@anthropic-ai/sandbox-runtime) and retry',
  }),
  fileCheck(
    'harness manifest',
    resolve(root, env.HARNESS_DIR ?? 'harness', 'manifest.json'),
    true,
    root,
    { missingMessage: 'restore harness/manifest.json and retry' },
  ),
  fileCheck('workflow directory', resolve(root, env.WORKFLOWS_DIR ?? 'workflows'), true, root, {
    missingMessage: 'restore workflows/ and retry',
  }),
  fileCheck(
    'model catalog',
    resolve(root, env.MODEL_CATALOG_PATH ?? 'models/catalog.yaml'),
    true,
    root,
    { missingMessage: 'restore models/catalog.yaml and retry' },
  ),
  commandCheck('docker', ['info', '--format', '{{.ServerVersion}}'], realMode, {
    missingMessage: 'start Docker Desktop and retry',
  }),
  ...storageChecks({ root, dataDirectory }),
  fileVaultCheck(process.platform, run),
];
const probes = await Promise.all([
  providerProbe({
    provider: 'codex',
    label: 'Codex',
    versionArgs: ['--version'],
    helpArgs: ['exec', '--help'],
    authArgs: ['login', 'status'],
    flags: {
      nonInteractive: [
        '--json',
        '--ephemeral',
        '--color',
        '--output-last-message',
        '--skip-git-repo-check',
      ],
      modelSelection: ['--model'],
      sandbox: ['--sandbox'],
    },
    authenticationStatus(result) {
      const output = combinedOutput(result).trim();
      if (/^Not logged in\.?$/i.test(output)) return false;
      if (result.status === 0 && /^Logged in(?: using (?:ChatGPT|an API key))?\.?$/i.test(output)) {
        return true;
      }
      return null;
    },
  }),
  providerProbe({
    provider: 'claude',
    label: 'Claude',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    authArgs: ['auth', 'status'],
    flags: {
      nonInteractive: [
        '--print',
        '--verbose',
        '--output-format',
        '--no-session-persistence',
        '--prompt-suggestions',
        '--json-schema',
      ],
      modelSelection: ['--model'],
      sandbox: ['--safe-mode', '--permission-mode'],
    },
    authenticationStatus(result) {
      try {
        const { loggedIn } = JSON.parse(result.stdout ?? '');
        if (loggedIn === false) return false;
        if (loggedIn === true && result.status === 0) return true;
        return null;
      } catch {
        return null;
      }
    },
  }),
]);

const providerFailures = realMode ? probes.filter((probe) => probe.status !== 'ready') : [];
const failures = [...checks.filter((check) => check.required && !check.ok), ...providerFailures];
const report = {
  schemaVersion: 1,
  sourceRevision: sourceRevision.revision,
  executorMode,
  checks,
  probes,
};
print(report);
if (failures.length > 0) process.exitCode = 1;

function print(report) {
  if (process.argv.slice(2).includes('--json')) {
    console.log(JSON.stringify({ ...report, checks: jsonChecks(report.checks) }, null, 2));
    return;
  }
  console.log(`Agent Foundry doctor · executor mode: ${executorMode}\n`);
  for (const check of report.checks) {
    const icon = check.ok ? '✓' : check.required ? '✗' : '·';
    console.log(`${icon} ${check.name.padEnd(20)} ${check.message}`);
  }
  for (const probe of report.probes) {
    const required = realMode;
    const icon = probe.status === 'ready' ? '✓' : required ? '✗' : '·';
    console.log(`${icon} ${probe.provider.padEnd(20)} ${probe.message}`);
  }

  const failures = [
    ...report.checks.filter((check) => check.required && !check.ok),
    ...(realMode ? report.probes.filter((probe) => probe.status !== 'ready') : []),
  ];
  if (failures.length > 0) {
    console.error(`\n${failures.length} required check(s) failed.`);
  } else {
    console.log(
      '\nEnvironment is ready. In real mode, authenticate each CLI interactively before starting the worker.',
    );
  }
}

async function providerProbe(definition) {
  const versionResult = run(definition.provider, definition.versionArgs);
  if (versionResult.status !== 0) {
    return probeResult(definition, {
      status: 'unavailable',
      capabilities: emptyCapabilities(),
      message: realMode
        ? `install ${definition.label} CLI and retry.`
        : `${definition.label} CLI is unavailable.`,
    });
  }

  const version = extractVersion(combinedOutput(versionResult));
  const helpResult = run(definition.provider, definition.helpArgs);
  const help = combinedOutput(helpResult);
  const optionTokens = new Set(help.match(/--[0-9A-Za-z][0-9A-Za-z-]*/g) ?? []);
  const capabilities = Object.fromEntries(
    Object.entries(definition.flags).map(([capability, flags]) => [
      capability,
      helpResult.status === 0 && flags.every((flag) => optionTokens.has(flag)),
    ]),
  );
  if (!version) {
    return probeResult(definition, {
      status: 'incompatible',
      capabilities,
      message: `${definition.label} version could not be parsed.`,
    });
  }
  if (definition.minimumVersion && compareVersions(version, definition.minimumVersion) < 0) {
    return probeResult(definition, {
      status: 'incompatible',
      version,
      capabilities,
      message: `${definition.label} ${version} is too old; ${definition.minimumVersion}+ is required.`,
    });
  }
  if (helpResult.status !== 0 || !Object.values(capabilities).every(Boolean)) {
    return probeResult(definition, {
      status: 'incompatible',
      version,
      capabilities,
      message: `${definition.label} CLI is missing required capability flags.`,
    });
  }

  const authResult = run(definition.provider, definition.authArgs);
  const authenticationStatus = definition.authenticationStatus(authResult);
  if (authenticationStatus === false) {
    return probeResult(definition, {
      status: 'unauthenticated',
      version,
      capabilities,
      message: `run ${definition.provider === 'codex' ? 'codex login' : 'claude auth login'} and retry.`,
    });
  }
  if (authenticationStatus !== true) {
    return probeResult(definition, {
      status: 'incompatible',
      version,
      capabilities,
      message: `${definition.label} returned an unrecognized authentication response.`,
    });
  }

  return probeResult(definition, {
    status: 'ready',
    version,
    capabilities,
    message: `${definition.label} is ready.`,
  });
}

function probeResult(definition, result) {
  return { provider: definition.provider, ...result };
}

function emptyCapabilities() {
  return { nonInteractive: false, modelSelection: false, sandbox: false };
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, env: probeEnv });
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

function commandCheck(command, args, required, options = {}) {
  const result = run(command, args);
  const output = combinedOutput(result).split('\n')[0];
  if (result.status !== 0) {
    return {
      name: command,
      ok: false,
      required,
      message: required
        ? (options.missingMessage ?? 'missing or not executable')
        : 'not installed; acceptable in mock mode',
    };
  }

  if (options.minimumVersion) {
    const actual = extractVersion(output);
    if (!actual) {
      return {
        name: command,
        ok: !required,
        required,
        message: required
          ? `version could not be parsed; ${options.minimumVersion}+ is required`
          : `${output || 'available'}; version not parsed`,
      };
    }
    if (compareVersions(actual, options.minimumVersion) < 0) {
      return {
        name: command,
        ok: false,
        required,
        message: `${actual} is too old; ${options.minimumVersion}+ is required`,
      };
    }
  }

  return { name: command, ok: true, required, message: output || 'available' };
}

function sourceRevisionCheck() {
  const result = run('git', ['rev-parse', 'HEAD']);
  const revision = combinedOutput(result).trim();
  if (result.status === 0 && /^[0-9a-f]{40}$/.test(revision)) {
    return { name: 'source revision', ok: true, required: true, message: revision, revision };
  }
  return {
    name: 'source revision',
    ok: false,
    required: true,
    message: 'could not read the current Git revision; commit or repair the checkout and retry',
  };
}

function extractVersion(output) {
  return output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1];
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return difference;
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function parseVersion(value) {
  const withoutBuild = value.split('+', 1)[0];
  const separator = withoutBuild.indexOf('-');
  const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
  const prerelease = separator === -1 ? [] : withoutBuild.slice(separator + 1).split('.');
  return { core: core.split('.').map(Number), prerelease };
}

function fileCheck(name, path, required, workspaceRoot, options = {}) {
  const ok = existsSync(path);
  const safePath = relativeCheckPath(workspaceRoot, path);
  return {
    name,
    ok,
    required,
    message: ok ? path : (options.missingMessage ?? `missing: ${path}`),
    jsonMessage: ok ? safePath : (options.missingMessage ?? `missing: ${safePath}`),
  };
}

function relativeCheckPath(workspaceRoot, path) {
  const relativePath = relative(workspaceRoot, path);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    return '[outside workspace]';
  }
  return relativePath || '.';
}

function jsonChecks(input) {
  return input.map(({ jsonMessage, ...check }) => ({
    ...check,
    message: jsonMessage ?? check.message,
  }));
}

function readDotEnv(path) {
  if (!existsSync(path)) return {};
  const output = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    output[line.slice(0, index).trim()] = line
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return output;
}
