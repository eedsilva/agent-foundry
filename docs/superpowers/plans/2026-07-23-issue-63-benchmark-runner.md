# Benchmark Corpus & Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, versioned benchmark corpus (6 task kinds: greenfield, existing-repo, bug, refactor, review, security-sensitive) and a runner that executes each case through the real product pipeline against multiple pinned models, producing append-only, commit-comparable result artifacts.

**Architecture:** Reuse, don't reinvent. The dogfood pipeline (`packages/composition/src/dogfood.ts`) already drives a task through `ProjectService.create` → worker → declarative workflow and writes sanitized, append-only run records; the provider-canary/dogfood baseline-freeze pattern (`baseline-publish.ts`) already produces commit-comparable JSON+MD artifact pairs; the model-override mechanism (`ProjectService.createModelOverride`, scope `{kind:'run'}`) already lets a caller pin an exact catalog model for a run, bypassing router scoring. The benchmark runner is a thin new layer: a `BenchmarkCase` contract (a `DogfoodTask` plus a `kind` classifier and `expectedSignals`), a `runBenchmarkCase(case, model, options)` that calls the (lightly extended) `runDogfoodTask` with a model override, and a `freezeBenchmarkReport` that gates on all 6 kinds being present before publishing `docs/baselines/v0.9-benchmark.{json,md}`.

**Tech Stack:** TypeScript, Zod v4, Vitest, npm workspaces, existing `@agent-foundry/{contracts,domain,composition,model-router,persistence}` packages.

## Global Constraints

- Node >= 20 (`.nvmrc` = 22). npm workspaces monorepo — no new external dependencies.
- All new Zod schemas end with `.strict()`, following existing convention in `packages/contracts/src`.
- Task prompts and corpus fixture content are written in Portuguese (pt-BR), matching every existing `examples/dogfood/tasks/*.json` prompt.
- `.data/` is gitignored — benchmark run records must live under `.data/benchmark/`, never committed.
- No new GitHub Actions secrets or credential plumbing: the provider CLIs (`codex`/`claude`/`agy`) authenticate via local subscription login, not env API keys (verified: no `*_API_KEY` env vars referenced anywhere in `packages/executors/src` or `scripts/doctor.mjs`). A GitHub-hosted cron job would always report "no provider ready" and is explicitly out of scope — see Task 6 (ADR) for the reasoning. The "expensive suite" is invoked manually or via the operator's own externally-scheduled cron, exactly like `dogfood:run`/`canary:providers` today.
- Real-mode execution stays opt-in behind `RUN_REAL_BENCHMARK=true`, mirroring `RUN_REAL_DOGFOOD`/`RUN_REAL_PROVIDER_CANARIES`.
- Benchmark cases pin `baselineRef: "56568a3"` (this repo's current `main` tip at plan-authoring time) — a real, permanent commit that already contains every file the corpus fixtures reference (`packages/domain/src/{utils,redaction}.ts`, `packages/model-router/src/score-router.ts`).
- `npm test` already runs every `*.test.ts` file with no CI YAML changes required — new Vitest suites become "the fast CI suite" automatically. Do not add or edit `.github/workflows/*.yml`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/benchmark.ts` (new) | `BenchmarkCaseKindSchema`, `BenchmarkCaseSchema`, `BenchmarkRunRecordSchema`, `BenchmarkReportSchema` |
| `packages/contracts/src/benchmark.test.ts` (new) | Schema round-trip tests |
| `packages/contracts/src/index.ts` (modify) | Export the new module |
| `packages/composition/src/dogfood.ts` (modify) | Add optional `modelOverride` to `RunDogfoodTaskOptions`; apply it via `createModelOverride` before the worker runs |
| `packages/composition/src/dogfood.test.ts` (modify) | Cover the new override option |
| `benchmarks/cases/*.json` (new, ×6) | The versioned corpus: one fixture per `BenchmarkCaseKind` |
| `packages/composition/src/benchmark-runner.ts` (new) | `loadBenchmarkCases`, `runBenchmarkCase`, `freezeBenchmarkReport`, `renderBenchmarkMarkdown` |
| `packages/composition/src/benchmark-runner.test.ts` (new) | Real-corpus schema validation + synthetic mock-mode override/rerun-comparability test |
| `packages/composition/src/index.ts` (modify) | Export the new module |
| `scripts/benchmark.ts` (new) | CLI: `--case <id> --model <modelId> | --all [--models a,b] | --freeze` |
| `package.json` (modify) | Add `benchmark:run` / `benchmark:freeze` scripts |
| `docs/adr/0029-benchmark-corpus-and-runner.md` (new) | Durable design record, including why no GH Actions cron job was added |

---

### Task 1: Model override support in `runDogfoodTask`

**Files:**
- Modify: `packages/composition/src/dogfood.ts:34-40` (the `RunDogfoodTaskOptions` interface and the start of `runDogfoodTask`)
- Test: `packages/composition/src/dogfood.test.ts`

**Interfaces:**
- Consumes: `ProjectService.createModelOverride(runId, CreateModelOverrideRequest): Promise<ModelOverrideRecord>` (already exists, `packages/orchestrator/src/project-service.ts:88`). `ModelOverrideScopeSchema` discriminated union with `{kind:'run'}` (already exists, `packages/contracts/src/model.ts:142`).
- Produces: `RunDogfoodTaskOptions.modelOverride?: { modelId: string; provider: Provider; model: string; reason: string; estimatedImpact: string }` — Task 4's `runBenchmarkCase` passes this to pin a catalog model per run.

- [ ] **Step 1: Write the failing test**

Open `packages/composition/src/dogfood.test.ts`. Find the `describe('runDogfoodTask (mock mode)', ...)` block (it already contains a `sharedMiniFixture()` + `miniTask()` pattern used by the existing passing-mock-task test). Add a new test right after the first `it('runs a mock mini-task and writes an append-only record with copied files and a patch', ...)` test:

```typescript
  it('honors a run-scoped modelOverride and records the pinned model as executed', async () => {
    const fixture = await sharedMiniFixture();
    const dataDir = await tempDir('dogfood-data-');
    const task = miniTask({
      id: 'mini-override',
      baselineRef: fixture.sha,
      verifyScript: 'node -e "process.exit(0)"',
    });

    // ProjectService.createModelOverride validates the override tuple against
    // the *interpolated* models/catalog.yaml entry (packages/orchestrator/src/
    // project-service.ts resolveCatalogModel: it throws unless
    // catalog.model === override.model exactly). The catalog's codex-default
    // entry reads `model: '${CODEX_DEFAULT_MODEL:-}'`, which resolves to an
    // empty string unless that env var is set — so the test must set it to
    // the exact value it overrides with, then restore it.
    const previousCodexModel = process.env.CODEX_DEFAULT_MODEL;
    process.env.CODEX_DEFAULT_MODEL = 'benchmark-test-model';
    try {
      const record = await runDogfoodTask(task, {
        executorMode: 'mock',
        repoRoot: fixture.path,
        dataDir,
        modelOverride: {
          modelId: 'codex-default',
          provider: 'codex',
          model: 'benchmark-test-model',
          reason: 'dogfood.test.ts modelOverride coverage',
          estimatedImpact: 'Test only — pins a fixed model for a deterministic assertion',
        },
      });

      expect(record.status).toBe('passed');
      expect(record.route?.executed?.model?.provider).toBe('codex');
      expect(record.route?.executed?.model?.model).toBe('benchmark-test-model');
      expect(record.executedModel).toBe('mock:codex/benchmark-test-model');
    } finally {
      if (previousCodexModel === undefined) delete process.env.CODEX_DEFAULT_MODEL;
      else process.env.CODEX_DEFAULT_MODEL = previousCodexModel;
    }
  }, 60_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/composition/src/dogfood.test.ts -t "honors a run-scoped modelOverride" --pool=threads --maxWorkers=1`
Expected: FAIL — `modelOverride` does not exist on type `RunDogfoodTaskOptions` (TypeScript error) or, if TS is not enforced at test time, a runtime `TypeError`/mismatch because the option is silently ignored and `record.route?.executed?.model?.model` is not `'benchmark-test-model'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/composition/src/dogfood.ts`, update the imports to include `Provider`:

```typescript
import {
  DogfoodReportSchema,
  DogfoodRunRecordSchema,
  DogfoodTaskSchema,
  VerificationReportSchema,
  type DogfoodHumanEdit,
  type DogfoodReport,
  type DogfoodRunRecord,
  type DogfoodTask,
  type ExecutionUsage,
  type Provider,
  type RouteDecision,
  type StepAttempt,
  type StepRun,
  type VerificationReport,
} from '@agent-foundry/contracts';
```

Update `RunDogfoodTaskOptions`:

```typescript
export interface RunDogfoodTaskOptions {
  repoRoot: string;
  dataDir?: string;
  executorMode?: 'real' | 'mock';
  modelOverride?: {
    modelId: string;
    provider: Provider;
    model: string;
    reason: string;
    estimatedImpact: string;
  };
}
```

Inside `runDogfoodTask`, find this block (right after `projectId = project.id;` / `runId = project.currentRunId ?? '';` / `const workspacePath = ...` and the `seedWorkspace(...)` call, and right before `await runtime.worker.runOnce();`):

```typescript
    const baseline = await seedWorkspace(workspacePath, task, options.repoRoot);

    await runtime.worker.runOnce();
```

Insert the override application between the two:

```typescript
    const baseline = await seedWorkspace(workspacePath, task, options.repoRoot);

    if (options.modelOverride) {
      await runtime.projectService.createModelOverride(runId, {
        scope: { kind: 'run' },
        modelId: options.modelOverride.modelId,
        provider: options.modelOverride.provider,
        model: options.modelOverride.model,
        actor: { kind: 'system', id: 'benchmark-runner' },
        reason: options.modelOverride.reason,
        estimatedImpact: options.modelOverride.estimatedImpact,
      });
    }

    await runtime.worker.runOnce();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/composition/src/dogfood.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (all existing dogfood tests plus the new one — 16 tests total in this file).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/composition`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/composition/src/dogfood.ts packages/composition/src/dogfood.test.ts
git commit -m "feat(dogfood): support a run-scoped model override in runDogfoodTask"
```

---

### Task 2: Benchmark contracts

**Files:**
- Create: `packages/contracts/src/benchmark.ts`
- Test: `packages/contracts/src/benchmark.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `DogfoodTaskSchema`, `DogfoodRunRecordSchema` from `./dogfood.js` (same package, already defined).
- Produces: `BenchmarkCaseKindSchema` (6-member enum), `BenchmarkCase` type (`id`, `title`, `workflowId`, `prompt`, `baselineRef`, `allowedFiles`, `seedFiles`, `verifyScript?`, `kind`, `expectedSignals`), `BenchmarkRunRecord` type (`caseId`, `caseKind`, `modelId`, plus the run-outcome fields from `DogfoodRunRecord` minus `taskId`/`issueRef`/`humanEdit`), `BenchmarkReport` type. Task 3's fixtures validate against `BenchmarkCaseSchema`; Task 4's runner produces `BenchmarkRunRecordSchema`-shaped records and `BenchmarkReportSchema`-shaped frozen reports.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/benchmark.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CASE_KINDS,
  BenchmarkCaseSchema,
  BenchmarkReportSchema,
  BenchmarkRunRecordSchema,
} from './benchmark.js';

function validCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sample-case',
    title: 'Sample case',
    workflowId: 'dogfood-task-v1',
    prompt: 'x'.repeat(60),
    baselineRef: '56568a3',
    allowedFiles: ['packages/domain/src/sample.ts'],
    seedFiles: [],
    kind: 'greenfield',
    expectedSignals: ['creates the file'],
    ...overrides,
  };
}

function validRunRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    caseId: 'sample-case',
    caseKind: 'greenfield',
    modelId: 'codex-default',
    attempt: 1,
    baselineRef: '56568a3',
    projectId: 'project-1',
    runId: 'run-1',
    startedAt: '2026-07-23T00:00:00.000Z',
    status: 'passed',
    durationMs: 100,
    checks: [],
    repairs: { iterations: 1, repairEvents: 0 },
    ...overrides,
  };
}

describe('BENCHMARK_CASE_KINDS', () => {
  it('lists all six required corpus kinds', () => {
    expect(BENCHMARK_CASE_KINDS).toEqual([
      'greenfield',
      'existing-repo',
      'bug',
      'refactor',
      'review',
      'security-sensitive',
    ]);
  });
});

describe('BenchmarkCaseSchema', () => {
  it('parses a valid case', () => {
    expect(() => BenchmarkCaseSchema.parse(validCase())).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => BenchmarkCaseSchema.parse(validCase({ kind: 'unknown' }))).toThrow();
  });

  it('rejects a case with no expected signals', () => {
    expect(() => BenchmarkCaseSchema.parse(validCase({ expectedSignals: [] }))).toThrow();
  });

  it('rejects an issueRef field carried over from DogfoodTask', () => {
    expect(() =>
      BenchmarkCaseSchema.parse(validCase({ issueRef: 'eedsilva/agent-foundry#63' })),
    ).toThrow();
  });
});

describe('BenchmarkRunRecordSchema', () => {
  it('parses a valid run record', () => {
    expect(() => BenchmarkRunRecordSchema.parse(validRunRecord())).not.toThrow();
  });

  it('rejects a record missing modelId', () => {
    const { modelId: _modelId, ...withoutModelId } = validRunRecord();
    expect(() => BenchmarkRunRecordSchema.parse(withoutModelId)).toThrow();
  });
});

describe('BenchmarkReportSchema', () => {
  it('parses a report with at least one run', () => {
    const report = {
      schemaVersion: '1',
      createdAt: '2026-07-23T00:00:00.000Z',
      baselineRef: '56568a3',
      runs: [validRunRecord()],
      limitations: ['example limitation'],
    };
    expect(() => BenchmarkReportSchema.parse(report)).not.toThrow();
  });

  it('rejects an empty runs array', () => {
    const report = {
      schemaVersion: '1',
      createdAt: '2026-07-23T00:00:00.000Z',
      baselineRef: '56568a3',
      runs: [],
      limitations: [],
    };
    expect(() => BenchmarkReportSchema.parse(report)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/benchmark.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `Cannot find module './benchmark.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/contracts/src/benchmark.ts`:

```typescript
import { z } from 'zod';
import { DogfoodRunRecordSchema, DogfoodTaskSchema } from './dogfood.js';

export const BenchmarkCaseKindSchema = z.enum([
  'greenfield',
  'existing-repo',
  'bug',
  'refactor',
  'review',
  'security-sensitive',
]);
export type BenchmarkCaseKind = z.infer<typeof BenchmarkCaseKindSchema>;
export const BENCHMARK_CASE_KINDS = BenchmarkCaseKindSchema.options;

// A benchmark case is a DogfoodTask (input + repo commit + policy via
// allowedFiles + checks via verifyScript) plus the two fields the v0.9
// benchmark runner needs on top: which corpus kind it represents and what a
// human reviewer should expect to see in a passing run.
export const BenchmarkCaseSchema = DogfoodTaskSchema.omit({ issueRef: true })
  .extend({
    kind: BenchmarkCaseKindSchema,
    expectedSignals: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

export const BenchmarkRunRecordSchema = DogfoodRunRecordSchema.omit({
  taskId: true,
  issueRef: true,
  humanEdit: true,
})
  .extend({
    caseId: z.string().min(1),
    caseKind: BenchmarkCaseKindSchema,
    modelId: z.string().min(1),
  })
  .strict();
export type BenchmarkRunRecord = z.infer<typeof BenchmarkRunRecordSchema>;

export const BenchmarkReportSchema = z
  .object({
    schemaVersion: z.literal('1'),
    createdAt: z.string().datetime(),
    baselineRef: z.string(),
    runs: z.array(BenchmarkRunRecordSchema).min(1),
    limitations: z.array(z.string()),
  })
  .strict();
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;
```

Add the export to `packages/contracts/src/index.ts`, alphabetically near the other domain modules (after the `agent.js` export, before `canary.js`, matching the existing ordering style):

```typescript
export * from './benchmark.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/benchmark.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck the whole contracts package**

Run: `npm run typecheck --workspace @agent-foundry/contracts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/benchmark.ts packages/contracts/src/benchmark.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add BenchmarkCase, BenchmarkRunRecord, BenchmarkReport schemas"
```

---

### Task 3: Benchmark corpus fixtures

**Files:**
- Create: `benchmarks/cases/greenfield-clamp-util.json`
- Create: `benchmarks/cases/existing-repo-truncate.json`
- Create: `benchmarks/cases/bug-version-compare.json`
- Create: `benchmarks/cases/refactor-formatters.json`
- Create: `benchmarks/cases/review-score-router.json`
- Create: `benchmarks/cases/security-redaction-google-api-key.json`

**Interfaces:**
- Consumes: `BenchmarkCaseSchema` shape from Task 2 (`id`, `title`, `workflowId`, `prompt`, `baselineRef`, `allowedFiles`, `seedFiles`, `verifyScript?`, `kind`, `expectedSignals`).
- Produces: the corpus directory `benchmarks/cases/` that Task 4's `loadBenchmarkCases('benchmarks/cases')` reads and validates.

This task is data-only (no application code), so there is no red/green TDD cycle here — the validation happens in Task 4's test (`benchmark-runner.test.ts` parses every file in this directory against `BenchmarkCaseSchema`). Each JSON file must be valid JSON and satisfy the schema; that is checked by running Task 4's test after this task's files exist. Create all six files now:

- [ ] **Step 1: `benchmarks/cases/greenfield-clamp-util.json`**

```json
{
  "id": "greenfield-clamp-util",
  "title": "Utilitário clamp em packages/domain",
  "kind": "greenfield",
  "workflowId": "dogfood-task-v1",
  "baselineRef": "56568a3",
  "allowedFiles": ["packages/domain/src/clamp.ts", "packages/domain/src/index.ts"],
  "seedFiles": [
    {
      "path": "packages/domain/src/clamp.test.ts",
      "content": "import { describe, expect, it } from 'vitest';\nimport { clamp } from './clamp.js';\n\ndescribe('clamp', () => {\n  it('returns the value unchanged when inside the range', () => {\n    expect(clamp(5, 0, 10)).toBe(5);\n  });\n\n  it('returns min when the value is below the range', () => {\n    expect(clamp(-3, 0, 10)).toBe(0);\n  });\n\n  it('returns max when the value is above the range', () => {\n    expect(clamp(42, 0, 10)).toBe(10);\n  });\n\n  it('throws when min is greater than max', () => {\n    expect(() => clamp(5, 10, 0)).toThrow();\n  });\n});\n"
    }
  ],
  "verifyScript": "vitest run packages/domain/src/clamp.test.ts --pool=threads --maxWorkers=1",
  "prompt": "# Tarefa: utilitário clamp em packages/domain\n\nEste é o monorepo agent-foundry (TypeScript, npm workspaces, Node >=20). O pacote packages/domain/src contém tipos e lógica de domínio puros, sem I/O. packages/domain/src/index.ts reexporta cada módulo com export * from './arquivo.js'.\n\n## Entregável\n\nCrie o arquivo NOVO packages/domain/src/clamp.ts, exportando:\n\n- clamp(value: number, min: number, max: number): number — retorna value se estiver dentro do intervalo [min, max]; retorna min se value for menor que min; retorna max se value for maior que max. Se min for maior que max, lance um Error.\n\nExporte o novo módulo a partir de packages/domain/src/index.ts, seguindo o padrão já usado nesse arquivo (export * from './clamp.js';).\n\nUm arquivo de teste já foi semeado no workspace em packages/domain/src/clamp.test.ts — NÃO o modifique. Ele define o contrato exato esperado.\n\n## Arquivos permitidos (allowlist)\n\nSó é permitido criar ou modificar:\n- packages/domain/src/clamp.ts\n- packages/domain/src/index.ts\n\nQualquer alteração fora dessa lista reprova a tarefa, mesmo que os testes passem.\n\n## Verificação\n\nO comando npm run dogfood:verify deve passar antes de finalizar. Ele executa vitest run packages/domain/src/clamp.test.ts --pool=threads --maxWorkers=1 sobre o teste semeado.\n",
  "expectedSignals": [
    "cria clamp.ts do zero, sem depender de código pré-existente",
    "exporta clamp a partir de index.ts",
    "não modifica nenhum arquivo fora da allowlist"
  ]
}
```

- [ ] **Step 2: `benchmarks/cases/existing-repo-truncate.json`**

```json
{
  "id": "existing-repo-truncate",
  "title": "truncateWithEllipsis em packages/domain/src/utils.ts",
  "kind": "existing-repo",
  "workflowId": "dogfood-task-v1",
  "baselineRef": "56568a3",
  "allowedFiles": ["packages/domain/src/utils.ts"],
  "seedFiles": [
    {
      "path": "packages/domain/src/utils-truncate.test.ts",
      "content": "import { describe, expect, it } from 'vitest';\nimport { truncateWithEllipsis } from './utils.js';\n\ndescribe('truncateWithEllipsis', () => {\n  it('returns the original string unchanged when it already fits', () => {\n    expect(truncateWithEllipsis('hello', 10)).toBe('hello');\n  });\n\n  it('returns exactly maxLength characters, ending in an ellipsis, when longer than maxLength', () => {\n    const result = truncateWithEllipsis('hello world', 8);\n    expect(result).toHaveLength(8);\n    expect(result.endsWith('\\u2026')).toBe(true);\n    expect(result.startsWith('hello')).toBe(true);\n  });\n\n  it('treats a string exactly at maxLength as fitting (no truncation)', () => {\n    expect(truncateWithEllipsis('exact', 5)).toBe('exact');\n  });\n\n  it('throws when maxLength is less than 1', () => {\n    expect(() => truncateWithEllipsis('x', 0)).toThrow();\n  });\n});\n"
    }
  ],
  "verifyScript": "vitest run packages/domain/src/utils-truncate.test.ts --pool=threads --maxWorkers=1",
  "prompt": "# Tarefa: truncateWithEllipsis em packages/domain/src/utils.ts\n\nEste é o monorepo agent-foundry. O arquivo packages/domain/src/utils.ts já existe e exporta várias funções puras (getValueAtPath, estimateTokens, errorMessage, toExecutionResult, stableJson). Leia o arquivo real antes de editar.\n\n## Entregável\n\nAdicione UMA nova função exportada a packages/domain/src/utils.ts, sem remover ou alterar o comportamento das funções existentes:\n\n- truncateWithEllipsis(text: string, maxLength: number): string — se text.length for menor ou igual a maxLength, retorna text sem alterações. Caso contrário, retorna os primeiros (maxLength - 1) caracteres de text seguidos do caractere de reticências '\\u2026' (um único caractere Unicode, não três pontos), de modo que o resultado tenha exatamente maxLength caracteres. Se maxLength for menor que 1, lance um Error.\n\nUm arquivo de teste já foi semeado no workspace em packages/domain/src/utils-truncate.test.ts — NÃO o modifique. Ele define o contrato exato esperado.\n\n## Arquivos permitidos (allowlist)\n\nSó é permitido criar ou modificar:\n- packages/domain/src/utils.ts\n\nQualquer alteração fora dessa lista reprova a tarefa, mesmo que os testes passem.\n\n## Verificação\n\nO comando npm run dogfood:verify deve passar antes de finalizar. Ele executa vitest run packages/domain/src/utils-truncate.test.ts --pool=threads --maxWorkers=1 sobre o teste semeado.\n",
  "expectedSignals": [
    "estende utils.ts existente sem remover ou quebrar as funções já exportadas",
    "trata o caso de borda maxLength < 1",
    "não cria arquivos novos nem toca em utils.test.ts"
  ]
}
```

- [ ] **Step 3: `benchmarks/cases/bug-version-compare.json`**

```json
{
  "id": "bug-version-compare",
  "title": "Bug de comparação de versões semânticas",
  "kind": "bug",
  "workflowId": "dogfood-task-v1",
  "baselineRef": "56568a3",
  "allowedFiles": ["packages/domain/src/version-compare.ts"],
  "seedFiles": [
    {
      "path": "packages/domain/src/version-compare.ts",
      "content": "export function compareVersions(a: string, b: string): number {\n  const majorA = Number(a.split('.')[0]);\n  const majorB = Number(b.split('.')[0]);\n  if (majorA !== majorB) return majorA - majorB;\n  return 0;\n}\n"
    },
    {
      "path": "packages/domain/src/version-compare.test.ts",
      "content": "import { describe, expect, it } from 'vitest';\nimport { compareVersions } from './version-compare.js';\n\ndescribe('compareVersions', () => {\n  it('returns 0 for identical versions', () => {\n    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);\n  });\n\n  it('returns a negative number when the first major version is lower', () => {\n    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);\n  });\n\n  it('returns a positive number when the first major version is higher', () => {\n    expect(compareVersions('3.0.0', '1.0.0')).toBeGreaterThan(0);\n  });\n\n  it('compares minor versions when major versions are equal', () => {\n    expect(compareVersions('1.1.0', '1.2.0')).toBeLessThan(0);\n    expect(compareVersions('1.5.0', '1.2.0')).toBeGreaterThan(0);\n  });\n\n  it('compares patch versions when major and minor versions are equal', () => {\n    expect(compareVersions('1.2.1', '1.2.9')).toBeLessThan(0);\n    expect(compareVersions('1.2.9', '1.2.1')).toBeGreaterThan(0);\n  });\n});\n"
    }
  ],
  "verifyScript": "vitest run packages/domain/src/version-compare.test.ts --pool=threads --maxWorkers=1",
  "prompt": "# Tarefa: corrigir bug de comparação de versões semânticas\n\nEste é o monorepo agent-foundry. O arquivo packages/domain/src/version-compare.ts já existe no workspace com uma implementação incompleta de compareVersions(a: string, b: string): number — ela só compara o segmento major de cada versão e retorna 0 sempre que os majors são iguais, ignorando minor e patch. Isso é o bug.\n\n## Entregável\n\nCorrija packages/domain/src/version-compare.ts para que compareVersions compare corretamente os três segmentos (major.minor.patch), nessa ordem de prioridade: se major difere, retorna majorA - majorB; senão, se minor difere, retorna minorA - minorB; senão, retorna patchA - patchB (0 quando as três partes são iguais). Mantenha a assinatura exata da função.\n\nUm arquivo de teste já foi semeado no workspace em packages/domain/src/version-compare.test.ts — NÃO o modifique. Ele expõe o bug (os dois últimos casos de teste falham com a implementação atual) e define o contrato exato esperado após a correção.\n\n## Arquivos permitidos (allowlist)\n\nSó é permitido criar ou modificar:\n- packages/domain/src/version-compare.ts\n\nQualquer alteração fora dessa lista reprova a tarefa, mesmo que os testes passem.\n\n## Verificação\n\nO comando npm run dogfood:verify deve passar antes de finalizar. Ele executa vitest run packages/domain/src/version-compare.test.ts --pool=threads --maxWorkers=1 sobre o teste semeado.\n",
  "expectedSignals": [
    "identifica que o bug está na comparação de minor/patch, não apenas no major",
    "corrige compareVersions sem alterar sua assinatura",
    "não modifica version-compare.test.ts"
  ]
}
```

- [ ] **Step 4: `benchmarks/cases/refactor-formatters.json`**

```json
{
  "id": "refactor-formatters",
  "title": "Remover duplicação em packages/domain/src/formatters.ts",
  "kind": "refactor",
  "workflowId": "dogfood-task-v1",
  "baselineRef": "56568a3",
  "allowedFiles": ["packages/domain/src/formatters.ts"],
  "seedFiles": [
    {
      "path": "packages/domain/src/formatters.ts",
      "content": "export function formatBytes(bytes: number): string {\n  const rounded = Math.round(bytes * 100) / 100;\n  return `${rounded} B`;\n}\n\nexport function formatDuration(ms: number): string {\n  const seconds = ms / 1000;\n  const rounded = Math.round(seconds * 100) / 100;\n  return `${rounded} s`;\n}\n"
    },
    {
      "path": "packages/domain/src/formatters.test.ts",
      "content": "import { describe, expect, it } from 'vitest';\nimport { formatBytes, formatDuration } from './formatters.js';\n\ndescribe('formatBytes', () => {\n  it('rounds to two decimal places and appends the unit', () => {\n    expect(formatBytes(1024.4567)).toBe('1024.46 B');\n  });\n\n  it('formats a whole number without unnecessary decimals', () => {\n    expect(formatBytes(2048)).toBe('2048 B');\n  });\n});\n\ndescribe('formatDuration', () => {\n  it('converts milliseconds to seconds, rounded to two decimal places', () => {\n    expect(formatDuration(1234)).toBe('1.23 s');\n  });\n\n  it('formats a whole number of seconds without unnecessary decimals', () => {\n    expect(formatDuration(5000)).toBe('5 s');\n  });\n});\n"
    }
  ],
  "verifyScript": "vitest run packages/domain/src/formatters.test.ts --pool=threads --maxWorkers=1",
  "prompt": "# Tarefa: remover duplicação em packages/domain/src/formatters.ts\n\nEste é o monorepo agent-foundry. O arquivo packages/domain/src/formatters.ts já existe no workspace e exporta formatBytes e formatDuration. Ambas as funções repetem a mesma lógica de arredondamento (Math.round(valor * 100) / 100).\n\n## Entregável\n\nRefatore packages/domain/src/formatters.ts extraindo essa lógica duplicada para uma função auxiliar não exportada roundToPrecision(value: number, precision: number): number (arredonda value para precision casas decimais: Math.round(value * 10**precision) / 10**precision). formatBytes e formatDuration devem passar a usar essa função auxiliar, mantendo exatamente o mesmo comportamento observável (as mesmas strings de saída para as mesmas entradas) e a mesma assinatura pública.\n\nUm arquivo de teste já foi semeado no workspace em packages/domain/src/formatters.test.ts — NÃO o modifique. Ele cobre o comportamento público de formatBytes e formatDuration e deve continuar passando sem alterações após a refatoração.\n\n## Arquivos permitidos (allowlist)\n\nSó é permitido criar ou modificar:\n- packages/domain/src/formatters.ts\n\nQualquer alteração fora dessa lista reprova a tarefa, mesmo que os testes passem.\n\n## Verificação\n\nO comando npm run dogfood:verify deve passar antes de finalizar. Ele executa vitest run packages/domain/src/formatters.test.ts --pool=threads --maxWorkers=1 sobre o teste semeado.\n",
  "expectedSignals": [
    "extrai a lógica de arredondamento duplicada para um único helper",
    "preserva o comportamento observável (os testes semeados continuam passando sem alteração)",
    "não altera a assinatura pública de formatBytes/formatDuration"
  ]
}
```

- [ ] **Step 5: `benchmarks/cases/review-score-router.json`**

```json
{
  "id": "review-score-router",
  "title": "Revisão de código: packages/model-router/src/score-router.ts",
  "kind": "review",
  "workflowId": "dogfood-plan-v1",
  "baselineRef": "56568a3",
  "allowedFiles": [],
  "seedFiles": [],
  "prompt": "# Tarefa: revisão de código (issue de benchmark #63)\n\nEste é o monorepo agent-foundry. O arquivo packages/model-router/src/score-router.ts implementa o roteador de modelos baseado em score (seleção de candidato do catálogo por tarefa).\n\n## Entregável\n\nEsta é uma tarefa de **revisão de código, sem alteração de código**. Leia packages/model-router/src/score-router.ts (o arquivo real, não suponha o conteúdo) e produza um artefato de revisão estruturado contendo:\n\n1. Pelo menos um risco de correção ou edge case que o código atual não trata claramente (cite a função e o trecho relevante).\n2. Pelo menos uma sugestão concreta de simplificação ou remoção de complexidade desnecessária.\n3. Uma nota geral de aprovação: 'aprovar', 'aprovar com ressalvas' ou 'solicitar mudanças', com uma frase justificando a nota.\n\n## Arquivos permitidos (allowlist)\n\nNenhum arquivo do workspace pode ser criado ou modificado (allowedFiles vazio nesta tarefa) — apenas o artefato de revisão do workflow deve ser produzido. Qualquer diff no repositório reprova a tarefa.\n\n## Verificação\n\nEsta tarefa não tem dogfood:verify; a aprovação vem do gate de qualidade do plano (dogfood-plan-v1: planner -> plan-reviewer -> repair-plan).\n",
  "expectedSignals": [
    "identifica corretamente que o arquivo revisado é score-router.ts",
    "aponta pelo menos um risco de correção ou edge case concreto",
    "não produz nenhum diff de código no repositório"
  ]
}
```

- [ ] **Step 6: `benchmarks/cases/security-redaction-google-api-key.json`**

> Note: an earlier draft of this fixture targeted an AWS `AKIA...` access-key
> pattern. Task-review caught that `packages/domain/src/redaction.ts` at
> `56568a3` **already** redacts that exact pattern (`/\bAKIA[0-9A-Z]{16}\b/g`
> is already in `VALUE_PATTERNS`), which made that case a no-op — a no-diff
> agent run would trivially "pass." This corrected fixture targets a Google
> Cloud API key (`AIza` + 35 alphanumeric/underscore/hyphen chars), confirmed
> absent from `VALUE_PATTERNS` at the pinned baseline, so the case actually
> discriminates a correct fix from doing nothing.

```json
{
  "id": "security-redaction-google-api-key",
  "title": "Redação de chaves de API do Google em packages/domain/src/redaction.ts",
  "kind": "security-sensitive",
  "workflowId": "dogfood-task-v1",
  "baselineRef": "56568a3",
  "allowedFiles": ["packages/domain/src/redaction.ts"],
  "seedFiles": [
    {
      "path": "packages/domain/src/redaction-google-api-key.test.ts",
      "content": "import { describe, expect, it } from 'vitest';\nimport { redactString } from './redaction.js';\n\ndescribe('redactString (Google API key)', () => {\n  it('redacts an AIza-style Google API key embedded in text', () => {\n    const secret = 'AIzaSyD4c9f8g7h6j5k4l3m2n1p0q9r8s7t6u5v';\n    const result = redactString(`google_api_key=${secret}`);\n    expect(result).not.toContain(secret);\n    expect(result).toContain('[REDACTED]');\n  });\n\n  it('leaves ordinary text untouched', () => {\n    const message = 'Deploy succeeded in 4200ms.';\n    expect(redactString(message)).toBe(message);\n  });\n});\n"
    }
  ],
  "verifyScript": "vitest run packages/domain/src/redaction-google-api-key.test.ts --pool=threads --maxWorkers=1",
  "prompt": "# Tarefa: redação de chaves de API do Google (segurança)\n\nEste é o monorepo agent-foundry. O arquivo packages/domain/src/redaction.ts já existe e exporta redactString(text: string): string, cuja lista VALUE_PATTERNS hoje redige tokens Bearer, chaves sk-/rk-, tokens gh[pousr]_ do GitHub, JWTs e chaves de acesso AWS (AKIA...) embutidos em texto livre, substituindo o segredo por '[REDACTED]'. Leia o arquivo real antes de editar — NÃO presuma quais padrões já existem.\n\n## Entregável\n\nEstenda VALUE_PATTERNS em packages/domain/src/redaction.ts para também redigir chaves de API do Google Cloud no formato AIza seguido de exatamente 35 caracteres alfanuméricos, '_' ou '-' (39 caracteres no total, por exemplo AIzaSyD4c9f8g7h6j5k4l3m2n1p0q9r8s7t6u5v), embutidas em qualquer texto livre, substituindo o valor por '[REDACTED]' exatamente como os outros padrões já fazem. Não altere nem enfraqueça nenhum dos padrões de redação já existentes.\n\nUm arquivo de teste já foi semeado no workspace em packages/domain/src/redaction-google-api-key.test.ts — NÃO o modifique. Ele define o contrato exato esperado para o novo padrão.\n\n## Arquivos permitidos (allowlist)\n\nSó é permitido criar ou modificar:\n- packages/domain/src/redaction.ts\n\nQualquer alteração fora dessa lista reprova a tarefa, mesmo que os testes passem.\n\n## Verificação\n\nO comando npm run dogfood:verify deve passar antes de finalizar. Ele executa vitest run packages/domain/src/redaction-google-api-key.test.ts --pool=threads --maxWorkers=1 sobre o teste semeado.\n",
  "expectedSignals": [
    "adiciona um padrão de redação para chaves de API do Google (AIza...)",
    "não enfraquece nenhum padrão de redação pré-existente (Bearer, sk-/rk-, gh*_, JWT, AKIA)",
    "não modifica redaction.test.ts nem redaction-google-api-key.test.ts"
  ]
}
```

- [ ] **Step 7: Sanity-check JSON validity before moving on**

Run: `for f in benchmarks/cases/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "INVALID: $f"; done`
Expected: no `INVALID` lines printed.

- [ ] **Step 8: Commit**

```bash
git add benchmarks/cases
git commit -m "feat(benchmarks): add the six-kind v0.9 benchmark corpus"
```

---

### Task 4: Benchmark runner

**Files:**
- Create: `packages/composition/src/benchmark-runner.ts`
- Test: `packages/composition/src/benchmark-runner.test.ts`
- Modify: `packages/composition/src/index.ts`

**Interfaces:**
- Consumes: `runDogfoodTask` + `RunDogfoodTaskOptions.modelOverride` (Task 1), `BenchmarkCaseSchema` / `BenchmarkRunRecordSchema` / `BenchmarkReportSchema` / `BENCHMARK_CASE_KINDS` (Task 2), `publishBaselinePair` + `markdownCell` (`./baseline-publish.js`, existing), the corpus directory `benchmarks/cases/` (Task 3), `Provider` (`@agent-foundry/contracts`, existing).
- Produces: `loadBenchmarkCases(dir: string): Promise<BenchmarkCase[]>`, `BenchmarkModelTarget` (`{ id: string; provider: Provider; model: string }` — deliberately narrower than the full `ModelDefinition` catalog entry, since that is all a run needs; a `ModelDefinition` satisfies it structurally, so Task 5's CLI can pass catalog entries straight through), `runBenchmarkCase(benchmarkCase: BenchmarkCase, model: BenchmarkModelTarget, options: RunBenchmarkCaseOptions): Promise<BenchmarkRunRecord>`, `freezeBenchmarkReport(records: BenchmarkRunRecord[], options: { baselinesDir: string; baselineRef: string }): Promise<void>`, `renderBenchmarkMarkdown(report: BenchmarkReport): string`. Task 5's CLI calls `loadBenchmarkCases`, `runBenchmarkCase`, and `freezeBenchmarkReport` directly.

- [ ] **Step 1: Write the failing tests**

Create `packages/composition/src/benchmark-runner.test.ts`:

```typescript
import { readdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BenchmarkCaseSchema, BENCHMARK_CASE_KINDS } from '@agent-foundry/contracts';
import { freezeBenchmarkReport, loadBenchmarkCases, runBenchmarkCase } from './benchmark-runner.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const casesDir = resolve(repoRoot, 'benchmarks/cases');

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const suiteDirectories: string[] = [];
afterAll(async () => {
  await Promise.all(
    suiteDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// See the equivalent comment in dogfood.test.ts: createModelOverride validates
// its (modelId, provider, model) tuple against the interpolated
// models/catalog.yaml entry, so CODEX_DEFAULT_MODEL must be set to exactly
// MODEL.model below for the whole file's runBenchmarkCase(..., MODEL, ...)
// calls to pass override validation.
let previousCodexModel: string | undefined;
beforeAll(() => {
  previousCodexModel = process.env.CODEX_DEFAULT_MODEL;
  process.env.CODEX_DEFAULT_MODEL = 'benchmark-fixture-model';
});
afterAll(() => {
  if (previousCodexModel === undefined) delete process.env.CODEX_DEFAULT_MODEL;
  else process.env.CODEX_DEFAULT_MODEL = previousCodexModel;
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

async function suiteDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  suiteDirectories.push(dir);
  return dir;
}

let miniFixture: Promise<{ path: string; sha: string }> | undefined;
function sharedMiniFixture(): Promise<{ path: string; sha: string }> {
  return (miniFixture ??= (async () => {
    const path = await suiteDir('benchmark-fixture-shared-');
    const MINI_PACKAGE = `${JSON.stringify({ name: 'mini', private: true, version: '0.0.0' }, null, 2)}\n`;
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const files: Record<string, string> = {
      'package.json': MINI_PACKAGE,
      'src/lib.js': 'export const value = 1;\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      const destination = join(path, relative);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    await execa('git', ['init', '--quiet'], { cwd: path });
    await execa('git', ['config', 'user.name', 'Benchmark Fixture'], { cwd: path });
    await execa('git', ['config', 'user.email', 'benchmark-fixture@example.invalid'], {
      cwd: path,
    });
    await execa('git', ['add', '.'], { cwd: path });
    await execa('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: path });
    const short = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: path });
    await writeFile(join(path, 'EXTRA.txt'), 'later commit\n');
    await execa('git', ['add', '.'], { cwd: path });
    await execa('git', ['commit', '--quiet', '-m', 'later commit'], { cwd: path });
    return { path, sha: short.stdout.trim() };
  })());
}

function miniCase(overrides: Record<string, unknown> = {}) {
  return BenchmarkCaseSchema.parse({
    id: 'mini-case',
    title: 'Mini benchmark case',
    kind: 'greenfield',
    workflowId: 'dogfood-task-v1',
    prompt: 'Implement a tiny module inside the seeded workspace so verification passes.',
    baselineRef: 'placeholder',
    allowedFiles: ['package.json', 'src/index.js', 'src/index.test.js'],
    seedFiles: [],
    verifyScript: 'node -e "process.exit(0)"',
    expectedSignals: ['mock executor mutation is present'],
    ...overrides,
  });
}

const MODEL = { id: 'codex-default', provider: 'codex' as const, model: 'benchmark-fixture-model' };

describe('the real benchmark corpus', () => {
  it('every fixture in benchmarks/cases parses as a BenchmarkCase and covers all six kinds', async () => {
    const cases = await loadBenchmarkCases(casesDir);
    const files = (await readdir(casesDir)).filter((name) => name.endsWith('.json'));
    expect(cases).toHaveLength(files.length);

    const kinds = new Set(cases.map((benchmarkCase) => benchmarkCase.kind));
    for (const kind of BENCHMARK_CASE_KINDS) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it('every fixture pins a baselineRef that resolves in this repository', async () => {
    const cases = await loadBenchmarkCases(casesDir);
    for (const benchmarkCase of cases) {
      await expect(
        execa('git', ['cat-file', '-e', `${benchmarkCase.baselineRef}^{commit}`], {
          cwd: repoRoot,
        }),
      ).resolves.toBeDefined();
    }
  });
});

describe('runBenchmarkCase (mock mode)', () => {
  it('applies the given model as a run-scoped override and records comparable metadata across two attempts', async () => {
    const fixture = await sharedMiniFixture();
    const dataDir = await tempDir('benchmark-data-');
    const benchmarkCase = miniCase({ id: 'mini-rerun', baselineRef: fixture.sha });

    const first = await runBenchmarkCase(benchmarkCase, MODEL, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });
    const second = await runBenchmarkCase(benchmarkCase, MODEL, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });

    for (const record of [first, second]) {
      expect(record.status).toBe('passed');
      expect(record.caseId).toBe('mini-rerun');
      expect(record.caseKind).toBe('greenfield');
      expect(record.modelId).toBe('codex-default');
      expect(record.route?.executed?.model?.provider).toBe('codex');
      expect(record.route?.executed?.model?.model).toBe('benchmark-fixture-model');
    }
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
  }, 60_000);
});

describe('freezeBenchmarkReport', () => {
  it('requires every corpus kind to be represented before freezing', async () => {
    const record = await runBenchmarkCase(miniCase({ id: 'mini-freeze-gate' }), MODEL, {
      executorMode: 'mock',
      repoRoot: (await sharedMiniFixture()).path,
      dataDir: await tempDir('benchmark-data-'),
    });
    const baselinesDir = await tempDir('benchmark-baselines-');

    await expect(
      freezeBenchmarkReport([record], { baselinesDir, baselineRef: '56568a3' }),
    ).rejects.toThrow(/every case kind/);
  }, 60_000);
});
```

Wire the fixture's `baselineRef` before running: replace the placeholder in `miniCase` calls above with `fixture.sha` where a fixture is available (already done for `mini-rerun`; for `mini-freeze-gate`, add `{ baselineRef: (await sharedMiniFixture()).sha }` to its overrides — adjust the test body so `sharedMiniFixture()` is awaited once and its `.sha` passed into `miniCase`, matching the pattern already used for `mini-rerun`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/composition/src/benchmark-runner.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `Cannot find module './benchmark-runner.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/composition/src/benchmark-runner.ts`:

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BenchmarkCaseSchema,
  BenchmarkReportSchema,
  BenchmarkRunRecordSchema,
  DogfoodTaskSchema,
  type BenchmarkCase,
  type BenchmarkCaseKind,
  type BenchmarkReport,
  type BenchmarkRunRecord,
  type Provider,
} from '@agent-foundry/contracts';
import { markdownCell, publishBaselinePair } from './baseline-publish.js';
import { runDogfoodTask, type RunDogfoodTaskOptions } from './dogfood.js';

const BASELINE_STEM = 'v0.9-benchmark';
const ALL_KINDS: readonly BenchmarkCaseKind[] = [
  'greenfield',
  'existing-repo',
  'bug',
  'refactor',
  'review',
  'security-sensitive',
];

export interface RunBenchmarkCaseOptions {
  repoRoot: string;
  dataDir?: string;
  executorMode?: 'real' | 'mock';
}

// Deliberately narrower than the full ModelDefinition catalog entry — running
// a case only needs these three fields. A ModelDefinition satisfies this
// structurally, so scripts/benchmark.ts can pass catalog entries straight in.
export interface BenchmarkModelTarget {
  id: string;
  provider: Provider;
  model: string;
}

export async function loadBenchmarkCases(dir: string): Promise<BenchmarkCase[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const cases = await Promise.all(
    entries.map(async (name) =>
      BenchmarkCaseSchema.parse(JSON.parse(await readFile(join(dir, name), 'utf8'))),
    ),
  );
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

export async function runBenchmarkCase(
  benchmarkCase: BenchmarkCase,
  model: BenchmarkModelTarget,
  options: RunBenchmarkCaseOptions,
): Promise<BenchmarkRunRecord> {
  if (!model.model.trim()) {
    throw new Error(
      `Catalog model ${model.id} does not resolve to an explicit provider model; skip it instead of running.`,
    );
  }

  const dogfoodOptions: RunDogfoodTaskOptions = {
    repoRoot: options.repoRoot,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.executorMode ? { executorMode: options.executorMode } : {}),
    modelOverride: {
      modelId: model.id,
      provider: model.provider,
      model: model.model,
      reason: `Benchmark run of case "${benchmarkCase.id}" (${benchmarkCase.kind})`,
      estimatedImpact: `Measures ${model.id} performance on the ${benchmarkCase.kind} corpus kind`,
    },
  };

  const dogfoodTask = DogfoodTaskSchema.parse({
    id: `${benchmarkCase.id}--${model.id}`,
    title: benchmarkCase.title,
    issueRef: `benchmark:${benchmarkCase.kind}`,
    workflowId: benchmarkCase.workflowId,
    prompt: benchmarkCase.prompt,
    baselineRef: benchmarkCase.baselineRef,
    allowedFiles: benchmarkCase.allowedFiles,
    seedFiles: benchmarkCase.seedFiles,
    ...(benchmarkCase.verifyScript ? { verifyScript: benchmarkCase.verifyScript } : {}),
  });

  const record = await runDogfoodTask(dogfoodTask, dogfoodOptions);
  const { taskId: _taskId, issueRef: _issueRef, humanEdit: _humanEdit, ...rest } = record;

  return BenchmarkRunRecordSchema.parse({
    ...rest,
    caseId: benchmarkCase.id,
    caseKind: benchmarkCase.kind,
    modelId: model.id,
  });
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines = [
    '# v0.9 benchmark baseline',
    '',
    `Frozen at ${report.createdAt}. Baseline ref \`${report.baselineRef}\`. Machine-readable source of truth: \`${BASELINE_STEM}.json\`.`,
    '',
    '## Runs',
    '',
    '| Case | Kind | Model | Attempt | Status | Duration (ms) | Repairs |',
    '| --- | --- | --- | ---: | --- | ---: | --- |',
    ...report.runs.map(
      (run) =>
        `| ${markdownCell(run.caseId)} | ${run.caseKind} | ${markdownCell(run.modelId)} | ${run.attempt} | ${run.status} | ${run.durationMs} | ${run.repairs.iterations} iter / ${run.repairs.repairEvents} repair(s) |`,
    ),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
  ];
  return lines.join('\n');
}

export async function freezeBenchmarkReport(
  records: BenchmarkRunRecord[],
  options: { baselinesDir: string; baselineRef: string },
): Promise<void> {
  const kinds = new Set(records.map((record) => record.caseKind));
  const missing = ALL_KINDS.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    throw new Error(`Benchmark freeze requires every case kind; missing: ${missing.join(', ')}.`);
  }
  if (records.some((record) => record.status === 'failed' && !record.failure)) {
    throw new Error('Every failed benchmark record must carry a failure before freezing.');
  }

  const report = BenchmarkReportSchema.parse({
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    baselineRef: options.baselineRef,
    runs: records,
    limitations: [
      'Each case runs through the real product pipeline with a run-scoped model override; results depend on provider CLI availability and authentication on the host that ran it.',
      'Failures are frozen alongside passes so the baseline reflects true per-model reliability, not a green wall.',
      'expectedSignals on each case are documentation for reviewers; this runner does not automatically grade output against them.',
    ],
  });

  await publishBaselinePair(
    join(options.baselinesDir, `${BASELINE_STEM}.json`),
    join(options.baselinesDir, `${BASELINE_STEM}.md`),
    `${JSON.stringify(report, null, 2)}\n`,
    renderBenchmarkMarkdown(report),
    {
      restoreFailureMessage: 'Benchmark freeze failed and its baseline pair could not be restored.',
      cleanupFailureMessage: 'Benchmark baseline pair was published but backup cleanup failed.',
    },
  );
}
```

Add the export to `packages/composition/src/index.ts`, next to the `dogfood.js` export:

```typescript
export * from './benchmark-runner.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/composition/src/benchmark-runner.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (5 tests: corpus-kinds coverage, baselineRef resolution, mock-mode override + rerun-comparable metadata, freeze-gate rejection).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/composition`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/composition/src/benchmark-runner.ts packages/composition/src/benchmark-runner.test.ts packages/composition/src/index.ts
git commit -m "feat(composition): add the benchmark runner (load/run/freeze)"
```

---

### Task 5: CLI and npm scripts

**Files:**
- Create: `scripts/benchmark.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `loadBenchmarkCases`, `runBenchmarkCase`, `freezeBenchmarkReport` (Task 4, `packages/composition/src/benchmark-runner.js`), `loadModelCatalog` (`@agent-foundry/model-router`, existing), `loadDoctorProbes` (`packages/composition/src/provider-canary.js`, existing — same readiness check `scripts/dogfood.ts` already uses).
- Produces: `npm run benchmark:run -- --case <id> --model <modelId>`, `npm run benchmark:run -- --all [--models <id,id,...>]`, `npm run benchmark:run -- --freeze`.

This task has no unit test of its own (it is a thin CLI wrapper over already-tested Task 4 functions, exactly mirroring the untested `scripts/dogfood.ts`). Verification is a manual smoke run in mock mode.

- [ ] **Step 1: Create `scripts/benchmark.ts`**

```typescript
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BenchmarkRunRecordSchema,
  type BenchmarkRunRecord,
  type ModelDefinition,
} from '@agent-foundry/contracts';
import { loadModelCatalog } from '@agent-foundry/model-router';
import {
  freezeBenchmarkReport,
  loadBenchmarkCases,
  runBenchmarkCase,
} from '../packages/composition/src/benchmark-runner.js';
import { loadDoctorProbes } from '../packages/composition/src/provider-canary.js';

const rootDir = resolve(import.meta.dirname, '..');
const casesDir = resolve(rootDir, 'benchmarks/cases');
const benchmarkDir = resolve(rootDir, '.data/benchmark');
const catalogPath = resolve(rootDir, 'models/catalog.yaml');
const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function loadRecords(): Promise<BenchmarkRunRecord[]> {
  let entries: string[];
  try {
    entries = (await readdir(benchmarkDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return Promise.all(
    entries.map(async (name) =>
      BenchmarkRunRecordSchema.parse(JSON.parse(await readFile(join(benchmarkDir, name), 'utf8'))),
    ),
  );
}

async function resolveModels(): Promise<ModelDefinition[]> {
  const catalog = await loadModelCatalog(catalogPath, process.env);
  const explicit = argValue('--models');
  const selected = explicit ? new Set(explicit.split(',').map((id) => id.trim())) : undefined;
  return catalog.filter(
    (model) => model.model.trim().length > 0 && (!selected || selected.has(model.id)),
  );
}

async function assertRealModeReady(): Promise<void> {
  if (process.env.RUN_REAL_BENCHMARK !== 'true') {
    console.error('Real benchmark runs require RUN_REAL_BENCHMARK=true.');
    process.exit(1);
  }
  const probes = await loadDoctorProbes(rootDir, process.env);
  for (const probe of probes) {
    if (probe.status !== 'ready') console.error(`skip: ${probe.provider} probe reported ${probe.status}.`);
  }
  if (!probes.some((probe) => probe.status === 'ready')) {
    console.error('No provider CLI is ready; refusing to run real benchmark cases.');
    process.exit(1);
  }
}

const executorMode = argValue('--executor-mode') === 'mock' ? ('mock' as const) : ('real' as const);

try {
  if (args.includes('--freeze')) {
    const records = await loadRecords();
    const baselineRefs = new Set(records.map((record) => record.baselineRef));
    if (baselineRefs.size > 1) {
      throw new Error(
        `--freeze requires all records to share one baselineRef; found: ${[...baselineRefs].join(', ')}`,
      );
    }
    const baselineRef = records[0]?.baselineRef ?? 'unknown';
    await freezeBenchmarkReport(records, {
      baselinesDir: resolve(rootDir, 'docs/baselines'),
      baselineRef,
    });
    console.log(`Frozen ${records.length} record(s) into docs/baselines.`);
  } else if (args.includes('--all') || argValue('--case')) {
    if (executorMode === 'real') await assertRealModeReady();
    const cases = await loadBenchmarkCases(casesDir);
    const caseId = argValue('--case');
    const selectedCases = caseId ? cases.filter((benchmarkCase) => benchmarkCase.id === caseId) : cases;
    if (selectedCases.length === 0) {
      console.error(caseId ? `Unknown case: ${caseId}` : 'No benchmark cases found.');
      process.exit(1);
    }
    const models = await resolveModels();
    if (models.length === 0) {
      console.error('No catalog model resolves to an explicit provider model.');
      process.exit(1);
    }
    let failures = 0;
    for (const benchmarkCase of selectedCases) {
      for (const model of models) {
        const record = await runBenchmarkCase(benchmarkCase, model, {
          repoRoot: rootDir,
          executorMode,
        });
        console.log(
          `${record.caseId} x ${record.modelId} attempt ${record.attempt}: ${record.status}` +
            (record.failure ? ` (${record.failure.kind}: ${record.failure.message})` : ''),
        );
        if (record.status === 'failed') failures += 1;
      }
    }
    process.exitCode = failures === 0 ? 0 : 1;
  } else {
    console.error(
      'Usage: tsx scripts/benchmark.ts --case <id> --model <modelId> | --all [--models <id,id>] | --freeze [--executor-mode mock]',
    );
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Benchmark runner failed.');
  process.exitCode = 1;
}
```

- [ ] **Step 2: Add npm scripts**

In `package.json`, add two entries next to the existing `"dogfood:run": "tsx scripts/dogfood.ts",` line:

```json
    "benchmark:run": "tsx scripts/benchmark.ts",
    "benchmark:freeze": "tsx scripts/benchmark.ts --freeze",
```

- [ ] **Step 3: Smoke-test in mock mode**

Run: `npm run benchmark:run -- --case greenfield-clamp-util --models codex-default --executor-mode mock`
Expected: prints a line like `greenfield-clamp-util x codex-default attempt 1: failed (allowlist: ...)` or `... failed (verification: ...)` — mock mode is expected to fail real corpus verifyScripts (the mock executor always writes a fixed unrelated `src/index.js`, as established during design research); the smoke test's purpose is only to confirm the CLI runs end-to-end without a crash and writes a record file. Confirm with:

Run: `ls .data/benchmark/`
Expected: a file named `greenfield-clamp-util--codex-default-attempt01.json` exists.

Clean up the smoke-test artifact (it is gitignored, but keep the working tree tidy):

Run: `rm -rf .data/benchmark`

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark.ts package.json
git commit -m "feat(scripts): add the benchmark CLI (run/freeze)"
```

---

### Task 6: ADR

**Files:**
- Create: `docs/adr/0029-benchmark-corpus-and-runner.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: the durable record `docs/DEFINITION_OF_DONE.md` requires ("An ADR exists for a durable architectural decision"), referenced from the PR description as evidence.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0029-benchmark-corpus-and-runner.md`:

```markdown
# ADR 0029: Versioned benchmark corpus and multi-model runner

- Status: Accepted
- Date: 2026-07-23
- Owners: Core and Model Router

## Context

ADR 0009 proved the three provider CLIs run and report a model (`canary:providers`). ADR 0013 proved the real `project -> run -> step -> attempt` pipeline turns a prompt into an accepted change on a handful of issue-driven tasks (`dogfood:run`), retaining failures as data. Neither answers the question issue #63 asks: given a representative, versioned corpus of task *kinds*, which model performs best on which kind, comparably across Agent Foundry commits? `v09-task-taxonomy` (ADR 0023) and `v09-usage-telemetry` landed the prerequisites — a hierarchical `TaskCategory` and normalized per-provider usage — but neither defines a benchmark corpus or a way to pin an exact model for a run.

## Decision

A `BenchmarkCase` (`packages/contracts/src/benchmark.ts`) is a `DogfoodTask` (input via `prompt`/`seedFiles`, repo commit via `baselineRef`, policy via `allowedFiles`, checks via `verifyScript`) plus a `kind: 'greenfield' | 'existing-repo' | 'bug' | 'refactor' | 'review' | 'security-sensitive'` classifier and human-facing `expectedSignals`. The corpus lives in `benchmarks/cases/*.json`, one fixture per kind, all pinned to the same `baselineRef` so the whole corpus is versioned against one Agent Foundry commit.

`runBenchmarkCase` (`packages/composition/src/benchmark-runner.ts`) reuses `runDogfoodTask` unchanged except for one addition: `RunDogfoodTaskOptions.modelOverride`, applied via the existing `ProjectService.createModelOverride` with scope `{kind:'run'}` right after project creation and before the worker executes. This bypasses router scoring entirely for the run, so the pinned catalog model (not whatever the router would have picked) is what actually executes — the mechanism the model-override UI already uses for a human's manual pin, reused here for a runner's programmatic one.

Records reuse the dogfood shape (`DogfoodRunRecordSchema` minus `taskId`/`issueRef`/`humanEdit`, plus `caseId`/`caseKind`/`modelId`) and freeze through the same `publishBaselinePair` crash-safe JSON+MD writer as the canary and dogfood baselines, into `docs/baselines/v0.9-benchmark.{json,md}`. `freezeBenchmarkReport` gates on every one of the six kinds being present among the frozen records — the corpus-completeness half of issue #63's acceptance criteria, enforced in code rather than left to reviewer discipline.

The fast suite and the expensive suite are the same code path split by executor mode, not two separate implementations. `packages/composition/src/benchmark-runner.test.ts` exercises `runBenchmarkCase` in `EXECUTOR_MODE=mock` against a synthetic mini-fixture (the same pattern `dogfood.test.ts` already uses), asserting a rerun of the same case produces comparable metadata (`caseId`, `caseKind`, `modelId`, `route.executed` all match; `attempt` increments) — this is both the "reexecução produz metadados comparáveis" required test and, because it is an ordinary Vitest file, the CI-fast-suite: `npm test` already runs every `*.test.ts` with no CI configuration change. The expensive suite — the real six-case corpus against real models — runs via `npm run benchmark:run -- --all`, gated behind `RUN_REAL_BENCHMARK=true`, exactly like `dogfood:run`/`canary:providers` today: invoked manually or by the operator's own externally-scheduled cron.

## Alternatives considered

A new GitHub Actions workflow with `schedule:` + `workflow_dispatch:` (mirroring `security-audit.yml`) was considered and rejected. `codex`/`claude`/`agy` authenticate via local subscription CLI login, not an env-var API key (confirmed: no `*_API_KEY` reference anywhere in `packages/executors/src` or `scripts/doctor.mjs`), and neither the canary nor the dogfood workflow — both older, more established, and asked for the same "expensive suite" treatment — ever got GitHub Actions wiring, for the same reason: a GitHub-hosted runner has no logged-in CLI session, so every scheduled invocation would report every provider not-ready and exit non-zero. Shipping a workflow file guaranteed to fail on every run is worse than not shipping one; the honest scope is the CLI itself, runnable by any cron the operator controls on an authenticated host.

Building a brand-new execution pipeline instead of extending `runDogfoodTask` was rejected: the project-creation, workspace-seeding, verification, diff-capture, and append-only-record machinery is identical to dogfood's, and duplicating ~150 lines of it would drift from dogfood's own bug fixes over time. The one behavioral difference — which model actually executes — is exactly what the existing run-scoped model-override mechanism already exists to express.

Automatically grading a run's output against its case's `expectedSignals` was rejected as unrequested scope: issue #63's acceptance criteria ask the corpus to *fix* expected signals per case (documentation a reviewer reads against the frozen report), not for the runner to algorithmically score prose or diffs against them — that is a `v09-confidence-routing`/`v09-quality-signals`-shaped follow-up, not this one.

## Consequences

Model selection can now be justified against comparable, versioned evidence instead of the capability priors already in `models/catalog.yaml` alone — those priors were self-admittedly "routing priors for this application, not vendor benchmarks" (see the comment at the top of `models/catalog.yaml`); this baseline is a step toward replacing guesses with measurements. Because the corpus is small (one fixture per kind) and fixed, it will saturate — it answers "does this model still handle these six kinds correctly," not "which model is best in general"; that ceiling is explicit in the frozen report's `limitations`. `v09-router-dashboard` (which depends on this issue) can read `docs/baselines/v0.9-benchmark.json` directly once it exists.

## Validation and rollback

`packages/contracts/src/benchmark.test.ts` covers the schemas (kind enum, expected-signals non-empty, issueRef rejected). `packages/composition/src/dogfood.test.ts` covers the new `modelOverride` option. `packages/composition/src/benchmark-runner.test.ts` covers: every real corpus fixture parses and all six kinds are present, every fixture's `baselineRef` resolves in this repository, a mock-mode run applies the override and two attempts of the same case produce comparable metadata, and freezing without all six kinds throws. Rollback: the new files (`packages/contracts/src/benchmark.ts`, `packages/composition/src/benchmark-runner.ts`, `benchmarks/cases/*.json`, `scripts/benchmark.ts`) are additive; the one modified file with production behavior change is `packages/composition/src/dogfood.ts`, whose `modelOverride` option is optional and defaults to today's unmodified behavior when omitted.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0029-benchmark-corpus-and-runner.md
git commit -m "docs(adr): record the benchmark corpus and runner design (ADR 0029)"
```

---

### Task 7: Full verification pass

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full check suite**

Run: `npm run check`
Expected: exits 0. This single script already runs, in order, `format:check`, `lint`, `architecture:check`, `roadmap:check` (which includes `roadmap:validate` — the reconciler that protects the `v09-benchmark-runner` entry in `planning/roadmap-spec.json` by hash; none of Tasks 1–6 touch that file, so this must report no drift), `typecheck`, `test` (all suites, including the new `packages/contracts/src/benchmark.test.ts`, `packages/composition/src/benchmark-runner.test.ts`, and the updated `packages/composition/src/dogfood.test.ts`), and `build`.

- [ ] **Step 2: Confirm no `.data/` artifacts leaked into git**

Run: `git status --porcelain`
Expected: only the files from Tasks 1–6 are staged/modified; no `.data/benchmark/*` or `.data/dogfood/*` paths appear (they are gitignored, but double-check in case a script wrote outside the expected dir).

- [ ] **Step 3: Collect evidence for the PR**

Run and capture output for the PR description:
```bash
npm run benchmark:run -- --case bug-version-compare --models codex-default --executor-mode mock
```
This demonstrates the CLI end-to-end (schema load → override application → record write) without requiring a real, authenticated provider CLI. Paste the console output and the resulting `.data/benchmark/*.json` record (then `rm -rf .data/benchmark` again) into the PR body as evidence, alongside the `npm test` summary line.
