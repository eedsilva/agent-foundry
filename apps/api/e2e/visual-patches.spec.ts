import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from '../src/app.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE_SCRIPT = resolve(REPO_ROOT, 'packages/executors/src/fixtures/preview-dev-server.mjs');

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Keep polling while Next starts.
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
const temporaryDirectories: string[] = [];

test.beforeAll(async () => {
  const [dataDir, workflowsDir] = await Promise.all([
    mkdtemp(join(tmpdir(), 'agent-foundry-visual-patches-e2e-data-')),
    mkdtemp(join(tmpdir(), 'agent-foundry-visual-patches-e2e-wf-')),
  ]);
  temporaryDirectories.push(dataDir, workflowsDir);
  await writeFile(
    join(workflowsDir, 'golden-flow-e2e-v1.yaml'),
    await readFile(resolve(import.meta.dirname, 'fixtures/golden-flow-e2e-v1.yaml'), 'utf8'),
  );

  const [apiPort, webPort] = await Promise.all([reservePort(), reservePort()]);
  webBaseUrl = `http://localhost:${webPort}`;
  runtime = await createRuntime({
    ...process.env,
    REPO_ROOT,
    DATA_DIR: dataDir,
    WORKFLOWS_DIR: workflowsDir,
    EXECUTOR_MODE: 'real',
    API_HOST: '127.0.0.1',
    API_PORT: String(apiPort),
    WORKER_ID: 'visual-patches-e2e-worker',
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
  await waitForHttp(webBaseUrl);
});

test.afterAll(async () => {
  webProcess.kill();
  await Promise.all([
    apiClose(),
    ...temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  ]);
});

async function createProject(): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Visual patches E2E',
      prd: 'x'.repeat(60),
      workflowId: 'golden-flow-e2e-v1',
    }),
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function seedWorkspace(projectId: string): Promise<string> {
  await runtime.workspaces.ensure(projectId);
  const workspacePath = runtime.workspaces.workspacePath(projectId);
  const workspaceFile = join(workspacePath, 'server.mjs');
  await writeFile(workspaceFile, await readFile(FIXTURE_SCRIPT, 'utf8'));
  await writeFile(
    join(workspacePath, 'package.json'),
    JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
  );
  return workspaceFile;
}

async function openSelectedFixture(
  page: Page,
): Promise<{ selected: Locator; workspaceFile: string }> {
  const projectId = await createProject();
  const workspaceFile = await seedWorkspace(projectId);
  await page.goto(`${webBaseUrl}/project/${projectId}`);
  await page.getByRole('button', { name: 'Iniciar preview' }).click();
  const iframe = page.locator('.previewFrameWrap iframe');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const initialSrc = await iframe.getAttribute('src');
  if (!initialSrc) throw new Error('preview iframe has no src');
  const fixtureUrl = new URL(initialSrc);
  fixtureUrl.pathname = `${fixtureUrl.pathname.replace(/\/$/, '')}/dom-source-map-fixture`;
  const frame = await iframe.elementHandle().then((handle) => handle?.contentFrame());
  if (!frame) throw new Error('preview iframe has no content frame');
  await frame.goto(fixtureUrl.toString());

  await page.getByRole('button', { name: 'Selecionar elemento' }).click();
  const selected = page.frameLocator('.previewFrameWrap iframe').locator('#simple');
  await selected.click();
  await expect(page.getByText('src/Greeting.tsx')).toBeVisible({ timeout: 10_000 });
  return { selected, workspaceFile };
}

function watchPromotionRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/visual-edits')) {
      requests.push(request.url());
    }
  });
  return requests;
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

test('temporarily previews text before any promotion request', async ({ page }) => {
  const promotions = watchPromotionRequests(page);
  const { selected, workspaceFile } = await openSelectedFixture(page);
  const sourceBefore = await readFile(workspaceFile, 'utf8');

  await previewEdit(page, 'text', 'Simple', 'Temporary text');

  await expect(selected).toHaveText('Temporary text');
  expect(promotions).toEqual([]);
  expect(await readFile(workspaceFile, 'utf8')).toBe(sourceBefore);
});

test('temporarily previews padding before any promotion request', async ({ page }) => {
  const promotions = watchPromotionRequests(page);
  const { selected, workspaceFile } = await openSelectedFixture(page);
  const sourceBefore = await readFile(workspaceFile, 'utf8');

  await previewEdit(page, 'padding', '0px', '12px');

  await expect(selected).toHaveCSS('padding', '12px');
  expect(promotions).toEqual([]);
  expect(await readFile(workspaceFile, 'utf8')).toBe(sourceBefore);
});

test('temporarily previews an existing color token before any promotion request', async ({
  page,
}) => {
  const promotions = watchPromotionRequests(page);
  const { selected, workspaceFile } = await openSelectedFixture(page);
  const sourceBefore = await readFile(workspaceFile, 'utf8');

  await previewEdit(page, 'color', '', 'var(--fixture-accent)');

  await expect(selected).toHaveCSS('color', 'rgb(12, 34, 56)');
  expect(promotions).toEqual([]);
  expect(await readFile(workspaceFile, 'utf8')).toBe(sourceBefore);
});

test('temporarily previews responsive layout only at its breakpoint before promotion', async ({
  page,
}) => {
  const promotions = watchPromotionRequests(page);
  const { selected, workspaceFile } = await openSelectedFixture(page);
  const sourceBefore = await readFile(workspaceFile, 'utf8');

  await previewEdit(page, 'display', 'block', 'grid', 'md');

  await expect(selected).toHaveCSS('display', 'grid');
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect(selected).toHaveCSS('display', 'block');
  await page.getByRole('button', { name: 'Desktop' }).click();
  await expect(selected).toHaveCSS('display', 'grid');
  expect(promotions).toEqual([]);
  expect(await readFile(workspaceFile, 'utf8')).toBe(sourceBefore);
});

test('routes an invalid direct request into conversation without promoting it', async ({
  page,
}) => {
  const promotions = watchPromotionRequests(page);
  const conversationMessages: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.endsWith('/conversation/messages')
    ) {
      conversationMessages.push(request.url());
    }
  });
  const { selected } = await openSelectedFixture(page);

  await previewEdit(page, 'backgroundColor', '#eee', 'url(javascript:x)');

  await expect(page.getByText('Edição direta inválida')).toBeVisible();
  await expect(page.getByText('visual-edit', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(selected).toHaveText('Simple');
  expect(conversationMessages).toHaveLength(1);
  expect(promotions).toEqual([]);
});
