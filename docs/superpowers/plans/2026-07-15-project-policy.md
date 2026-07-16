# ProjectPolicy Enforcement (issue #15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Development mode: ponytail ultra + superpowers:test-driven-development + andrej-karpathy-skills:karpathy-guidelines.

**Goal:** Define a versioned, hashed ProjectPolicy (requiredStack, allowedProviders, forbiddenDependencies, allowedCommands) selected per project, enforced before execution (router, stack check), after execution (verifier), and pinned per run so a mid-run policy change blocks continuation until the user forks (retries) the project.

**Architecture:** Policy schema lives in `contracts`; a `PolicyRepository` port in `domain` is implemented by a `YamlPolicyRepository` in `persistence` (mirrors `YamlWorkflowRepository`, files in `policies/<id>.yaml`). `CreateProjectRequest` gains `policyId` (default `default`). The orchestrator resolves the project's policy at run start, stamps `{id, version, hash}` on the `WorkflowRun`, fails the run with an auditable `policy.violation` event when the policy content changed mid-run or `requiredStack` mismatches the workflow stack, threads the policy into the task profile (router rejects forbidden providers with a policy-attributed reason recorded in `RouteDecision.rejected`) and into the verifier (forbidden-dependency + command-allowlist checks land as failing entries in the `VerificationReport`). Pause snapshots capture `policyHash` and resume is blocked on drift via the existing `ResumeBlockedError` machinery.

**Tech Stack:** TypeScript ESM monorepo, zod schemas, vitest (`npm run test:unit` = `vitest run --pool=threads --maxWorkers=1`), YAML config files, npm workspaces.

## Global Constraints

- Issue #15 acceptance criteria (all must be demonstrable):
  - Policy supports `requiredStack`, `forbiddenDependencies`, `allowedProviders`, and allowed commands.
  - Router eliminates forbidden candidates with an auditable reason.
  - Verifier detects dependencies/changes that violate the policy.
  - Policy has revision/versioning and its hash is saved on the run.
  - Policy change during a run requires fork (project retry → new run) — blocked otherwise.
- Mandatory tests: block a provider, block a forbidden package, block a command outside the allowlist.
- Persisted schemas must stay backward compatible: every new field on persisted entities (`Project`, `WorkflowRun`, `RunPauseSnapshot`) is **optional**. Repos `parse()` on read (`packages/persistence/src/run-repositories.ts:30`).
- `docs/DEFINITION_OF_DONE.md` applies: evidence on the issue, ADR for the durable decision, rollback documented.
- Full gate before PR: `npm run check` (format, lint, architecture, roadmap, typecheck, tests, build).
- Follow existing file/naming/comment idioms; deliberate shortcuts get `ponytail:` comments naming the ceiling.
- Do not touch `apps/web` UI (out of issue touchpoints); API picks up `policyId` automatically because `apps/api/src/app.ts:94` parses `CreateProjectRequestSchema`.

## Process (how to execute this plan)

1. **Worktree first** (superpowers:using-git-worktrees): create isolated worktree on branch `feat/15-project-policy` off `main`, e.g. via the native `EnterWorktree` tool or `git worktree add ../agent-foundry-issue-15 -b feat/15-project-policy`.
2. Copy this plan to `docs/superpowers/plans/2026-07-15-project-policy.md` in the worktree (commit with first task).
3. **Task 1 first** (foundation). Then dispatch **Tasks 2, 3, 4, 5 in parallel** (superpowers:subagent-driven-development — they touch disjoint packages: model-router / executors / persistence / orchestrator). Parallel subagents must NOT run `git commit` (they share the worktree); the coordinating session reviews, runs each task's tests, and commits sequentially after each task's diff lands. Task 6 after 4+5. Task 7 last.
4. Every task follows TDD: failing test → minimal code → pass → commit.
5. After PR: run `/ponytail:ponytail-review` and `/simplify`, address all findings, push. Post evidence on issue #15 (test output, event trace, PR link).

---

## File Structure

- `packages/contracts/src/policy.ts` (new) — `ProjectPolicySchema`, `PolicyRecordSchema`.
- `packages/contracts/src/policy.test.ts` (new) — schema tests.
- `packages/contracts/src/{project,model,run,api,index}.ts` — additive fields.
- `packages/domain/src/errors.ts` — `PolicyViolationError`.
- `packages/domain/src/ports.ts` — `PolicyRepository` port; `VerificationService` input gains `policy`.
- `packages/persistence/src/policy-repository.ts` (new) + `policy-repository.test.ts` (new) + `index.ts` export.
- `packages/model-router/src/score-router.ts` — policy rejection reason; `score-router.test.ts` additions.
- `packages/executors/src/verifier.ts` — command allowlist + dependency check; `verifier.test.ts` additions.
- `packages/orchestrator/src/idempotency.ts` — `policyHash()`.
- `packages/orchestrator/src/task-profiler.ts` — thread policy into `TaskProfile`.
- `packages/orchestrator/src/workflow-orchestrator.ts` — resolve/stamp/enforce policy, thread to router+verifier, pause snapshot.
- `packages/orchestrator/src/project-service.ts` — validate `policyId` at create, resume diagnostic.
- `packages/orchestrator/src/testing/harness.ts` — `InMemoryPolicies`, policy in `makeHarness`.
- `packages/orchestrator/src/cancellation.test.ts` — fix direct constructor call sites.
- `packages/orchestrator/src/policy-enforcement.test.ts` (new) — end-to-end orchestrator policy tests.
- `packages/composition/src/{config,runtime}.ts` + `config.test.ts` — `POLICIES_DIR`, wiring.
- `policies/default.yaml` (new) — permissive default policy.
- `docs/adr/0014-project-policy-enforcement.md` (new).

---

### Task 1: Contracts + domain foundation

**Files:**

- Create: `packages/contracts/src/policy.ts`
- Create: `packages/contracts/src/policy.test.ts`
- Modify: `packages/contracts/src/project.ts` (ProjectSchema, ProjectEventSchema)
- Modify: `packages/contracts/src/model.ts` (TaskProfileSchema)
- Modify: `packages/contracts/src/run.ts` (WorkflowRunSchema, RunPauseSnapshotSchema)
- Modify: `packages/contracts/src/api.ts` (CreateProjectRequestSchema)
- Modify: `packages/contracts/src/index.ts` (add `export * from './policy.js';`)
- Modify: `packages/domain/src/errors.ts`
- Modify: `packages/domain/src/ports.ts`

**Interfaces:**

- Consumes: existing `PathSegmentSchema`, `ProviderSchema` (`packages/contracts/src/primitives.ts`), `IdempotencyKeySchema` (`packages/contracts/src/run.ts:64`).
- Produces (later tasks rely on these exact names):
  - `ProjectPolicySchema` / `type ProjectPolicy` — `{ schemaVersion: '1'; id: string; version: number; requiredStack?: string; allowedProviders?: ('codex'|'claude'|'agy')[]; forbiddenDependencies: string[]; allowedCommands?: string[] }`
  - `PolicyRecordSchema` / `type PolicyRecord` — `{ id: string; version: number; hash: string /* sha256 hex */ }`
  - `Project.policyId?: string`
  - `TaskProfile.policy?: { id: string; version: number; allowedProviders: ('codex'|'claude'|'agy')[] }`
  - `WorkflowRun.policy?: PolicyRecord`
  - `RunPauseSnapshot.policyHash?: string`
  - `CreateProjectRequest.policyId: string` (zod default `'default'`)
  - `ProjectEvent.type` gains `'policy.violation'`
  - `class PolicyViolationError extends Error { readonly violations: string[] }` (domain)
  - `interface PolicyRepository { get(policyId: string): Promise<ProjectPolicy> }` (domain)
  - `VerificationService.verify` input gains `policy?: ProjectPolicy | undefined`

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/policy.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { ProjectPolicySchema, PolicyRecordSchema } from './policy.js';

describe('ProjectPolicySchema', () => {
  it('parses a full policy and defaults forbiddenDependencies to []', () => {
    const policy = ProjectPolicySchema.parse({
      schemaVersion: '1',
      id: 'strict-nextjs',
      version: 3,
      requiredStack: 'nextjs',
      allowedProviders: ['claude', 'codex'],
      allowedCommands: ['typecheck', 'lint', 'test', 'build'],
    });
    expect(policy.forbiddenDependencies).toEqual([]);
    expect(policy.allowedProviders).toEqual(['claude', 'codex']);
  });

  it('rejects the mock provider in allowedProviders', () => {
    expect(() =>
      ProjectPolicySchema.parse({
        schemaVersion: '1',
        id: 'p',
        version: 1,
        allowedProviders: ['mock'],
      }),
    ).toThrow();
  });

  it('rejects a non-positive version and empty allowlists', () => {
    expect(() => ProjectPolicySchema.parse({ schemaVersion: '1', id: 'p', version: 0 })).toThrow();
    expect(() =>
      ProjectPolicySchema.parse({ schemaVersion: '1', id: 'p', version: 1, allowedCommands: [] }),
    ).toThrow();
  });
});

describe('PolicyRecordSchema', () => {
  it('requires a sha256 hex hash', () => {
    expect(() => PolicyRecordSchema.parse({ id: 'p', version: 1, hash: 'nope' })).toThrow();
    expect(
      PolicyRecordSchema.parse({ id: 'p', version: 1, hash: 'a'.repeat(64) }).hash,
    ).toHaveLength(64);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/policy.test.ts`
Expected: FAIL — `Cannot find module './policy.js'`

- [ ] **Step 3: Create `packages/contracts/src/policy.ts`**

```ts
import { z } from 'zod';
import { PathSegmentSchema, ProviderSchema } from './primitives.js';

/**
 * Hard constraints a project executes under, validated before (router,
 * stack) and after (verifier) execution. Absent optional fields mean
 * "unrestricted"; empty allowlists are rejected as almost certainly a
 * configuration mistake (they would forbid everything).
 */
export const ProjectPolicySchema = z.object({
  schemaVersion: z.literal('1'),
  id: PathSegmentSchema,
  version: z.number().int().positive(),
  requiredStack: PathSegmentSchema.optional(),
  allowedProviders: z
    .array(ProviderSchema.exclude(['mock']))
    .min(1)
    .optional(),
  forbiddenDependencies: z.array(z.string().min(1)).default([]),
  allowedCommands: z.array(z.string().min(1)).min(1).optional(),
});
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

/** Identity of the policy a run executes under; the hash pins exact content. */
export const PolicyRecordSchema = z
  .object({
    id: PathSegmentSchema,
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PolicyRecord = z.infer<typeof PolicyRecordSchema>;
```

- [ ] **Step 4: Wire the additive contract fields**

In `packages/contracts/src/project.ts`:

- `ProjectSchema`: after `workflowId`, add `policyId: PathSegmentSchema.optional(),` (optional = legacy projects resolve as `'default'`).
- `ProjectEventSchema` type enum: add `'policy.violation',` after `'verification.completed',`.

In `packages/contracts/src/model.ts`, inside `TaskProfileSchema` after `allowedProviders`:

```ts
  policy: z
    .object({
      id: PathSegmentSchema,
      version: z.number().int().positive(),
      allowedProviders: z.array(ProviderSchema.exclude(['mock'])),
    })
    .strict()
    .optional(),
```

In `packages/contracts/src/run.ts`:

- `import { PolicyRecordSchema } from './policy.js';`
- `RunPauseSnapshotSchema`: add `policyHash: IdempotencyKeySchema.optional(),` after `harnessVersion`.
- `WorkflowRunSchema`: add `policy: PolicyRecordSchema.optional(),` after `workflowId`.

In `packages/contracts/src/api.ts`, `CreateProjectRequestSchema`: add `policyId: PathSegmentSchema.default('default'),` after `workflowId`.

In `packages/contracts/src/index.ts`: add `export * from './policy.js';` alongside the other exports.

- [ ] **Step 5: Domain error + ports**

`packages/domain/src/errors.ts` (after `QualityGateError`):

```ts
/** A hard ProjectPolicy constraint was violated; the run must not proceed. */
export class PolicyViolationError extends Error {
  override readonly name = 'PolicyViolationError';

  constructor(
    message: string,
    readonly violations: string[] = [],
  ) {
    super(message);
  }
}
```

`packages/domain/src/ports.ts`:

- Add `ProjectPolicy` to the type-import list from `@agent-foundry/contracts`.
- After `WorkflowRepository`, add:

```ts
export interface PolicyRepository {
  get(policyId: string): Promise<ProjectPolicy>;
}
```

- `VerificationService.verify` input: add `policy?: ProjectPolicy | undefined;` after `includeGitDiffCheck`.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run packages/contracts && npm run typecheck`
Expected: contracts tests PASS. Typecheck may surface downstream compile errors only if signatures were changed beyond the plan — the additions above are purely additive/optional, so expect PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts packages/domain docs/superpowers/plans/2026-07-15-project-policy.md
git commit -m "feat(contracts,domain): ProjectPolicy schema, policy run record and PolicyRepository port"
```

---

### Task 2: Model router rejects policy-forbidden providers (parallel-safe)

**Files:**

- Modify: `packages/model-router/src/score-router.ts:65-76` (`rejectReason`)
- Test: `packages/model-router/src/score-router.test.ts`

**Interfaces:**

- Consumes: `TaskProfile.policy` from Task 1.
- Produces: rejection reason string format `provider <p> is forbidden by policy <id>@v<version>` recorded in `RouteDecision.rejected` (already persisted with every attempt → auditable).

- [ ] **Step 1: Write the failing test** — add to `packages/model-router/src/score-router.test.ts` (reuse the file's existing model/profile fixture helpers; adapt names to what is there):

```ts
it('rejects providers forbidden by policy with an auditable reason', async () => {
  const router = new ScoreBasedModelRouter(
    [
      model({ id: 'claude-model', provider: 'claude' }),
      model({ id: 'codex-model', provider: 'codex' }),
    ],
    metrics,
  );
  const decision = await router.route(
    profile({ policy: { id: 'strict', version: 2, allowedProviders: ['codex'] } }),
  );
  expect(decision.selected.model.id).toBe('codex-model');
  expect(decision.rejected).toContainEqual({
    modelId: 'claude-model',
    reason: 'provider claude is forbidden by policy strict@v2',
  });
});

it('throws when policy forbids every provider, listing the policy rejections', async () => {
  const router = new ScoreBasedModelRouter(
    [model({ id: 'claude-model', provider: 'claude' })],
    metrics,
  );
  await expect(
    router.route(profile({ policy: { id: 'strict', version: 2, allowedProviders: ['codex'] } })),
  ).rejects.toThrow(/forbidden by policy strict@v2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/model-router/src/score-router.test.ts`
Expected: FAIL — no rejection entry / selected is claude-model.

- [ ] **Step 3: Implement** — in `rejectReason` (`score-router.ts:65`), first check:

```ts
if (profile.policy && !profile.policy.allowedProviders.includes(model.provider)) {
  return `provider ${model.provider} is forbidden by policy ${profile.policy.id}@v${profile.policy.version}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/model-router/src/score-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** (coordinator, after review)

```bash
git add packages/model-router
git commit -m "feat(model-router): reject policy-forbidden providers with auditable reason"
```

---

### Task 3: Verifier enforces command allowlist and forbidden dependencies (parallel-safe)

**Files:**

- Modify: `packages/executors/src/verifier.ts`
- Test: `packages/executors/src/verifier.test.ts`

**Interfaces:**

- Consumes: `ProjectPolicy` from Task 1; `VerificationService` input `policy` from Task 1.
- Produces: two synthetic `VerificationCommandResult` behaviors inside the existing `VerificationReport` (no report schema change):
  - Disallowed script → `{ name: <script>, command: 'policy', exitCode: 1, stderr: "Script '<s>' is not allowed by policy <id>@v<version>." }`, script **never executed**.
  - `{ name: 'policy-dependency-check', command: 'policy', exitCode: 0|1, stderr: 'Forbidden dependencies declared: <names> (policy <id>@v<version>).' }` — emitted whenever a policy is provided.

- [ ] **Step 1: Write the failing tests** — add to `packages/executors/src/verifier.test.ts` (mirror the file's existing temp-workspace setup helpers; the pattern below assumes a helper that writes `package.json` into a temp dir — reuse whatever the file already uses):

```ts
const POLICY = ProjectPolicySchema.parse({
  schemaVersion: '1',
  id: 'strict',
  version: 2,
  forbiddenDependencies: ['left-pad'],
  allowedCommands: ['lint'],
});

it('blocks scripts outside the policy allowlist without executing them', async () => {
  // package.json with scripts: { lint: 'node -e ""', evil: 'node -e "require(`fs`).writeFileSync(`evil-ran`, ``)"' }
  const report = await verifier.verify({
    workspacePath,
    scripts: ['lint', 'evil'],
    includeGitDiffCheck: false,
    policy: POLICY,
  });
  expect(report.approved).toBe(false);
  const blocked = report.commands.find((command) => command.name === 'evil');
  expect(blocked).toMatchObject({ command: 'policy', exitCode: 1 });
  expect(blocked?.stderr).toContain('not allowed by policy strict@v2');
  await expect(access(join(workspacePath, 'evil-ran'))).rejects.toThrow(); // never executed
});

it('fails the report when a forbidden dependency is declared', async () => {
  // package.json with dependencies: { 'left-pad': '1.3.0' } and scripts: {}
  const report = await verifier.verify({
    workspacePath,
    scripts: [],
    includeGitDiffCheck: false,
    policy: POLICY,
  });
  expect(report.approved).toBe(false);
  const check = report.commands.find((command) => command.name === 'policy-dependency-check');
  expect(check).toMatchObject({ exitCode: 1 });
  expect(check?.stderr).toContain('left-pad');
});

it('passes the dependency check when nothing forbidden is declared', async () => {
  // package.json with dependencies: { react: '19.0.0' }
  const report = await verifier.verify({
    workspacePath,
    scripts: [],
    includeGitDiffCheck: false,
    policy: POLICY,
  });
  expect(
    report.commands.find((command) => command.name === 'policy-dependency-check')?.exitCode,
  ).toBe(0);
});

it('runs unrestricted when no policy is provided (existing behavior unchanged)', async () => {
  const report = await verifier.verify({ workspacePath, scripts: [], includeGitDiffCheck: false });
  expect(
    report.commands.find((command) => command.name === 'policy-dependency-check'),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/executors/src/verifier.test.ts`
Expected: FAIL — `policy` not accepted / no policy results emitted.

- [ ] **Step 3: Implement** in `packages/executors/src/verifier.ts`:

Add to imports: `type ProjectPolicy` from `@agent-foundry/contracts`.

`verify` input type: add `policy?: ProjectPolicy | undefined;`.

In the scripts loop (`verifier.ts:56`), before the missing-script branch:

```ts
if (input.policy?.allowedCommands && !input.policy.allowedCommands.includes(script)) {
  commands.push({
    name: script,
    command: 'policy',
    args: [],
    exitCode: 1,
    durationMs: 0,
    stdout: '',
    stderr: `Script '${script}' is not allowed by policy ${input.policy.id}@v${input.policy.version}.`,
    skipped: false,
  });
  continue;
}
```

After the scripts loop, before the git-diff block:

```ts
if (input.policy) commands.push(dependencyPolicyCheck(input.policy, packageJson));
```

Module-level function (near `detectPackageManager`):

```ts
// ponytail: exact-name match over package.json manifests only; scan the
// lockfile for transitive dependencies if policy evasion ever matters.
function dependencyPolicyCheck(
  policy: ProjectPolicy,
  packageJson: Record<string, unknown>,
): VerificationCommandResult {
  const declared = ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((field) => {
    const section = packageJson[field];
    return isRecord(section) ? Object.keys(section) : [];
  });
  const violations = [
    ...new Set(declared.filter((name) => policy.forbiddenDependencies.includes(name))),
  ].sort();
  return {
    name: 'policy-dependency-check',
    command: 'policy',
    args: [],
    exitCode: violations.length === 0 ? 0 : 1,
    durationMs: 0,
    stdout: '',
    stderr:
      violations.length === 0
        ? ''
        : `Forbidden dependencies declared: ${violations.join(', ')} (policy ${policy.id}@v${policy.version}).`,
    skipped: false,
  };
}
```

Note: the early no-`package.json` return (`verifier.ts:37-46`) already fails the report, so the dependency check needs no null handling there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/executors/src/verifier.test.ts`
Expected: PASS (all pre-existing verifier tests still green).

- [ ] **Step 5: Commit** (coordinator, after review)

```bash
git add packages/executors
git commit -m "feat(executors): verifier enforces policy command allowlist and forbidden dependencies"
```

---

### Task 4: YamlPolicyRepository in persistence (parallel-safe)

**Files:**

- Create: `packages/persistence/src/policy-repository.ts`
- Create: `packages/persistence/src/policy-repository.test.ts`
- Modify: `packages/persistence/src/index.ts` (export)

**Interfaces:**

- Consumes: `ProjectPolicySchema` (Task 1), `PolicyRepository` port (Task 1), `safeSegment` from `packages/persistence/src/fs-utils.ts`, `NotFoundError` from domain.
- Produces: `class YamlPolicyRepository implements PolicyRepository { constructor(policiesDir: string); get(policyId: string): Promise<ProjectPolicy> }`.

- [ ] **Step 1: Write the failing test** — `packages/persistence/src/policy-repository.test.ts` (mirror `workflow-repository.test.ts` temp-dir setup):

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@agent-foundry/domain';
import { YamlPolicyRepository } from './policy-repository.js';

describe('YamlPolicyRepository', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'policies-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and validates a policy file by id', async () => {
    await writeFile(
      join(dir, 'strict.yaml'),
      [
        "schemaVersion: '1'",
        'id: strict',
        'version: 2',
        'requiredStack: nextjs',
        'allowedProviders: [codex]',
        'forbiddenDependencies: [left-pad]',
        'allowedCommands: [lint, test]',
      ].join('\n'),
    );
    const policy = await new YamlPolicyRepository(dir).get('strict');
    expect(policy).toMatchObject({ id: 'strict', version: 2, requiredStack: 'nextjs' });
  });

  it('rejects a filename/id mismatch', async () => {
    await writeFile(join(dir, 'strict.yaml'), "schemaVersion: '1'\nid: other\nversion: 1\n");
    await expect(new YamlPolicyRepository(dir).get('strict')).rejects.toThrow(/filename and id/);
  });

  it('throws NotFoundError for a missing policy', async () => {
    await expect(new YamlPolicyRepository(dir).get('nope')).rejects.toThrow(NotFoundError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/policy-repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/persistence/src/policy-repository.ts` (mirrors `workflow-repository.ts:13-42`):

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { ProjectPolicySchema, type ProjectPolicy } from '@agent-foundry/contracts';
import type { PolicyRepository } from '@agent-foundry/domain';
import { NotFoundError } from '@agent-foundry/domain';
import { safeSegment } from './fs-utils.js';

export class YamlPolicyRepository implements PolicyRepository {
  constructor(private readonly policiesDir: string) {}

  async get(policyId: string): Promise<ProjectPolicy> {
    const path = join(this.policiesDir, `${safeSegment(policyId)}.yaml`);
    try {
      const policy = ProjectPolicySchema.parse(YAML.parse(await readFile(path, 'utf8')));
      if (policy.id !== policyId) {
        throw new Error(
          `Policy file ${policyId}.yaml declares id ${policy.id}; filename and id must match`,
        );
      }
      return policy;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new NotFoundError(`Policy ${policyId} not found`);
      }
      throw error;
    }
  }
}
```

Add `export * from './policy-repository.js';` to `packages/persistence/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/policy-repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** (coordinator, after review)

```bash
git add packages/persistence
git commit -m "feat(persistence): YamlPolicyRepository loading versioned policies from policies dir"
```

---

### Task 5: Orchestrator enforcement — stamp hash, block mid-run change, requiredStack, threading (parallel-safe)

**Files:**

- Modify: `packages/orchestrator/src/idempotency.ts` (add `policyHash`)
- Modify: `packages/orchestrator/src/task-profiler.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/project-service.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts`
- Modify: `packages/orchestrator/src/cancellation.test.ts` (two direct constructor sites, lines ~503 and ~523)
- Create: `packages/orchestrator/src/policy-enforcement.test.ts`

**Interfaces:**

- Consumes: `ProjectPolicy`, `PolicyRecord`, `PolicyRepository`, `PolicyViolationError`, `Project.policyId`, `WorkflowRun.policy`, `RunPauseSnapshot.policyHash`, `TaskProfile.policy` (Task 1).
- Produces:
  - `policyHash(policy: ProjectPolicy): string` exported from `idempotency.ts` (sha256 of stable stringify — same helpers as `workflowHash`).
  - `WorkflowOrchestrator` constructor gains `policies: PolicyRepository` **immediately after** the `workflows` param.
  - `ProjectService` constructor gains `policies: PolicyRepository` **immediately after** the `workflows` param.
  - `buildTaskProfile` input gains `policy?: ProjectPolicy | undefined`.
  - Harness exports `InMemoryPolicies` and `DEFAULT_POLICY`; `makeHarness(behaviors, existing, opts)` accepts `opts.policy?: ProjectPolicy`; returned object includes `policies: InMemoryPolicies` (with a mutable `policy` field for mid-run-change tests).

- [ ] **Step 1: Write the failing tests** — `packages/orchestrator/src/policy-enforcement.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { ProjectPolicySchema } from '@agent-foundry/contracts';
import { policyHash } from './idempotency.js';
import { makeHarness, seedRun } from './testing/harness.js';

const strictPolicy = (overrides: Record<string, unknown> = {}) =>
  ProjectPolicySchema.parse({
    schemaVersion: '1',
    id: 'default',
    version: 1,
    ...overrides,
  });

describe('policy enforcement', () => {
  it('stamps the policy id, version and hash on the run', async () => {
    const policy = strictPolicy();
    const harness = makeHarness({}, undefined, { policy });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('completed');
    expect(run?.policy).toEqual({ id: 'default', version: 1, hash: policyHash(policy) });
  });

  it('threads the policy into the route decision profile', async () => {
    const policy = strictPolicy({ allowedProviders: ['codex'] });
    const harness = makeHarness({}, undefined, { policy });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const attempt = harness.stepAttempts.all().find((item) => item.executorKind === 'agent');
    expect(attempt?.routeDecision?.profile.policy).toEqual({
      id: 'default',
      version: 1,
      allowedProviders: ['codex'],
    });
  });

  it('fails the run before any step when requiredStack mismatches the workflow', async () => {
    const harness = makeHarness({}, undefined, {
      policy: strictPolicy({ requiredStack: 'rails' }), // fixture workflow stack is 'node'
    });
    await seedRun(harness);
    await assert.rejects(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
      /requiredStack/,
    );
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
    expect(harness.events.types()).toContain('policy.violation');
    expect(harness.stepAttempts.all()).toHaveLength(0);
  });

  it('blocks a run whose policy changed mid-flight; retry forks a run under the new policy', async () => {
    const harness = makeHarness({ implement: 'gated' }, undefined, { policy: strictPolicy() });
    await seedRun(harness);
    const first = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    // Policy content changes while the run is parked mid-step.
    harness.policies.policy = strictPolicy({ version: 2, forbiddenDependencies: ['left-pad'] });
    harness.executor.release('implement');
    await first; // in-flight walk finishes under the already-resolved v1 policy
    // Redelivery (crash replay / requeue) now sees the changed policy and must block.
    await assert.rejects(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
      /changed/,
    );
    expect(harness.events.types()).toContain('policy.violation');
    // Fork: project retry creates a fresh run that adopts the new policy.
    await harness.service.retry('project-1');
    const forked = (await harness.projects.get('project-1'))?.currentRunId;
    await harness.orchestrator.runProject('project-1', undefined, forked);
    const run = await harness.runs.get(forked!);
    expect(run?.status).toBe('completed');
    expect(run?.policy?.version).toBe(2);
  });

  it('blocks resume when the policy hash drifted while paused', async () => {
    const harness = makeHarness({ implement: 'gated' }, undefined, { policy: strictPolicy() });
    await seedRun(harness);
    const walk = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await harness.service.pauseRun('run-1');
    harness.executor.release('implement');
    await walk;
    expect((await harness.runs.get('run-1'))?.status).toBe('paused');
    harness.policies.policy = strictPolicy({ version: 2, requiredStack: 'node' });
    await assert.rejects(harness.service.resumeRun('run-1'), /policyVersion/);
  });

  it('passes the policy to the verifier', async () => {
    const policy = strictPolicy({ allowedCommands: ['typecheck', 'lint', 'test', 'build'] });
    const harness = makeHarness({}, undefined, { policy });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect(harness.verifierInputs.at(-1)?.policy).toEqual(policy);
  });
});
```

Note on the mid-run test: the terminal-status early return at `workflow-orchestrator.ts:112-118` fires before policy checks, so the "redelivery blocks" assertion needs the first walk to leave the run non-terminal. If the gated walk completes the run, restructure: keep a second gated step (`review: 'gated'`) so the change lands while `run-1` is still `running`, then release everything and assert the _policy check on the next step boundary_ fails the run. Whichever structure is used, the observable contract is fixed: a policy content change during a live run ends in `status: 'failed'`, a `policy.violation` event, a thrown `PolicyViolationError`, and a successful retry-fork under the new policy. Implementers may adjust gating mechanics, not the contract. (Checking the hash at **every step boundary** — inside `executeStep` — rather than only at `runProject` entry is the required implementation for exactly this reason.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/policy-enforcement.test.ts`
Expected: FAIL — `makeHarness` has no policy support, orchestrator has no policy behavior.

- [ ] **Step 3: Implement `policyHash`** — `packages/orchestrator/src/idempotency.ts`, next to `workflowHash` (line 56):

```ts
export function policyHash(policy: ProjectPolicy): string {
  return sha256(stableStringify(policy));
}
```

Add `ProjectPolicy` to the type imports.

- [ ] **Step 4: Thread policy through `buildTaskProfile`** — `packages/orchestrator/src/task-profiler.ts`:

Input type gains `policy?: ProjectPolicy | undefined;`. In the returned object, after the `allowedProviders` spread:

```ts
    ...(input.policy?.allowedProviders
      ? {
          policy: {
            id: input.policy.id,
            version: input.policy.version,
            allowedProviders: input.policy.allowedProviders,
          },
        }
      : {}),
```

- [ ] **Step 5: Orchestrator changes** — `packages/orchestrator/src/workflow-orchestrator.ts`:

1. Constructor: add `private readonly policies: PolicyRepository,` immediately after the `workflows` param. Import `PolicyRepository` type from domain, `PolicyViolationError` from domain, `policyHash` from `./idempotency.js`, `type ProjectPolicy` and `type PolicyRecord` from contracts.

2. `runProject` (line 99): after `const workflow = await this.workflows.get(...)`:

```ts
const policy = await this.policies.get(project.policyId ?? 'default');
```

3. Inside the `try` block, before the `for (const node of workflow.nodes)` loop:

```ts
await this.enforceRunPolicy(run.id, project, workflow, policy);
```

4. New private method (place near `pauseSnapshot`):

```ts
  /**
   * Pins the run to the policy it started under and blocks execution when the
   * policy content changed mid-run — retrying the project (a fresh run) is
   * the explicit fork that adopts the new policy.
   */
  private async enforceRunPolicy(
    runId: string,
    project: Project,
    workflow: WorkflowDefinition,
    policy: ProjectPolicy,
  ): Promise<void> {
    const hash = policyHash(policy);
    const run = await this.requireRun(runId);
    if (run.policy && run.policy.hash !== hash) {
      const message =
        `Policy ${policy.id} changed (v${run.policy.version} → v${policy.version}) while run ${runId} was in flight. ` +
        'Retry the project to fork a new run under the current policy.';
      await this.emit(project.id, 'policy.violation', message, {
        runId,
        data: { field: 'policyHash', expected: run.policy.hash, actual: hash },
      });
      throw new PolicyViolationError(message, ['policy-changed-mid-run']);
    }
    if (!run.policy) {
      await this.runs.update(
        {
          ...run,
          policy: { id: policy.id, version: policy.version, hash },
          updatedAt: this.clock.now().toISOString(),
        },
        run.version,
      );
    }
    if (policy.requiredStack && policy.requiredStack !== workflow.stack) {
      const message = `Workflow ${workflow.id} stack '${workflow.stack}' violates policy ${policy.id}@v${policy.version} requiredStack '${policy.requiredStack}'.`;
      await this.emit(project.id, 'policy.violation', message, {
        runId,
        data: { requiredStack: policy.requiredStack, stack: workflow.stack },
      });
      throw new PolicyViolationError(message, ['required-stack']);
    }
  }
```

5. Thread `policy: ProjectPolicy` as a parameter through `executeNode` → `executeQualityLoop` / `executeStep` → `executeAgentStep` / `executeVerifyStep` (mechanical: one extra trailing param before `signal`/`iteration`, matching each signature's style).

6. **Step-boundary check:** at the top of `executeStep` (after the `pause_requested` check, line ~552), re-verify the policy hash so a change mid-run blocks at the next boundary:

```ts
if (run.policy && run.policy.hash !== policyHash(policy)) {
  const current = await this.policies.get(project.policyId ?? 'default');
  const message =
    `Policy ${current.id} changed (v${run.policy.version} → v${current.version}) while run ${runId} was in flight. ` +
    'Retry the project to fork a new run under the current policy.';
  await this.emit(project.id, 'policy.violation', message, {
    runId,
    nodeId,
    data: { field: 'policyHash', expected: run.policy.hash, actual: policyHash(current) },
  });
  throw new PolicyViolationError(message, ['policy-changed-mid-run']);
}
```

Wait — `policy` here is the object resolved at `runProject` entry, so comparing it to itself can't detect a change. The step-boundary check must **re-resolve**: `const current = await this.policies.get(project.policyId ?? 'default');` first, then compare `run.policy.hash !== policyHash(current)`. Implement it that way (the snippet above shows the emit/throw shape; the comparison uses `current`).

7. `executeAgentStep`: `const profile = buildTaskProfile({ step, harness, artifacts: inputArtifacts, policy });`

8. `executeVerifyStep`: pass `policy` in the `verifier.verify` input object.

9. `pauseSnapshot` (line 316): add `policy: ProjectPolicy` param; add `policyHash: policyHash(policy),` to the returned snapshot. `finalizePause` gains the same param; both `runProject` call sites pass `policy`.

- [ ] **Step 6: ProjectService changes** — `packages/orchestrator/src/project-service.ts`:

1. Constructor: add `private readonly policies: PolicyRepository,` immediately after `workflows`. Import `policyHash` from `./idempotency.js`.
2. `create` (line 65): after `await this.workflows.get(input.workflowId);` add `await this.policies.get(input.policyId);` and set `policyId: input.policyId,` on the `project` object (after `workflowId`).
3. `resumeDiagnostics` (line 609): after the harness-version check:

```ts
if (snapshot.policyHash) {
  const project = await this.requireProject(run.projectId);
  const policy = await this.policies.get(project.policyId ?? 'default');
  const actualPolicyHash = policyHash(policy);
  if (actualPolicyHash !== snapshot.policyHash) {
    diagnostics.push({
      field: 'policyVersion',
      expected: snapshot.policyHash,
      actual: actualPolicyHash,
    });
  }
}
```

- [ ] **Step 7: Harness support** — `packages/orchestrator/src/testing/harness.ts`:

```ts
export const DEFAULT_POLICY: ProjectPolicy = ProjectPolicySchema.parse({
  schemaVersion: '1',
  id: 'default',
  version: 1,
});

export class InMemoryPolicies implements PolicyRepository {
  constructor(public policy: ProjectPolicy) {}
  get(policyId: string): Promise<ProjectPolicy> {
    if (policyId !== this.policy.id) {
      return Promise.reject(new NotFoundError(`Policy ${policyId} not found`));
    }
    return Promise.resolve({ ...this.policy });
  }
}
```

- `makeHarness` opts gain `policy?: ProjectPolicy`; build `const policies = new InMemoryPolicies(opts.policy ?? DEFAULT_POLICY);`; pass `policies` to both `WorkflowOrchestrator` and `ProjectService` constructors (after `workflows`); include `policies` in the returned object.
- Capture verifier inputs for assertions: change the stub verifier to record its input — `const verifierInputs: Array<{ policy?: ProjectPolicy | undefined }> = [];` and inside `verify: (input) => { verifierInputs.push(input); return Promise.resolve({...}); }`; return `verifierInputs` from `makeHarness`.
- `seedRun` project fixture: add `policyId: 'default',`.
- Fix `packages/orchestrator/src/cancellation.test.ts` (~lines 503, 523): pass a `new InMemoryPolicies(DEFAULT_POLICY)` in the new constructor slot (import both from `./testing/harness.js`).

- [ ] **Step 8: Run the orchestrator suite**

Run: `npx vitest run packages/orchestrator`
Expected: PASS — new policy tests green, all existing run-control/approval/failure-injection/cancellation tests still green.

- [ ] **Step 9: Commit** (coordinator, after review)

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): resolve, stamp and enforce ProjectPolicy across run lifecycle"
```

---

### Task 6: Composition wiring, default policy file, config (after Tasks 4+5)

**Files:**

- Modify: `packages/composition/src/config.ts`
- Modify: `packages/composition/src/runtime.ts`
- Modify: `packages/composition/src/config.test.ts`
- Create: `policies/default.yaml`

**Interfaces:**

- Consumes: `YamlPolicyRepository` (Task 4), new constructor slots (Task 5).
- Produces: `RuntimeConfig.policiesDir: string` (env `POLICIES_DIR`, default `policies`); `Runtime.policies: YamlPolicyRepository`.

- [ ] **Step 1: Write the failing test** — add to `packages/composition/src/config.test.ts` (mirror existing dir-resolution assertions in that file):

```ts
it('defaults POLICIES_DIR to <root>/policies and honors overrides', () => {
  expect(loadRuntimeConfig(baseEnv()).policiesDir).toBe(resolve(root, 'policies'));
  expect(loadRuntimeConfig({ ...baseEnv(), POLICIES_DIR: 'custom/policies' }).policiesDir).toBe(
    resolve(root, 'custom/policies'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/composition/src/config.test.ts`
Expected: FAIL — `policiesDir` undefined.

- [ ] **Step 3: Implement**

`config.ts`: `POLICIES_DIR: z.string().default('policies'),` in `ConfigSchema`; `policiesDir: string;` in `RuntimeConfig`; `policiesDir: resolve(rootDir, parsed.POLICIES_DIR),` in the return.

`runtime.ts`: import `YamlPolicyRepository` from `@agent-foundry/persistence`; `const policies = new YamlPolicyRepository(config.policiesDir);` next to `workflows`; pass `policies` into `WorkflowOrchestrator` and `ProjectService` (after `workflows` arg); add `policies: YamlPolicyRepository;` to the `Runtime` interface and returned object.

`policies/default.yaml` (permissive — existing flows keep working, hash still recorded):

```yaml
schemaVersion: '1'
id: default
version: 1
forbiddenDependencies: []
```

- [ ] **Step 4: Run composition tests + integration**

Run: `npx vitest run packages/composition`
Expected: PASS, including `runtime.integration.test.ts` (it builds a real runtime; the default policy file must parse).

- [ ] **Step 5: Commit**

```bash
git add packages/composition policies
git commit -m "feat(composition): wire YamlPolicyRepository and ship permissive default policy"
```

---

### Task 7: ADR, full gate, PR, review loop, evidence

**Files:**

- Create: `docs/adr/0014-project-policy-enforcement.md`

- [ ] **Step 1: Write ADR** `docs/adr/0014-project-policy-enforcement.md` following `docs/adr/0000-template.md` format (check its headings and mirror them). Content to cover: context (hard constraints can't live in prompts — issue #15); decision (per-project versioned YAML policies in `policies/`, selected by `CreateProjectRequest.policyId`, content-hash pinned per run; enforcement points: router pre-execution, orchestrator run-start + step boundaries, verifier post-execution); consequences (mid-run policy edits require project retry = fork; exact-name dependency matching only — lockfile scan deferred; single `policies/` dir, no per-project policy storage); rollback (revert wiring — optional fields on persisted entities mean old data keeps parsing; removing the feature requires no migration).

- [ ] **Step 2: Full verification gate**

Run: `npm run check`
Expected: format:check, lint, architecture:check, roadmap:check, typecheck, test (unit + scripts), build — all PASS. Fix anything that fails before proceeding.

- [ ] **Step 3: Commit ADR + plan doc, push branch, open PR**

```bash
git add docs
git commit -m "docs(adr): ADR 0014 project policy enforcement"
git push -u origin feat/15-project-policy
gh pr create --title "feat(policy): define and enforce ProjectPolicy for stack, providers and dependencies" --body "$(cat <<'EOF'
Closes #15

## What
- `ProjectPolicy` (schemaVersion/id/version + requiredStack, allowedProviders, forbiddenDependencies, allowedCommands) loaded from `policies/<id>.yaml`, selected per project via `CreateProjectRequest.policyId` (default `default`).
- Router rejects policy-forbidden providers with reason `provider <p> is forbidden by policy <id>@v<n>` recorded in `RouteDecision.rejected`.
- Verifier blocks scripts outside `allowedCommands` (never executed) and fails the report on forbidden dependencies (`policy-dependency-check`).
- Each run stamps `{id, version, hash}`; a mid-run policy content change emits `policy.violation` and fails the run — retrying the project forks a new run under the new policy. Pause snapshots pin `policyHash`; resume is blocked on drift.

## Acceptance criteria evidence
(paste `npm run check` tail + the six policy-enforcement test names with PASS output here)

## Safety / migration / rollback
- All new persisted fields are optional; existing projects/runs parse unchanged (no migration).
- Default policy is permissive; behavior changes only when a policy restricts something.
- Rollback: revert the PR; persisted `policy`/`policyId` fields are ignored by older schemas readers? No — older code parses unknown fields via zod `.strict()` on WorkflowRun... verify and state the actual rollback story from the ADR.
- No new permissions, no network, no secret exposure; policy files are local YAML.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(Before posting: replace the placeholder lines with real command output; resolve the rollback sentence against the ADR — `WorkflowRunSchema` is `.strict()`, so document that rolling back code requires leaving the written `policy` field tolerated or stripping it; verify which and state it truthfully.)

- [ ] **Step 4: Review loop** — run `/ponytail:ponytail-review` and `/simplify` on the branch diff; address every finding (fix or explicitly justify); re-run `npm run check`; push.

- [ ] **Step 5: Evidence on issue #15** — `gh issue comment 15 --body ...` containing: PR link; pasted test output for the three mandatory blocks (provider blocked with policy reason, forbidden package failing `policy-dependency-check`, disallowed command blocked without execution); the `policy.violation` event trace from the mid-run-change test; note that `docs/DEFINITION_OF_DONE.md` items are satisfied (tests, ADR 0014, rollback documented, no sensitive data).

---

## Verification (end-to-end)

1. `npm run check` — full deterministic gate.
2. Targeted suites: `npx vitest run packages/contracts packages/model-router packages/executors packages/persistence packages/orchestrator packages/composition`.
3. Manual smoke (mock executors): `EXECUTOR_MODE=mock RUN_WORKER_INLINE=true npm run dev --workspace @agent-foundry/api`, then `POST /api/projects` with `{"policyId": "default", ...}` → run completes and `GET` run detail shows `run.policy.{id,version,hash}`; edit `policies/default.yaml` (bump `version`) while a second project is paused → resume returns `ResumeBlockedError` with a `policyVersion` diagnostic.
4. Evidence captured from steps 1–3 goes into the PR body and the issue comment.

## Self-review notes

- Spec coverage: requiredStack (orchestrator run-start check), allowedProviders (router + TaskProfile.policy audit), forbiddenDependencies (verifier), allowedCommands (verifier); versioning + hash on run (PolicyRecord via policyHash); mid-run change → fork (enforceRunPolicy + step-boundary re-resolve + resume diagnostic). Mandatory tests all present (Tasks 2, 3, 5).
- Type consistency: `PolicyRepository.get(policyId)` used by orchestrator, service, harness, runtime; `policyHash` shared by orchestrator + service; constructor slot is "after `workflows`" in all four construction sites (runtime.ts, harness.ts, cancellation.test.ts ×2).
- Known ceilings marked `ponytail:`: exact-name dependency matching (no lockfile/transitive scan); policy re-resolution per step boundary costs one YAML read per step (file-cached by OS; cache if it bites).
