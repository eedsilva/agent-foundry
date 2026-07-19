# Issue #64 Quality Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist attributable quality observations for deterministic checks, blind LLM review, human edits, and post-merge regressions, then use their separate components in model routing without losing the raw evidence.

**Architecture:** Introduce an append-only `QualityObservation` contract and repository, keyed by the producing artifact's route identity. The router reads raw observations, derives independently visible source components, and uses a fixed, documented weighted quality score only when observations exist; legacy metrics remain the fallback. Orchestrator records verifier and reviewer observations, removes producer metadata from reviewer prompts, and exposes a narrow API for delayed human-edit and post-merge-regression signals.

**Tech Stack:** TypeScript, Zod, Vitest, Fastify, file-backed persistence, existing npm workspaces.

## Global Constraints

- Work only on `feat/issue-64-quality-signals`; never push directly to `main`.
- Add no dependencies; use existing Zod, Vitest, Fastify, and file persistence helpers.
- Store every raw observation append-only and return it alongside every derived component; aggregate values must not replace evidence.
- Use fixed source weights only in `packages/model-router/src/quality-signals.ts`: deterministic `0.50`, blind-review `0.25`, human-edit `0.15`, post-merge-regression `0.10`; normalize across present sources.
- Keep deterministic checks and LLM review as separate named components in both the contract and routing result.
- Reviewer prompts must omit producer artifact metadata (`createdBy`, route information, and actor metadata); artifact content remains available for review.
- Delayed observations must resolve the exact producer artifact revision and its `routeDecision`; reject requests that cannot be attributed to a routed model.
- Evidence must be bounded structured metadata or artifact references; never persist credentials, raw CLI output, or workspace paths.
- Cover new behavior test-first: run each focused test red before implementation, then green; retain one focused automated check for every non-trivial branch.
- Add an ADR because this changes persistence, routing, and a public API contract.

---

## File Structure

- `packages/contracts/src/quality.ts` — versioned observation, evidence, subject, and summary schemas shared by persistence, routing, and HTTP input.
- `packages/domain/src/ports.ts` — `QualityObservationRepository` dependency boundary.
- `packages/persistence/src/quality-observation-repository.ts` — append-only JSON repository under `DATA_DIR/quality/observations.json`.
- `packages/model-router/src/quality-signals.ts` — pure source grouping and weighted score derivation.
- `packages/orchestrator/src/quality-observation-service.ts` — translates verifier/reviewer/delayed outcomes into attributed observations.
- `apps/api/src/app.ts` — POST ingress for attributable delayed signals.
- `docs/adr/0024-quality-observations.md` and `docs/MODEL_ROUTING.md` — durable decision, operational behavior, and rollback.

### Task 1: Versioned contract and append-only repository

**Files:**

- Create: `packages/contracts/src/quality.ts`
- Create: `packages/contracts/src/quality.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/domain/src/ports.ts`
- Create: `packages/persistence/src/quality-observation-repository.ts`
- Create: `packages/persistence/src/quality-observation-repository.test.ts`
- Modify: `packages/persistence/src/index.ts`

**Interfaces:**

- Produces `QualityObservation`, `QualityObservationInput`, `QualitySignalSummary`, and `QualityObservationRepository`.
- `QualityObservationRepository.list(query)` returns historical observations with the same producing model, task kind, role, taxonomy version, and category. Each returned observation retains its exact artifact reference for auditability.
- Later tasks use these exact source names: `deterministic`, `blind-review`, `human-edit`, and `post-merge-regression`.

- [ ] **Step 1: Write the failing contract and repository tests**

```ts
it('requires evaluator, blind flag, rubric, score, and evidence', () => {
  expect(() => QualityObservationSchema.parse({ source: 'deterministic' })).toThrow();
});

it('appends and lists only observations for the exact routed artifact', async () => {
  await repository.record(observation({ id: 'quality-1' }));
  await repository.record(observation({ id: 'quality-2', subject: otherSubject }));

  await expect(repository.list(subject)).resolves.toEqual([observation({ id: 'quality-1' })]);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx vitest run packages/contracts/src/quality.test.ts packages/persistence/src/quality-observation-repository.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because `quality.ts` and `quality-observation-repository.ts` do not exist.

- [ ] **Step 3: Add the minimal shared contract and port**

```ts
export const QualityObservationSourceSchema = z.enum([
  'deterministic',
  'blind-review',
  'human-edit',
  'post-merge-regression',
]);

export const QualityObservationSchema = z
  .object({
    id: PathSegmentSchema,
    source: QualityObservationSourceSchema,
    subject: QualitySubjectSchema,
    evaluator: QualityEvaluatorSchema,
    blind: z.boolean(),
    rubric: z.string().trim().min(1),
    score: z.number().min(0).max(1),
    evidence: z.array(QualityEvidenceSchema).min(1),
    observedAt: z.string().datetime(),
  })
  .strict();

export interface QualityObservationRepository {
  record(observation: QualityObservation): Promise<void>;
  list(subject: QualitySubject): Promise<QualityObservation[]>;
}
```

Define `QualitySubjectSchema` with `modelId`, `taskKind`, `role`, `taxonomyVersion`, `category`, and an `ArtifactReferenceSchema` artifact. Define strict evaluator and evidence schemas with a short identifier plus an optional artifact reference or sanitized message. Export `quality.ts` from contracts and the port from `packages/domain/src/ports.ts`.

- [ ] **Step 4: Implement the file repository**

```ts
export class FileQualityObservationRepository implements QualityObservationRepository {
  constructor(private readonly dataDir: string) {}

  async record(observation: QualityObservation): Promise<void> {
    await withDirectoryLock(`${this.path()}.lock`, async () => {
      const file = await this.read();
      if (!file.observations.some((item) => item.id === observation.id)) {
        file.observations.push(QualityObservationSchema.parse(observation));
        await atomicWriteJson(this.path(), file);
      }
    });
  }

  async list(subject: QualitySubject): Promise<QualityObservation[]> {
    return (await this.read()).observations.filter((item) => sameSubject(item.subject, subject));
  }
}
```

Use `readJsonOrNull`, `atomicWriteJson`, and `withDirectoryLock` from `fs-utils.ts`. Persist `{ observations: [] }` at `quality/observations.json`; return chronological insertion order and make repeated ids idempotent. Export the repository from the persistence barrel.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `npx vitest run packages/contracts/src/quality.test.ts packages/persistence/src/quality-observation-repository.test.ts --pool=threads --maxWorkers=1`

Expected: PASS with schema validation, append-only persistence, idempotency, and exact-subject filtering verified.

- [ ] **Step 6: Commit the contract and repository**

```bash
git add packages/contracts/src/quality.ts packages/contracts/src/quality.test.ts packages/contracts/src/index.ts packages/domain/src/ports.ts packages/persistence/src/quality-observation-repository.ts packages/persistence/src/quality-observation-repository.test.ts packages/persistence/src/index.ts
git commit -m "feat: persist quality observations"
```

### Task 2: Separate quality components in routing

**Files:**

- Create: `packages/model-router/src/quality-signals.ts`
- Create: `packages/model-router/src/quality-signals.test.ts`
- Modify: `packages/model-router/src/score-router.ts`
- Modify: `packages/model-router/src/score-router.test.ts`
- Modify: `packages/model-router/src/index.ts`

**Interfaces:**

- Consumes `QualityObservationRepository.list(query)` from Task 1.
- Produces `QualitySignalSummary` with raw observations, one optional average per source, and an optional normalized aggregate.
- `ScoreBasedModelRouter` accepts the repository as an optional third constructor argument so existing callers retain legacy metric behavior until composition wires the repository.

- [ ] **Step 1: Write failing router tests**

```ts
it('keeps deterministic and blind-review components distinct while routing on their weighted aggregate', async () => {
  const router = new ScoreBasedModelRouter(models, metrics, observations);
  const route = await router.route(profile);

  expect(route.selected.quality?.components.deterministic?.average).toBe(1);
  expect(route.selected.quality?.components.blindReview?.average).toBe(0);
  expect(route.selected.quality?.observations).toHaveLength(2);
});

it('does not let an aggregate erase raw delayed human and regression evidence', () => {
  const summary = summarizeQualityObservations(observations);
  expect(summary.observations.map((item) => item.source)).toEqual([
    'human-edit',
    'post-merge-regression',
  ]);
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx vitest run packages/model-router/src/quality-signals.test.ts packages/model-router/src/score-router.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because the summary, optional ranked-model quality field, and repository injection do not exist.

- [ ] **Step 3: Implement pure source grouping and the fixed weight calculation**

```ts
const SOURCE_WEIGHTS = {
  deterministic: 0.5,
  'blind-review': 0.25,
  'human-edit': 0.15,
  'post-merge-regression': 0.1,
} as const;

export function summarizeQualityObservations(
  observations: QualityObservation[],
): QualitySignalSummary {
  const components = summarizeComponents(observations);
  const present = Object.entries(SOURCE_WEIGHTS).filter(
    ([source]) => components[source as QualityObservationSource] !== undefined,
  );
  const totalWeight = present.reduce(
    (sum, [source]) => sum + SOURCE_WEIGHTS[source as QualityObservationSource],
    0,
  );
  const aggregate =
    totalWeight === 0
      ? undefined
      : present.reduce(
          (sum, [source]) =>
            sum +
            components[source as QualityObservationSource]!.average *
              SOURCE_WEIGHTS[source as QualityObservationSource],
          0,
        ) / totalWeight;
  return { observations, components, ...(aggregate === undefined ? {} : { aggregate }) };
}
```

Use `blindReview` as the public component key while retaining `blind-review` as the immutable observation source. Preserve chronological raw observations without mutation. Add `quality?: QualitySignalSummary` to `RankedModelSchema`, retaining optional compatibility for existing route decisions.

- [ ] **Step 4: Integrate quality summaries into `ScoreBasedModelRouter`**

```ts
const observations = this.qualityObservations
  ? await this.qualityObservations.list(qualitySubject(model.id, profile))
  : [];
const quality = observations.length ? summarizeQualityObservations(observations) : undefined;
ranked.push({
  model,
  score: this.score(model, profile, metric, quality?.aggregate),
  ...(quality ? { quality } : {}),
});
```

When a quality aggregate exists, use it for `qualityHistory`; otherwise retain the current `qualityEvaluations` / `qualityApprovals` calculation exactly. Keep execution success, latency, cost, policy rejection, and fallback behavior unchanged.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `npx vitest run packages/model-router/src/quality-signals.test.ts packages/model-router/src/score-router.test.ts --pool=threads --maxWorkers=1`

Expected: PASS with deterministic and LLM components separately observable, weights normalized only over present sources, and legacy metric routing unchanged without the repository.

- [ ] **Step 6: Commit routing changes**

```bash
git add packages/model-router/src/quality-signals.ts packages/model-router/src/quality-signals.test.ts packages/model-router/src/score-router.ts packages/model-router/src/score-router.test.ts packages/model-router/src/index.ts packages/contracts/src/quality.ts
git commit -m "feat: route from separate quality signals"
```

### Task 3: Capture blind reviewer and deterministic observations

**Files:**

- Create: `packages/orchestrator/src/quality-observation-service.ts`
- Create: `packages/orchestrator/src/quality-observation-service.test.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/prompt-compiler.ts`
- Modify: `packages/orchestrator/src/prompt-compiler.test.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**

- Consumes a producing `StoredArtifact` with `metadata.routeDecision` plus a verifier or reviewer output artifact.
- `QualityObservationService.recordDeterministic` records `source: 'deterministic'`, `blind: false`, rubric `workspace-verifier`, and a score derived from `VerificationReport.approved`.
- `QualityObservationService.recordBlindReview` records `source: 'blind-review'`, `blind: true`, rubric `workflow-review`, and a score derived from the reviewer approval result.
- Optional injection at the end of existing constructors preserves all existing test harnesses that do not configure quality observations.

- [ ] **Step 1: Write failing service and blind-prompt tests**

````ts
it('records verifier and blind reviewer observations against the same producer artifact', async () => {
  await service.recordDeterministic(producer, verification);
  await service.recordBlindReview(producer, review);

  expect(repository.values.map((item) => [item.source, item.blind, item.subject.artifact])).toEqual(
    [
      ['deterministic', false, producerReference],
      ['blind-review', true, producerReference],
    ],
  );
});

it('does not disclose producer metadata in a reviewer request', () => {
  expect(request).not.toContain('developer:codex/gpt-5');
  expect(request).not.toContain('Created by:');
  expect(request).toContain('```json');
});
````

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/quality-observation-service.test.ts packages/orchestrator/src/prompt-compiler.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because the observation service and reviewer-specific prompt rendering do not exist.

- [ ] **Step 3: Implement capture and prompt redaction**

```ts
const isReviewer = ['plan-reviewer', 'architecture-reviewer', 'code-reviewer'].includes(
  input.step.role,
);
const artifactHeading = isReviewer
  ? `### Input artifact · revision ${artifact.metadata.revision}`
  : `### ${artifact.metadata.name} · revision ${artifact.metadata.revision}\n\nCreated by: ${artifact.metadata.createdBy}`;
```

Keep artifact content, revision, and SHA visible. Do not serialize `ArtifactMetadata.routeDecision`; it is already absent from request JSON and must remain absent. In `executeQualityLoop`, record a deterministic observation when `check.type === 'verify'`, and record a blind-review observation when `check.type === 'agent'` with a reviewer role. Both observations must target `qualitySubject`, not the check artifact.

- [ ] **Step 4: Wire the repository in composition**

```ts
const qualityObservations = new FileQualityObservationRepository(config.dataDir);
const router = new ScoreBasedModelRouter(catalog, metrics, qualityObservations);
const qualityObservationService = new QualityObservationService(qualityObservations, clock, ids);
```

Expose the repository and service through `Runtime`, then inject the service as the final optional `WorkflowOrchestrator` dependency.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `npx vitest run packages/orchestrator/src/quality-observation-service.test.ts packages/orchestrator/src/prompt-compiler.test.ts packages/orchestrator/src/workflow-orchestrator.test.ts --pool=threads --maxWorkers=1`

Expected: PASS with deterministic/verifier and blind/reviewer observations attributed to the same source artifact, plus no producer metadata in a reviewer request.

- [ ] **Step 6: Commit capture and composition wiring**

```bash
git add packages/orchestrator/src/quality-observation-service.ts packages/orchestrator/src/quality-observation-service.test.ts packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/prompt-compiler.ts packages/orchestrator/src/prompt-compiler.test.ts packages/orchestrator/src/index.ts packages/composition/src/runtime.ts
git commit -m "feat: capture verifier and blind review quality"
```

### Task 4: Delayed-signal API, documentation, and end-to-end evidence

**Files:**

- Modify: `packages/contracts/src/api.ts`
- Modify: `packages/contracts/src/api.test.ts`
- Modify: `packages/orchestrator/src/project-service.ts`
- Modify: `packages/orchestrator/src/project-service.test.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/quality-observations.test.ts`
- Create: `docs/adr/0024-quality-observations.md`
- Modify: `docs/MODEL_ROUTING.md`

**Interfaces:**

- `POST /projects/:projectId/quality-observations` accepts a validated `QualityObservationInput` with source `human-edit` or `post-merge-regression`.
- The service resolves the precise artifact revision, reads its producer `routeDecision`, then delegates to `QualityObservationService.recordDelayed`.
- The endpoint returns the stored immutable `QualityObservation` with HTTP 201.

- [ ] **Step 1: Write failing API and complete-evidence tests**

```ts
it('accepts delayed human-edit and post-merge-regression signals only for a routed artifact', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/projects/${projectId}/quality-observations`,
    payload: delayedSignal,
  });

  expect(response.statusCode).toBe(201);
  expect(JSON.parse(response.body).observation.source).toBe('human-edit');
});

it('shows verifier, blind-review, and human observations for one output', async () => {
  expect((await runtime.qualityObservations.list(subject)).map((item) => item.source)).toEqual([
    'deterministic',
    'blind-review',
    'human-edit',
  ]);
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npx vitest run packages/contracts/src/api.test.ts packages/orchestrator/src/project-service.test.ts apps/api/src/quality-observations.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because the delayed observation request schema, project-service method, and route do not exist.

- [ ] **Step 3: Implement delayed-signal ingress**

```ts
app.post('/projects/:projectId/quality-observations', async (request, reply) => {
  const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
  const input = QualityObservationInputSchema.parse(request.body);
  const observation = await runtime.projectService.recordDelayedQualityObservation(
    projectId,
    input,
  );
  return reply.status(201).send({ observation });
});
```

Require evidence, rubric, score, and one actor identity in the input. Restrict the source to delayed sources. Return a validation error when the project or referenced artifact is absent, the SHA does not match, or the artifact has no route decision. Do not add a route for direct aggregate writes.

- [ ] **Step 4: Add the ADR and routing documentation**

Document the source weights, raw append-only observation file, metadata-only blind-review protection, exact artifact attribution, delayed ingress, security/privacy limits, migration behavior, and rollback. State that the initial file scan is intentionally simple and should gain an index only when routing volume demonstrates a need.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `npx vitest run packages/contracts/src/api.test.ts packages/orchestrator/src/project-service.test.ts apps/api/src/quality-observations.test.ts --pool=threads --maxWorkers=1`

Expected: PASS with rejected un-routed artifacts and a single-output verifier/blind-review/human evidence path.

- [ ] **Step 6: Run all required validation gates**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run architecture:check && npm run roadmap:check && npm run e2e --workspace @agent-foundry/api`

Expected: every command exits 0. If the known baseline full-Vitest hang recurs, isolate the specific test process and fix only the new test's cleanup before continuing.

- [ ] **Step 7: Commit the API, ADR, and evidence**

```bash
git add packages/contracts/src/api.ts packages/contracts/src/api.test.ts packages/orchestrator/src/project-service.ts apps/api/src/app.ts apps/api/src/quality-observations.test.ts docs/adr/0024-quality-observations.md docs/MODEL_ROUTING.md docs/adr/README.md docs/superpowers/plans/2026-07-18-issue-64-quality-signals.md
git commit -m "feat: accept delayed quality signals"
```

## Plan self-review

- Spec coverage: Task 1 captures evaluator, blind, rubric, score, and evidence. Task 2 separates deterministic and LLM weights without discarding raw components. Task 3 removes producer metadata from reviewer prompts and captures verifier/reviewer results. Task 4 provides attributable delayed human-edit and post-merge-regression ingestion and proves the required three-evaluator path.
- Placeholder scan: no unresolved implementation steps; every code task has a focused red command, minimal green change, focused green command, and commit command.
- Type consistency: all tasks use `QualityObservation`, `QualitySubject`, `QualityObservationInput`, and `QualityObservationRepository`; source strings and component names are fixed in the Global Constraints.
