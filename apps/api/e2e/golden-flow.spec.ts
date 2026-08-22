import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import type { AgentExecutor } from '@agent-foundry/domain';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  BrowserVerificationReport,
  ExecutorHealth,
  OperationKind,
  RouterDecisionLogEntry,
  TaskProfile,
} from '@agent-foundry/contracts';
import {
  BrowserVerificationReportSchema,
  CONTROL_SESSION_COOKIE,
  CONTROL_SESSION_CSRF_COOKIE,
  CONTROL_SESSION_CSRF_HEADER,
} from '@agent-foundry/contracts';
import { buildAuthenticatedApp } from '../src/authenticated-app.js';
import { reserveEphemeralPort, waitForHttp } from './support.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE_SCRIPT = resolve(REPO_ROOT, 'packages/executors/src/fixtures/preview-dev-server.mjs');
const REFERENCE_IMAGE = resolve(import.meta.dirname, 'fixtures/design-reference.png');
const UI_QUALITY_POLICY_ID = 'golden-flow-ui-quality-fixture';
const UI_QUALITY_POLICY_FIXTURE = resolve(
  import.meta.dirname,
  `fixtures/${UI_QUALITY_POLICY_ID}.yaml`,
);
const BUILDER_SCREENSHOT = resolve(
  REPO_ROOT,
  'test-results/issue-43-knowledge-builder-desktop.png',
);
const FIRST_BUILD_DIFF_SCREENSHOT = resolve(
  REPO_ROOT,
  'test-results/issue-173-first-build-diff.png',
);
const ROUTER_SCREENSHOT = resolve(REPO_ROOT, 'test-results/router-dashboard-desktop.png');
const HOME_SCREENSHOT = resolve(REPO_ROOT, 'test-results/home-desktop.png');
const VERSIONS_SCREENSHOT = resolve(REPO_ROOT, 'test-results/project-versions-desktop.png');
const BUILDER_MOBILE_SCREENSHOT = resolve(
  REPO_ROOT,
  'test-results/issue-97-builder-mobile-390.png',
);
const DECIDE_DIALOG_MOBILE_SCREENSHOT = resolve(
  REPO_ROOT,
  'test-results/issue-97-decide-dialog-mobile-390.png',
);
const CHANGES_MOBILE_SCREENSHOT = resolve(
  REPO_ROOT,
  'test-results/issue-97-changes-mobile-390.png',
);

/**
 * Whole-page axe scan. Until Task 7 this was scoped to
 * `[data-testid="preview-panel"]`, which never saw the chat pane, the alert
 * strip, the inspector, the home page or the router dashboard — four AA
 * violations shipped past it. The only standing exclusion is the previewed
 * `<iframe>`: it renders the fixture dev server's bare-text stand-in page
 * (packages/executors/src/fixtures/preview-dev-server.mjs), not app markup, so
 * it has no landmarks or `h1` by design.
 */
async function expectNoAxeViolations(page: Page, surface: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .exclude('[data-testid="preview-frame"]')
    // axe-core ships `target-size` (WCAG 2.5.8, the only wcag22a/wcag22aa
    // rule as of axe-core 4.12) with `enabled: false` in its metadata — but
    // that default only governs an *unscoped* run (no `runOnly`). Once
    // `withTags` sets `runOnly: {type:'tag', ...}`, axe's own rule-matching
    // (`matchTags` in axe-core's core/public/run.js) runs any rule whose
    // tags overlap the requested list regardless of its `enabled` default;
    // `enabled: false` is bypassed, not honoured. Verified empirically: with
    // and without the `.options()` call below, the `target-size` pass/fail
    // counts on every surface in this suite are byte-identical (38/31/10 on
    // builder/builder-mudancas/versions either way). The explicit enable is
    // therefore *defensive*, not required — a guard against axe ever
    // changing that `runOnly`-overrides-`enabled` behavior — and costs
    // nothing to keep. `options()` must still come *before* `withTags()` if
    // kept: it replaces `this.option` wholesale, so calling it after would
    // drop the `runOnly` tag filter `withTags` sets.
    .options({ rules: { 'target-size': { enabled: true } } })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      surface,
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

/**
 * At a 390px CSS width the document must not scroll horizontally, and the
 * surface's own primary action must stay reachable rather than sliding off
 * or getting clipped. Always leaves the viewport at 1440x900 on return — the
 * width every desktop assertion and axe scan that follows a probe call in
 * this suite assumes, same contract as the pre-existing 900px check below.
 *
 * `atNarrowViewport` runs after the assertions and before the viewport is
 * restored — for the callers that also want a 390px screenshot, so they don't
 * resize twice around the probe.
 */
async function expectNoHorizontalOverflow(
  page: Page,
  surface: string,
  primaryAction: Locator,
  atNarrowViewport?: () => Promise<void>,
): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${surface} overflows the 390px viewport: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
  await expect(primaryAction).toBeVisible();
  await atNarrowViewport?.();
  await page.setViewportSize({ width: 1440, height: 900 });
}

/**
 * Press Tab until `target` holds focus. Asserting on the *number* of presses
 * would encode the current control order, which is not the contract — the
 * contract is that the control is reachable at all, so `maxPresses` is a loop
 * bound, not an expected value.
 */
async function tabUntilFocused(
  page: Page,
  target: Locator,
  maxPresses: number,
  label: string,
): Promise<void> {
  let reached = false;
  for (let attempt = 0; attempt < maxPresses && !reached; attempt += 1) {
    await page.keyboard.press('Tab');
    reached = await target.evaluate((element) => element === document.activeElement);
  }
  expect(reached, `Tab never reached ${label}`).toBe(true);
}

/**
 * WCAG 2.4.7: a keyboard user must be able to see where focus is. Either an
 * outline or a box-shadow satisfies it — `FIELD` in lib/ui.ts uses the shadow
 * form and everything else leans on the UA outline, so accept either rather
 * than pinning the mechanism.
 */
async function expectVisibleFocus(target: Locator, label: string): Promise<void> {
  const style = await target.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { outline: computed.outlineStyle, boxShadow: computed.boxShadow };
  });
  expect(
    style.outline !== 'none' || style.boxShadow !== 'none',
    `${label} has no visible focus indicator: ${JSON.stringify(style)}`,
  ).toBe(true);
}

async function readWebVitals(page: Page): Promise<{
  ttfb: number;
  lcp: number | null;
  inp: number | null;
}> {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const vitals = (
      window as unknown as {
        __webVitals?: { lcp: number | null; inp: number | null };
      }
    ).__webVitals;
    return {
      ttfb: navigation ? navigation.responseStart - navigation.requestStart : 0,
      lcp: vitals?.lcp ?? null,
      inp: vitals?.inp ?? null,
    };
  });
}
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

/** Inspector panels stay mounted but hidden; open the tab before asserting on it. */
async function openInspectorTab(page: Page, label: string) {
  await page.getByRole('tab', { name: label }).click();
  await expect(page.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
}

/** Inspector itself (its tabs and the "Changes" region) is hidden by default
 * behind the "Avançado" toggle (#489); flip it on before touching Inspector. */
async function enableAdvancedMode(page: Page) {
  const toggle = page.getByRole('button', { name: 'Avançado' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

let runtime: Runtime;
let apiClose: () => Promise<void>;
let apiBaseUrl: string;
let apiCookie = '';
let apiCsrf = '';
let browserCookies: { name: string; value: string; httpOnly: boolean }[] = [];
let webProcess: ChildProcess;
let webBaseUrl: string;
const dirs: string[] = [];
// #548: EXECUTOR_MODE: 'real' below spawns the real ClaudeCliExecutor /
// CodexCliExecutor classes, which resolve the `claude` / `codex` command by
// name on PATH. The suite ran no agent step before the UI-quality judge
// policy below was added — golden-flow-e2e-v1.yaml has no 'agent' node —
// so nothing previously required these to resolve to anything at all.
// Prepending the checked-in fake CLIs (same fixtures fake-cli.integration.test.ts
// uses) makes this self-contained rather than depending on an external PATH.
const FAKE_CLI_DIR = resolve(REPO_ROOT, 'packages/executors/src/fixtures/fake-cli');
const originalPath = process.env.PATH;

test.beforeAll(async () => {
  process.env.PATH = `${FAKE_CLI_DIR}:${originalPath}`;
  const [dataDir, workflowsDir, policiesDir] = await Promise.all([
    mkdtemp(join(tmpdir(), 'agent-foundry-golden-e2e-data-')),
    mkdtemp(join(tmpdir(), 'agent-foundry-golden-e2e-wf-')),
    mkdtemp(join(tmpdir(), 'agent-foundry-golden-e2e-policies-')),
  ]);
  dirs.push(dataDir, workflowsDir, policiesDir);
  await writeFile(
    join(workflowsDir, 'golden-flow-e2e-v1.yaml'),
    await readFile(resolve(import.meta.dirname, 'fixtures/golden-flow-e2e-v1.yaml'), 'utf8'),
  );
  await Promise.all([
    // The 'default' policy every other test in this file relies on implicitly
    // (createProject's policyId default) — copied from the repo's checked-in
    // policies/default.yaml so overriding POLICIES_DIR below changes nothing
    // for them, and can't silently drift from it.
    writeFile(
      join(policiesDir, 'default.yaml'),
      await readFile(resolve(REPO_ROOT, 'policies/default.yaml'), 'utf8'),
    ),
    writeFile(
      join(policiesDir, `${UI_QUALITY_POLICY_ID}.yaml`),
      await readFile(UI_QUALITY_POLICY_FIXTURE, 'utf8'),
    ),
  ]);

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
      POLICIES_DIR: policiesDir,
      EXECUTOR_MODE: 'real',
      API_HOST: 'localhost',
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
  const { app, bootstrapUrl } = await buildAuthenticatedApp(runtime);
  app.post('/__control_session_probe__', async () => ({ ok: true }));
  await app.listen({ host: 'localhost', port: apiPort });
  apiBaseUrl = `http://localhost:${apiPort}`;
  apiClose = () => app.close();

  const mutation = { method: 'POST' } satisfies RequestInit;
  expect((await fetch(`${apiBaseUrl}/__control_session_probe__`, mutation)).status).toBe(401);

  const bootstrap = await fetch(bootstrapUrl, { redirect: 'manual' });
  expect(bootstrap.status).toBe(302);
  const cookiePairs = bootstrap.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .filter(Boolean);
  apiCookie = cookiePairs.join('; ');
  apiCsrf =
    cookiePairs
      .find((pair) => pair.startsWith(`${CONTROL_SESSION_CSRF_COOKIE}=`))
      ?.slice(CONTROL_SESSION_CSRF_COOKIE.length + 1) ?? '';
  browserCookies = cookiePairs.map((pair) => {
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    return {
      name,
      value: pair.slice(separator + 1),
      httpOnly: name === CONTROL_SESSION_COOKIE,
    };
  });
  expect((await apiFetch('/__control_session_probe__', mutation)).status).toBe(200);

  webProcess = spawn('npx', ['next', 'dev', '-p', String(webPort)], {
    cwd: resolve(REPO_ROOT, 'apps/web'),
    env: { ...process.env, NEXT_PUBLIC_API_URL: apiBaseUrl, PORT: String(webPort) },
    stdio: 'pipe',
  });
  await waitForHttp(webBaseUrl, 60_000);
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(
    browserCookies.map((cookie) => ({ ...cookie, url: apiBaseUrl, sameSite: 'Lax' })),
  );
});

test.afterAll(async () => {
  webProcess.kill();
  process.env.PATH = originalPath;
  await Promise.all([apiClose(), ...dirs.map((dir) => rm(dir, { recursive: true, force: true }))]);
});

async function createProject(policyId?: string): Promise<string> {
  const response = await apiFetch('/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Golden flow E2E',
      prd: 'x'.repeat(60),
      workflowId: 'golden-flow-e2e-v1',
      ...(policyId ? { policyId } : {}),
    }),
  });
  expect(response.status).toBe(202);
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cookie', apiCookie);
  headers.set(CONTROL_SESSION_CSRF_HEADER, apiCsrf);
  return fetch(`${apiBaseUrl}${path}`, { ...init, headers });
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

// Seeds RouterDecisionLogEntry rows directly through the repository port,
// the same way seedWorkspaceAndPlan seeds routeDecision artifact metadata via
// runtime.router.route() rather than driving a full workflow run: the golden
// -flow-e2e-v1.yaml fixture has no quality-loop node, so nothing here would
// ever produce a RouterDecisionLogEntry through a live run. Task 6's
// orchestrator instrumentation (does executeQualityLoopTraced actually call
// decisionLog.append) is covered by
// packages/orchestrator/src/quality-observation-integration.test.ts; this e2e
// only needs to prove the dashboard/decisions/export/experiment HTTP+browser
// surface (Tasks 7-8) render real decision-log content, including the
// repairs > 0 case.
async function seedRouterDecisions(projectId: string, runId: string): Promise<void> {
  const base = {
    schemaVersion: '1' as const,
    createdAt: new Date().toISOString(),
    projectId,
    runId,
    workflowId: 'golden-flow-e2e-v1',
    harnessVersion: await runtime.harness.version(),
  };
  const entries: RouterDecisionLogEntry[] = [
    {
      ...base,
      id: 'e2e-router-decision-1',
      routeId: 'e2e-router-route-1',
      nodeId: 'quality-loop',
      taskKind: 'implementation',
      category: 'implementation/frontend',
      role: 'developer',
      provider: 'claude',
      modelId: 'sonnet',
      model: 'claude-sonnet-5',
      approved: true,
      firstPass: true,
      repairs: 0,
      durationMs: 4_200,
      confidence: 0.92,
      sampleSize: 12,
    },
    {
      ...base,
      id: 'e2e-router-decision-2',
      routeId: 'e2e-router-route-2',
      nodeId: 'quality-loop',
      taskKind: 'repair',
      category: 'repair/integration',
      role: 'fixer',
      provider: 'codex',
      modelId: 'gpt-5-codex',
      model: 'gpt-5-codex',
      approved: true,
      firstPass: false,
      repairs: 2,
      durationMs: 9_800,
    },
    {
      ...base,
      id: 'e2e-router-decision-3',
      routeId: 'e2e-router-route-3',
      nodeId: 'quality-loop',
      taskKind: 'implementation',
      category: 'implementation/backend',
      role: 'developer',
      provider: 'codex',
      modelId: 'codex-large',
      model: 'codex-large-v1',
      approved: false,
      firstPass: false,
      repairs: 1,
      durationMs: 6_100,
    },
  ];
  for (const entry of entries) await runtime.decisionLog.append(entry);
}

async function getRun(projectId: string): Promise<{ id: string; status: string }> {
  const response = await apiFetch(`/projects/${projectId}`);
  const { project } = (await response.json()) as { project: { currentRunId: string } };
  const runResponse = await apiFetch(`/runs/${project.currentRunId}`);
  const { run } = (await runResponse.json()) as { run: { id: string; status: string } };
  return run;
}

async function stopProvisionedPreview(projectId: string): Promise<void> {
  const session = await runtime.previewService.activeForProject(projectId);
  if (session) await runtime.previewService.stop(session.id);
}

async function runConversationJob(
  projectId: string,
  kind: Extract<OperationKind, 'plan' | 'build' | 'visual-edit'>,
): Promise<void> {
  expect(await runtime.worker.runOnce()).toBe(true);
  const operation = (await runtime.conversations.listOperations(projectId))
    .filter((candidate) => candidate.kind === kind)
    .at(-1);
  if (!operation?.runId) throw new Error(`latest ${kind} operation has no run`);
  const run = await runtime.runs.get(operation.runId);
  if (run?.status !== 'completed') {
    throw new Error(
      `${kind} operation ${operation.id} did not complete: ${run?.status ?? 'run missing'} ${JSON.stringify(run?.error ?? null)}`,
    );
  }
  expect(operation.artifactReferences.length).toBeGreaterThan(0);
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
  const registry = runtime.executors as {
    get: () => AgentExecutor;
    health: () => Promise<ExecutorHealth[]>;
  };
  registry.get = () => executor;
  registry.health = () => executor.health().then((health) => [health]);
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
  const projectId = await createProject(UI_QUALITY_POLICY_ID);
  await seedWorkspaceAndPlan(projectId);
  expect(await runtime.worker.runOnce()).toBe(true);
  await stopProvisionedPreview(projectId);

  const run = await getRun(projectId);
  expect(run.status).toBe('awaiting_approval');

  // #548: the fixture policy's uiQualityJudge ran against the fake provider
  // CLI (packages/executors/src/fixtures/fake-cli/fake-cli-core.mjs) during
  // verify-browser above. Before that fixture learned the judge's output
  // schema, evaluateUiQuality always degraded to `undefined` here and this
  // field never landed on the report.
  const reportArtifact = await runtime.artifacts.getLatest(
    projectId,
    'browser-verification.report',
  );
  const report: BrowserVerificationReport = BrowserVerificationReportSchema.parse(
    reportArtifact?.content,
  );
  expect(report.approved).toBe(true);
  expect(report.uiQuality?.overallScore).toBeGreaterThanOrEqual(0.5);

  const firstBuildCommit = await runtime.workspaces.checkpoint(
    projectId,
    'golden-flow first build',
  );
  await runtime.projectVersionService.recordFromStep({
    projectId,
    runId: run.id,
    stepRunId: 'golden-flow-first-build-step',
    attemptId: 'golden-flow-first-build-attempt',
    commit: firstBuildCommit,
  });
  await expect(runtime.projectVersionService.list(projectId, 50)).resolves.toMatchObject([
    { runId: run.id, commit: firstBuildCommit },
  ]);

  // CLS budget (Task 4's perf-budgets.json): installed before navigation so
  // it catches every shift from first paint, not just ones after the test
  // starts polling. `hadRecentInput` shifts (e.g. the click-driven ones this
  // test does further down) don't count towards CLS by spec.
  await page.addInitScript(() => {
    const tracker = window as unknown as { __clsScore: number };
    tracker.__clsScore = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) tracker.__clsScore += shift.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });

    const vitals = window as unknown as {
      __webVitals: { lcp: number | null; inp: number | null };
    };
    vitals.__webVitals = { lcp: null, inp: null };
    if (PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')) {
      new PerformanceObserver((list) => {
        const entry = list.getEntries().at(-1);
        if (entry) vitals.__webVitals.lcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    }
    if (PerformanceObserver.supportedEntryTypes.includes('event')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          vitals.__webVitals.inp = Math.max(vitals.__webVitals.inp ?? 0, entry.duration);
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    }
  });

  await page.goto(`${webBaseUrl}/project/${projectId}`);
  // First visit to this route triggers Next dev's on-demand compile of the
  // project page (on top of the client-side data fetch); default 5s
  // assertion timeout is too tight for a cold compile.
  await expect(page.getByRole('button', { name: 'Avançado' })).toBeVisible({ timeout: 30_000 });

  // Keyboard-only pass, skip link + chat composer (DESIGN.md §7) — the one
  // flow the existing dialog/tablist keyboard assertions below never touch.
  // Must run before any `.click()` on this page: the "first Tab from page
  // load" assertion only means something on a page nothing has focused yet.
  const skipLink = page.getByRole('link', { name: 'Pular para o conteúdo' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expectVisibleFocus(skipLink, 'skip link');
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();

  // Tab from <main> until the composer's textarea gets focus.
  const chatInput = page.getByLabel('Mensagem');
  await tabUntilFocused(page, chatInput, 30, 'the chat composer textarea');

  // Keep tabbing until the send control — proves it's keyboard-reachable too.
  const sendButton = page.getByRole('button', { name: 'Enviar' });
  await tabUntilFocused(page, sendButton, 10, 'the send control');
  await expectVisibleFocus(sendButton, 'send control');

  // "Avançado" toggle responds to Space/Enter with `aria-pressed` flipping —
  // reset to 'false' before `enableAdvancedMode` below.
  const advancedToggle = page.getByRole('button', { name: 'Avançado' });
  await advancedToggle.focus();
  await expect(advancedToggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Space');
  await expect(advancedToggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(advancedToggle).toHaveAttribute('aria-pressed', 'false');

  // Simple view: chat pane + preview panel only, inspector still hidden.
  await expectNoHorizontalOverflow(
    page,
    'builder-simple',
    page.getByRole('button', { name: 'Enviar' }),
  );
  await enableAdvancedMode(page);
  // Advanced view adds the inspector rail (tabs, Mudanças/Router/Artefatos
  // panels) beside the chat pane and preview panel — the widest the builder
  // shell gets. Also covers chat-pane.tsx and conversation-list.tsx, named
  // in Task 3's audit list but never actually opened or measured there:
  // both are always-visible panes in this default view. Screenshot kept for
  // a visual check, not just the scrollWidth number — Task 3's clipping bug
  // was a rect-based-scan miss that only a screenshot caught.
  await mkdir(resolve(BUILDER_MOBILE_SCREENSHOT, '..'), { recursive: true });
  await expectNoHorizontalOverflow(
    page,
    'builder-advanced',
    page.getByRole('button', { name: 'Enviar' }),
    async () => {
      await page.screenshot({ path: BUILDER_MOBILE_SCREENSHOT, fullPage: true });
    },
  );
  await expect(page.getByRole('tab', { name: 'Mudanças' })).toBeVisible();
  await openInspectorTab(page, 'Mudanças');
  await expect(page.getByRole('heading', { name: 'Aprovações' })).toBeVisible();

  await openInspectorTab(page, 'Router');
  const routesPanel = page.getByTestId('router-decisions');
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
  await expect(routesPanel.getByTestId('route-card').locator('h4')).toHaveCount(3);

  await page.getByRole('button', { name: 'Iniciar preview' }).click();
  const iframe = page.getByTestId('preview-frame');
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
  await expect(page.getByTestId('screenshot-thumb').first()).toBeVisible();

  // Whole builder page: header, alert strip, chat pane, preview panel and the
  // inspector, with the preview panel's console/network/test tabs open.
  await expectNoAxeViolations(page, 'builder');

  await openInspectorTab(page, 'Artefatos');
  const screenshotArtifactButton = page
    .getByTestId('artifact-item')
    .filter({ hasText: 'browser-screenshot' })
    .first();
  await screenshotArtifactButton.click();
  await expect(page.getByTestId('artifact-modal').getByTestId('artifact-image')).toBeVisible();
  // Every prior axe scan runs between/before dialogs — `ICON_BTN` (the
  // modal's "Fechar" close control, its only usage in the app, from
  // components/overlay.tsx) was never actually on-screen during any of
  // them. Scan here, with this artifact-viewer dialog open, to cover it.
  await expectNoAxeViolations(page, 'builder/artifact-modal');

  // Keyboard pass, dialogs (DESIGN.md §7). Every dialog is a native <dialog>
  // opened with showModal(), so Escape dismisses it and focus returns to the
  // control that opened it — assert both rather than trusting the platform.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('artifact-modal')).toHaveCount(0);
  await expect(screenshotArtifactButton).toBeFocused();

  await screenshotArtifactButton.click();
  await expect(page.getByTestId('artifact-modal').getByTestId('artifact-image')).toBeVisible();
  // The close control is `aria-label="Fechar"` now; "×" was its accessible
  // name, which is not one. This path unmounts the dialog instead of letting
  // the UA close it, so focus return is the shell's unmount cleanup doing its
  // job, not the platform's — assert it here too.
  await page.getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByTestId('artifact-modal')).toHaveCount(0);
  await expect(screenshotArtifactButton).toBeFocused();

  // Keyboard pass, tablist (ARIA tabs pattern): arrows step and wrap, Home and
  // End jump to the ends.
  await page.getByRole('tab', { name: 'Atividade' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Execução' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('End');
  // Last tab is 'Arquivos' since #491 added it after 'Versões'.
  await expect(page.getByRole('tab', { name: 'Arquivos' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Atividade' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Atividade' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Scoped to the decide-modal's own heading: the live timeline ("Linha do
  // tempo") also renders an event whose message equals the node title
  // ("Human diff approval"), as a plain <p>, which collides with a bare
  // getByText match.
  await openInspectorTab(page, 'Mudanças');
  const decideModalHeading = page.getByRole('heading', { name: /Human diff approval/ });
  await page.getByRole('button', { name: 'approve' }).first().click();
  await expect(decideModalHeading).toBeVisible();
  await expect(page.getByTestId('artifact-modal').getByTestId('artifact-diff')).toContainText(
    'diff --git',
  );
  await expect(page.getByText('Nenhuma versão anterior para comparar.')).not.toBeVisible();
  await page.getByTestId('artifact-modal').screenshot({ path: FIRST_BUILD_DIFF_SCREENSHOT });

  // Task 3 deferred: DecideDialog's MODAL sizing (`w-[min(1000px,100%)]`
  // inside a `grid place-items-center` backdrop resolves against an
  // indefinite track) was claimed byte-identical to the inline
  // AgentArtifactView but never independently confirmed live. Probe it here
  // while it holds this decision's real diff content (an actual
  // `diff --git` header/hunk, not seeded fixture text).
  await mkdir(resolve(DECIDE_DIALOG_MOBILE_SCREENSHOT, '..'), { recursive: true });
  await expectNoHorizontalOverflow(
    page,
    'decide-dialog',
    page.getByRole('button', { name: /Confirmar approve/ }),
    async () => {
      await page
        .getByTestId('artifact-modal')
        .screenshot({ path: DECIDE_DIALOG_MOBILE_SCREENSHOT });
    },
  );

  await page.getByLabel('Decidido por').fill('e2e-reviewer');
  await page.getByRole('button', { name: /Confirmar approve/ }).click();
  await expect(decideModalHeading).not.toBeVisible();

  expect(await runtime.worker.runOnce()).toBe(true);
  const finalRun = await getRun(projectId);
  expect(finalRun.status).toBe('completed');

  // CLS budget: read the score accumulated over everything above — the tab
  // switches (Mudanças/Router), preview start + Tablet/Mobile iframe resize,
  // the console/network/test tabs, the artifact modal open/close, tablist
  // keyboard nav and the diff-approval dialog. Read from perf-budgets.json
  // rather than hardcoding the number so Task 4's budget stays the one
  // source of truth; logged unconditionally so a passing CI run still shows
  // the trend, not just a pass/fail.
  const perfBudgets = JSON.parse(
    await readFile(resolve(REPO_ROOT, 'perf-budgets.json'), 'utf8'),
  ) as {
    cls: { builder: number };
    webVitals: { builder: { ttfb: number; lcp: number; inp: number } };
  };
  const clsScore = await page.evaluate(
    () => (window as unknown as { __clsScore: number }).__clsScore,
  );
  console.log(`CLS builder: ${clsScore} (budget ${perfBudgets.cls.builder})`);
  expect(clsScore).toBeLessThanOrEqual(perfBudgets.cls.builder);

  const webVitals = await readWebVitals(page);
  console.log(
    `Web Vitals builder: TTFB ${webVitals.ttfb}ms, LCP ${webVitals.lcp ?? 'n/a'}ms, INP ${webVitals.inp ?? 'n/a'}ms`,
  );
  expect(webVitals.ttfb).toBeLessThanOrEqual(perfBudgets.webVitals.builder.ttfb);
  expect(webVitals.lcp).not.toBeNull();
  expect(webVitals.lcp!).toBeLessThanOrEqual(perfBudgets.webVitals.builder.lcp);
  expect(webVitals.inp).not.toBeNull();
  expect(webVitals.inp!).toBeLessThanOrEqual(perfBudgets.webVitals.builder.inp);

  // Replaces builder-shell-css.test.ts, which grepped globals.css for the grid
  // rules Task 5 deleted: below the lg breakpoint the three panes stack, and
  // long lines scroll inside their pane instead of widening the document.
  await page.setViewportSize({ width: 900, height: 900 });
  const chatBox = await page.getByTestId('pane-chat').boundingBox();
  const centerBox = await page.getByTestId('pane-center').boundingBox();
  expect(chatBox).not.toBeNull();
  expect(centerBox).not.toBeNull();
  expect(centerBox!.y).toBeGreaterThan(chatBox!.y + chatBox!.height - 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Second builder scan with the inspector on Mudanças: sibling tab panels are
  // `hidden`, so one scan only ever covers the panel that is open.
  await expectNoAxeViolations(page, 'builder/mudancas');

  // `/project/:id/versions` was the last surface still on the deleted
  // globals.css; it renders real versions here because the run above recorded
  // one.
  await page.goto(`${webBaseUrl}/project/${projectId}/versions`);
  await expect(page.getByRole('heading', { name: 'Histórico de versões' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('version-item').first()).toBeVisible();
  await mkdir(resolve(VERSIONS_SCREENSHOT, '..'), { recursive: true });
  await page.screenshot({ path: VERSIONS_SCREENSHOT, fullPage: true });
  await expectNoHorizontalOverflow(
    page,
    'versions',
    page.getByRole('button', { name: 'Comparar selecionadas' }),
  );
  await expectNoAxeViolations(page, 'versions');
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
  await stopProvisionedPreview(projectId);

  await page.goto(`${webBaseUrl}/project/${projectId}`);
  const regions = {
    chat: page.getByRole('region', { name: 'Chat' }),
    preview: page.getByRole('region', { name: 'Preview' }),
    changes: page.getByRole('region', { name: 'Changes' }),
  };
  await expect(regions.chat).toBeVisible({ timeout: 30_000 });
  await expect(regions.preview).toBeVisible();
  await enableAdvancedMode(page);
  await expect(regions.changes).toBeVisible();
  await openInspectorTab(page, 'Mudanças');
  const decideModalHeading = page.getByRole('heading', { name: /Human diff approval/ });
  await page.getByRole('button', { name: 'approve' }).first().click();
  await page.getByLabel('Decidido por').fill('golden-flow-reviewer');
  await page.getByRole('button', { name: /Confirmar approve/ }).click();
  await expect(decideModalHeading).not.toBeVisible();
  expect(await runtime.worker.runOnce()).toBe(true);
  await expect.poll(() => getRun(projectId)).toMatchObject({ status: 'completed' });
  const knowledgeReads = installGoldenFixtureExecutor();

  await page.getByLabel('Adicionar knowledge file').setInputFiles(REFERENCE_IMAGE);
  let knowledge = page.getByTestId('knowledge-file').filter({
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
  await runConversationJob(projectId, 'plan');
  await expect(
    regions.chat.getByTestId('operation-badge').filter({ hasText: 'plan, pending' }),
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
    regions.chat.getByTestId('operation-badge').filter({ hasText: 'plan, approved' }),
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
  await runConversationJob(projectId, 'build');
  await expect(
    regions.chat.getByTestId('operation-badge').filter({ hasText: 'build' }).last(),
  ).toBeVisible();
  const buildRequest = await latestOperationRequest(projectId, 'build');
  expect(buildRequest).toContain('- Workflow: conversation-build');
  expect(buildRequest).toContain(expectedKnowledgeContext);
  expect(knowledgeReads).toEqual(['plan', 'build']);

  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Iniciar preview' }).click();
  const iframe = page.getByTestId('preview-frame');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const src = await iframe.getAttribute('src');
  if (!src) throw new Error('preview iframe has no src');
  const fixtureUrl = new URL(src);
  fixtureUrl.pathname = `${fixtureUrl.pathname.replace(/\/$/, '')}/dom-source-map-fixture`;
  const iframeHandle = await page.waitForSelector('[data-testid="preview-frame"]');
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('preview iframe has no content frame');
  await frame.goto(fixtureUrl.toString());
  await page.getByRole('button', { name: 'Selecionar elemento' }).click();
  const selected = page.frameLocator('[data-testid="preview-frame"]').locator('#simple');
  await selected.click();
  // Scoped to the Preview region: the new Files tab (#491) also lists
  // 'src/Greeting.tsx' in Inspector, and a bare page-wide getByText now
  // matches both.
  await expect(regions.preview.getByText('src/Greeting.tsx')).toBeVisible();
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
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/preview\/[^/]+\/stop$/.test(new URL(response.url()).pathname),
    ),
    page.getByRole('button', { name: 'Parar preview' }).click(),
  ]);
  await runConversationJob(projectId, 'visual-edit');
  await expect.poll(() => readFile(greetingPath, 'utf8')).toContain("'#ddd'");

  const [visualVersion, baselineVersion] = await runtime.projectVersionService.list(projectId, 50);
  if (!visualVersion || !baselineVersion) throw new Error('golden versions were not recorded');
  const versionArticle = (commit: string, kind = 'run') =>
    page
      .getByTestId('version-item')
      .filter({ hasText: commit.slice(0, 7) })
      .filter({ has: page.getByText(kind, { exact: true }) });
  await openInspectorTab(page, 'Versões');
  await expect(versionArticle(baselineVersion.commit)).toBeVisible({ timeout: 30_000 });
  await expect(versionArticle(visualVersion.commit)).toBeVisible();
  await versionArticle(baselineVersion.commit).getByRole('checkbox').check();
  await versionArticle(visualVersion.commit).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Comparar selecionadas' }).click();
  await expect(page.getByTestId('version-diff')).toContainText("'#ddd'");
  // Second half of the deleted builder-shell-css.test.ts: the diff pane's own
  // `max-w-full overflow-x-auto`. Asserted here, with the Versões panel actually
  // visible — from the Mudanças tab the diff sits in a `hidden` panel and
  // contributes nothing to scrollWidth, so the check would be vacuous.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

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
  await runConversationJob(projectId, 'build');
  const rebuiltGreeting = await readFile(greetingPath, 'utf8');
  expect(rebuiltGreeting).toContain("'#eee'");
  expect(rebuiltGreeting).not.toContain("'#ddd'");
  await expect(readFile(buildSequencePath, 'utf8')).resolves.toBe('2\n');

  await expect.poll(() => runtime.projectVersionService.list(projectId, 50)).toHaveLength(5);
  const [rebuiltVersion] = await runtime.projectVersionService.list(projectId, 50);
  await expect(versionArticle(rebuiltVersion!.commit)).toBeVisible({ timeout: 30_000 });
  await openInspectorTab(page, 'Mudanças');
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
  // The lg shell is exactly one viewport tall, so the builder document must
  // not scroll — anything taller paints bare mesh below the panes. It regressed
  // once via the knowledge-file `sr-only` inputs: `position: absolute` with no
  // positioned ancestor resolves against the initial containing block, which
  // escapes both the chat scroller's and the pane's clip.
  expect(
    await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    })),
  ).toMatchObject({ scrollHeight: 1200, clientHeight: 1200 });
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

  // Real long content, not a freshly-seeded project: the Changes region
  // (still open from the Mudanças tab above) is showing this run's actual
  // commit hashes, the fixture's real absolute workspace path (in the "Open
  // in editor" vscode:// href) and the visual-edit diff. Task 3 found a
  // clipping bug a rect-based scan missed entirely and only a screenshot
  // caught, so check both here.
  await mkdir(resolve(CHANGES_MOBILE_SCREENSHOT, '..'), { recursive: true });
  await expectNoHorizontalOverflow(
    page,
    'changes',
    changes.getByRole('link', { name: 'Open in editor' }),
    async () => {
      await page.screenshot({ path: CHANGES_MOBILE_SCREENSHOT, fullPage: true });
    },
  );

  knowledge = page.getByTestId('knowledge-file').filter({
    hasText: 'design-reference.png',
  });
  await knowledge.getByRole('button', { name: 'Remover design-reference.png' }).click();
  await expect(page.getByText('Nenhum knowledge file ativo.')).toBeVisible();
});

test('router dashboard shows decisions and filters, an experiment can be registered, and export is PII-free', async ({
  page,
}) => {
  const projectId = await createProject();
  const run = await getRun(projectId);
  await seedRouterDecisions(projectId, run.id);

  const dashboardResponse = await apiFetch('/router/dashboard');
  expect(dashboardResponse.ok).toBe(true);
  const dashboard = (await dashboardResponse.json()) as {
    facets: { taskKinds: string[]; workflowIds: string[] };
    kpis: { sampleSize: number; avgRepairs: number | null };
  };
  expect(dashboard.facets.workflowIds).toContain('golden-flow-e2e-v1');
  expect(dashboard.facets.taskKinds).toEqual(expect.arrayContaining(['implementation', 'repair']));
  expect(dashboard.kpis.sampleSize).toBeGreaterThan(0);
  expect(dashboard.kpis.avgRepairs).not.toBeNull();
  expect(dashboard.kpis.avgRepairs as number).toBeGreaterThan(0);

  await page.goto(`${webBaseUrl}/router`);
  await expect(page.getByRole('heading', { name: 'Dashboard do router' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Aprovação de primeira')).toBeVisible();
  await expect(page.getByLabel('Tarefa')).toBeVisible();
  // Confirms the repairs > 0 decision-log row (Task 6's quality-loop
  // instrumentation branch) actually renders in the UI, not just in the API
  // response.
  await expect(page.getByText('2 reparo(s)')).toBeVisible();
  await page.screenshot({ path: ROUTER_SCREENSHOT, fullPage: true });
  await expectNoHorizontalOverflow(
    page,
    'router',
    page.getByRole('button', { name: 'Novo experimento' }),
  );
  await expectNoAxeViolations(page, 'router');

  const hypothesis = `E2E hypothesis ${Date.now()}`;
  // Experiment creation lives in a dialog now (DESIGN.md §5.4).
  await page.getByRole('button', { name: 'Novo experimento' }).click();
  await expect(page.getByTestId('new-experiment')).toBeVisible();
  await page.getByLabel('Hipótese').fill(hypothesis);
  await page.getByLabel('Limite').fill('0.65');
  await page.getByLabel('Amostras mínimas').fill('12');
  await page.getByRole('button', { name: 'Registrar experimento' }).click();
  await expect(page.getByText(hypothesis)).toBeVisible({ timeout: 10_000 });

  // expect(...).toBeVisible() above can resolve against the still-filled
  // <textarea>'s own live value before the POST that persists the
  // experiment has actually completed, so poll the API instead of reading
  // it once immediately.
  await expect
    .poll(
      async () => {
        const experimentsResponse = await apiFetch('/experiments');
        const { experiments } = (await experimentsResponse.json()) as {
          experiments: {
            hypothesis: string;
            stopRule: { threshold: number; minSamples: number };
          }[];
        };
        return experiments.find((experiment) => experiment.hypothesis === hypothesis)?.stopRule;
      },
      { timeout: 10_000 },
    )
    .toMatchObject({ threshold: 0.65, minSamples: 12 });

  const exportResponse = await apiFetch('/router/export');
  expect(exportResponse.ok).toBe(true);
  const { rows } = (await exportResponse.json()) as { rows: Record<string, unknown>[] };
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).not.toHaveProperty('projectId');
    expect(row).not.toHaveProperty('runId');
  }

  // Home page: the project list is non-empty by now, so the scan sees the
  // create form, the pipeline card and the ProjectCard grid.
  await page.goto(`${webBaseUrl}/`);
  await expect(page.getByRole('button', { name: 'Fundir projeto' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('project-card').first()).toBeVisible();
  await mkdir(resolve(HOME_SCREENSHOT, '..'), { recursive: true });
  await page.screenshot({ path: HOME_SCREENSHOT, fullPage: true });
  await expectNoHorizontalOverflow(
    page,
    'home',
    page.getByRole('button', { name: 'Fundir projeto' }),
  );
  await expectNoAxeViolations(page, 'home');
});

test('regression gate passes an unchanged report and fails one missing a baseline case', async () => {
  const baselinePath = resolve(REPO_ROOT, 'docs/baselines/v0.9-benchmark.json');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as { runs: unknown[] };
  expect(baseline.runs.length).toBeGreaterThan(1);

  const missingOneCase = { ...baseline, runs: baseline.runs.slice(1) };
  const [passResponse, failResponse] = await Promise.all([
    apiFetch('/router/regression-gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fresh: baseline }),
    }),
    apiFetch('/router/regression-gate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fresh: missingOneCase }),
    }),
  ]);

  expect(passResponse.ok).toBe(true);
  const { result: passResult } = (await passResponse.json()) as { result: { verdict: string } };
  expect(passResult.verdict).toBe('pass');

  expect(failResponse.ok).toBe(true);
  const { result: failResult } = (await failResponse.json()) as {
    result: { verdict: string; reasons: string[] };
  };
  expect(failResult.verdict).toBe('fail');
  expect(failResult.reasons.some((reason) => reason.includes('missing'))).toBe(true);
});
