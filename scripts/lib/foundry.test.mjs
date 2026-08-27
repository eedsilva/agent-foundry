import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultProjectName,
  formatEvent,
  normalizePrd,
  parseFoundryArgs,
  parseSseChunk,
  pendingApprovals,
  statusKind,
} from './foundry.mjs';

describe('parseFoundryArgs', () => {
  it('joins positional words into the prompt and applies defaults', () => {
    const parsed = parseFoundryArgs(['quero', 'um', 'app', 'de', 'receitas']);
    assert.equal(parsed.prompt, 'quero um app de receitas');
    assert.equal(parsed.apiUrl, 'http://localhost:4000');
    assert.equal(parsed.open, true);
    assert.equal(parsed.help, false);
  });

  it('accepts --name, --api and --no-open flags anywhere', () => {
    const parsed = parseFoundryArgs([
      '--name',
      'Receitas',
      'um app',
      '--api',
      'http://localhost:5000',
      '--no-open',
    ]);
    assert.equal(parsed.prompt, 'um app');
    assert.equal(parsed.name, 'Receitas');
    assert.equal(parsed.apiUrl, 'http://localhost:5000');
    assert.equal(parsed.open, false);
  });

  it('flags help and tolerates a missing prompt for it', () => {
    assert.equal(parseFoundryArgs(['--help']).help, true);
    assert.equal(parseFoundryArgs([]).prompt, '');
  });
});

describe('normalizePrd', () => {
  it('passes an already long prompt through unchanged', () => {
    const long = 'x'.repeat(80);
    assert.equal(normalizePrd(long), long);
  });

  it('pads a short prompt to the 50-char PRD minimum, keeping the prompt text', () => {
    const prd = normalizePrd('app de receitas');
    assert.ok(prd.length >= 50);
    assert.ok(prd.includes('app de receitas'));
  });
});

describe('defaultProjectName', () => {
  it('uses the first words of the prompt', () => {
    assert.equal(
      defaultProjectName('quero um app de receitas com fotos e categorias'),
      'quero um app de receitas com',
    );
  });

  it('caps at 120 chars and falls back when empty', () => {
    assert.ok(defaultProjectName('x'.repeat(500)).length <= 120);
    assert.equal(defaultProjectName('   '), 'Foundry app');
  });
});

describe('formatEvent', () => {
  it('renders time, type and message on one line', () => {
    const line = formatEvent({
      type: 'agent.started',
      message: 'plan started on claude-haiku.',
      createdAt: '2026-08-07T12:00:01.000Z',
    });
    assert.ok(line.includes('agent.started'));
    assert.ok(line.includes('plan started on claude-haiku.'));
    assert.ok(!line.includes('\n'));
  });
});

describe('parseSseChunk', () => {
  it('extracts data payloads and ignores comments/heartbeats', () => {
    const { events, rest, lastId } = parseSseChunk(
      ': connected\n\nid: e1\ndata: {"type":"project.created"}\n\n: ping\n\nid: e2\ndata: {"ty',
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['project.created'],
    );
    assert.equal(lastId, 'e1');
    assert.ok(rest.includes('id: e2'));
  });

  it('carries an incomplete frame over and completes it with the next chunk', () => {
    const first = parseSseChunk('id: e2\ndata: {"ty');
    assert.equal(first.events.length, 0);
    // The resume cursor must not advance past an event that never fully arrived.
    assert.equal(first.lastId, undefined);
    const second = parseSseChunk(first.rest + 'pe":"node.completed"}\n\n');
    assert.deepEqual(
      second.events.map((event) => event.type),
      ['node.completed'],
    );
    assert.equal(second.lastId, 'e2');
    assert.equal(second.rest, '');
  });
});

describe('pendingApprovals', () => {
  it('keeps only requests without a decision', () => {
    const pending = pendingApprovals([
      { request: { id: 'a' }, decision: null },
      { request: { id: 'b' }, decision: { action: 'approve' } },
    ]);
    assert.deepEqual(
      pending.map((approval) => approval.id),
      ['a'],
    );
  });
});

describe('statusKind', () => {
  it('classifies the run statuses the journey reacts to', () => {
    assert.equal(statusKind('completed'), 'succeeded');
    assert.equal(statusKind('failed'), 'failed');
    assert.equal(statusKind('rejected'), 'failed');
    assert.equal(statusKind('cancelled'), 'cancelled');
    assert.equal(statusKind('awaiting_approval'), 'awaiting-approval');
    assert.equal(statusKind('running'), 'active');
    assert.equal(statusKind('queued'), 'active');
    assert.equal(statusKind('paused'), 'active');
  });
});

it('stops before booting the stack when environment preflight fails', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-foundry-preflight-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/foundry.ts', 'app de receitas'],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: dataDir, EXECUTOR_MODE: 'real', PATH: '/usr/bin:/bin' },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Preflight falhou/);
  assert.doesNotMatch(result.stdout + result.stderr, /subindo o stack/);
});

it('blocks Foundry for low storage before any model invocation', async (t) => {
  const fixture = await createPreflightFixture(t);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/foundry.ts', 'app de receitas'],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATA_DIR: fixture.dataDir,
        EXECUTOR_MODE: 'real',
        PATH: fixture.bin,
        NODE_OPTIONS: `--require=${fixture.statfsHook}`,
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /free at least/);
  assert.match(result.stdout + result.stderr, /Preflight falhou/);
  assert.equal(existsSync(fixture.modelInvocations), false);
  assert.doesNotMatch(result.stdout + result.stderr, /subindo o stack/);
});

async function createPreflightFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-foundry-foundry-storage-'));
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  const modelInvocations = join(root, 'model-invocations');
  const statfsHook = join(root, 'statfs-hook.cjs');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(bin);
  await Promise.all([mkdir(dataDir), symlink(process.execPath, join(bin, 'node'))]);
  await writeFile(
    statfsHook,
    "const fs = require('node:fs');\nfs.statfsSync = () => ({ bavail: 0n, bsize: 1n });\nrequire('node:module').syncBuiltinESMExports();\n",
  );
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node\nconst args = process.argv.slice(2).join(' ');\nif (args === '--version') process.stdout.write('git version 2.50.1\\n');\nelse if (args === 'rev-parse HEAD') process.stdout.write('${'a'.repeat(40)}\\n');\nelse process.exitCode = 1;\n`,
  );
  await writeFile(
    join(bin, 'docker'),
    "#!/usr/bin/env node\nif (process.argv.slice(2).join(' ') === 'info --format {{.ServerVersion}}') process.stdout.write('27.0.0\\n');\nelse process.exitCode = 1;\n",
  );
  await writeFile(
    join(bin, 'srt'),
    "#!/usr/bin/env node\nif (process.argv[2] === '--version') process.stdout.write('1.0.0\\n');\nelse process.exitCode = 1;\n",
  );
  for (const provider of ['codex', 'claude']) {
    await writeFile(
      join(bin, provider),
      `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2).join(' ');\nif ((args.startsWith('exec ') && args !== 'exec --help') || args.startsWith('--print ')) appendFileSync('${modelInvocations}', args);\nif (args === '--version') process.stdout.write('1.0.0\\n');\nelse if (args === 'exec --help') process.stdout.write('--json --ephemeral --color --output-last-message --skip-git-repo-check --model --sandbox\\n');\nelse if (args === 'login status') process.stderr.write('Logged in using ChatGPT\\n');\nelse if (args === '--help') process.stdout.write('--safe-mode --print --verbose --output-format --no-session-persistence --prompt-suggestions --json-schema --model --permission-mode\\n');\nelse if (args === 'auth status') process.stdout.write('{\\"loggedIn\\":true}');\nelse process.exitCode = 1;\n`,
    );
  }
  for (const command of ['git', 'docker', 'srt', 'codex', 'claude']) {
    await chmod(join(bin, command), 0o755);
  }
  return { bin, dataDir, modelInvocations, statfsHook };
}
