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
  commandCheck('codex', ['--version'], realMode),
  commandCheck('claude', ['--version'], realMode),
  commandCheck('agy', ['--version'], realMode, { minimumVersion: '1.1.1' }),
  fileCheck('harness manifest', resolve(root, env.HARNESS_DIR ?? 'harness', 'manifest.json'), true),
  fileCheck('workflow directory', resolve(root, env.WORKFLOWS_DIR ?? 'workflows'), true),
  fileCheck('model catalog', resolve(root, env.MODEL_CATALOG_PATH ?? 'models/catalog.yaml'), true),
];

console.log(`Agent Foundry doctor · executor mode: ${executorMode}\n`);
for (const check of checks) {
  const icon = check.ok ? '✓' : check.required ? '✗' : '·';
  console.log(`${icon} ${check.name.padEnd(20)} ${check.message}`);
}

const failures = checks.filter((check) => check.required && !check.ok);
if (failures.length > 0) {
  console.error(`\n${failures.length} required check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(
    '\nEnvironment is ready. In real mode, authenticate each CLI interactively before starting the worker.',
  );
}

function commandCheck(command, args, required, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
  const output = (result.stdout || result.stderr || '').trim().split('\n')[0];
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
