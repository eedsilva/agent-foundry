# Browser Evidence Artifacts (Issue #33) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist browser-verification screenshots, an optional Playwright trace, and an optional video as binary artifacts with their own retention, and let the web UI download them without ever seeing a local filesystem path.

**Architecture:** `FileArtifactStore` grows a streaming blob path (`putBlob`/`getBlobStream`) alongside its existing JSON path, so binary content is hashed and size-capped while streaming to disk instead of being buffered in memory. `PlaywrightBrowserVerifier` (executors) captures a screenshot per step plus an optional trace/video as `Buffer`s and returns them as a separate `evidence` object next to the existing JSON `report` — it cannot call the store directly (architecture rule: `executors` may only import `contracts`+`domain`). `BrowserVerificationCoordinator` (orchestrator) is the one place with both the verifier and the store, so it persists the evidence via `putBlob` _after_ the existing report/session binding check, then attaches the resulting `ArtifactReference`s to `previewSession.evidence`. A new `apps/api` route streams a blob artifact by `{projectId, name, revision}` (never a path), and a new interval sweep (mirroring the existing preview reaper) deletes expired blob bytes while leaving artifact metadata intact.

**Tech Stack:** TypeScript, Zod, Vitest, Playwright (`chromium`, already a dependency), Fastify, Node `stream`/`fs/promises`.

## Global Constraints

- Package import boundaries are enforced by `scripts/check-architecture.mjs` (`npm run check` fails otherwise). Exact allow-list relevant here:
  - `@agent-foundry/contracts` → nothing.
  - `@agent-foundry/domain` → `@agent-foundry/contracts` only.
  - `@agent-foundry/persistence` → `contracts`, `domain`.
  - `@agent-foundry/executors` → `contracts`, `domain` **only** (never `persistence`).
  - `@agent-foundry/orchestrator` → `contracts`, `domain` **only** (never `persistence` directly — concrete stores are injected).
  - `@agent-foundry/composition` → all of the above (only place that wires concrete `FileArtifactStore` into orchestrator/executors).
  - `apps/api` → `composition`, `contracts`, `domain` only (never `persistence`/`orchestrator`/`executors` directly — go through `runtime.<service>`).
  - `apps/web` → `contracts` only.
- Every new Zod schema field is **additive and optional** — no existing stored JSON (artifacts, policies, reports) may be broken by these changes.
- New byte-limit and retention values are configured the same way every existing limit in this codebase is: a `ConfigSchema` key in `packages/composition/src/config.ts` with a sane default, never a hardcoded constant buried in application code.
- No new dependency is added. Playwright (`^1.61.1`, already in `packages/executors/package.json`) already supports `context.tracing.start/stop` and `recordVideo`; Fastify already supports returning a `Readable` from a route handler.
- Every existing test in `packages/executors/src/browser-verifier.test.ts` and `packages/orchestrator/src/browser-verification-coordinator.test.ts` must keep passing — most of them go through one shared `verify()` test helper per file, so the return-type change is absorbed there instead of touching 40+ individual assertions.
- Scope, deliberately excluded (record this in the ADR in Task 14, don't silently drop it):
  - No remote/S3 blob backend — "external reference" is satisfied by separating metadata (JSON, cheap) from bytes (a sibling file on local disk), consistent with this being a self-hosted personal-v1 product.
  - No signed/token download URLs — the existing JSON artifact route already has no auth layer; the new binary route matches that same posture (path-parameter validation only, same as today).
  - No evidence-viewer UI — that is the separate, downstream roadmap item `v05-preview-ui-e2e`. This plan only adds a URL-building helper the web app can wire a viewer to later.
  - Trace/video are read into a bounded, config-capped `Buffer` inside the executor before being handed to the orchestrator (Playwright writes them to a temp file first regardless); only the **store's** write and read paths are truly streamed end-to-end. This is a deliberate, bounded tradeoff — call it out in the ADR rather than trying to pipe a live stream across the `executors → orchestrator` package boundary.

## Task Dependency Map

Tasks 1, 2, 3, and 7 touch disjoint files and can be done **in parallel** (dispatch as independent subagents). Everything else forms a chain except for the second group: once Task 6 is merged, Tasks {8→9→10} (executor/orchestrator evidence capture), Task 11 (download route), and Task 12 (retention reaper) are three independent workstreams and can also run **in parallel**. Task 13 depends on 11. Task 14 is last and depends on everything.

```
1 ─┐
2 ─┼─→ 4 ─→ 5 ─→ 6 ─┬─→ 8 ─→ 9 ─→ 10 ─┐
3 ─┘                ├─→ 11 ──────────┼─→ 13
7 ──────────────────┴─→ 12 ──────────┘
                                        └─→ 14 (final)
```

---

### Task 1: Contracts — blob storage fields on `ArtifactMetadata`

**Files:**

- Modify: `packages/contracts/src/project.ts:26-46`

**Interfaces:**

- Produces: `ArtifactMetadataSchema` gains `storage` (`'inline' | 'blob'`, defaults `'inline'`), `sizeBytes` (optional), `expiresAt` (optional ISO datetime), `blobDeleted` (optional boolean). `ArtifactMetadata` type picks these up automatically via `z.infer`.

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/project.ts` — there's no dedicated `project.test.ts`; contracts schemas in this repo are exercised by their consuming package's tests. Instead, add a focused unit test right next to the schema. Create `packages/contracts/src/project.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ArtifactMetadataSchema } from './project.js';

describe('ArtifactMetadataSchema', () => {
  it('defaults storage to inline and accepts an existing JSON artifact unchanged', () => {
    const parsed = ArtifactMetadataSchema.parse({
      projectId: 'project-1',
      name: 'prd',
      revision: 1,
      contentType: 'text/markdown',
      createdAt: '2026-07-17T12:00:00.000Z',
      createdBy: 'user',
      sha256: 'a'.repeat(64),
    });
    expect(parsed.storage).toBe('inline');
    expect(parsed.sizeBytes).toBeUndefined();
  });

  it('accepts a blob artifact with size, expiry, and deletion metadata', () => {
    const parsed = ArtifactMetadataSchema.parse({
      projectId: 'project-1',
      name: 'browser-screenshot-preview-1-open-items',
      revision: 1,
      contentType: 'image/png',
      createdAt: '2026-07-17T12:00:00.000Z',
      createdBy: 'browser-verifier',
      sha256: 'b'.repeat(64),
      storage: 'blob',
      sizeBytes: 48_211,
      expiresAt: '2026-07-24T12:00:00.000Z',
    });
    expect(parsed.storage).toBe('blob');
    expect(parsed.sizeBytes).toBe(48_211);
    expect(parsed.blobDeleted).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/project.test.ts`
Expected: FAIL — `storage`/`sizeBytes` are not recognized keys yet (or `parsed.storage` is `undefined` instead of `'inline'`).

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/project.ts`, replace the `ArtifactMetadataSchema` definition (lines 26-46):

```ts
export const ArtifactMetadataSchema = z.object({
  projectId: PathSegmentSchema,
  name: PathSegmentSchema,
  revision: z.number().int().positive(),
  contentType: z.string(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
  runId: PathSegmentSchema.optional(),
  stepRunId: PathSegmentSchema.optional(),
  attemptId: PathSegmentSchema.optional(),
  kind: z.literal('feedback').optional(),
  actor: ActorRefSchema.optional(),
  sourceDecisionId: PathSegmentSchema.optional(),
  routeDecision: RouteDecisionSchema.optional(),
  idempotencyKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sha256: z.string(),
  storage: z.enum(['inline', 'blob']).default('inline'),
  sizeBytes: z.number().int().nonnegative().optional(),
  expiresAt: z.string().datetime().optional(),
  blobDeleted: z.boolean().optional(),
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/project.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/project.ts packages/contracts/src/project.test.ts
git commit -m "feat(contracts): add blob storage fields to ArtifactMetadata"
```

---

### Task 2: Contracts — sized artifact references, screenshot evidence, and video evidence

**Files:**

- Modify: `packages/contracts/src/run.ts:56-63`
- Modify: `packages/contracts/src/preview.ts:280-297`
- Modify: `packages/contracts/src/preview.test.ts` (create if it doesn't already cover this — check first: run `ls packages/contracts/src/preview.test.ts`; if absent, create it)

**Interfaces:**

- Produces: `ArtifactReferenceSchema` gains optional `sizeBytes`. New `BrowserScreenshotEvidenceSchema`/`BrowserScreenshotEvidence` (fields: `name`, `revision`, `sha256`, `sizeBytes?`, `stepId`, `url`, `viewport: { width, height }`). `PreviewEvidenceSchema.screenshots` becomes `BrowserScreenshotEvidence[]` (was `ArtifactReference[]` — nothing populates it yet per the issue #32 ADR, so this is safe). `PreviewEvidenceSchema` gains optional `video: ArtifactReferenceSchema`.
- Consumes: `PathSegmentSchema` from `./primitives.js` (already imported in both files).

- [ ] **Step 1: Write the failing test**

Check whether `packages/contracts/src/preview.test.ts` exists:

```bash
ls packages/contracts/src/preview.test.ts 2>/dev/null || echo "MISSING"
```

If `MISSING`, create `packages/contracts/src/preview.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import {
  ArtifactReferenceSchema,
  BrowserScreenshotEvidenceSchema,
  PreviewEvidenceSchema,
} from './preview.js';

describe('ArtifactReferenceSchema', () => {
  it('accepts an optional sizeBytes without requiring it', () => {
    expect(
      ArtifactReferenceSchema.parse({ name: 'plan', revision: 1, sha256: 'a'.repeat(64) }),
    ).toEqual({ name: 'plan', revision: 1, sha256: 'a'.repeat(64) });
    expect(
      ArtifactReferenceSchema.parse({
        name: 'plan',
        revision: 1,
        sha256: 'a'.repeat(64),
        sizeBytes: 128,
      }).sizeBytes,
    ).toBe(128);
  });
});

describe('BrowserScreenshotEvidenceSchema', () => {
  it('carries viewport, url, step id, and hash alongside the artifact reference', () => {
    const parsed = BrowserScreenshotEvidenceSchema.parse({
      name: 'browser-screenshot-preview-1-open-items',
      revision: 1,
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
      stepId: 'open-items',
      url: 'http://127.0.0.1:4000/preview/preview-1/items',
      viewport: { width: 1280, height: 720 },
    });
    expect(parsed.stepId).toBe('open-items');
    expect(parsed.viewport).toEqual({ width: 1280, height: 720 });
  });
});

describe('PreviewEvidenceSchema', () => {
  it('defaults to an empty screenshot array and accepts optional trace/video/logs', () => {
    expect(PreviewEvidenceSchema.parse({})).toEqual({ screenshots: [] });
    const full = PreviewEvidenceSchema.parse({
      logs: { name: 'browser-logs', revision: 1, sha256: 'a'.repeat(64) },
      screenshots: [
        {
          name: 'browser-screenshot-preview-1-open-items',
          revision: 1,
          sha256: 'a'.repeat(64),
          stepId: 'open-items',
          url: 'http://127.0.0.1:4000/preview/preview-1/items',
          viewport: { width: 1280, height: 720 },
        },
      ],
      trace: { name: 'browser-trace-preview-1', revision: 1, sha256: 'b'.repeat(64) },
      video: { name: 'browser-video-preview-1', revision: 1, sha256: 'c'.repeat(64) },
    });
    expect(full.video?.name).toBe('browser-video-preview-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/preview.test.ts`
Expected: FAIL — `sizeBytes` rejected by `.strict()`, `BrowserScreenshotEvidenceSchema` doesn't exist, `video` rejected by `.strict()`.

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/run.ts`, replace `ArtifactReferenceSchema` (lines 56-63):

```ts
export const ArtifactReferenceSchema = z
  .object({
    name: PathSegmentSchema,
    revision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
```

In `packages/contracts/src/preview.ts`, replace `PreviewEvidenceSchema` (lines 280-287) with the new schema plus the screenshot evidence type placed just above it:

```ts
export const BrowserScreenshotEvidenceSchema = z
  .object({
    name: PathSegmentSchema,
    revision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative().optional(),
    stepId: PathSegmentSchema,
    url: z.string(),
    viewport: z
      .object({
        width: z.number().int().min(1).max(10_000),
        height: z.number().int().min(1).max(10_000),
      })
      .strict(),
  })
  .strict();
export type BrowserScreenshotEvidence = z.infer<typeof BrowserScreenshotEvidenceSchema>;

export const PreviewEvidenceSchema = z
  .object({
    logs: ArtifactReferenceSchema.optional(),
    screenshots: z.array(BrowserScreenshotEvidenceSchema).default([]),
    trace: ArtifactReferenceSchema.optional(),
    video: ArtifactReferenceSchema.optional(),
  })
  .strict();
export type PreviewEvidence = z.infer<typeof PreviewEvidenceSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/preview.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full contracts package test suite to check for ripple effects**

Run: `npx vitest run packages/contracts`
Expected: PASS — every existing `.strict()` consumer of `ArtifactReferenceSchema`/`PreviewEvidenceSchema` only ever _reads or constructs with a subset_ of fields (optional additions never break existing valid objects). If anything fails, read the failure — it means some other schema literally hardcodes the old shape and needs the same additive update (unlikely per the earlier codebase read, but verify).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/run.ts packages/contracts/src/preview.ts packages/contracts/src/preview.test.ts
git commit -m "feat(contracts): add sized artifact references and screenshot/video evidence"
```

---

### Task 3: Contracts — browser evidence policy (trace/video toggle and size limits)

**Files:**

- Modify: `packages/contracts/src/policy.ts`

**Interfaces:**

- Produces: `BrowserEvidencePolicySchema`/`BrowserEvidencePolicy` (`captureTrace`, `captureVideo`, each defaulting to `false`), `DEFAULT_BROWSER_EVIDENCE_POLICY` (a parsed instance with defaults applied). `ProjectPolicySchema` gains optional `browserEvidence`.

Byte ceilings are deliberately **not** part of this policy — they're an operational/infra concern (protecting local disk from a runaway trace/video file), not a per-project decision, so they live only in `RuntimeConfig` (Task 7) and are enforced once, at the `FileArtifactStore.putBlob` layer (Task 5/6), not duplicated here.

- [ ] **Step 1: Write the failing test**

Check for an existing `packages/contracts/src/policy.test.ts` (there is one, per the earlier repo read — 12 existing tests). Add a new `describe` block at the end of `packages/contracts/src/policy.test.ts`:

```ts
describe('BrowserEvidencePolicySchema', () => {
  it('defaults to no trace/video capture', () => {
    expect(DEFAULT_BROWSER_EVIDENCE_POLICY).toEqual({ captureTrace: false, captureVideo: false });
  });

  it('is accepted as an optional field on ProjectPolicySchema', () => {
    const parsed = ProjectPolicySchema.parse({
      schemaVersion: '1',
      id: 'default',
      version: 1,
      browserEvidence: { captureTrace: true, captureVideo: true },
    });
    expect(parsed.browserEvidence).toEqual({ captureTrace: true, captureVideo: true });
  });
});
```

Add `BrowserEvidencePolicySchema`, `DEFAULT_BROWSER_EVIDENCE_POLICY` to the existing top-of-file import from `./policy.js` in that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/policy.test.ts`
Expected: FAIL — `BrowserEvidencePolicySchema`/`DEFAULT_BROWSER_EVIDENCE_POLICY` don't exist; `browserEvidence` is silently dropped or errors (schema isn't `.strict()` today, so it would just be `undefined` on parse without the new field, failing the second assertion).

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/policy.ts`, add after the `BrowserOriginSchema` definition and before `ProjectPolicySchema`:

```ts
export const BrowserEvidencePolicySchema = z
  .object({
    captureTrace: z.boolean().default(false),
    captureVideo: z.boolean().default(false),
  })
  .strict();
export type BrowserEvidencePolicy = z.infer<typeof BrowserEvidencePolicySchema>;

export const DEFAULT_BROWSER_EVIDENCE_POLICY: BrowserEvidencePolicy =
  BrowserEvidencePolicySchema.parse({});
```

Then add one field to `ProjectPolicySchema` (right after `browserAllowedOrigins`):

```ts
  browserAllowedOrigins: z.array(BrowserOriginSchema).min(1).optional(),
  browserEvidence: BrowserEvidencePolicySchema.optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/policy.test.ts`
Expected: PASS (14 tests total: 12 existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/policy.ts packages/contracts/src/policy.test.ts
git commit -m "feat(contracts): add browser evidence capture policy"
```

---

### Task 4: Domain — blob store port methods, `ArtifactTooLargeError`, and evidence-carrying `BrowserVerifier`

**Files:**

- Modify: `packages/domain/src/errors.ts`
- Modify: `packages/domain/src/ports.ts`
- Test: `packages/domain/src/errors.test.ts` (existing — add one case)

**Interfaces:**

- Consumes: `ArtifactMetadata`, `BrowserEvidencePolicy` from `@agent-foundry/contracts` (both now exist per Tasks 1 and 3).
- Produces: `ArtifactTooLargeError`. `ArtifactBlobPutInput` interface. `ArtifactStore.putBlob(input, source): Promise<ArtifactMetadata>` and `ArtifactStore.getBlobStream(projectId, name, revision): Promise<Readable | null>` (new methods on the existing interface — `put`/`getLatest`/`getRevision`/`listLatest`/`listMetadata` are unchanged). `CapturedScreenshot`, `BrowserVerificationEvidence` interfaces. `BrowserVerifier.verify()` return type changes from `Promise<BrowserVerificationReport>` to `Promise<{ report: BrowserVerificationReport; evidence: BrowserVerificationEvidence }>`, and its input gains `evidencePolicy: BrowserEvidencePolicy`.

- [ ] **Step 1: Write the failing test**

Add to `packages/domain/src/errors.test.ts` (existing file — read it first to match its exact style, then append):

```ts
import { ArtifactTooLargeError } from './errors.js';
```

(add to the existing import line/block at the top, then add a new case in the existing `describe`/`it` structure — match whatever pattern the file already uses, e.g.:)

```ts
it('names ArtifactTooLargeError with the byte ceiling in its message', () => {
  const error = new ArtifactTooLargeError(1_024);
  expect(error.name).toBe('ArtifactTooLargeError');
  expect(error.message).toContain('1024');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/domain/src/errors.test.ts`
Expected: FAIL — `ArtifactTooLargeError` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/domain/src/errors.ts`, add (anywhere alongside the other small error classes, e.g. after `QueueError`):

```ts
export class ArtifactTooLargeError extends Error {
  override readonly name = 'ArtifactTooLargeError';

  constructor(readonly maxBytes: number) {
    super(`Artifact exceeds the ${maxBytes}-byte limit`);
  }
}
```

In `packages/domain/src/ports.ts`:

1. Add `import type { Readable } from 'node:stream';` to the top of the file.
2. Add `BrowserEvidencePolicy` to the existing `from '@agent-foundry/contracts'` import list.
3. Replace the `ArtifactStore` interface (lines 110-130) with:

```ts
export interface ArtifactBlobPutInput {
  projectId: string;
  name: string;
  contentType: string;
  createdBy: string;
  maxBytes: number;
  runId?: string;
  stepRunId?: string;
  attemptId?: string;
  retentionSeconds?: number;
}

export interface ArtifactStore {
  put(input: {
    projectId: string;
    name: string;
    content: unknown;
    contentType?: string;
    createdBy: string;
    runId?: string;
    stepRunId?: string;
    attemptId?: string;
    kind?: 'feedback';
    actor?: import('@agent-foundry/contracts').ActorRef;
    sourceDecisionId?: string;
    routeDecision?: RouteDecision;
    idempotencyKey?: string;
  }): Promise<StoredArtifact>;
  putBlob(input: ArtifactBlobPutInput, source: Readable): Promise<ArtifactMetadata>;
  getBlobStream(projectId: string, name: string, revision: number): Promise<Readable | null>;
  getLatest(projectId: string, name: string): Promise<StoredArtifact | null>;
  getRevision(projectId: string, name: string, revision: number): Promise<StoredArtifact | null>;
  listLatest(projectId: string): Promise<StoredArtifact[]>;
  listMetadata(projectId: string, name?: string): Promise<ArtifactMetadata[]>;
}
```

4. Add near the `BrowserVerifier` interface (replace lines 241-251):

```ts
export interface CapturedScreenshot {
  stepId: string;
  url: string;
  viewport: { width: number; height: number };
  buffer: Buffer;
}

export interface BrowserVerificationEvidence {
  screenshots: CapturedScreenshot[];
  trace?: Buffer;
  video?: Buffer;
}

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/domain`
Expected: PASS — `errors.test.ts` passes.

Run: `npx tsc -b packages/domain --force --pretty false`
Expected: PASS — `ports.ts` already imports `PreviewSessionReference`, `ArtifactReference`, and `BrowserVerificationReport` from `@agent-foundry/contracts` (used by the pre-existing `BrowserVerifier`/`PreviewSessionRecord` types), so only `BrowserEvidencePolicy` and `Readable` are new imports to add. `domain` itself has no implementers of `ArtifactStore`/`BrowserVerifier` to break — those live in `persistence`/`executors`, fixed in Tasks 6 and 8 respectively; don't run `npm run check` repo-wide until then.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/errors.ts packages/domain/src/ports.ts packages/domain/src/errors.test.ts
git commit -m "feat(domain): add blob artifact store port and evidence-carrying BrowserVerifier"
```

**Note for the next task's implementer:** after this commit, `packages/persistence` (FileArtifactStore doesn't implement `putBlob`/`getBlobStream` yet) and `packages/executors`/`packages/orchestrator` (return the old bare report) will fail typecheck/build. That's expected — this plan's remaining tasks fix each in turn. Don't run `npm run build`/`npm run check` repo-wide until Task 10 is done; run scoped `vitest run <path>` per task instead.

---

### Task 5: Persistence — streaming, size-capped, hashing write primitive

**Files:**

- Modify: `packages/persistence/src/fs-utils.ts`
- Modify: `packages/persistence/src/fs-utils.test.ts`

**Interfaces:**

- Consumes: `ArtifactTooLargeError` from `@agent-foundry/domain` (Task 4).
- Produces: `sha256(value: string | Buffer): string` (widened, same name, same behavior for existing string callers). `atomicWriteStream(path: string, source: Readable, maxBytes: number): Promise<{ sha256: string; sizeBytes: number }>` — streams `source` to a temp file while hashing and counting bytes, throws `ArtifactTooLargeError` and deletes the temp file if `maxBytes` is exceeded, otherwise renames into place atomically (same pattern as `atomicWriteJson`).

- [ ] **Step 1: Write the failing test**

Add to `packages/persistence/src/fs-utils.test.ts` (append a new `describe` block; add `Readable` from `node:stream` and `atomicWriteStream`, `sha256` to the existing imports):

```ts
import { Readable } from 'node:stream';
import { ArtifactTooLargeError } from '@agent-foundry/domain';
// ...alongside the existing import from './fs-utils.js', add: atomicWriteStream, sha256

describe('atomicWriteStream', () => {
  it('streams content to disk and returns its hash and size', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'blob.bin');
    const content = Buffer.from('hello world');

    const result = await atomicWriteStream(path, Readable.from(content), 1_000);

    expect(result).toEqual({ sha256: sha256(content), sizeBytes: content.byteLength });
    await expect(readFile(path)).resolves.toEqual(content);
  });

  it('rejects content over the byte limit and leaves no temp file behind', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'blob.bin');
    const content = Buffer.from('this is definitely more than ten bytes');

    await expect(atomicWriteStream(path, Readable.from(content), 10)).rejects.toThrow(
      ArtifactTooLargeError,
    );
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/fs-utils.test.ts`
Expected: FAIL — `atomicWriteStream` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/persistence/src/fs-utils.ts`:

1. Add `import type { Readable } from 'node:stream';` to the imports.
2. Add `import { ArtifactTooLargeError } from '@agent-foundry/domain';` alongside the existing `NotFoundError` import (combine into one import statement from `@agent-foundry/domain`).
3. Replace the `sha256` function (lines 141-143):

```ts
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
```

4. Add a new function after `atomicWriteText` (after line 92):

```ts
export async function atomicWriteStream(
  path: string,
  source: Readable,
  maxBytes: number,
): Promise<{ sha256: string; sizeBytes: number }> {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    const handle = await open(temp, 'w');
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buffer.byteLength;
        if (sizeBytes > maxBytes) throw new ArtifactTooLargeError(maxBytes);
        hash.update(buffer);
        await handle.write(buffer);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/fs-utils.test.ts`
Expected: PASS (all existing fs-utils tests plus the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add packages/persistence/src/fs-utils.ts packages/persistence/src/fs-utils.test.ts
git commit -m "feat(persistence): add streaming size-capped write primitive"
```

---

### Task 6: Persistence — `FileArtifactStore` blob put/get/reap

**Files:**

- Modify: `packages/persistence/src/artifact-store.ts`
- Modify: `packages/persistence/src/artifact-store.test.ts`

**Interfaces:**

- Consumes: `atomicWriteStream`, `sha256` (widened), `exists`, `safeSegment`, `withDirectoryLock`, `readJsonOrNull`, `atomicWriteJson` from `./fs-utils.js` (existing + Task 5's addition). `ArtifactBlobPutInput` from `@agent-foundry/domain` (Task 4).
- Produces: `FileArtifactStore.putBlob(input, source)`, `FileArtifactStore.getBlobStream(projectId, name, revision)`, `FileArtifactStore.reapExpired(now: Date): Promise<number>` (this last one is **not** part of the `ArtifactStore` domain interface — mirrors how `PreviewReaperService` in `apps/api/src/preview-reaper.ts` is a narrow structural type the concrete service happens to satisfy, not a domain port method; `apps/api` will call it directly on `runtime.artifacts`, which is typed as concrete `FileArtifactStore` on the `Runtime` interface).

- [ ] **Step 1: Write the failing test**

Add to `packages/persistence/src/artifact-store.test.ts` (add `Readable` from `node:stream` to imports, plus `readFile` from `node:fs/promises`):

```ts
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';

describe('FileArtifactStore blob storage', () => {
  it('streams a blob to disk and reads it back byte-for-byte', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);
    const content = Buffer.from('a screenshot, pretend');

    const metadata = await store.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1-open-items',
        contentType: 'image/png',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
      },
      Readable.from(content),
    );

    expect(metadata).toMatchObject({
      storage: 'blob',
      contentType: 'image/png',
      sizeBytes: content.byteLength,
      revision: 1,
    });
    const stream = await store.getBlobStream(
      'project-1',
      'browser-screenshot-preview-1-open-items',
      1,
    );
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(content);
  });

  it('rejects a blob over the size limit and leaves no orphaned index entry', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-toolarge-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);

    await expect(
      store.putBlob(
        {
          projectId: 'project-1',
          name: 'browser-trace-preview-1',
          contentType: 'application/zip',
          createdBy: 'browser-verifier',
          maxBytes: 4,
        },
        Readable.from(Buffer.from('way more than four bytes')),
      ),
    ).rejects.toThrow(/exceeds the 4-byte limit/);

    await expect(store.listMetadata('project-1', 'browser-trace-preview-1')).resolves.toEqual([]);
  });

  it('returns null for a blob that was never written', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-missing-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);

    await expect(store.getBlobStream('project-1', 'nonexistent', 1)).resolves.toBeNull();
  });

  it('reaps expired blobs after their retention window without touching metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-reap-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);
    const content = Buffer.from('expires soon');
    const metadata = await store.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-video-preview-1',
        contentType: 'video/webm',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
        retentionSeconds: 60,
      },
      Readable.from(content),
    );
    expect(metadata.expiresAt).toBeTruthy();

    const beforeExpiry = new Date(Date.parse(metadata.expiresAt!) - 1_000);
    await expect(store.reapExpired(beforeExpiry)).resolves.toBe(0);
    await expect(
      store.getBlobStream('project-1', 'browser-video-preview-1', 1),
    ).resolves.not.toBeNull();

    const afterExpiry = new Date(Date.parse(metadata.expiresAt!) + 1_000);
    await expect(store.reapExpired(afterExpiry)).resolves.toBe(1);
    await expect(
      store.getBlobStream('project-1', 'browser-video-preview-1', 1),
    ).resolves.toBeNull();

    const survivingMetadata = await store.listMetadata('project-1', 'browser-video-preview-1');
    expect(survivingMetadata).toHaveLength(1);
    expect(survivingMetadata[0]).toMatchObject({ blobDeleted: true, sha256: metadata.sha256 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/artifact-store.test.ts`
Expected: FAIL — `putBlob`/`getBlobStream`/`reapExpired` don't exist on `FileArtifactStore`.

- [ ] **Step 3: Write minimal implementation**

In `packages/persistence/src/artifact-store.ts`:

1. Add to the imports: `import { createReadStream } from 'node:fs';`, `import { readdir, rm } from 'node:fs/promises';`, `import type { Readable } from 'node:stream';`, `import type { ArtifactBlobPutInput } from '@agent-foundry/domain';`, and add `atomicWriteStream`, `exists` to the existing `from './fs-utils.js'` import.
2. Add three methods to the `FileArtifactStore` class (after the existing `put` method, before `getLatest`):

```ts
  async putBlob(input: ArtifactBlobPutInput, source: Readable): Promise<ArtifactMetadata> {
    const projectId = safeSegment(input.projectId);
    const name = safeSegment(input.name);
    const root = join(this.dataDir, 'projects', projectId, 'artifacts');
    const lock = join(root, '.index.lock');

    return withDirectoryLock(lock, async () => {
      const indexPath = join(root, 'index.json');
      const index = (await readJsonOrNull<ArtifactIndex>(indexPath)) ?? { artifacts: {} };
      const revisions = index.artifacts[name] ?? [];
      const revision = revisions.length + 1;
      const blobPath = join(root, name, 'blobs', `${String(revision).padStart(6, '0')}.bin`);
      const { sha256: hash, sizeBytes } = await atomicWriteStream(blobPath, source, input.maxBytes);

      const metadata = ArtifactMetadataSchema.parse({
        projectId,
        name,
        revision,
        contentType: input.contentType,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        storage: 'blob',
        sizeBytes,
        ...(input.retentionSeconds
          ? { expiresAt: new Date(Date.now() + input.retentionSeconds * 1000).toISOString() }
          : {}),
        sha256: hash,
      });

      const stored = StoredArtifactSchema.parse({ metadata, content: null });
      const metadataPath = join(root, name, `${String(revision).padStart(6, '0')}.json`);
      await atomicWriteJson(metadataPath, stored);

      index.artifacts[name] = [...revisions, metadata];
      await atomicWriteJson(indexPath, index);
      return metadata;
    });
  }

  async getBlobStream(
    projectId: string,
    name: string,
    revision: number,
  ): Promise<Readable | null> {
    const blobPath = join(
      this.dataDir,
      'projects',
      safeSegment(projectId),
      'artifacts',
      safeSegment(name),
      'blobs',
      `${String(revision).padStart(6, '0')}.bin`,
    );
    if (!(await exists(blobPath))) return null;
    return createReadStream(blobPath);
  }

  async reapExpired(now: Date): Promise<number> {
    const projectsRoot = join(this.dataDir, 'projects');
    const projectIds = await readdir(projectsRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    let reaped = 0;
    for (const projectId of projectIds) {
      const artifactsRoot = join(projectsRoot, projectId, 'artifacts');
      const lock = join(artifactsRoot, '.index.lock');
      reaped += await withDirectoryLock(lock, async () => {
        const indexPath = join(artifactsRoot, 'index.json');
        const index = await readJsonOrNull<ArtifactIndex>(indexPath);
        if (!index) return 0;
        let count = 0;
        for (const [name, revisions] of Object.entries(index.artifacts)) {
          for (const metadata of revisions) {
            if (
              metadata.storage === 'blob' &&
              !metadata.blobDeleted &&
              metadata.expiresAt &&
              metadata.expiresAt <= now.toISOString()
            ) {
              const blobPath = join(
                artifactsRoot,
                safeSegment(name),
                'blobs',
                `${String(metadata.revision).padStart(6, '0')}.bin`,
              );
              await rm(blobPath, { force: true });
              metadata.blobDeleted = true;
              count += 1;
            }
          }
        }
        if (count > 0) await atomicWriteJson(indexPath, index);
        return count;
      });
    }
    return reaped;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/artifact-store.test.ts`
Expected: PASS (3 existing tests + 4 new ones)

- [ ] **Step 5: Run the whole persistence package suite**

Run: `npx vitest run packages/persistence`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/persistence/src/artifact-store.ts packages/persistence/src/artifact-store.test.ts
git commit -m "feat(persistence): stream binary artifacts to disk with size limits and retention"
```

---

### Task 7: Composition — artifact size and retention config

**Files:**

- Modify: `packages/composition/src/config.ts`
- Modify: `packages/composition/src/config.test.ts`

**Interfaces:**

- Produces: `RuntimeConfig` gains `artifactMaxScreenshotBytes`, `artifactMaxTraceBytes`, `artifactMaxVideoBytes`, `artifactRetentionSeconds`, `artifactReapIntervalMs` (all numbers). Read from env vars `ARTIFACT_MAX_SCREENSHOT_BYTES`, `ARTIFACT_MAX_TRACE_BYTES`, `ARTIFACT_MAX_VIDEO_BYTES`, `ARTIFACT_RETENTION_SECONDS`, `ARTIFACT_REAP_INTERVAL_MS`.

This task has no cross-package dependency — it can be done in parallel with Tasks 1-6.

- [ ] **Step 1: Write the failing test**

Add to `packages/composition/src/config.test.ts`, a new `describe` block:

```ts
describe('artifact retention configuration', () => {
  it('defaults artifact size and retention limits', () => {
    expect(loadRuntimeConfig(base)).toMatchObject({
      artifactMaxScreenshotBytes: 5_000_000,
      artifactMaxTraceBytes: 20_000_000,
      artifactMaxVideoBytes: 50_000_000,
      artifactRetentionSeconds: 604_800,
      artifactReapIntervalMs: 60_000,
    });
  });

  it('honors overrides for each artifact limit', () => {
    const config = loadRuntimeConfig({
      ...base,
      ARTIFACT_MAX_SCREENSHOT_BYTES: '1000',
      ARTIFACT_MAX_TRACE_BYTES: '2000',
      ARTIFACT_MAX_VIDEO_BYTES: '3000',
      ARTIFACT_RETENTION_SECONDS: '3600',
      ARTIFACT_REAP_INTERVAL_MS: '5000',
    });
    expect(config.artifactMaxScreenshotBytes).toBe(1000);
    expect(config.artifactMaxTraceBytes).toBe(2000);
    expect(config.artifactMaxVideoBytes).toBe(3000);
    expect(config.artifactRetentionSeconds).toBe(3600);
    expect(config.artifactReapIntervalMs).toBe(5000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/composition/src/config.test.ts`
Expected: FAIL — `artifactMaxScreenshotBytes` etc. are `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/composition/src/config.ts`:

1. Add to `ConfigSchema` (after `PREVIEW_LOG_MAX_BYTES`):

```ts
  ARTIFACT_MAX_SCREENSHOT_BYTES: z.coerce.number().int().positive().default(5_000_000),
  ARTIFACT_MAX_TRACE_BYTES: z.coerce.number().int().positive().default(20_000_000),
  ARTIFACT_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(50_000_000),
  ARTIFACT_RETENTION_SECONDS: z.coerce.number().int().positive().default(604_800),
  ARTIFACT_REAP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
```

2. Add to the `RuntimeConfig` interface (after `previewLogMaxBytes`):

```ts
artifactMaxScreenshotBytes: number;
artifactMaxTraceBytes: number;
artifactMaxVideoBytes: number;
artifactRetentionSeconds: number;
artifactReapIntervalMs: number;
```

3. Add to the return object in `loadRuntimeConfig` (after `previewLogMaxBytes: parsed.PREVIEW_LOG_MAX_BYTES,`):

```ts
    artifactMaxScreenshotBytes: parsed.ARTIFACT_MAX_SCREENSHOT_BYTES,
    artifactMaxTraceBytes: parsed.ARTIFACT_MAX_TRACE_BYTES,
    artifactMaxVideoBytes: parsed.ARTIFACT_MAX_VIDEO_BYTES,
    artifactRetentionSeconds: parsed.ARTIFACT_RETENTION_SECONDS,
    artifactReapIntervalMs: parsed.ARTIFACT_REAP_INTERVAL_MS,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/composition/src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/composition/src/config.ts packages/composition/src/config.test.ts
git commit -m "feat(composition): add artifact size and retention configuration"
```

---

### Task 8: Executors — capture screenshot/trace/video evidence in `PlaywrightBrowserVerifier`

**Files:**

- Modify: `packages/executors/src/browser-verifier.ts`
- Modify: `packages/executors/src/browser-verifier.test.ts`

**Interfaces:**

- Consumes: `BrowserVerifier`, `CapturedScreenshot`, `BrowserVerificationEvidence` from `@agent-foundry/domain` (Task 4). `BrowserEvidencePolicy`, `DEFAULT_BROWSER_EVIDENCE_POLICY` from `@agent-foundry/contracts` (Task 3).
- Produces: `PlaywrightBrowserVerifier.verify()` now returns `{ report, evidence }`. `evidence.screenshots` has one entry per step that actually ran (not skipped). `evidence.trace`/`evidence.video` are populated whenever `evidencePolicy.captureTrace`/`captureVideo` is true — the executor has no byte-limit knowledge at all; size enforcement is the coordinator/store's job (Task 9), so an oversized capture never fails verification here, it just gets dropped one layer up.

- [ ] **Step 1: Write the failing test**

`packages/executors/src/browser-verifier.test.ts` funnels ~38 existing tests through one shared `verify()` helper (around line 77-91) — update the helper first so every existing test keeps compiling and passing unchanged, then add new tests that call the verifier directly to inspect `evidence`.

Update imports at the top of the file (add to the existing `@agent-foundry/contracts` import list):

```ts
import type {
  ArtifactReference,
  BrowserEvidencePolicy,
  BrowserTestPlan,
  BrowserVerificationReport,
  PreviewSessionReference,
} from '@agent-foundry/contracts';
import { DEFAULT_BROWSER_EVIDENCE_POLICY } from '@agent-foundry/contracts';
```

Replace the `verify()` helper (lines 77-91):

```ts
async function verify(
  origin: string,
  browserPlan: BrowserTestPlan,
  options: {
    allowedOrigins?: string[];
    signal?: AbortSignal;
    evidencePolicy?: BrowserEvidencePolicy;
  } = {},
): Promise<BrowserVerificationReport> {
  const { report } = await new PlaywrightBrowserVerifier().verify(
    {
      planArtifact: PLAN_ARTIFACT,
      planContent: artifact(browserPlan),
      session: session(origin),
      allowedOrigins: options.allowedOrigins ?? [],
      evidencePolicy: options.evidencePolicy ?? DEFAULT_BROWSER_EVIDENCE_POLICY,
    },
    options.signal ?? new AbortController().signal,
  );
  return report;
}
```

Fix the two call sites that bypass the helper (construct `PlaywrightBrowserVerifier` directly): at the test titled `'fails closed on an untrusted preview prefix'` (around line 587) and the test with the injected `javascript` action kind (around line 1687). For each, add `evidencePolicy: DEFAULT_BROWSER_EVIDENCE_POLICY,` to the input object, and change `const report = await new PlaywrightBrowserVerifier().verify(` to `const { report } = await new PlaywrightBrowserVerifier().verify(`.

Then add new tests at the end of the `describe('PlaywrightBrowserVerifier', ...)` block:

```ts
it('captures one screenshot per executed step with viewport, url, and hash', async () => {
  const origin = await serve((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<h1>Fixture</h1>');
  });
  const browserPlan = plan([
    { id: 'open', title: 'Open fixture', action: { kind: 'goto', path: '/' }, assertions: [] },
  ]);

  const { evidence } = await new PlaywrightBrowserVerifier().verify(
    {
      planArtifact: PLAN_ARTIFACT,
      planContent: artifact(browserPlan),
      session: session(origin),
      allowedOrigins: [],
      evidencePolicy: DEFAULT_BROWSER_EVIDENCE_POLICY,
    },
    new AbortController().signal,
  );

  expect(evidence.screenshots).toHaveLength(1);
  expect(evidence.screenshots[0]).toMatchObject({
    stepId: 'open',
    viewport: { width: 900, height: 600 },
  });
  expect(evidence.screenshots[0]!.buffer.byteLength).toBeGreaterThan(0);
  expectRedacted(evidence.screenshots[0]!.url);
  expect(evidence.trace).toBeUndefined();
  expect(evidence.video).toBeUndefined();
});

it('captures a trace only when the evidence policy requests it', async () => {
  const origin = await serve((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<h1>Fixture</h1>');
  });
  const browserPlan = plan([
    { id: 'open', title: 'Open fixture', action: { kind: 'goto', path: '/' }, assertions: [] },
  ]);

  const { evidence } = await new PlaywrightBrowserVerifier().verify(
    {
      planArtifact: PLAN_ARTIFACT,
      planContent: artifact(browserPlan),
      session: session(origin),
      allowedOrigins: [],
      evidencePolicy: { ...DEFAULT_BROWSER_EVIDENCE_POLICY, captureTrace: true },
    },
    new AbortController().signal,
  );

  expect(evidence.trace).toBeInstanceOf(Buffer);
  expect(evidence.trace!.byteLength).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/browser-verifier.test.ts -t "captures one screenshot"`
Expected: FAIL — `verify()` still returns a bare report; `evidence` is `undefined` when destructured, so `evidence.screenshots` throws.

- [ ] **Step 3: Write minimal implementation**

In `packages/executors/src/browser-verifier.ts`:

1. Add to imports: `import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';`, `import { tmpdir } from 'node:os';`, `import { join } from 'node:path';`, and add `type BrowserEvidencePolicy` to the `@agent-foundry/contracts` import list, and `type BrowserVerificationEvidence`, `type CapturedScreenshot` to the `@agent-foundry/domain` import list.

2. Replace the `verify()` method's signature and every early-return (there are 4 early returns before the browser launches: plan validation failed, missing session URL, wrong preview prefix, bad allowed origins). Each currently does:

```ts
      return BrowserVerificationReportSchema.parse({ ... });
```

Wrap each in the new shape — e.g. the first one (lines 109-124) becomes:

```ts
if (!parsed.success) {
  return {
    report: BrowserVerificationReportSchema.parse({
      schemaVersion: '1',
      approved: false,
      summary: 'Browser test plan validation failed.',
      planArtifact: input.planArtifact,
      previewSession,
      planValidationError: redact(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
          .join('; '),
        previewToken,
      ),
      steps: [],
    }),
    evidence: { screenshots: [] },
  };
}
```

Apply the identical `{ report: BrowserVerificationReportSchema.parse({...unchanged...}), evidence: { screenshots: [] } }` wrapping to the other 3 early returns (missing URL, wrong prefix, bad allowed origins) — the inner `BrowserVerificationReportSchema.parse({...})` argument is unchanged in every case, only the wrapping changes.

3. Change the `verify()` method's own return type annotation from `Promise<BrowserVerificationReport>` to `Promise<{ report: BrowserVerificationReport; evidence: BrowserVerificationEvidence }>`.

4. Change the browser-launch section (lines 178-221) to set up video recording and tracing, and to finalize evidence after `execute()` returns but before the outer `finally` closes the context. Replace:

```ts
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    const launch = chromium.launch({ headless: true });
    const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, timeout]);

    try {
      const run = (async () => {
        browser = await launch;
        context = await browser.newContext({
          viewport: parsed.data.data.viewport,
          serviceWorkers: 'block',
        });
        await context.grantPermissions(['local-network-access'], { origin: prefixUrl.origin });
        return this.execute(
          context,
          parsed.data.data,
          prefixUrl,
          token,
          allowedOrigins,
          input,
          previewSession,
        );
      })();
      return await Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          combinedSignal.addEventListener(
            'abort',
            () =>
              reject(
                signal.aborted
                  ? new RunCancelledError()
                  : new Error('Browser verification timed out.'),
              ),
            { once: true },
          );
        }),
      ]);
    } finally {
      if (context) await context.close().catch(() => undefined);
      const launched = browser ?? (await launch.catch(() => undefined));
      await launched?.close().catch(() => undefined);
    }
  }
```

with:

```ts
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let tracingStarted = false;
    const evidencePolicy = input.evidencePolicy;
    const videoDir = evidencePolicy.captureVideo
      ? await mkdtemp(join(tmpdir(), 'agent-foundry-browser-video-'))
      : undefined;
    const launch = chromium.launch({ headless: true });
    const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, timeout]);

    try {
      const run = (async () => {
        browser = await launch;
        context = await browser.newContext({
          viewport: parsed.data.data.viewport,
          serviceWorkers: 'block',
          ...(videoDir
            ? { recordVideo: { dir: videoDir, size: parsed.data.data.viewport } }
            : {}),
        });
        await context.grantPermissions(['local-network-access'], { origin: prefixUrl.origin });
        if (evidencePolicy.captureTrace) {
          await context.tracing.start({ screenshots: true, snapshots: true });
          tracingStarted = true;
        }
        return this.execute(
          context,
          parsed.data.data,
          prefixUrl,
          token,
          allowedOrigins,
          input,
          previewSession,
        );
      })();
      const result = await Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          combinedSignal.addEventListener(
            'abort',
            () =>
              reject(
                signal.aborted
                  ? new RunCancelledError()
                  : new Error('Browser verification timed out.'),
              ),
            { once: true },
          );
        }),
      ]);

      let trace: Buffer | undefined;
      if (tracingStarted && context) {
        const traceDir = await mkdtemp(join(tmpdir(), 'agent-foundry-browser-trace-'));
        const tracePath = join(traceDir, 'trace.zip');
        await context.tracing.stop({ path: tracePath });
        trace = await readFile(tracePath);
        await rm(traceDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (context) await context.close().catch(() => undefined);
      context = undefined;

      let video: Buffer | undefined;
      if (videoDir) {
        const files = await readdir(videoDir).catch(() => [] as string[]);
        const videoFile = files.find((file) => file.endsWith('.webm'));
        if (videoFile) video = await readFile(join(videoDir, videoFile));
      }

      return {
        report: result.report,
        evidence: {
          ...result.evidence,
          ...(trace ? { trace } : {}),
          ...(video ? { video } : {}),
        },
      };
    } finally {
      if (context) await context.close().catch(() => undefined);
      const launched = browser ?? (await launch.catch(() => undefined));
      await launched?.close().catch(() => undefined);
      if (videoDir) await rm(videoDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
```

5. Change `execute()`'s signature return type from `Promise<BrowserVerificationReport>` to `Promise<{ report: BrowserVerificationReport; evidence: BrowserVerificationEvidence }>`, capture a screenshot per executed step, and wrap the final return. Inside the `for (const [index, step] of plan.steps.entries())` loop, after the existing `try { ... } catch (error) { ... }` block (right after the step is pushed in both the success and failure paths — i.e., right before the loop's closing brace), add:

```ts
await this.captureScreenshot(page, step.id, plan.viewport, token, screenshots);
```

Declare `const screenshots: CapturedScreenshot[] = [];` right before the `for` loop (alongside the existing `const steps: StepReport[] = [];`).

Change the final return of `execute()` from:

```ts
    return BrowserVerificationReportSchema.parse({
      schemaVersion: '1',
      approved,
      summary: ...,
      planArtifact: input.planArtifact,
      previewSession,
      steps,
    });
  }
```

to:

```ts
    return {
      report: BrowserVerificationReportSchema.parse({
        schemaVersion: '1',
        approved,
        summary: approved
          ? 'All browser verification steps passed.'
          : `${steps.filter((step) => step.status === 'failed').length} browser step failure(s) and ${runObservations.length} passive failure(s).`,
        planArtifact: input.planArtifact,
        previewSession,
        steps,
      }),
      evidence: { screenshots },
    };
  }

  private async captureScreenshot(
    page: Page,
    stepId: string,
    viewport: { width: number; height: number },
    token: string | null,
    sink: CapturedScreenshot[],
  ): Promise<void> {
    try {
      const buffer = await page.screenshot({ type: 'png' });
      sink.push({ stepId, url: sanitizeUrl(page.url(), token), viewport, buffer });
    } catch {
      // Best-effort evidence: a closed or mid-navigation page must not fail verification.
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/browser-verifier.test.ts`
Expected: PASS — all ~40 tests (38 existing + 2 new). This requires Chromium to be installed locally: `npx playwright install chromium` if not already present (per ADR 0020's existing setup instructions — this repo's CI already does this for the existing suite).

- [ ] **Step 5: Commit**

```bash
git add packages/executors/src/browser-verifier.ts packages/executors/src/browser-verifier.test.ts
git commit -m "feat(executors): capture screenshot, trace, and video evidence during browser verification"
```

---

### Task 9: Orchestrator — `BrowserVerificationCoordinator` persists evidence

**Files:**

- Modify: `packages/orchestrator/src/browser-verification-coordinator.ts`
- Modify: `packages/orchestrator/src/browser-verification-coordinator.test.ts`

**Interfaces:**

- Consumes: `BrowserScreenshotEvidence` from `@agent-foundry/contracts` (Task 2). `ArtifactStore`, `BrowserVerificationEvidence` from `@agent-foundry/domain` (Task 4). `Readable` from `node:stream`.
- Produces: `BrowserVerificationCoordinator` constructor gains 2 params: `artifacts: Pick<ArtifactStore, 'putBlob'>` and `limits: { maxScreenshotBytes: number; maxTraceBytes: number; maxVideoBytes: number; retentionSeconds: number }` (these byte ceilings come only from `RuntimeConfig`/Task 7 — the single source of truth; `BrowserEvidencePolicy` from Task 3 carries only the `captureTrace`/`captureVideo` toggles). `BrowserVerificationInput` gains `evidencePolicy: BrowserEvidencePolicy`. The final report's `previewSession.evidence` is populated with real `ArtifactReference`/`BrowserScreenshotEvidence` values (was always `{ screenshots: [] }` before). A `putBlob` call that exceeds its `maxBytes` (`ArtifactTooLargeError`, Task 4) is caught here and that one piece of evidence is silently omitted — it must never fail the whole verification.

- [ ] **Step 1: Write the failing test**

In `packages/orchestrator/src/browser-verification-coordinator.test.ts`:

1. Update the `setup()` helper (lines 96-112) to accept and pass through a fake `artifacts` store, and give `BrowserVerificationCoordinator` its 2 new constructor args:

```ts
function setup(
  verify: BrowserVerifier['verify'],
  artifacts: Pick<ArtifactStore, 'putBlob'> = {
    putBlob: () => Promise.reject(new Error('putBlob should not be called by this fixture')),
  },
) {
  const stopped: string[] = [];
  const session = runningSession();
  const previews = {
    start: () => Promise.resolve({ session, url: session.url! }),
    stop: (sessionId: string) => {
      stopped.push(sessionId);
      return Promise.resolve({
        ...session,
        status: 'stopped' as const,
        completedAt: '2026-07-17T12:00:02.000Z',
      });
    },
  } satisfies Pick<PreviewService, 'start' | 'stop'>;
  const coordinator = new BrowserVerificationCoordinator(previews, { verify }, artifacts, {
    maxScreenshotBytes: 5_000_000,
    maxTraceBytes: 20_000_000,
    maxVideoBytes: 50_000_000,
    retentionSeconds: 604_800,
  });
  return { coordinator, stopped };
}
```

2. Add `ArtifactStore` to the `@agent-foundry/domain` import, and `DEFAULT_BROWSER_EVIDENCE_POLICY` to the `@agent-foundry/contracts` import.

3. Update every existing `verify: () => Promise.resolve(report())` (and its variants that reject or mutate) to wrap the report in `{ report: ..., evidence: { screenshots: [] } }`. Concretely:
   - `setup(() => Promise.resolve(report()))` → `setup(() => Promise.resolve({ report: report(), evidence: { screenshots: [] } }))`
   - `setup(() => Promise.resolve(mutate(report())))` → `setup(() => Promise.resolve({ report: mutate(report()), evidence: { screenshots: [] } }))`
   - The direct `new BrowserVerificationCoordinator(...)` construction at line 174-180 (the "preserves verifier and preview stop failures" test) needs the 2 new args too — reuse the same `{ maxScreenshotBytes: ..., ... }` limits object and a stub `artifacts` with a rejecting `putBlob`.
   - The `report()` helper builder itself is unchanged (it returns a bare `BrowserVerificationReport`, which is exactly what `{ report: report(), evidence: ... }` wraps).

4. Add `evidencePolicy: DEFAULT_BROWSER_EVIDENCE_POLICY` to the shared `input` object (line 114-120).

5. Add a new test after the existing ones:

```ts
it('persists captured evidence via putBlob and attaches references to the report', async () => {
  const putCalls: string[] = [];
  const artifacts: Pick<ArtifactStore, 'putBlob'> = {
    putBlob: (blobInput) => {
      putCalls.push(blobInput.name);
      return Promise.resolve({
        projectId: 'project-1',
        name: blobInput.name,
        revision: 1,
        contentType: blobInput.contentType,
        createdAt: '2026-07-17T12:00:03.000Z',
        createdBy: blobInput.createdBy,
        sha256: 'c'.repeat(64),
        storage: 'blob',
        sizeBytes: 128,
      });
    },
  };
  const { coordinator } = setup(
    () =>
      Promise.resolve({
        report: report(),
        evidence: {
          screenshots: [
            {
              stepId: 'open-items',
              url: 'http://127.0.0.1:4000/preview/preview-1/items',
              viewport: { width: 1280, height: 720 },
              buffer: Buffer.from('fake screenshot'),
            },
          ],
          trace: Buffer.from('fake trace'),
          video: Buffer.from('fake video'),
        },
      }),
    artifacts,
  );

  const result = await coordinator.verify(input, new AbortController().signal);

  expect(putCalls).toHaveLength(3);
  expect(result.previewSession.evidence.screenshots).toEqual([
    {
      name: putCalls[0],
      revision: 1,
      sha256: 'c'.repeat(64),
      sizeBytes: 128,
      stepId: 'open-items',
      url: 'http://127.0.0.1:4000/preview/preview-1/items',
      viewport: { width: 1280, height: 720 },
    },
  ]);
  expect(result.previewSession.evidence.trace).toEqual({
    name: putCalls[1],
    revision: 1,
    sha256: 'c'.repeat(64),
    sizeBytes: 128,
  });
  expect(result.previewSession.evidence.video).toEqual({
    name: putCalls[2],
    revision: 1,
    sha256: 'c'.repeat(64),
    sizeBytes: 128,
  });
});

it('drops evidence that exceeds its size limit instead of failing verification', async () => {
  const artifacts: Pick<ArtifactStore, 'putBlob'> = {
    putBlob: (blobInput) => {
      if (blobInput.name.startsWith('browser-trace-')) {
        return Promise.reject(new ArtifactTooLargeError(blobInput.maxBytes));
      }
      return Promise.resolve({
        projectId: 'project-1',
        name: blobInput.name,
        revision: 1,
        contentType: blobInput.contentType,
        createdAt: '2026-07-17T12:00:03.000Z',
        createdBy: blobInput.createdBy,
        sha256: 'c'.repeat(64),
        storage: 'blob',
        sizeBytes: 128,
      });
    },
  };
  const { coordinator } = setup(
    () =>
      Promise.resolve({
        report: report(),
        evidence: {
          screenshots: [
            {
              stepId: 'open-items',
              url: 'http://127.0.0.1:4000/preview/preview-1/items',
              viewport: { width: 1280, height: 720 },
              buffer: Buffer.from('fake screenshot'),
            },
          ],
          trace: Buffer.from('too big'),
        },
      }),
    artifacts,
  );

  const result = await coordinator.verify(input, new AbortController().signal);

  expect(result.previewSession.evidence.trace).toBeUndefined();
  expect(result.previewSession.evidence.screenshots).toHaveLength(1);
});
```

Add `ArtifactTooLargeError` to the existing `@agent-foundry/domain` import at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/browser-verification-coordinator.test.ts`
Expected: FAIL — constructor arity mismatch (existing calls pass 2 args, new signature needs 4), verifier mocks return the wrong shape, `ArtifactTooLargeError` isn't caught yet so the new test's `verify()` call rejects instead of resolving.

- [ ] **Step 3: Write minimal implementation**

In `packages/orchestrator/src/browser-verification-coordinator.ts`:

1. Add to imports: `import { Readable } from 'node:stream';`, `import type { BrowserScreenshotEvidence } from '@agent-foundry/contracts';`, `import { ArtifactTooLargeError, type ArtifactBlobPutInput, type ArtifactStore } from '@agent-foundry/domain';`.
2. Add `evidencePolicy: BrowserEvidencePolicy` to `BrowserVerificationInput` (import `BrowserEvidencePolicy` type from `@agent-foundry/contracts` too), and add a `limits` type + 2 new constructor params:

```ts
export interface BrowserVerificationInput {
  projectId: string;
  workspacePath: string;
  runId: string;
  plan: StoredArtifact;
  allowedOrigins: string[];
  evidencePolicy: BrowserEvidencePolicy;
}

export interface BrowserEvidenceLimits {
  maxScreenshotBytes: number;
  maxTraceBytes: number;
  maxVideoBytes: number;
  retentionSeconds: number;
}

export class BrowserVerificationCoordinator {
  constructor(
    private readonly previews: Pick<PreviewService, 'start' | 'stop'>,
    private readonly verifier: BrowserVerifier,
    private readonly artifacts: Pick<ArtifactStore, 'putBlob'>,
    private readonly limits: BrowserEvidenceLimits,
  ) {}
```

3. Update the `verify()` method body — replace the `try` block's `return validateBrowserVerificationReportBinding(...)` (lines 68-83) with:

```ts
const { report: verifierReport, evidence } = await this.verifier.verify(
  {
    planArtifact,
    planContent: input.plan.content,
    session,
    allowedOrigins: input.allowedOrigins,
    evidencePolicy: input.evidencePolicy,
  },
  signal,
);
const validated = validateBrowserVerificationReportBinding(verifierReport, {
  planArtifact,
  planContent: input.plan.content,
  previewSession: publicSession,
});
return await this.attachEvidence(validated, evidence, input);
```

4. Add 2 private methods after `verify()`:

```ts
  private async attachEvidence(
    report: BrowserVerificationReport,
    evidence: BrowserVerificationEvidence,
    input: BrowserVerificationInput,
  ): Promise<BrowserVerificationReport> {
    if (evidence.screenshots.length === 0 && !evidence.trace && !evidence.video) return report;
    const sessionId = report.previewSession.sessionId;

    const screenshots: BrowserScreenshotEvidence[] = [];
    for (const shot of evidence.screenshots) {
      const metadata = await this.putBlobOrSkip(
        {
          projectId: input.projectId,
          name: `browser-screenshot-${sessionId}-${shot.stepId}`,
          contentType: 'image/png',
          createdBy: 'browser-verifier',
          maxBytes: this.limits.maxScreenshotBytes,
          runId: input.runId,
          retentionSeconds: this.limits.retentionSeconds,
        },
        Readable.from(shot.buffer),
      );
      if (!metadata) continue;
      screenshots.push({
        name: metadata.name,
        revision: metadata.revision,
        sha256: metadata.sha256,
        sizeBytes: metadata.sizeBytes,
        stepId: shot.stepId,
        url: shot.url,
        viewport: shot.viewport,
      });
    }

    let trace: ArtifactReference | undefined;
    if (evidence.trace) {
      const metadata = await this.putBlobOrSkip(
        {
          projectId: input.projectId,
          name: `browser-trace-${sessionId}`,
          contentType: 'application/zip',
          createdBy: 'browser-verifier',
          maxBytes: this.limits.maxTraceBytes,
          runId: input.runId,
          retentionSeconds: this.limits.retentionSeconds,
        },
        Readable.from(evidence.trace),
      );
      if (metadata) {
        trace = { name: metadata.name, revision: metadata.revision, sha256: metadata.sha256, sizeBytes: metadata.sizeBytes };
      }
    }

    let video: ArtifactReference | undefined;
    if (evidence.video) {
      const metadata = await this.putBlobOrSkip(
        {
          projectId: input.projectId,
          name: `browser-video-${sessionId}`,
          contentType: 'video/webm',
          createdBy: 'browser-verifier',
          maxBytes: this.limits.maxVideoBytes,
          runId: input.runId,
          retentionSeconds: this.limits.retentionSeconds,
        },
        Readable.from(evidence.video),
      );
      if (metadata) {
        video = { name: metadata.name, revision: metadata.revision, sha256: metadata.sha256, sizeBytes: metadata.sizeBytes };
      }
    }

    return BrowserVerificationReportSchema.parse({
      ...report,
      previewSession: {
        ...report.previewSession,
        evidence: {
          ...report.previewSession.evidence,
          screenshots,
          ...(trace ? { trace } : {}),
          ...(video ? { video } : {}),
        },
      },
    });
  }

  private async putBlobOrSkip(
    input: ArtifactBlobPutInput,
    source: Readable,
  ): Promise<ArtifactMetadata | undefined> {
    try {
      return await this.artifacts.putBlob(input, source);
    } catch (error) {
      if (error instanceof ArtifactTooLargeError) return undefined;
      throw error;
    }
  }
```

Add `ArtifactMetadata` to the existing `@agent-foundry/contracts` type-only import list in `browser-verification-coordinator.ts` (needed for `putBlobOrSkip`'s return type).

5. Add `type BrowserVerificationEvidence` to the `@agent-foundry/domain` import (alongside `BrowserVerifier`), and `type ArtifactReference` is already imported.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/browser-verification-coordinator.test.ts`
Expected: PASS (7 existing tests, updated in place, + 2 new)

- [ ] **Step 5: Run the full orchestrator suite to catch any other consumer**

Run: `npx vitest run packages/orchestrator`
Expected: FAIL at this point specifically in `workflow-orchestrator.test.ts`/`workflow-orchestrator.ts` — that's expected and fixed in Task 10.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/browser-verification-coordinator.ts packages/orchestrator/src/browser-verification-coordinator.test.ts
git commit -m "feat(orchestrator): persist browser verification evidence as blob artifacts"
```

---

### Task 10: Orchestrator + Composition — wire `evidencePolicy` through the workflow and DI container

**Files:**

- Modify: `packages/orchestrator/src/workflow-orchestrator.ts:1414-1421`
- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**

- Consumes: `DEFAULT_BROWSER_EVIDENCE_POLICY` from `@agent-foundry/contracts`. `RuntimeConfig.artifactMax*Bytes`/`artifactRetentionSeconds` (Task 7). `BrowserVerificationCoordinator`'s new constructor arity (Task 9).
- Produces: the real `verify()` call site now passes `evidencePolicy: policy.browserEvidence ?? DEFAULT_BROWSER_EVIDENCE_POLICY`. `createRuntime()` wires `artifacts` and the configured limits into both the real and mock `BrowserVerificationCoordinator`.

This task is pure wiring with no new observable behavior of its own — Tasks 8 and 9 already have direct unit coverage for capture and persistence. The compiler is the test here: a wiring mismatch is a type error, not a runtime behavior to assert on.

- [ ] **Step 1: Confirm the wiring gap with a failing typecheck**

Run: `npx tsc -b packages/orchestrator packages/composition --force --pretty false 2>&1 | head -40`
Expected: FAIL — `workflow-orchestrator.ts`'s call to `this.browserVerification.verify(...)` is missing the now-required `evidencePolicy` field; `runtime.ts`'s `new BrowserVerificationCoordinator(previewService, browserVerifier)` and `mockBrowserVerificationCoordinator()`'s inline `verifier.verify` are missing the new constructor args / new return shape.

- [ ] **Step 2: Write minimal implementation**

In `packages/orchestrator/src/workflow-orchestrator.ts`, add `evidencePolicy` to the `verify()` call (around line 1414-1421):

```ts
        const report = await this.browserVerification.verify(
          {
            projectId: project.id,
            workspacePath: this.workspaces.workspacePath(project.id),
            runId,
            plan: browserPlan,
            allowedOrigins: policy.browserAllowedOrigins ?? [],
            evidencePolicy: policy.browserEvidence ?? DEFAULT_BROWSER_EVIDENCE_POLICY,
          },
```

Add `DEFAULT_BROWSER_EVIDENCE_POLICY` to the existing `@agent-foundry/contracts` import at the top of `workflow-orchestrator.ts`.

In `packages/composition/src/runtime.ts`:

1. Build the limits object once, after `const browserVerifier = new PlaywrightBrowserVerifier();`:

```ts
const browserVerifier = new PlaywrightBrowserVerifier();
const browserEvidenceLimits = {
  maxScreenshotBytes: config.artifactMaxScreenshotBytes,
  maxTraceBytes: config.artifactMaxTraceBytes,
  maxVideoBytes: config.artifactMaxVideoBytes,
  retentionSeconds: config.artifactRetentionSeconds,
};
const browserVerification =
  config.executorMode === 'mock'
    ? mockBrowserVerificationCoordinator(artifacts, browserEvidenceLimits)
    : new BrowserVerificationCoordinator(
        previewService,
        browserVerifier,
        artifacts,
        browserEvidenceLimits,
      );
```

2. Update `mockBrowserVerificationCoordinator` to accept and forward these:

```ts
function mockBrowserVerificationCoordinator(
  artifacts: Pick<FileArtifactStore, 'putBlob'>,
  limits: {
    maxScreenshotBytes: number;
    maxTraceBytes: number;
    maxVideoBytes: number;
    retentionSeconds: number;
  },
): BrowserVerificationCoordinator {
  let sequence = 0;
  const sessions = new Map<string, PreviewSession>();
  const previews: Pick<PreviewService, 'start' | 'stop'> = {
    // ... unchanged ...
  };
  const verifier: BrowserVerifier = {
    verify: (input) => {
      const plan = BrowserTestPlanArtifactSchema.parse(input.planContent).data;
      return Promise.resolve({
        report: {
          schemaVersion: '1',
          approved: true,
          summary: 'Mock browser verification passed.',
          planArtifact: input.planArtifact,
          previewSession: {
            ...input.session,
            url: input.session.url?.replace(/\?.*$/, ''),
          },
          steps: plan.steps.map((step) => ({
            stepId: step.id,
            title: step.title,
            status: 'passed' as const,
            durationMs: 0,
            observations: [],
          })),
        },
        evidence: { screenshots: [] },
      });
    },
  };
  return new BrowserVerificationCoordinator(previews, verifier, artifacts, limits);
}
```

(Only the `verifier.verify` return value and the function's parameter list change — `previews` and `sessions` logic are untouched.)

- [ ] **Step 3: Run test to verify it passes**

Run: `npx tsc -b packages/orchestrator packages/composition --force --pretty false`
Expected: PASS (clean compile, no errors)

Run: `npx vitest run packages/orchestrator packages/composition`
Expected: PASS — this is also where `workflow-orchestrator.test.ts`'s browser-verify-step tests (if any construct a fake `BrowserVerificationCoordinator` or stub `verify`) get exercised; per the earlier repo read, that file's one browser-related stub (`verify: () => Promise.reject(...)`) is never actually invoked by its fixture, so no further change should be needed there — but run the suite to confirm.

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/workflow-orchestrator.ts packages/composition/src/runtime.ts
git commit -m "feat(composition): wire browser evidence policy and limits into the runtime"
```

---

### Task 11: API — stream a blob artifact for download

**Files:**

- Modify: `apps/api/src/app.ts`
- Modify: `packages/orchestrator/src/project-service.ts`
- Create: `apps/api/src/artifacts.test.ts`

**Interfaces:**

- Consumes: `runtime.artifacts.getBlobStream` (Task 6), `runtime.projectService.getArtifact` (existing, for metadata).
- Produces: `ProjectService.getArtifactBlob(projectId, name, revision?)` → `{ metadata: ArtifactMetadata; stream: Readable } | 'gone'` (mirrors `getArtifact`'s existing `NotFoundError`-on-missing convention, plus a `'gone'` sentinel for a reaped blob). New route `GET /projects/:projectId/artifacts/:name/blob`.

This task depends only on Task 6 (`getBlobStream`) — it can run in parallel with Tasks 8/9/10.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/artifacts.test.ts`, following the exact `startApi()`/`createProject()` pattern already used in `apps/api/src/preview.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startApi(): Promise<{ baseUrl: string; runtime: Runtime }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-artifacts-'));
  dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'artifacts-worker',
  });
  const app = await buildApp(runtime);
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { baseUrl, runtime };
}

async function createProject(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Artifact sample', prd: 'x'.repeat(60) }),
  });
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

describe('artifact blob download route', () => {
  it('streams a blob artifact with its content type and length', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const content = Buffer.from('a screenshot, pretend');
    await runtime.artifacts.putBlob(
      {
        projectId,
        name: 'browser-screenshot-preview-1-open-items',
        contentType: 'image/png',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
      },
      Readable.from(content),
    );

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/artifacts/browser-screenshot-preview-1-open-items/blob`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(content.byteLength));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
  });

  it('returns 404 for an artifact that was never written', async () => {
    const { baseUrl, projectId } = await (async () => {
      const started = await startApi();
      return { ...started, projectId: await createProject(started.baseUrl) };
    })();

    const response = await fetch(`${baseUrl}/projects/${projectId}/artifacts/missing/blob`);
    expect(response.status).toBe(404);
  });

  it('returns 410 for a blob that already expired and was reaped', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const metadata = await runtime.artifacts.putBlob(
      {
        projectId,
        name: 'browser-trace-preview-1',
        contentType: 'application/zip',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
        retentionSeconds: 1,
      },
      Readable.from(Buffer.from('trace bytes')),
    );
    await runtime.artifacts.reapExpired(new Date(Date.parse(metadata.expiresAt!) + 1_000));

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/artifacts/browser-trace-preview-1/blob`,
    );
    expect(response.status).toBe(410);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/artifacts.test.ts`
Expected: FAIL — route doesn't exist (404 for everything, including the first "should be 200" case).

- [ ] **Step 3: Write minimal implementation**

In `packages/orchestrator/src/project-service.ts`, add a method right after the existing `getArtifact` (after line 187):

```ts
  async getArtifactBlob(
    projectId: string,
    name: string,
    revision?: number,
  ): Promise<{ metadata: ArtifactMetadata; stream: NodeJS.ReadableStream } | 'gone'> {
    const artifact = await this.getArtifact(projectId, name, revision);
    if (artifact.metadata.blobDeleted) return 'gone';
    const stream = await this.artifacts.getBlobStream(
      projectId,
      artifact.metadata.name,
      artifact.metadata.revision,
    );
    if (!stream) return 'gone';
    return { metadata: artifact.metadata, stream };
  }
```

Add `ArtifactMetadata` to the existing `@agent-foundry/contracts` type-only import list at the top of `project-service.ts`.

In `apps/api/src/app.ts`, add a new route right after the existing `GET /projects/:projectId/artifacts/:name` route (after line 151):

```ts
app.get('/projects/:projectId/artifacts/:name/blob', async (request, reply) => {
  const { projectId, name } = z
    .object({ projectId: PathSegmentSchema, name: PathSegmentSchema })
    .parse(request.params);
  const { revision } = z
    .object({ revision: z.coerce.number().int().positive().optional() })
    .parse(request.query);
  const result = await runtime.projectService.getArtifactBlob(projectId, name, revision);
  if (result === 'gone') {
    return reply.status(410).send({ error: 'Gone', message: `Artifact ${name} has expired.` });
  }
  reply.header('content-type', result.metadata.contentType);
  if (result.metadata.sizeBytes !== undefined) {
    reply.header('content-length', String(result.metadata.sizeBytes));
  }
  return reply.send(result.stream);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/artifacts.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/project-service.ts apps/api/src/app.ts apps/api/src/artifacts.test.ts
git commit -m "feat(api): stream blob artifacts for download without exposing local paths"
```

---

### Task 12: API — artifact retention reaper

**Files:**

- Create: `apps/api/src/artifact-reaper.ts`
- Create: `apps/api/src/artifact-reaper.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**

- Consumes: `runtime.artifacts.reapExpired` (Task 6), `runtime.config.artifactReapIntervalMs` (Task 7).
- Produces: `startArtifactReaper(service, intervalMs, logger, app): ArtifactReaperSchedule` — an exact structural mirror of `startPreviewReaper` in `apps/api/src/preview-reaper.ts`, adapted to call `reapExpired(new Date())` instead of a no-arg `reap()`.

This task depends only on Tasks 6 and 7 — it can run in parallel with Tasks 8/9/10/11.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/artifact-reaper.test.ts` as a close adaptation of the existing `apps/api/src/preview-reaper.test.ts` (read that file first for the exact fake-timer idioms), swapping `reap: vi.fn()` for a `reapExpired: vi.fn()` that receives a `Date`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { startArtifactReaper } from './artifact-reaper.js';

afterEach(() => vi.useRealTimers());

describe('artifact reaper schedule', () => {
  it('runs immediately, passes the current time, and prevents interval overlap', async () => {
    let finish!: () => void;
    const firstSweep = new Promise<void>((resolveSweep) => {
      finish = resolveSweep;
    });
    const reapExpired = vi
      .fn()
      .mockReturnValueOnce(firstSweep.then(() => 0))
      .mockResolvedValueOnce(2);
    const logger = { error: vi.fn() };
    vi.useFakeTimers();
    const app = Fastify();
    const schedule = startArtifactReaper({ reapExpired }, 10, logger, app);

    await vi.advanceTimersByTimeAsync(0);
    expect(reapExpired).toHaveBeenCalledTimes(1);
    expect(reapExpired.mock.calls[0]![0]).toBeInstanceOf(Date);
    await vi.advanceTimersByTimeAsync(30);
    expect(reapExpired).toHaveBeenCalledTimes(1);
    finish();
    await firstSweep;
    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTicks();
    expect(reapExpired).toHaveBeenCalledTimes(2);

    await schedule.stop();
    await app.close();
  });

  it('logs and continues after a failed sweep', async () => {
    const reapExpired = vi.fn().mockRejectedValueOnce(new Error('disk error')).mockResolvedValue(0);
    const logger = { error: vi.fn() };
    vi.useFakeTimers();
    const app = Fastify();
    const schedule = startArtifactReaper({ reapExpired }, 10, logger, app);

    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(expect.any(Error), 'Artifact reaper sweep failed');

    await schedule.stop();
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/artifact-reaper.test.ts`
Expected: FAIL — `./artifact-reaper.js` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/api/src/artifact-reaper.ts` (adapted from `apps/api/src/preview-reaper.ts`):

```ts
import type { FastifyInstance } from 'fastify';

interface ArtifactReaperLogger {
  error(error: unknown, message: string): void;
}

interface ArtifactReaperService {
  reapExpired(now: Date): Promise<number>;
}

export interface ArtifactReaperSchedule {
  stop(): Promise<void>;
}

export function startArtifactReaper(
  service: ArtifactReaperService,
  intervalMs: number,
  logger: ArtifactReaperLogger,
  app: FastifyInstance,
): ArtifactReaperSchedule {
  let active: Promise<void> | undefined;
  const sweep = () => {
    if (active) return;
    try {
      active = service
        .reapExpired(new Date())
        .catch((error: unknown) => logger.error(error, 'Artifact reaper sweep failed'))
        .then(() => undefined)
        .finally(() => {
          active = undefined;
        });
    } catch (error) {
      logger.error(error, 'Artifact reaper sweep failed');
    }
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();

  let stopPromise: Promise<void> | undefined;
  const schedule: ArtifactReaperSchedule = {
    stop() {
      stopPromise ??= (async () => {
        clearInterval(timer);
        await active;
      })();
      return stopPromise;
    },
  };
  app.addHook('onClose', () => schedule.stop());
  return schedule;
}
```

In `apps/api/src/index.ts`, add the import and wire it up right after the existing preview reaper:

```ts
import { startArtifactReaper } from './artifact-reaper.js';
```

```ts
startPreviewReaper(runtime.previewService, runtime.config.previewReapIntervalMs, app.log, app);
startArtifactReaper(runtime.artifacts, runtime.config.artifactReapIntervalMs, app.log, app);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/artifact-reaper.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/artifact-reaper.ts apps/api/src/artifact-reaper.test.ts apps/api/src/index.ts
git commit -m "feat(api): sweep expired blob artifacts on an interval"
```

---

### Task 13: Web — blob download URL helper

**Files:**

- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/lib/api.test.ts`

**Interfaces:**

- Produces: `getArtifactBlobUrl(projectId: string, name: string, revision?: number): string` — builds the absolute API URL for the Task 11 download route (for use in `<img src>`/`<a href download>`; not a `fetch`-wrapping wrapper since the browser should hit the route directly for streaming).

This task depends only on Task 11.

- [ ] **Step 1: Write the failing test**

Check `apps/web/lib/api.test.ts` for its existing style (it exists per the baseline test run — 6 passing tests), then add:

```ts
describe('getArtifactBlobUrl', () => {
  it('builds the download URL for the latest revision', () => {
    expect(getArtifactBlobUrl('project-1', 'browser-screenshot-preview-1-open-items')).toBe(
      'http://localhost:4000/projects/project-1/artifacts/browser-screenshot-preview-1-open-items/blob',
    );
  });

  it('includes an explicit revision when provided', () => {
    expect(getArtifactBlobUrl('project-1', 'browser-trace-preview-1', 2)).toBe(
      'http://localhost:4000/projects/project-1/artifacts/browser-trace-preview-1/blob?revision=2',
    );
  });
});
```

(Match whatever `API_URL` default the test file already observes — per the source, it's `http://localhost:4000` absent `NEXT_PUBLIC_API_URL`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/api.test.ts`
Expected: FAIL — `getArtifactBlobUrl` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `apps/web/lib/api.ts`, add right after the existing `getArtifact` function:

```ts
export function getArtifactBlobUrl(projectId: string, name: string, revision?: number): string {
  const query = revision ? `?revision=${revision}` : '';
  return `${API_URL}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(name)}/blob${query}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/api.test.ts`
Expected: PASS (8 tests: 6 existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api.ts apps/web/lib/api.test.ts
git commit -m "feat(web): add a blob artifact download URL helper"
```

---

### Task 14: ADR, full verification, and evidence for closing the issue

**Files:**

- Create: `docs/adr/0022-browser-evidence-artifacts.md`

**Interfaces:** none — this is the closing task: document the decision, then run the project's full gate.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0022-browser-evidence-artifacts.md`, following the exact section structure of `docs/adr/0020-declarative-browser-verification.md` (Status/Date/Owners header, Context, Decision, Alternatives considered, Consequences, Migration/rollback/validation):

```markdown
# ADR 0022: Browser evidence artifacts — blob storage, capture, and retention

- Status: Accepted
- Date: 2026-07-17
- Owners: Contracts, Persistence, Executors, Orchestrator, Composition, and API

## Context

ADR 0020 deferred binary browser evidence (screenshots, trace, video) to issue #33, keeping the initial declarative browser verification report pure JSON. That evidence is large relative to every other artifact this system stores, needs its own retention (it must not accumulate forever on a self-hosted machine), and must never hand the web UI a local filesystem path.

## Decision

`FileArtifactStore` grows a second, binary-shaped path alongside its existing JSON path: `putBlob`/`getBlobStream` stream bytes to/from `<project>/artifacts/<name>/blobs/<revision>.bin` via a new `atomicWriteStream` primitive that hashes and counts bytes while writing, rejecting (and cleaning up) anything over a configured limit — never buffering the whole blob in memory at the store layer. Metadata for a blob artifact reuses the exact same per-revision JSON file and `index.json` as inline artifacts (with `content: null` and `storage: 'blob'`), so every existing artifact-listing code path keeps working unmodified.

`PlaywrightBrowserVerifier` captures one PNG screenshot per executed step (always) plus an optional trace/video gated by a new `ProjectPolicy.browserEvidence` policy block (`captureTrace`, `captureVideo` — a per-project on/off decision only). Byte ceilings are deliberately not part of that policy: they're an operational concern, not a per-project one, so they live once in `RuntimeConfig` (`ARTIFACT_MAX_SCREENSHOT_BYTES`/`ARTIFACT_MAX_TRACE_BYTES`/`ARTIFACT_MAX_VIDEO_BYTES`) and are enforced only at `FileArtifactStore.putBlob`. Because `executors` may not import `persistence`, the verifier returns captured evidence as plain `Buffer`s next to its existing JSON report (`{ report, evidence }`) instead of writing to the store itself. `BrowserVerificationCoordinator` (the one place holding both the verifier and the store) persists each buffer via `putBlob` only _after_ the existing plan/session binding check passes, then attaches the resulting `ArtifactReference`s (a screenshot also carries `stepId`, `url`, and `viewport`) to `previewSession.evidence`, which ADR 0020 defined but nothing populated until now. If a capture exceeds its configured ceiling, `putBlob` throws `ArtifactTooLargeError`; the coordinator catches it and drops just that one piece of evidence rather than failing the whole verification — a browser test run that passed must not turn into a failure because its video happened to be large.

An artifact is "the external reference" the acceptance criteria call for by construction: its JSON metadata (hash, size, content type) is cheap and always loaded, while its bytes live in a sibling file fetched only on demand. There is no remote/S3 backend — this is a self-hosted personal-v1 product, and separating metadata from bytes on local disk already satisfies "binary content or an external reference without loading everything into memory."

A new `GET /projects/:projectId/artifacts/:name/blob` route streams a blob's bytes with its stored content type and length; it never returns or accepts a filesystem path, matching the existing JSON artifact route's posture. A retention sweep (`FileArtifactStore.reapExpired`, wired into `apps/api` on an interval exactly like the existing preview reaper) deletes blob bytes past their `expiresAt` while leaving the artifact's metadata entry in place (marked `blobDeleted: true`) — so a `StepAttempt.outputArtifacts`/`PreviewEvidence` reference an old run holds never dangles into a parse error, it just 410s on download.

## Alternatives considered

- A remote/S3-backed blob store was rejected: nothing else in this self-hosted product talks to external storage, and it would add a dependency and configuration surface disproportionate to a personal-v1 tool.
- Signed/token download URLs were rejected: the existing JSON artifact route has no auth layer at all; a plain path-parameterized binary route matches that same posture rather than inventing new security surface for this one route.
- Streaming Playwright's trace/video file directly into `putBlob` across the `executors → orchestrator` boundary (avoiding an in-memory `Buffer` hop entirely) was rejected: the verifier's own cleanup (`finally` block) runs before the coordinator would get a chance to consume a still-open stream, and keeping a temp file alive across that package boundary for the orchestrator to close later was judged more fragile than a bounded, config-capped in-memory buffer. The store's own write and read paths remain genuinely streamed either way.
- Capturing a screenshot only on step failure (instead of every executed step) was rejected: the issue asks for evidence "per test step," and the downstream `v05-preview-ui-e2e` roadmap item wants to inspect the full run, not just failures.

## Consequences

`ProjectPolicy.browserEvidence` is optional; existing policies default to no trace/video capture (screenshots are unconditional, since they're small and always useful evidence). `PreviewEvidenceSchema.screenshots` changes shape from `ArtifactReference[]` to `BrowserScreenshotEvidence[]` — safe, because ADR 0020 shipped it always empty. Blob artifacts add a new on-disk shape (`blobs/` subdirectory) that only new binary evidence populates; nothing existing is migrated or rewritten.

## Migration, rollback, and validation

No backfill: every field this ADR adds is optional or newly introduced, and no existing artifact, policy, or report changes shape. To roll back, remove the `apps/api` artifact reaper wiring, the blob download route, and the coordinator's evidence-persistence call — `FileArtifactStore.put`/`getRevision`/`getLatest` and the JSON artifact route are untouched and keep working exactly as before. Retained blob bytes on disk are inert if evidence capture is disabled again (no code path reads them without the download route or a policy that requested them).
```

- [ ] **Step 2: Run the complete verification gate**

```bash
npm run check
```

Expected: PASS — this runs `format:check`, `lint`, `architecture:check`, `roadmap:check`, `typecheck`, `test` (unit + scripts), and `build` in sequence. If `architecture:check` fails, re-read the Global Constraints import-boundary table above and fix the offending import (the most likely mistake: `executors` or `orchestrator` accidentally importing `@agent-foundry/persistence`).

If Chromium isn't installed in this environment and `npm test` fails only on the new/existing `browser-verifier.test.ts` Playwright-driven tests:

```bash
npx playwright install chromium
npm test
```

- [ ] **Step 3: Manually exercise the golden path with the mock executor**

```bash
EXECUTOR_MODE=mock RUN_WORKER_INLINE=true npm run dev --workspace @agent-foundry/api &
sleep 2
curl -s -X POST http://localhost:4000/projects -H 'content-type: application/json' \
  -d '{"name":"Artifact evidence smoke test","prd":"A simple todo app with add and delete."}' | tee /tmp/project.json
```

This confirms the API still boots and serves traffic with the new reaper/route wired in (mock executor mode never runs the real Playwright verifier, so this only proves wiring, not capture — capture is proven by Task 8/9's automated tests). Stop the server afterward (`kill %1` or `fg` then Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0022-browser-evidence-artifacts.md
git commit -m "docs: add ADR for browser evidence artifact storage and retention"
```

- [ ] **Step 5: Record evidence in the GitHub issue / PR**

Attach to the PR description (this is `docs/DEFINITION_OF_DONE.md`'s "Delivery evidence" requirement):

- Full `npm run check` output (or a summary: N test files, N tests, 0 failures).
- The new test file list: `packages/contracts/src/project.test.ts` (new), `packages/persistence/src/artifact-store.test.ts` (extended), `apps/api/src/artifacts.test.ts` (new), `apps/api/src/artifact-reaper.test.ts` (new), plus every other modified `*.test.ts`.
- A one-line note per acceptance criterion in the issue body, confirming which task/test satisfies it (Task 6 tests → binary storage without full in-memory buffering; Task 8 tests → screenshot viewport/url/step/hash; Task 3 tests → trace/video capture is optional, Task 6 + Task 9 tests → size limit is enforced and handled gracefully; Task 11 tests → UI download without a local path; Task 6 "reaps expired blobs" test → retention without breaking metadata).

---

## Final Task List Summary

1. Contracts — `ArtifactMetadata` blob fields _(parallel with 2, 3, 7)_
2. Contracts — sized references, screenshot evidence, video evidence _(parallel with 1, 3, 7)_
3. Contracts — browser evidence policy _(parallel with 1, 2, 7)_
4. Domain — blob store port + `ArtifactTooLargeError` + evidence-carrying `BrowserVerifier`
5. Persistence — `atomicWriteStream`
6. Persistence — `FileArtifactStore.putBlob`/`getBlobStream`/`reapExpired`
7. Composition — artifact size/retention config _(parallel with 1, 2, 3)_
8. Executors — capture screenshot/trace/video _(parallel with 11, 12 once 6 is done)_
9. Orchestrator — coordinator persists evidence
10. Orchestrator + Composition — wire `evidencePolicy` end to end
11. API — blob download route _(parallel with 8-10, 12)_
12. API — artifact retention reaper _(parallel with 8-10, 11)_
13. Web — blob URL helper
14. ADR + full verification + issue evidence
