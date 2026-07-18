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
