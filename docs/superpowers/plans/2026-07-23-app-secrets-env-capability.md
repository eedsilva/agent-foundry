# App Secrets via Local .env Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give generated apps a capability-based secrets mechanism backed by a local, never-committed `.env` file per project — the coding agent sees only secret _names_, real values are injected only into the preview/deploy process outside the agent's own execution, and a scanner + tests prove no value ever reaches Git, a prompt, an artifact, a log, or a client bundle.

**Architecture:** A new `SecretStore` port (`names()` / `resolveAll()`) reads `<DATA_DIR>/projects/<projectId>/.env` — a file that lives outside the git-tracked `workspace/` directory and therefore cannot be committed by construction. `WorkflowOrchestrator` populates `ExecutionRequest.secrets` with names only (already-defined `ExecutionSecretRefSchema`, currently unused). `NodePreviewRunner` resolves real values and injects them into the generated app's dev-server process — a process distinct from the coding agent's own CLI subprocess. Both subprocess spawn points (`base-cli-executor.ts` for the coding agent, `node-preview-runner.ts` for the generated app) stop inheriting the control plane's full `process.env` and instead use an explicit safe allowlist. A pattern+exact-value scanner (reusing `packages/domain/src/redaction.ts`'s patterns) backstops source, CI, and build output.

**Tech Stack:** TypeScript, Zod, vitest (packages), `node --test` (root scripts), `dotenv` (already a dependency), `execa`.

## Global Constraints

- No new npm dependency: `dotenv`, `execa`, `zod` already cover every need (ponytail rung 5 — reuse installed deps).
- Reuse `packages/domain/src/redaction.ts`'s `VALUE_PATTERNS`/`SENSITIVE_WORD` regexes for the scanner instead of inventing new ones.
- Reuse the existing `ExecutionSecretRefSchema { name, ref }` in `packages/contracts/src/execution-plane.ts` — do not add a new contract shape for secret capability names.
- `packages/executors` may depend only on `@agent-foundry/contracts` and `@agent-foundry/domain` (enforced by `scripts/lib/architecture.mjs`'s `ALLOWED_INTERNAL_DEPENDENCIES`) — never import `@agent-foundry/persistence` from there. Same rule applies to `@agent-foundry/orchestrator`.
- `WorkflowOrchestrator`'s constructor takes 18 required positional params today; any new dependency must be added as a new **optional trailing param** (matching `modelOverrides?`, `versions?`, `browserVerification?`, `qualityObservations?`, `executors?`) so existing call sites and tests keep compiling unchanged.
- VPS/SSH publish (ADR `0008-existing-vps-compose-deployment.md`) is not implemented anywhere in the repo today and stays out of scope for this issue. The preview/dev-server process (`NodePreviewRunner`) is the concrete "deploy" substrate for Personal v1; the ADR this plan adds must say so explicitly so the future VPS publish work knows to reuse `SecretStore` rather than re-solve secret injection.
- Every step that touches code ends with the exact test command and expected result — no "add appropriate tests" placeholders.

---

## File Structure

| File                                                               | Responsibility                                                                                                                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/src/ports.ts` (modify)                            | Add `SecretStore` port interface.                                                                                                                                       |
| `packages/persistence/src/secret-store.ts` (new)                   | `FileSecretStore`: reads `<projectRoot>/.env`, never touches `process.env`.                                                                                             |
| `packages/persistence/src/secret-store.test.ts` (new)              | Unit tests for `FileSecretStore`.                                                                                                                                       |
| `packages/persistence/src/index.ts` (modify)                       | Export `FileSecretStore`.                                                                                                                                               |
| `packages/executors/src/safe-environment.ts` (new)                 | Shared allowlist + `pickSafeEnvironment()`, used by both subprocess spawn points in this package.                                                                       |
| `packages/executors/src/safe-environment.test.ts` (new)            | Unit tests for the allowlist.                                                                                                                                           |
| `packages/executors/src/base-cli-executor.ts` (modify)             | Coding-agent CLI subprocess always gets a safe, explicit env — never a blanket `process.env` inherit.                                                                   |
| `packages/executors/src/base-cli-executor.test.ts` (modify)        | Add env-scoping assertions.                                                                                                                                             |
| `packages/executors/src/node-preview-runner.ts` (modify)           | Generated-app dev-server subprocess gets safe env + resolved secret values by capability.                                                                               |
| `packages/executors/src/node-preview-runner.test.ts` (modify)      | Add secret-injection + env-scoping assertions.                                                                                                                          |
| `packages/executors/src/fixtures/preview-dev-server.mjs` (modify)  | Add an `/echo-env` route (mirrors the existing `/echo-headers` route) so tests can observe what the spawned process actually received.                                  |
| `packages/orchestrator/src/workflow-orchestrator.ts` (modify)      | Populate `ExecutionRequest.secrets` from `SecretStore.names()` instead of the hardcoded `[]`.                                                                           |
| `packages/orchestrator/src/testing/harness.ts` (modify)            | Add a `FakeSecretStore` test double.                                                                                                                                    |
| `packages/orchestrator/src/workflow-orchestrator.test.ts` (modify) | Add a secrets-population test.                                                                                                                                          |
| `packages/composition/src/runtime.ts` (modify)                     | Instantiate `FileSecretStore` and wire it into `WorkflowOrchestrator` and `NodePreviewRunner`.                                                                          |
| `packages/domain/src/secret-scan.ts` (new)                         | `scanForSecrets(content, knownSecrets)` — pattern + exact-value matcher, reuses `redaction.ts` patterns.                                                                |
| `packages/domain/src/secret-scan.test.ts` (new)                    | Unit tests.                                                                                                                                                             |
| `packages/domain/src/index.ts` (modify)                            | Export `scanForSecrets`.                                                                                                                                                |
| `scripts/lib/secret-scan.mjs` (new)                                | CLI-facing wrapper: walks `git ls-files` + given directories, calls `scanForSecrets`, and separately asserts no `.env`/`.env.*` (except `.env.example`) is git-tracked. |
| `scripts/lib/secret-scan.test.mjs` (new)                           | `node --test` coverage using temp fixtures.                                                                                                                             |
| `scripts/scan-secrets.mjs` (new)                                   | Thin CLI entrypoint (mirrors `scripts/check-architecture.mjs`'s shape).                                                                                                 |
| `package.json` (modify)                                            | Add `secrets:check` script, wire into `check`.                                                                                                                          |
| `.github/workflows/ci.yml` (modify)                                | Add a `secrets` job.                                                                                                                                                    |
| `packages/composition/src/secret-leak.integration.test.ts` (new)   | The AC6-mandated leak-scanner test sweeping Git, prompt, artifact, log, and client-bundle surfaces.                                                                     |
| `docs/adr/0032-app-secret-capabilities.md` (new)                   | Design record.                                                                                                                                                          |
| `docs/OPERATIONS.md` (modify)                                      | Operator instructions: where to put a project's `.env`.                                                                                                                 |
| `.env.example` (modify)                                            | One-paragraph pointer to the new per-project secrets file, so it isn't confused with this repo-root template.                                                           |

---

### Task 1: `SecretStore` port + `FileSecretStore`

**Files:**

- Modify: `packages/domain/src/ports.ts` (append after the `WorkspaceManager` interface, which currently ends at line 486)
- Create: `packages/persistence/src/secret-store.ts`
- Create: `packages/persistence/src/secret-store.test.ts`
- Modify: `packages/persistence/src/index.ts`

**Interfaces:**

- Produces: `SecretStore` port —
  ```ts
  export interface SecretStore {
    names(projectId: string): Promise<string[]>;
    resolveAll(projectId: string): Promise<Record<string, string>>;
  }
  ```
- Produces: `FileSecretStore implements SecretStore`, constructor `(workspaces: Pick<WorkspaceManager, 'projectRoot'>)`.

- [ ] **Step 1: Write the failing test**

Create `packages/persistence/src/secret-store.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSecretStore } from './secret-store.js';

describe('FileSecretStore', () => {
  it('reads declared names and resolved values from <projectRoot>/.env', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-secrets-'));
    const projectRoot = join(dataDir, 'projects', 'project-1');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, '.env'),
      'STRIPE_SECRET_KEY=sk-test-1234567890abcdef\nDATABASE_URL=postgres://x\n',
    );
    const store = new FileSecretStore({ projectRoot: () => projectRoot });

    await expect(store.names('project-1')).resolves.toEqual(['STRIPE_SECRET_KEY', 'DATABASE_URL']);
    await expect(store.resolveAll('project-1')).resolves.toEqual({
      STRIPE_SECRET_KEY: 'sk-test-1234567890abcdef',
      DATABASE_URL: 'postgres://x',
    });
  });

  it('returns empty results when the project has no .env file yet', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-secrets-'));
    const store = new FileSecretStore({ projectRoot: () => join(dataDir, 'projects', 'p2') });

    await expect(store.names('p2')).resolves.toEqual([]);
    await expect(store.resolveAll('p2')).resolves.toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/secret-store.test.ts`
Expected: FAIL — `Cannot find module './secret-store.js'`

- [ ] **Step 3: Add the `SecretStore` port**

In `packages/domain/src/ports.ts`, immediately after the `WorkspaceManager` interface's closing brace (currently line 486, right before `export interface Clock {`), add:

```ts
/**
 * Local-.env-backed secret capabilities for a project (v1: files, not a
 * broker). `names()` is safe to expose to the coding agent's context —
 * it never returns a value. `resolveAll()` must only be called from the
 * process that runs the generated app (preview/deploy), never from
 * anything that builds the agent's prompt, logs, or artifacts.
 */
export interface SecretStore {
  names(projectId: string): Promise<string[]>;
  resolveAll(projectId: string): Promise<Record<string, string>>;
}
```

- [ ] **Step 4: Implement `FileSecretStore`**

Create `packages/persistence/src/secret-store.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseDotEnv } from 'dotenv';
import type { SecretStore, WorkspaceManager } from '@agent-foundry/domain';

export class FileSecretStore implements SecretStore {
  constructor(private readonly workspaces: Pick<WorkspaceManager, 'projectRoot'>) {}

  async names(projectId: string): Promise<string[]> {
    return Object.keys(await this.readEnvFile(projectId));
  }

  async resolveAll(projectId: string): Promise<Record<string, string>> {
    return this.readEnvFile(projectId);
  }

  private async readEnvFile(projectId: string): Promise<Record<string, string>> {
    const path = join(this.workspaces.projectRoot(projectId), '.env');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    return parseDotEnv(raw);
  }
}
```

Add to `packages/persistence/src/index.ts` (after the existing `export * from './workspace-manager.js';` line):

```ts
export * from './secret-store.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/secret-store.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Typecheck the two touched packages**

Run: `npx tsc -b packages/domain packages/persistence --force --pretty false`
Expected: no output, exit code 0

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/ports.ts packages/persistence/src/secret-store.ts packages/persistence/src/secret-store.test.ts packages/persistence/src/index.ts
git commit -m "feat(persistence): add FileSecretStore backed by a per-project .env file"
```

---

### Task 2: Safe environment allowlist for the coding-agent CLI subprocess

**Files:**

- Create: `packages/executors/src/safe-environment.ts`
- Create: `packages/executors/src/safe-environment.test.ts`
- Modify: `packages/executors/src/base-cli-executor.ts:136`
- Modify: `packages/executors/src/base-cli-executor.test.ts`

**Context:** Today, `executeInvocation` (base-cli-executor.ts:124-137) only sets `env:` on the spawned CLI subprocess when a provider explicitly supplies `invocation.environment` — every provider except the codex debug-log case leaves it unset, so execa's default takes over and the coding agent's CLI subprocess inherits the **entire** control-plane process environment unfiltered, including this app's own `DATABASE_URL`, `BLOB_SIGNING_SECRET`, etc. This is the concrete leak this task closes. `invocation.environment` still wins for provider-specific keys (e.g. `RUST_LOG`).

**Interfaces:**

- Produces: `pickSafeEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`, used by this task and by Task 4.

- [ ] **Step 1: Write the failing test**

Create `packages/executors/src/safe-environment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pickSafeEnvironment } from './safe-environment.js';

describe('pickSafeEnvironment', () => {
  it('keeps only the OS/tooling allowlist and drops everything else', () => {
    const result = pickSafeEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      LANG: 'en_US.UTF-8',
      DATABASE_URL: 'postgres://leak',
      STRIPE_SECRET_KEY: 'sk-leak',
      BLOB_SIGNING_SECRET: 'leak',
    });
    expect(result).toEqual({ PATH: '/usr/bin', HOME: '/home/agent', LANG: 'en_US.UTF-8' });
  });

  it('omits allowlisted keys that are simply absent from the source', () => {
    expect(pickSafeEnvironment({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/safe-environment.test.ts`
Expected: FAIL — `Cannot find module './safe-environment.js'`

- [ ] **Step 3: Implement `pickSafeEnvironment`**

Create `packages/executors/src/safe-environment.ts`:

```ts
// Deny-by-default: only the OS/tooling variables a spawned child needs to
// start and find its own config. Never includes an application secret —
// see docs/adr/0032-app-secret-capabilities.md.
const SAFE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'NODE_ENV',
  'SystemRoot',
  'ComSpec',
  'USERPROFILE',
  'APPDATA',
]);

export function pickSafeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => SAFE_ENV_ALLOWLIST.has(key)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/safe-environment.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing executor test**

In `packages/executors/src/base-cli-executor.test.ts`, find the existing test that asserts on the `execa` call args (search for `mocked.mock.calls[0]` or similar — the file mocks `execa`). Add:

```ts
it('never inherits the control plane process env into the CLI subprocess', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://control-plane-only-leak-canary';
  try {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await new FixtureExecutor(1_000_000).execute(request);

    const [, , options] = execaMock.mock.calls[0];
    expect(options.env).toBeDefined();
    expect(options.env).not.toHaveProperty('DATABASE_URL');
    expect(Object.keys(options.env).length).toBeGreaterThan(0);
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
```

Reuses this file's existing module-level `execaMock` (`vi.hoisted(() => ({ execaMock: vi.fn() }))`, base-cli-executor.test.ts:16), `FixtureExecutor` class, and `request` fixture object (all defined near the top of the file, used the same way by the file's other tests, e.g. `'keeps the selected model and records the model reported by the provider'`).

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/base-cli-executor.test.ts -t "never inherits"`
Expected: FAIL — `options.env` is `undefined` (no `env` key currently passed for this provider)

- [ ] **Step 7: Make the executor always pass a safe env**

In `packages/executors/src/base-cli-executor.ts`, add the import:

```ts
import { pickSafeEnvironment } from './safe-environment.js';
```

Change line 136 from:

```ts
        ...(invocation.environment ? { env: cleanEnvironment(invocation.environment) } : {}),
```

to:

```ts
        env: cleanEnvironment({ ...pickSafeEnvironment(), ...invocation.environment }),
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/base-cli-executor.test.ts`
Expected: PASS, including the new test and every pre-existing test in the file

- [ ] **Step 9: Commit**

```bash
git add packages/executors/src/safe-environment.ts packages/executors/src/safe-environment.test.ts packages/executors/src/base-cli-executor.ts packages/executors/src/base-cli-executor.test.ts
git commit -m "fix(executors): stop the coding-agent CLI subprocess inheriting the full control-plane env"
```

---

### Task 3: Populate `ExecutionRequest.secrets` with declared names

**Files:**

- Modify: `packages/orchestrator/src/workflow-orchestrator.ts:126-154` (constructor), `:2375` (request construction)
- Modify: `packages/orchestrator/src/testing/harness.ts` (add `FakeSecretStore`)
- Modify: `packages/orchestrator/src/workflow-orchestrator.test.ts`

**Interfaces:**

- Consumes: `SecretStore` from `@agent-foundry/domain` (Task 1).
- Produces: `WorkflowOrchestrator`'s new optional constructor param `secretStore?: SecretStore`, appended **after** the existing `executors?: Pick<ExecutorRegistry, 'health'>` param (position 24) so every existing positional call site keeps compiling.

- [ ] **Step 1: Write the failing test**

In `packages/orchestrator/src/testing/harness.ts`, add near the other fakes (e.g. after `FakeWorkspaces`):

```ts
export class FakeSecretStore implements SecretStore {
  constructor(private readonly declared: Record<string, string> = {}) {}
  names(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.declared));
  }
  resolveAll(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.declared });
  }
}
```

Add `SecretStore` to this file's existing `@agent-foundry/domain` import list.

`ControllableExecutor` (same file, `class ControllableExecutor implements AgentExecutor, ExecutionPlane`) implements `ExecutionPlane.submit(request: ExecutionRequest, ...)` but immediately narrows to `request.agent` before recording anything in its `readonly requests: AgentExecutionRequest[] = []` field (harness.ts:895, populated inside `executeInternal` at line 965) — so `.secrets` never survives into what a test can inspect today. Add a second capture field that keeps the full request. Find the `async submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {` method (harness.ts:907) and:

1. Add a new field next to `readonly requests: AgentExecutionRequest[] = [];`:
   ```ts
   readonly submittedExecutionRequests: ExecutionRequest[] = [];
   ```
2. As the first line inside `submit`'s body (before `this.states.set(...)`), add:
   ```ts
   this.submittedExecutionRequests.push(request);
   ```

In `packages/orchestrator/src/workflow-orchestrator.test.ts`, change `makeOrchestrator`'s signature (currently `function makeOrchestrator(versions?: ProjectVersionService, executorHealth?: ExecutorHealth[])`) to accept a third optional arg and thread it through:

```ts
function makeOrchestrator(
  versions?: ProjectVersionService,
  executorHealth?: ExecutorHealth[],
  secretStore?: SecretStore,
) {
```

In that function's `new WorkflowOrchestrator(...)` call (currently ending `..., undefined, versions, undefined, undefined, executors,\n  );`), add `secretStore` as a 25th argument after `executors`:

```ts
    executors,
    secretStore,
  );
```

Import `FakeSecretStore` and `SecretStore` type at the top of the test file, then add a new test (near the other execution-request-shape tests in this file):

```ts
it('populates ExecutionRequest.secrets with declared names only, never values', async () => {
  const secretStore = new FakeSecretStore({ STRIPE_SECRET_KEY: 'sk-should-never-appear' });
  const { orchestrator, projects, workspaces } = makeOrchestrator(
    undefined,
    undefined,
    secretStore,
  );
  const project = await projects.create({
    id: 'project-1',
    name: 'Test',
    workflowId: WORKFLOW.id,
  } as Project);
  await orchestrator.runProject(project.id);

  // makeOrchestrator's `executor` is a ControllableExecutor — read the
  // `submittedExecutionRequests` field added to it in this same task's setup.
  const submitted = executor.submittedExecutionRequests.at(-1);
  expect(submitted?.secrets).toEqual([{ name: 'STRIPE_SECRET_KEY', ref: 'STRIPE_SECRET_KEY' }]);
  expect(JSON.stringify(submitted)).not.toContain('sk-should-never-appear');
});
```

`makeOrchestrator` must return `executor` alongside its existing `{ projects, runs, stepRuns, artifacts, events, workspaces, clock, orchestrator, route }` return object (workflow-orchestrator.test.ts:173) — add `executor` to that object literal if it isn't already there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts -t "populates ExecutionRequest.secrets"`
Expected: FAIL — `submitted?.secrets` is `[]`, not the expected array

- [ ] **Step 3: Add the constructor param**

In `packages/orchestrator/src/workflow-orchestrator.ts`, add `SecretStore` to the `@agent-foundry/domain` import list, then change the constructor (currently lines 127-154) by appending a new final param after `executors?`:

```ts
    private readonly executors?: Pick<ExecutorRegistry, 'health'>,
    private readonly secretStore?: SecretStore,
  ) {}
```

- [ ] **Step 4: Populate `secrets` in `executeCandidate`**

At `packages/orchestrator/src/workflow-orchestrator.ts:2375`, replace:

```ts
        secrets: [],
```

with:

```ts
        secrets: this.secretStore
          ? (await this.secretStore.names(project.id)).map((name) => ({ name, ref: name }))
          : [],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts`
Expected: PASS, including every pre-existing test in the file (confirms the new optional param didn't break any positional call site)

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b packages/orchestrator --force --pretty false`
Expected: no output, exit code 0

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/testing/harness.ts packages/orchestrator/src/workflow-orchestrator.test.ts
git commit -m "feat(orchestrator): populate ExecutionRequest.secrets from declared capability names"
```

---

### Task 4: Inject resolved secrets into the preview/deploy process

**Files:**

- Modify: `packages/executors/src/node-preview-runner.ts` (`NodePreviewRunnerOptions`, constructor, `attemptSpawn`)
- Modify: `packages/executors/src/fixtures/preview-dev-server.mjs`
- Modify: `packages/executors/src/node-preview-runner.test.ts`

**Context:** `attemptSpawn` (node-preview-runner.ts:212-222) spawns the generated app's dev server with `env: { ...process.env, PORT, HOST }` — same blanket-inherit problem as Task 2, on the process that actually runs the generated app. This is the "deploy injects `.env` by capability, outside the agent's sandbox" mechanism for Personal v1 (see the ADR in Task 9 for why this process, not a not-yet-built VPS publish path, is the right injection point).

**Interfaces:**

- Consumes: `SecretStore` (Task 1), `pickSafeEnvironment` (Task 2).
- Produces: `NodePreviewRunnerOptions.secretStore?: Pick<SecretStore, 'resolveAll'>`.

- [ ] **Step 1: Add an `/echo-env` fixture route**

In `packages/executors/src/fixtures/preview-dev-server.mjs`, immediately after the existing `/echo-headers` block, add:

```js
if (req.url === '/echo-env') {
  // Echoes the process's own environment, so preview-injection tests can
  // assert exactly which variables the spawned dev server received.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(process.env));
  return;
}
```

- [ ] **Step 2: Write the failing test**

In `packages/executors/src/node-preview-runner.test.ts`, find the existing test that spawns the fixture and hits `/echo-headers` (or a similarly-structured spawn test) to copy its setup pattern, then add:

```ts
it('injects resolved secret values into the dev server process, scoped to a safe base env', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://control-plane-only-leak-canary';
  try {
    const secretStore = {
      resolveAll: async () => ({ STRIPE_SECRET_KEY: 'sk-injected-for-test' }),
    };
    const runner = new NodePreviewRunner({ secretStore });
    let session = await newSession('sess-secret-injection');
    session = {
      ...session,
      commandPlan: {
        packageManager: 'npm',
        install: { ok: true, command: 'npm', args: ['ci'] },
        build: { ok: true, command: 'npm', args: ['run', 'build'] },
        dev: { ok: true, command: 'node', args: [FIXTURE_SCRIPT] },
        detectedAt: new Date().toISOString(),
      },
    };
    session = await startTracked(runner, session);
    const port = session.process!.port!;

    const response = await fetch(`http://127.0.0.1:${port}/echo-env`);
    const env = await response.json();

    expect(env.STRIPE_SECRET_KEY).toBe('sk-injected-for-test');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PORT).toBe(String(port));
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
```

`newSession` (node-preview-runner.test.ts:155) and `startTracked` (node-preview-runner.test.ts:60) are this file's existing helpers — reuse them exactly as the file's other spawn tests do (e.g. the `'common cleanup stops a fixture when the test omits runner.stop'` test at line 223, which builds `commandPlan` the same way). Do not hand-roll a second session-building path.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/node-preview-runner.test.ts -t "injects resolved secret values"`
Expected: FAIL — `env.DATABASE_URL` is defined (current blanket inherit), and/or `NodePreviewRunnerOptions` has no `secretStore` field yet (TS error)

- [ ] **Step 4: Wire the injection**

In `packages/executors/src/node-preview-runner.ts`:

Add to the imports:

```ts
import type { SecretStore } from '@agent-foundry/domain';
import { pickSafeEnvironment } from './safe-environment.js';
```

(Add `SecretStore` to the existing `@agent-foundry/domain` import list rather than a second import statement.)

Extend `NodePreviewRunnerOptions` (currently lines 30-38):

```ts
export interface NodePreviewRunnerOptions {
  reservePort?: () => Promise<number>;
  startupTimeoutMs?: number;
  maxOutputBytes?: number;
  clock?: Clock;
  healthPath?: string;
  logRepository?: PreviewLogRepository;
  installer?: PreviewInstaller;
  secretStore?: Pick<SecretStore, 'resolveAll'>;
}
```

Store it in the constructor (find the existing constructor that assigns `this.installer = options.installer`, etc., and add alongside):

```ts
this.secretStore = options.secretStore;
```

with the corresponding field declaration near the other `private readonly` option fields:

```ts
  private readonly secretStore: Pick<SecretStore, 'resolveAll'> | undefined;
```

Change `attemptSpawn` (currently lines 212-222) so it resolves secrets before spawning:

```ts
  private async attemptSpawn(
    session: PreviewSession,
    dev: { command: string; args: string[] },
  ): Promise<{ port: number; pid: number | undefined; crashedImmediately: boolean }> {
    const reservedPort = await this.reservePort();
    const secrets = this.secretStore
      ? await this.secretStore.resolveAll(session.workspaceRef.projectId)
      : {};
    const child = execa(dev.command, dev.args, {
      cwd: session.workspaceRef.workspacePath,
      env: {
        ...pickSafeEnvironment(),
        ...secrets,
        PORT: String(reservedPort),
        HOST: '127.0.0.1',
      },
      reject: false,
      detached: process.platform !== 'win32',
    }) as unknown as DevServerProcess;
```

Leave the rest of `attemptSpawn` unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/node-preview-runner.test.ts`
Expected: PASS, including every pre-existing test in the file

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b packages/executors --force --pretty false`
Expected: no output, exit code 0

- [ ] **Step 7: Commit**

```bash
git add packages/executors/src/node-preview-runner.ts packages/executors/src/node-preview-runner.test.ts packages/executors/src/fixtures/preview-dev-server.mjs
git commit -m "feat(executors): inject resolved project secrets into the preview dev-server process only"
```

---

### Task 5: Wire `FileSecretStore` into the composition root

**Files:**

- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**

- Consumes: `FileSecretStore` (Task 1), `WorkflowOrchestrator`'s new param (Task 3), `NodePreviewRunnerOptions.secretStore` (Task 4).

- [ ] **Step 1: Instantiate the store and expose it on `Runtime`**

In `packages/composition/src/runtime.ts`, add `FileSecretStore` to the existing `@agent-foundry/persistence` import list. Immediately after the existing `const workspaces = new FileWorkspaceManager(...)` block (around line 196-199), add:

```ts
const secretStore = new FileSecretStore(workspaces);
```

Add `secretStore: FileSecretStore;` to the `Runtime` interface (runtime.ts:92-136), next to the existing `workspaces: FileWorkspaceManager;` line. Add `secretStore,` to the function's final returned object literal (runtime.ts:380-424), next to the existing `workspaces,` line.

- [ ] **Step 2: Pass it to `NodePreviewRunner`**

In the existing `const previewRunner = new NodePreviewRunner({ ... })` call (around lines 225-237), add `secretStore` to the options object:

```ts
const previewRunner = new NodePreviewRunner({
  startupTimeoutMs: config.previewStartupTimeoutMs,
  maxOutputBytes: config.maxCliOutputBytes,
  healthPath: config.previewHealthPath,
  logRepository: previewLogs,
  secretStore,
  ...(config.executorMode === 'real' && overrides.previewInstaller !== null
    ? {
        installer:
          overrides.previewInstaller ??
          new DockerPreviewInstaller({ runner: new DockerSandboxRunner() }),
      }
    : {}),
});
```

- [ ] **Step 3: Pass it to `WorkflowOrchestrator`**

In the existing `const orchestrator = new WorkflowOrchestrator(...)` call (around lines 284-311), add `secretStore` as the new final argument after `executors`:

```ts
    executors,
    secretStore,
  );
```

- [ ] **Step 4: Run the composition package's existing tests**

Run: `npx vitest run packages/composition`
Expected: PASS — every pre-existing test in the package still passes (this task adds no new test file; Task 8 is where the wiring gets exercised end-to-end)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b packages/composition --force --pretty false`
Expected: no output, exit code 0

- [ ] **Step 6: Commit**

```bash
git add packages/composition/src/runtime.ts
git commit -m "feat(composition): wire FileSecretStore into the orchestrator and preview runner"
```

---

### Task 6: Secret-scan matcher (pattern + exact-value)

**Files:**

- Create: `packages/domain/src/secret-scan.ts`
- Create: `packages/domain/src/secret-scan.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface SecretMatch {
    kind: 'pattern' | 'exact-value';
    index: number;
  }
  export function scanForSecrets(content: string, knownSecrets?: string[]): SecretMatch[];
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/domain/src/secret-scan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scanForSecrets } from './secret-scan.js';

describe('scanForSecrets', () => {
  it('finds a known-shape secret pattern with no known-value list', () => {
    const matches = scanForSecrets('const key = "sk-abcdefghijklmnopqrstuvwx";');
    expect(matches).toEqual([{ kind: 'pattern', index: 12 }]);
  });

  it('finds an exact known secret value that matches no known pattern', () => {
    const matches = scanForSecrets('DATABASE_URL=custom-opaque-value-12345', [
      'custom-opaque-value-12345',
    ]);
    expect(matches).toEqual([{ kind: 'exact-value', index: 13 }]);
  });

  it('returns no matches for ordinary content', () => {
    expect(scanForSecrets('export const PORT = 3000;', ['unrelated-secret'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/domain/src/secret-scan.test.ts`
Expected: FAIL — `Cannot find module './secret-scan.js'`

- [ ] **Step 3: Implement `scanForSecrets`**

Create `packages/domain/src/secret-scan.ts`:

```ts
// Reuses redaction.ts's shape-based patterns (they're the repo's one
// source of truth for what a secret *looks like*) and adds exact-value
// matching against secrets whose real value is already known at scan
// time (e.g. planted in a leak-scanner test, or read from a project's
// resolved .env before a CI check).
const VALUE_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export interface SecretMatch {
  kind: 'pattern' | 'exact-value';
  index: number;
}

export function scanForSecrets(content: string, knownSecrets: string[] = []): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const pattern of VALUE_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      if (match.index !== undefined) matches.push({ kind: 'pattern', index: match.index });
    }
  }
  for (const secret of knownSecrets) {
    if (!secret) continue;
    let index = content.indexOf(secret);
    while (index !== -1) {
      matches.push({ kind: 'exact-value', index });
      index = content.indexOf(secret, index + 1);
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}
```

Add to `packages/domain/src/index.ts` (after the existing `export * from './redaction.js';` line):

```ts
export * from './secret-scan.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/domain/src/secret-scan.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b packages/domain --force --pretty false`
Expected: no output, exit code 0

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/secret-scan.ts packages/domain/src/secret-scan.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): add scanForSecrets pattern+exact-value matcher"
```

---

### Task 7: CI-facing scanner script + `.env`-not-tracked guard

**Files:**

- Create: `scripts/lib/secret-scan.mjs`
- Create: `scripts/lib/secret-scan.test.mjs`
- Create: `scripts/scan-secrets.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `scanForSecrets` from `@agent-foundry/domain` (Task 6), imported the same way `scripts/db-migrate.mjs` imports `@agent-foundry/persistence` — dynamic `import()` with a friendly "run `npm run build` first" error.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/secret-scan.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  scanTrackedFiles,
  scanDirectoryFiles,
  assertNoRealEnvFilesTracked,
} from './secret-scan.mjs';

const run = promisify(execFile);

async function initGitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'af-secret-scan-'));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'Test'], { cwd: root });
  return root;
}

test('scanTrackedFiles flags a pattern-shaped secret in a git-tracked file', async () => {
  const root = await initGitRepo();
  await writeFile(join(root, 'config.ts'), 'const key = "sk-abcdefghijklmnopqrstuvwx";');
  await run('git', ['add', '-A'], { cwd: root });

  const findings = await scanTrackedFiles(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'config.ts');
});

test('scanTrackedFiles ignores untracked files', async () => {
  const root = await initGitRepo();
  await writeFile(join(root, 'config.ts'), 'const key = "sk-abcdefghijklmnopqrstuvwx";');
  // not git add'ed

  const findings = await scanTrackedFiles(root);
  assert.deepEqual(findings, []);
});

test('assertNoRealEnvFilesTracked throws when a real .env is git-tracked', async () => {
  const root = await initGitRepo();
  await writeFile(join(root, '.env'), 'SECRET=leak');
  await run('git', ['add', '-A'], { cwd: root });

  await assert.rejects(() => assertNoRealEnvFilesTracked(root), /\.env is tracked by Git/);
});

test('assertNoRealEnvFilesTracked allows .env.example', async () => {
  const root = await initGitRepo();
  await writeFile(join(root, '.env.example'), 'SECRET=');
  await run('git', ['add', '-A'], { cwd: root });

  await assert.doesNotReject(() => assertNoRealEnvFilesTracked(root));
});

test('scanDirectoryFiles flags a secret in a built (untracked) client bundle chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-secret-scan-'));
  const bundleDir = join(root, 'apps/web/.next');
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, 'chunk.js'), 'var k="sk-abcdefghijklmnopqrstuvwx"');
  // Deliberately not git-tracked — .next is gitignored; the scan must still
  // catch a secret baked into build output that Git would never see.

  const findings = await scanDirectoryFiles(bundleDir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, join(bundleDir, 'chunk.js'));
});

test('scanDirectoryFiles is a no-op when the directory does not exist (build not run yet)', async () => {
  const findings = await scanDirectoryFiles(join(tmpdir(), 'af-does-not-exist-' + Date.now()));
  assert.deepEqual(findings, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/lib/secret-scan.test.mjs`
Expected: FAIL — `Cannot find module './secret-scan.mjs'`

- [ ] **Step 3: Implement the script library**

Create `scripts/lib/secret-scan.mjs`:

```js
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

let domain;
async function loadDomain() {
  if (domain) return domain;
  try {
    domain = await import('@agent-foundry/domain');
  } catch (error) {
    console.error('Could not load @agent-foundry/domain. Run `npm run build` first.');
    throw error;
  }
  return domain;
}

/** Every git-tracked file, scanned for known secret shapes (no known-value list — CI doesn't have one). */
export async function scanTrackedFiles(root, knownSecrets = []) {
  const { scanForSecrets } = await loadDomain();
  const { stdout } = await run('git', ['ls-files'], { cwd: root });
  const files = stdout.split('\n').filter(Boolean);
  const findings = [];
  for (const file of files) {
    let content;
    try {
      content = await readFile(`${root}/${file}`, 'utf8');
    } catch {
      continue; // binary or unreadable — skip rather than crash the scan
    }
    for (const match of scanForSecrets(content, knownSecrets)) {
      findings.push({ file, ...match });
    }
  }
  return findings;
}

/**
 * Every file under `dir`, scanned for known secret shapes — unlike
 * scanTrackedFiles, this walks the real filesystem regardless of Git, so it
 * catches a secret baked into build output (e.g. apps/web/.next, a "client
 * bundle") that .gitignore keeps out of scanTrackedFiles entirely. A no-op
 * if the directory doesn't exist yet (build hasn't run).
 */
export async function scanDirectoryFiles(dir, knownSecrets = []) {
  const { scanForSecrets } = await loadDomain();
  const findings = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue; // binary or unreadable — skip rather than crash the scan
    }
    for (const match of scanForSecrets(content, knownSecrets)) {
      findings.push({ file: path, ...match });
    }
  }
  return findings;
}

/** Fails if any real .env file (anything but .env.example) is git-tracked. */
export async function assertNoRealEnvFilesTracked(root) {
  const { stdout } = await run('git', ['ls-files'], { cwd: root });
  const tracked = stdout.split('\n').filter(Boolean);
  const offenders = tracked.filter(
    (file) => /(^|\/)\.env(\..+)?$/.test(file) && !file.endsWith('.env.example'),
  );
  if (offenders.length > 0) {
    throw new Error(`.env is tracked by Git: ${offenders.join(', ')}`);
  }
}
```

Create `scripts/scan-secrets.mjs`:

```js
#!/usr/bin/env node
import { join, resolve } from 'node:path';
import {
  assertNoRealEnvFilesTracked,
  scanDirectoryFiles,
  scanTrackedFiles,
} from './lib/secret-scan.mjs';

const root = resolve(import.meta.dirname, '..');

await assertNoRealEnvFilesTracked(root);
const findings = [
  ...(await scanTrackedFiles(root)),
  ...(await scanDirectoryFiles(join(root, 'apps/web/.next'))),
];
if (findings.length > 0) {
  console.error('Possible secret(s) found:');
  for (const finding of findings) {
    console.error(`  ${finding.file} (${finding.kind} match at offset ${finding.index})`);
  }
  process.exit(1);
}
console.log(
  'secrets:check — no .env tracked, no known secret shapes found in source or client bundle.',
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/lib/secret-scan.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Wire into `package.json`**

In `package.json`, add a new script (near `"github-config:check"`):

```json
    "secrets:check": "npm run build --workspace @agent-foundry/domain && node scripts/scan-secrets.mjs",
```

Change the `"test:scripts"` entry from:

```json
    "test:scripts": "node --test scripts/lib/*.test.mjs",
```

(no change needed — the glob already picks up the new `scripts/lib/secret-scan.test.mjs`)

Change the `"check"` entry from:

```json
    "check": "npm run format:check && npm run lint && npm run architecture:check && npm run roadmap:check && npm run typecheck && npm test && npm run build",
```

to:

```json
    "check": "npm run format:check && npm run lint && npm run architecture:check && npm run roadmap:check && npm run typecheck && npm test && npm run build && npm run secrets:check",
```

(placed after `build` since `secrets:check` needs `@agent-foundry/domain` built, and the earlier `npm run build` step already builds every package.)

- [ ] **Step 6: Add a CI job**

In `.github/workflows/ci.yml`, add a new job after the existing `roadmap` job (mirroring its shape exactly):

```yaml
secrets:
  name: secrets
  needs: preflight
  runs-on: ubuntu-latest
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@v7
      with:
        fetch-depth: 0
    - uses: actions/setup-node@v6
      with:
        node-version-file: .nvmrc
        cache: npm
    - run: npm ci
    - name: Build the web app so the client-bundle scan has something to scan
      run: npm run build --workspace @agent-foundry/contracts && npm run build --workspace @agent-foundry/domain && npm run build --workspace @agent-foundry/web
    - run: npm run secrets:check
```

Use the plain `- uses: actions/checkout@v7` with no extra `with:` (matching the `roadmap` job above it exactly) — `git ls-files` reads the index, not history, so the default shallow checkout is sufficient.

Without the explicit web build step, `scanDirectoryFiles(apps/web/.next)` would silently no-op in CI (the directory wouldn't exist yet) and the "client bundle" half of AC5 would pass by omission rather than by actually being checked — build it first so the check is real.

- [ ] **Step 7: Run the full check locally**

Run: `npm run secrets:check`
Expected: exit code 0, prints `secrets:check — no .env tracked, no known secret shapes found in tracked files.`

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/secret-scan.mjs scripts/lib/secret-scan.test.mjs scripts/scan-secrets.mjs package.json .github/workflows/ci.yml
git commit -m "feat(ci): add a secret scanner and .env-tracked guard"
```

---

### Task 8: Mandatory multi-surface leak-scanner test

**Files:**

- Create: `packages/composition/src/secret-leak.integration.test.ts`

**Context:** This is the AC-mandated test: plant one known fake secret value, then prove it appears nowhere across the six surfaces the issue names (Git, prompt, artifact/screenshot, event/log, client bundle) plus a positive check that it _does_ reach the one place it's supposed to (the preview process). It composes the exact `.not.toContain(secret)` idiom already used in `packages/composition/src/runtime.integration.test.ts:412` and `apps/api/src/conversation.test.ts:490,496`, plus Task 6/7's scanner for the file-content surfaces.

**Interfaces:**

- Consumes: `createRuntime`, `Runtime.secretStore` (Task 5), `approveDiffGate` from `./testing-helpers.js` (existing composition test helper), `scanForSecrets` (Task 6).

- [ ] **Step 1: Write the test**

Create `packages/composition/src/secret-leak.integration.test.ts`. This follows `packages/composition/src/runtime.integration.test.ts`'s established "run the complete workflow in mock mode" pattern exactly (its `'runs the complete workflow in default mock mode without runtime patches'` test): `projectService.create` → `runtime.worker.runOnce()` → `approveDiffGate(runtime, runId)` → `runtime.worker.runOnce()` again to reach `'completed'`. Copy that file's imports (`mkdtemp`, `tmpdir`, `join`, `resolve`, `readFile`, `afterEach`/`temporaryDirectories` cleanup, `createRuntime`, `approveDiffGate` from `./testing-helpers.js`) verbatim rather than re-deriving them.

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { scanForSecrets } from '@agent-foundry/domain';
import { createRuntime } from './runtime.js';
import { approveDiffGate } from './testing-helpers.js';

const run = promisify(execFile);
const FAKE_SECRET = 'leak-canary-9f2b7c1a';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('secret leak scan', () => {
  it('never leaks a real secret value into Git, the prompt, artifacts, or events — only the declared name and, for the preview process, the resolved value are ever exposed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-secret-leak-'));
    temporaryDirectories.push(dataDir);
    const rootDir = resolve(import.meta.dirname, '../../..');
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });

    const project = await runtime.projectService.create({
      name: 'Secret Leak Check',
      workflowId: 'web-app-v1',
      prd: 'Build a tiny app so this test has a real workflow to run through mock execution.',
    });
    await writeFile(join(dataDir, 'projects', project.id, '.env'), `FAKE_SECRET=${FAKE_SECRET}\n`);

    // 1. Capability surfaced by name only — the value is never touched here.
    expect(await runtime.secretStore.names(project.id)).toEqual(['FAKE_SECRET']);

    if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
    const runId = project.currentRunId;
    expect(await runtime.worker.runOnce()).toBe(true);
    await approveDiffGate(runtime, runId);
    expect(await runtime.worker.runOnce()).toBe(true);
    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');

    // 2. Git / prompt surface: every file written into the git-tracked workspace,
    //    including REQUEST.md (the compiled agent prompt) under .orchestrator/runs/.
    const workspacePath = runtime.workspaces.workspacePath(project.id);
    const { stdout: trackedFiles } = await run('git', ['ls-files'], { cwd: workspacePath });
    const files = trackedFiles.split('\n').filter(Boolean);
    expect(files).not.toContain('.env');
    for (const file of files) {
      const content = await readFile(join(workspacePath, file), 'utf8').catch(() => '');
      expect(scanForSecrets(content, [FAKE_SECRET])).toEqual([]);
    }

    // 3. Artifact surface — this is also the mechanism a captured screenshot
    //    goes through (see runtime.integration.test.ts's browser-verification
    //    test: screenshots are stored via runtime.artifacts, same as any
    //    other artifact — no separate screenshot pipeline exists to check).
    const artifacts = await runtime.artifacts.listLatest(project.id);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(scanForSecrets(JSON.stringify(artifact.content), [FAKE_SECRET])).toEqual([]);
    }

    // 4. Event/log surface.
    const events = await runtime.events.list(project.id);
    expect(events.length).toBeGreaterThan(0);
    expect(scanForSecrets(JSON.stringify(events), [FAKE_SECRET])).toEqual([]);

    // 5. Client-bundle surface: the scanner (Task 6/7) does catch it when a
    //    build artifact contains the raw value — proven directly here since
    //    this workflow's mock run doesn't produce a real Next.js build.
    const bundleFixture = `var leaked = "${FAKE_SECRET}";`;
    expect(scanForSecrets(bundleFixture, [FAKE_SECRET])).toEqual([
      { kind: 'exact-value', index: bundleFixture.indexOf(FAKE_SECRET) },
    ]);

    // 6. Positive check: the preview process is the one place the real
    //    value is allowed to land (Task 4) — resolveAll is that path.
    expect(await runtime.secretStore.resolveAll(project.id)).toEqual({ FAKE_SECRET });
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `npx vitest run packages/composition/src/secret-leak.integration.test.ts`

Expected first failure: `runtime.secretStore` is `undefined` if Task 5's `Runtime` interface/return-object addition isn't done yet — go back and confirm Task 5 landed first. Once it has:

Expected: PASS (1 test)

- [ ] **Step 4: Run the whole composition suite**

Run: `npx vitest run packages/composition`
Expected: PASS — every pre-existing test in the package still passes

- [ ] **Step 5: Commit**

```bash
git add packages/composition/src/secret-leak.integration.test.ts packages/composition/src/runtime.ts
git commit -m "test(composition): add the mandatory multi-surface secret leak scanner test"
```

---

### Task 9: ADR + operator docs

**Files:**

- Create: `docs/adr/0032-app-secret-capabilities.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0032-app-secret-capabilities.md` (follow the format of `docs/adr/0012-sse-event-stream-and-redaction.md` and `docs/adr/0028-deny-by-default-network-policy.md` — read both first for this repo's ADR structure/tone). Cover:

- Decision: one `.env` file per project at `<DATA_DIR>/projects/<projectId>/.env`, outside the git-tracked `workspace/` directory, as the source of both declared secret names and resolved values (`SecretStore.names()` / `resolveAll()`).
- The coding agent (`base-cli-executor.ts`) and the generated app's dev-server process (`node-preview-runner.ts`) are two different subprocesses; only the latter ever calls `resolveAll()`.
- Both subprocess spawn points now use `pickSafeEnvironment()` instead of inheriting the control-plane's full `process.env` — name this as a fix to a real prior gap, not just new behavior.
- Explicitly state that VPS/SSH publish (ADR 0008) doesn't exist in the codebase yet, and that when it's built, it must reuse `SecretStore.resolveAll()` as its injection mechanism rather than re-deriving one.
- Reference ADRs 0008, 0012, 0023, 0024, 0025, 0028.

- [ ] **Step 2: Update operator docs**

In `docs/OPERATIONS.md`, add a short section (near wherever `.env`/`DATABASE_URL` is already documented, per the earlier grep hit at `docs/OPERATIONS.md:618`) titled "App secrets (per project)" explaining: create `<DATA_DIR>/projects/<projectId>/.env` by hand with `KEY=value` lines; those keys become the declared capability names the coding agent can reference in generated code; values are injected only into the running preview process.

- [ ] **Step 3: Point the repo-root `.env.example` at the per-project file**

In `.env.example`, add a short comment near the top (this file is the control plane's own config template, not a generated app's secrets):

```
# Per-project app secrets (the coding agent's declared capabilities, e.g.
# a generated app's STRIPE_SECRET_KEY) do NOT go in this file. Create
# <DATA_DIR>/projects/<projectId>/.env instead — see docs/OPERATIONS.md
# "App secrets (per project)".
```

- [ ] **Step 4: Run the roadmap/docs checks**

Run: `npm run roadmap:check`
Expected: PASS (confirms the new ADR doesn't break any roadmap/doc validation this repo runs)

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0032-app-secret-capabilities.md docs/OPERATIONS.md .env.example
git commit -m "docs: record the app-secret-capabilities design (ADR 0032) and operator instructions"
```

---

## Task Dependency Order

Independent — dispatch in parallel first:

- **Task 1** (SecretStore port + FileSecretStore)
- **Task 2** (safe environment allowlist + CLI executor fix)
- **Task 6** (secret-scan matcher)

Then, once Task 1 lands:

- **Task 3** (orchestrator wiring) — needs Task 1's port
- **Task 4** (preview injection) — needs Task 1's port + Task 2's `pickSafeEnvironment`

Then, once Task 3 and Task 4 land:

- **Task 5** (composition wiring)

In parallel with Task 5, once Task 6 lands:

- **Task 7** (CI scanner script)

Then, once Task 5 and Task 7 land:

- **Task 8** (mandatory leak-scanner test) — the AC6 evidence

Last, once everything above is settled:

- **Task 9** (ADR + docs) — documents the final, real design rather than a planned one

## Final Verification (run once every task is committed)

```bash
npm run check
```

Expected: every sub-check passes — `format:check`, `lint`, `architecture:check`, `roadmap:check`, `typecheck`, `test` (unit + scripts), `build`, and the new `secrets:check`.

```bash
npm run e2e --workspace @agent-foundry/api
```

(`apps/api/e2e/playwright.config.ts` — this repo's e2e suite; the issue's Definition of Done requires e2e green, not just unit/integration.) No task in this plan touches an e2e spec directly, so this run should be a pure regression check; if a spec exercises the preview dev-server or CLI executor spawn paths touched by Tasks 2/4, investigate rather than assuming flake.
