# ADR 0062: Read-only workspace-file API for the builder's Files tab

- Status: Proposed
- Date: 2026-08-10
- Owners: Core, Security
- Tracked by issue #491 (epic: #488, ADR 0061)

## Context

#491 adds a new HTTP surface that lists and serves the contents of files from
a generated project's workspace directory, so the builder's Files tab can
show what an agent actually built without an operator opening a separate
editor. This is a new class of exposure this repo didn't have before:
arbitrary-ish file read from a directory an untrusted agent process writes
into, reachable from the browser.

## Decision

- **Scope**: `WorkspaceManager.listFiles(projectId)` and
  `.readWorkspaceFile(projectId, relativePath)`, both on the existing
  `FileWorkspaceManager` — no new, competing workspace-access abstraction.
- **Path safety**: `relativePath` is resolved against the workspace root via
  the existing `resolveWorkspaceRelativePath` (already used elsewhere for
  "untrusted candidate path against a root" — not new machinery for this
  ticket). A path that escapes (traversal, absolute injection) is rejected
  with `NotFoundError`, not served.
- **Listing exclusion**: a project's own `.gitignore` is respected first
  (`node_modules`, build output, etc. stay out automatically), then a
  hardcoded always-exclude applies on top, unconditionally — a project's own
  gitignore (even a deliberate `!` negation) can never override it. The
  hardcoded list: `.env`/`.env.*` (except `.env.example`, which the golden
  scaffold's own default gitignore already treats as a template, not a
  secret — no other `.env.*` name gets a carve-out), SSH/TLS private keys
  (`*.pem`, `*.key`, `id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`, `.ssh/**`),
  and common tool/cloud credential files (`.npmrc`, `.netrc`,
  `.aws/credentials`). Not exhaustive — a named baseline that can grow.
- **Reading, not just listing, is re-checked**: `readWorkspaceFile`
  re-applies the same exclusion filter to the resolved path before reading,
  so a client can't request a file's content by path even if it knows (or
  guesses) a path the listing itself would have excluded.
- **Size and content bounds**: a resolved path is `stat`'d before reading; a
  file over 5 MiB is rejected (`ValidationError`, not loaded into memory).
  The read buffer is checked for a NUL byte before UTF-8 decoding; content
  that looks binary is rejected rather than decoded into garbage text.
- **API shape**: `path` travels as a query parameter, not a URL path
  segment — a workspace-relative path legitimately contains `/`, which this
  repo's existing single-segment `PathSegmentSchema` route params don't
  allow. The real safety boundary is `resolveWorkspaceRelativePath` inside
  the service call, not the route's own shape.

## Considered Options

- **A wildcard/catch-all Fastify route** (`/workspace/files/*`) instead of a
  query param. Rejected — no existing route in this codebase uses Fastify
  wildcards, and a query param is simpler to validate with the same `zod`
  pattern every other route already uses.
- **`ArtifactTooLargeError`** for the size cap, matching the artifact-upload
  path's existing error type. Rejected in favor of `ValidationError` — the
  former has no HTTP status mapping in `apps/api/src/app.ts`'s error
  handler yet, and adding one is a global, security/behavior-relevant change
  out of proportion to this ticket; `ValidationError` is already mapped to
  400 and reads correctly for "this specific request is rejected."
- **Rely solely on the project's `.gitignore`** for exclusion, skipping the
  hardcoded always-exclude list. Rejected explicitly by #491's acceptance
  criteria — a missing or broken gitignore entry would otherwise leak a
  secret with no second line of defense.

## Consequences

- The hardcoded credential-path list is a judgement call, not a provably
  complete one. Extending it later (a newly-common credential filename, a
  new cloud provider's default path) is a small, low-risk addition to
  `packages/domain/src/workspace-file-listing.ts`'s `ALWAYS_EXCLUDE` — not
  an architectural change.
- Binary-file and oversized-file rejection means the Files tab is
  deliberately incomplete as a general file browser (no image preview, no
  large-log viewing) — by design; #491 scopes this to "browse readable
  source/config text," not a full file manager.
