import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const doctorPath = resolve('scripts/doctor.mjs');

const readyFixtures = {
  codex: {
    version: { stdout: 'codex-cli 0.144.2\n' },
    help: {
      stdout:
        '--json --ephemeral --color --output-last-message --skip-git-repo-check --model --sandbox\n',
    },
    auth: { stderr: 'Logged in using ChatGPT\n' },
  },
  claude: {
    version: { stdout: '2.1.207 (Claude Code)\n' },
    help: {
      stdout:
        '--safe-mode --print --verbose --output-format --no-session-persistence --prompt-suggestions --json-schema --model --permission-mode\n',
    },
    auth: {
      stdout: JSON.stringify({
        loggedIn: true,
        email: 'private@example.test',
        orgId: 'private-org',
      }),
    },
  },
};

test('prints ready provider probes as contract-shaped JSON without raw authentication data', async (t) => {
  const fixture = await createFixture(t, readyFixtures);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.executorMode, 'real');
  assert.deepEqual(output.probes, [
    readyProbe('codex', '0.144.2', 'Codex is ready.'),
    readyProbe('claude', '2.1.207', 'Claude is ready.'),
  ]);
  assert.deepEqual(Object.keys(output.probes[0]).sort(), [
    'capabilities',
    'message',
    'provider',
    'status',
    'version',
  ]);
  assert.match(output.sourceRevision, /^[0-9a-f]{40}$/);
  assert.doesNotMatch(result.stdout, /private@example\.test|private-org|Logged in using ChatGPT/);
  assert.deepEqual(
    output.checks
      .filter(({ name }) =>
        ['harness manifest', 'workflow directory', 'model catalog'].includes(name),
      )
      .map(({ message }) => message),
    ['harness/manifest.json', 'workflows', 'models/catalog.yaml'],
  );
  assert.equal(result.stdout.includes(fixture.root), false);
  assert.doesNotMatch(result.stdout, /private-user/);
});

test('classifies missing provider CLIs as unavailable', async (t) => {
  const fixture = await createFixture(t, {});
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const { probes } = JSON.parse(result.stdout);
  assert.deepEqual(
    probes.map(({ provider, status, capabilities }) => ({ provider, status, capabilities })),
    ['codex', 'claude'].map((provider) => ({
      provider,
      status: 'unavailable',
      capabilities: {
        nonInteractive: false,
        modelSelection: false,
        sandbox: false,
      },
    })),
  );
  assertNoModelInvocation(fixture);
});

test('blocks a missing Docker daemon without invoking a model', async (t) => {
  const fixture = await createFixture(t, readyFixtures);
  assert.equal(runDoctor(fixture, ['--json']).status, 0);
  await rm(join(fixture.bin, 'docker'));

  const result = runDoctor(fixture, ['--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).checks.find(({ name }) => name === 'docker').ok, false);
  assertNoModelInvocation(fixture);
});

test('reruns preflight when a provider session changes without a new source revision', async (t) => {
  const fixture = await createFixture(t, readyFixtures);
  assert.equal(runDoctor(fixture, ['--json']).status, 0);
  await writeFile(
    join(fixture.root, 'provider-fixtures.json'),
    JSON.stringify({
      ...readyFixtures,
      codex: { ...readyFixtures.codex, auth: { stdout: 'Not logged in\n' } },
    }),
  );

  assert.equal(runDoctor(fixture, ['--json']).status, 1, 'same revision reruns checks');
  assertNoModelInvocation(fixture);
});

for (const [label, degrade] of [
  ['srt', (fixture) => rm(join(fixture.bin, 'srt'))],
  ['model catalog', (fixture) => rm(join(fixture.root, 'models', 'catalog.yaml'))],
]) {
  test(`blocks a lost ${label} after a green preflight without invoking a model`, async (t) => {
    const fixture = await createFixture(t, readyFixtures);
    assert.equal(runDoctor(fixture, ['--json']).status, 0);
    await degrade(fixture);

    assert.equal(runDoctor(fixture, ['--json']).status, 1);
    assertNoModelInvocation(fixture);
  });
}

test('fails real mode when srt (the sandbox wrapper #637 spawns instead of codex) is missing, even with Codex itself ready', async (t) => {
  const fixture = await createFixture(t, readyFixtures);
  await rm(join(fixture.bin, 'srt'));
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const srtCheck = output.checks.find(({ name }) => name === 'srt');
  assert.deepEqual(srtCheck, {
    name: 'srt',
    ok: false,
    required: true,
    message: 'install srt (@anthropic-ai/sandbox-runtime) and retry',
  });
  // The Codex provider probe itself still reports ready — health() (not
  // doctor's own probe) is what CodexCliExecutor uses to combine the two;
  // doctor surfaces srt as its own independent required check instead.
  const codexProbe = output.probes.find(({ provider }) => provider === 'codex');
  assert.equal(codexProbe.status, 'ready');
});

test('does not require srt in mock mode', async (t) => {
  const fixture = await createFixture(t, {});
  await rm(join(fixture.bin, 'srt'));
  const result = runDoctor(fixture, ['--json'], { EXECUTOR_MODE: 'mock' });

  assert.equal(result.status, 0, result.stderr);
  const srtCheck = JSON.parse(result.stdout).checks.find(({ name }) => name === 'srt');
  assert.deepEqual(srtCheck, {
    name: 'srt',
    ok: false,
    required: false,
    message: 'not installed; acceptable in mock mode',
  });
});

test('classifies providers with absent sessions as unauthenticated', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.codex.auth = { stderr: 'Not logged in\n' };
  providers.claude.auth = { stdout: JSON.stringify({ loggedIn: false, email: 'secret@test' }) };
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  assert.deepEqual(
    JSON.parse(result.stdout).probes.map(({ status }) => status),
    ['unauthenticated', 'unauthenticated'],
  );
  assert.deepEqual(
    JSON.parse(result.stdout).probes.map(({ message }) => message),
    ['run codex login and retry.', 'run claude auth login and retry.'],
  );
  assert.doesNotMatch(result.stdout + result.stderr, /secret@test|private-user|Not logged in/);
  assertNoModelInvocation(fixture);
});

test('reports individual incompatible capabilities when required flags disappear', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.codex.help.stdout = '--model --sandbox --ask-for-approval\n';
  providers.claude.help.stdout = '--print --output-format --model\n';
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const { probes } = JSON.parse(result.stdout);
  assert.deepEqual(
    probes.map(({ status }) => status),
    ['incompatible', 'incompatible'],
  );
  assert.deepEqual(probes[0].capabilities, {
    nonInteractive: false,
    modelSelection: true,
    sandbox: true,
  });
  assert.deepEqual(probes[1].capabilities, {
    nonInteractive: false,
    modelSelection: true,
    sandbox: false,
  });
});

test('rejects providers missing execution flags outside the representative capability labels', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.codex.help.stdout = providers.codex.help.stdout.replace('--ephemeral ', '');
  providers.claude.help.stdout = providers.claude.help.stdout.replace(
    '--no-session-persistence ',
    '',
  );
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  assert.deepEqual(
    JSON.parse(result.stdout).probes.map(({ status }) => status),
    ['incompatible', 'incompatible'],
  );
});

test('requires exact help option tokens instead of accepting longer prefix collisions', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.codex.help.stdout = '--json-lines --model-directory --sandbox-policy\n';
  providers.claude.help.stdout =
    '--print-timeout --output-formatting --model-directory --permission-mode-name\n';
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const { probes } = JSON.parse(result.stdout);
  assert.deepEqual(
    probes.map(({ status }) => status),
    ['incompatible', 'incompatible'],
  );
  assert.deepEqual(
    probes.map(({ capabilities }) => capabilities),
    ['codex', 'claude'].map(() => ({
      nonInteractive: false,
      modelSelection: false,
      sandbox: false,
    })),
  );
});

test('fails closed on successful but malformed authentication responses', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.codex.auth = { stdout: 'session for codex-secret-user\n' };
  providers.claude.auth = { stdout: '{"email":"claude-secret@test"' };
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  assert.deepEqual(
    JSON.parse(result.stdout).probes.map(({ status }) => status),
    ['incompatible', 'incompatible'],
  );
  assert.doesNotMatch(result.stdout + result.stderr, /codex-secret-user|claude-secret@test/);
});

test('rejects deceptive successful Codex authentication near-matches', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.codex.auth = { stdout: 'Unable to determine whether user is logged in\n' };
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const probes = JSON.parse(result.stdout).probes;
  assert.equal(probes.find(({ provider }) => provider === 'codex').status, 'incompatible');
  assert.doesNotMatch(result.stdout + result.stderr, /Unable to determine/);
});

test('classifies unrecognized nonzero authentication failures as incompatible', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.codex.auth = { status: 2, stderr: 'unknown subcommand for codex-private-user\n' };
  providers.claude.auth = { status: 2, stderr: 'unknown subcommand for claude-private-user\n' };
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  assert.deepEqual(
    JSON.parse(result.stdout).probes.map(({ status }) => status),
    ['incompatible', 'incompatible'],
  );
  assert.doesNotMatch(result.stdout + result.stderr, /private-user|unknown subcommand/);
});

test('classifies signaled authentication probe crashes as incompatible', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.claude.auth = { signal: 'SIGTERM' };
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const probe = JSON.parse(result.stdout).probes.find(({ provider }) => provider === 'claude');
  assert.equal(probe.status, 'incompatible');
  assert.equal(probe.message, 'Claude returned an unrecognized authentication response.');
});

test('classifies timed-out authentication probes as incompatible', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.codex.auth = { hang: true };
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const probe = JSON.parse(result.stdout).probes.find(({ provider }) => provider === 'codex');
  assert.equal(probe.status, 'incompatible');
  assert.equal(probe.message, 'Codex returned an unrecognized authentication response.');
});

test('keeps human mock mode non-provider checks and makes missing providers optional', async (t) => {
  const fixture = await createFixture(t, {});
  const result = runDoctor(fixture, [], { EXECUTOR_MODE: 'mock' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent Foundry doctor · executor mode: mock/);
  assert.match(result.stdout, /✓ node\s+v\d+/);
  assert.match(result.stdout, /✓ git\s+git version/);
  assert.match(result.stdout, /✓ harness manifest/);
  assert.match(result.stdout, /✓ workflow directory/);
  assert.match(result.stdout, /✓ model catalog/);
  assert.match(result.stdout, new RegExp(escapeRegExp(fixture.root)));
  assert.match(result.stdout, /· codex\s+Codex CLI is unavailable\./);
  assert.match(result.stdout, /Environment is ready\./);
});

test('redacts existing and missing filesystem paths from JSON checks', async (t) => {
  const fixture = await createFixture(t, readyFixtures);
  await rm(join(fixture.root, 'models', 'catalog.yaml'));
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.checks
      .filter(({ name }) =>
        ['harness manifest', 'workflow directory', 'model catalog'].includes(name),
      )
      .map(({ message }) => message),
    ['harness/manifest.json', 'workflows', 'restore models/catalog.yaml and retry'],
  );
  assert.equal(result.stdout.includes(fixture.root), false);
  assert.doesNotMatch(result.stdout, /private-user/);
});

test('derives configured-path remediations without exposing an external path', async (t) => {
  const fixture = await createFixture(t, readyFixtures);
  const result = runDoctor(fixture, ['--json'], {
    HARNESS_DIR: 'configured-harness',
    WORKFLOWS_DIR: 'configured-workflows',
    MODEL_CATALOG_PATH: '/private/configured-catalog.yaml',
  });

  assert.equal(result.status, 1);
  assert.deepEqual(
    JSON.parse(result.stdout)
      .checks.filter(({ name }) =>
        ['harness manifest', 'workflow directory', 'model catalog'].includes(name),
      )
      .map(({ message }) => message),
    [
      'restore configured-harness/manifest.json and retry',
      'restore configured-workflows and retry',
      'restore [outside workspace] and retry',
    ],
  );
  assert.doesNotMatch(result.stdout, /private\/configured-catalog\.yaml/);
});

test('redacts an existing externally configured catalog from human output', async (t) => {
  const fixture = await createFixture(t, readyFixtures);
  const catalogRoot = await mkdtemp(join(tmpdir(), 'agent-foundry-external-catalog-'));
  const catalog = join(catalogRoot, 'catalog.yaml');
  t.after(() => rm(catalogRoot, { recursive: true, force: true }));
  await writeFile(catalog, 'models: []\n');

  const result = runDoctor(fixture, [], { MODEL_CATALOG_PATH: catalog });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ model catalog\s+\[outside workspace\]/);
  assert.equal(result.stdout.includes(catalog), false);
});

test('prints sanitized human provider status without auth payloads or identities', async (t) => {
  const fixture = await createFixture(t, readyFixtures);
  const result = runDoctor(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ codex\s+Codex is ready\./);
  assert.match(result.stdout, /✓ claude\s+Claude is ready\./);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /private@example\.test|private-org|Logged in using ChatGPT|Gemini 2\.5/,
  );
});

test('treats an unparseable installed CLI version as incompatible', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.claude.version.stdout = 'Claude Code development build\n';
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json']);

  assert.equal(result.status, 1);
  const probe = JSON.parse(result.stdout).probes.find(({ provider }) => provider === 'claude');
  assert.equal(probe.status, 'incompatible');
  assert.equal('version' in probe, false);
  assert.equal(probe.message, 'Claude version could not be parsed.');
});

test('scopes the probe environment to the spawn allowlist execution uses', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.claude.auth = { fromEnv: true };
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json'], {
    USER: 'doctor-probe-user',
    DOCTOR_LEAK_CANARY: 'control-plane-only',
  });

  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout).probes.find(({ provider }) => provider === 'claude');
  assert.equal(probe.status, 'ready');
});

test('reports unauthenticated when the identity variable is withheld from the probe env', async (t) => {
  const providers = structuredClone(readyFixtures);
  providers.claude.auth = { fromEnv: true };
  const fixture = await createFixture(t, providers);
  const result = runDoctor(fixture, ['--json'], { USER: undefined, LOGNAME: undefined });

  assert.equal(result.status, 1);
  const probe = JSON.parse(result.stdout).probes.find(({ provider }) => provider === 'claude');
  assert.equal(probe.status, 'unauthenticated');
  assert.equal(probe.message, 'run claude auth login and retry.');
});

function readyProbe(provider, version, message, extraCapabilities = {}) {
  return {
    provider,
    status: 'ready',
    version,
    capabilities: {
      nonInteractive: true,
      modelSelection: true,
      sandbox: true,
      ...extraCapabilities,
    },
    message,
  };
}

async function createFixture(t, providers) {
  const root = await mkdtemp(join(tmpdir(), 'agent-foundry-doctor-private-user-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  await writeFile(join(root, 'git-revision'), `${'a'.repeat(40)}\n`);
  await writeFile(
    join(bin, 'git'),
    "#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nconst args = process.argv.slice(2).join(' ');\nif (args === '--version') process.stdout.write('git version 2.50.1\\n');\nelse if (args === 'rev-parse HEAD') process.stdout.write(readFileSync('git-revision', 'utf8'));\nelse process.exitCode = 1;\n",
  );
  await chmod(join(bin, 'git'), 0o755);
  await writeFile(
    join(bin, 'docker'),
    "#!/usr/bin/env node\nif (process.argv.slice(2).join(' ') === 'info --format {{.ServerVersion}}') process.stdout.write('27.0.0\\n');\nelse process.exitCode = 1;\n",
  );
  await chmod(join(bin, 'docker'), 0o755);
  await writeFile(
    join(bin, 'fdesetup'),
    "#!/usr/bin/env node\nif (process.argv[2] === 'status') process.stdout.write('FileVault is On.\\n');\nelse process.exitCode = 1;\n",
  );
  await chmod(join(bin, 'fdesetup'), 0o755);
  // Present by default so every existing fixture exercises the ready path;
  // tests for the missing-wrapper case (#637) remove it after createFixture,
  // the same pattern the missing-catalog-file test below already uses.
  await writeFile(
    join(bin, 'srt'),
    "#!/usr/bin/env node\nif (process.argv[2] === '--version') { process.stdout.write('1.0.0\\n'); process.exit(0); }\nprocess.exit(1);\n",
  );
  await chmod(join(bin, 'srt'), 0o755);
  for (const path of ['harness', 'workflows', 'models']) await mkdir(join(root, path));
  await writeFile(join(root, 'harness', 'manifest.json'), '{}\n');
  await writeFile(join(root, 'models', 'catalog.yaml'), 'models: []\n');

  await writeFile(join(root, 'provider-fixtures.json'), JSON.stringify(providers));
  // Read from cwd, not an env var: the doctor scopes the probe env to the same
  // spawn allowlist execution uses, so nothing bespoke survives into the child.
  const fakeCli = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
const provider = basename(process.argv[1]);
const args = process.argv.slice(2);
const fixtures = JSON.parse(readFileSync('provider-fixtures.json', 'utf8'));
const fixture = fixtures[provider];
let command;
if (
  (provider === 'codex' && args[0] === 'exec' && args[1] !== '--help') ||
  (provider === 'claude' && args[0] === '--print')
) {
  appendFileSync('model-invocations', args.join(' ') + '\\n');
  process.exit(98);
} else if (args[0] === '--version') command = 'version';
else if (provider === 'codex' && args.join(' ') === 'exec --help') command = 'help';
else if (provider === 'codex' && args.join(' ') === 'login status') command = 'auth';
else if (provider === 'claude' && args.join(' ') === '--help') command = 'help';
else if (provider === 'claude' && args.join(' ') === 'auth status') command = 'auth';
else process.exit(97);
const response = fixture?.[command] ?? { status: 1 };
if (response.fromEnv) {
  // Logged in only when the allowlisted identity var arrived AND the parent's
  // non-allowlisted canary did not — both observable through the probe status.
  const loggedIn = Boolean(process.env.USER) && !process.env.DOCTOR_LEAK_CANARY;
  process.stdout.write(JSON.stringify({ loggedIn }));
  process.exit(0);
}
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
if (response.signal) {
  process.kill(process.pid, response.signal);
  setInterval(() => {}, 1_000);
} else if (response.hang) setInterval(() => {}, 1_000);
else process.exit(response.status ?? 0);
`;
  for (const provider of Object.keys(providers)) {
    const path = join(bin, provider);
    await writeFile(path, fakeCli);
    await chmod(path, 0o755);
  }

  return { root, bin };
}

function runDoctor(fixture, args = [], extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: fixture.bin,
    EXECUTOR_MODE: 'real',
    DATA_DIR: '.data',
    ...extraEnv,
  };
  // An explicit `undefined` withholds a variable the runner's own env may carry.
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync(process.execPath, [doctorPath, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    env,
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoModelInvocation(fixture) {
  assert.equal(existsSync(join(fixture.root, 'model-invocations')), false);
}
