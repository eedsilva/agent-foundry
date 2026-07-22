# Issue 194 Unknown Package Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop preview planning from choosing `npm run` when a workspace has no supported package-manager signal, so startup returns the existing reproducible-install diagnostic instead of spawning an arbitrary command.

**Architecture:** Keep the behavior at the command-planning boundary. `resolveScript` already converts invalid commands into `PreviewCommandResult` diagnostics, so it should reject `unknown` before calling the command-shaping helper; `NodePreviewRunner.start` will then take its existing `PREVIEW_NO_DEV_COMMAND` path. Narrow `scriptCommand` to known managers so future callers cannot reintroduce this fallback.

**Tech Stack:** TypeScript, Vitest, Zod contracts, npm workspaces.

## Global Constraints

- Issue #194 must never spawn a package-manager command for `PackageManager === 'unknown'`.
- Preserve all known-manager command shapes and the existing unsupported-install diagnostic text.
- Add no dependency or new public configuration.
- Follow TDD: observe the relevant test fail before production code is changed.
- Work only on branch `fix/issue-194-unknown-package-manager`; do not merge or push to `main`.

---

### Task 1: Reject unknown package managers during preview command planning

**Files:**

- Modify: `packages/executors/src/preview-command-plan.ts`
- Modify: `packages/executors/src/preview-command-plan.test.ts`
- Modify: `packages/executors/src/package-manager.ts`
- Modify: `packages/executors/src/package-manager.test.ts`

**Interfaces:**

- Consumes: `detectPackageManager(workspacePath): Promise<PackageManager>` and `PreviewCommandResult`.
- Produces: `resolvePreviewCommandPlan(...).dev` with `{ ok: false, reason: 'No supported lockfile or packageManager field found; cannot pick a reproducible install command.' }` when `packageManager` is `unknown`.
- Preserves: `scriptCommand('npm' | 'pnpm' | 'yarn' | 'bun', script)` command/args results.

- [x] **Step 1: Write the failing command-plan test**

In the existing no-lockfile test in `packages/executors/src/preview-command-plan.test.ts`, assert the dev result before changing production code:

```ts
expect(plan.dev).toEqual({
  ok: false,
  reason: 'No supported lockfile or packageManager field found; cannot pick a reproducible install command.',
});
```

Remove the `scriptCommand('unknown', 'build')` expectation from `packages/executors/src/package-manager.test.ts`; unknown command selection is no longer a valid public helper input.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npm run test:unit -- packages/executors/src/preview-command-plan.test.ts packages/executors/src/package-manager.test.ts`

Expected: FAIL because `plan.dev` is currently `{ ok: true, command: 'npm', args: ['run', 'dev'] }` for the no-lockfile workspace.

- [x] **Step 3: Implement the minimal planner guard**

Add a package-manager diagnostic branch in `resolveScript` before `scriptCommand` is called:

```ts
if (packageManager === 'unknown') {
  return {
    ok: false,
    reason:
      'No supported lockfile or packageManager field found; cannot pick a reproducible install command.',
  };
}
```

Narrow `scriptCommand` to `Exclude<PackageManager, 'unknown'>` and remove its `unknown` switch case. Do not add a second command resolver or alter any known-manager branch.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm run test:unit -- packages/executors/src/preview-command-plan.test.ts packages/executors/src/package-manager.test.ts`

Expected: PASS with the unknown workspace producing diagnostics for install and dev.

- [x] **Step 5: Run package-local validation**

Run: `npm run typecheck --workspace @agent-foundry/executors && npm run lint:code -- --quiet`

Expected: PASS.

- [x] **Step 6: Commit the issue change**

```bash
git add docs/superpowers/plans/2026-07-22-issue-194-unknown-package-manager.md packages/executors/src/preview-command-plan.ts packages/executors/src/preview-command-plan.test.ts packages/executors/src/package-manager.ts packages/executors/src/package-manager.test.ts
git commit -m "fix(preview): reject unknown package managers"
```
