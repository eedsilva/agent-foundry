import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { execa } from 'execa';
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

async function seedDomSourceMapFixture(projectId: string): Promise<string> {
  await runtime.workspaces.ensure(projectId);
  const workspacePath = runtime.workspaces.workspacePath(projectId);
  const fixtureSource = await readFile(FIXTURE_SCRIPT, 'utf8');
  await writeFile(join(workspacePath, 'server.mjs'), fixtureSource);
  await writeFile(
    join(workspacePath, 'package.json'),
    JSON.stringify({ packageManager: 'npm@10', scripts: { dev: 'node server.mjs' } }),
  );
  await writeFile(
    join(workspacePath, 'package-lock.json'),
    JSON.stringify({ name: 'dom-source-map-e2e-fixture', lockfileVersion: 3, packages: {} }),
  );
  await runtime.workspaces.checkpoint(projectId, 'DOM source map e2e baseline');
  return workspacePath;
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

interface WorkspaceState {
  head: string;
  status: string;
}

async function workspaceState(workspacePath: string): Promise<WorkspaceState> {
  const [head, status] = await Promise.all([
    execa('git', ['rev-parse', 'HEAD'], { cwd: workspacePath }),
    execa('git', ['status', '--porcelain'], { cwd: workspacePath }),
  ]);
  return { head: head.stdout, status: status.stdout };
}

async function openSelectedFixture(page: Page): Promise<{
  projectId: string;
  selected: Locator;
  workspacePath: string;
  baseline: WorkspaceState;
}> {
  const projectId = await createProject();
  const workspacePath = await seedDomSourceMapFixture(projectId);
  const frameBody = await startPreviewAndSelect(page, projectId);
  const selected = frameBody.locator('#simple');
  await selected.click();
  await expect(page.getByText('src/Greeting.tsx')).toBeVisible({ timeout: 10_000 });
  const baseline = await workspaceState(workspacePath);
  expect(baseline.status).toBe('');
  return { projectId, selected, workspacePath, baseline };
}

function watchOperationMutations(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === 'POST' &&
      (/\/visual-edits$/.test(pathname) ||
        /\/conversation\/messages\/[^/]+\/operations$/.test(pathname) ||
        /\/conversation\/(?:operations|change-requests)\/[^/]+\/decide$/.test(pathname))
    ) {
      requests.push(request.url());
    }
  });
  return requests;
}

async function expectNoPromotion(input: {
  projectId: string;
  workspacePath: string;
  baseline: WorkspaceState;
  operationMutations: string[];
}): Promise<void> {
  expect(input.operationMutations).toEqual([]);
  expect(await runtime.conversations.listOperations(input.projectId)).toEqual([]);
  expect(await workspaceState(input.workspacePath)).toEqual(input.baseline);
}

async function previewEdit(
  page: Page,
  property: string,
  oldValue: string,
  newValue: string,
  breakpoint = '',
): Promise<void> {
  await page.getByLabel('Propriedade').selectOption(property);
  await page.getByLabel('Valor atual').fill(oldValue);
  await page.getByLabel('Novo valor').fill(newValue);
  await page.getByLabel('Breakpoint').selectOption(breakpoint);
  await page.getByRole('button', { name: 'Pré-visualizar alteração' }).click();
}

test('clicking a simple component resolves to its source file', async ({ page }) => {
  const projectId = await createProject();
  await seedDomSourceMapFixture(projectId);
  const frameBody = await startPreviewAndSelect(page, projectId);
  await frameBody.locator('#simple').click();
  await expect(page.getByText('src/Greeting.tsx')).toBeVisible({ timeout: 10_000 });
});

test('previews and clears a text edit without changing workspace source', async ({ page }) => {
  const operationMutations = watchOperationMutations(page);
  const fixture = await openSelectedFixture(page);
  const workspaceFile = join(fixture.workspacePath, 'server.mjs');
  const sourceBefore = await readFile(workspaceFile, 'utf8');

  await expect(page.getByLabel('Valor atual')).toBeVisible({ timeout: 5_000 });
  await previewEdit(page, 'text', 'Simple', 'Edited in preview');
  await expect(fixture.selected).toHaveText('Edited in preview');

  await page.getByRole('button', { name: 'Limpar alteração' }).click();
  await expect(fixture.selected).toHaveText('Simple');
  expect(await readFile(workspaceFile, 'utf8')).toBe(sourceBefore);
  await expectNoPromotion({ ...fixture, operationMutations });
});

test('temporarily previews padding before any promotion request', async ({ page }) => {
  const operationMutations = watchOperationMutations(page);
  const fixture = await openSelectedFixture(page);

  await previewEdit(page, 'padding', '0px', '12px');

  await expect(fixture.selected).toHaveCSS('padding', '12px');
  await expectNoPromotion({ ...fixture, operationMutations });
});

test('temporarily previews an existing color token before any promotion request', async ({
  page,
}) => {
  const operationMutations = watchOperationMutations(page);
  const fixture = await openSelectedFixture(page);

  await previewEdit(page, 'color', '', 'var(--fixture-accent)');

  await expect(fixture.selected).toHaveCSS('color', 'rgb(12, 34, 56)');
  expect(await fixture.selected.evaluate((element) => element.style.color)).toBe(
    'var(--fixture-accent)',
  );
  await expectNoPromotion({ ...fixture, operationMutations });
});

test('temporarily previews responsive layout only at its breakpoint before promotion', async ({
  page,
}) => {
  const operationMutations = watchOperationMutations(page);
  const fixture = await openSelectedFixture(page);

  await previewEdit(page, 'display', 'block', 'grid', 'md');

  await expect(fixture.selected).toHaveCSS('display', 'grid');
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect(fixture.selected).toHaveCSS('display', 'block');
  await page.getByRole('button', { name: 'Desktop' }).click();
  await expect(fixture.selected).toHaveCSS('display', 'grid');
  await expectNoPromotion({ ...fixture, operationMutations });
});

test('routes an unsafe direct edit through chat classification', async ({ page }) => {
  const operationMutations = watchOperationMutations(page);
  const fixture = await openSelectedFixture(page);

  await previewEdit(page, 'backgroundColor', '#eee', 'url(javascript:x)');

  await expect(page.getByText('Edição direta inválida')).toBeVisible();
  await expect(page.getByText('visual-edit', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(fixture.selected).toHaveText('Simple');
  await expectNoPromotion({ ...fixture, operationMutations });
});

test('routes a conversational-only property through chat classification', async ({ page }) => {
  const operationMutations = watchOperationMutations(page);
  const fixture = await openSelectedFixture(page);
  await page.getByLabel('Propriedade').evaluate((element) => {
    const option = document.createElement('option');
    option.value = 'fontFamily';
    option.textContent = 'fontFamily';
    element.append(option);
  });

  await previewEdit(page, 'fontFamily', 'sans-serif', 'serif');

  await expect(page.getByText('Edição direta inválida')).toBeVisible();
  await expect(page.getByText('visual-edit', { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(await fixture.selected.evaluate((element) => element.style.fontFamily)).toBe('');
  await expectNoPromotion({ ...fixture, operationMutations });
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
