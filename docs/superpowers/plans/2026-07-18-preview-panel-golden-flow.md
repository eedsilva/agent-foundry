# Preview Panel + Golden Flow E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a responsive preview panel in `apps/web` (viewport switching, runtime logs, browser console/network, test results) and add a real human diff-approval step to the golden flow, closing issue #34.

**Architecture:** No new domain concepts. Reuse existing project creation as the change-request entry point, existing `approval-gate` mechanics for diff approval, and existing artifact/preview contracts for evidence. Two small `apps/api` additions (a session-lookup route), one `workflows/web-app-v1.yaml` config change, and a new `PreviewPanel` component plus two modal extensions in `apps/web`. Full spec: `docs/superpowers/specs/2026-07-18-preview-panel-golden-flow-design.md`.

**Tech Stack:** Fastify (`apps/api`), Next.js App Router client components (`apps/web`), Zod contracts (`packages/contracts`), Vitest, Playwright (new: `@playwright/test` + `@axe-core/playwright` in `apps/api`, driving a real Next.js dev server + real Chromium for the golden-flow E2E).

## Global Constraints

- `apps/web` may depend on **only** `@agent-foundry/contracts` internally (`scripts/lib/architecture.mjs:5,28` — `ALLOWED_INTERNAL_DEPENDENCIES`, enforced by `npm run architecture:check`). It must never import `@agent-foundry/composition`, `@agent-foundry/persistence`, or any other internal package. This is why the E2E test (Task 8) lives under `apps/api`, not `apps/web`.
- No new `packages/contracts` schemas. Every new response shape reuses existing exported types (`PreviewSession`, `BrowserVerificationReport`, etc.).
- No Tailwind/shadcn or other UI framework. `apps/web` styles live in one file, `apps/web/app/globals.css`, hand-rolled CSS classes — follow that convention for all new UI.
- Pin any new `@playwright/test` devDependency to exactly `1.61.1` — `packages/executors/package.json:25` already resolves `playwright` to `1.61.1` (`package-lock.json:4448-4457`); two different Playwright versions in one repo is not acceptable.
- New test/tooling devDependencies (`@playwright/test`, `@axe-core/playwright`) go in `apps/api/package.json` only, not the root `package.json`.
- Vitest's root config (`vitest.config.ts:8`) only matches `**/*.test.ts` — all new Playwright spec files must use `.spec.ts` to avoid collision.

---

### Task 1: `GET /projects/:projectId/preview/active` endpoint

**Depends on:** nothing. Can run in parallel with Tasks 2 and 3.

**Files:**

- Modify: `apps/api/src/app.ts:395` (insert new route between the existing `POST /projects/:projectId/preview` handler ending at line 395 and the `POST /projects/:projectId/preview/:sessionId/stop` handler starting at line 397)
- Test: `apps/api/src/preview.test.ts`

**Interfaces:**

- Consumes: `runtime.previewSessions.listActive(): Promise<PreviewSessionRecord[]>` (`packages/domain/src/ports.ts:291`, impl `packages/persistence/src/preview-repositories.ts:95-108` — returns only non-terminal sessions, i.e. excludes `stopped`/`failed`/`expired`). `PreviewSessionRecord.session.workspaceRef.projectId` (`packages/contracts/src/preview.ts:61-67`) identifies which project a session belongs to. `PreviewSession.createdAt` is an ISO datetime string.
- Produces: `GET /projects/:projectId/preview/active` → `200 { session: PreviewSession | null }`. No new contracts export — the response is typed inline in `apps/web/lib/api.ts` in Task 3.

- [ ] **Step 1: Write the failing tests**

Open `apps/api/src/preview.test.ts`. After the existing `createStoredSession` helper (it creates a `status: 'stopped'` session), add a second helper for an active session, then a new `describe` block. Insert both right after the closing `}` of `createStoredSession` (currently ending at the line before `describe('preview routes', () => {`):

```ts
async function createActiveSession(runtime: Runtime, projectId: string): Promise<PreviewSession> {
  const now = new Date().toISOString();
  const session: PreviewSession = {
    id: `preview-active-${projectId}`,
    workspaceRef: { projectId, workspacePath: runtime.workspaces.workspacePath(projectId) },
    status: 'running',
    version: 1,
    url: `http://127.0.0.1/preview/preview-active-${projectId}/?token=test`,
    health: { state: 'healthy', consecutiveFailures: 0 },
    ttl: { seconds: 60 },
    restartCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  await runtime.previewSessions.create({ session, tokenDigest: 'a'.repeat(64) });
  return session;
}
```

Then, after the closing `});` of the existing `describe('preview routes', ...)` block (before `describe('preview reaper schedule', ...)`), add:

```ts
describe('GET /projects/:projectId/preview/active', () => {
  it('returns null when no session is active', async () => {
    const { baseUrl } = await startApi();
    const projectId = await createProject(baseUrl);

    const response = await fetch(`${baseUrl}/projects/${projectId}/preview/active`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: null });
  });

  it('returns the active session for a project', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const session = await createActiveSession(runtime, projectId);

    const response = await fetch(`${baseUrl}/projects/${projectId}/preview/active`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session });
  });

  it('does not return a stopped session', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    await createStoredSession(runtime, projectId);

    const response = await fetch(`${baseUrl}/projects/${projectId}/preview/active`);

    expect(await response.json()).toEqual({ session: null });
  });

  it("does not return another project's active session", async () => {
    const { baseUrl, runtime } = await startApi();
    const ownerId = await createProject(baseUrl);
    const otherId = await createProject(baseUrl);
    await createActiveSession(runtime, ownerId);

    const response = await fetch(`${baseUrl}/projects/${otherId}/preview/active`);

    expect(await response.json()).toEqual({ session: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/src/preview.test.ts -t "preview/active"`
Expected: FAIL — `404` or connection error, since the route doesn't exist yet.

- [ ] **Step 3: Add the route**

In `apps/api/src/app.ts`, insert this route immediately after the closing `});` of `POST /projects/:projectId/preview` (line 395) and before `app.post('/projects/:projectId/preview/:sessionId/stop', ...)` (line 397):

```ts
app.get('/projects/:projectId/preview/active', async (request) => {
  const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
  const active = await runtime.previewSessions.listActive();
  const projectSessions = active
    .filter((record) => record.session.workspaceRef.projectId === projectId)
    .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
  return { session: projectSessions[0]?.session ?? null };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/src/preview.test.ts`
Expected: PASS, all tests in the file including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/preview.test.ts
git commit -m "feat(api): resolve a project's active preview session for refresh-safe reattachment"
```

---

### Task 2: Add `diff-approval` gate to the default workflow

**Depends on:** nothing. Can run in parallel with Tasks 1 and 3.

**Files:**

- Modify: `workflows/web-app-v1.yaml` (insert a new node between `browser-verification` and `release-assessment`)
- Modify: `packages/persistence/src/workflow-repository.test.ts:19-27`

**Interfaces:**

- Consumes: `ApprovalGateStepSchema` (`packages/contracts/src/workflow.ts:88-119`) — `artifact` must be an artifact guaranteed to exist by an earlier node; `browser-verification`'s `check` step already produces `outputArtifact: browser-verification.report` (`workflows/web-app-v1.yaml`, existing `browser-verification` node).
- Produces: a `diff-approval` node whose `outputArtifact: diff.approval` later tasks can reference by name (`browser-verification.report`, the gate's `artifact`, is what Task 7's decide-modal extension checks for).

- [ ] **Step 1: Write the failing test**

In `packages/persistence/src/workflow-repository.test.ts`, update the existing node-id assertion (lines 19-27):

```ts
const workflow = await repository.get('web-app-v1');
expect(workflow.nodes.map((node) => node.id)).toEqual([
  'plan-gate',
  'architecture-gate',
  'implementation-gate',
  'deterministic-verification',
  'browser-verification',
  'diff-approval',
  'release-assessment',
]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/workflow-repository.test.ts`
Expected: FAIL — actual array has no `'diff-approval'` entry.

- [ ] **Step 3: Add the gate to the workflow**

In `workflows/web-app-v1.yaml`, find the end of the `browser-verification` node (its `approval:` block) immediately followed by the `release-assessment` node:

```yaml
    approval:
      artifact: browser-verification.report
      path: approved
      equals: true

  - id: release-assessment
```

Replace with:

```yaml
    approval:
      artifact: browser-verification.report
      path: approved
      equals: true

  - id: diff-approval
    type: approval-gate
    title: Human diff approval
    artifact: browser-verification.report
    outputArtifact: diff.approval

  - id: release-assessment
```

(`actions`/`onReject` are left at their schema defaults — `[approve, reject]` / `end` — matching the precedent `release-approval` node in `apps/api/src/approvals.test.ts`'s fixture workflow, which also omits them.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/workflow-repository.test.ts`
Expected: PASS. This also exercises `YamlWorkflowRepository`'s semantic dataflow validation (an artifact-availability check), confirming `diff-approval`'s `artifact: browser-verification.report` is satisfiable.

- [ ] **Step 5: Commit**

```bash
git add workflows/web-app-v1.yaml packages/persistence/src/workflow-repository.test.ts
git commit -m "feat: add a human diff-approval gate after browser verification"
```

---

### Task 3: `apps/web` preview API client functions

**Depends on:** nothing. Can run in parallel with Tasks 1 and 2.

**Files:**

- Modify: `apps/web/lib/api.ts`
- Test: `apps/web/lib/api.test.ts`

**Interfaces:**

- Consumes: existing `api<T>()` helper (`apps/web/lib/api.ts:23-37`); `PreviewSession`/`PreviewLogPage` types from `@agent-foundry/contracts`; the `GET /projects/:projectId/preview/active` route from Task 1 (contract only — this task's tests mock `fetch`, no live server needed).
- Produces: `getActivePreviewSession(projectId): Promise<{ session: PreviewSession | null }>`, `startPreview(projectId): Promise<{ session: PreviewSession; url: string }>`, `stopPreview(projectId, sessionId): Promise<{ session: PreviewSession }>`, `getPreviewLogs(projectId, sessionId, cursor?): Promise<PreviewLogPage>` — all consumed by Task 4's `PreviewPanel`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/api.test.ts`, after the existing `import` block, extend the type-only import from `'@agent-foundry/contracts'` (currently only `ProjectVersion`) and the function import from `'./api'`:

```ts
import type { PreviewLogPage, PreviewSession, ProjectVersion } from '@agent-foundry/contracts';
```

```ts
import {
  branchFromVersion,
  compareVersions,
  getActivePreviewSession,
  getArtifactBlobUrl,
  getPreviewLogs,
  listVersions,
  revertToVersion,
  setVersionProtected,
  startPreview,
  stopPreview,
} from './api';
```

Then append a new `describe` block at the end of the file:

```ts
const session: PreviewSession = {
  id: 'preview-1',
  workspaceRef: { projectId: 'project-1', workspacePath: '/tmp/project-1' },
  status: 'running',
  version: 1,
  url: 'http://localhost:4000/preview/preview-1/',
  health: { state: 'healthy', consecutiveFailures: 0 },
  ttl: { seconds: 1800 },
  restartCount: 0,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

describe('preview API client', () => {
  it('gets the active preview session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ session }));

    const result = await getActivePreviewSession('project-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/active',
      expect.anything(),
    );
    expect(result).toEqual({ session });
    fetchMock.mockRestore();
  });

  it('returns null when no session is active', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ session: null }));

    const result = await getActivePreviewSession('project-1');

    expect(result).toEqual({ session: null });
    fetchMock.mockRestore();
  });

  it('starts a preview session', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ session, url: session.url }, 202));

    const result = await startPreview('project-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual({ session, url: session.url });
    fetchMock.mockRestore();
  });

  it('stops a preview session', async () => {
    const stopped = { ...session, status: 'stopped' as const };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ session: stopped }, 202));

    const result = await stopPreview('project-1', 'preview-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/preview-1/stop',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual({ session: stopped });
    fetchMock.mockRestore();
  });

  it('gets preview logs without a cursor', async () => {
    const page: PreviewLogPage = { entries: [], nextCursor: 0 };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(page));

    const result = await getPreviewLogs('project-1', 'preview-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/preview-1/logs',
      expect.anything(),
    );
    expect(result).toEqual(page);
    fetchMock.mockRestore();
  });

  it('gets preview logs with a cursor', async () => {
    const page: PreviewLogPage = { entries: [], nextCursor: 5 };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(page));

    await getPreviewLogs('project-1', 'preview-1', 5);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/projects/project-1/preview/preview-1/logs?cursor=5',
      expect.anything(),
    );
    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/lib/api.test.ts`
Expected: FAIL — `getActivePreviewSession`, `startPreview`, `stopPreview`, `getPreviewLogs` are not exported from `./api`.

- [ ] **Step 3: Implement the client functions**

In `apps/web/lib/api.ts`, add `PreviewLogPage` and `PreviewSession` to the existing type-only import block (lines 1-19), inserted alphabetically:

```ts
import type {
  ApprovalConflictResponse,
  ApprovalListResponse,
  CreateModelOverrideRequest,
  CreateModelOverrideResponse,
  DecideApprovalRequest,
  DecideApprovalResponse,
  PreviewLogPage,
  PreviewSession,
  Project,
  ProjectDetailResponse,
  ProjectVersion,
  ResumeBlockedResponse,
  RetryPlanResponse,
  RetryStepRequest,
  RunDetailResponse,
  RuntimeInfoResponse,
  StoredArtifact,
  WorkflowDefinition,
  WorkflowRun,
} from '@agent-foundry/contracts';
```

Then append these functions after `getArtifactBlobUrl` (after line 169):

```ts
export function getActivePreviewSession(
  projectId: string,
): Promise<{ session: PreviewSession | null }> {
  return api<{ session: PreviewSession | null }>(
    `/projects/${encodeURIComponent(projectId)}/preview/active`,
  );
}

export function startPreview(projectId: string): Promise<{ session: PreviewSession; url: string }> {
  return api<{ session: PreviewSession; url: string }>(
    `/projects/${encodeURIComponent(projectId)}/preview`,
    { method: 'POST' },
  );
}

export function stopPreview(
  projectId: string,
  sessionId: string,
): Promise<{ session: PreviewSession }> {
  return api<{ session: PreviewSession }>(
    `/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(sessionId)}/stop`,
    { method: 'POST' },
  );
}

export function getPreviewLogs(
  projectId: string,
  sessionId: string,
  cursor?: number,
): Promise<PreviewLogPage> {
  const query = cursor !== undefined ? `?cursor=${cursor}` : '';
  return api<PreviewLogPage>(
    `/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(sessionId)}/logs${query}`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/web/lib/api.test.ts`
Expected: PASS, all tests including the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api.ts apps/web/lib/api.test.ts
git commit -m "feat(web): add preview session and log API client functions"
```

---

### Task 4: `PreviewPanel` component

**Depends on:** Task 3 (imports its client functions).

**Files:**

- Create: `apps/web/lib/browser-verification.ts`
- Test: `apps/web/lib/browser-verification.test.ts`
- Create: `apps/web/app/project/[id]/preview-panel.tsx`
- Modify: `apps/web/app/globals.css` (append new classes)

**Interfaces:**

- Consumes: `getActivePreviewSession`, `startPreview`, `getPreviewLogs`, `getArtifactBlobUrl` (Task 3 / existing); `PreviewSession`, `PreviewLogEntry`, `StoredArtifact`, `WorkflowRun`, `BrowserVerificationReport`, `BrowserVerificationReportSchema` from `@agent-foundry/contracts`.
- Produces: `latestBrowserVerificationReport(artifacts, runId): BrowserVerificationReport | null` (exported from `lib/browser-verification.ts`, reused by Task 7). `PreviewPanel({ projectId, run, artifacts })` and `VerificationReportView({ report, projectId })` (both exported from `preview-panel.tsx`; `VerificationReportView` is reused by Task 7's decide-modal extension).

**Note on test scope:** this repo has no jsdom/React Testing Library anywhere (`vitest.config.ts:9` sets `environment: 'node'` globally) and none is being added here — that's a real new dependency the roadmap's touchpoints don't call for, and the roadmap's own required test is the golden-flow E2E (Task 8), not component unit tests. Per TDD, the _pure logic_ extracted into `lib/browser-verification.ts` gets a real Vitest unit test in this task; the component's rendering behavior is proven end-to-end by Task 8's real-browser E2E.

- [ ] **Step 1: Write the failing test for the pure helper**

Create `apps/web/lib/browser-verification.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BrowserVerificationReport, StoredArtifact } from '@agent-foundry/contracts';
import { latestBrowserVerificationReport } from './browser-verification';

function reportArtifact(
  runId: string,
  revision: number,
  overrides: Partial<BrowserVerificationReport> = {},
): StoredArtifact {
  const report: BrowserVerificationReport = {
    schemaVersion: '1',
    approved: true,
    summary: 'ok',
    planArtifact: { name: 'browser-test.plan', revision: 1, sha256: 'a'.repeat(64) },
    previewSession: { sessionId: 'preview-1', status: 'stopped', evidence: { screenshots: [] } },
    steps: [],
    ...overrides,
  };
  return {
    metadata: {
      projectId: 'project-1',
      name: 'browser-verification.report',
      revision,
      contentType: 'application/json',
      createdAt: '2026-07-18T00:00:00.000Z',
      createdBy: 'test',
      runId,
      sha256: 'b'.repeat(64),
    },
    content: report,
  };
}

describe('latestBrowserVerificationReport', () => {
  it('returns null when no report exists for the run', () => {
    expect(latestBrowserVerificationReport([], 'run-1')).toBeNull();
  });

  it('ignores reports from other runs', () => {
    const artifacts = [reportArtifact('run-2', 1)];
    expect(latestBrowserVerificationReport(artifacts, 'run-1')).toBeNull();
  });

  it('returns the highest-revision report for the run', () => {
    const older = reportArtifact('run-1', 1, { summary: 'first' });
    const newer = reportArtifact('run-1', 2, { summary: 'second' });
    const result = latestBrowserVerificationReport([older, newer], 'run-1');
    expect(result?.summary).toBe('second');
  });

  it('ignores artifacts whose content does not match the report schema', () => {
    const malformed: StoredArtifact = {
      ...reportArtifact('run-1', 1),
      content: { not: 'a report' },
    };
    expect(latestBrowserVerificationReport([malformed], 'run-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/browser-verification.test.ts`
Expected: FAIL — `./browser-verification` module does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/web/lib/browser-verification.ts`:

```ts
import {
  BrowserVerificationReportSchema,
  type BrowserVerificationReport,
  type StoredArtifact,
} from '@agent-foundry/contracts';

export function latestBrowserVerificationReport(
  artifacts: StoredArtifact[],
  runId: string,
): BrowserVerificationReport | null {
  const candidates = artifacts.filter(
    (artifact) =>
      artifact.metadata.name === 'browser-verification.report' &&
      artifact.metadata.runId === runId &&
      BrowserVerificationReportSchema.safeParse(artifact.content).success,
  );
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((a, b) => (a.metadata.revision > b.metadata.revision ? a : b));
  return latest.content as BrowserVerificationReport;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/browser-verification.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Implement the PreviewPanel component**

Create `apps/web/app/project/[id]/preview-panel.tsx`:

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  BrowserVerificationReport,
  PreviewLogEntry,
  PreviewSession,
  StoredArtifact,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  getActivePreviewSession,
  getArtifactBlobUrl,
  getPreviewLogs,
  startPreview,
  stopPreview,
} from '../../../lib/api';
import { latestBrowserVerificationReport } from '../../../lib/browser-verification';

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: 1280, height: 800 },
  tablet: { label: 'Tablet', width: 768, height: 1024 },
  mobile: { label: 'Mobile', width: 375, height: 667 },
} as const;
type ViewportKey = keyof typeof VIEWPORTS;

const TERMINAL_SESSION_STATUSES = new Set(['stopped', 'failed', 'expired']);

export function VerificationReportView({
  report,
  projectId,
}: {
  report: BrowserVerificationReport;
  projectId: string;
}) {
  return (
    <div className="checksList">
      <p>{report.summary}</p>
      {report.steps.map((step) => (
        <details key={step.stepId} open={step.status === 'failed'}>
          <summary>
            <span className={`pill ${step.status}`}>{step.status}</span>
            {step.title} · {Math.round(step.durationMs)}ms
          </summary>
          {step.error ? <p className="errorBox">{step.error}</p> : null}
          {step.observations.length > 0 ? (
            <ul>
              {step.observations.map((observation, index) => (
                <li key={index}>
                  <code>{observation.kind}</code> {observation.message}
                  {observation.url ? <small> · {observation.url}</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ))}
      {report.previewSession.evidence.screenshots.length > 0 ? (
        <div className="screenshotFilmstrip">
          {report.previewSession.evidence.screenshots.map((shot) => (
            <figure key={`${shot.name}-${shot.revision}`}>
              <img
                src={getArtifactBlobUrl(projectId, shot.name, shot.revision)}
                alt={shot.stepId}
              />
              <figcaption className="hint">{shot.stepId}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {report.previewSession.evidence.trace ? (
        <a
          className="secondaryButton"
          href={getArtifactBlobUrl(
            projectId,
            report.previewSession.evidence.trace.name,
            report.previewSession.evidence.trace.revision,
          )}
        >
          Baixar trace
        </a>
      ) : null}
      {report.previewSession.evidence.video ? (
        <a
          className="secondaryButton"
          href={getArtifactBlobUrl(
            projectId,
            report.previewSession.evidence.video.name,
            report.previewSession.evidence.video.revision,
          )}
        >
          Baixar vídeo
        </a>
      ) : null}
    </div>
  );
}

export function PreviewPanel({
  projectId,
  run,
  artifacts,
}: {
  projectId: string;
  run: WorkflowRun | null;
  artifacts: StoredArtifact[];
}) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [viewport, setViewport] = useState<ViewportKey>('desktop');
  const [tab, setTab] = useState<'logs' | 'verification'>('logs');
  const [logs, setLogs] = useState<PreviewLogEntry[]>([]);
  const [panelError, setPanelError] = useState('');

  useEffect(() => {
    let active = true;
    setSessionLoaded(false);
    getActivePreviewSession(projectId)
      .then((result) => {
        if (active) setSession(result.session);
      })
      .catch((cause: unknown) => {
        if (active) setPanelError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setSessionLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!session || TERMINAL_SESSION_STATUSES.has(session.status)) return;
    let active = true;
    let cursor: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await getPreviewLogs(projectId, session.id, cursor);
        if (!active) return;
        if (page.entries.length > 0) {
          setLogs((current) => [...current, ...page.entries]);
          cursor = page.nextCursor;
        }
        timer = setTimeout(poll, 2_000);
      } catch (cause) {
        if (active) setPanelError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, session]);

  async function start() {
    try {
      setPanelError('');
      const { session: started } = await startPreview(projectId);
      setSession(started);
      setLogs([]);
    } catch (cause) {
      setPanelError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function stop() {
    if (!session) return;
    try {
      setPanelError('');
      const { session: stopped } = await stopPreview(projectId, session.id);
      setSession(stopped);
    } catch (cause) {
      setPanelError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const report = useMemo(
    () => (run ? latestBrowserVerificationReport(artifacts, run.id) : null),
    [artifacts, run],
  );

  return (
    <section className="panel previewPanel">
      <div className="panelHeader">
        <h2>Preview</h2>
        {session?.status ? (
          <span className={`pill ${session.status}`}>{session.status}</span>
        ) : null}
      </div>

      {panelError ? <p className="errorBox">{panelError}</p> : null}

      {!sessionLoaded ? (
        <p className="hint">Carregando…</p>
      ) : !session || TERMINAL_SESSION_STATUSES.has(session.status) ? (
        <button className="secondaryButton" onClick={() => void start()}>
          Iniciar preview
        </button>
      ) : (
        <>
          <div className="viewportSwitcher">
            {(Object.keys(VIEWPORTS) as ViewportKey[]).map((key) => (
              <button
                key={key}
                className={`secondaryButton${viewport === key ? ' active' : ''}`}
                onClick={() => setViewport(key)}
              >
                {VIEWPORTS[key].label}
              </button>
            ))}
            <button className="secondaryButton" onClick={() => void stop()}>
              Parar preview
            </button>
          </div>
          {session.url ? (
            <div className="previewFrameWrap">
              <iframe
                src={session.url}
                width={VIEWPORTS[viewport].width}
                height={VIEWPORTS[viewport].height}
                title="Preview do aplicativo"
              />
            </div>
          ) : (
            <p className="hint">Preview iniciando…</p>
          )}
        </>
      )}

      <div className="viewportSwitcher">
        <button
          className={`secondaryButton${tab === 'logs' ? ' active' : ''}`}
          onClick={() => setTab('logs')}
        >
          Logs de runtime
        </button>
        <button
          className={`secondaryButton${tab === 'verification' ? ' active' : ''}`}
          onClick={() => setTab('verification')}
        >
          Console, rede e testes
        </button>
      </div>

      {tab === 'logs' ? (
        logs.length === 0 ? (
          <p className="emptyState">Nenhum log de runtime ainda.</p>
        ) : (
          <pre className="previewLogPane">
            {logs.map((entry) => `[${entry.stream}] ${entry.message}`).join('\n')}
          </pre>
        )
      ) : !report ? (
        <p className="emptyState">Nenhuma verificação de navegador ainda para esta execução.</p>
      ) : (
        <VerificationReportView report={report} projectId={projectId} />
      )}
    </section>
  );
}
```

- [ ] **Step 6: Add supporting CSS**

Append to `apps/web/app/globals.css`:

```css
.viewportSwitcher {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin: 0.75rem 0;
}
.secondaryButton.active {
  border-color: var(--accent);
  color: var(--accent);
}
.previewFrameWrap {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1rem;
  background: rgba(0, 0, 0, 0.2);
}
.previewFrameWrap iframe {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: white;
  display: block;
}
.previewLogPane {
  max-height: 240px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 12px;
  padding: 0.75rem;
  font-size: 0.85rem;
}
.screenshotFilmstrip {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  padding-bottom: 0.5rem;
}
.screenshotFilmstrip img {
  height: 160px;
  border-radius: 8px;
  border: 1px solid var(--line);
}
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/web`
Expected: exits 0, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/browser-verification.ts apps/web/lib/browser-verification.test.ts apps/web/app/project/\[id\]/preview-panel.tsx apps/web/app/globals.css
git commit -m "feat(web): add PreviewPanel with viewport switching, logs, and verification evidence"
```

---

### Task 5: Mount `PreviewPanel` in the project page

**Depends on:** Task 4 (imports `PreviewPanel` from the file it creates). Must run after Task 4 — same file (`page.tsx`) as Tasks 6 and 7, so those three run sequentially, not in parallel.

**Files:**

- Modify: `apps/web/app/project/[id]/page.tsx`

**Interfaces:**

- Consumes: `PreviewPanel` from `./preview-panel` (Task 4). Existing `id`, `run`, `detail.artifacts` already in scope in `ProjectPage`.

- [ ] **Step 1: Add the import**

In `apps/web/app/project/[id]/page.tsx`, after the existing `model-overrides` import block (ending at line 47):

```tsx
import {
  agentStepTargets,
  executionEvidence,
  modelOverrideRequest,
  retryMode,
  retryRequest,
} from '../../../lib/model-overrides';
import { PreviewPanel } from './preview-panel';
```

- [ ] **Step 2: Mount the panel**

Find (around line 493-494):

```tsx
      {detail.project.error ? <p className="errorBox">{detail.project.error}</p> : null}
      {error ? <p className="errorBox">{error}</p> : null}

      {run?.status === 'paused' ? (
```

Replace with:

```tsx
      {detail.project.error ? <p className="errorBox">{detail.project.error}</p> : null}
      {error ? <p className="errorBox">{error}</p> : null}

      <PreviewPanel projectId={id} run={run ?? null} artifacts={detail.artifacts} />

      {run?.status === 'paused' ? (
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/web`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/project/\[id\]/page.tsx
git commit -m "feat(web): mount the preview panel on the project page"
```

---

### Task 6: Render blob artifacts (screenshots/trace/video) in the artifact modal

**Depends on:** Task 5 (same file, run sequentially after it).

**Files:**

- Modify: `apps/web/app/project/[id]/page.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**

- Consumes: `getArtifactBlobUrl` (existing, `apps/web/lib/api.ts:166-169`, already defined but previously unused by this file). `ArtifactMetadata.storage: 'inline' | 'blob' | undefined` and `ArtifactMetadata.contentType: string` (`packages/contracts/src/project.ts:30,45`).

- [ ] **Step 1: Import `getArtifactBlobUrl`**

In the existing `apps/web/lib/api` import block in `page.tsx` (lines 24-39), insert `getArtifactBlobUrl` alphabetically:

```tsx
import {
  decideApproval,
  createModelOverride,
  eventStreamUrl,
  getArtifact,
  getArtifactBlobUrl,
  getProject,
  getRetryPlan,
  getRunDetail,
  getRuntime,
  listApprovals,
  listWorkflows,
  pauseRun,
  resumeRun,
  retryProject,
  retryStep,
} from '../../../lib/api';
```

- [ ] **Step 2: Add the blob-rendering branch**

Find the artifact modal's content ternary (around lines 1049-1069):

```tsx
            ) : isVerificationReport(selected.content) ? (
              <div className="checksList">
                <p>{selected.content.summary}</p>
                {selected.content.commands.map((command, index) => (
                  <details key={`${command.name}-${index}`}>
                    <summary>
                      <span
                        className={`pill ${command.skipped ? 'skipped' : command.exitCode === 0 ? 'completed' : 'failed'}`}
                      >
                        {command.skipped ? 'skipped' : command.exitCode === 0 ? 'pass' : 'fail'}
                      </span>
                      {command.name} · {formatSeconds(command.durationMs)}
                    </summary>
                    {command.stdout ? <pre>{command.stdout}</pre> : null}
                    {command.stderr ? <pre>{command.stderr}</pre> : null}
                  </details>
                ))}
              </div>
            ) : (
              <pre>{artifactText(selected.content)}</pre>
            )}
```

Replace with:

```tsx
            ) : isVerificationReport(selected.content) ? (
              <div className="checksList">
                <p>{selected.content.summary}</p>
                {selected.content.commands.map((command, index) => (
                  <details key={`${command.name}-${index}`}>
                    <summary>
                      <span
                        className={`pill ${command.skipped ? 'skipped' : command.exitCode === 0 ? 'completed' : 'failed'}`}
                      >
                        {command.skipped ? 'skipped' : command.exitCode === 0 ? 'pass' : 'fail'}
                      </span>
                      {command.name} · {formatSeconds(command.durationMs)}
                    </summary>
                    {command.stdout ? <pre>{command.stdout}</pre> : null}
                    {command.stderr ? <pre>{command.stderr}</pre> : null}
                  </details>
                ))}
              </div>
            ) : selected.metadata.storage === 'blob' ? (
              <div className="blobPreview">
                {selected.metadata.contentType.startsWith('image/') ? (
                  <img
                    src={getArtifactBlobUrl(
                      detail.project.id,
                      selected.metadata.name,
                      selected.metadata.revision,
                    )}
                    alt={selected.metadata.name}
                  />
                ) : selected.metadata.contentType.startsWith('video/') ? (
                  <video
                    controls
                    src={getArtifactBlobUrl(
                      detail.project.id,
                      selected.metadata.name,
                      selected.metadata.revision,
                    )}
                  />
                ) : (
                  <p className="hint">Conteúdo binário ({selected.metadata.contentType}).</p>
                )}
                <a
                  className="secondaryButton"
                  href={getArtifactBlobUrl(
                    detail.project.id,
                    selected.metadata.name,
                    selected.metadata.revision,
                  )}
                  download
                >
                  Baixar
                </a>
              </div>
            ) : (
              <pre>{artifactText(selected.content)}</pre>
            )}
```

- [ ] **Step 3: Add supporting CSS**

Append to `apps/web/app/globals.css`:

```css
.blobPreview img,
.blobPreview video {
  max-width: 100%;
  border-radius: 12px;
  display: block;
  margin-bottom: 0.75rem;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/web`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/project/\[id\]/page.tsx apps/web/app/globals.css
git commit -m "feat(web): render blob-backed artifacts (screenshots, video) in the artifact modal"
```

(Rendering correctness for this branch is verified in Task 8's E2E, which opens a screenshot artifact from the list and asserts an `<img>` renders.)

---

### Task 7: Diff + evidence in the decide modal

**Depends on:** Task 6 (same file, run sequentially after it). Reuses `VerificationReportView` from Task 4 and `listVersions`/`compareVersions` (already existing in `apps/web/lib/api.ts`).

**Files:**

- Create: `apps/web/lib/diff-approval.ts`
- Test: `apps/web/lib/diff-approval.test.ts`
- Modify: `apps/web/app/project/[id]/page.tsx`

**Interfaces:**

- Consumes: `ProjectVersion` (`sequence`, `runId`, `id` fields — `packages/contracts/src/project-version.ts:14-29`), `listVersions(projectId): Promise<ProjectVersion[]>` (sorted newest-first by `sequence`, `apps/web/lib/api.ts:176-182` / `packages/persistence/src/project-version-repository.ts:59-63`), `compareVersions(projectId, from, to): Promise<{ diff: string }>` (`apps/web/lib/api.ts:184-192`), `VerificationReportView` and `latestBrowserVerificationReport`/`BrowserVerificationReportSchema` from Task 4.
- Produces: `findDiffApprovalVersions(versions, runId): { from: ProjectVersion | null; to: ProjectVersion | null }`, exported from `lib/diff-approval.ts`.

- [ ] **Step 1: Write the failing test for the pure helper**

Create `apps/web/lib/diff-approval.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ProjectVersion } from '@agent-foundry/contracts';
import { findDiffApprovalVersions } from './diff-approval';

function version(
  overrides: Partial<ProjectVersion> & { id: string; sequence: number },
): ProjectVersion {
  return {
    schemaVersion: '1',
    projectId: 'project-1',
    kind: 'run',
    commit: 'a'.repeat(40),
    artifacts: [],
    protected: false,
    version: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('findDiffApprovalVersions', () => {
  it('returns nulls when the run has no recorded version', () => {
    const versions = [version({ id: 'v1', sequence: 1, runId: 'other-run' })];
    expect(findDiffApprovalVersions(versions, 'run-1')).toEqual({ from: null, to: null });
  });

  it('finds the latest version for the run and the prior version before it', () => {
    const versions = [
      version({ id: 'v3', sequence: 3, runId: 'run-1' }),
      version({ id: 'v2', sequence: 2, runId: 'run-1' }),
      version({ id: 'v1', sequence: 1, runId: 'other-run' }),
    ];
    expect(findDiffApprovalVersions(versions, 'run-1')).toEqual({
      from: versions[2],
      to: versions[0],
    });
  });

  it('returns a null "from" when the run version has no predecessor', () => {
    const versions = [version({ id: 'v1', sequence: 1, runId: 'run-1' })];
    expect(findDiffApprovalVersions(versions, 'run-1')).toEqual({ from: null, to: versions[0] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/diff-approval.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/web/lib/diff-approval.ts`:

```ts
import type { ProjectVersion } from '@agent-foundry/contracts';

export function findDiffApprovalVersions(
  versions: ProjectVersion[],
  runId: string,
): { from: ProjectVersion | null; to: ProjectVersion | null } {
  const toIndex = versions.findIndex((version) => version.runId === runId);
  if (toIndex === -1) return { from: null, to: null };
  const to = versions[toIndex]!;
  const from = versions.slice(toIndex + 1).find((version) => version.runId !== runId) ?? null;
  return { from, to };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/diff-approval.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Wire the decide modal**

In `apps/web/app/project/[id]/page.tsx`:

Add to the `apps/web/lib/api` import block (from Task 6, now add `compareVersions`, `listVersions`):

```tsx
import {
  compareVersions,
  decideApproval,
  createModelOverride,
  eventStreamUrl,
  getArtifact,
  getArtifactBlobUrl,
  getProject,
  getRetryPlan,
  getRunDetail,
  getRuntime,
  listApprovals,
  listVersions,
  listWorkflows,
  pauseRun,
  resumeRun,
  retryProject,
  retryStep,
} from '../../../lib/api';
```

Add a new import after the `PreviewPanel` import (from Task 5):

```tsx
import { PreviewPanel, VerificationReportView } from './preview-panel';
import { findDiffApprovalVersions } from '../../../lib/diff-approval';
import { BrowserVerificationReportSchema } from '@agent-foundry/contracts';
```

Add new state, alongside the existing `decidePreview`/`decideError` state (after line 151's `const [decideError, setDecideError] = useState('');`):

```tsx
const [decideDiff, setDecideDiff] = useState<string | null>(null);
```

Add a new effect after the existing `useEffect` blocks (e.g. right after the `getRuntime` effect ending around line 248), keyed on `decideTarget`:

```tsx
useEffect(() => {
  setDecideDiff(null);
  if (
    !decideTarget ||
    !run ||
    decideTarget.request.artifact.name !== 'browser-verification.report'
  ) {
    return;
  }
  let active = true;
  listVersions(id)
    .then((versions) => {
      if (!active) return;
      const { from, to } = findDiffApprovalVersions(versions, run.id);
      if (!from || !to) {
        setDecideDiff('Nenhuma versão anterior para comparar.');
        return undefined;
      }
      return compareVersions(id, from.id, to.id).then((result) => {
        if (active) setDecideDiff(result.diff);
      });
    })
    .catch((cause: unknown) => {
      if (active) setDecideError(cause instanceof Error ? cause.message : String(cause));
    });
  return () => {
    active = false;
  };
}, [decideTarget, id, run]);
```

Add a memo for the evidence report, next to the existing `evidence`/`routes` memos (after line 259's `routes` memo):

```tsx
const decideReport = useMemo(() => {
  if (!decideTarget || decideTarget.request.artifact.name !== 'browser-verification.report') {
    return null;
  }
  const match = detail?.artifacts.find(
    (artifact) =>
      artifact.metadata.name === decideTarget.request.artifact.name &&
      artifact.metadata.revision === decideTarget.request.artifact.revision,
  );
  if (!match) return null;
  const parsed = BrowserVerificationReportSchema.safeParse(match.content);
  return parsed.success ? parsed.data : null;
}, [decideTarget, detail]);
```

Finally, in the decide-modal JSX, insert the diff/evidence view before the existing "Comentário" `<label>` (find, around line 972-974):

```tsx
            ) : (
              <p className="hint">Calculando consequências…</p>
            )}

            <label>
              {decideTarget.action === 'request-changes'
```

Replace with:

```tsx
            ) : (
              <p className="hint">Calculando consequências…</p>
            )}

            {decideTarget.request.artifact.name === 'browser-verification.report' ? (
              <div>
                {decideReport ? (
                  <VerificationReportView report={decideReport} projectId={detail.project.id} />
                ) : null}
                {decideDiff !== null ? (
                  <pre className="diffPane">
                    {decideDiff.split('\n').map((line, index) => (
                      <span
                        key={index}
                        className={
                          line.startsWith('+')
                            ? 'diffAdded'
                            : line.startsWith('-')
                              ? 'diffRemoved'
                              : undefined
                        }
                      >
                        {line}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p className="hint">Carregando diff…</p>
                )}
              </div>
            ) : null}

            <label>
              {decideTarget.action === 'request-changes'
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/web`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/diff-approval.ts apps/web/lib/diff-approval.test.ts apps/web/app/project/\[id\]/page.tsx
git commit -m "feat(web): show the code diff and verification evidence in the diff-approval decide modal"
```

---

### Task 8: Golden-flow E2E (Playwright + axe)

**Depends on:** Tasks 1, 2, 3, 4, 5, 6, 7 — this exercises the full stack. Run last.

**Why this lives under `apps/api`, not `apps/web`:** per Global Constraints, `apps/web` may only depend on `@agent-foundry/contracts` (`scripts/lib/architecture.mjs:5,28`). This test needs in-process access to `createRuntime`/`buildApp` (to seed artifacts directly and manually pump the worker between steps, exactly like `apps/api/src/approvals.test.ts` already does) — only `@agent-foundry/api` is allowed to depend on `@agent-foundry/composition`. The Next.js web app itself is launched as a real subprocess and driven purely through the browser.

**Files:**

- Modify: `apps/api/package.json` (new devDependencies + script)
- Create: `apps/api/e2e/tsconfig.json`
- Create: `apps/api/e2e/playwright.config.ts`
- Create: `apps/api/e2e/fixtures/golden-flow-e2e-v1.yaml`
- Create: `apps/api/e2e/golden-flow.spec.ts`

**Interfaces:**

- Consumes: `createRuntime`, `buildApp` (as in every existing `apps/api/src/*.test.ts`); `runtime.worker.runOnce(): Promise<boolean>` (`packages/orchestrator/src/worker-loop.ts`, proven pattern in `apps/api/src/approvals.test.ts:154` etc.); `runtime.artifacts.put(...)` (`packages/persistence/src/artifact-store.ts:40-54`); `runtime.workspaces.ensure(projectId)` (`packages/persistence/src/workspace-manager.ts:42`); `packages/executors/src/fixtures/preview-dev-server.mjs` (copied into the seeded workspace).
- Produces: nothing consumed elsewhere — this is the terminal verification task.

- [ ] **Step 1: Add devDependencies and the e2e script**

In `apps/api/package.json`, add to `devDependencies` (create the key if absent) and add a script:

```json
{
  "name": "@agent-foundry/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --clean --sourcemap",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "e2e": "playwright test --config e2e/playwright.config.ts"
  },
  "dependencies": {
    "@agent-foundry/composition": "0.1.0",
    "@agent-foundry/contracts": "0.1.0",
    "@agent-foundry/domain": "0.1.0",
    "@fastify/cors": "^11.1.0",
    "dotenv": "^17.2.2",
    "fastify": "^5.6.1",
    "zod": "^4.1.12"
  },
  "devDependencies": {
    "@axe-core/playwright": "^4.10.2",
    "@playwright/test": "1.61.1"
  }
}
```

Run: `npm install`
Expected: lockfile updates, no errors.

Run: `npx playwright install chromium`
Expected: downloads the Chromium binary (already run in CI, per `.github/workflows/ci.yml:120`, for the existing `packages/executors` browser-verifier tests).

- [ ] **Step 2: Isolate the e2e directory from the app's TypeScript program**

Create `apps/api/e2e/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["@playwright/test", "node"]
  },
  "include": ["**/*.ts"]
}
```

(`apps/api/tsconfig.json:8` has `"include": ["src/**/*.ts"]` — `apps/api/e2e/` is outside `src/`, so the root `npm run typecheck` project-reference build never touches it; this standalone tsconfig is only for editor/IDE support and running the suite directly.)

- [ ] **Step 3: Playwright config**

Create `apps/api/e2e/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
});
```

- [ ] **Step 4: Fixture workflow**

Create `apps/api/e2e/fixtures/golden-flow-e2e-v1.yaml`:

```yaml
schemaVersion: '1'
id: golden-flow-e2e-v1
name: Golden flow E2E fixture
description: Minimal real preview + real browser-verification + diff-approval pipeline for issue #34 E2E coverage.
stack: nextjs
nodes:
  - id: verify-browser
    type: verify
    title: Run the declarative browser test plan
    outputArtifact: browser-verification.report
    browserTestPlanArtifact: browser-test.plan
    scripts: []
    includeGitDiffCheck: false

  - id: diff-approval
    type: approval-gate
    title: Human diff approval
    artifact: browser-verification.report
    outputArtifact: diff.approval
```

This mirrors the shape of Task 2's production gate exactly (same node fields), so the E2E genuinely exercises the same gate being shipped to production — just without the preceding LLM-driven plan/architecture/implementation steps, which would be slow, costly, and nondeterministic in CI.

- [ ] **Step 5: The E2E test**

Create `apps/api/e2e/golden-flow.spec.ts`:

```ts
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from '../src/app.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE_SCRIPT = resolve(REPO_ROOT, 'packages/executors/src/fixtures/preview-dev-server.mjs');
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
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-golden-e2e-data-'));
  const workflowsDir = await mkdtemp(join(tmpdir(), 'agent-foundry-golden-e2e-wf-'));
  dirs.push(dataDir, workflowsDir);
  await writeFile(
    join(workflowsDir, 'golden-flow-e2e-v1.yaml'),
    await readFile(resolve(import.meta.dirname, 'fixtures/golden-flow-e2e-v1.yaml'), 'utf8'),
  );

  const apiPort = await reserveEphemeralPort();
  runtime = await createRuntime({
    ...process.env,
    REPO_ROOT,
    DATA_DIR: dataDir,
    WORKFLOWS_DIR: workflowsDir,
    EXECUTOR_MODE: 'real',
    API_HOST: '127.0.0.1',
    API_PORT: String(apiPort),
    WORKER_ID: 'golden-e2e-worker',
  });
  const app = await buildApp(runtime);
  apiBaseUrl = await app.listen({ host: '127.0.0.1', port: apiPort });
  apiClose = () => app.close();

  const webPort = await reserveEphemeralPort();
  webProcess = spawn('npx', ['next', 'dev', '-p', String(webPort)], {
    cwd: resolve(REPO_ROOT, 'apps/web'),
    env: { ...process.env, NEXT_PUBLIC_API_URL: apiBaseUrl, PORT: String(webPort) },
    stdio: 'pipe',
  });
  webBaseUrl = `http://127.0.0.1:${webPort}`;
  await waitForHttp(webBaseUrl, 60_000);
});

test.afterAll(async () => {
  webProcess.kill();
  await apiClose();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
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
  await runtime.artifacts.put({
    projectId,
    name: 'browser-test.plan',
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

test('golden flow: change request, preview, browser tests, diff approval, axe', async ({
  page,
}) => {
  const projectId = await createProject();
  await seedWorkspaceAndPlan(projectId);
  expect(await runtime.worker.runOnce()).toBe(true);

  const run = await getRun(projectId);
  expect(run.status).toBe('awaiting_approval');

  await page.goto(`${webBaseUrl}/project/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Aprovações' })).toBeVisible();

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

  const axeResults = await new AxeBuilder({ page }).include('.previewPanel').analyze();
  expect(axeResults.violations).toEqual([]);

  const screenshotArtifactButton = page
    .locator('.artifactList button')
    .filter({ hasText: 'browser-screenshot' })
    .first();
  await screenshotArtifactButton.click();
  await expect(page.locator('.artifactModal img')).toBeVisible();
  await page.getByRole('button', { name: '×' }).click();

  await page.getByRole('button', { name: 'approve' }).first().click();
  await expect(page.getByText('Human diff approval')).toBeVisible();
  await page.getByLabel('Decidido por').fill('e2e-reviewer');
  await page.getByRole('button', { name: /Confirmar approve/ }).click();
  await expect(page.getByText('Human diff approval')).not.toBeVisible();

  expect(await runtime.worker.runOnce()).toBe(true);
  const finalRun = await getRun(projectId);
  expect(finalRun.status).toBe('completed');
});
```

- [ ] **Step 6: Run the E2E test**

Run: `npm run e2e --workspace @agent-foundry/api`
Expected: PASS, 1 test. This is the plan's only step that boots real servers and a real browser end-to-end — allow several minutes for `next dev` compilation + real Chromium launch + real dev-server health checks.

If it fails, debug with `PWDEBUG=1 npm run e2e --workspace @agent-foundry/api` (Playwright inspector) rather than guessing — check `webProcess`'s stdio output (piped, so visible in the test runner's own output) for Next.js compile errors first, since those are the most common source of a blank page.

- [ ] **Step 7: Run the full existing test suite once more**

Run: `npm test`
Expected: PASS — confirms Tasks 1-7's changes didn't regress anything, and the new `.spec.ts`/`e2e/` files aren't picked up by Vitest.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/e2e package-lock.json
git commit -m "test(api): add real-browser golden-flow E2E covering preview, viewports, evidence, and diff approval"
```

---

## Final verification (after all tasks)

- [ ] Run `npm run check` (format, lint, architecture, roadmap, typecheck, unit tests, build) from the repo root — confirms the architecture boundary (Global Constraints) actually holds and nothing else regressed.
- [ ] Run `npm run dev:inline` and manually open `http://localhost:3000`, create a project, and click through to the project page once a run exists, to eyeball the panel in a real browser per this repo's UI-change verification convention — Task 8's E2E already proves the flow mechanically, this is a final human sanity check.
