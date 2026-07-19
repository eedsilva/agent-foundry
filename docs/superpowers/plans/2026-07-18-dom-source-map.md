# DOM Source Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user clicks an element in the live preview iframe, resolve that click to a small, explainable set of in-workspace source files/components (or gracefully degrade to a screenshot when that's not possible).

**Architecture:** An inert inspector script is injected by the reverse proxy (`apps/api/src/preview-proxy.ts`) into `text/html` preview responses. Once activated via `postMessage`, it captures DOM path/bounding-box/computed-style/React-fiber-derived source candidates on click and posts them back to the parent. A new orchestrator service re-validates candidate file paths against the project's workspace root (via a new domain-level containment guard), de-duplicates, and classifies the result as `resolved` / `ambiguous` / `unsupported`. `apps/web` renders accordingly, falling back to an on-demand Playwright screenshot (reusing the existing browser-verifier) when unsupported.

**Tech Stack:** TypeScript, Zod (contracts), Fastify (apps/api), Next.js/React (apps/web), Playwright (executors), Vitest (unit/integration), Playwright Test (e2e).

**Design doc:** `docs/superpowers/specs/2026-07-18-dom-source-map-design.md`

## Global Constraints

- Monorepo architecture is enforced by `npm run architecture:check` via `scripts/lib/architecture.mjs`'s `ALLOWED_INTERNAL_DEPENDENCIES` map. **`@agent-foundry/orchestrator` may only depend on `@agent-foundry/contracts` and `@agent-foundry/domain`** — never on `@agent-foundry/executors` or `@agent-foundry/persistence` directly. New cross-package capabilities (workspace path containment, screenshot capture) must be defined as interfaces in `@agent-foundry/domain` and implemented by the concrete packages; composition wires the concrete instance in.
- Every new/modified package must pass: `npm run format:check`, `npm run lint`, `npm run architecture:check`, `npm run typecheck`, `npm test`, `npm run build` (collectively `npm run check`).
- All new Zod schemas in `packages/contracts/src/preview.ts` follow the file's existing convention: `export const XxxSchema = z.object({...}).strict();` + `export type Xxx = z.infer<typeof XxxSchema>;`.
- Test files are colocated (`foo.ts` + `foo.test.ts`), using Vitest (`describe`/`it`/`expect`), run via `npx vitest run <path>` (root `vitest.config.ts` provides `@agent-foundry/*` aliases).
- No new npm dependencies — everything needed (Playwright, Zod, Fastify) is already installed.
- UI copy stays in Portuguese, matching the rest of `apps/web` (e.g. "Preview do aplicativo", "Iniciar preview").

---

### Task 1: Domain — workspace path containment guard

**Files:**
- Create: `packages/domain/src/workspace-paths.ts`
- Create: `packages/domain/src/workspace-paths.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces: `resolveWorkspaceRelativePath(workspaceRoot: string, candidatePath: string): string | null` — used by Task 8 (`PreviewSelectionService`) to validate untrusted, browser-reported file paths against a project's workspace root.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/src/workspace-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceRelativePath } from './workspace-paths.js';

describe('resolveWorkspaceRelativePath', () => {
  it('returns the relative path for a candidate inside the workspace', () => {
    expect(resolveWorkspaceRelativePath('/data/ws', 'src/App.tsx')).toBe('src/App.tsx');
  });

  it('accepts an absolute candidate that resolves inside the workspace', () => {
    expect(resolveWorkspaceRelativePath('/data/ws', '/data/ws/src/App.tsx')).toBe('src/App.tsx');
  });

  it.each(['../../etc/passwd', '/etc/passwd', '../secret', '../../data/other-ws/file.ts'])(
    'rejects an escaping candidate %j',
    (candidate) => {
      expect(resolveWorkspaceRelativePath('/data/ws', candidate)).toBeNull();
    },
  );

  it('rejects the workspace root itself (empty relative path)', () => {
    expect(resolveWorkspaceRelativePath('/data/ws', '/data/ws')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/domain/src/workspace-paths.test.ts`
Expected: FAIL — `Cannot find module './workspace-paths.js'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/domain/src/workspace-paths.ts`:

```ts
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Resolves a candidate file path (untrusted — e.g. reported by an
 * instrumented preview iframe) against a project's workspace root, returning
 * the workspace-relative path if it stays inside the workspace, or null if it
 * escapes (absolute outside the root, `..` traversal) or resolves to the
 * workspace root itself. Mirrors sandbox-runner.ts's isAllowed containment
 * check but on real host paths, since candidatePath may itself be absolute.
 */
export function resolveWorkspaceRelativePath(
  workspaceRoot: string,
  candidatePath: string,
): string | null {
  const absoluteRoot = resolve(workspaceRoot);
  const absoluteCandidate = resolve(absoluteRoot, candidatePath);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel;
}
```

Modify `packages/domain/src/index.ts` — add a line after the existing `export * from './sandbox-runner.js';`:

```ts
export * from './workspace-paths.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/domain/src/workspace-paths.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/workspace-paths.ts packages/domain/src/workspace-paths.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): add workspace path containment guard"
```

---

### Task 2: Domain — selection screenshot capturer port

**Files:**
- Modify: `packages/domain/src/ports.ts` (add interface after `BrowserVerifier`, ~line 345)

**Interfaces:**
- Produces: `SelectionScreenshotCapturer` interface — implemented by Task 4 (`PlaywrightBrowserVerifier`), consumed by Task 8 (`PreviewSelectionService`). Kept separate from `BrowserVerifier` so no existing implementer/mock of `BrowserVerifier` is forced to implement it.

- [ ] **Step 1: Add the interface (no test — this is a pure type addition; covered by Task 4/8's tests exercising it)**

Modify `packages/domain/src/ports.ts`. Find:

```ts
export interface BrowserVerifier {
  verify(
    input: {
      planArtifact: ArtifactReference;
      planContent: unknown;
      session: PreviewSessionReference;
      allowedOrigins: string[];
      evidencePolicy: BrowserEvidencePolicy;
    },
    signal: AbortSignal,
  ): Promise<{ report: BrowserVerificationReport; evidence: BrowserVerificationEvidence }>;
}
```

Insert immediately after it:

```ts

/**
 * On-demand, single-shot screenshot capture against a live preview session —
 * separate from BrowserVerifier's scheduled verify() flow, which requires a
 * full BrowserTestPlan/allowedOrigins/evidencePolicy. Used only for the
 * "unsupported selection" fallback (packages/orchestrator/src/preview-selection-service.ts).
 */
export interface SelectionScreenshotCapturer {
  captureSelectionScreenshot(input: {
    url: string;
    clip: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number };
  }): Promise<Buffer | null>;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b packages/domain --force --pretty false`
Expected: PASS (no consumers yet, pure addition)

- [ ] **Step 3: Commit**

```bash
git add packages/domain/src/ports.ts
git commit -m "feat(domain): add SelectionScreenshotCapturer port"
```

---

### Task 3: Contracts — preview selection schemas

**Files:**
- Modify: `packages/contracts/src/preview.ts` (append at end of file, after `BrowserVerificationReportSchema`)
- Modify: `packages/contracts/src/preview.test.ts` (append new `describe` block at end of file)

**Interfaces:**
- Produces: `PreviewSelectionCandidateSchema`/`PreviewSelectionCandidate`, `PreviewSelectionRequestSchema`/`PreviewSelectionRequest`, `PreviewSelectionResultSchema`/`PreviewSelectionResult` — consumed by Task 5 (client payload shape mirrored in the injected script), Task 8 (orchestrator service), Task 9 (apps/api route), Task 10 (apps/web client), Task 11 (apps/web UI).

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/preview.test.ts` (end of file):

```ts
describe('PreviewSelectionResultSchema', () => {
  const boundingBox = { x: 0, y: 0, width: 100, height: 20 };
  const computedStyle = { display: 'block' };

  it('accepts a resolved result with a file and no candidates/screenshot', () => {
    const result = PreviewSelectionResultSchema.parse({
      status: 'resolved',
      domPath: 'div[1]>span[1]',
      boundingBox,
      computedStyle,
      file: 'src/App.tsx',
    });
    expect(result.file).toBe('src/App.tsx');
  });

  it('rejects a resolved result missing file', () => {
    expect(() =>
      PreviewSelectionResultSchema.parse({
        status: 'resolved',
        domPath: 'div[1]',
        boundingBox,
        computedStyle,
      }),
    ).toThrow();
  });

  it('accepts an ambiguous result with 2+ candidates', () => {
    const result = PreviewSelectionResultSchema.parse({
      status: 'ambiguous',
      domPath: 'div[1]',
      boundingBox,
      computedStyle,
      candidates: ['src/Card.tsx', 'src/Button.tsx'],
    });
    expect(result.candidates).toHaveLength(2);
  });

  it('rejects an ambiguous result with fewer than 2 candidates', () => {
    expect(() =>
      PreviewSelectionResultSchema.parse({
        status: 'ambiguous',
        domPath: 'div[1]',
        boundingBox,
        computedStyle,
        candidates: ['src/Card.tsx'],
      }),
    ).toThrow();
  });

  it('rejects an unsupported result carrying a file', () => {
    expect(() =>
      PreviewSelectionResultSchema.parse({
        status: 'unsupported',
        domPath: 'div[1]',
        boundingBox,
        computedStyle,
        file: 'src/App.tsx',
      }),
    ).toThrow();
  });

  it('accepts an unsupported result with a screenshot artifact reference', () => {
    const result = PreviewSelectionResultSchema.parse({
      status: 'unsupported',
      domPath: 'div[1]',
      boundingBox,
      computedStyle,
      screenshot: { name: 'selection-42.png', revision: 1 },
    });
    expect(result.screenshot?.name).toBe('selection-42.png');
  });
});

describe('PreviewSelectionRequestSchema', () => {
  it('accepts a raw client payload with zero or more candidates', () => {
    const request = PreviewSelectionRequestSchema.parse({
      previewUrl: 'http://127.0.0.1:4000/preview/session-1/?token=abc',
      domPath: 'div[1]',
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      computedStyle: {},
      candidates: [{ fileName: 'src/App.tsx', line: 3, column: 5, componentName: 'App' }],
    });
    expect(request.candidates).toHaveLength(1);
  });
});
```

Add the three new type imports to the top of `packages/contracts/src/preview.test.ts`'s existing import block from `./preview.js` (whatever that import currently lists — add `PreviewSelectionRequestSchema` and `PreviewSelectionResultSchema` to it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/preview.test.ts`
Expected: FAIL — `PreviewSelectionResultSchema is not defined` / `PreviewSelectionRequestSchema is not defined`

- [ ] **Step 3: Write minimal implementation**

Append to `packages/contracts/src/preview.ts` (after the final line, `export type BrowserVerificationReport = z.infer<typeof BrowserVerificationReportSchema>;`):

```ts

export const PreviewSelectionCandidateSchema = z
  .object({
    fileName: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    componentName: z.string().min(1).optional(),
  })
  .strict();
export type PreviewSelectionCandidate = z.infer<typeof PreviewSelectionCandidateSchema>;

const PreviewSelectionBoundingBoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

const PreviewSelectionComputedStyleSchema = z
  .object({
    display: z.string().optional(),
    position: z.string().optional(),
    width: z.string().optional(),
    height: z.string().optional(),
    color: z.string().optional(),
    backgroundColor: z.string().optional(),
    fontSize: z.string().optional(),
    fontFamily: z.string().optional(),
  })
  .strict();

export const PreviewSelectionRequestSchema = z
  .object({
    previewUrl: z.string().min(1),
    domPath: z.string().min(1),
    boundingBox: PreviewSelectionBoundingBoxSchema,
    computedStyle: PreviewSelectionComputedStyleSchema,
    candidates: z.array(PreviewSelectionCandidateSchema),
  })
  .strict();
export type PreviewSelectionRequest = z.infer<typeof PreviewSelectionRequestSchema>;

export const PreviewSelectionResultSchema = z
  .object({
    status: z.enum(['resolved', 'ambiguous', 'unsupported']),
    domPath: z.string().min(1),
    boundingBox: PreviewSelectionBoundingBoxSchema,
    computedStyle: PreviewSelectionComputedStyleSchema,
    file: z.string().min(1).optional(),
    candidates: z.array(z.string().min(1)).optional(),
    screenshot: ArtifactReferenceSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'resolved' && !result.file) {
      context.addIssue({ code: 'custom', path: ['file'], message: 'resolved requires file' });
    }
    if (result.status !== 'resolved' && result.file) {
      context.addIssue({ code: 'custom', path: ['file'], message: 'Only resolved may set file' });
    }
    if (result.status === 'ambiguous' && (!result.candidates || result.candidates.length < 2)) {
      context.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'ambiguous requires 2+ candidates',
      });
    }
    if (result.status !== 'ambiguous' && result.candidates) {
      context.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Only ambiguous may set candidates',
      });
    }
    if (result.status !== 'unsupported' && result.screenshot) {
      context.addIssue({
        code: 'custom',
        path: ['screenshot'],
        message: 'Only unsupported may set screenshot',
      });
    }
  });
export type PreviewSelectionResult = z.infer<typeof PreviewSelectionResultSchema>;
```

Note: `screenshot` reuses `ArtifactReferenceSchema`, already imported at the top of `preview.ts` from `./run.js` — do not add a new import from `./project.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/preview.test.ts`
Expected: PASS (all tests, including the 7 new ones)

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/preview.ts packages/contracts/src/preview.test.ts
git commit -m "feat(contracts): add preview selection schemas"
```

---

### Task 4: Executors — on-demand selection screenshot

**Files:**
- Modify: `packages/executors/src/browser-verifier.ts`
- Modify: `packages/executors/src/browser-verifier.test.ts`

**Interfaces:**
- Consumes: nothing new (uses existing `chromium`, `ACTION_TIMEOUT_MS`, `SCREENSHOT_TIMEOUT_MS` already in the file).
- Produces: `PlaywrightBrowserVerifier.captureSelectionScreenshot(input): Promise<Buffer | null>` (implements `SelectionScreenshotCapturer` from Task 2) — consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Append to `packages/executors/src/browser-verifier.test.ts` (using whatever local fixture-server helper the file already uses to start a `text/html`-serving local server — if the existing test helpers only start the `preview-dev-server.mjs` fixture, add a minimal inline `http.createServer` for this test instead, since we just need a real page to screenshot):

```ts
import { createServer } from 'node:http';

describe('captureSelectionScreenshot', () => {
  it('returns a PNG buffer clipped to the given region', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body style="margin:0"><div style="width:50px;height:50px;background:red"></div></body></html>');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected AddressInfo');
    const verifier = new PlaywrightBrowserVerifier();
    try {
      const buffer = await verifier.captureSelectionScreenshot({
        url: `http://127.0.0.1:${address.port}/`,
        clip: { x: 0, y: 0, width: 50, height: 50 },
        viewport: { width: 200, height: 200 },
      });
      expect(buffer).not.toBeNull();
      expect(buffer?.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic bytes
    } finally {
      server.close();
    }
  });

  it('returns null when navigation fails', async () => {
    const verifier = new PlaywrightBrowserVerifier();
    const buffer = await verifier.captureSelectionScreenshot({
      url: 'http://127.0.0.1:1/', // nothing listens here
      clip: { x: 0, y: 0, width: 10, height: 10 },
      viewport: { width: 100, height: 100 },
    });
    expect(buffer).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/browser-verifier.test.ts -t captureSelectionScreenshot`
Expected: FAIL — `verifier.captureSelectionScreenshot is not a function`

- [ ] **Step 3: Write minimal implementation**

Modify `packages/executors/src/browser-verifier.ts`. Change the class declaration:

```ts
export class PlaywrightBrowserVerifier implements BrowserVerifier {
```

to:

```ts
export class PlaywrightBrowserVerifier implements BrowserVerifier, SelectionScreenshotCapturer {
```

Add `SelectionScreenshotCapturer` to the `@agent-foundry/domain` import block at the top of the file (alongside `RunCancelledError`, `BrowserVerificationEvidence`, `BrowserVerifier`, `CapturedScreenshot`).

Add a new public method to the class, right before the existing private `captureScreenshot` method:

```ts
  /** On-demand, single-shot screenshot against a live preview session — not
   * the scheduled verify() flow. Launches its own short-lived browser/context,
   * navigates once, and screenshots the given viewport-relative clip.
   * ponytail: no route()/permitted() policy enforcement here — this only ever
   * navigates to the caller-supplied, already-authorized preview session URL
   * (validated by the caller against its own session record before this is
   * invoked). Revisit if ever exposed to a caller-supplied arbitrary URL. */
  async captureSelectionScreenshot(input: {
    url: string;
    clip: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number };
  }): Promise<Buffer | null> {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: input.viewport });
      const page = await context.newPage();
      await page.goto(input.url, { timeout: ACTION_TIMEOUT_MS });
      return await page.screenshot({
        type: 'png',
        clip: input.clip,
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
    } catch {
      return null; // best-effort: the UI degrades to "no screenshot" rather than failing selection
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/browser-verifier.test.ts -t captureSelectionScreenshot`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full file's tests to confirm no regression**

Run: `npx vitest run packages/executors/src/browser-verifier.test.ts`
Expected: PASS (all tests, existing + 2 new)

- [ ] **Step 6: Commit**

```bash
git add packages/executors/src/browser-verifier.ts packages/executors/src/browser-verifier.test.ts
git commit -m "feat(executors): add on-demand selection screenshot capture"
```

---

### Task 5: apps/api — fiber-walk pure functions

**Files:**
- Create: `apps/api/src/preview-inspector-fiber-walk.ts`
- Create: `apps/api/src/preview-inspector-fiber-walk.test.ts`

**Interfaces:**
- Produces: `findReactFiber(node: unknown): FiberLike | null`, `walkFiberCandidates(fiber: FiberLike | null): SelectionCandidate[]`, and the `FiberLike`/`SelectionCandidate` types — consumed by Task 6 (embedded verbatim into the injected browser script via `.toString()`).
- These are plain functions with no Node-only APIs (no imports), by design, so they run correctly both in this test (Node) and when injected into a browser via `.toString()`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/preview-inspector-fiber-walk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findReactFiber, walkFiberCandidates, type FiberLike } from './preview-inspector-fiber-walk.js';

describe('findReactFiber', () => {
  it('finds a fiber attached under a __reactFiber$ prefixed key', () => {
    const fiber: FiberLike = { type: 'div', return: null };
    const node = { __reactFiber$abc123: fiber };
    expect(findReactFiber(node)).toBe(fiber);
  });

  it('returns null for a node with no react fiber key (generated/non-React element)', () => {
    expect(findReactFiber({ foo: 'bar' })).toBeNull();
    expect(findReactFiber(null)).toBeNull();
  });
});

describe('walkFiberCandidates', () => {
  it('resolves a simple component to a single candidate', () => {
    const fiber: FiberLike = {
      type: { name: 'Greeting' },
      return: null,
      _debugSource: { fileName: 'src/Greeting.tsx', lineNumber: 4, columnNumber: 3 },
    };
    expect(walkFiberCandidates(fiber)).toEqual([
      { fileName: 'src/Greeting.tsx', line: 4, column: 3, componentName: 'Greeting' },
    ]);
  });

  it('reports two distinct candidates for a wrapper around a named component', () => {
    const inner: FiberLike = {
      type: { name: 'Button' },
      return: null,
      _debugSource: { fileName: 'src/Button.tsx', lineNumber: 8, columnNumber: 5 },
    };
    const wrapper: FiberLike = {
      type: { name: 'Card' },
      return: inner,
      _debugSource: { fileName: 'src/Card.tsx', lineNumber: 12, columnNumber: 3 },
    };
    expect(walkFiberCandidates(wrapper)).toEqual([
      { fileName: 'src/Card.tsx', line: 12, column: 3, componentName: 'Card' },
      { fileName: 'src/Button.tsx', line: 8, column: 5, componentName: 'Button' },
    ]);
  });

  it('collapses adjacent frames sharing the same file+line (e.g. a memo wrapper)', () => {
    const outer: FiberLike = {
      type: { name: 'ListItem' },
      return: null,
      _debugSource: { fileName: 'src/ListItem.tsx', lineNumber: 6, columnNumber: 2 },
    };
    const memoWrapper: FiberLike = {
      type: 'ListItem', // React.memo's outer fiber shares the inner's source location
      return: outer,
      _debugSource: { fileName: 'src/ListItem.tsx', lineNumber: 6, columnNumber: 2 },
    };
    expect(walkFiberCandidates(memoWrapper)).toEqual([
      { fileName: 'src/ListItem.tsx', line: 6, column: 2, componentName: undefined },
    ]);
  });

  it('resolves two different list-item clicks to the same single candidate', () => {
    const itemAt = (): FiberLike => ({
      type: { name: 'ListItem' },
      return: null,
      _debugSource: { fileName: 'src/ListItem.tsx', lineNumber: 6, columnNumber: 2 },
    });
    expect(walkFiberCandidates(itemAt())).toEqual(walkFiberCandidates(itemAt()));
  });

  it('returns no candidates when there is no fiber (generated/non-React element)', () => {
    expect(walkFiberCandidates(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/preview-inspector-fiber-walk.test.ts`
Expected: FAIL — `Cannot find module './preview-inspector-fiber-walk.js'`

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/preview-inspector-fiber-walk.ts`:

```ts
// Runs both in Node (tested here) and, via .toString(), inside the injected
// browser inspector script (preview-inspector-script.ts) — no imports, no
// Node-only or DOM-only APIs beyond plain object/array operations.

export interface FiberLike {
  type?: { name?: string; displayName?: string } | string;
  return?: FiberLike | null;
  _debugSource?: { fileName: string; lineNumber: number; columnNumber: number };
}

export interface SelectionCandidate {
  fileName: string;
  line: number;
  column: number;
  componentName?: string;
}

export function findReactFiber(node: unknown): FiberLike | null {
  if (typeof node !== 'object' || node === null) return null;
  const key = Object.keys(node).find((candidateKey) => candidateKey.startsWith('__reactFiber$'));
  if (!key) return null;
  return (node as Record<string, unknown>)[key] as FiberLike;
}

export function walkFiberCandidates(fiber: FiberLike | null): SelectionCandidate[] {
  const candidates: SelectionCandidate[] = [];
  let current: FiberLike | null | undefined = fiber;
  while (current) {
    const source = current._debugSource;
    if (source) {
      const componentName =
        typeof current.type === 'string'
          ? undefined
          : (current.type?.displayName ?? current.type?.name);
      const last = candidates[candidates.length - 1];
      const isDuplicateOfLast =
        last !== undefined && last.fileName === source.fileName && last.line === source.lineNumber;
      if (!isDuplicateOfLast) {
        candidates.push({
          fileName: source.fileName,
          line: source.lineNumber,
          column: source.columnNumber,
          componentName,
        });
      }
    }
    current = current.return ?? null;
  }
  return candidates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/preview-inspector-fiber-walk.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/preview-inspector-fiber-walk.ts apps/api/src/preview-inspector-fiber-walk.test.ts
git commit -m "feat(api): add pure React fiber-walk source resolution"
```

---

### Task 6: apps/api — inspector script builder

**Files:**
- Create: `apps/api/src/preview-inspector-script.ts`
- Create: `apps/api/src/preview-inspector-script.test.ts`

**Interfaces:**
- Consumes: `findReactFiber`, `walkFiberCandidates` from Task 5 (embedded via `.toString()`).
- Produces: `buildInspectorScript(parentOrigin: string): string` — a `<script>`-ready JS string — consumed by Task 7 (`preview-proxy.ts`'s HTML injection).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/preview-inspector-script.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildInspectorScript } from './preview-inspector-script.js';

describe('buildInspectorScript', () => {
  it('embeds the given parent origin as a JSON string literal', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script).toContain('"https://app.example.com"');
  });

  it('embeds the fiber-walk function source so it is self-contained', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script).toContain('function findReactFiber');
    expect(script).toContain('function walkFiberCandidates');
  });

  it('wires up the af:selection:start / af:selection:result message contract', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script).toContain('af:selection:start');
    expect(script).toContain('af:selection:result');
  });

  it('is wrapped in an IIFE so it never leaks globals into the preview page', () => {
    const script = buildInspectorScript('https://app.example.com');
    expect(script.trim().startsWith('(function()')).toBe(true);
    expect(script.trim().endsWith('})();')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/preview-inspector-script.test.ts`
Expected: FAIL — `Cannot find module './preview-inspector-script.js'`

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/preview-inspector-script.ts`:

```ts
import { findReactFiber, walkFiberCandidates } from './preview-inspector-fiber-walk.js';

const COMPUTED_STYLE_PROPERTIES = [
  'display',
  'position',
  'width',
  'height',
  'color',
  'backgroundColor',
  'fontSize',
  'fontFamily',
] as const;

/**
 * Builds the inline inspector script injected into preview HTML responses
 * (preview-proxy.ts). It is inert until the parent posts an
 * "af:selection:start" message, then captures the next click's DOM path,
 * bounding box, a fixed allow-list of computed style properties, and
 * React-fiber-derived source candidates, posting them back as
 * "af:selection:result". Both directions are origin-checked against
 * parentOrigin. findReactFiber/walkFiberCandidates are embedded via
 * .toString() so the browser-executed logic is identical to what
 * preview-inspector-fiber-walk.test.ts exercises in Node.
 */
export function buildInspectorScript(parentOrigin: string): string {
  return `(function() {
${findReactFiber.toString()}
${walkFiberCandidates.toString()}
var PARENT_ORIGIN = ${JSON.stringify(parentOrigin)};
var STYLE_PROPS = ${JSON.stringify(COMPUTED_STYLE_PROPERTIES)};
var selecting = false;
window.addEventListener('message', function (event) {
  if (event.origin !== PARENT_ORIGIN) return;
  if (event.data && event.data.type === 'af:selection:start') selecting = true;
});
function buildDomPath(node) {
  var parts = [];
  var el = node;
  while (el && el.tagName && parts.length < 20) {
    var index = 1;
    var sibling = el;
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === el.tagName) index++;
    }
    parts.unshift(el.tagName.toLowerCase() + '[' + index + ']');
    el = el.parentElement;
  }
  return parts.join('>');
}
document.addEventListener(
  'click',
  function (event) {
    if (!selecting) return;
    event.preventDefault();
    event.stopPropagation();
    selecting = false;
    var target = event.target;
    var fiber = findReactFiber(target);
    var candidates = walkFiberCandidates(fiber);
    var rect = target.getBoundingClientRect();
    var computed = window.getComputedStyle(target);
    var computedStyle = {};
    for (var i = 0; i < STYLE_PROPS.length; i++) {
      computedStyle[STYLE_PROPS[i]] = computed[STYLE_PROPS[i]];
    }
    var payload = {
      domPath: buildDomPath(target),
      boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      computedStyle: computedStyle,
      candidates: candidates,
    };
    window.parent.postMessage({ type: 'af:selection:result', payload: payload }, PARENT_ORIGIN);
  },
  true,
);
})();`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/preview-inspector-script.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/preview-inspector-script.ts apps/api/src/preview-inspector-script.test.ts
git commit -m "feat(api): build the injectable preview inspector script"
```

---

### Task 7: apps/api — inject the inspector script into proxied HTML

**Files:**
- Modify: `apps/api/src/preview-proxy.ts`
- Modify: `apps/api/src/preview-proxy.test.ts`

**Interfaces:**
- Consumes: `buildInspectorScript` from Task 6.
- Produces: proxied `text/html` responses now carry the inspector script; all other content-types are untouched (verified by test).

- [ ] **Step 1: Write the failing test**

`apps/api/src/preview-proxy.test.ts` already has `startApi()` (spins up a real listening API with a temp `DATA_DIR`, `EXECUTOR_MODE: 'mock'`) and `startPreview(baseUrl, runtime, id)` (creates a project, writes the `preview-dev-server.mjs` fixture as the workspace's `server.mjs`, POSTs `/projects/:id/preview`, returns `{ session, url }`, and registers cleanup). `preview-dev-server.mjs` only serves `text/plain`, so this test writes its own tiny HTML-serving fixture script directly, reusing `startApi()` but not `startPreview()`. Add:

```ts
describe('inspector script injection', () => {
  async function startPreviewWithHtmlFixture(
    baseUrl: string,
    runtime: Runtime,
    script: string,
    id: string,
  ) {
    const projectResponse = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Inject ${id}`, prd: 'x'.repeat(60) }),
    });
    const { project } = (await projectResponse.json()) as { project: { id: string } };
    await runtime.workspaces.ensure(project.id);
    const workspacePath = runtime.workspaces.workspacePath(project.id);
    await writeFile(join(workspacePath, 'server.mjs'), script);
    await writeFile(
      join(workspacePath, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
    );
    const startResponse = await fetch(`${baseUrl}/projects/${project.id}/preview`, {
      method: 'POST',
    });
    const started = (await startResponse.json()) as { session: { id: string }; url: string };
    cleanups.push(() => runtime.previewService.stop(started.session.id).then(() => undefined));
    return started;
  }

  const HTML_FIXTURE = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT ?? 0);
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body><div>hello</div></body></html>');
}).listen(port, '127.0.0.1', () => console.log('  VITE fixture  ready\\n\\n  ➜  Local:   http://127.0.0.1:' + port + '/\\n'));
`;

  const JSON_FIXTURE = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT ?? 0);
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}).listen(port, '127.0.0.1', () => console.log('  VITE fixture  ready\\n\\n  ➜  Local:   http://127.0.0.1:' + port + '/\\n'));
`;

  it('injects the inspector script into a text/html response before </body>', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreviewWithHtmlFixture(baseUrl, runtime, HTML_FIXTURE, 'html');
    const body = await fetch(started.url).then((response) => response.text());
    expect(body).toContain('af:selection:start');
    expect(body.indexOf('af:selection:start')).toBeLessThan(body.indexOf('</body>'));
  });

  it('does not touch a non-HTML response', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreviewWithHtmlFixture(baseUrl, runtime, JSON_FIXTURE, 'json');
    const body = await fetch(started.url).then((response) => response.text());
    expect(body).toBe('{"ok":true}');
  });
});
```

This relies on `writeFile`/`join` already being imported at the top of `preview-proxy.test.ts` (they are, per the existing `startPreview` helper) and on a module-level `cleanups: Array<() => Promise<void>>` array already existing in the file (it does, per the existing `startPreview` helper's own `cleanups.push(...)` call) — reuse both, don't redeclare them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/preview-proxy.test.ts -t "inspector script"`
Expected: FAIL — response body does not contain `af:selection:start`

- [ ] **Step 3: Write minimal implementation**

Modify `apps/api/src/preview-proxy.ts`. Add the import at the top:

```ts
import { buildInspectorScript } from './preview-inspector-script.js';
```

Replace `respondFromUpstream` (and add its two new helpers) — find:

```ts
function respondFromUpstream(
  upstreamRes: IncomingMessage,
  raw: ServerResponse,
  sessionId: string,
  upstreamPort: number,
  cookieValue: string | undefined,
): void {
  const headers = sanitizeResponseHeaders(upstreamRes.headers, sessionId, upstreamPort);
  if (cookieValue) {
    const cookie = `pv_${sessionId}=${cookieValue}; Path=/preview/${sessionId}; HttpOnly; SameSite=Lax`;
    const existing = headers['set-cookie'];
    headers['set-cookie'] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), cookie]
      : cookie;
  }
  raw.writeHead(upstreamRes.statusCode ?? 502, headers);
  upstreamRes.pipe(raw);
}
```

Replace with:

```ts
function respondFromUpstream(
  upstreamRes: IncomingMessage,
  raw: ServerResponse,
  sessionId: string,
  upstreamPort: number,
  cookieValue: string | undefined,
  parentOrigin: string,
): void {
  const headers = sanitizeResponseHeaders(upstreamRes.headers, sessionId, upstreamPort);
  if (cookieValue) {
    const cookie = `pv_${sessionId}=${cookieValue}; Path=/preview/${sessionId}; HttpOnly; SameSite=Lax`;
    const existing = headers['set-cookie'];
    headers['set-cookie'] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), cookie]
      : cookie;
  }
  const contentType = headers['content-type'];
  const isHtml = typeof contentType === 'string' && contentType.startsWith('text/html');
  if (!isHtml) {
    raw.writeHead(upstreamRes.statusCode ?? 502, headers);
    upstreamRes.pipe(raw);
    return;
  }
  // ponytail: buffers the full HTML body in memory before forwarding (loses
  // today's fully-streamed proxying for HTML documents only — JS/CSS/HMR
  // chunks are untouched above). Fine for typical page sizes; revisit with a
  // streaming </body> boundary scan if huge SSR pages ever matter.
  const chunks: Buffer[] = [];
  upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
  upstreamRes.on('end', () => {
    const html = injectInspectorScript(Buffer.concat(chunks).toString('utf8'), parentOrigin);
    const rewritten = Buffer.from(html, 'utf8');
    delete headers['content-length']; // body length changed; let Node recompute framing
    raw.writeHead(upstreamRes.statusCode ?? 502, {
      ...headers,
      'content-length': String(rewritten.byteLength),
    });
    raw.end(rewritten);
  });
  upstreamRes.on('error', () => raw.destroy());
}

function injectInspectorScript(html: string, parentOrigin: string): string {
  if (!html.includes('</body>')) return html;
  const scriptTag = `<script>${buildInspectorScript(parentOrigin)}</script>`;
  return html.replace('</body>', `${scriptTag}</body>`);
}
```

Now thread `parentOrigin` through from the one call site. Find, in `handleHttp`:

```ts
    (upstreamRes) => respondFromUpstream(upstreamRes, raw, sessionId, resolved.port, cookieValue),
```

Replace with:

```ts
    (upstreamRes) =>
      respondFromUpstream(
        upstreamRes,
        raw,
        sessionId,
        resolved.port,
        cookieValue,
        runtime.config.webBaseUrl,
      ),
```

This requires `runtime.config.webBaseUrl` to exist. Check `packages/composition/src/runtime.ts`'s `RuntimeConfig`/`config` shape for the existing base URL apps/web is served from (search for how CORS or the API's `Access-Control-Allow-Origin` is currently configured — there is very likely already a configured web origin string; reuse it exactly rather than inventing a new config key). If no such config value exists yet, add a `webBaseUrl: string` field to the runtime config (sourced from an existing env var such as `WEB_BASE_URL`/`NEXT_PUBLIC_API_URL`'s counterpart) rather than hardcoding `http://localhost:3000`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/preview-proxy.test.ts`
Expected: PASS (all existing tests + 2 new ones)

- [ ] **Step 5: Run the full apps/api test suite to confirm no regression**

Run: `npx vitest run apps/api`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/preview-proxy.ts apps/api/src/preview-proxy.test.ts
git commit -m "feat(api): inject inspector script into proxied preview HTML"
```

---

### Task 8: Orchestrator — PreviewSelectionService

**Files:**
- Create: `packages/orchestrator/src/preview-selection-service.ts`
- Create: `packages/orchestrator/src/preview-selection-service.test.ts`
- Modify: `packages/orchestrator/src/index.ts`

**Interfaces:**
- Consumes: `resolveWorkspaceRelativePath` (Task 1), `SelectionScreenshotCapturer` (Task 2), `PreviewSelectionRequest`/`PreviewSelectionResult`/`PreviewSelectionCandidate` (Task 3), `WorkspaceManager` (existing, domain).
- Produces: `PreviewSelectionService.resolve(input: { projectId: string; sessionId: string; request: PreviewSelectionRequest }): Promise<PreviewSelectionResult>` — consumed by Task 9 (apps/api route) via Task 10 (composition wiring).

- [ ] **Step 1: Write the failing test**

Create `packages/orchestrator/src/preview-selection-service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { PreviewSelectionRequest } from '@agent-foundry/contracts';
import { PreviewSelectionService } from './preview-selection-service.js';

const boundingBox = { x: 0, y: 0, width: 10, height: 10 };
const computedStyle = {};

function baseRequest(overrides: Partial<PreviewSelectionRequest> = {}): PreviewSelectionRequest {
  return {
    previewUrl: 'http://127.0.0.1:4000/preview/session-1/?token=abc',
    domPath: 'div[1]',
    boundingBox,
    computedStyle,
    candidates: [],
    ...overrides,
  };
}

function makeService(overrides: {
  workspacePath?: string;
  captureSelectionScreenshot?: ReturnType<typeof vi.fn>;
} = {}) {
  const workspaces = { workspacePath: () => overrides.workspacePath ?? '/data/ws' };
  const screenshots = {
    captureSelectionScreenshot: overrides.captureSelectionScreenshot ?? vi.fn(async () => null),
  };
  const service = new PreviewSelectionService(workspaces, screenshots, {
    previewBaseUrl: 'http://127.0.0.1:4000/preview',
  });
  return { service, screenshots };
}

describe('PreviewSelectionService.resolve', () => {
  it('resolves a single in-workspace candidate', async () => {
    const { service } = makeService();
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({
        candidates: [{ fileName: 'src/Greeting.tsx', line: 4, column: 3, componentName: 'Greeting' }],
      }),
    });
    expect(result).toMatchObject({ status: 'resolved', file: 'src/Greeting.tsx' });
  });

  it('reports ambiguous for 2+ distinct in-workspace candidates', async () => {
    const { service } = makeService();
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({
        candidates: [
          { fileName: 'src/Card.tsx', line: 12, column: 3, componentName: 'Card' },
          { fileName: 'src/Button.tsx', line: 8, column: 5, componentName: 'Button' },
        ],
      }),
    });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toEqual(['src/Card.tsx', 'src/Button.tsx']);
  });

  it('resolves two different list-item candidate sets to the same single file', async () => {
    const { service } = makeService();
    const candidateFor = (): PreviewSelectionRequest['candidates'] => [
      { fileName: 'src/ListItem.tsx', line: 6, column: 2, componentName: 'ListItem' },
    ];
    const first = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({ candidates: candidateFor() }),
    });
    const second = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({ candidates: candidateFor() }),
    });
    expect(first).toEqual(second);
    expect(first.status).toBe('resolved');
    expect(first.file).toBe('src/ListItem.tsx');
  });

  it('drops candidates that escape the workspace root and rejects the whole selection as unsupported when none remain', async () => {
    const { service, screenshots } = makeService();
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({
        candidates: [{ fileName: '../../etc/passwd', line: 1, column: 1 }],
      }),
    });
    expect(result.status).toBe('unsupported');
    expect(result.file).toBeUndefined();
    expect(result.candidates).toBeUndefined();
    expect(screenshots.captureSelectionScreenshot).toHaveBeenCalledTimes(1);
  });

  it('treats a generated/non-React element (no candidates) as unsupported and attaches a screenshot when capture succeeds', async () => {
    const buffer = Buffer.from('fake-png');
    const { service, screenshots } = makeService({
      captureSelectionScreenshot: vi.fn(async () => buffer),
    });
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({ candidates: [] }),
    });
    expect(result.status).toBe('unsupported');
    expect(result.screenshot).toBeDefined();
    expect(screenshots.captureSelectionScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://127.0.0.1:4000/preview/session-1/?token=abc',
        clip: boundingBox,
      }),
    );
  });

  it('omits the screenshot when previewUrl does not match the session prefix', async () => {
    const { service, screenshots } = makeService();
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({ previewUrl: 'http://evil.example/steal', candidates: [] }),
    });
    expect(result.status).toBe('unsupported');
    expect(result.screenshot).toBeUndefined();
    expect(screenshots.captureSelectionScreenshot).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/preview-selection-service.test.ts`
Expected: FAIL — `Cannot find module './preview-selection-service.js'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/orchestrator/src/preview-selection-service.ts`:

```ts
import {
  ArtifactReferenceSchema,
  type PreviewSelectionRequest,
  type PreviewSelectionResult,
} from '@agent-foundry/contracts';
import {
  resolveWorkspaceRelativePath,
  type SelectionScreenshotCapturer,
  type WorkspaceManager,
} from '@agent-foundry/domain';

export interface PreviewSelectionServiceConfig {
  previewBaseUrl: string;
}

export class PreviewSelectionService {
  constructor(
    private readonly workspaces: Pick<WorkspaceManager, 'workspacePath'>,
    private readonly screenshots: Pick<SelectionScreenshotCapturer, 'captureSelectionScreenshot'>,
    private readonly config: PreviewSelectionServiceConfig,
  ) {}

  async resolve(input: {
    projectId: string;
    sessionId: string;
    request: PreviewSelectionRequest;
  }): Promise<PreviewSelectionResult> {
    const { request } = input;
    const workspaceRoot = this.workspaces.workspacePath(input.projectId);

    const resolvedFiles: string[] = [];
    for (const candidate of request.candidates) {
      const relative = resolveWorkspaceRelativePath(workspaceRoot, candidate.fileName);
      if (relative && !resolvedFiles.includes(relative)) resolvedFiles.push(relative);
    }

    const base = {
      domPath: request.domPath,
      boundingBox: request.boundingBox,
      computedStyle: request.computedStyle,
    };

    if (resolvedFiles.length === 1) {
      return { ...base, status: 'resolved', file: resolvedFiles[0] };
    }
    if (resolvedFiles.length >= 2) {
      return { ...base, status: 'ambiguous', candidates: resolvedFiles };
    }

    const screenshot = await this.captureFallbackScreenshot(input.sessionId, request);
    return { ...base, status: 'unsupported', ...(screenshot ? { screenshot } : {}) };
  }

  private async captureFallbackScreenshot(
    sessionId: string,
    request: PreviewSelectionRequest,
  ): ReturnType<PreviewSelectionService['resolve']> extends Promise<infer _R>
    ? Promise<PreviewSelectionResult['screenshot']>
    : never {
    const expectedPrefix = `${this.config.previewBaseUrl}/${sessionId}/`;
    if (!request.previewUrl.startsWith(expectedPrefix)) return undefined;
    const buffer = await this.screenshots.captureSelectionScreenshot({
      url: request.previewUrl,
      clip: request.boundingBox,
      viewport: { width: request.boundingBox.width, height: request.boundingBox.height },
    });
    if (!buffer) return undefined;
    return ArtifactReferenceSchema.parse({
      name: `preview-selection-${sessionId}-${Date.now()}.png`,
      revision: 1,
    });
  }
}
```

Note: the conditional-type return annotation on `captureFallbackScreenshot` above is needlessly clever — simplify it in the actual file to a plain `Promise<PreviewSelectionResult['screenshot']>` return type; it's written awkwardly here only to fit inline. Use:

```ts
  private async captureFallbackScreenshot(
    sessionId: string,
    request: PreviewSelectionRequest,
  ): Promise<PreviewSelectionResult['screenshot']> {
```

Modify `packages/orchestrator/src/index.ts` — add:

```ts
export * from './preview-selection-service.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/preview-selection-service.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/preview-selection-service.ts packages/orchestrator/src/preview-selection-service.test.ts packages/orchestrator/src/index.ts
git commit -m "feat(orchestrator): add PreviewSelectionService"
```

---

### Task 9: Composition — wire PreviewSelectionService into Runtime

**Files:**
- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**
- Consumes: `PreviewSelectionService` (Task 8), existing `workspaces`/`browserVerifier` singletons already constructed in `createRuntime`.
- Produces: `runtime.previewSelectionService` — consumed by Task 10 (apps/api route).

- [ ] **Step 1: No new automated test for this task — it's pure wiring** (covered end-to-end by Task 10's route test, which fails without this).

- [ ] **Step 2: Modify `packages/composition/src/runtime.ts`**

Add `PreviewSelectionService` to the existing `@agent-foundry/orchestrator` destructured import block at the top of the file.

Add to the `Runtime` interface (near the existing `previewService: PreviewService;` line):

```ts
  previewSelectionService: PreviewSelectionService;
```

In `createRuntime`, after `const browserVerifier = new PlaywrightBrowserVerifier();` (and after `config.previewBaseUrl` has already been assembled for `previewService`'s config, a few lines earlier), add:

```ts
  const previewSelectionService = new PreviewSelectionService(workspaces, browserVerifier, {
    previewBaseUrl: `http://${config.apiHost}:${config.apiPort}/preview`,
  });
```

Add `previewSelectionService,` to the trailing returned object literal (near the existing `previewService,` line).

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b packages/composition --force --pretty false`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/composition/src/runtime.ts
git commit -m "feat(composition): wire PreviewSelectionService into the runtime"
```

---

### Task 10: apps/api — selection endpoint

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/preview.test.ts` (this is the existing file that already tests every other `/projects/:projectId/preview*` route, using real `fetch()` against a listening app — not `app.inject`)

**Interfaces:**
- Consumes: `runtime.previewSelectionService` (Task 9), `PreviewSelectionRequestSchema`/`PreviewSelectionResultSchema` (Task 3), existing `requireProjectSession` helper (`apps/api/src/app.ts:597`).
- Produces: `POST /projects/:projectId/preview/:sessionId/selection` — consumed by Task 11 (apps/web client).

- [ ] **Step 1: Write the failing test**

`apps/api/src/preview.test.ts` already has `startApi()`, `createProject(baseUrl)`, and `createActiveSession(runtime, projectId)` (writes a `running`-status `PreviewSession` record directly into `runtime.previewSessions`, no real dev-server process needed). Add a new `describe` block using them:

```ts
describe('POST /projects/:projectId/preview/:sessionId/selection', () => {
  it('resolves a selection with no candidates as unsupported', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const session = await createActiveSession(runtime, projectId);
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/preview/${session.id}/selection`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          previewUrl: `${baseUrl}/preview/${session.id}/`,
          domPath: 'div[1]',
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          computedStyle: {},
          candidates: [],
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('unsupported');
  });

  it('404s for a selection posted against another project\'s session', async () => {
    const { baseUrl, runtime } = await startApi();
    const ownerId = await createProject(baseUrl);
    const otherId = await createProject(baseUrl);
    const session = await createActiveSession(runtime, ownerId);
    const response = await fetch(
      `${baseUrl}/projects/${otherId}/preview/${session.id}/selection`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          previewUrl: `${baseUrl}/preview/${session.id}/`,
          domPath: 'div[1]',
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          computedStyle: {},
          candidates: [],
        }),
      },
    );
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/preview.test.ts -t "preview selection"`
Expected: FAIL — 404 (route doesn't exist yet)

- [ ] **Step 3: Write minimal implementation**

Modify `apps/api/src/app.ts`. Add `PreviewSelectionRequestSchema` and `PreviewSelectionResultSchema` to the existing `@agent-foundry/contracts` import block.

Add the new route immediately before `registerPreviewProxy(app, runtime);`:

```ts
  app.post('/projects/:projectId/preview/:sessionId/selection', async (request, reply) => {
    const { projectId, sessionId } = z
      .object({ projectId: PathSegmentSchema, sessionId: PathSegmentSchema })
      .parse(request.params);
    await requireProjectSession(runtime, projectId, sessionId);
    const input = PreviewSelectionRequestSchema.parse(request.body);
    const result = await runtime.previewSelectionService.resolve({
      projectId,
      sessionId,
      request: input,
    });
    return reply.status(200).send(PreviewSelectionResultSchema.parse(result));
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/preview.test.ts -t "preview selection"`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full apps/api test suite to confirm no regression**

Run: `npx vitest run apps/api`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/preview.test.ts
git commit -m "feat(api): add preview selection endpoint"
```

---

### Task 11: apps/web — API client function

**Files:**
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: `PreviewSelectionRequest`/`PreviewSelectionResult` (Task 3).
- Produces: `resolvePreviewSelection(projectId, sessionId, input): Promise<PreviewSelectionResult>` — consumed by Task 12.

- [ ] **Step 1: No isolated unit test for this task — it's a thin wrapper over the already-tested `api()` helper; correctness is verified by Task 12's component test, which calls it through a mocked `fetch`.**

- [ ] **Step 2: Modify `apps/web/lib/api.ts`**

Add `PreviewSelectionRequest` and `PreviewSelectionResult` to the top `@agent-foundry/contracts` type-only import block.

Add near `startPreview`/`stopPreview`:

```ts
export function resolvePreviewSelection(
  projectId: string,
  sessionId: string,
  input: PreviewSelectionRequest,
): Promise<PreviewSelectionResult> {
  return api<PreviewSelectionResult>(
    `/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(sessionId)}/selection`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b apps/web --force --pretty false`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): add resolvePreviewSelection API client"
```

---

### Task 12: apps/web — select-element UI in PreviewPanel

**Files:**
- Modify: `apps/web/app/project/[id]/preview-panel.tsx`

**Interfaces:**
- Consumes: `resolvePreviewSelection` (Task 11), `PreviewSelectionResult` (Task 3), existing `BlobMedia`/`getArtifactBlobUrl`.
- Produces: visible "Selecionar elemento" toggle + result panels in `PreviewPanel` — exercised end-to-end by Task 13's Playwright spec.

**No component-level unit test for this task.** Verified: `apps/web` has zero `.test.tsx` files today, no `@testing-library/react` devDependency, and the root `vitest.config.ts` runs with `environment: 'node'` (no jsdom) — this repo verifies `apps/web` behavior through real Playwright e2e specs (`apps/api/e2e/*.spec.ts`), not component-level rendering tests. Adding a new test framework/dependency for one component would violate this plan's "no new npm dependencies" constraint and this repo's established convention. This task's safety net is `tsc` (Step 3) plus Task 13's e2e spec, which is expanded (see Task 13 below) to actually click through the resolved/ambiguous/unsupported panels this task renders, not just the happy path.

- [ ] **Step 1: Modify `apps/web/app/project/[id]/preview-panel.tsx` directly (no separate failing-test step — see the note above)**

Modify `apps/web/app/project/[id]/preview-panel.tsx`.

Add to the imports:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArtifactReference,
  BrowserVerificationReport,
  PreviewLogEntry,
  PreviewSelectionResult,
  PreviewSession,
  StoredArtifact,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  getActivePreviewSession,
  getArtifactBlobUrl,
  getPreviewLogs,
  resolvePreviewSelection,
  startPreview,
  stopPreview,
} from '../../../lib/api';
```

Inside `PreviewPanel`, add new state and a `ref` (alongside the existing `useState` calls):

```tsx
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionResult, setSelectionResult] = useState<PreviewSelectionResult | null>(null);
  const [selectionError, setSelectionError] = useState('');
```

Add a new effect (alongside the existing two `useEffect`s) that listens for the inspector script's result and resolves it:

```tsx
  useEffect(() => {
    if (!session?.url) return;
    const previewOrigin = new URL(session.url).origin;
    function onMessage(event: MessageEvent) {
      if (event.origin !== previewOrigin) return;
      if (event.data?.type !== 'af:selection:result') return;
      setSelecting(false);
      const payload = event.data.payload;
      resolvePreviewSelection(projectId, session!.id, {
        previewUrl: session!.url!,
        domPath: payload.domPath,
        boundingBox: payload.boundingBox,
        computedStyle: payload.computedStyle,
        candidates: payload.candidates,
      })
        .then(setSelectionResult)
        .catch((cause) => setSelectionError(cause instanceof Error ? cause.message : String(cause)));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [projectId, session]);

  function toggleSelecting() {
    if (!session?.url || !iframeRef.current?.contentWindow) return;
    setSelectionResult(null);
    setSelecting(true);
    iframeRef.current.contentWindow.postMessage(
      { type: 'af:selection:start' },
      new URL(session.url).origin,
    );
  }
```

Modify the `viewportSwitcher` block that currently ends with the "Parar preview" button — add a toggle button next to it:

```tsx
            <button className="secondaryButton" onClick={() => void stop()}>
              Parar preview
            </button>
            <button className="secondaryButton" onClick={toggleSelecting}>
              {selecting ? 'Clique em um elemento…' : 'Selecionar elemento'}
            </button>
```

Modify the iframe render to attach the `ref`:

```tsx
          {session.url ? (
            <div className="previewFrameWrap">
              <iframe
                ref={iframeRef}
                src={session.url}
                width={VIEWPORTS[viewport].width}
                height={VIEWPORTS[viewport].height}
                title="Preview do aplicativo"
              />
            </div>
          ) : (
            <p className="hint">Preview iniciando…</p>
          )}
```

Add the result panels right after the `previewFrameWrap`/`Preview iniciando…` block, still inside the same conditional branch:

```tsx
          {selectionError ? <p className="errorBox">{selectionError}</p> : null}
          {selectionResult?.status === 'resolved' ? (
            <div className="panel">
              <p>
                Elemento mapeado para: <strong>{selectionResult.file}</strong>
              </p>
            </div>
          ) : null}
          {selectionResult?.status === 'ambiguous' ? (
            <div className="panel">
              <p>Seleção ambígua — escolha o arquivo correto:</p>
              <ul>
                {selectionResult.candidates?.map((file) => (
                  <li key={file}>
                    <button className="secondaryButton" onClick={() => setSelectionResult(null)}>
                      {file}
                    </button>
                  </li>
                ))}
              </ul>
              <button className="secondaryButton" onClick={() => setSelectionResult(null)}>
                Descartar
              </button>
            </div>
          ) : null}
          {selectionResult?.status === 'unsupported' ? (
            <div className="panel">
              <p>Não foi possível mapear este elemento a um arquivo de origem.</p>
              <p className="hint">{selectionResult.domPath}</p>
              {selectionResult.screenshot ? (
                <BlobMedia
                  src={getArtifactBlobUrl(
                    projectId,
                    selectionResult.screenshot.name,
                    selectionResult.screenshot.revision,
                  )}
                  alt={selectionResult.domPath}
                  kind="image"
                />
              ) : null}
              <button className="secondaryButton" onClick={() => setSelectionResult(null)}>
                Fechar
              </button>
            </div>
          ) : null}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b apps/web --force --pretty false`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/project/\[id\]/preview-panel.tsx
git commit -m "feat(web): add click-to-select UI to the preview panel"
```

---

### Task 13: End-to-end Playwright coverage

**Files:**
- Modify: `packages/executors/src/fixtures/preview-dev-server.mjs` (add an HTML-serving branch)
- Create: `apps/api/e2e/dom-source-map.spec.ts`

**Interfaces:**
- Consumes: the full stack (Tasks 1–12).
- Produces: real-browser regression tests proving the click → postMessage → resolve → UI round trip works end to end for all three UI outcomes (`resolved`/`ambiguous`/`unsupported`). The four *candidate-resolution* scenarios named in the issue — simple/wrapper/repeated-list/generated — are already covered at the unit level by Tasks 5 and 8; this spec proves the wiring between them and the real browser/UI, using one fixture element per UI outcome (a repeated-list fixture element would exercise identical wiring to "simple", so it isn't duplicated here).

- [ ] **Step 1: Add an HTML-serving branch to the fixture dev server**

Modify `packages/executors/src/fixtures/preview-dev-server.mjs`. Add a branch before the final default `text/plain` handler:

```js
  if (req.url === '/dom-source-map-fixture') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body>
<div id="simple"></div>
<div id="wrapper"></div>
<div id="generated"></div>
<script>
  document.getElementById('simple').__reactFiber\$fixture = {
    type: { name: 'Greeting' },
    return: null,
    _debugSource: { fileName: 'src/Greeting.tsx', lineNumber: 4, columnNumber: 3 },
  };
  document.getElementById('wrapper').__reactFiber\$fixture = {
    type: { name: 'Button' },
    return: {
      type: { name: 'Card' },
      return: null,
      _debugSource: { fileName: 'src/Card.tsx', lineNumber: 12, columnNumber: 3 },
    },
    _debugSource: { fileName: 'src/Button.tsx', lineNumber: 8, columnNumber: 5 },
  };
  // 'generated' has no __reactFiber$* property at all — the unsupported/degrade path.
</script>
</body></html>`);
    return;
  }
```

(Note the fiber is attached under a literal `__reactFiber$fixture` key — `findReactFiber` matches any key with the `__reactFiber$` prefix, not a specific suffix, exactly so this fixture doesn't need to fake React's real random suffix.)

- [ ] **Step 2: Write the e2e spec**

Create `apps/api/e2e/dom-source-map.spec.ts`. Copy `apps/api/e2e/golden-flow.spec.ts`'s full `test.beforeAll`/`test.afterAll` block verbatim (the runtime + `buildApp` + `app.listen` + `next dev` web-process bootstrap, `reserveEphemeralPort`, `waitForHttp`, and the module-level `runtime`/`apiClose`/`apiBaseUrl`/`webProcess`/`webBaseUrl`/`dirs` state it sets up, plus its `createProject()` helper) — this test needs the exact same real API + real Next.js web app running, since it drives the actual `apps/web` UI, not just the API. Read that file in full before writing this step, since the plan can't inline its ~120-line setup without risking drift from the real fixture/env-var wiring it uses. Then add:

```ts
async function seedDomSourceMapFixture(projectId: string): Promise<void> {
  await runtime.workspaces.ensure(projectId);
  const workspacePath = runtime.workspaces.workspacePath(projectId);
  const fixtureSource = await readFile(FIXTURE_SCRIPT, 'utf8');
  await writeFile(join(workspacePath, 'server.mjs'), fixtureSource);
  await writeFile(join(workspacePath, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }));
}

async function startPreviewAndSelect(page: import('@playwright/test').Page, projectId: string) {
  await page.goto(`${webBaseUrl}/project/${projectId}`);
  await page.getByText('Iniciar preview').click();
  await page.waitForSelector('.previewFrameWrap iframe');
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
```

- [ ] **Step 3: Run the e2e spec**

Run: `npm run e2e --workspace @agent-foundry/api -- dom-source-map.spec.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/executors/src/fixtures/preview-dev-server.mjs apps/api/e2e/dom-source-map.spec.ts
git commit -m "test(e2e): cover the click-to-source-map round trip"
```

---

### Task 14: Full verification pass and evidence capture

**Files:** none (verification only)

- [ ] **Step 1: Run the full check suite**

Run: `npm run check`
Expected: PASS (format, lint, architecture, roadmap, typecheck, test, build all green)

- [ ] **Step 2: Run the e2e suite**

Run: `npm run e2e --workspace @agent-foundry/api`
Expected: PASS

- [ ] **Step 3: Capture evidence for the PR/issue**

Save the full output of `npm run check` and the e2e run to a scratch file for pasting into the PR description (per `docs/DEFINITION_OF_DONE.md`'s "Delivery evidence" requirement). Also capture, per the roadmap's required test scenarios:
- The `walkFiberCandidates`/`PreviewSelectionService` test output for the simple/wrapper/repeated-list/generated cases (Tasks 5, 8).
- A screenshot or terminal capture of the e2e spec passing (Task 13).

- [ ] **Step 4: No commit — this task only produces evidence for the PR description.**
