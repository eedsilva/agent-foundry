// Shared core of the fake provider CLIs (#416). The `codex` and `claude`
// executables next to this file speak each real CLI's invocation and stream
// protocol, but answer deterministically from the persisted REQUEST.md — the
// pipeline regression e2e uses them as the LLM boundary so a real-mode run
// spends no quota. Node-only on purpose: these run as standalone binaries on
// PATH, so they cannot import workspace packages.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const TASK_GRAPH_SCHEMA_ID = 'https://agent-foundry.dev/schemas/task-graph-artifact-v1.json';
const BROWSER_PLAN_SCHEMA_ID =
  'https://agent-foundry.dev/schemas/browser-test-plan-artifact-v1.json';

export async function resolveRequest(prompt) {
  const match = prompt.match(/\.orchestrator\/runs\/\S+\/REQUEST\.md/);
  if (!match) throw new Error('fake CLI: prompt does not reference a REQUEST.md');
  const requestPath = join(process.cwd(), match[0]);
  const markdown = await readFile(requestPath, 'utf8');
  const field = (label) => markdown.match(new RegExp(`^- ${label}: (.+)$`, 'm'))?.[1]?.trim();
  let outputSchemaId;
  try {
    const schema = JSON.parse(
      await readFile(join(dirname(requestPath), 'output.schema.json'), 'utf8'),
    );
    outputSchemaId = schema?.$id;
  } catch {
    outputSchemaId = undefined;
  }
  return {
    stepId: field('Step') ?? 'unknown-step',
    role: field('Role') ?? 'developer',
    taskKind: field('Task kind') ?? 'implementation',
    mutationAllowed: field('Workspace mutation allowed') === 'yes',
    outputSchemaId,
  };
}

/**
 * Mirrors the mock executor's workspace mutation (mock-executor.ts): neutralize
 * the scaffold's install-needing scripts and, when converting a pnpm workspace
 * to npm, leave a previewable app (stub lockfile + zero-dependency dev server).
 */
export async function mutateWorkspace(stepId) {
  const cwd = process.cwd();
  await mkdir(join(cwd, 'src'), { recursive: true });
  const packagePath = join(cwd, 'package.json');
  let packageJson = {};
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    packageJson = {};
  }
  packageJson.name = packageJson.name ?? 'generated-fake-app';
  packageJson.private = true;
  packageJson.type = 'module';
  const convertedFromPnpm =
    typeof packageJson.packageManager === 'string' && packageJson.packageManager.startsWith('pnpm');
  packageJson.packageManager = 'npm@10';
  if (convertedFromPnpm) {
    delete packageJson.dependencies;
    delete packageJson.devDependencies;
  }
  packageJson.scripts = {
    ...(packageJson.scripts ?? {}),
    ...(convertedFromPnpm ? { dev: 'node scripts/fake-dev-server.mjs' } : {}),
    typecheck: 'node --check src/index.js',
    lint: 'node --check src/index.js',
    test: 'node --test',
    build: 'node --check src/index.js',
    'server-actions:check': 'node --check src/index.js',
    'db:start': 'node -e ""',
    'db:reset': 'node -e ""',
    smoke: 'node -e ""',
    'database-row-match': `node -e "console.log('AGENT_FOUNDRY_DB_MATCH:${'0'.repeat(64)}')"`,
  };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  if (convertedFromPnpm) {
    const name = packageJson.name;
    const version = packageJson.version ?? '0.0.0';
    await writeFile(
      join(cwd, 'package-lock.json'),
      `${JSON.stringify(
        {
          name,
          version,
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name, version } },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await mkdir(join(cwd, 'scripts'), { recursive: true });
    await writeFile(
      join(cwd, 'scripts', 'fake-dev-server.mjs'),
      [
        "import { createServer } from 'node:http';",
        'const server = createServer((request, response) => {',
        "  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
        "  response.end('<html><body><h1>Generated fake app</h1></body></html>');",
        '});',
        "server.listen(Number(process.env.PORT ?? 0), '127.0.0.1');",
        "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
        '',
      ].join('\n'),
      'utf8',
    );
  }
  await writeFile(
    join(cwd, 'src', 'index.js'),
    [
      'export function createProject(input) {',
      "  if (!input?.name || !input?.prd) throw new Error('name and prd are required');",
      "  return { ...input, status: 'queued' };",
      '}',
      `export const lastStep = ${JSON.stringify(stepId)};`,
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(cwd, 'src', 'index.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { createProject } from './index.js';",
      '',
      "test('queues a valid project', () => {",
      "  assert.equal(createProject({ name: 'x', prd: 'y' }).status, 'queued');",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
}

export function buildArtifact(identity) {
  const isReview = identity.taskKind.includes('review') || identity.role === 'tester';
  const data =
    identity.outputSchemaId === BROWSER_PLAN_SCHEMA_ID
      ? {
          schemaVersion: '1',
          id: 'fake-critical-journey',
          title: 'Fake critical journey',
          viewport: { width: 1280, height: 720 },
          steps: [
            {
              id: 'open-root',
              title: 'Open the app',
              action: { kind: 'goto', path: '/' },
              assertions: [],
            },
          ],
        }
      : identity.outputSchemaId === TASK_GRAPH_SCHEMA_ID
        ? {
            schemaVersion: '1',
            goal: `Fake plan for ${identity.stepId}`,
            tasks: [
              {
                id: 'T1',
                title: 'Create the project skeleton',
                dependsOn: [],
                deliverables: ['package.json', 'src/index.js'],
                acceptanceCheck: 'npm test passes in the generated workspace',
                acceptanceMode: 'deterministic-only',
              },
              {
                id: 'T2',
                title: 'Implement the core flow',
                dependsOn: ['T1'],
                deliverables: ['src/index.js'],
                acceptanceCheck: 'createProject queues a valid project',
                acceptanceMode: 'deterministic-only',
              },
            ],
          }
        : {
            stepId: identity.stepId,
            role: identity.role,
            taskKind: identity.taskKind,
            note: 'Generated by the fake provider CLI',
          };
  return {
    schemaVersion: '1',
    status: 'completed',
    summary: `Fake ${identity.role} completed ${identity.stepId}`,
    ...(isReview ? { approved: true } : {}),
    data,
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  };
}

export async function respond(prompt) {
  const identity = await resolveRequest(prompt);
  if (identity.mutationAllowed && ['implementation', 'repair'].includes(identity.taskKind)) {
    await mutateWorkspace(identity.stepId);
  }
  return buildArtifact(identity);
}

export function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', rejectPromise);
  });
}

export function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
