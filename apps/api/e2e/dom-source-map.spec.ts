import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from '../src/app.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE_SCRIPT = resolve(REPO_ROOT, 'packages/executors/src/fixtures/preview-dev-server.mjs');

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
    mkdtemp(join(tmpdir(), 'agent-foundry-dom-source-map-e2e-data-')),
    mkdtemp(join(tmpdir(), 'agent-foundry-dom-source-map-e2e-wf-')),
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
    WORKER_ID: 'dom-source-map-e2e-worker',
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
      name: 'DOM source map E2E',
      prd: 'x'.repeat(60),
      workflowId: 'golden-flow-e2e-v1',
    }),
  });
  expect(response.status).toBe(202);
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

async function seedDomSourceMapFixture(projectId: string): Promise<void> {
  await runtime.workspaces.ensure(projectId);
  const workspacePath = runtime.workspaces.workspacePath(projectId);
  const fixtureSource = await readFile(FIXTURE_SCRIPT, 'utf8');
  await writeFile(join(workspacePath, 'server.mjs'), fixtureSource);
  await writeFile(
    join(workspacePath, 'package.json'),
    JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
  );
}

async function startPreviewAndSelect(page: Page, projectId: string) {
  await page.goto(`${webBaseUrl}/project/${projectId}`);
  await page.getByText('Iniciar preview').click();
  const iframeHandle = await page.waitForSelector('.previewFrameWrap iframe');

  // PreviewPanel sets the iframe's initial src to the proxied session root
  // (e.g. /preview/<sessionId>/?token=...), which the fixture dev server
  // answers with its bare "ok:/" text/plain placeholder (see the default
  // handler in preview-dev-server.mjs) — the proxy only injects the click
  // inspector script into text/html responses, and the DOM source map
  // fixture markup only lives at /dom-source-map-fixture. Navigate the
  // iframe there directly rather than assuming the root page has it.
  const initialSrc = await iframeHandle.getAttribute('src');
  if (!initialSrc) throw new Error('preview iframe has no src');
  const fixtureUrl = new URL(initialSrc);
  fixtureUrl.pathname = fixtureUrl.pathname.replace(/\/$/, '') + '/dom-source-map-fixture';
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('preview iframe has no content frame');
  await frame.goto(fixtureUrl.toString());

  await page.getByText('Selecionar elemento').click();
  return page.frameLocator('.previewFrameWrap iframe').locator('body');
}

test('clicking a simple component resolves to its source file', async ({ page }) => {
  const projectId = await createProject();
  await seedDomSourceMapFixture(projectId);
  const frameBody = await startPreviewAndSelect(page, projectId);
  await frameBody.locator('#simple').click();
  await expect(page.getByText('src/Greeting.tsx')).toBeVisible({ timeout: 10_000 });
});

test('previews and clears a text edit without changing workspace source', async ({ page }) => {
  const projectId = await createProject();
  await seedDomSourceMapFixture(projectId);
  const workspaceFile = join(runtime.workspaces.workspacePath(projectId), 'server.mjs');
  const sourceBefore = await readFile(workspaceFile, 'utf8');
  const frameBody = await startPreviewAndSelect(page, projectId);
  const selected = frameBody.locator('#simple');
  await selected.click();
  await expect(page.getByText('src/Greeting.tsx')).toBeVisible({ timeout: 10_000 });

  await expect(page.getByLabel('Valor atual')).toBeVisible({ timeout: 5_000 });
  await page.getByLabel('Valor atual').fill('Simple');
  await page.getByLabel('Novo valor').fill('Edited in preview');
  await page.getByRole('button', { name: 'Pré-visualizar alteração' }).click();
  await expect(selected).toHaveText('Edited in preview');

  await page.getByRole('button', { name: 'Limpar alteração' }).click();
  await expect(selected).toHaveText('Simple');
  expect(await readFile(workspaceFile, 'utf8')).toBe(sourceBefore);
});

test('routes an unsafe direct edit through chat classification', async ({ page }) => {
  const projectId = await createProject();
  await seedDomSourceMapFixture(projectId);
  const frameBody = await startPreviewAndSelect(page, projectId);
  const selected = frameBody.locator('#simple');
  await selected.click();
  await expect(page.getByText('src/Greeting.tsx')).toBeVisible({ timeout: 10_000 });

  await page.getByLabel('Propriedade').selectOption('backgroundColor');
  await page.getByLabel('Valor atual').fill('#eee');
  await page.getByLabel('Novo valor').fill('url(javascript:x)');
  await page.getByRole('button', { name: 'Pré-visualizar alteração' }).click();

  await expect(page.getByText('Edição direta inválida')).toBeVisible();
  await expect(page.getByText('visual-edit', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(selected).toHaveText('Simple');
});

test('routes a legacy resolved selection without coordinates through chat', async ({ page }) => {
  await page.route(/\/preview\/[^/]+\/selection$/, async (route) => {
    const response = await route.fetch();
    const result = (await response.json()) as Record<string, unknown>;
    delete result.line;
    delete result.column;
    await route.fulfill({ response, json: result });
  });
  const projectId = await createProject();
  await seedDomSourceMapFixture(projectId);
  const frameBody = await startPreviewAndSelect(page, projectId);
  await frameBody.locator('#simple').click();
  await expect(page.getByText('src/Greeting.tsx')).toBeVisible({ timeout: 10_000 });

  await expect(page.getByLabel('Valor atual')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continuar na conversa' }).click();
  await expect(page.getByText('visual-edit', { exact: true })).toBeVisible({ timeout: 10_000 });
});

test('clicking a wrapped component shows the ambiguous confirm panel', async ({ page }) => {
  const projectId = await createProject();
  await seedDomSourceMapFixture(projectId);
  const frameBody = await startPreviewAndSelect(page, projectId);
  await frameBody.locator('#wrapper').click();
  await expect(page.getByText('Seleção ambígua')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('src/Card.tsx')).toBeVisible();
  await expect(page.getByText('src/Button.tsx')).toBeVisible();
});

test('clicking a generated element degrades to the unsupported panel', async ({ page }) => {
  const projectId = await createProject();
  await seedDomSourceMapFixture(projectId);
  const frameBody = await startPreviewAndSelect(page, projectId);
  await frameBody.locator('#generated').click();
  await expect(page.getByText('Não foi possível mapear')).toBeVisible({ timeout: 10_000 });
});
