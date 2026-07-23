import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import type { AgentExecutor } from '@agent-foundry/domain';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  OperationKind,
  TaskProfile,
} from '@agent-foundry/contracts';
import { buildApp } from '../src/app.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE_SCRIPT = resolve(REPO_ROOT, 'packages/executors/src/fixtures/preview-dev-server.mjs');
const REFERENCE_IMAGE = resolve(import.meta.dirname, 'fixtures/design-reference.png');
const BUILDER_SCREENSHOT = resolve(
  REPO_ROOT,
  'test-results/issue-43-knowledge-builder-desktop.png',
);
const FIRST_BUILD_DIFF_SCREENSHOT = resolve(
  REPO_ROOT,
  'test-results/issue-173-first-build-diff.png',
);
const BROWSER_TEST_PLAN = {
  schemaVersion: '1' as const,
  status: 'completed' as const,
  summary: 'Minimal smoke plan for the fixture root route.',
  data: {
    schemaVersion: '1',
    id: 'smoke-plan',
    title: 'Smoke check root route',
    viewport: { width: 1280, height: 720 },
    steps: [
      {
        id: 'load-root',
        title: 'Load the root page',
        action: { kind: 'goto', path: '/' },
        assertions: [{ kind: 'url', path: '/' }],
      },
    ],
  },
};

async function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let runtime: Runtime;
let apiClose: () => Promise<void>;
let apiBaseUrl: string;
let webProcess: ChildProcess;
let webBaseUrl: string;
const dirs: string[] = [];

test.beforeAll(async () => {
  const [dataDir, workflowsDir] = await Promise.all([
    mkdtemp(join(tmpdir(), 'agent-foundry-golden-e2e-data-')),
    mkdtemp(join(tmpdir(), 'agent-foundry-golden-e2e-wf-')),
  ]);
  dirs.push(dataDir, workflowsDir);
  await writeFile(
    join(workflowsDir, 'golden-flow-e2e-v1.yaml'),
    await readFile(resolve(import.meta.dirname, 'fixtures/golden-flow-e2e-v1.yaml'), 'utf8'),
  );

  const [apiPort, webPort] = await Promise.all([reserveEphemeralPort(), reserveEphemeralPort()]);
  // Reserve the web port up front so its origin can be passed as WEB_ORIGIN
  // below — the API's CORS policy (apps/api/src/app.ts) only allows
  // runtime.config.webOrigin (default http://localhost:3000), and the web
  // subprocess runs on a random ephemeral port, so the browser's fetches
  // from the project page would otherwise be silently CORS-blocked.
  //
  // The web origin must use the "localhost" hostname, not "127.0.0.1":
  // Next.js 16 dev servers only serve their own dev-runtime resources (HMR
  // socket, RSC coordination) to allowedDevOrigins, which defaults to
  // "localhost" only. Visiting via 127.0.0.1 gets those requests silently
  // blocked ("Blocked cross-origin request to Next.js dev resource"), which
  // leaves the client stuck re-attempting hydration and never commits its
  // effects — so app fetches (and this test) would hang forever waiting for
  // UI that never appears, with no error surfaced anywhere.
  webBaseUrl = `http://localhost:${webPort}`;
  runtime = await createRuntime(
    {
      ...process.env,
      REPO_ROOT,
      DATA_DIR: dataDir,
      WORKFLOWS_DIR: workflowsDir,
      EXECUTOR_MODE: 'real',
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      WORKER_ID: 'golden-e2e-worker',
      WEB_ORIGIN: webBaseUrl,
    },
    undefined,
    undefined,
    // This suite uses fake provider CLIs and a controlled local fixture. The
    // This fixture deliberately avoids Docker-backed real-mode dependencies.
    { previewInstaller: null, generatedProjectRuntime: null },
  );
  const app = await buildApp(runtime);
  apiBaseUrl = await app.listen({ host: '127.0.0.1', port: apiPort });
  apiClose = () => app.close();

  webProcess = spawn('npx', ['next', 'dev', '-p', String(webPort)], {
    cwd: resolve(REPO_ROOT, 'apps/web'),
    env: { ...process.env, NEXT_PUBLIC_API_URL: apiBaseUrl, PORT: String(webPort) },
    stdio: 'pipe',
  });
  await waitForHttp(webBaseUrl, 60_000);
});

test.afterAll(async () => {
  webProcess.kill();
  await Promise.all([apiClose(), ...dirs.map((dir) => rm(dir, { recursive: true, force: true }))]);
});

async function createProject(): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Golden flow E2E',
      prd: 'x'.repeat(60),
      workflowId: 'golden-flow-e2e-v1',
    }),
  });
  expect(response.status).toBe(202);
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

async function seedWorkspaceAndPlan(projectId: string): Promise<void> {
  await runtime.workspaces.ensure(projectId);
  const workspacePath = runtime.workspaces.workspacePath(projectId);
  const fixtureSource = await readFile(FIXTURE_SCRIPT, 'utf8');
  await writeFile(join(workspacePath, 'server.mjs'), fixtureSource);
  await writeFile(
    join(workspacePath, 'package.json'),
    JSON.stringify({
      packageManager: 'npm@10',
      scripts: {
        dev: 'node server.mjs',
        typecheck: 'node --check server.mjs',
        lint: 'node --check server.mjs',
        test: 'node --test',
        build: 'node --check server.mjs',
      },
    }),
  );
  await writeFile(
    join(workspacePath, 'package-lock.json'),
    JSON.stringify({ name: 'golden-flow-e2e-fixture', lockfileVersion: 3, packages: {} }),
  );
  // Reuses the 'prd' artifact name (see golden-flow-e2e-v1.yaml comment):
  // project creation already wrote revision 1 (the placeholder PRD text);
  // this adds revision 2 with the real browser test plan content, which
  // `getLatest` then resolves for the verify-browser node.
  await runtime.artifacts.put({
    projectId,
    name: 'prd',
    content: BROWSER_TEST_PLAN,
    contentType: 'application/json',
    createdBy: 'golden-flow-e2e',
  });
  const profileDefaults = {
    role: 'developer',
    taxonomyVersion: '2',
    complexity: 3,
    risk: 2,
    estimatedContextTokens: 1_000,
    estimatedOutputTokens: 500,
    mutatesWorkspace: false,
    priorities: { quality: 0.5, speed: 0.2, cost: 0.1, reliability: 0.2 },
    preferredTags: [],
  };
  const profiles: TaskProfile[] = [
    {
      ...profileDefaults,
      taskKind: 'implementation',
      category: 'implementation/frontend',
      features: ['frontend', 'tests'],
    },
    {
      ...profileDefaults,
      taskKind: 'implementation',
      category: 'implementation/backend',
      features: ['backend'],
    },
    {
      ...profileDefaults,
      taskKind: 'repair',
      category: 'repair/integration',
      features: ['integration'],
    },
  ];
  for (const profile of profiles) {
    const routeDecision = await runtime.router.route(profile);
    await runtime.artifacts.put({
      projectId,
      name: `taxonomy-${profile.category.replace('/', '-')}`,
      content: { seeded: true },
      contentType: 'application/json',
      createdBy: 'golden-flow-e2e',
      routeDecision,
    });
  }
}

async function getRun(projectId: string): Promise<{ id: string; status: string }> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}`);
  const { project } = (await response.json()) as { project: { currentRunId: string } };
  const runResponse = await fetch(`${apiBaseUrl}/runs/${project.currentRunId}`);
  const { run } = (await runResponse.json()) as { run: { id: string; status: string } };
  return run;
}

async function runConversationJob(): Promise<void> {
  expect(await runtime.worker.runOnce()).toBe(true);
}

async function readKnowledgeThroughCliChild(path: string): Promise<Buffer> {
  const cli = spawn(
    process.execPath,
    [
      '-e',
      [
        "const { spawnSync } = require('node:child_process');",
        "const tool = spawnSync(process.execPath, ['-e', \"process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('base64'))\", process.argv[1]], { encoding: 'utf8' });",
        'if (tool.status !== 0) throw new Error(tool.stderr);',
        'process.stdout.write(tool.stdout);',
      ].join('\n'),
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  cli.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  cli.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    cli.once('error', reject);
    cli.once('close', resolveExit);
  });
  if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString('utf8'));
  return Buffer.from(Buffer.concat(stdout).toString('utf8'), 'base64');
}

function installGoldenFixtureExecutor(): Array<'plan' | 'build'> {
  let buildSequence = 0;
  const knowledgeReads: Array<'plan' | 'build'> = [];
  const executor: AgentExecutor = {
    provider: 'mock',
    health: () =>
      Promise.resolve({
        provider: 'mock',
        available: true,
        message: 'Golden-flow fixture executor is enabled',
      }),
    execute: async (request, signal) => {
      const kind = request.stepId.includes('conversation-plan')
        ? 'plan'
        : request.stepId.includes('conversation-build')
          ? 'build'
          : null;
      if (kind) {
        const knowledgePath = request.prompt.match(
          /knowledge-[a-zA-Z0-9._-]+@2: ([^;]+?)(?:;|\.$)/,
        )?.[1];
        if (!knowledgePath) throw new Error(`${kind} knowledge input was not materialized`);
        if (!knowledgePath.startsWith(`${request.cwd}/.orchestrator/runs/`)) {
          throw new Error(
            `${kind} knowledge input is outside its run context: ${knowledgePath} (cwd ${request.cwd})`,
          );
        }
        if (!knowledgePath.includes('/inputs/knowledge/') || !knowledgePath.endsWith('/v2.png')) {
          throw new Error(`${kind} knowledge input is not the current v2 PNG path`);
        }
        const [actual, expected] = await Promise.all([
          readKnowledgeThroughCliChild(knowledgePath),
          readFile(REFERENCE_IMAGE),
        ]);
        if (!actual.equals(expected)) throw new Error(`${kind} knowledge bytes do not match`);
        if (
          !request.inputArtifacts?.some(
            (reference) => reference.name.startsWith('knowledge-') && reference.revision === 2,
          )
        ) {
          throw new Error(`${kind} request is missing the current v2 artifact reference`);
        }
        knowledgeReads.push(kind);
      } else if (
        request.stepId.includes('conversation-visual-edit') &&
        request.prompt.includes('knowledge-')
      ) {
        throw new Error('visual-edit request received a knowledge reference');
      }
      if (signal?.aborted) throw signal.reason;
      if (request.stepId.includes('conversation-build')) {
        buildSequence += 1;
        await writeFile(join(request.cwd, 'build-sequence.txt'), `${buildSequence}\n`);
      }
      if (request.stepId.includes('conversation-visual-edit')) {
        const target = join(request.cwd, 'src', 'Greeting.tsx');
        const source = await readFile(target, 'utf8');
        if (!source.includes("'#eee'")) throw new Error('visual-edit fixture source is stale');
        await writeFile(target, source.replace("'#eee'", "'#ddd'"));
      }
      return goldenFixtureResult(request);
    },
  };
  (runtime.executors as { get: () => AgentExecutor }).get = () => executor;
  return knowledgeReads;
}

function goldenFixtureResult(request: AgentExecutionRequest): AgentExecutionResult {
  const output = {
    schemaVersion: '1' as const,
    status: 'completed' as const,
    summary: `Golden fixture completed ${request.stepId}`,
    data: { stepId: request.stepId },
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  };
  return {
    runId: request.runId,
    stepRunId: request.stepRunId,
    attemptId: request.attemptId,
    provider: 'mock',
    model: 'golden-fixture',
    exitCode: 0,
    durationMs: 1,
    stdout: JSON.stringify(output),
    stderr: '',
    output,
  };
}

async function latestOperationRequest(projectId: string, kind: OperationKind): Promise<string> {
  const operation = (await runtime.conversations.listOperations(projectId))
    .filter((candidate) => candidate.kind === kind)
    .at(-1);
  if (!operation?.runId) throw new Error(`latest ${kind} operation has no run`);
  const runPath = join(
    runtime.workspaces.workspacePath(projectId),
    '.orchestrator',
    'runs',
    operation.runId,
  );
  const request = (await readdir(runPath, { recursive: true }))
    .filter((path) => path.endsWith('REQUEST.md'))
    .sort()
    .at(-1);
  if (!request) throw new Error(`latest ${kind} operation has no request`);
  return readFile(join(runPath, request), 'utf8');
}

test('golden flow: change request, preview, browser tests, diff approval, axe', async ({
  page,
}) => {
  const projectId = await createProject();
  await seedWorkspaceAndPlan(projectId);
  expect(await runtime.worker.runOnce()).toBe(true);

  const run = await getRun(projectId);
  expect(run.status).toBe('awaiting_approval');

  await page.goto(`${webBaseUrl}/project/${projectId}`);
  // First visit to this route triggers Next dev's on-demand compile of the
  // project page (on top of the client-side data fetch); default 5s
  // assertion timeout is too tight for a cold compile.
  await expect(page.getByRole('heading', { name: 'Aprovações' })).toBeVisible({
    timeout: 30_000,
  });

  const routesPanel = page.locator('.routesPanel');
  const implementationRoutes = routesPanel
    .getByRole('heading', { name: 'implementation', exact: true })
    .locator('..');
  await expect(implementationRoutes).toContainText('implementation/frontend · taxonomy v2');
  await expect(implementationRoutes).toContainText('implementation/backend · taxonomy v2');
  await expect(implementationRoutes).toContainText('features: frontend, tests');
  const repairRoutes = routesPanel
    .getByRole('heading', { name: 'repair', exact: true })
    .locator('..');
  await expect(repairRoutes).toContainText('repair/integration · taxonomy v2');
  await expect(routesPanel.locator('.routeGrid article h4')).toHaveCount(3);

  await page.getByRole('button', { name: 'Iniciar preview' }).click();
  const iframe = page.locator('.previewFrameWrap iframe');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  await expect(iframe).toHaveAttribute('width', '1280');

  await page.getByRole('button', { name: 'Tablet' }).click();
  await expect(iframe).toHaveAttribute('width', '768');
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect(iframe).toHaveAttribute('width', '375');

  await page.getByRole('button', { name: 'Console, rede e testes' }).click();
  await expect(
    page.getByRole('region', { name: 'Preview' }).getByText('Load the root page'),
  ).toBeVisible();
  await expect(page.locator('.screenshotFilmstrip img').first()).toBeVisible();

  // Exclude the previewed iframe's own document: it's the fixture dev
  // server's bare-text stand-in page (packages/executors/src/fixtures/
  // preview-dev-server.mjs), not real app markup, so it has no landmarks/h1
  // by design. This scan targets the PreviewPanel chrome itself (Task 4's
  // deliverable — buttons, tabs, labels), not arbitrary previewed content.
  const axeResults = await new AxeBuilder({ page })
    .include('.previewPanel')
    .exclude('.previewFrameWrap iframe')
    .analyze();
  expect(axeResults.violations).toEqual([]);

  const screenshotArtifactButton = page
    .locator('.artifactList button')
    .filter({ hasText: 'browser-screenshot' })
    .first();
  await screenshotArtifactButton.click();
  await expect(page.locator('.artifactModal img')).toBeVisible();
  await page.getByRole('button', { name: '×' }).click();

  // Scoped to the decide-modal's own heading: the live timeline ("Linha do
  // tempo") also renders an event whose message equals the node title
  // ("Human diff approval"), as a plain <p>, which collides with a bare
  // getByText match.
  const decideModalHeading = page.getByRole('heading', { name: /Human diff approval/ });
  await page.getByRole('button', { name: 'approve' }).first().click();
  await expect(decideModalHeading).toBeVisible();
  await expect(page.locator('.diffView')).toBeVisible();
  await expect(page.getByText('Nenhuma versão anterior para comparar.')).not.toBeVisible();
  await page.locator('.artifactModal').screenshot({ path: FIRST_BUILD_DIFF_SCREENSHOT });
  await page.getByLabel('Decidido por').fill('e2e-reviewer');
  await page.getByRole('button', { name: /Confirmar approve/ }).click();
  await expect(decideModalHeading).not.toBeVisible();

  expect(await runtime.worker.runOnce()).toBe(true);
  const finalRun = await getRun(projectId);
  expect(finalRun.status).toBe('completed');
});

test('golden flow: attach reference, plan, build, visual edit, revert, rebuild', async ({
  page,
}) => {
  const projectId = await createProject();
  await seedWorkspaceAndPlan(projectId);
  await mkdir(join(runtime.workspaces.workspacePath(projectId), 'src'));
  const greetingPath = join(runtime.workspaces.workspacePath(projectId), 'src', 'Greeting.tsx');
  await writeFile(greetingPath, "export const greetingBackground = '#eee';\n", { flag: 'wx' });
  expect(await runtime.worker.runOnce()).toBe(true);

  await page.goto(`${webBaseUrl}/project/${projectId}`);
  const regions = {
    chat: page.getByRole('region', { name: 'Chat' }),
    preview: page.getByRole('region', { name: 'Preview' }),
    changes: page.getByRole('region', { name: 'Changes' }),
  };
  await expect(regions.chat).toBeVisible({ timeout: 30_000 });
  await expect(regions.preview).toBeVisible();
  await expect(regions.changes).toBeVisible();
  const decideModalHeading = page.getByRole('heading', { name: /Human diff approval/ });
  await page.getByRole('button', { name: 'approve' }).first().click();
  await page.getByLabel('Decidido por').fill('golden-flow-reviewer');
  await page.getByRole('button', { name: /Confirmar approve/ }).click();
  await expect(decideModalHeading).not.toBeVisible();
  expect(await runtime.worker.runOnce()).toBe(true);
  await expect.poll(() => getRun(projectId)).toMatchObject({ status: 'completed' });
  const knowledgeReads = installGoldenFixtureExecutor();

  await page.getByLabel('Adicionar knowledge file').setInputFiles(REFERENCE_IMAGE);
  let knowledge = page.locator('.knowledgeFileList article').filter({
    hasText: 'design-reference.png',
  });
  await expect(knowledge).toContainText('design-reference · v1 · fixado');
  const image = knowledge.getByRole('img', { name: 'design-reference.png' });
  await expect(image).toBeVisible();
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);

  await knowledge.getByRole('button', { name: 'Desafixar design-reference.png' }).click();
  await expect(knowledge).not.toContainText('fixado');
  await knowledge.getByRole('button', { name: 'Fixar design-reference.png' }).click();
  await expect(knowledge).toContainText('fixado');
  await knowledge.getByLabel('Substituir design-reference.png').setInputFiles(REFERENCE_IMAGE);
  await expect(knowledge).toContainText('design-reference · v2 · fixado');
  const [knowledgeFile] = await runtime.knowledgeFiles.list(projectId);
  if (!knowledgeFile) throw new Error('knowledge fixture was not persisted');
  const expectedKnowledgeContext =
    `- design-reference.png v2 · design-reference · ` + `artifact knowledge-${knowledgeFile.id}@2`;

  const chatInput = regions.chat.locator('form textarea');
  await chatInput.fill('Consider the attached reference before execution.');
  await regions.chat.getByRole('button', { name: 'Enviar' }).click();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/conversation\/change-requests\/[^/]+\/decide$/.test(new URL(response.url()).pathname),
    ),
    regions.chat.getByRole('button', { name: 'Confirm plan' }).click(),
  ]);
  await runConversationJob();
  await expect(
    regions.chat.locator('.operationBadge').filter({ hasText: 'plan, pending' }),
  ).toBeVisible();
  await regions.chat.getByRole('button', { name: 'Editar proposta' }).click();
  await regions.chat.getByLabel('Proposta editável').fill(
    JSON.stringify({
      schemaVersion: '1',
      status: 'completed',
      summary: 'Edited proposal',
      data: {},
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    }),
  );
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        /\/conversation\/operations\/[^/]+\/proposal$/.test(new URL(response.url()).pathname),
    ),
    regions.chat.getByRole('button', { name: 'Salvar proposta' }).click(),
  ]);
  await page.screenshot({ path: 'test-results/issue-206-editable-proposal.png', fullPage: true });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/conversation\/operations\/[^/]+\/decide$/.test(new URL(response.url()).pathname),
    ),
    regions.chat.getByRole('button', { name: 'Aprovar' }).click(),
  ]);
  await expect(
    regions.chat.locator('.operationBadge').filter({ hasText: 'plan, approved' }),
  ).toBeVisible();
  await expect(latestOperationRequest(projectId, 'plan')).resolves.toContain(
    expectedKnowledgeContext,
  );
  expect(knowledgeReads).toContain('plan');

  await regions.chat.getByLabel('Build (vai alterar código e consumir budget)').check();
  await chatInput.fill('Build the approved implementation');
  await regions.chat.getByRole('button', { name: 'Enviar' }).click();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/conversation\/change-requests\/[^/]+\/decide$/.test(new URL(response.url()).pathname),
    ),
    regions.chat.getByRole('button', { name: 'Confirm build' }).click(),
  ]);
  await runConversationJob();
  await expect(
    regions.chat.locator('.operationBadge').filter({ hasText: 'build' }).last(),
  ).toBeVisible();
  const buildRequest = await latestOperationRequest(projectId, 'build');
  expect(buildRequest).toContain('- Workflow: conversation-build');
  expect(buildRequest).toContain(expectedKnowledgeContext);
  expect(knowledgeReads).toEqual(['plan', 'build']);

  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Iniciar preview' }).click();
  const iframe = page.locator('.previewFrameWrap iframe');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const src = await iframe.getAttribute('src');
  if (!src) throw new Error('preview iframe has no src');
  const fixtureUrl = new URL(src);
  fixtureUrl.pathname = `${fixtureUrl.pathname.replace(/\/$/, '')}/dom-source-map-fixture`;
  const iframeHandle = await page.waitForSelector('.previewFrameWrap iframe');
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('preview iframe has no content frame');
  await frame.goto(fixtureUrl.toString());
  await page.getByRole('button', { name: 'Selecionar elemento' }).click();
  const selected = page.frameLocator('.previewFrameWrap iframe').locator('#simple');
  await selected.click();
  await expect(page.getByText('src/Greeting.tsx')).toBeVisible();
  await page.getByLabel('Propriedade').selectOption('backgroundColor');
  await page.getByLabel('Valor atual').fill('#eee');
  await page.getByLabel('Novo valor').fill('#ddd');
  await page.getByRole('button', { name: 'Pré-visualizar alteração' }).click();
  await expect(selected).toHaveCSS('background-color', 'rgb(221, 221, 221)');
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/preview\/[^/]+\/visual-edits$/.test(new URL(response.url()).pathname),
    ),
    page.getByRole('button', { name: 'Aplicar alteração' }).click(),
  ]);
  await runConversationJob();
  await expect.poll(() => readFile(greetingPath, 'utf8')).toContain("'#ddd'");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/preview\/[^/]+\/stop$/.test(new URL(response.url()).pathname),
    ),
    page.getByRole('button', { name: 'Parar preview' }).click(),
  ]);

  const [visualVersion, baselineVersion] = await runtime.projectVersionService.list(projectId, 50);
  if (!visualVersion || !baselineVersion) throw new Error('golden versions were not recorded');
  const versionArticle = (commit: string, kind = 'run') =>
    page
      .locator('.versionList article')
      .filter({ hasText: commit.slice(0, 7) })
      .filter({ has: page.getByText(kind, { exact: true }) });
  await expect(versionArticle(baselineVersion.commit)).toBeVisible({ timeout: 30_000 });
  await expect(versionArticle(visualVersion.commit)).toBeVisible();
  await versionArticle(baselineVersion.commit).getByRole('checkbox').check();
  await versionArticle(visualVersion.commit).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Comparar selecionadas' }).click();
  await expect(page.locator('.diffPane')).toContainText("'#ddd'");

  page.once('dialog', (dialog) => dialog.accept('golden-flow'));
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/versions\/[^/]+\/branch$/.test(new URL(response.url()).pathname),
    ),
    versionArticle(baselineVersion.commit)
      .getByRole('button', { name: 'Criar branch da versão 1' })
      .click(),
  ]);
  await expect(versionArticle(baselineVersion.commit, 'branch')).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/versions\/[^/]+\/protect$/.test(new URL(response.url()).pathname),
    ),
    versionArticle(baselineVersion.commit)
      .getByRole('button', { name: 'Proteger versão 1' })
      .click(),
  ]);
  await expect
    .poll(async () => runtime.projectVersions.get(projectId, baselineVersion.id))
    .toMatchObject({ protected: true });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/versions\/[^/]+\/revert$/.test(new URL(response.url()).pathname),
    ),
    versionArticle(baselineVersion.commit).locator('[data-version-action="revert"]').click(),
  ]);
  const revertedGreeting = await readFile(greetingPath, 'utf8');
  expect(revertedGreeting).toContain("'#eee'");
  expect(revertedGreeting).not.toContain("'#ddd'");
  const [revertVersion] = await runtime.projectVersionService.list(projectId, 50);
  await expect(versionArticle(revertVersion!.commit, 'revert')).toBeVisible();
  const buildSequencePath = join(runtime.workspaces.workspacePath(projectId), 'build-sequence.txt');

  const refreshedChat = page.getByRole('region', { name: 'Chat' });
  await refreshedChat.getByLabel('Build (vai alterar código e consumir budget)').check();
  await refreshedChat.locator('form textarea').fill('Rebuild the approved implementation');
  await refreshedChat.getByRole('button', { name: 'Enviar' }).click();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/conversation\/change-requests\/[^/]+\/decide$/.test(new URL(response.url()).pathname),
    ),
    refreshedChat.getByRole('button', { name: 'Confirm build' }).click(),
  ]);
  await runConversationJob();
  const rebuiltGreeting = await readFile(greetingPath, 'utf8');
  expect(rebuiltGreeting).toContain("'#eee'");
  expect(rebuiltGreeting).not.toContain("'#ddd'");
  await expect(readFile(buildSequencePath, 'utf8')).resolves.toBe('2\n');

  await expect.poll(() => runtime.projectVersionService.list(projectId, 50)).toHaveLength(5);
  const [rebuiltVersion] = await runtime.projectVersionService.list(projectId, 50);
  await expect(versionArticle(rebuiltVersion!.commit)).toBeVisible({ timeout: 30_000 });
  const changes = page.getByRole('region', { name: 'Changes' });
  await expect(changes).toContainText('Checks');
  await expect(changes).toContainText('passed');
  const workspacePath = runtime.workspaces.workspacePath(projectId);
  await expect(changes.getByRole('link', { name: 'Open in editor' })).toHaveAttribute(
    'href',
    `vscode://file/${encodeURIComponent(workspacePath)}`,
  );

  await mkdir(resolve(BUILDER_SCREENSHOT, '..'), { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.screenshot({ path: BUILDER_SCREENSHOT, fullPage: true });
  expect((await stat(BUILDER_SCREENSHOT)).size).toBeGreaterThan(0);
  await test.info().attach('knowledge builder desktop', {
    path: BUILDER_SCREENSHOT,
    contentType: 'image/png',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileRegions = [
    page.getByRole('region', { name: 'Chat' }),
    page.getByRole('region', { name: 'Preview' }),
    page.getByRole('region', { name: 'Changes' }),
  ];
  for (const region of mobileRegions) await expect(region).toBeVisible();
  const boxes = await Promise.all(mobileRegions.map((region) => region.boundingBox()));
  expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);

  knowledge = page.locator('.knowledgeFileList article').filter({
    hasText: 'design-reference.png',
  });
  await knowledge.getByRole('button', { name: 'Remover design-reference.png' }).click();
  await expect(page.getByText('Nenhum knowledge file ativo.')).toBeVisible();
});
