# Real-mode validation goal and staged acceptance

## Goal

Validate that a generated Next.js app can be built and used by a real user in
real-provider mode, with failures stopping early, preserving evidence, and
remaining retryable at the failed step.

## Constraints

- Work from the latest `origin/main` in an isolated worktree and branch.
- Use real providers and a real generated runtime; no mock data or mock
  acceptance claims.
- Use visible, user-like browser actions for final QA; automated Playwright is
  not the final acceptance runner.
- Do not modify `main` directly.
- Keep database smoke checks in the full-suite node, after the task graph.
- Preserve completed tasks, checkpoints, and artifacts across step retries.
- Create Bugs-milestone issues only for confirmed reproducible defects.

## Confirmed failure inventory

1. Claude rejected Draft 2020-12 `$schema` and top-level `x-*` JSON Schema
   metadata. Fixed on `origin/main` by normalizing Claude's provider payload.
2. Linux Docker optional dependencies were used by the macOS host preview.
   Fixed on `origin/main` by constraining pnpm's supported host architecture
   during install and restoring the manifest.
3. Preview installation was sensitive to memory, TTY prompts, and Docker
   removal races. Fixed on `origin/main` with a 2 GiB install budget,
   non-interactive Corepack settings, and idempotent cleanup handling.
4. Per-task database smoke checks ran against an intentionally transitional
   schema. Fixed on `origin/main` by deferring `db:start`, `db:reset`, and
   `smoke` to `full-suite-verification`.
5. Repair agents could not reliably reproduce Docker-backed checks. The staged
   flow keeps those checks out of task repair and runs them once, as blocking
   checks, in `full-suite-verification`; a Docker failure therefore stops with
   the verifier's command and output instead of entering an unsafe repair loop.
6. Retry replay could re-enter provisioning before replaying the failed step.
   This branch adds the missing persisted provisioning boundary.
7. A long-running workflow could outlive its preview TTL. This branch adds a
   workflow-owned preview lease heartbeat.
8. A terminal preview health failure could be surfaced as a browser-report
   binding error. The coordinator now preserves the original preview failure.
9. The generated Next.js web package did not declare `@swc/helpers`, and the
   real preview could fail at runtime after install. The scaffold now declares
   the helper directly.

## Staged validation flow

### Phase 1 — platform preflight

Verify real Claude execution, provisioning, preview installation/startup, and
host-native dependency compatibility. Stop before product generation on any
failure. Record run/project identifiers and bounded diagnostics.

### Phase 2 — TODO tracer bullet

Generate a minimal TODO app with persistence/schema, create/list API, and
create/list/reload UI tasks. Gate each task with focused checks. Confirm one
TODO survives a visible page reload.

### Phase 3 — appointment vertical slice

Implement only appointment schema/seed, create/list API, and create/list UI.
Confirm database persistence and visible browser behavior before adding edits
or status transitions.

### Phase 4 — complete appointment flow

Add edit, legal status transitions, finalize, filters, and deletion. Retry only
the failed step and retain completed artifacts.

### Phase 5 — final acceptance

Run the complete workflow once, then visibly create, edit, finalize, and reload
an appointment. Confirm the final row and status in the real database. Capture
run ID, generated project ID, visible UI evidence, and backend evidence.

## Acceptance evidence

- Focused regression tests for retry replay and preview lease renewal.
- Preview lifecycle failures remain visible before browser-report validation.
- Static and full repository checks on the final branch.
- One real-provider platform preflight and one complete happy-path run, with
  Docker/Supabase availability stated literally.
- No claim of green validation for any skipped or unavailable environment gate.

## Current live-run result

The real-provider TODO run used project `01KYWNCJKGM5BS8K7S7EMFYX31` and run
`01KYWNPNT6SAFV2YWG7S820YH4`. Planning, provisioning, T1, and T2 completed;
the preserved T3 retry reused the T2 checkpoint without reprovisioning. The
generated T3 app installed, built, and started in a healthy preview. The
workflow browser gate produced a valid bound report but failed on
`net::ERR_BLOCKED_BY_CLIENT` while opening the control-plane preview URL, with
an additional `__name is not defined` passive observation. After the bounded
repair attempts, the run stopped because no unused executor remained.

Separately, manual visible browser QA against the healthy T3 preview created a
TODO, reloaded the page, and observed the TODO in the rendered list. The same
row was present in the disposable Supabase REST response. This confirms the
TODO tracer bullet, but no appointment project was generated and no appointment
create/edit/finalize/reload acceptance claim is made.
