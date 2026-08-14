// Single source of the deterministic "generated app" behavior (#416): the
// fake provider CLIs next to this file AND MockAgentExecutor both delegate
// here, so the scaffold-script contract can never drift between mock mode and
// the nightly real-mode pipeline regression. Node-only on purpose: the fake
// CLIs run as standalone binaries on PATH and cannot import workspace
// packages (the mock executor imports this file, never the reverse).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { dirname, join } from 'node:path';

const TASK_GRAPH_SCHEMA_ID = 'https://agent-foundry.dev/schemas/task-graph-artifact-v1.json';
const BROWSER_PLAN_SCHEMA_ID =
  'https://agent-foundry.dev/schemas/browser-test-plan-artifact-v1.json';
const SCHEMA_PLAN_SCHEMA_ID = 'https://agent-foundry.dev/schemas/schema-plan-artifact-v1.json';
/** Matches UI_QUALITY_JUDGE_JSON_SCHEMA.$id (packages/contracts/src/ui-quality-rubric.ts).
 * Hardcoded rather than imported: this file is Node-only and cannot depend on
 * workspace packages (see the file-header comment). */
const UI_QUALITY_JUDGE_SCHEMA_ID =
  'https://agent-foundry.dev/schemas/ui-quality-judge-artifact-v1.json';
const UI_QUALITY_JUDGE_CRITERION_IDS = [
  'layout-coherence',
  'navigation',
  'empty-loading-error-states',
  'contrast-readability',
  'responsive-sanity',
];

/** Parses the persisted REQUEST.md the prompt points at. Throws on a missing
 * required field so a prompt-compiler format change fails loudly at this
 * boundary instead of silently downstream (format owner:
 * packages/orchestrator/src/prompt-compiler.ts compileRequestMarkdown). */
export async function resolveRequest(prompt, options = {}) {
  const match = prompt.match(/\.orchestrator\/runs\/\S+\/REQUEST\.md/);
  if (!match) return resolveAdHocRequest(prompt, options);
  const requestPath = join(process.cwd(), match[0]);
  const markdown = await readFile(requestPath, 'utf8');
  const field = (label) => {
    const value = markdown.match(new RegExp(`^- ${label}: (.+)$`, 'm'))?.[1]?.trim();
    if (value === undefined) {
      throw new Error(`fake CLI: REQUEST.md is missing the '${label}' identity field`);
    }
    return value;
  };
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
    stepId: field('Step'),
    role: field('Role'),
    taskKind: field('Task kind'),
    mutationAllowed: field('Workspace mutation allowed') === 'yes',
    outputSchemaId,
  };
}

/**
 * Handles callers with no run context on disk (#548) — currently only the
 * UI-quality judge (packages/orchestrator/src/ui-quality-judge.ts), which
 * calls executor.execute() directly with a free-text prompt instead of
 * routing through prompt-compiler's REQUEST.md convention. The only channel
 * still carrying the output schema is the prompt itself: codex's invocation
 * (packages/executors/src/output-schema-prompt.ts) always appends "Output
 * JSON Schema:" plus the schema JSON to the prompt when one is set. Claude
 * passes its schema as a separate `--json-schema` CLI arg instead, so its
 * fake shim forwards that JSON here explicitly.
 */
function resolveAdHocRequest(prompt, options = {}) {
  const schemaMatch = prompt.match(/Output JSON Schema:\n(\{[\s\S]*\})$/);
  const outputSchemaId =
    (typeof options.outputSchemaJson === 'string'
      ? safeParseSchemaId(options.outputSchemaJson)
      : undefined) ?? (schemaMatch ? safeParseSchemaId(schemaMatch[1]) : undefined);
  if (outputSchemaId !== UI_QUALITY_JUDGE_SCHEMA_ID) {
    throw new Error('fake CLI: prompt does not reference a REQUEST.md');
  }
  return {
    stepId: 'ad-hoc',
    role: 'tester',
    taskKind: 'verification',
    mutationAllowed: false,
    outputSchemaId,
  };
}

function safeParseSchemaId(json) {
  try {
    return JSON.parse(json).$id;
  } catch {
    return undefined;
  }
}

/**
 * Neutralizes the scaffold's install-needing scripts and, when converting a
 * pnpm workspace to npm, leaves a previewable app (stub lockfile +
 * zero-dependency dev server). These overrides exist because the scaffold's
 * real scripts (`next build`, `tsc -p`) need an install neither the mock nor
 * the fake CLI ever performs, and the `db:*`/`smoke` scripts need Docker and
 * both tiers running — deferring to them would send every run into repair
 * over a missing dependency instead of exercising the workflow.
 */
export async function mutateWorkspace(cwd, stepId, label = 'fake') {
  await mkdir(join(cwd, 'src'), { recursive: true });
  const packagePath = join(cwd, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    packageJson = {};
  }
  packageJson.name = packageJson.name ?? `generated-${label}-app`;
  packageJson.private = true;
  packageJson.type = 'module';
  // The real invariant behind the preview machinery below: overwriting the
  // manager converts a pnpm workspace (the scaffold declares pnpm via the
  // corepack field) to npm with no matching lockfile, which would break the
  // preview's `npm ci`. Gate on that conversion so dogfood/benchmark
  // mini-workspaces and test-seeded workspaces stay untouched — extra files
  // would violate dogfood file allowlists (#443).
  const convertedFromPnpm =
    typeof packageJson.packageManager === 'string' && packageJson.packageManager.startsWith('pnpm');
  packageJson.packageManager = 'npm@10';
  if (convertedFromPnpm) {
    // Nothing is ever installed, so declared dependencies would only put
    // package.json out of sync with the stub lockfile and fail `npm ci`.
    delete packageJson.dependencies;
    delete packageJson.devDependencies;
  }
  packageJson.scripts = {
    ...(packageJson.scripts ?? {}),
    ...(convertedFromPnpm ? { dev: `node scripts/${label}-dev-server.mjs` } : {}),
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
      join(cwd, 'scripts', `${label}-dev-server.mjs`),
      [
        "import { createServer } from 'node:http';",
        'const server = createServer((request, response) => {',
        "  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
        `  response.end('<html><body><h1>Generated ${label} app</h1></body></html>');`,
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
      // Marks which step wrote this file. Without something step-specific, a
      // second mutating step leaves an identical tree, git finds nothing to
      // commit, and a per-task commit silently disappears.
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

export function buildArtifact(identity, options = {}) {
  const label = options.label ?? 'Fake';
  // Mock mode drives the browser-verification path, so its second task stays
  // browser-visible; the pipeline regression keeps the chain deterministic.
  const t2AcceptanceMode = options.t2AcceptanceMode ?? 'deterministic-only';
  const isReview = identity.taskKind.includes('review') || identity.role === 'tester';
  const data =
    identity.outputSchemaId === BROWSER_PLAN_SCHEMA_ID
      ? {
          schemaVersion: '1',
          id: `${label.toLowerCase()}-critical-journey`,
          title: `${label} critical journey`,
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
            goal: `${label} plan for ${identity.stepId}`,
            modules: [{ id: 'crud:project', acceptanceChannel: 'deterministic-only' }],
            tasks: [
              {
                id: 'T1',
                title: 'Create the project skeleton',
                dependsOn: [],
                deliverables: ['package.json', 'src/index.js'],
                acceptanceCheck: 'npm test passes in the generated workspace',
                acceptanceMode: 'deterministic-only',
                module: 'crud:project',
              },
              {
                id: 'T2',
                title: 'Implement the core flow',
                dependsOn: ['T1'],
                deliverables: ['src/index.js'],
                acceptanceCheck: 'createProject queues a valid project',
                acceptanceMode: t2AcceptanceMode,
                module: 'crud:project',
              },
            ],
          }
        : identity.outputSchemaId === SCHEMA_PLAN_SCHEMA_ID
          ? {
              // Smallest plan SchemaPlanArtifactSchema accepts: one table, one
              // column, RLS on with one policy. Without this branch the generic
              // payload below fails validation and every mock web-app-v1 run
              // burns the schema step's attempts and dies (#481).
              schemaVersion: '1',
              tables: [
                {
                  name: 'items',
                  columns: [{ name: 'id', type: 'uuid', nullable: false }],
                  constraints: [{ type: 'primary-key', columns: ['id'] }],
                  indexes: [],
                  rls: {
                    enabled: true,
                    policies: [{ name: 'items_all', command: 'all', using: 'true' }],
                  },
                },
              ],
            }
          : identity.outputSchemaId === UI_QUALITY_JUDGE_SCHEMA_ID
            ? {
                // Fixture value (#548), not a real judgment: the fake CLI
                // never looks at the screenshots. Deterministic and fixed on
                // purpose so tests control the gate outcome via the policy's
                // minOverallScore instead of this score.
                overallScore: 0.8,
                criteria: UI_QUALITY_JUDGE_CRITERION_IDS.map((criterionId) => ({
                  criterionId,
                  score: 0.8,
                })),
              }
            : {
                stepId: identity.stepId,
                role: identity.role,
                taskKind: identity.taskKind,
                note: `Generated by deterministic ${label.toLowerCase()} mode`,
              };
  return {
    schemaVersion: '1',
    status: 'completed',
    summary: `${label} ${identity.role} completed ${identity.stepId}`,
    ...(isReview ? { approved: true } : {}),
    data,
    decisions: [
      {
        title: `Decision from ${identity.stepId}`,
        choice: 'Use the modular workflow contract',
        rationale: 'It keeps orchestration independent from provider CLIs.',
        alternatives: ['Directly call a provider from the API route'],
        consequences: ['Provider adapters remain replaceable'],
      },
    ],
    assumptions: [],
    risks: [],
    nextActions: [],
  };
}

export async function respond(prompt, options = {}) {
  const identity = await resolveRequest(prompt, options);
  if (identity.mutationAllowed && ['implementation', 'repair'].includes(identity.taskKind)) {
    await mutateWorkspace(process.cwd(), identity.stepId, 'fake');
  }
  return buildArtifact(identity);
}

export function readStdin() {
  return text(process.stdin);
}

export function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
