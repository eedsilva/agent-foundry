# Dogfood v0.2 Tasks Implementation Plan (issue #118)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute ≥5 real v0.2 tasks through the actual Agent Foundry pipeline (queue → orchestrator → router → real CLI → verifier), record prompt/context/route/model/duration/quota/diff/checks/repairs/human-edit per run, keep failures as data, and freeze a baseline.

**Architecture:** Unlike the provider canaries (which bypass the product and call executors directly on synthetic toy repos), dogfooding runs each task through `ProjectService.create` + `WorkerLoop.runOnce` — the real pipeline — so every record lands in the existing `WorkflowRun`/`StepRun`/`StepAttempt`/artifact/event/metrics shapes for free. The runner seeds the project workspace with the real agent-foundry repo at a pinned baseline ref before the worker claims the job, and uses small dedicated workflows. Reporting reuses the canary freeze pattern (atomic write, sanitized, fail-closed) into `docs/baselines/v0.2-dogfood.{json,md}` — with one deliberate difference: failed runs do NOT block freezing; they are the point.

**Tech Stack:** TypeScript, existing `@agent-foundry/composition` runtime, tsx script, vitest (mock-mode integration test), real CLIs (codex/claude/agy) gated by doctor + `RUN_REAL_DOGFOOD=true`.

## Global Constraints

- Real execution is opt-in fail-closed: `RUN_REAL_DOGFOOD=true` env var required, doctor probes must be `ready` (reuse the exact gating pattern from `packages/composition/src/provider-canary.ts:67,354-368`).
- Frozen evidence excludes raw provider output, auth payloads, identities, credentials, machine paths (ADR 0009 rules). Sanitized error = `kind`/`code`/`message` only. Diff patches of the agent's own code changes ARE allowed in local records (`.data/dogfood/`, gitignored) but the frozen baseline carries only diffstats + commit ids.
- Failures are never deleted: every runner invocation appends a record; reruns of the same task keep prior records (`attempt` counter).
- CI never runs real CLIs: the vitest coverage uses `EXECUTOR_MODE=mock` on a tiny synthetic seed.
- Baseline ref for all 5 real tasks: commit `8896a3c` (main before issues #10/#11 merge) — tasks are real subtasks of those issues, so "later human edit" can be measured against what the human-reviewed PRs finally merged.
- `npm run check` must pass at the end.

---

### Task 1: Dogfood contracts

**Files:**

- Create: `packages/contracts/src/dogfood.ts`
- Modify: `packages/contracts/src/index.ts` (export)
- Test: `packages/contracts/src/dogfood.test.ts`

**Interfaces (produces — consumed by Tasks 3–5):**

```ts
import { z } from 'zod';
import { RouteDecisionSchema } from './model.js'; // match real import paths used by canary.ts
import { ExecutionUsageSchema } from './run.js';

export const DogfoodTaskSchema = z.object({
  id: z.string().min(1), // e.g. 'domain-redaction'
  title: z.string().min(1),
  issueRef: z.string().min(1), // e.g. 'eedsilva/agent-foundry#10'
  workflowId: z.string().min(1), // 'dogfood-task-v1' | 'dogfood-plan-v1'
  prompt: z.string().min(50), // becomes the project PRD
  baselineRef: z.string().min(7), // git ref the workspace is seeded from
  allowedFiles: z.array(z.string().min(1)), // paths the agent may create/modify ([] = no diff allowed)
  seedFiles: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  verifyScript: z.string().min(1).optional(), // value injected as package.json "dogfood:verify"
});

export const DogfoodHumanEditSchema = z.object({
  status: z.enum(['pending', 'recorded']),
  reference: z.string().optional(), // merged ref/PR the comparison used
  files: z
    .array(
      z.object({
        path: z.string(),
        agentVsMerged: z.enum(['same', 'modified', 'absent', 'agent-only']),
      }),
    )
    .default([]),
  notes: z.string().optional(),
});

export const DogfoodRunRecordSchema = z.object({
  schemaVersion: z.literal('1'),
  taskId: z.string(),
  attempt: z.number().int().positive(), // 1, 2… — reruns append, never overwrite
  issueRef: z.string(),
  baselineRef: z.string(),
  projectId: z.string(),
  runId: z.string(),
  startedAt: z.string().datetime(),
  status: z.enum(['passed', 'failed']), // passed = run completed AND verification approved AND allowlist respected
  durationMs: z.number().nonnegative(),
  route: RouteDecisionSchema.optional(), // from the implementation StepAttempt
  executedModel: z.string().optional(),
  usage: ExecutionUsageSchema.optional(),
  promptArtifact: z.string().optional(), // artifact name holding REQUEST.md (audit trail)
  diff: z
    .object({
      checkpoint: z.string().optional(),
      commit: z.string().optional(),
      stat: z.string(),
      filesChanged: z.array(z.string()),
    })
    .optional(),
  checks: z
    .array(
      z.object({
        name: z.string(),
        exitCode: z.number().nullable(),
        durationMs: z.number().nonnegative(),
        skipped: z.boolean(),
      }),
    )
    .default([]),
  repairs: z.object({
    iterations: z.number().int().nonnegative(),
    repairEvents: z.number().int().nonnegative(),
  }),
  failure: z
    .object({ kind: z.string(), code: z.string().optional(), message: z.string() })
    .optional(),
  humanEdit: DogfoodHumanEditSchema,
});

export const DogfoodReportSchema = z.object({
  schemaVersion: z.literal('1'),
  createdAt: z.string().datetime(),
  baselineRef: z.string(),
  runs: z.array(DogfoodRunRecordSchema).min(1),
  limitations: z.array(z.string()),
});
export type DogfoodTask = z.infer<typeof DogfoodTaskSchema>;
export type DogfoodRunRecord = z.infer<typeof DogfoodRunRecordSchema>;
export type DogfoodReport = z.infer<typeof DogfoodReportSchema>;
```

- [ ] **Step 1:** Failing test: parse a valid task + record fixture; reject a record missing `humanEdit`; reject `runs: []` report. Model test style on `packages/contracts/src/canary.test.ts` if it exists, else on any contracts test.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(contracts): dogfood task, record and report schemas`

---

### Task 2: Dogfood workflows + task definitions

**Files:**

- Create: `workflows/dogfood-task-v1.yaml`, `workflows/dogfood-plan-v1.yaml`
- Create: `examples/dogfood/README.md`, `examples/dogfood/tasks/*.json` (5 tasks)

**Workflows.** Copy node structure from `workflows/web-app-v1.yaml` (read it first), trimmed:

- `dogfood-task-v1`: two nodes — `implementation-gate` quality-loop (`developer` setup, `code-reviewer` check, `repair-code` repair, `mutatesWorkspace: true`, `maxIterations: 2`) and `deterministic-verification` (verify step with scripts `['dogfood:verify']`, `fixer` repair, `maxIterations: 2`). Keep roles/artifact names exactly as web-app-v1 uses so the harness selection works unchanged.
- `dogfood-plan-v1`: single `plan-gate` quality-loop (planner / plan-reviewer / repair-plan), no workspace mutation.

**The 5 real v0.2 tasks** (all `baselineRef: "8896a3c"`; prompts in pt-BR like the repo's PRDs, each stating: the repo layout, the exact deliverable, the allowlist, and that `npm run dogfood:verify` must pass):

1. `domain-redaction` (issue #10): implement `packages/domain/src/redaction.ts` (`redactEvent`/`redactString`) to make the seeded test pass. Seed: `packages/domain/src/redaction.test.ts` (copy the test content from the issue-10 plan, `docs/superpowers/plans/2026-07-14-sse-event-stream-timeline.md` Task 1). `allowedFiles: ['packages/domain/src/redaction.ts', 'packages/domain/src/index.ts']`. `verifyScript: 'vitest run packages/domain/src/redaction.test.ts --pool=threads --maxWorkers=1'`.
2. `event-store-cursor` (issue #10): add `afterId` cursor support to `FileEventStore.list` + widen `EventStore` port. Seed: a new test file `packages/persistence/src/event-store-cursor.test.ts` with the cursor tests from the issue-10 plan Task 2. `allowedFiles: ['packages/persistence/src/event-store.ts', 'packages/domain/src/ports.ts']`.
3. `web-merge-events` (issue #10): implement `apps/web/lib/events.ts` `mergeEvents` passing seeded `apps/web/lib/events.test.ts` (tests from issue-10 plan Task 5). `allowedFiles: ['apps/web/lib/events.ts']`.
4. `failure-matrix-plan` (issue #11, planning — no diff): analyze `packages/orchestrator/src/run-controls.test.ts` and `workflow-orchestrator.ts` and produce a plan artifact enumerating the phase×failure matrix cells for issue #11. `workflowId: 'dogfood-plan-v1'`, `allowedFiles: []`, no `verifyScript`.
5. `executor-failure-fixtures` (issue #11): add `timeoutError`/`rateLimitError`/`invalidOutputError` factories + a `fail-once` behavior to a NEW file `packages/orchestrator/src/testing/fixtures.ts` passing seeded test `packages/orchestrator/src/testing/fixtures.test.ts` (assert `ExecutionError` shapes per issue-11 plan Task 2). `allowedFiles: ['packages/orchestrator/src/testing/fixtures.ts']`.

`examples/dogfood/README.md`: what this is, how to run (`npm run dogfood:run -- --task <id>`, `--all`, `--annotate-human-edits`, `--freeze`), where records land, the safety gates.

- [ ] **Step 1:** Write both workflow YAMLs; validate by loading them through the existing `YamlWorkflowRepository` in a quick vitest (`packages/composition/src/dogfood.test.ts` starts here): `expect(await workflows.get('dogfood-task-v1')).toBeTruthy()` plus schema parse.
- [ ] **Step 2:** Write the 5 task JSONs + README; test that every file in `examples/dogfood/tasks/` parses with `DogfoodTaskSchema` (glob in the same test file).
- [ ] **Step 3:** Run → PASS. **Commit** — `feat(dogfood): workflows and five real v0.2 task definitions`

---

### Task 3: The runner

**Files:**

- Create: `packages/composition/src/dogfood.ts`
- Create: `scripts/dogfood.ts`
- Modify: `package.json` (add `"dogfood:run": "tsx scripts/dogfood.ts"`), `.env.example` (document `RUN_REAL_DOGFOOD`), `.gitignore` if `.data/` isn't already covered
- Test: `packages/composition/src/dogfood.test.ts` (extend)

**Interfaces (produces):**

```ts
export interface DogfoodDependencies {
  // injectable for tests, mirroring provider-canary.ts style
  repoRoot: string; // local repo to seed from
  now(): Date;
}
export async function runDogfoodTask(
  task: DogfoodTask,
  options: {
    repoRoot: string;
    dataDir?: string;
    executorMode?: 'real' | 'mock';
    attempt?: number;
  },
): Promise<DogfoodRunRecord>;
export async function loadDogfoodTasks(dir: string): Promise<DogfoodTask[]>;
export function renderDogfoodMarkdown(report: DogfoodReport): string;
export async function freezeDogfoodReport(
  records: DogfoodRunRecord[],
  options: { baselinesDir: string; baselineRef: string },
): Promise<void>;
export async function annotateHumanEdits(
  records: DogfoodRunRecord[],
  options: { repoRoot: string; mergedRef: string },
): Promise<DogfoodRunRecord[]>;
```

`runDogfoodTask` flow (each numbered step is code, not prose — read `packages/composition/src/runtime.ts`, `provider-canary.ts`, and `packages/persistence/src/workspace-manager.ts` before writing):

1. `mkdtemp` a `DATA_DIR`; `createRuntime(env)` with `{ DATA_DIR, EXECUTOR_MODE: options.executorMode ?? 'real', RUN_WORKER_INLINE: 'false', WORKFLOWS_DIR: <repo workflows dir> }` (copy the full env recipe from `runtime.integration.test.ts`).
2. `project = await runtime.projectService.create({ name: task.id, prd: task.prompt, workflowId: task.workflowId })` — this creates the workspace and enqueues the job, but the worker has NOT claimed it yet (not inline).
3. Seed the workspace at `runtime.workspaces.workspacePath(project.id)` (or via the manager's path helper): `git -C <ws> fetch <repoRoot> <task.baselineRef>` + `git -C <ws> checkout FETCH_HEAD -- .`; write `task.seedFiles`; if `task.verifyScript`, inject `"dogfood:verify": task.verifyScript` into the workspace `package.json` scripts; run `npm ci` in the workspace (skip when `allowedFiles` is empty AND no verifyScript — the planning task needs no deps); `git add -A && git commit -m 'dogfood: seed baseline <ref>'`.
4. `started = Date.now()`; `await runtime.worker.runOnce()`; `durationMs = Date.now() - started`.
5. Collect: `run = await runtime.runs.get(project.currentRunId ?? ...)` (re-read project); steps + attempts via `runtime.stepRuns.list` / `runtime.stepAttempts.list`; pick the implementation attempt (last attempt of the mutating step; for plan workflow, the planner step) → `route`, `executedModel`, `usage`; verification artifact `verification.report` (via `runtime.projectService.getArtifact`) → `checks`; repair count = events with type `quality.repair_requested` (via `runtime.events.list(project.id)`), iterations from step context; diff: `git -C <ws> diff --stat <checkpoint> <commit>` + `--name-only` → `stat`, `filesChanged`; allowlist check: every changed file ∈ `task.allowedFiles` (for `allowedFiles: []`, require empty diff — same rule as canary planning).
6. `status = 'passed'` iff run completed && verification approved (or no verify step) && allowlist respected. On any throw: catch, sanitize (`kind = error.name`, `message` truncated 500 chars, no stdout/stderr), `status: 'failed'`, keep going.
7. Write full local record (including a `patch` field NOT in the schema? — no: write the frozen-shape record via `DogfoodRunRecordSchema.parse`, plus a sibling `<file>.patch.txt` with the raw `git diff` for local analysis) to `.data/dogfood/<taskId>-attempt<NN>.json`. Never delete existing records; `attempt` = 1 + count of existing records for the task.
8. `humanEdit: { status: 'pending', files: [] }` at run time.

`annotateHumanEdits`: for each record with a `diff`, for each `filesChanged` path: compare the agent's blob (`git -C <ws>` is gone — use the saved `.patch.txt` applied to baseline in a temp dir, or simpler: store each changed file's full content hash in the local record at run time) against `git -C repoRoot show <mergedRef>:<path>`. Classification: `same` (identical), `modified` (both exist, differ), `absent` (merged tree lacks it), `agent-only`. Simplest robust storage decision: at run time, copy the agent's changed files verbatim into `.data/dogfood/<taskId>-attempt<NN>-files/` — then annotation is a plain file comparison. Do that.

`freezeDogfoodReport`: reuse the canary pattern (atomic temp+rename into `docs/baselines/`, backup/rollback) but gate differently: require ≥5 distinct `taskId`s present and every `failed` record to carry `failure` — failures do NOT block freezing. Writes `docs/baselines/v0.2-dogfood.json` + `.md` (`renderDogfoodMarkdown`: table per run — task, attempt, status, selected → executed model, duration, tokens/cost, repairs, diff files count, human-edit status; then limitations list).

`scripts/dogfood.ts` (mirror `scripts/provider-canaries.ts`): parse `--task <id>`/`--all`/`--freeze`/`--annotate-human-edits <ref>`/`--executor-mode mock`; real mode requires `RUN_REAL_DOGFOOD=true` (else exit 1 with the opt-in message) and doctor probes ready (shell `node scripts/doctor.mjs --json` with `EXECUTOR_MODE=real`, skip-not-fail per provider like the canary).

- [ ] **Step 1: Failing mock-mode integration test** in `packages/composition/src/dogfood.test.ts`: a synthetic mini-task fixture (NOT the real repo — a tiny temp repo with one file and `verifyScript` using `node --test` or plain `node -e "process.exit(0)"` wrapped as an npm script; no `npm ci` needed — guard: skip install when the seeded workspace has no `package-lock.json`): run `runDogfoodTask(task, { executorMode: 'mock', repoRoot: fixtureRepo })`; assert the record parses, `status: 'passed'`, `route`/`usage`/`diff`/`checks`/`repairs` populated, record file + copied changed files exist under the temp `.data`. Second test: task whose `verifyScript` fails → `status: 'failed'` with `failure` populated and the record still written. Third: `freezeDogfoodReport` refuses <5 distinct tasks; accepts 5 including failures; `renderDogfoodMarkdown` snapshot contains the table header.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `dogfood.ts` + script. **Step 4:** Run → PASS. `npm run typecheck && npm run lint`.
- [ ] **Step 5: Commit** — `feat(dogfood): pipeline-backed dogfood runner with append-only records and freeze`

---

### Task 4: Real execution of the five tasks (evidence phase — NOT CI)

Preconditions: `EXECUTOR_MODE=real` CLIs authenticated on this host (see `docs/VALIDATION.md:30-46` — validated 2026-07-14), `RUN_REAL_DOGFOOD=true`.

- [ ] **Step 1:** `npm run doctor` in real mode — all providers ✓ (capture output).
- [ ] **Step 2:** For each task, run `RUN_REAL_DOGFOOD=true npm run dogfood:run -- --task <id>` sequentially (order: `failure-matrix-plan` first — cheapest, validates the loop end-to-end — then `web-merge-events`, `domain-redaction`, `event-store-cursor`, `executor-failure-fixtures`).
- [ ] **Step 3:** MANDATORY (issue test): if any run failed, diagnose from the record + failure artifact, fix the ROOT CAUSE (task prompt, seed, or runner bug — commit the fix), rerun that task (`attempt: 2`) and keep both records. If ALL five passed first try, still demonstrate the rerun path: intentionally run one task with a sabotaged `verifyScript` in a scratch copy? NO — do not fabricate evidence. Instead document in VALIDATION.md that the rerun path is covered by the mock-mode failing-task test, and rerun one real task once to show records append (`attempt: 2` on the cheapest task).
- [ ] **Step 4:** After issues #10/#11 PR branches are final: `npm run dogfood:run -- --annotate-human-edits <ref>` where `<ref>` is each PR branch head (run per record; the annotation notes name the PR). Re-freeze.
- [ ] **Step 5:** `npm run dogfood:run -- --freeze` → `docs/baselines/v0.2-dogfood.{json,md}`.
- [ ] **Step 6: Commit** — `feat(dogfood): freeze v0.2 dogfood baseline from five real task runs`

---

### Task 5: Docs + evidence

**Files:**

- Modify: `docs/VALIDATION.md` (new "Dogfood baseline — v0.2" section: table, boundaries, link to baselines), `README.md` (short dogfood subsection near the canary one)
- Create: `docs/adr/0012-dogfood-run-record-contract.md` (numbering: check `docs/adr/` in this worktree; if #10's ADR merged first as 0012, use 0013)

- [ ] **Step 1:** ADR: decision to run dogfood through the product pipeline (vs canary-style direct execution), the append-only failure-as-data rule, the freeze gate difference, what "quota" means here (tokens/estimated cost per ADR 0009 limits).
- [ ] **Step 2:** VALIDATION.md section with the results table and explicit boundaries (single host, single run per task unless rerun, not a reliability benchmark; feeds the pre-adaptive-routing baseline).
- [ ] **Step 3:** `npm run check` green. **Commit** — `docs: dogfood baseline validation record and ADR`
