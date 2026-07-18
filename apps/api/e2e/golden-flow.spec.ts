import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from '../src/app.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE_SCRIPT = resolve(
  REPO_ROOT,
  'packages/executors/src/fixtures/preview-dev-server.mjs',
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
  runtime = await createRuntime({
    ...process.env,
    REPO_ROOT,
    DATA_DIR: dataDir,
    WORKFLOWS_DIR: workflowsDir,
    EXECUTOR_MODE: 'real',
    API_HOST: '127.0.0.1',
    API_PORT: String(apiPort),
    WORKER_ID: 'golden-e2e-worker',
    WEB_ORIGIN: webBaseUrl,
  });
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
    JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
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
}

async function getRun(projectId: string): Promise<{ id: string; status: string }> {
  const response = await fetch(`${apiBaseUrl}/projects/${projectId}`);
  const { project } = (await response.json()) as { project: { currentRunId: string } };
  const runResponse = await fetch(`${apiBaseUrl}/runs/${project.currentRunId}`);
  const { run } = (await runResponse.json()) as { run: { id: string; status: string } };
  return run;
}

test('golden flow: change request, preview, browser tests, diff approval, axe', async ({ page }) => {
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

  await page.getByRole('button', { name: 'Iniciar preview' }).click();
  const iframe = page.locator('.previewFrameWrap iframe');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  await expect(iframe).toHaveAttribute('width', '1280');

  await page.getByRole('button', { name: 'Tablet' }).click();
  await expect(iframe).toHaveAttribute('width', '768');
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect(iframe).toHaveAttribute('width', '375');

  await page.getByRole('button', { name: 'Console, rede e testes' }).click();
  await expect(page.getByText('Load the root page')).toBeVisible();
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
  await page.getByLabel('Decidido por').fill('e2e-reviewer');
  await page.getByRole('button', { name: /Confirmar approve/ }).click();
  await expect(decideModalHeading).not.toBeVisible();

  expect(await runtime.worker.runOnce()).toBe(true);
  const finalRun = await getRun(projectId);
  expect(finalRun.status).toBe('completed');
});
