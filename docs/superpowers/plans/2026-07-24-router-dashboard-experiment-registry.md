# Router Dashboard + Experiment Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a global router-decision audit dashboard, an experiment registry, and a benchmark regression gate for GitHub issue #67, satisfying its five acceptance criteria without adding a new package or a new dependency.

**Architecture:** A new flat, append-only production decision log (`RouterDecisionLogEntry`) is written once per approved/rejected quality-loop iteration inside the orchestrator, carrying exactly the fields the existing `ModelMetric`/`RouteDecision` aggregates don't (workflow id, harness version, time-to-approved, first-pass, repairs, confidence). Cost/quota stay sourced from the existing `FileMetricsRepository` aggregate rather than being duplicated per-decision. A separate `ExperimentRecord` store is a plain CRUD registry (record hypothesis/variants/population/stop-rule — it does not execute traffic-splitting). A pure `compareBenchmarkReports` function is the regression gate, run via a CLI flag and an API endpoint against the existing frozen benchmark baseline. A new Next.js page renders both, backed by new Fastify endpoints.

**Tech Stack:** TypeScript, Zod (contracts), Fastify (API), Next.js App Router + plain CSS (web, no chart library), Vitest (unit), Playwright (e2e, local-only).

## Global Constraints

- No new `@agent-foundry/*` package. All new code lives in `packages/contracts`, `packages/domain`, `packages/persistence`, `packages/composition`, `packages/orchestrator`, `apps/api`, `apps/web` — every edge already exists in `scripts/lib/architecture.mjs`'s `ALLOWED_INTERNAL_DEPENDENCIES`. Do not touch that file.
- No new npm dependency. All required packages (`zod`, `fastify`, `next`) are already present in every touched workspace's `package.json`.
- Persistence for the two new stores is **file-only** (`.data/`), matching the existing precedent of `metrics`/`modelOverrides`/`qualityObservations`, which also stay file-backed regardless of `PERSISTENCE_MODE`. No Postgres migration, no `describePostgres` suite.
- No new web UI dependency (no chart library). Hand-roll the one distribution visual as inline SVG. No UI component library — plain `className`s in `apps/web/app/globals.css`, matching existing dark theme tokens.
- User-facing web copy is Portuguese (pt-BR), matching every existing string in `apps/web/app/**`.
- Prettier: `singleQuote: true`, `trailingComma: 'all'`, `printWidth: 100`, `semi: true`. ESLint: `--max-warnings=0`, unused vars/args must be prefixed `_` or removed.
- Every new/modified `.ts` file needs a colocated `*.test.ts` (Vitest, `--pool=threads --maxWorkers=1`), and `tsc -b` (root `npm run typecheck`) must stay clean after each task.
- `planning/roadmap-spec.json` already has the `v09-router-dashboard` entry — do not edit it.
- The required e2e is a local-only extension of `apps/api/e2e/golden-flow.spec.ts` (Playwright is not wired into CI today); it is run manually via `npm run e2e --workspace @agent-foundry/api`.

---

### Task 1: Contracts — experiment, decision-log, and regression-gate schemas

**Files:**

- Create: `packages/contracts/src/experiment.ts`
- Create: `packages/contracts/src/experiment.test.ts`
- Modify: `packages/contracts/src/index.ts` (add barrel export)

**Interfaces:**

- Produces (consumed by every later task): `RouterDecisionLogEntrySchema` / `RouterDecisionLogEntry`, `ExperimentVariantSchema`/`ExperimentStopRuleSchema`/`ExperimentRecordSchema`/`ExperimentRecord`, `RegressionCaseDeltaSchema`/`RegressionGateResultSchema`/`RegressionGateResult`, `DecisionExportRowSchema`/`DecisionExportRow`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/contracts/src/experiment.test.ts
import { describe, expect, it } from 'vitest';
import {
  DecisionExportRowSchema,
  ExperimentRecordSchema,
  RegressionGateResultSchema,
  RouterDecisionLogEntrySchema,
} from './experiment.js';

const decision = {
  schemaVersion: '1' as const,
  id: '01J000000000000000000000',
  routeId: '01J000000000000000000001',
  createdAt: '2026-07-24T00:00:00.000Z',
  projectId: 'project-1',
  runId: 'run-1',
  nodeId: 'implement',
  workflowId: 'golden-flow-e2e-v1',
  harnessVersion: 'v3',
  taskKind: 'implementation' as const,
  category: 'implementation/frontend' as const,
  role: 'developer' as const,
  provider: 'claude' as const,
  modelId: 'claude-opus',
  model: 'claude-opus-4-8',
  approved: true,
  firstPass: true,
  repairs: 0,
  durationMs: 12_000,
  confidence: 0.82,
  sampleSize: 9,
};

describe('RouterDecisionLogEntrySchema', () => {
  it('accepts a well-formed entry', () => {
    expect(RouterDecisionLogEntrySchema.parse(decision)).toMatchObject(decision);
  });

  it('rejects an unknown field (strict)', () => {
    expect(() => RouterDecisionLogEntrySchema.parse({ ...decision, extra: 'nope' })).toThrow();
  });
});

describe('DecisionExportRowSchema', () => {
  it('strips projectId/runId/nodeId/id/routeId from an entry', () => {
    const row = DecisionExportRowSchema.parse(decision);
    expect(row).not.toHaveProperty('projectId');
    expect(row).not.toHaveProperty('runId');
    expect(row).not.toHaveProperty('nodeId');
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('routeId');
    expect(row.modelId).toBe('claude-opus');
  });
});

describe('ExperimentRecordSchema', () => {
  it('accepts a two-variant experiment with a stop rule', () => {
    const record = ExperimentRecordSchema.parse({
      schemaVersion: '1',
      id: 'exp-1',
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      hypothesis: 'Opus first-pass rate beats Sonnet on frontend implementation tasks.',
      variants: [
        { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
        { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
      ],
      population: { taskKinds: ['implementation'], targetSampleSize: 30 },
      stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
      status: 'draft',
    });
    expect(record.variants).toHaveLength(2);
  });

  it('rejects a single-variant experiment', () => {
    expect(() =>
      ExperimentRecordSchema.parse({
        schemaVersion: '1',
        id: 'exp-1',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
        hypothesis: 'x'.repeat(10),
        variants: [
          { key: 'control', description: 'only one', target: { kind: 'model', modelId: 'a' } },
        ],
        population: { taskKinds: ['implementation'], targetSampleSize: 30 },
        stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
        status: 'draft',
      }),
    ).toThrow();
  });
});

describe('RegressionGateResultSchema', () => {
  it('accepts a pass verdict with deltas', () => {
    const result = RegressionGateResultSchema.parse({
      schemaVersion: '1',
      createdAt: '2026-07-24T00:00:00.000Z',
      baselineRef: 'abc1234',
      freshCreatedAt: '2026-07-24T00:00:00.000Z',
      verdict: 'pass',
      reasons: [],
      deltas: [
        {
          caseId: 'greenfield-clamp-util',
          modelId: 'opus',
          baselineStatus: 'passed',
          freshStatus: 'passed',
          statusRegressed: false,
          durationDeltaMs: 500,
          repairsDelta: 0,
        },
      ],
    });
    expect(result.verdict).toBe('pass');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/experiment.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL with "Cannot find module './experiment.js'" (or similar resolution error).

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/contracts/src/experiment.ts
import { z } from 'zod';
import {
  AgentRoleSchema,
  PathSegmentSchema,
  ProviderSchema,
  TaskKindSchema,
} from './primitives.js';
import { TaskCategorySchema } from './task-taxonomy.js';
import { BenchmarkCaseKindSchema } from './benchmark.js';

// --- Production per-decision log -------------------------------------------
// Flattened, not the full RouteDecision: only the fields ModelMetric/RouteDecision
// don't already aggregate. Cost/quota stay on ModelMetric (FileMetricsRepository)
// to avoid duplicating a second cost ledger.
export const RouterDecisionLogEntrySchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: PathSegmentSchema,
    routeId: PathSegmentSchema,
    createdAt: z.string().datetime(),
    projectId: PathSegmentSchema,
    runId: PathSegmentSchema,
    nodeId: z.string().min(1),
    workflowId: z.string().min(1),
    harnessVersion: z.string().min(1),
    taskKind: TaskKindSchema,
    category: TaskCategorySchema,
    role: AgentRoleSchema,
    provider: ProviderSchema.exclude(['mock']),
    modelId: PathSegmentSchema,
    model: z.string().min(1),
    approved: z.boolean(),
    firstPass: z.boolean(),
    repairs: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    confidence: z.number().min(0).max(1).optional(),
    sampleSize: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RouterDecisionLogEntry = z.infer<typeof RouterDecisionLogEntrySchema>;

// PII-free export projection: drops every identifier that ties a row back to
// a specific project/run/node. There is no free-text field in the log entry
// by construction — keep it that way so this omit stays a sufficient boundary.
export const DecisionExportRowSchema = RouterDecisionLogEntrySchema.omit({
  id: true,
  routeId: true,
  projectId: true,
  runId: true,
  nodeId: true,
}).strict();
export type DecisionExportRow = z.infer<typeof DecisionExportRowSchema>;

// --- Experiment registry (records, does not execute traffic-splitting) -----
export const ExperimentVariantSchema = z
  .object({
    key: z.string().min(1),
    description: z.string().min(1),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('model'), modelId: PathSegmentSchema }).strict(),
      z.object({ kind: z.literal('harness'), harnessVersion: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('catalog'), catalogRef: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
export type ExperimentVariant = z.infer<typeof ExperimentVariantSchema>;

export const ExperimentStopRuleSchema = z
  .object({
    metric: z.enum(['approval-rate', 'first-pass-rate', 'cost-usd', 'time-to-approved-ms']),
    comparator: z.enum(['gte', 'lte']),
    threshold: z.number(),
    minSamples: z.number().int().positive(),
  })
  .strict();
export type ExperimentStopRule = z.infer<typeof ExperimentStopRuleSchema>;

export const ExperimentRecordSchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: PathSegmentSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    hypothesis: z.string().min(1),
    variants: z.array(ExperimentVariantSchema).min(2),
    population: z
      .object({
        taskKinds: z.array(TaskKindSchema).min(1),
        targetSampleSize: z.number().int().positive(),
      })
      .strict(),
    stopRule: ExperimentStopRuleSchema,
    status: z.enum(['draft', 'running', 'stopped', 'concluded']),
    conclusion: z.string().optional(),
  })
  .strict();
export type ExperimentRecord = z.infer<typeof ExperimentRecordSchema>;

// --- Regression gate ---------------------------------------------------------
export const RegressionCaseDeltaSchema = z
  .object({
    caseId: z.string().min(1),
    modelId: z.string().min(1),
    baselineStatus: z.enum(['passed', 'failed']),
    freshStatus: z.enum(['passed', 'failed']),
    statusRegressed: z.boolean(),
    durationDeltaMs: z.number(),
    repairsDelta: z.number().int(),
  })
  .strict();
export type RegressionCaseDelta = z.infer<typeof RegressionCaseDeltaSchema>;

export const RegressionGateResultSchema = z
  .object({
    schemaVersion: z.literal('1'),
    createdAt: z.string().datetime(),
    baselineRef: z.string(),
    freshCreatedAt: z.string().datetime(),
    verdict: z.enum(['pass', 'fail']),
    reasons: z.array(z.string()),
    deltas: z.array(RegressionCaseDeltaSchema),
  })
  .strict();
export type RegressionGateResult = z.infer<typeof RegressionGateResultSchema>;

// Re-exported purely so callers building fresh reports can reference it
// without importing benchmark.ts directly.
export { BenchmarkCaseKindSchema };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/experiment.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (4 test files / all assertions green).

- [ ] **Step 5: Add barrel export and typecheck**

Modify `packages/contracts/src/index.ts` — add one line after `export * from './benchmark.js';`:

```typescript
export * from './experiment.js';
```

Run: `npx tsc -b --force --pretty false`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/experiment.ts packages/contracts/src/experiment.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add router decision log, experiment, and regression gate schemas"
```

---

### Task 2: Domain ports — RouterDecisionLogRepository, ExperimentRepository

**Files:**

- Modify: `packages/domain/src/ports.ts` (append after `ModelOverrideRepository`, line ~148)

**Interfaces:**

- Consumes: `RouterDecisionLogEntry`, `ExperimentRecord` from `@agent-foundry/contracts` (Task 1).
- Produces: `RouterDecisionLogRepository`, `ExperimentRepository` — implemented by Task 3, consumed by Task 5 (runtime wiring) and Task 6 (orchestrator).

No test needed — this file only adds TypeScript interfaces (no runtime behavior); it is verified by `tsc -b` in the next task, once a concrete implementation exists.

- [ ] **Step 1: Add the import**

In `packages/domain/src/ports.ts`, add to the existing `from '@agent-foundry/contracts'` import block (after `ModelOverrideRecord,`):

```typescript
  RouterDecisionLogEntry,
  ExperimentRecord,
```

- [ ] **Step 2: Add the interfaces**

Insert immediately after the `ModelOverrideRepository` interface (currently ends at line 148 with `}`):

```typescript
/** Create-only, per-run production decision log — one row per quality-loop iteration. */
export interface RouterDecisionLogRepository {
  append(entry: RouterDecisionLogEntry): Promise<void>;
  list(filter?: {
    workflowId?: string;
    provider?: string;
    modelId?: string;
    taskKind?: string;
    harnessVersion?: string;
  }): Promise<RouterDecisionLogEntry[]>;
}

/** Mutable CRUD store — records a hypothesis/variants/population/stop-rule; does not execute traffic-splitting. */
export interface ExperimentRepository {
  create(record: ExperimentRecord): Promise<ExperimentRecord>;
  update(record: ExperimentRecord): Promise<ExperimentRecord>;
  get(id: string): Promise<ExperimentRecord | null>;
  list(): Promise<ExperimentRecord[]>;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b --force --pretty false`
Expected: no errors (interfaces are unused so far — that's fine, TS doesn't flag unused exported types).

- [ ] **Step 4: Commit**

```bash
git add packages/domain/src/ports.ts
git commit -m "feat(domain): add RouterDecisionLogRepository and ExperimentRepository ports"
```

---

### Task 3: File persistence repositories

**Files:**

- Create: `packages/persistence/src/router-decision-log-repository.ts`
- Create: `packages/persistence/src/router-decision-log-repository.test.ts`
- Create: `packages/persistence/src/experiment-repository.ts`
- Create: `packages/persistence/src/experiment-repository.test.ts`
- Modify: `packages/persistence/src/index.ts` (add two barrel exports)

**Interfaces:**

- Consumes: `RouterDecisionLogRepository`, `ExperimentRepository` (Task 2); `RouterDecisionLogEntrySchema`, `ExperimentRecordSchema` (Task 1); `atomicCreateJson`, `atomicWriteJson`, `ensureDir`, `exists`, `readJson`, `readJsonOrNull`, `safeSegment` from `./fs-utils.js`.
- Produces: `FileRouterDecisionLogRepository`, `FileExperimentRepository` — consumed by Task 5 (`runtime.ts`).

- [ ] **Step 1: Write the failing test for the decision log repo**

```typescript
// packages/persistence/src/router-decision-log-repository.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RouterDecisionLogEntry } from '@agent-foundry/contracts';
import { FileRouterDecisionLogRepository } from './router-decision-log-repository.js';

function entry(overrides: Partial<RouterDecisionLogEntry> = {}): RouterDecisionLogEntry {
  return {
    schemaVersion: '1',
    id: overrides.id ?? 'entry-1',
    routeId: 'route-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    projectId: 'project-1',
    runId: overrides.runId ?? 'run-1',
    nodeId: 'implement',
    workflowId: 'golden-flow-e2e-v1',
    harnessVersion: 'v3',
    taskKind: 'implementation',
    category: 'implementation/frontend',
    role: 'developer',
    provider: 'claude',
    modelId: 'claude-opus',
    model: 'claude-opus-4-8',
    approved: true,
    firstPass: true,
    repairs: 0,
    durationMs: 12_000,
    confidence: 0.82,
    sampleSize: 9,
    ...overrides,
  };
}

describe('FileRouterDecisionLogRepository', () => {
  let dataDir: string;
  let repo: FileRouterDecisionLogRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'router-decision-log-'));
    repo = new FileRouterDecisionLogRepository(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('appends and lists entries across multiple runs', async () => {
    await repo.append(entry({ id: 'e1', runId: 'run-1', modelId: 'claude-opus' }));
    await repo.append(entry({ id: 'e2', runId: 'run-2', modelId: 'codex-5' }));

    const all = await repo.list();
    expect(all).toHaveLength(2);
  });

  it('filters by modelId', async () => {
    await repo.append(entry({ id: 'e1', runId: 'run-1', modelId: 'claude-opus' }));
    await repo.append(entry({ id: 'e2', runId: 'run-2', modelId: 'codex-5' }));

    const filtered = await repo.list({ modelId: 'codex-5' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.modelId).toBe('codex-5');
  });

  it('rejects a duplicate id within the same run', async () => {
    await repo.append(entry({ id: 'e1', runId: 'run-1' }));
    await expect(repo.append(entry({ id: 'e1', runId: 'run-1' }))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/router-decision-log-repository.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — module `./router-decision-log-repository.js` not found.

- [ ] **Step 3: Implement FileRouterDecisionLogRepository**

```typescript
// packages/persistence/src/router-decision-log-repository.ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RouterDecisionLogEntrySchema,
  type RouterDecisionLogEntry,
} from '@agent-foundry/contracts';
import type { RouterDecisionLogRepository } from '@agent-foundry/domain';
import { atomicCreateJson, ensureDir, exists, readJson, safeSegment } from './fs-utils.js';

export interface RouterDecisionLogFilter {
  workflowId?: string;
  provider?: string;
  modelId?: string;
  taskKind?: string;
  harnessVersion?: string;
}

// ponytail: list() scans every run directory linearly; add a cross-run index
// file if the number of runs on disk grows large enough for this to matter.
export class FileRouterDecisionLogRepository implements RouterDecisionLogRepository {
  constructor(private readonly dataDir: string) {}

  async append(entry: RouterDecisionLogEntry): Promise<void> {
    const parsed = RouterDecisionLogEntrySchema.parse(entry);
    const root = this.rootFor(parsed.runId);
    await ensureDir(root);
    const path = join(root, `${safeSegment(parsed.id)}.json`);
    if (!(await atomicCreateJson(path, parsed))) {
      throw new Error(`router decision log entry ${parsed.id} already exists`);
    }
  }

  async list(filter: RouterDecisionLogFilter = {}): Promise<RouterDecisionLogEntry[]> {
    const runsRoot = join(this.dataDir, 'runs');
    await ensureDir(runsRoot);
    const runDirs = await readdir(runsRoot, { withFileTypes: true });
    const entries: RouterDecisionLogEntry[] = [];
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const decisionsRoot = join(runsRoot, runDir.name, 'router-decisions');
      if (!(await exists(decisionsRoot))) continue;
      const files = (await readdir(decisionsRoot)).filter((file) => file.endsWith('.json'));
      for (const file of files) {
        entries.push(RouterDecisionLogEntrySchema.parse(await readJson(join(decisionsRoot, file))));
      }
    }
    return entries
      .filter((entry) => !filter.workflowId || entry.workflowId === filter.workflowId)
      .filter((entry) => !filter.provider || entry.provider === filter.provider)
      .filter((entry) => !filter.modelId || entry.modelId === filter.modelId)
      .filter((entry) => !filter.taskKind || entry.taskKind === filter.taskKind)
      .filter((entry) => !filter.harnessVersion || entry.harnessVersion === filter.harnessVersion)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private rootFor(runId: string): string {
    return join(this.dataDir, 'runs', safeSegment(runId), 'router-decisions');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/router-decision-log-repository.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (3/3).

- [ ] **Step 5: Write the failing test for the experiment repo**

```typescript
// packages/persistence/src/experiment-repository.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExperimentRecord } from '@agent-foundry/contracts';
import { FileExperimentRepository } from './experiment-repository.js';

function record(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    schemaVersion: '1',
    id: overrides.id ?? 'exp-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
    variants: [
      { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
      { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
    ],
    population: { taskKinds: ['implementation'], targetSampleSize: 30 },
    stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
    status: 'draft',
    ...overrides,
  };
}

describe('FileExperimentRepository', () => {
  let dataDir: string;
  let repo: FileExperimentRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'experiment-repo-'));
    repo = new FileExperimentRepository(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates, gets, and lists experiments', async () => {
    await repo.create(record({ id: 'exp-1' }));
    await repo.create(record({ id: 'exp-2' }));

    expect(await repo.get('exp-1')).toMatchObject({ id: 'exp-1' });
    expect(await repo.list()).toHaveLength(2);
  });

  it('rejects creating a duplicate id', async () => {
    await repo.create(record({ id: 'exp-1' }));
    await expect(repo.create(record({ id: 'exp-1' }))).rejects.toThrow();
  });

  it('updates status and conclusion', async () => {
    await repo.create(record({ id: 'exp-1', status: 'draft' }));
    const updated = await repo.update(
      record({ id: 'exp-1', status: 'concluded', conclusion: 'Opus wins.' }),
    );
    expect(updated.status).toBe('concluded');
    expect(await repo.get('exp-1')).toMatchObject({ status: 'concluded' });
  });

  it('rejects updating an experiment that does not exist', async () => {
    await expect(repo.update(record({ id: 'missing' }))).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/experiment-repository.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement FileExperimentRepository**

```typescript
// packages/persistence/src/experiment-repository.ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExperimentRecordSchema, type ExperimentRecord } from '@agent-foundry/contracts';
import type { ExperimentRepository } from '@agent-foundry/domain';
import {
  atomicCreateJson,
  atomicWriteJson,
  ensureDir,
  readJson,
  readJsonOrNull,
  safeSegment,
} from './fs-utils.js';

export class FileExperimentRepository implements ExperimentRepository {
  constructor(private readonly dataDir: string) {}

  async create(record: ExperimentRecord): Promise<ExperimentRecord> {
    const parsed = ExperimentRecordSchema.parse(record);
    await ensureDir(this.root());
    if (!(await atomicCreateJson(this.pathFor(parsed.id), parsed))) {
      throw new Error(`experiment ${parsed.id} already exists`);
    }
    return parsed;
  }

  async update(record: ExperimentRecord): Promise<ExperimentRecord> {
    const parsed = ExperimentRecordSchema.parse(record);
    const existing = await readJsonOrNull(this.pathFor(parsed.id));
    if (!existing) throw new Error(`experiment ${parsed.id} does not exist`);
    await atomicWriteJson(this.pathFor(parsed.id), parsed);
    return parsed;
  }

  async get(id: string): Promise<ExperimentRecord | null> {
    const raw = await readJsonOrNull(this.pathFor(id));
    return raw ? ExperimentRecordSchema.parse(raw) : null;
  }

  async list(): Promise<ExperimentRecord[]> {
    await ensureDir(this.root());
    const files = (await readdir(this.root())).filter((file) => file.endsWith('.json'));
    const records = await Promise.all(
      files.map(async (file) =>
        ExperimentRecordSchema.parse(await readJson(join(this.root(), file))),
      ),
    );
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private root(): string {
    return join(this.dataDir, 'experiments');
  }

  private pathFor(id: string): string {
    return join(this.root(), `${safeSegment(id)}.json`);
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/experiment-repository.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (4/4).

- [ ] **Step 9: Add barrel exports and typecheck**

Modify `packages/persistence/src/index.ts` — add two lines (alongside the existing `export * from './model-override-repository.js';`):

```typescript
export * from './router-decision-log-repository.js';
export * from './experiment-repository.js';
```

Run: `npx tsc -b --force --pretty false`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/persistence/src/router-decision-log-repository.ts packages/persistence/src/router-decision-log-repository.test.ts \
  packages/persistence/src/experiment-repository.ts packages/persistence/src/experiment-repository.test.ts packages/persistence/src/index.ts
git commit -m "feat(persistence): add file-backed router decision log and experiment repositories"
```

---

### Task 4: Regression gate comparator

**Files:**

- Create: `packages/composition/src/regression-gate.ts`
- Create: `packages/composition/src/regression-gate.test.ts`
- Modify: `packages/composition/src/index.ts` (add barrel export)

**Interfaces:**

- Consumes: `BenchmarkReport`, `RegressionGateResultSchema` (Task 1, already-existing `BenchmarkReport` from `benchmark.ts`).
- Produces: `compareBenchmarkReports(fresh, baseline): RegressionGateResult` — consumed by Task 7 (API) and Task 8 (CLI).

This task is independent of Tasks 2/3 and can run in parallel with them once Task 1 is committed.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/composition/src/regression-gate.test.ts
import { describe, expect, it } from 'vitest';
import type { BenchmarkReport } from '@agent-foundry/contracts';
import { compareBenchmarkReports } from './regression-gate.js';

function report(overrides: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    schemaVersion: '1',
    createdAt: '2026-07-24T00:00:00.000Z',
    baselineRef: 'abc1234',
    runs: [],
    limitations: [],
    ...overrides,
  } as BenchmarkReport;
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1' as const,
    attempt: 1,
    baselineRef: 'abc1234',
    projectId: 'project-1',
    runId: 'run-1',
    startedAt: '2026-07-24T00:00:00.000Z',
    status: 'passed' as const,
    durationMs: 10_000,
    checks: [],
    repairs: { iterations: 1, repairEvents: 0 },
    humanEdit: { status: 'pending', files: [] },
    caseId: 'greenfield-clamp-util',
    caseKind: 'greenfield' as const,
    modelId: 'opus',
    ...overrides,
  };
}

describe('compareBenchmarkReports', () => {
  it('passes when every case keeps or improves status', () => {
    const baseline = report({ runs: [run({ status: 'passed' })] });
    const fresh = report({ runs: [run({ status: 'passed', durationMs: 9_000 })] });

    const result = compareBenchmarkReports(fresh, baseline);
    expect(result.verdict).toBe('pass');
    expect(result.reasons).toHaveLength(0);
    expect(result.deltas[0]?.durationDeltaMs).toBe(-1_000);
  });

  it('fails when a case regresses from passed to failed', () => {
    const baseline = report({ runs: [run({ status: 'passed' })] });
    const fresh = report({ runs: [run({ status: 'failed' })] });

    const result = compareBenchmarkReports(fresh, baseline);
    expect(result.verdict).toBe('fail');
    expect(result.reasons[0]).toContain('regressed');
    expect(result.deltas[0]?.statusRegressed).toBe(true);
  });

  it('fails when a baseline case is missing from the fresh report', () => {
    const baseline = report({ runs: [run({ caseId: 'a' }), run({ caseId: 'b' })] });
    const fresh = report({ runs: [run({ caseId: 'a' })] });

    const result = compareBenchmarkReports(fresh, baseline);
    expect(result.verdict).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('missing'))).toBe(true);
  });

  it('does not fail on a duration or repairs regression alone', () => {
    const baseline = report({
      runs: [
        run({ status: 'passed', durationMs: 5_000, repairs: { iterations: 1, repairEvents: 0 } }),
      ],
    });
    const fresh = report({
      runs: [
        run({ status: 'passed', durationMs: 20_000, repairs: { iterations: 3, repairEvents: 2 } }),
      ],
    });

    const result = compareBenchmarkReports(fresh, baseline);
    expect(result.verdict).toBe('pass');
    expect(result.deltas[0]?.durationDeltaMs).toBe(15_000);
    expect(result.deltas[0]?.repairsDelta).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/composition/src/regression-gate.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement compareBenchmarkReports**

```typescript
// packages/composition/src/regression-gate.ts
import {
  RegressionGateResultSchema,
  type BenchmarkReport,
  type RegressionGateResult,
} from '@agent-foundry/contracts';

// ponytail: status-only gate (passed -> failed is the only hard failure).
// Duration/repairs deltas are reported but non-blocking, to avoid flaky
// provider-timing gates; add a duration-budget rule only once promotions
// start actually shipping measurable slowdowns.
export function compareBenchmarkReports(
  fresh: BenchmarkReport,
  baseline: BenchmarkReport,
): RegressionGateResult {
  const freshByKey = new Map(fresh.runs.map((run) => [`${run.caseId}::${run.modelId}`, run]));
  const reasons: string[] = [];
  const deltas: RegressionGateResult['deltas'] = [];

  for (const baselineRun of baseline.runs) {
    const key = `${baselineRun.caseId}::${baselineRun.modelId}`;
    const freshRun = freshByKey.get(key);
    if (!freshRun) {
      reasons.push(`${key}: missing from fresh report`);
      continue;
    }
    const statusRegressed = baselineRun.status === 'passed' && freshRun.status === 'failed';
    if (statusRegressed) reasons.push(`${key}: regressed from passed to failed`);
    deltas.push({
      caseId: freshRun.caseId,
      modelId: freshRun.modelId,
      baselineStatus: baselineRun.status,
      freshStatus: freshRun.status,
      statusRegressed,
      durationDeltaMs: freshRun.durationMs - baselineRun.durationMs,
      repairsDelta: freshRun.repairs.iterations - baselineRun.repairs.iterations,
    });
  }

  return RegressionGateResultSchema.parse({
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    baselineRef: baseline.baselineRef,
    freshCreatedAt: fresh.createdAt,
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    deltas,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/composition/src/regression-gate.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (4/4).

- [ ] **Step 5: Add barrel export and typecheck**

Modify `packages/composition/src/index.ts` — add after `export * from './benchmark-runner.js';`:

```typescript
export * from './regression-gate.js';
```

Run: `npx tsc -b --force --pretty false`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/composition/src/regression-gate.ts packages/composition/src/regression-gate.test.ts packages/composition/src/index.ts
git commit -m "feat(composition): add pure benchmark regression gate comparator"
```

---

### Task 5: Wire new repositories into runtime.ts and the orchestrator constructor

**Files:**

- Modify: `packages/composition/src/runtime.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts` (constructor signature only — instrumentation body is Task 6)

**Interfaces:**

- Consumes: `FileRouterDecisionLogRepository`, `FileExperimentRepository` (Task 3).
- Produces: `Runtime.decisionLog: FileRouterDecisionLogRepository`, `Runtime.experiments: FileExperimentRepository`; `WorkflowOrchestrator` gains a new optional constructor parameter `decisionLog?: RouterDecisionLogRepository` — consumed by Task 6 and Task 7 (`apps/api`).

This depends on Task 3. Requires an integration-level check rather than a unit test (constructing a `Runtime` touches many collaborators) — verified via the existing `runtime.integration.test.ts` plus `tsc -b`.

- [ ] **Step 1: Add imports**

In `packages/composition/src/runtime.ts`, add to the `@agent-foundry/persistence` import block:

```typescript
  FileRouterDecisionLogRepository,
  FileExperimentRepository,
```

- [ ] **Step 2: Add fields to the Runtime interface**

After `modelOverrides: FileModelOverrideRepository;` (line 110):

```typescript
decisionLog: FileRouterDecisionLogRepository;
experiments: FileExperimentRepository;
```

- [ ] **Step 3: Construct the repositories**

After `const modelOverrides = new FileModelOverrideRepository(config.dataDir);` (line 194):

```typescript
const decisionLog = new FileRouterDecisionLogRepository(config.dataDir);
const experiments = new FileExperimentRepository(config.dataDir);
```

- [ ] **Step 4: Pass decisionLog into WorkflowOrchestrator**

In `packages/orchestrator/src/workflow-orchestrator.ts`, add a new final optional constructor parameter after `private readonly secretStore?: SecretStore,`:

```typescript
    private readonly decisionLog?: RouterDecisionLogRepository,
```

Add `RouterDecisionLogRepository` to the `@agent-foundry/contracts`-adjacent import block at the top of the file — it actually comes from `@agent-foundry/domain`, so add it to that import instead (the file already imports several types from `@agent-foundry/domain` alongside the class body; add a new `import type { RouterDecisionLogRepository } from '@agent-foundry/domain';` near the file's existing domain-facing imports if one doesn't already exist, otherwise fold it into the existing one).

In `packages/composition/src/runtime.ts`, update the `new WorkflowOrchestrator(...)` call (line 288) to pass `decisionLog` as the new last argument, after `secretStore,` (line 315):

```typescript
    secretStore,
    decisionLog,
```

- [ ] **Step 5: Add to the Runtime return object**

After `modelOverrides,` in the returned object (line 402):

```typescript
    decisionLog,
    experiments,
```

- [ ] **Step 6: Typecheck and run the runtime integration test**

Run: `npx tsc -b --force --pretty false`
Expected: no errors.

Run: `npx vitest run packages/composition/src/runtime.integration.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (existing suite stays green; it doesn't yet assert on `decisionLog`/`experiments`, so no test changes are required here).

- [ ] **Step 7: Commit**

```bash
git add packages/composition/src/runtime.ts packages/orchestrator/src/workflow-orchestrator.ts
git commit -m "feat(composition): wire router decision log and experiment repositories into the runtime"
```

---

### Task 6: Orchestrator instrumentation — append a decision-log row per quality-loop iteration

**Files:**

- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts` (thread `decisionLog` through the shared test harness)
- Modify: `packages/orchestrator/src/quality-observation-integration.test.ts` (add the new assertion next to the existing blind-review/deterministic-check tests, which already exercise the exact setup→review→repair→approval path this needs)

**Interfaces:**

- Consumes: `this.decisionLog` (Task 5), `this.harness.version()`, `this.clock.now()`, `this.ids.next()` (all already-existing fields), `route.executed ?? route.selected` (`RankedModel`), `route.profile.{taskKind,category,role}`.
- Produces: one `RouterDecisionLogEntry` appended per quality-loop iteration when a `qualitySubject` carries a `routeDecision` — read by Task 7's dashboard endpoints.

- [ ] **Step 1: Thread decisionLog through the shared test harness**

`packages/orchestrator/src/testing/harness.ts`'s `makeHarness()` builds the real `WorkflowOrchestrator` for every orchestrator test via `completeRun(harness)`. Its constructor call (line ~1302) currently stops at `opts.qualityObservationService` (the 25th positional constructor argument), leaving `executors` (26th) and `secretStore` (27th) implicitly `undefined`. The new `decisionLog` parameter (Task 5) is the 28th and last — reaching it requires explicit `undefined` placeholders for the two args in between.

Add `RouterDecisionLogRepository` to `harness.ts`'s existing `@agent-foundry/domain` type-only import block (alongside `type ApprovalDecisionRepository`, etc.):

```typescript
  type RouterDecisionLogRepository,
```

Add `decisionLog?: RouterDecisionLogRepository;` to `makeHarness`'s `opts` parameter type (in the object type starting at line 1138, alongside `qualityObservationService?: QualityObservationService;`).

Change the constructor call (line ~1302-1328) so it ends:

```typescript
    stores.modelOverrides,
    opts.versions,
    opts.browserVerification,
    opts.qualityObservationService,
    undefined,
    undefined,
    opts.decisionLog,
  );
```

- [ ] **Step 2: Add the failing test**

In `packages/orchestrator/src/quality-observation-integration.test.ts`, add a `MemoryRouterDecisionLog` test double next to the existing `MemoryQualityObservations` class:

```typescript
class MemoryRouterDecisionLog implements RouterDecisionLogRepository {
  readonly values: RouterDecisionLogEntry[] = [];
  async append(entry: RouterDecisionLogEntry): Promise<void> {
    this.values.push(entry);
  }
  async list(): Promise<RouterDecisionLogEntry[]> {
    return this.values;
  }
}
```

Add `type RouterDecisionLogEntry` to the existing `@agent-foundry/contracts` import and `type RouterDecisionLogRepository` to the existing `@agent-foundry/domain` import at the top of the file.

Add a new test inside the `describe('WorkflowOrchestrator quality observations', ...)` block, alongside the existing `'records an approved blind review for the setup output'` test:

```typescript
it('appends a router decision log entry for the approved iteration', async () => {
  const decisionLog = new MemoryRouterDecisionLog();
  const harness = makeHarness({}, undefined, { workflow, decisionLog });

  await completeRun(harness);

  expect(decisionLog.values).toMatchObject([
    {
      approved: true,
      firstPass: true,
      repairs: 0,
      workflowId: workflow.id,
      harnessVersion: harness.harnessVersion.value,
      taskKind: 'code-review',
      modelId: expect.any(String),
    },
  ]);
});
```

(If `harness.harnessVersion` isn't the exact property name the `Stores` type exposes for the fixture harness version, use whatever `stores.harnessVersion.value` is called elsewhere in this same file/`makeHarness` — it's the same value the mock `HarnessRepository.version()` in `makeHarness` returns.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/quality-observation-integration.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `decisionLog.values` is empty (the orchestrator doesn't call `append` yet).

- [ ] **Step 4: Capture loop start time**

In `executeQualityLoopTraced`, immediately before `let latest: StoredArtifact | null = null;`, add:

```typescript
const loopStartedAt = this.clock.now().getTime();
```

- [ ] **Step 5: Call appendDecisionLog alongside recordQualityOutcome**

Inside the `for` loop, the existing block reads:

```typescript
if (qualitySubject) {
  await this.recordQualityOutcome(qualitySubject, approved);
  if (node.check.type === 'verify') {
    await this.qualityObservations?.recordDeterministic(qualitySubject, latest, approved);
  } else if (isReviewerRole(node.check.role)) {
    await this.qualityObservations?.recordBlindReview(qualitySubject, latest, approved);
  }
}
```

Add one line right after `await this.recordQualityOutcome(qualitySubject, approved);`:

```typescript
await this.appendDecisionLog(
  project.id,
  workflow.id,
  node.id,
  runId,
  qualitySubject,
  approved,
  iteration,
  this.clock.now().getTime() - loopStartedAt,
);
```

- [ ] **Step 6: Implement the appendDecisionLog helper**

Add this private method next to `recordQualityOutcome` (which stays unchanged):

```typescript
  private async appendDecisionLog(
    projectId: string,
    workflowId: string,
    nodeId: string,
    runId: string,
    artifact: StoredArtifact,
    approved: boolean,
    iteration: number,
    durationMs: number,
  ): Promise<void> {
    if (!this.decisionLog) return;
    const route = artifact.metadata.routeDecision;
    if (!route) return;
    const executed = route.executed ?? route.selected;
    await this.decisionLog.append({
      schemaVersion: '1',
      id: this.ids.next(),
      routeId: route.routeId,
      createdAt: this.clock.now().toISOString(),
      projectId,
      runId,
      nodeId,
      workflowId,
      harnessVersion: await this.harness.version(),
      taskKind: route.profile.taskKind,
      category: route.profile.category,
      role: route.profile.role,
      provider: executed.model.provider,
      modelId: executed.model.id,
      model: executed.model.model,
      approved,
      firstPass: approved && iteration === 1,
      repairs: iteration - 1,
      durationMs,
      ...(executed.confidence
        ? { confidence: executed.confidence.value, sampleSize: executed.confidence.sampleSize }
        : {}),
    });
  }
```

Add `RouterDecisionLogEntry` is not needed as a type import here (the object literal is inferred against `RouterDecisionLogRepository.append`'s parameter type); no new import required beyond the `RouterDecisionLogRepository` type added in Task 5.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/quality-observation-integration.test.ts --pool=threads --maxWorkers=1`
Expected: PASS.

- [ ] **Step 8: Run the full orchestrator suite and typecheck**

Run: `npx vitest run packages/orchestrator --pool=threads --maxWorkers=1`
Expected: PASS (no regressions in sibling quality-loop/repair tests).

Run: `npx tsc -b --force --pretty false`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/testing/harness.ts packages/orchestrator/src/quality-observation-integration.test.ts
git commit -m "feat(orchestrator): append a router decision log entry per quality-loop iteration"
```

---

### Task 7: API endpoints — dashboard, decisions, experiments CRUD, regression gate, export

**Files:**

- Modify: `packages/contracts/src/api.ts` (request/response schemas)
- Modify: `apps/api/src/app.ts` (route registration)
- Create: `apps/api/src/router.test.ts`

**Interfaces:**

- Consumes: `runtime.decisionLog`, `runtime.experiments`, `runtime.metrics` (Task 5), `compareBenchmarkReports` (Task 4), `ExperimentRecordSchema`/`RegressionGateResultSchema`/`DecisionExportRowSchema` (Task 1).
- Produces: `GET /router/dashboard`, `GET /router/decisions`, `GET /router/export`, `POST /router/regression-gate`, `GET /experiments`, `POST /experiments`, `GET /experiments/:id`, `PATCH /experiments/:id` — consumed by Task 8 (web) and Task 9 (e2e).

- [ ] **Step 1: Add request/response schemas to contracts/src/api.ts**

Add after `RuntimeInfoResponseSchema` (line ~359):

```typescript
export const RouterDashboardQuerySchema = z.object({
  taskKind: TaskKindSchema.optional(),
  provider: ProviderSchema.exclude(['mock']).optional(),
  modelId: PathSegmentSchema.optional(),
  workflowId: z.string().min(1).optional(),
  harnessVersion: z.string().min(1).optional(),
});
export type RouterDashboardQuery = z.infer<typeof RouterDashboardQuerySchema>;

export const RouterDashboardResponseSchema = z.object({
  facets: z.object({
    taskKinds: z.array(TaskKindSchema),
    providers: z.array(ProviderSchema.exclude(['mock'])),
    modelIds: z.array(z.string()),
    workflowIds: z.array(z.string()),
    harnessVersions: z.array(z.string()),
  }),
  kpis: z.object({
    sampleSize: z.number().int().nonnegative(),
    firstPassRate: z.number().min(0).max(1).nullable(),
    avgRepairs: z.number().nonnegative().nullable(),
    timeToApprovedMsP50: z.number().nonnegative().nullable(),
    timeToApprovedMsP95: z.number().nonnegative().nullable(),
    avgConfidence: z.number().min(0).max(1).nullable(),
    costUsd: z.number().nonnegative().nullable(),
    quotaUnits: z.number().nonnegative().nullable(),
  }),
});
export type RouterDashboardResponse = z.infer<typeof RouterDashboardResponseSchema>;

export const CreateExperimentRequestSchema = ExperimentRecordSchema.omit({
  schemaVersion: true,
  id: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  conclusion: true,
});
export type CreateExperimentRequest = z.infer<typeof CreateExperimentRequestSchema>;

export const UpdateExperimentRequestSchema = z.object({
  status: z.enum(['draft', 'running', 'stopped', 'concluded']).optional(),
  conclusion: z.string().optional(),
});
export type UpdateExperimentRequest = z.infer<typeof UpdateExperimentRequestSchema>;

export const RegressionGateRequestSchema = z.object({ fresh: BenchmarkReportSchema });
export type RegressionGateRequest = z.infer<typeof RegressionGateRequestSchema>;
```

This requires adding `ExperimentRecordSchema`, `BenchmarkReportSchema` to `api.ts`'s existing import from `./experiment.js` / `./benchmark.js` (both already exported from the barrel — import directly from the sibling files, matching how `api.ts` already imports `ModelDefinitionSchema` from `./model.js`).

- [ ] **Step 2: Write the failing API test**

```typescript
// apps/api/src/router.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

describe('router dashboard + experiments API', () => {
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataDir: string;
  let workflowsDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'router-api-data-'));
    workflowsDir = await mkdtemp(join(tmpdir(), 'router-api-wf-'));
    runtime = await createRuntime({
      ...process.env,
      DATA_DIR: dataDir,
      WORKFLOWS_DIR: workflowsDir,
      EXECUTOR_MODE: 'mock',
    } as NodeJS.ProcessEnv);
    app = await buildApp(runtime);
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workflowsDir, { recursive: true, force: true });
  });

  it('returns empty facets and null KPIs with no decisions', async () => {
    const response = await app.inject({ method: 'GET', url: '/router/dashboard' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.facets.modelIds).toEqual([]);
    expect(body.kpis.sampleSize).toBe(0);
    expect(body.kpis.firstPassRate).toBeNull();
  });

  it('creates, lists, and updates an experiment', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/experiments',
      payload: {
        hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
        variants: [
          { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
          { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
        ],
        population: { taskKinds: ['implementation'], targetSampleSize: 30 },
        stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
      },
    });
    expect(create.statusCode).toBe(201);
    const { experiment } = create.json();
    expect(experiment.status).toBe('draft');

    const list = await app.inject({ method: 'GET', url: '/experiments' });
    expect(list.json().experiments).toHaveLength(1);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/experiments/${experiment.id}`,
      payload: { status: 'concluded', conclusion: 'Opus wins.' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().experiment.status).toBe('concluded');
  });

  it('exports decisions with no project/run/node identifiers', async () => {
    const response = await app.inject({ method: 'GET', url: '/router/export' });
    expect(response.statusCode).toBe(200);
    const { rows } = response.json();
    for (const row of rows) {
      expect(row).not.toHaveProperty('projectId');
      expect(row).not.toHaveProperty('runId');
      expect(row).not.toHaveProperty('nodeId');
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/api/src/router.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 4: Add the routes to app.ts**

Add to the existing `@agent-foundry/contracts` import block in `apps/api/src/app.ts`:

```typescript
  CreateExperimentRequestSchema,
  RegressionGateRequestSchema,
  RouterDashboardQuerySchema,
  RouterDashboardResponseSchema,
  UpdateExperimentRequestSchema,
  DecisionExportRowSchema,
} from '@agent-foundry/contracts';
```

Add `compareBenchmarkReports` to the existing `@agent-foundry/composition` import line:

```typescript
import {
  blobKeyFor,
  compareBenchmarkReports,
  listRisks,
  getRiskById,
  verifyBlobToken,
} from '@agent-foundry/composition';
```

Add the routes after the existing `GET /runtime` block (line ~169):

```typescript
app.get('/router/dashboard', async (request) => {
  const query = RouterDashboardQuerySchema.parse(request.query);
  const filtered = await runtime.decisionLog.list(query);
  const all = await runtime.decisionLog.list();
  const metrics = await runtime.metrics.list();
  const matchingMetrics = metrics.filter(
    (metric) =>
      (!query.modelId || metric.modelId === query.modelId) &&
      (!query.taskKind || metric.taskKind === query.taskKind),
  );
  const durations = filtered.map((entry) => entry.durationMs).sort((left, right) => left - right);
  const firstPassCount = filtered.filter((entry) => entry.firstPass).length;
  const confidences = filtered
    .map((entry) => entry.confidence)
    .filter((value): value is number => value !== undefined);
  const totalCost = matchingMetrics.reduce((sum, metric) => sum + metric.totalEstimatedCostUsd, 0);
  const totalQuota = matchingMetrics.reduce(
    (sum, metric) => sum + (metric.quotaUnitsTotal ?? 0),
    0,
  );

  return RouterDashboardResponseSchema.parse({
    facets: {
      taskKinds: [...new Set(all.map((entry) => entry.taskKind))],
      providers: [...new Set(all.map((entry) => entry.provider))],
      modelIds: [...new Set(all.map((entry) => entry.modelId))],
      workflowIds: [...new Set(all.map((entry) => entry.workflowId))],
      harnessVersions: [...new Set(all.map((entry) => entry.harnessVersion))],
    },
    kpis: {
      sampleSize: filtered.length,
      firstPassRate: filtered.length ? firstPassCount / filtered.length : null,
      avgRepairs: filtered.length
        ? filtered.reduce((sum, entry) => sum + entry.repairs, 0) / filtered.length
        : null,
      timeToApprovedMsP50: percentile(durations, 0.5),
      timeToApprovedMsP95: percentile(durations, 0.95),
      avgConfidence: confidences.length
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : null,
      costUsd: matchingMetrics.length ? totalCost : null,
      quotaUnits: matchingMetrics.length ? totalQuota : null,
    },
  });
});

app.get('/router/decisions', async (request) => {
  const query = RouterDashboardQuerySchema.parse(request.query);
  return { decisions: await runtime.decisionLog.list(query) };
});

app.get('/router/export', async (request, reply) => {
  const query = RouterDashboardQuerySchema.parse(request.query);
  const decisions = await runtime.decisionLog.list(query);
  reply.header('content-disposition', 'attachment; filename="router-decisions-export.json"');
  return { rows: decisions.map((entry) => DecisionExportRowSchema.parse(entry)) };
});

app.post('/router/regression-gate', async (request) => {
  const { fresh } = RegressionGateRequestSchema.parse(request.body);
  const baselinePath = resolve(REPO_ROOT, 'docs/baselines/v0.9-benchmark.json');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  return { result: compareBenchmarkReports(fresh, baseline) };
});

app.get('/experiments', async () => ({ experiments: await runtime.experiments.list() }));

app.post('/experiments', async (request, reply) => {
  const input = CreateExperimentRequestSchema.parse(request.body);
  const now = new Date().toISOString();
  const experiment = await runtime.experiments.create({
    schemaVersion: '1',
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    ...input,
  });
  return reply.status(201).send({ experiment });
});

app.get('/experiments/:id', async (request) => {
  const { id } = z.object({ id: PathSegmentSchema }).parse(request.params);
  const experiment = await runtime.experiments.get(id);
  if (!experiment) throw new NotFoundError(`experiment ${id} not found`);
  return { experiment };
});

app.patch('/experiments/:id', async (request) => {
  const { id } = z.object({ id: PathSegmentSchema }).parse(request.params);
  const input = UpdateExperimentRequestSchema.parse(request.body);
  const existing = await runtime.experiments.get(id);
  if (!existing) throw new NotFoundError(`experiment ${id} not found`);
  const experiment = await runtime.experiments.update({
    ...existing,
    ...input,
    updatedAt: new Date().toISOString(),
  });
  return { experiment };
});
```

Add the `percentile` helper and the two new imports (`resolve` from `node:path`, `readFile` from `node:fs/promises`, and a `REPO_ROOT` constant) near the top of `app.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// ...
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length));
  return sortedValues[index] ?? null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/api/src/router.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (3/3).

- [ ] **Step 6: Run the full API suite and typecheck**

Run: `npx vitest run apps/api --pool=threads --maxWorkers=1`
Expected: PASS (no regressions).

Run: `npx tsc -b --force --pretty false`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/api.ts apps/api/src/app.ts apps/api/src/router.test.ts
git commit -m "feat(api): add router dashboard, decisions, export, regression-gate, and experiments endpoints"
```

---

### Task 8: Web dashboard page

**Files:**

- Modify: `apps/web/lib/api.ts` (fetch wrappers)
- Create: `apps/web/app/router/dashboard-view.tsx` (presentational component + pure helpers — unit tested)
- Create: `apps/web/app/router/dashboard-view.test.tsx`
- Create: `apps/web/app/router/page.tsx` (route-level `'use client'` component: fetch + state wiring, no colocated unit test)
- Modify: `apps/web/app/globals.css` (new classes)

**Interfaces:**

- Consumes: `RouterDashboardResponse`, `RouterDecisionLogEntry`, `ExperimentRecord`, `CreateExperimentRequest` types from `@agent-foundry/contracts` (Task 1/7); `api<T>()` from `./api.js` (existing).
- Produces: `/router` route rendered by the app; `RouterDashboardView`, `RouterFilters`, `EMPTY_ROUTER_FILTERS`, `activeRouterQuery` — exercised by Task 10's e2e (via `page.tsx`) and this task's own unit test (via `dashboard-view.tsx` directly).

This codebase has no `@testing-library/react` dependency and vitest's environment is `'node'` (see `vitest.config.ts`), not `jsdom` — adding either would violate the plan's "no new dependency" constraint. The established convention (`apps/web/app/project/[id]/changes-panel.tsx` + `.test.tsx`, `knowledge-files.tsx` + `.test.tsx`) is: extract a **presentational** component that takes already-fetched data as props, unit-test it with `renderToStaticMarkup` from `react-dom/server` (already a dependency via `react-dom`), and leave the route-level `page.tsx` that does the `useEffect`/fetch wiring untested at the unit level — exactly like `apps/web/app/page.tsx` and `apps/web/app/project/[id]/page.tsx`, neither of which has a colocated test. The interactive, fetch-driven behavior is covered only by Task 10's Playwright e2e. Follow that split here.

- [ ] **Step 1: Add fetch wrappers to lib/api.ts**

Add near `getRuntime`:

```typescript
export function getRouterDashboard(
  query: Record<string, string>,
): Promise<RouterDashboardResponse> {
  const qs = new URLSearchParams(query).toString();
  return api<RouterDashboardResponse>(`/router/dashboard${qs ? `?${qs}` : ''}`);
}

export function listRouterDecisions(
  query: Record<string, string>,
): Promise<{ decisions: RouterDecisionLogEntry[] }> {
  const qs = new URLSearchParams(query).toString();
  return api<{ decisions: RouterDecisionLogEntry[] }>(`/router/decisions${qs ? `?${qs}` : ''}`);
}

export function listExperiments(): Promise<{ experiments: ExperimentRecord[] }> {
  return api<{ experiments: ExperimentRecord[] }>('/experiments');
}

export function createExperiment(input: CreateExperimentRequest): Promise<ExperimentRecord> {
  return api<{ experiment: ExperimentRecord }>('/experiments', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((response) => response.experiment);
}

export function routerExportUrl(query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return `${API_URL}/router/export${qs ? `?${qs}` : ''}`;
}
```

Add `CreateExperimentRequest`, `ExperimentRecord`, `RouterDashboardResponse`, `RouterDecisionLogEntry` to the existing `@agent-foundry/contracts` type-only import block at the top of the file.

- [ ] **Step 2: Write the failing test for the presentational component**

```tsx
// apps/web/app/router/dashboard-view.test.tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExperimentRecord, RouterDashboardResponse } from '@agent-foundry/contracts';
import { EMPTY_ROUTER_FILTERS, RouterDashboardView, activeRouterQuery } from './dashboard-view.js';

const dashboard: RouterDashboardResponse = {
  facets: {
    taskKinds: ['implementation'],
    providers: ['claude'],
    modelIds: ['opus'],
    workflowIds: ['golden-flow-e2e-v1'],
    harnessVersions: ['v3'],
  },
  kpis: {
    sampleSize: 1,
    firstPassRate: 1,
    avgRepairs: 0,
    timeToApprovedMsP50: 100,
    timeToApprovedMsP95: 100,
    avgConfidence: 0.8,
    costUsd: 0.02,
    quotaUnits: null,
  },
};

const experiment: ExperimentRecord = {
  schemaVersion: '1',
  id: 'exp-1',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
  hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
  variants: [
    { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
    { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
  ],
  population: { taskKinds: ['implementation'], targetSampleSize: 30 },
  stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
  status: 'draft',
};

describe('activeRouterQuery', () => {
  it('drops empty filter values', () => {
    expect(activeRouterQuery({ ...EMPTY_ROUTER_FILTERS, provider: 'claude' })).toEqual({
      provider: 'claude',
    });
  });

  it('returns an empty object when every filter is empty', () => {
    expect(activeRouterQuery(EMPTY_ROUTER_FILTERS)).toEqual({});
  });
});

describe('RouterDashboardView', () => {
  it('renders KPI tiles, filter options, and registered experiments', () => {
    const markup = renderToStaticMarkup(
      <RouterDashboardView
        filters={EMPTY_ROUTER_FILTERS}
        onFiltersChange={() => {}}
        dashboard={dashboard}
        decisions={[]}
        experiments={[experiment]}
        exportHref="http://localhost:4000/router/export"
        hypothesis=""
        onHypothesisChange={() => {}}
        onSubmitExperiment={() => {}}
      />,
    );

    expect(markup).toContain('Aprovação de primeira');
    expect(markup).toContain('Tempo até aprovação (p50)');
    expect(markup).toContain(experiment.hypothesis);
    expect(markup).toMatch(/<option[^>]*value="implementation"[^>]*>implementation<\/option>/);
    expect(markup).toContain('http://localhost:4000/router/export');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/web/app/router/dashboard-view.test.tsx --pool=threads --maxWorkers=1`
Expected: FAIL — module `./dashboard-view.js` not found.

- [ ] **Step 4: Implement the presentational component**

```tsx
// apps/web/app/router/dashboard-view.tsx
import type React from 'react';
import type {
  ExperimentRecord,
  RouterDashboardResponse,
  RouterDecisionLogEntry,
} from '@agent-foundry/contracts';

export interface RouterFilters {
  taskKind: string;
  provider: string;
  modelId: string;
  workflowId: string;
  harnessVersion: string;
}

export const EMPTY_ROUTER_FILTERS: RouterFilters = {
  taskKind: '',
  provider: '',
  modelId: '',
  workflowId: '',
  harnessVersion: '',
};

export function activeRouterQuery(filters: RouterFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''));
}

export function RouterDashboardView({
  filters,
  onFiltersChange,
  dashboard,
  decisions,
  experiments,
  exportHref,
  hypothesis,
  onHypothesisChange,
  onSubmitExperiment,
}: {
  filters: RouterFilters;
  onFiltersChange: (filters: RouterFilters) => void;
  dashboard: RouterDashboardResponse;
  decisions: RouterDecisionLogEntry[];
  experiments: ExperimentRecord[];
  exportHref: string;
  hypothesis: string;
  onHypothesisChange: (value: string) => void;
  onSubmitExperiment: (event: React.FormEvent) => void;
}) {
  return (
    <main className="shell routerDashboard">
      <h1>Dashboard do router</h1>

      <section className="panel filterBar">
        <label>
          Tarefa
          <select
            value={filters.taskKind}
            onChange={(event) => onFiltersChange({ ...filters, taskKind: event.target.value })}
          >
            <option value="">Todas</option>
            {dashboard.facets.taskKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select
            value={filters.provider}
            onChange={(event) => onFiltersChange({ ...filters, provider: event.target.value })}
          >
            <option value="">Todos</option>
            {dashboard.facets.providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select
            value={filters.modelId}
            onChange={(event) => onFiltersChange({ ...filters, modelId: event.target.value })}
          >
            <option value="">Todos</option>
            {dashboard.facets.modelIds.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Workflow
          <select
            value={filters.workflowId}
            onChange={(event) => onFiltersChange({ ...filters, workflowId: event.target.value })}
          >
            <option value="">Todos</option>
            {dashboard.facets.workflowIds.map((workflowId) => (
              <option key={workflowId} value={workflowId}>
                {workflowId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Versão do harness
          <select
            value={filters.harnessVersion}
            onChange={(event) =>
              onFiltersChange({ ...filters, harnessVersion: event.target.value })
            }
          >
            <option value="">Todas</option>
            {dashboard.facets.harnessVersions.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </label>
        <a className="primaryButton" href={exportHref} download>
          Exportar (sem PII)
        </a>
      </section>

      <section className="panel kpiGrid">
        <div className="kpiTile">
          <span>Tempo até aprovação (p50)</span>
          <strong>{dashboard.kpis.timeToApprovedMsP50 ?? '—'} ms</strong>
        </div>
        <div className="kpiTile">
          <span>Tempo até aprovação (p95)</span>
          <strong>{dashboard.kpis.timeToApprovedMsP95 ?? '—'} ms</strong>
        </div>
        <div className="kpiTile">
          <span>Aprovação de primeira</span>
          <strong>
            {dashboard.kpis.firstPassRate === null
              ? '—'
              : `${Math.round(dashboard.kpis.firstPassRate * 100)}%`}
          </strong>
        </div>
        <div className="kpiTile">
          <span>Reparos (média)</span>
          <strong>{dashboard.kpis.avgRepairs?.toFixed(2) ?? '—'}</strong>
        </div>
        <div className="kpiTile">
          <span>Custo (USD)</span>
          <strong>{dashboard.kpis.costUsd?.toFixed(4) ?? '—'}</strong>
        </div>
        <div className="kpiTile">
          <span>Confiança</span>
          <strong>
            {dashboard.kpis.avgConfidence === null
              ? '—'
              : `${Math.round(dashboard.kpis.avgConfidence * 100)}%`}
          </strong>
        </div>
      </section>

      <section className="panel">
        <h2>Decisões ({decisions.length})</h2>
        <ul className="artifactList">
          {decisions.map((decision) => (
            <li key={decision.id}>
              {decision.modelId} · {decision.taskKind} ·{' '}
              {decision.approved ? 'aprovado' : 'reprovado'} · {decision.repairs} reparo(s)
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Registro de experimentos</h2>
        <table className="experimentTable">
          <thead>
            <tr>
              <th>Hipótese</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {experiments.map((exp) => (
              <tr key={exp.id}>
                <td>{exp.hypothesis}</td>
                <td>{exp.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={onSubmitExperiment}>
          <label>
            Hipótese
            <textarea
              className="compactTextarea"
              value={hypothesis}
              onChange={(event) => onHypothesisChange(event.target.value)}
            />
          </label>
          <button type="submit" className="primaryButton">
            Registrar experimento
          </button>
        </form>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/web/app/router/dashboard-view.test.tsx --pool=threads --maxWorkers=1`
Expected: PASS.

- [ ] **Step 6: Implement the route-level page (fetch/state wiring, no colocated unit test — matches `apps/web/app/page.tsx` convention)**

```tsx
// apps/web/app/router/page.tsx
'use client';

import { useEffect, useState } from 'react';
import type {
  CreateExperimentRequest,
  ExperimentRecord,
  RouterDashboardResponse,
  RouterDecisionLogEntry,
} from '@agent-foundry/contracts';
import {
  createExperiment,
  getRouterDashboard,
  listExperiments,
  listRouterDecisions,
  routerExportUrl,
} from '../../lib/api.js';
import {
  activeRouterQuery,
  EMPTY_ROUTER_FILTERS,
  RouterDashboardView,
  type RouterFilters,
} from './dashboard-view.js';

const FIXED_VARIANTS: CreateExperimentRequest['variants'] = [
  { key: 'control', description: 'Controle', target: { kind: 'model', modelId: 'sonnet' } },
  { key: 'treatment', description: 'Tratamento', target: { kind: 'model', modelId: 'opus' } },
];

export default function RouterDashboardPage() {
  const [filters, setFilters] = useState<RouterFilters>(EMPTY_ROUTER_FILTERS);
  const [dashboard, setDashboard] = useState<RouterDashboardResponse | null>(null);
  const [decisions, setDecisions] = useState<RouterDecisionLogEntry[]>([]);
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([]);
  const [hypothesis, setHypothesis] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = activeRouterQuery(filters);
    void Promise.all([getRouterDashboard(query), listRouterDecisions(query), listExperiments()])
      .then(([dashboardResponse, decisionsResponse, experimentsResponse]) => {
        setDashboard(dashboardResponse);
        setDecisions(decisionsResponse.decisions);
        setExperiments(experimentsResponse.experiments);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [filters]);

  async function handleSubmitExperiment(event: React.FormEvent) {
    event.preventDefault();
    if (hypothesis.trim().length === 0) return;
    const experiment = await createExperiment({
      hypothesis,
      variants: FIXED_VARIANTS,
      population: { taskKinds: ['implementation'], targetSampleSize: 30 },
      stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
    });
    setExperiments((current) => [experiment, ...current]);
    setHypothesis('');
  }

  if (error) return <p className="error">{error}</p>;
  if (!dashboard) return <p>Carregando…</p>;

  return (
    <RouterDashboardView
      filters={filters}
      onFiltersChange={setFilters}
      dashboard={dashboard}
      decisions={decisions}
      experiments={experiments}
      exportHref={routerExportUrl(activeRouterQuery(filters))}
      hypothesis={hypothesis}
      onHypothesisChange={setHypothesis}
      onSubmitExperiment={handleSubmitExperiment}
    />
  );
}
```

- [ ] **Step 7: Add CSS classes to globals.css**

Append to `apps/web/app/globals.css`:

```css
.routerDashboard {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.filterBar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 16px;
}
.filterBar label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.kpiGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.kpiTile {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kpiTile span {
  font-size: 12px;
  color: var(--muted);
}
.kpiTile strong {
  font-size: 22px;
}
.experimentTable {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 16px;
}
.experimentTable th,
.experimentTable td {
  text-align: left;
  border-bottom: 1px solid var(--line);
  padding: 8px 6px;
}
```

- [ ] **Step 8: Run the full web unit-test suite, build, and typecheck**

Run: `npx vitest run apps/web --pool=threads --maxWorkers=1`
Expected: PASS (including the new `dashboard-view.test.tsx`; no regressions in sibling component tests).

Run: `npm run typecheck --workspace @agent-foundry/web`
Expected: no errors.

Run: `npm run build --workspace @agent-foundry/web`
Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/api.ts apps/web/app/router/dashboard-view.tsx apps/web/app/router/dashboard-view.test.tsx apps/web/app/router/page.tsx apps/web/app/globals.css
git commit -m "feat(web): add router dashboard and experiment registry page"
```

---

### Task 9: Regression gate CLI flag

**Files:**

- Modify: `scripts/benchmark.ts`

**Interfaces:**

- Consumes: `compareBenchmarkReports` (Task 4), existing `loadRecords()`/`resolveModels()` helpers already in the file.

This depends only on Task 4 and can run any time after it.

- [ ] **Step 1: Add the --gate branch**

Add a new import line (`compareBenchmarkReports` lives in `regression-gate.ts`, a sibling module to `benchmark-runner.ts` — do not add it to the existing `benchmark-runner.js` import, which stays as-is):

```typescript
import { compareBenchmarkReports } from '../packages/composition/src/regression-gate.js';
```

Add `readFile` to the existing `import { resolve } from 'node:path';`-style top-of-file imports:

```typescript
import { readFile } from 'node:fs/promises';
```

Add `BenchmarkReportSchema` to the existing `@agent-foundry/contracts` import line (alongside `BenchmarkRunRecordSchema`).

Add a new branch before the final `else` in the `try` block:

```typescript
  } else if (args.includes('--gate')) {
    const records = await loadRecords();
    const fresh = BenchmarkReportSchema.parse({
      schemaVersion: '1',
      createdAt: new Date().toISOString(),
      baselineRef: records[0]?.baselineRef ?? 'unknown',
      runs: records,
      limitations: [],
    });
    const baselineJsonPath = resolve(rootDir, 'docs/baselines/v0.9-benchmark.json');
    const baseline = BenchmarkReportSchema.parse(
      JSON.parse(await readFile(baselineJsonPath, 'utf8')),
    );
    const result = compareBenchmarkReports(fresh, baseline);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.verdict === 'fail' ? 1 : 0;
```

- [ ] **Step 2: Update the usage message**

Change the final `console.error('Usage: ...')` line to include `| --gate`.

- [ ] **Step 3: Verify manually**

Run: `npx tsx scripts/benchmark.ts --gate` (with at least one record in `.data/benchmark` and a frozen `docs/baselines/v0.9-benchmark.json` present — if neither exists yet, this is expected to fail cleanly with an ENOENT and exit 1; that's acceptable since freezing the v0.9 baseline is a separate, already-tracked follow-up).

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b --force --pretty false`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark.ts
git commit -m "feat(scripts): add --gate flag to run the regression gate against the frozen baseline"
```

---

### Task 10: E2E — extend golden-flow.spec.ts

**Files:**

- Modify: `apps/api/e2e/golden-flow.spec.ts`

**Interfaces:**

- Consumes: `runtime.decisionLog`, `runtime.experiments` (via the in-process `runtime` already available in the spec file), `apiBaseUrl`, `webBaseUrl` (existing spec-level variables).

This is the final task — it depends on Tasks 6, 7, and 8 all being merged.

- [ ] **Step 1: Add a new test after the existing golden-flow test(s)**

Insert a new top-level `test(...)` block in `apps/api/e2e/golden-flow.spec.ts`, after the existing tests, reusing the `projectId`/`run` produced by the existing flow (the file already drives a project through a repair loop, which is what appends decision-log rows via Task 6's instrumentation):

```typescript
test('router dashboard shows decisions and filters, and an experiment can be registered', async ({
  page,
}) => {
  const dashboardResponse = await fetch(`${apiBaseUrl}/router/dashboard`);
  expect(dashboardResponse.ok).toBe(true);
  const dashboard = (await dashboardResponse.json()) as {
    facets: { workflowIds: string[]; modelIds: string[] };
    kpis: { sampleSize: number };
  };
  expect(dashboard.facets.workflowIds.length).toBeGreaterThan(0);
  expect(dashboard.kpis.sampleSize).toBeGreaterThan(0);

  await page.goto(`${webBaseUrl}/router`);
  await expect(page.getByRole('heading', { name: 'Dashboard do router' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Aprovação de primeira')).toBeVisible();
  await expect(page.getByLabelText('Tarefa')).toBeVisible();

  const hypothesis = `E2E hypothesis ${Date.now()}`;
  await page.getByLabel('Hipótese').fill(hypothesis);
  await page.getByRole('button', { name: 'Registrar experimento' }).click();
  await expect(page.getByText(hypothesis)).toBeVisible({ timeout: 10_000 });

  const exportResponse = await fetch(`${apiBaseUrl}/router/export`);
  expect(exportResponse.ok).toBe(true);
  const { rows } = (await exportResponse.json()) as { rows: Record<string, unknown>[] };
  for (const row of rows) {
    expect(row).not.toHaveProperty('projectId');
    expect(row).not.toHaveProperty('runId');
  }
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `npm run e2e --workspace @agent-foundry/api -- --grep "router dashboard"`
Expected: PASS.

- [ ] **Step 3: Run the full golden-flow suite to confirm no regressions**

Run: `npm run e2e --workspace @agent-foundry/api`
Expected: PASS (all existing golden-flow tests plus the new one).

- [ ] **Step 4: Commit**

```bash
git add apps/api/e2e/golden-flow.spec.ts
git commit -m "test(e2e): extend golden-flow with router dashboard, experiment registration, and PII-free export"
```

---

## Final Verification

- [ ] Run the full local gate: `npm run check` (format:check, lint, architecture:check, roadmap:check, typecheck, test, build, secrets:check) — must pass clean.
- [ ] Run the e2e suite once more standalone: `npm run e2e --workspace @agent-foundry/api`.
- [ ] Confirm every acceptance criterion from issue #67:
  - Filters by task/provider/model/workflow/harness — `RouterDashboardQuerySchema` + facet lists in the web page.
  - Time-to-approved/first-pass/repairs/cost-quota/confidence — KPI tiles in `/router`.
  - Experiment registers hypothesis/variants/population/stop rule — `ExperimentRecordSchema` + registry panel.
  - Regression gate compares fresh vs frozen baseline before promotion — `compareBenchmarkReports` + `--gate` CLI + `POST /router/regression-gate`.
  - Export without PII — `GET /router/export` + `DecisionExportRowSchema`.
- [ ] Attach evidence to the PR: `npm run check` output, the e2e run output/trace, and a screenshot of the `/router` page (via a manual `npm run dev` session or the Playwright trace viewer).
