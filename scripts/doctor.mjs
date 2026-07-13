import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const env = { ...readDotEnv(resolve(root, '.env')), ...process.env };
const executorMode = env.EXECUTOR_MODE ?? 'mock';
const realMode = executorMode === 'real';
const checks = [
  commandCheck('node', ['--version'], true, { minimumVersion: '22.0.0' }),
  commandCheck('git', ['--version'], true),
  fileCheck('harness manifest', resolve(root, env.HARNESS_DIR ?? 'harness', 'manifest.json'), true),
  fileCheck('workflow directory', resolve(root, env.WORKFLOWS_DIR ?? 'workflows'), true),
  fileCheck('model catalog', resolve(root, env.MODEL_CATALOG_PATH ?? 'models/catalog.yaml'), true),
];
const probes = [
  providerProbe({
    provider: 'codex',
    label: 'Codex',
    versionArgs: ['--version'],
    helpArgs: ['exec', '--help'],
    authArgs: ['login', 'status'],
    flags: {
      nonInteractive: ['--json'],
      modelSelection: ['--model'],
      sandbox: ['--sandbox'],
    },
    authenticationStatus(output) {
      if (/not logged in/i.test(output)) return false;
      if (/logged in/i.test(output)) return true;
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
      nonInteractive: ['--print', '--output-format'],
      modelSelection: ['--model'],
      sandbox: ['--permission-mode'],
    },
    authenticationStatus(output) {
      try {
        const { loggedIn } = JSON.parse(output);
        return typeof loggedIn === 'boolean' ? loggedIn : null;
      } catch {
        return null;
      }
    },
  }),
  providerProbe({
    provider: 'agy',
    label: 'AGY',
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    authArgs: ['models'],
    minimumVersion: '1.1.1',
    flags: {
      nonInteractive: ['--print', '--print-timeout'],
      modelSelection: ['--model'],
      sandbox: ['--sandbox', '--mode'],
    },
    authenticationStatus(output) {
      return /\([^()\s]+\)\s*$/m.test(output) ? true : null;
    },
  }),
];

const providerFailures = realMode ? probes.filter((probe) => probe.status !== 'ready') : [];
const failures = [...checks.filter((check) => check.required && !check.ok), ...providerFailures];

if (process.argv.slice(2).includes('--json')) {
  console.log(JSON.stringify({ executorMode, checks, probes }, null, 2));
} else {
  console.log(`Agent Foundry doctor · executor mode: ${executorMode}\n`);
  for (const check of checks) {
    const icon = check.ok ? '✓' : check.required ? '✗' : '·';
    console.log(`${icon} ${check.name.padEnd(20)} ${check.message}`);
  }
  for (const probe of probes) {
    const required = realMode;
    const icon = probe.status === 'ready' ? '✓' : required ? '✗' : '·';
    console.log(`${icon} ${probe.provider.padEnd(20)} ${probe.message}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} required check(s) failed.`);
  } else {
    console.log(
      '\nEnvironment is ready. In real mode, authenticate each CLI interactively before starting the worker.',
    );
  }
}

if (failures.length > 0) process.exitCode = 1;

function providerProbe(definition) {
  const versionResult = run(definition.provider, definition.versionArgs);
  if (versionResult.status !== 0) {
    return probeResult(definition, {
      status: 'unavailable',
      capabilities: emptyCapabilities(),
      message: `${definition.label} CLI is unavailable.`,
    });
  }

  const version = extractVersion(combinedOutput(versionResult));
  const helpResult = run(definition.provider, definition.helpArgs);
  const help = combinedOutput(helpResult);
  const capabilities = Object.fromEntries(
    Object.entries(definition.flags).map(([capability, flags]) => [
      capability,
      helpResult.status === 0 && flags.every((flag) => help.includes(flag)),
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
  const authenticationStatus =
    authResult.status === 0 ? definition.authenticationStatus(combinedOutput(authResult)) : false;
  if (authenticationStatus === false) {
    return probeResult(definition, {
      status: 'unauthenticated',
      version,
      capabilities,
      message: `${definition.label} is not authenticated.`,
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
  return spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
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
      message: required ? 'missing or not executable' : 'not installed; acceptable in mock mode',
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

function extractVersion(output) {
  return output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1];
}

function compareVersions(left, right) {
  const normalize = (value) => value.split(/[+-]/, 1)[0].split('.').map(Number);
  const a = normalize(left);
  const b = normalize(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function fileCheck(name, path, required) {
  const ok = existsSync(path);
  return { name, ok, required, message: ok ? path : `missing: ${path}` };
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
