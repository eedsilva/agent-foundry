# Knowledge Files and Builder Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver persistent, versioned project knowledge files (including design-reference and bug-evidence images) and make the project page a responsive Chat / Preview / Changes builder shell that exercises them through the existing Plan, Build, visual-edit, version, and approval flows.

**Architecture:** Reuse the existing `ArtifactStore` for immutable uploaded bytes and its existing blob-download route; a small project-scoped knowledge index points at the current artifact revision and records pin/purpose/visibility. This avoids a second blob transport, new dependency, or weakening the existing artifact GC/storage rules. The operation runner reads only active pinned files into its deterministic context; the web shell is a composition of the existing conversation, preview, version, diff, verification, and approval surfaces rather than a replacement workflow.

**Tech Stack:** TypeScript, Zod 4, Fastify, file-backed persistence, existing `ArtifactStore` / `FsBlobStore` / S3 BlobStore, Next.js/React, Vitest, Playwright.

## Global Constraints

- Work only on branch `agent/issue-43-knowledge-builder-shell` in `/Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-43-knowledge-builder-shell`; never write or push implementation code to `main`.
- Reuse `ArtifactStore.putBlob()` and `/projects/:projectId/artifacts/:name/blob`; do not add a second blob store, multipart library, image-processing library, image generation, or raster-editing feature.
- Upload bytes are base64 JSON only for this local-first v1 slice, decoded server-side, with a 4 MiB decoded limit and strict bare MIME type / SHA-256 verification. The route body limit must cover base64 overhead.
- Each knowledge file has an immutable artifact revision; replacement creates the next revision, and removal only removes it from active prompt/UI context while retained artifact history remains auditable.
- Only active **pinned** knowledge entries are appended to Plan/Build context. Images have an explicit use of `design-reference` or `bug-evidence`; non-images use `reference`.
- Preserve current public conversation, artifact, visual-edit, approval, preview, version, and project APIs; add schema-version-1 fields/endpoints additively.
- Project-local paths are trusted local operator information: render them as text, URL-encode `vscode://file/<path>` for Open in editor, and never expose a server-side arbitrary-command endpoint.
- Desktop is a labeled three-column Chat / Preview / Changes layout. At `max-width: 850px`, it becomes a single column with all panels still reachable in document order.
- Tests follow RED → GREEN → refactor. Do not add production behavior before the focused test fails for the intended reason.
- Deliver `npm run check`, `npm run doctor`, `git diff --check`, relevant API E2E, a browser screenshot, PR evidence/comment, and live GitHub PR checks before completion.

---

### Task 1: Persist knowledge-file metadata and upload revisions through existing artifacts

**Files:**

- Create: `packages/contracts/src/knowledge-file.ts`
- Create: `packages/persistence/src/knowledge-file-repository.ts`
- Create: `packages/persistence/src/knowledge-file-repository.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/composition/src/runtime.ts`
- Modify: `packages/composition/src/runtime.integration.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/conversation.test.ts`
- Modify: `apps/api/src/blob-gc.ts`
- Modify: `apps/api/src/blob-gc.test.ts`

**Interfaces:**

- Consumes: `ArtifactStore.putBlob()`, `ArtifactStore.getRevision()`, `ArtifactReference`, `FileArtifactStore`, `atomicWriteJson`, `readJsonOrNull`, and the existing project directory layout.
- Produces: `KnowledgeFile`, `KnowledgeFileRevision`, `CreateKnowledgeFileRequest`, `UpdateKnowledgeFileRequest`, and `KnowledgeFileRepository` (`list`, `get`, `save`, `remove`) plus project-scoped API routes.

- [ ] **Step 1: Write the failing contract and repository tests**

```ts
it('keeps an immutable revision history while replacement changes the active revision', async () => {
  const first = await repository.save({ ...file, revisions: [revision(1, 'a'.repeat(64))] });
  const replaced = await repository.save({
    ...first,
    revisions: [...first.revisions, revision(2, 'b'.repeat(64))],
  });
  expect(replaced.revisions.map(({ version }) => version)).toEqual([1, 2]);
  expect(replaced.currentVersion).toBe(2);
});

it('removes a file from the active index without mutating a different project', async () => {
  await repository.save(file);
  await repository.save({ ...file, id: 'other', projectId: 'project-2' });
  await repository.remove('project-1', file.id);
  await expect(repository.list('project-1')).resolves.toEqual([]);
  await expect(repository.list('project-2')).resolves.toHaveLength(1);
});
```

- [ ] **Step 2: Run the repository test to verify it fails**

Run: `npx vitest run packages/persistence/src/knowledge-file-repository.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because `knowledge-file-repository` and the knowledge-file contract do not exist.

- [ ] **Step 3: Add the additive contract and file-backed repository**

```ts
export const KnowledgeFileSchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    name: z.string().trim().min(1).max(255),
    mediaType: BareMediaTypeSchema,
    purpose: z.enum(['reference', 'design-reference', 'bug-evidence']),
    pinned: z.boolean(),
    currentVersion: z.number().int().positive(),
    revisions: z.array(KnowledgeFileRevisionSchema).min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export interface KnowledgeFileRepository {
  list(projectId: string): Promise<KnowledgeFile[]>;
  get(projectId: string, knowledgeFileId: string): Promise<KnowledgeFile | null>;
  save(file: KnowledgeFile): Promise<KnowledgeFile>;
  remove(projectId: string, knowledgeFileId: string): Promise<void>;
}
```

Persist one validated `{ schemaVersion: '1', files: KnowledgeFile[] }` index at `DATA_DIR/projects/<projectId>/knowledge.json` using the same lock/atomic replacement pattern as conversation persistence. Reject project/id mismatches and duplicate IDs; keep revisions ordered and require `currentVersion` to name the final revision. Export the repository from persistence, add it to `Runtime`, and construct it in `createRuntime`.

- [ ] **Step 4: Extend the API with tested upload, replace, pin, list, and remove routes**

```ts
const MAX_KNOWLEDGE_FILE_BYTES = 4 * 1024 * 1024;
const artifactName = `knowledge-${knowledgeFileId}`;
const bytes = Buffer.from(request.contentBase64, 'base64');
if (bytes.length > MAX_KNOWLEDGE_FILE_BYTES || !isCanonicalBase64(request.contentBase64, bytes)) {
  throw new ValidationError('Knowledge file content is invalid or too large.');
}
const metadata = await runtime.artifacts.putBlob(
  {
    projectId,
    name: artifactName,
    contentType: request.mediaType,
    createdBy: 'knowledge-upload',
    maxBytes: MAX_KNOWLEDGE_FILE_BYTES,
  },
  Readable.from(bytes),
);
```

Add `GET`, `POST`, `PUT /projects/:projectId/knowledge-files`, `PATCH /projects/:projectId/knowledge-files/:knowledgeFileId` for `{ pinned }`, and `DELETE /projects/:projectId/knowledge-files/:knowledgeFileId`. The create/replace route must use Fastify's per-route `bodyLimit` for base64 overhead, verify that actual bytes/sha come from `putBlob`, allow only `image/*` for image purposes, and roll back no metadata on failed blob upload. Removal deletes the index entry, not an artifact revision. Return the full knowledge file in each mutation response.

Add a project-detail `knowledgeFiles` array additively and make blob GC treat existing artifact metadata as the sole bytes authority (no new GC key namespace).

- [ ] **Step 5: Run focused tests to verify GREEN**

Run: `npx vitest run packages/persistence/src/knowledge-file-repository.test.ts apps/api/src/conversation.test.ts apps/api/src/blob-gc.test.ts packages/composition/src/runtime.integration.test.ts --pool=threads --maxWorkers=1`

Expected: PASS; tests prove a valid image creates artifact revision 1, replacement creates revision 2, a pin change is visible in GET/project detail, removal hides only its project index entry, malformed/oversized/cross-project requests fail, and existing artifact GC behavior remains unchanged.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/contracts packages/domain/src/ports.ts packages/persistence packages/composition/src/runtime.ts apps/api
git commit -m "feat: persist versioned project knowledge files"
```

### Task 2: Feed active knowledge into Plan/Build and expose a safe local-editor link

**Files:**

- Modify: `packages/orchestrator/src/conversation-operation-runner.ts`
- Modify: `packages/orchestrator/src/conversation-operation-runner.test.ts`
- Modify: `packages/orchestrator/src/project-service.ts`
- Modify: `packages/orchestrator/src/project-service.test.ts`
- Modify: `packages/composition/src/runtime.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/conversation.test.ts`

**Interfaces:**

- Consumes: Task 1's `KnowledgeFileRepository`, `ArtifactStore`, `WorkspaceManager.workspacePath`, and the current operation compilation path.
- Produces: deterministic `## Pinned knowledge files` context for Plan/Build, project-detail `workspacePath`, and no command-execution API.

- [ ] **Step 1: Write the failing operation-runner and project-detail tests**

```ts
it('adds only active pinned knowledge revisions to a plan prompt', async () => {
  knowledgeFiles.files = [
    knowledge('design', { pinned: true, purpose: 'design-reference', currentVersion: 2 }),
    knowledge('notes', { pinned: false }),
  ];
  await runner.run(operation('plan'));
  expect(workspaces.lastRequestMarkdown).toContain('## Pinned knowledge files');
  expect(workspaces.lastRequestMarkdown).toContain('design v2 · design-reference');
  expect(workspaces.lastRequestMarkdown).not.toContain('notes v1');
});

it('exposes the generated workspace path without executing an editor command', async () => {
  const detail = await service.get('project-1');
  expect(detail.workspacePath).toBe(workspaces.workspacePath('project-1'));
});
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `npx vitest run packages/orchestrator/src/conversation-operation-runner.test.ts packages/orchestrator/src/project-service.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because neither the prompt context nor `workspacePath` exists.

- [ ] **Step 3: Add the smallest deterministic context integration**

```ts
function knowledgeContext(files: KnowledgeFile[]): string {
  const pinned = files.filter((file) => file.pinned);
  if (pinned.length === 0) return '';
  return `\n\n## Pinned knowledge files\n\n${pinned
    .map(
      (file) =>
        `- ${file.name} v${file.currentVersion} · ${file.purpose} · artifact ${file.revisions.at(-1)!.artifact.name}@${file.currentVersion}`,
    )
    .join('\n')}`;
}
```

Inject this text only into Plan/Build compilation after the normal change-request context and before execution. Do not alter visual-edit/explain/repair behavior. Add `workspacePath` to `ProjectDetailResponse` from the existing `WorkspaceManager`; the web client creates the `vscode://file/${encodeURIComponent(workspacePath)}` link locally. Do not spawn an editor process or accept arbitrary paths from HTTP.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `npx vitest run packages/orchestrator/src/conversation-operation-runner.test.ts packages/orchestrator/src/project-service.test.ts apps/api/src/conversation.test.ts --pool=threads --maxWorkers=1`

Expected: PASS; the compiled Plan/Build request records pinned revision/purpose, an unpinned/removal entry cannot influence it, and project detail has only its own generated path.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/orchestrator packages/composition/src/runtime.ts apps/api
git commit -m "feat: include pinned knowledge in builder context"
```

### Task 3: Compose the responsive Chat / Preview / Changes builder shell

**Files:**

- Create: `apps/web/app/project/[id]/knowledge-files.tsx`
- Create: `apps/web/app/project/[id]/knowledge-files.test.tsx`
- Create: `apps/web/app/project/[id]/changes-panel.tsx`
- Create: `apps/web/app/project/[id]/changes-panel.test.tsx`
- Modify: `apps/web/app/project/[id]/page.tsx`
- Modify: `apps/web/app/project/[id]/preview-panel.tsx`
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/lib/api.test.ts`
- Modify: `apps/web/app/globals.css`

**Interfaces:**

- Consumes: Task 1 knowledge APIs, Task 2 `workspacePath`, current Conversation UI, `PreviewPanel`, artifact blob URL helper, project versions/diff APIs, checks/approval UI.
- Produces: accessible upload/pin/replace/remove controls, image preview, three labeled panels, a Changes surface showing diff/checks/version actions/approval, and mobile collapse without hidden features.

- [ ] **Step 1: Write failing API-client and component tests**

```tsx
it('uploads a design reference, displays its current image revision, and removes it from the active list', async () => {
  render(<KnowledgeFiles projectId="project-1" knowledgeFiles={[]} onChange={reload} />);
  await user.upload(screen.getByLabelText('Adicionar knowledge file'), imageFile);
  expect(await screen.findByText('design-reference · v1')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Remover logo.png' }));
  expect(screen.queryByText('design-reference · v1')).not.toBeInTheDocument();
});

it('keeps Chat, Preview, and Changes reachable in mobile document order', () => {
  render(<ProjectBuilderShell {...fixture} />);
  expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
    'Chat',
    'Preview',
    'Changes',
  ]);
});
```

- [ ] **Step 2: Run the focused web tests to verify RED**

Run: `npx vitest run apps/web/app/project/[id]/knowledge-files.test.tsx apps/web/app/project/[id]/changes-panel.test.tsx apps/web/lib/api.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because knowledge client helpers and the shell components do not exist.

- [ ] **Step 3: Add narrow client helpers and present existing state in three panels**

```ts
export async function uploadKnowledgeFile(
  projectId: string,
  input: {
    name: string;
    mediaType: string;
    purpose: KnowledgeFilePurpose;
    pinned: boolean;
    contentBase64: string;
  },
): Promise<KnowledgeFile> {
  const response = await api<{ knowledgeFile: KnowledgeFile }>(
    `/projects/${encodeURIComponent(projectId)}/knowledge-files`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.knowledgeFile;
}
```

Read file bytes with `FileReader`, reject only files over the server's documented 4 MiB limit before upload, and use the returned current artifact revision to render images through `getArtifactBlobUrl`. The visible purpose selector is `reference`, `design-reference`, or `bug-evidence`; do not offer an image-editor action.

Move existing Conversation markup into a `role="region" aria-label="Chat"` panel, keep `PreviewPanel` in `Preview`, and add `Changes` around the existing versions/diff, verification evidence, and approval controls. It must expose version list/protect/revert/branch actions already supported by `api.ts`, current diff, check results, and current approval state; it must not duplicate backend behavior. Render `workspacePath` in Changes with `Open in editor` as an ordinary link. Keep all existing project controls, selectors, and test-visible labels.

```css
.builderGrid {
  display: grid;
  grid-template-columns: minmax(280px, 0.9fr) minmax(360px, 1.25fr) minmax(280px, 0.9fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 850px) {
  .builderGrid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: Run focused web tests to verify GREEN**

Run: `npx vitest run apps/web/app/project/[id]/knowledge-files.test.tsx apps/web/app/project/[id]/changes-panel.test.tsx apps/web/lib/api.test.ts --pool=threads --maxWorkers=1`

Expected: PASS; tests prove client request shape, file version/pin/remove UI, image preview, accessible shell labels, Open in editor encoding, and existing preview/changes controls remain reachable.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/web
git commit -m "feat: add knowledge-aware three-panel builder shell"
```

### Task 4: Prove the knowledge golden flow and responsive UI end to end

**Files:**

- Modify: `apps/api/e2e/golden-flow.spec.ts`
- Modify: `apps/api/e2e/visual-edit.spec.ts` (or the existing E2E that owns preview visual edits)
- Modify: `docs/VALIDATION.md`
- Modify: `docs/OPERATIONS.md`

**Interfaces:**

- Consumes: Tasks 1–3, existing golden-flow fixture/runtime/web startup, preview selection/edit flow, and project version APIs.
- Produces: E2E proof of attachment → plan/build context → visual edit → revert → rebuild, responsive shell evidence, and current operator/security documentation.

- [ ] **Step 1: Write the failing E2E assertions before implementation changes**

```ts
test('golden flow: attach reference, plan, build, visual edit, revert, rebuild', async ({
  page,
}) => {
  const projectId = await createProject();
  await page.goto(`${webBaseUrl}/project/${projectId}`);
  await page.getByLabel('Adicionar knowledge file').setInputFiles(referenceImage);
  await expect(page.getByText('design-reference · v1')).toBeVisible();
  await page.getByRole('button', { name: 'Planejar' }).click();
  await expect(pinnedKnowledgePrompt(projectId)).resolves.toContain('design-reference');
  await completePlanAndBuild(page);
  await previewEditAndPromote(page);
  await page.getByRole('button', { name: 'Reverter para versão 1' }).click();
  await page.getByRole('button', { name: 'Construir' }).click();
  await expect(page.getByRole('region', { name: 'Changes' })).toContainText('checks');
});
```

Add a desktop screenshot assertion/attachment after the three panels render and set the viewport to mobile to assert the three named regions remain visible in order. Use a tiny checked-in PNG fixture; no external service or screenshot baseline framework.

- [ ] **Step 2: Run E2E to verify RED**

Run: `npm run e2e --workspace @agent-foundry/api -- --grep "attach reference"`

Expected: FAIL because the knowledge controls and shell are absent (or because the new assertion sees no pinned context).

- [ ] **Step 3: Implement only the minimal fixture/setup needed for the test**

Extend the current golden-flow helpers instead of creating a second server harness. Keep the mock/fixture workflow deterministic, wait for actual UI state rather than timeouts, and record the generated screenshot path for the PR. Do not introduce image generation/editing or a real model/provider dependency.

- [ ] **Step 4: Run the green E2E and accessibility checks**

Run: `npm run e2e --workspace @agent-foundry/api -- --grep "attach reference"`

Expected: PASS; the E2E proves the full acceptance journey, current version/revert/rebuild state, image reference visibility, check/approval/diff surface, and responsive shell.

- [ ] **Step 5: Update operator and validation documentation**

Document the 4 MiB base64 upload boundary, supported use labels, revision/removal semantics, artifact retention/audit behavior, local `vscode://` behavior, no raster generation/editing, and exact E2E command/evidence. Update `docs/VALIDATION.md` with the observable golden-flow proof.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/api/e2e docs/VALIDATION.md docs/OPERATIONS.md
git commit -m "test: cover knowledge builder golden flow"
```

## Final verification and delivery

- [ ] Run `npm run check`, `npm run doctor`, `git diff --check`, and `npm run e2e --workspace @agent-foundry/api` from the worktree; fix every regression.
- [ ] Inspect the full branch diff using `git diff --check origin/main...HEAD` and re-run targeted tests after any review fix.
- [ ] Run `ponytail-review` against `origin/main...HEAD`; remove every valid complexity finding.
- [ ] Run `code-simplifier-v2` only over the changed files, preserving contracts and behavior; test after any safe simplification.
- [ ] Capture a local desktop builder screenshot and upload/embed it in the GitHub PR comment alongside exact command results, E2E outcome, security/migration/rollback assessment, and `Fixes #43`.
- [ ] Push only `agent/issue-43-knowledge-builder-shell`, create a PR to `main`, and verify live GitHub PR mergeability/check state.

## Plan self-review

- Spec coverage: Task 1 covers persistent, pinned, versioned, removable knowledge and image bytes; Task 2 establishes visible prompt impact and repository path; Task 3 covers desktop/mobile Chat/Preview/Changes plus diff/check/version/approval/editor UI; Task 4 proves the requested golden flow and documentation/evidence. Image generation/editing is explicitly excluded in Global Constraints and UI scope.
- Placeholder scan: no TODO/TBD steps or unspecified validation commands remain.
- Type consistency: `KnowledgeFileRepository` is introduced in Task 1, consumed by Task 2, and exposed through Task 3/4; all upload bytes remain in existing artifact revisions.
