# Task C: API routes + web versions panel

## Where this fits

Issue #40 exposes the `ProjectVersion` ledger (list/compare/revert/branch/
protect) through the API and a simple web panel. A sibling task (parallel,
different worktree) is building the `ProjectVersionService` your routes
call — code against its method names below; your own tests use a
hand-written fake, don't wait for it.

`ProjectVersionService` (in `@agent-foundry/orchestrator`, landing in
parallel) exposes:
```ts
list(projectId: string, limit?: number): Promise<ProjectVersion[]>
compare(projectId: string, fromVersionId: string, toVersionId: string): Promise<{ diff: string }>
revert(projectId: string, toVersionId: string): Promise<ProjectVersion>
branchFrom(projectId: string, fromVersionId: string, label?: string): Promise<{ branchName: string; version: ProjectVersion }>
setProtected(projectId: string, versionId: string, protectedFlag: boolean): Promise<ProjectVersion>
```
It throws `NotFoundError` (from `@agent-foundry/domain`) for an unknown
version id — the app already has a global error handler
(`apps/api/src/app.ts`, `setErrorHandler`, ~line 61) that maps that to a 404
response. Routes should just call the service and let errors propagate —
no per-route try/catch.

`Runtime` (from `@agent-foundry/composition`) will expose
`runtime.projectVersionService` once the sibling task lands — reference it
under that name.

## Part 1 — contracts additions (`packages/contracts/src/api.ts`)

Two small request schemas, same style as `CreateModelOverrideRequestSchema`
in that file:

```ts
export const BranchVersionRequestSchema = z.object({ label: z.string().min(1).optional() });
export type BranchVersionRequest = z.infer<typeof BranchVersionRequestSchema>;

export const SetVersionProtectedRequestSchema = z.object({ protected: z.boolean() });
export type SetVersionProtectedRequest = z.infer<typeof SetVersionProtectedRequestSchema>;
```
Export both from `packages/contracts/src/index.ts` (already re-exports
`* from './api.js'`, so no change needed there beyond adding the schemas to
`api.ts` itself). List/compare responses don't need dedicated schemas —
follow the existing plain-object-return convention already used for e.g.
`GET /workflows` (`{ workflows: ... }`) in `apps/api/src/app.ts`.

## Part 2 — routes in `apps/api/src/app.ts`

Add next to the other `/projects/:projectId/...` routes (same
`PathSegmentSchema` param-parsing style already used throughout this file —
read the existing `/projects/:projectId/artifacts/:name` route right above
for the exact pattern):

```
GET  /projects/:projectId/versions                                  -> { versions: await runtime.projectVersionService.list(projectId, limit) }
GET  /projects/:projectId/versions/compare?from=&to=                -> await runtime.projectVersionService.compare(projectId, from, to)
POST /projects/:projectId/versions/:versionId/revert                -> { version: await runtime.projectVersionService.revert(projectId, versionId) }, reply.status(202)
POST /projects/:projectId/versions/:versionId/branch                -> { branchName, version }, reply.status(202)
POST /projects/:projectId/versions/:versionId/protect               -> { version: await runtime.projectVersionService.setProtected(projectId, versionId, body.protected) }
```
`limit` on the list route: same `z.coerce.number().int().min(1).max(200).default(50)` pattern already used on `GET /projects`. `from`/`to` on compare: `PathSegmentSchema` each, required.

Tests: `apps/api/src/app.test.ts` if it exists (check first) or a new
colocated test file — same `buildApp(runtime)` test-harness pattern the
existing route tests use (a fake/stub `Runtime` with a hand-written fake
`projectVersionService`). Cover: list returns versions, compare returns a
diff, revert/branch/protect each call through and return 2xx, and a missing
version id 404s (via `NotFoundError` from the fake).

## Part 3 — client + panel in `apps/web`

`apps/web/lib/api.ts`: add matching client functions using the existing
`api<T>()` helper (read the top of that file — every existing function
follows the same three-line shape: call `api<...>(path, init)`, `POST`
bodies via `JSON.stringify`):
```ts
listVersions(projectId, limit?): Promise<ProjectVersion[]>
compareVersions(projectId, from, to): Promise<{ diff: string }>
revertToVersion(projectId, versionId): Promise<ProjectVersion>
branchFromVersion(projectId, versionId, label?): Promise<{ branchName: string; version: ProjectVersion }>
setVersionProtected(projectId, versionId, protectedFlag): Promise<ProjectVersion>
```

`apps/web/app/project/[id]/versions/page.tsx` (new): a client component
(`'use client'`) matching the existing page's conventions — read
`apps/web/app/project/[id]/page.tsx` for the general shape (it's long;
just skim the top imports and one panel section, don't try to absorb the
whole file). Keep this new page minimal:
- List versions (label/kind/commit short-sha/timestamp/protected badge),
  newest first.
- Checkbox or click-to-select two versions, a "Compare" button that calls
  `compareVersions` and renders the returned unified diff as preformatted
  text, coloring lines by their `+`/`-` prefix. Reuse the existing
  `.diffAdded`/`.diffRemoved` CSS classes already defined in
  `apps/web/app/globals.css` (~line 561) rather than inventing new ones —
  split the diff string on `\n`, map each line to a `<span>` with
  `className={line.startsWith('+') ? 'diffAdded' : line.startsWith('-') ? 'diffRemoved' : undefined}`,
  wrap in a `<pre>` (the existing `diffLines`-based flow in the parent page
  is for single-artifact revisions, not a repo-wide diff — don't force-fit
  it here, plain line-prefix coloring is the right level of effort).
- Per-version "Revert" and "Branch" (prompts for an optional label) and
  "Protect"/"Unprotect" buttons, each calling the matching `lib/api.ts`
  function and refreshing the list.
- No diff syntax highlighting beyond the added/removed coloring above, no
  graph/tree visualization — matches the rest of this app's current UI
  level.

## Verify before reporting

```
npx vitest run apps/api/src apps/web/lib
cd apps/api && npm run typecheck
cd apps/web && npm run typecheck
```
`apps/api`/`apps/web` typecheck will not fully pass until the sibling
orchestrator/composition task lands `runtime.projectVersionService` — note
that as an expected, temporary gap in your report rather than blocking on
it. Do not touch `packages/orchestrator` or `packages/composition` yourself.

## Report

Write your report to `.superpowers/sdd/task-C-report.md`: status, commit
sha(s), one-line test summary, and any concerns (including the expected
typecheck gap above). Commit your work with a conventional-commit message
before reporting DONE.
