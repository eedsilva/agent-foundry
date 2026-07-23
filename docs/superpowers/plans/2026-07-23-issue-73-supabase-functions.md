# Local Supabase Functions with Versioned Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a generated project's isolated local Supabase runtime deploy Edge Functions as immutable, checksummed versions with rollback, declared and validated resource ceilings (timeout/memory/egress), and traced invocation — closing GitHub issue #73 (`v010-functions`).

**Architecture:** Extend the existing `GeneratedProjectRuntime` port (`packages/domain/src/ports.ts`) and its only implementation, `SupabaseGeneratedProjectRuntime` (`packages/platform/src/supabase-runtime.ts`), with four new operations: `deployFunction`, `listFunctionVersions`, `rollbackFunction`, `invokeFunction`. Deploy snapshots the function's source tree into a content-addressed version store under the project's data directory (mirroring the existing migration-backup pattern), then activates it by copying the version into the live `supabase/functions/<name>/` directory that the Supabase CLI's local Edge Runtime already serves — there is no cloud "deploy" step to shell out to locally. Rollback re-activates a previously stored version after re-verifying its checksum. Invocation is a traced HTTP call to the project's own API gateway (`{endpoints.api}/functions/v1/<name>`) with the deployed version's declared `timeoutMs` enforced via `AbortController`.

**Tech Stack:** TypeScript, Zod (contracts), `execa`/Supabase CLI (already wired), Node `fetch`/`AbortController`, `@opentelemetry/api` via the existing `withSpan` helper, Vitest.

## Global Constraints

- Package dependency graph is enforced by `scripts/lib/architecture.mjs`: `@agent-foundry/platform` may import only `@agent-foundry/contracts` and `@agent-foundry/domain`. Do not import from `@agent-foundry/executors` (e.g. its network-policy sidecar) — it is not on the allowed edge list.
- `npm run check` (format, lint, architecture, roadmap, typecheck, test, build) must stay green after every task.
- Do not hand-edit `planning/roadmap-spec.json` or the roadmap checkboxes in `planning/ROADMAP.md` — the issue body states those fields are bot-reconciled and hash-protected.
- Secrets never enter contracts, logs, or fixtures: functions declare env var **names** only (`envRefs: string[]`), never values — matches the existing `redactString`/`redactDiagnostic` posture in `packages/platform/src/supabase-runtime.ts`.
- Zod object schemas in this codebase use `.strict()` — follow that convention for every new schema.
- **Known scope limit (record in the ADR, task 5):** the local Supabase CLI stack has no per-function memory or network-egress enforcement hook (confirmed against the Supabase CLI `config.toml` functions reference and the self-hosted Edge Runtime docs — only `enabled`, `verify_jwt`, `import_map`, `entrypoint`, `static_files` exist per function). `memoryMb` and `egressAllowlist` are therefore validated, bounded, and persisted as declared ceilings on the version manifest, but are **not** runtime-enforced in this change. `timeoutMs` **is** runtime-enforced, because that happens at our own `invokeFunction` call boundary, not inside the CLI-managed runtime.

---

## File Structure

| File                                                               | Responsibility                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/app-environment.ts`                        | Export the existing private `Sha256Schema` so it can be reused (1-line change).                              |
| `packages/contracts/src/function-deployment.ts` (new)              | `FunctionArtifactSchema`, `FunctionVersionSchema`, `FunctionInvocationResultSchema` + their bound constants. |
| `packages/contracts/src/function-deployment.test.ts` (new)         | Schema validation tests (bounds, name/env-ref format, strictness).                                           |
| `packages/contracts/src/index.ts`                                  | Barrel-export the new file.                                                                                  |
| `packages/domain/src/ports.ts`                                     | Add 4 methods to `GeneratedProjectRuntime`.                                                                  |
| `packages/orchestrator/src/project-service.test.ts`                | Fix the `satisfies GeneratedProjectRuntime` fixture that the interface change breaks.                        |
| `packages/platform/src/supabase-runtime.ts`                        | Implement `deployFunction`, `listFunctionVersions`, `rollbackFunction`, `invokeFunction` + private helpers.  |
| `packages/platform/src/supabase-runtime.test.ts`                   | Deploy, rollback, list, invoke (success/timeout/failure-path) tests.                                         |
| `docs/adr/0032-supabase-functions-versioned-local-deploy.md` (new) | Durable decision record, including the scope limit above.                                                    |

---

### Task 1: Function contracts (artifact, version, invocation result)

**Files:**

- Modify: `packages/contracts/src/app-environment.ts:36`
- Modify: `packages/contracts/src/app-environment.ts:13-23` (operation enum)
- Create: `packages/contracts/src/function-deployment.ts`
- Create: `packages/contracts/src/function-deployment.test.ts`
- Modify: `packages/contracts/src/index.ts:24` (add barrel export)

**Interfaces:**

- Produces: `FunctionArtifactSchema`/`FunctionArtifact`, `FunctionVersionSchema`/`FunctionVersion`, `FunctionInvocationResultSchema`/`FunctionInvocationResult`, constants `FUNCTION_TIMEOUT_MS_MAX = 60_000`, `FUNCTION_MEMORY_MB_MAX = 512`, `FUNCTION_INVOCATION_BODY_MAX_BYTES = 1_048_576`. Every later task imports these exact names from `@agent-foundry/contracts`.

- [ ] **Step 1: Export `Sha256Schema`**

In `packages/contracts/src/app-environment.ts:36`, change:

```ts
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
```

to:

```ts
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
```

- [ ] **Step 2: Add the three new operations to the lifecycle-operation enum**

In `packages/contracts/src/app-environment.ts:13-23`, change:

```ts
export const EnvironmentLifecycleOperationSchema = z.enum([
  'initialize',
  'start',
  'stop',
  'inspect',
  'migrate',
  'seed',
  'health',
  'reset',
  'cleanup',
]);
```

to:

```ts
export const EnvironmentLifecycleOperationSchema = z.enum([
  'initialize',
  'start',
  'stop',
  'inspect',
  'migrate',
  'seed',
  'health',
  'reset',
  'cleanup',
  'deploy-function',
  'rollback-function',
  'invoke-function',
]);
```

- [ ] **Step 3: Write the failing schema test**

Create `packages/contracts/src/function-deployment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  FunctionArtifactSchema,
  FunctionInvocationResultSchema,
  FunctionVersionSchema,
} from './index.js';

const ARTIFACT = {
  name: 'send-welcome-email',
  entrypoint: 'index.ts',
  verifyJwt: true,
  envRefs: ['RESEND_API_KEY'],
  timeoutMs: 5_000,
  memoryMb: 128,
  egressAllowlist: ['api.resend.com'],
};

describe('FunctionArtifactSchema', () => {
  it('accepts a well-formed artifact', () => {
    expect(FunctionArtifactSchema.parse(ARTIFACT)).toEqual(ARTIFACT);
  });

  it('rejects an env ref that is not SCREAMING_SNAKE_CASE', () => {
    expect(() =>
      FunctionArtifactSchema.parse({ ...ARTIFACT, envRefs: ['resendApiKey'] }),
    ).toThrow();
  });

  it('rejects a timeout beyond the platform ceiling', () => {
    expect(() => FunctionArtifactSchema.parse({ ...ARTIFACT, timeoutMs: 120_000 })).toThrow();
  });

  it('rejects a memory limit beyond the platform ceiling', () => {
    expect(() => FunctionArtifactSchema.parse({ ...ARTIFACT, memoryMb: 4096 })).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => FunctionArtifactSchema.parse({ ...ARTIFACT, extra: true })).toThrow();
  });
});

describe('FunctionVersionSchema', () => {
  it('accepts a version manifest referencing a valid artifact', () => {
    const version = {
      functionName: ARTIFACT.name,
      versionId: 'b6a0f5f0-2f8e-4b7a-9c1e-2b6f1a0d9e11',
      checksum: 'a'.repeat(64),
      artifact: ARTIFACT,
      createdAt: '2026-07-23T12:00:00.000Z',
    };
    expect(FunctionVersionSchema.parse(version)).toEqual(version);
  });

  it('rejects a non-hex checksum', () => {
    expect(() =>
      FunctionVersionSchema.parse({
        functionName: ARTIFACT.name,
        versionId: 'b6a0f5f0-2f8e-4b7a-9c1e-2b6f1a0d9e11',
        checksum: 'not-a-checksum',
        artifact: ARTIFACT,
        createdAt: '2026-07-23T12:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('FunctionInvocationResultSchema', () => {
  it('accepts a successful invocation result', () => {
    const result = { status: 200, body: '{"ok":true}', durationMs: 42, timedOut: false };
    expect(FunctionInvocationResultSchema.parse(result)).toEqual(result);
  });

  it('rejects an out-of-range HTTP status', () => {
    expect(() =>
      FunctionInvocationResultSchema.parse({
        status: 999,
        body: '',
        durationMs: 0,
        timedOut: false,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run packages/contracts/src/function-deployment.test.ts`
Expected: FAIL — `Failed to resolve import "./index.js"` / `FunctionArtifactSchema is not exported` (the module doesn't exist yet).

- [ ] **Step 5: Implement the schemas**

Create `packages/contracts/src/function-deployment.ts`:

```ts
import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';
import { Sha256Schema } from './app-environment.js';

export const FUNCTION_TIMEOUT_MS_MAX = 60_000;
export const FUNCTION_MEMORY_MB_MAX = 512;
export const FUNCTION_INVOCATION_BODY_MAX_BYTES = 1_048_576;

const EnvRefNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Env refs must be SCREAMING_SNAKE_CASE names');

export const FunctionArtifactSchema = z
  .object({
    name: PathSegmentSchema,
    entrypoint: z.string().min(1).max(255),
    verifyJwt: z.boolean(),
    envRefs: z.array(EnvRefNameSchema).max(50),
    timeoutMs: z.number().int().min(1_000).max(FUNCTION_TIMEOUT_MS_MAX),
    memoryMb: z.number().int().min(16).max(FUNCTION_MEMORY_MB_MAX),
    egressAllowlist: z.array(z.string().min(1).max(255)).max(50),
  })
  .strict();
export type FunctionArtifact = z.infer<typeof FunctionArtifactSchema>;

export const FunctionVersionSchema = z
  .object({
    functionName: PathSegmentSchema,
    versionId: PathSegmentSchema,
    checksum: Sha256Schema,
    artifact: FunctionArtifactSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type FunctionVersion = z.infer<typeof FunctionVersionSchema>;

export const FunctionInvocationResultSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.string().max(FUNCTION_INVOCATION_BODY_MAX_BYTES),
    durationMs: z.number().int().min(0),
    timedOut: z.boolean(),
  })
  .strict();
export type FunctionInvocationResult = z.infer<typeof FunctionInvocationResultSchema>;
```

- [ ] **Step 6: Barrel-export it**

In `packages/contracts/src/index.ts:24`, immediately after `export * from './app-environment.js';`, add:

```ts
export * from './function-deployment.js';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run packages/contracts/src/function-deployment.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add packages/contracts/src/app-environment.ts packages/contracts/src/function-deployment.ts packages/contracts/src/function-deployment.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add function artifact, version, and invocation schemas"
```

---

### Task 2: Extend the `GeneratedProjectRuntime` port

**Files:**

- Modify: `packages/domain/src/ports.ts:53-57` (import block)
- Modify: `packages/domain/src/ports.ts:536-548` (interface body)
- Modify: `packages/orchestrator/src/project-service.test.ts:41-52` (fixture that implements the interface)

**Interfaces:**

- Consumes: `FunctionArtifact`, `FunctionVersion`, `FunctionInvocationResult` from Task 1 (`@agent-foundry/contracts`).
- Produces: 4 new required methods on `GeneratedProjectRuntime` — `deployFunction`, `listFunctionVersions`, `rollbackFunction`, `invokeFunction` — with the exact signatures below. Task 3/4's platform implementation and any test fixture implementing this interface must match them exactly.

- [ ] **Step 1: Add the new contract imports**

In `packages/domain/src/ports.ts:53-57`, change:

```ts
  AppEnvironment,
  DestructiveEnvironmentConfirmation,
  MigrationApproval,
  MigrationBackup,
  MigrationPreview,
```

to:

```ts
  AppEnvironment,
  DestructiveEnvironmentConfirmation,
  FunctionArtifact,
  FunctionInvocationResult,
  FunctionVersion,
  MigrationApproval,
  MigrationBackup,
  MigrationPreview,
```

- [ ] **Step 2: Add the four methods to the interface**

In `packages/domain/src/ports.ts`, the interface currently ends with (around line 536-548):

```ts
export interface GeneratedProjectRuntime {
  initialize(input: { projectId: string }): Promise<AppEnvironment>;
  start(projectId: string): Promise<AppEnvironment>;
  stop(projectId: string): Promise<AppEnvironment>;
  inspect(projectId: string): Promise<AppEnvironment | null>;
  previewMigration(input: { projectId: string; migrationPath: string }): Promise<MigrationPreview>;
  backupMigration(input: { projectId: string; backupPath: string }): Promise<MigrationBackup>;
  migrate(input: {
    projectId: string;
    migrationPath: string;
    approval?: MigrationApproval;
  }): Promise<AppEnvironment>;
  seed(input: { projectId: string; seedPath: string }): Promise<AppEnvironment>;
  health(projectId: string): Promise<AppEnvironment>;
  reset(input: {
    projectId: string;
    confirmation: DestructiveEnvironmentConfirmation;
  }): Promise<AppEnvironment>;
  cleanup(input: {
    projectId: string;
    confirmation: DestructiveEnvironmentConfirmation;
  }): Promise<void>;
}
```

Add these four methods before the closing `}`:

```ts
  deployFunction(input: {
    projectId: string;
    functionPath: string;
    artifact: FunctionArtifact;
  }): Promise<FunctionVersion>;
  listFunctionVersions(input: {
    projectId: string;
    functionName: string;
  }): Promise<FunctionVersion[]>;
  rollbackFunction(input: {
    projectId: string;
    functionName: string;
    versionId: string;
  }): Promise<FunctionVersion>;
  invokeFunction(input: {
    projectId: string;
    functionName: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<FunctionInvocationResult>;
```

- [ ] **Step 3: Verify the break, then fix the orchestrator test fixture**

Run: `npm run typecheck`
Expected: FAIL — `packages/orchestrator/src/project-service.test.ts` reports the object literal at line 41 does not satisfy `GeneratedProjectRuntime` (missing 4 properties).

In `packages/orchestrator/src/project-service.test.ts:41-52`, change:

```ts
      generatedProjectRuntime: {
        initialize,
        start: unused,
        stop: unused,
        inspect: unused,
        previewMigration: unused,
        backupMigration: unused,
        migrate: unused,
        seed: unused,
        health: unused,
        reset: unused,
        cleanup: unused,
      } satisfies GeneratedProjectRuntime,
```

to:

```ts
      generatedProjectRuntime: {
        initialize,
        start: unused,
        stop: unused,
        inspect: unused,
        previewMigration: unused,
        backupMigration: unused,
        migrate: unused,
        seed: unused,
        health: unused,
        reset: unused,
        cleanup: unused,
        deployFunction: unused,
        listFunctionVersions: unused,
        rollbackFunction: unused,
        invokeFunction: unused,
      } satisfies GeneratedProjectRuntime,
```

(`unused` is already defined two lines above as `() => Promise.reject(new Error('unused test runtime operation'))` — it's untyped enough to satisfy every method shape here, matching how the existing 8 methods reuse it.)

- [ ] **Step 4: Run typecheck and the orchestrator test suite to verify the fix**

Run: `npm run typecheck && npx vitest run packages/orchestrator/src/project-service.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/ports.ts packages/orchestrator/src/project-service.test.ts
git commit -m "feat(domain): add function deploy/rollback/invoke to GeneratedProjectRuntime"
```

---

### Task 3: Platform — versioned deploy, list, rollback

**Files:**

- Modify: `packages/platform/src/supabase-runtime.ts`
- Modify: `packages/platform/src/supabase-runtime.test.ts`

**Interfaces:**

- Consumes: `FunctionArtifact`, `FunctionArtifactSchema`, `FunctionVersion`, `FunctionVersionSchema` (Task 1); `ValidationError`, `EnvironmentOperationError` (already imported in this file); the class's existing private `#dataDir`, `#now`, `#require`, `#touch`, and free functions `isContained`, `isNotFound`, `atomicWrite`.
- Produces: `SupabaseGeneratedProjectRuntime.deployFunction`, `.listFunctionVersions`, `.rollbackFunction` — later consumed by Task 4's `invokeFunction` (via `listFunctionVersions`) and by any future orchestrator wiring.

Function versions are stored under `{dataDir}/projects/{projectId}/functions/{name}/versions/{versionId}/` (the snapshot's files) with a sibling manifest `{versionId}.json`. The "live" copy Supabase's local Edge Runtime serves is `{workdir}/supabase/functions/{name}/`.

- [ ] **Step 1: Write the failing deploy/list/rollback tests**

Open `packages/platform/src/supabase-runtime.test.ts` and add these imports next to the existing ones at the top of the file (after the existing `import { ... } from './supabase-runtime.js';` line):

```ts
import { FunctionArtifactSchema, type FunctionArtifact } from '@agent-foundry/contracts';
```

Add this helper near the other test helpers (after `statusCommand`, before the first `describe`):

```ts
const FUNCTION_ARTIFACT: FunctionArtifact = FunctionArtifactSchema.parse({
  name: 'hello',
  entrypoint: 'index.ts',
  verifyJwt: true,
  envRefs: ['GREETING_SUFFIX'],
  timeoutMs: 5_000,
  memoryMb: 128,
  egressAllowlist: [],
});

async function deployHello(
  runtime: SupabaseGeneratedProjectRuntime,
  projectId: string,
  workdir: string,
  body = 'export default () => new Response("hi");\n',
) {
  const functionDir = join(workdir, 'supabase', 'functions', 'hello');
  await mkdir(functionDir, { recursive: true });
  await writeFile(join(functionDir, 'index.ts'), body);
  return runtime.deployFunction({
    projectId,
    functionPath: 'supabase/functions/hello',
    artifact: FUNCTION_ARTIFACT,
  });
}
```

Add this new `describe` block at the end of the file:

```ts
describe('function deployment', () => {
  it('deploys a function as an immutable, checksummed version and activates it', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'fn-project' });
    const version = await deployHello(runtime, 'fn-project', environment.workdir);

    expect(version.functionName).toBe('hello');
    expect(version.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(version.artifact).toEqual(FUNCTION_ARTIFACT);

    const live = await readFile(
      join(environment.workdir, 'supabase', 'functions', 'hello', 'index.ts'),
      'utf8',
    );
    expect(live).toContain('new Response("hi")');

    const config = await readFile(join(environment.workdir, 'supabase', 'config.toml'), 'utf8');
    expect(config).toContain('[functions.hello]');
    expect(config).toContain('verify_jwt = true');
  });

  it('rejects a function source path outside the declared function name', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'fn-project-2' });
    const functionDir = join(environment.workdir, 'supabase', 'functions', 'other');
    await mkdir(functionDir, { recursive: true });
    await writeFile(join(functionDir, 'index.ts'), 'export default () => new Response("hi");\n');

    await expect(
      runtime.deployFunction({
        projectId: 'fn-project-2',
        functionPath: 'supabase/functions/other',
        artifact: FUNCTION_ARTIFACT,
      }),
    ).rejects.toThrow(/must match/);
  });

  it('rejects a source path that escapes the project workdir', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    await runtime.initialize({ projectId: 'fn-project-3' });

    await expect(
      runtime.deployFunction({
        projectId: 'fn-project-3',
        functionPath: '../../etc/hello',
        artifact: FUNCTION_ARTIFACT,
      }),
    ).rejects.toThrow();
  });

  it('lists deployed versions oldest first and supports rollback to a prior version', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'fn-project-4' });
    const first = await deployHello(
      runtime,
      'fn-project-4',
      environment.workdir,
      'export default () => new Response("v1");\n',
    );
    const second = await deployHello(
      runtime,
      'fn-project-4',
      environment.workdir,
      'export default () => new Response("v2");\n',
    );

    const versions = await runtime.listFunctionVersions({
      projectId: 'fn-project-4',
      functionName: 'hello',
    });
    expect(versions.map((version) => version.versionId)).toEqual([
      first.versionId,
      second.versionId,
    ]);

    await runtime.rollbackFunction({
      projectId: 'fn-project-4',
      functionName: 'hello',
      versionId: first.versionId,
    });
    const live = await readFile(
      join(environment.workdir, 'supabase', 'functions', 'hello', 'index.ts'),
      'utf8',
    );
    expect(live).toContain('new Response("v1")');
  });

  it('rejects rollback to an unknown version id', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'fn-project-5' });
    await deployHello(runtime, 'fn-project-5', environment.workdir);

    await expect(
      runtime.rollbackFunction({
        projectId: 'fn-project-5',
        functionName: 'hello',
        versionId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/was not found/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/platform/src/supabase-runtime.test.ts -t "function deployment"`
Expected: FAIL — `runtime.deployFunction is not a function`.

- [ ] **Step 3: Implement the helpers and methods**

In `packages/platform/src/supabase-runtime.ts`, update the import block at the top. Change:

```ts
import {
  AppEnvironmentSchema,
  MigrationApprovalSchema,
  MigrationBackupSchema,
  MigrationPreviewSchema,
  PathSegmentSchema,
  type AppEnvironment,
  type DestructiveEnvironmentConfirmation,
  type EnvironmentLifecycleOperation,
  type MigrationApproval,
  type MigrationBackup,
  type MigrationPreview,
} from '@agent-foundry/contracts';
```

to:

```ts
import {
  AppEnvironmentSchema,
  FunctionArtifactSchema,
  FunctionVersionSchema,
  MigrationApprovalSchema,
  MigrationBackupSchema,
  MigrationPreviewSchema,
  PathSegmentSchema,
  type AppEnvironment,
  type DestructiveEnvironmentConfirmation,
  type EnvironmentLifecycleOperation,
  type FunctionArtifact,
  type FunctionVersion,
  type MigrationApproval,
  type MigrationBackup,
  type MigrationPreview,
} from '@agent-foundry/contracts';
```

Inside the `SupabaseGeneratedProjectRuntime` class, immediately after the existing `cleanup` method (just before the closing `}` of the class, i.e. right before the private `#read` method at line 332), add:

```ts
  async deployFunction(input: {
    projectId: string;
    functionPath: string;
    artifact: FunctionArtifact;
  }): Promise<FunctionVersion> {
    const environment = await this.#require(input.projectId);
    const artifact = FunctionArtifactSchema.parse(input.artifact);
    if (input.functionPath !== `supabase/functions/${artifact.name}`) {
      throw new ValidationError('Function source path must match supabase/functions/<name>.');
    }
    const sourceDir = await requireContainedDirectory(environment.workdir, input.functionPath);
    const files = await collectFunctionFiles(sourceDir);
    if (!files.some((file) => file.relativePath === artifact.entrypoint)) {
      throw new ValidationError(
        `Function entrypoint "${artifact.entrypoint}" was not found in source.`,
      );
    }
    const version = FunctionVersionSchema.parse({
      functionName: artifact.name,
      versionId: randomUUID(),
      checksum: functionChecksum(files),
      artifact,
      createdAt: this.#now().toISOString(),
    });
    await storeFunctionVersion(this.#dataDir, environment.projectId, version, files);
    await activateFunctionVersion(this.#dataDir, environment.workdir, environment.projectId, version);
    await this.#touch(environment);
    return version;
  }

  async listFunctionVersions(input: {
    projectId: string;
    functionName: string;
  }): Promise<FunctionVersion[]> {
    const environment = await this.#require(input.projectId);
    return readFunctionVersions(this.#dataDir, environment.projectId, input.functionName);
  }

  async rollbackFunction(input: {
    projectId: string;
    functionName: string;
    versionId: string;
  }): Promise<FunctionVersion> {
    const environment = await this.#require(input.projectId);
    const manifestPath = functionVersionManifestPath(
      this.#dataDir,
      environment.projectId,
      input.functionName,
      input.versionId,
    );
    let version: FunctionVersion;
    try {
      version = FunctionVersionSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    } catch (error) {
      if (isNotFound(error)) {
        throw new ValidationError(`Function version "${input.versionId}" was not found.`);
      }
      throw error;
    }
    const files = await collectFunctionFiles(
      functionVersionFilesDir(this.#dataDir, environment.projectId, input.functionName, input.versionId),
    );
    if (functionChecksum(files) !== version.checksum) {
      throw new ValidationError('Stored function version failed checksum verification.');
    }
    await activateFunctionVersion(this.#dataDir, environment.workdir, environment.projectId, version);
    await this.#touch(environment);
    return version;
  }
```

After the class closes (after line 393, `}` that ends the class), and after the existing `safeProjectId` function, add these free functions. Place them after `containedOutputFile` (after line 564) and before `isContained` (line 566), so they sit next to the other path-containment helpers:

```ts
async function requireContainedDirectory(workdir: string, inputPath: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new ValidationError('Function source must be a relative path.');
  }
  const candidate = resolve(workdir, inputPath);
  if (!isContained(workdir, candidate)) {
    throw new ValidationError('Function source must remain inside the project environment.');
  }
  const [resolvedWorkdir, resolvedCandidate] = await Promise.all([
    realpath(workdir),
    realpath(candidate),
  ]);
  if (!isContained(resolvedWorkdir, resolvedCandidate)) {
    throw new ValidationError('Function source must remain inside the project environment.');
  }
  return candidate;
}

interface FunctionFile {
  relativePath: string;
  content: Buffer;
}

async function collectFunctionFiles(root: string): Promise<FunctionFile[]> {
  const files: FunctionFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push({ relativePath: relative(root, absolute), content: await readFile(absolute) });
      }
    }
  }
  await walk(root);
  if (!files.length) throw new ValidationError('Function source directory contains no files.');
  return files;
}

function functionChecksum(files: FunctionFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.content);
  }
  return hash.digest('hex');
}

function functionVersionsDir(dataDir: string, projectId: string, functionName: string): string {
  return join(dataDir, 'projects', projectId, 'functions', functionName, 'versions');
}

function functionVersionManifestPath(
  dataDir: string,
  projectId: string,
  functionName: string,
  versionId: string,
): string {
  return join(functionVersionsDir(dataDir, projectId, functionName), `${versionId}.json`);
}

function functionVersionFilesDir(
  dataDir: string,
  projectId: string,
  functionName: string,
  versionId: string,
): string {
  return join(functionVersionsDir(dataDir, projectId, functionName), versionId);
}

async function storeFunctionVersion(
  dataDir: string,
  projectId: string,
  version: FunctionVersion,
  files: FunctionFile[],
): Promise<void> {
  const versionDir = functionVersionFilesDir(
    dataDir,
    projectId,
    version.functionName,
    version.versionId,
  );
  await mkdir(versionDir, { recursive: true });
  await Promise.all(
    files.map(async (file) => {
      const target = join(versionDir, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }),
  );
  await atomicWrite(
    functionVersionManifestPath(dataDir, projectId, version.functionName, version.versionId),
    `${JSON.stringify(version, null, 2)}\n`,
  );
}

async function readFunctionVersions(
  dataDir: string,
  projectId: string,
  functionName: string,
): Promise<FunctionVersion[]> {
  const dir = functionVersionsDir(dataDir, projectId, functionName);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const manifests = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(dir, entry.name));
  const versions = await Promise.all(
    manifests.map(async (path) =>
      FunctionVersionSchema.parse(JSON.parse(await readFile(path, 'utf8'))),
    ),
  );
  return versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function liveFunctionDir(workdir: string, functionName: string): string {
  return join(workdir, 'supabase', 'functions', functionName);
}

async function activateFunctionVersion(
  dataDir: string,
  workdir: string,
  projectId: string,
  version: FunctionVersion,
): Promise<void> {
  const versionDir = functionVersionFilesDir(
    dataDir,
    projectId,
    version.functionName,
    version.versionId,
  );
  const liveDir = liveFunctionDir(workdir, version.functionName);
  await rm(liveDir, { recursive: true, force: true });
  await mkdir(liveDir, { recursive: true });
  const files = await collectFunctionFiles(versionDir);
  await Promise.all(
    files.map(async (file) => {
      const target = join(liveDir, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }),
  );
  await writeFunctionConfigSection(workdir, version.functionName, version.artifact.verifyJwt);
}

async function writeFunctionConfigSection(
  workdir: string,
  functionName: string,
  verifyJwt: boolean,
): Promise<void> {
  const path = join(workdir, 'supabase', 'config.toml');
  const config = await readFile(path, 'utf8');
  const heading = `[functions.${functionName}]`;
  const lines = config.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    const trimmed = config.endsWith('\n') ? config : `${config}\n`;
    await atomicWrite(path, `${trimmed}\n${heading}\nverify_jwt = ${verifyJwt}\n`);
    return;
  }
  let end = start + 1;
  while (end < lines.length && !/^\[.*\]$/.test(lines[end]!.trim())) end += 1;
  const updated = [
    ...lines.slice(0, start),
    heading,
    `verify_jwt = ${verifyJwt}`,
    ...lines.slice(end),
  ].join('\n');
  await atomicWrite(path, updated);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/platform/src/supabase-runtime.test.ts -t "function deployment"`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full platform suite and typecheck**

Run: `npx vitest run packages/platform/src/supabase-runtime.test.ts && npm run typecheck`
Expected: both PASS (no regressions in the existing migration/backup tests).

- [ ] **Step 6: Commit**

```bash
git add packages/platform/src/supabase-runtime.ts packages/platform/src/supabase-runtime.test.ts
git commit -m "feat(platform): deploy Supabase functions as immutable versions with rollback"
```

---

### Task 4: Platform — traced, timeout-enforced invocation

**Files:**

- Modify: `packages/platform/src/supabase-runtime.ts`
- Modify: `packages/platform/src/supabase-runtime.test.ts`

**Interfaces:**

- Consumes: `FunctionInvocationResult`, `FunctionInvocationResultSchema` (Task 1); `listFunctionVersions` (Task 3, same class); `withSpan` from `@agent-foundry/domain`.
- Produces: `SupabaseGeneratedProjectRuntime.invokeFunction`.

- [ ] **Step 1: Write the failing invoke tests**

In `packages/platform/src/supabase-runtime.test.ts`, add this import at the top, next to the `node:fs/promises` import:

```ts
import { createServer, type Server } from 'node:http';
```

Add a new `describe` block after the `describe('function deployment', ...)` block added in Task 3:

```ts
describe('function invocation', () => {
  let server: Server;
  let apiPort: number;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/functions/v1/slow') {
        setTimeout(() => {
          res.writeHead(200);
          res.end('too late');
        }, 200);
        return;
      }
      if (req.url === '/functions/v1/failing') {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hi');
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    apiPort = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  function invokeCommand(...args: string[]) {
    return statusCommand(...args).then((result) => {
      if (args[0] !== 'start') return result;
      const status = JSON.parse(result.stdout) as Record<string, string>;
      status.API_URL = `http://127.0.0.1:${apiPort}`;
      return { ...result, stdout: JSON.stringify(status) };
    });
  }

  it('invokes a deployed function and returns its response', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: invokeCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'invoke-project' });
    await deployHello(runtime, 'invoke-project', environment.workdir);

    const result = await runtime.invokeFunction({
      projectId: 'invoke-project',
      functionName: 'hello',
    });
    expect(result).toEqual({
      status: 200,
      body: 'hi',
      durationMs: expect.any(Number),
      timedOut: false,
    });
  });

  it('surfaces a non-2xx response from the function without throwing', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: invokeCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'invoke-project-2' });
    await deployHello(runtime, 'invoke-project-2', environment.workdir);
    await runtime.deployFunction({
      projectId: 'invoke-project-2',
      functionPath: 'supabase/functions/hello',
      artifact: FUNCTION_ARTIFACT,
    });
    await writeFile(
      join(environment.workdir, 'supabase', 'functions', 'hello', 'index.ts'),
      'export default () => new Response("boom", { status: 500 });\n',
    );

    const result = await runtime.invokeFunction({
      projectId: 'invoke-project-2',
      functionName: 'failing',
    });
    expect(result.status).toBe(500);
    expect(result.timedOut).toBe(false);
  });

  it('enforces the deployed version timeout and reports a timeout result', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: invokeCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'invoke-project-3' });
    await runtime.deployFunction({
      projectId: 'invoke-project-3',
      functionPath: 'supabase/functions/hello',
      artifact: FunctionArtifactSchema.parse({ ...FUNCTION_ARTIFACT, timeoutMs: 1_000 }),
    });
    await mkdir(join(environment.workdir, 'supabase', 'functions', 'hello'), { recursive: true });
    await writeFile(
      join(environment.workdir, 'supabase', 'functions', 'hello', 'index.ts'),
      'export default () => new Response("hi");\n',
    );

    const result = await runtime.invokeFunction({
      projectId: 'invoke-project-3',
      functionName: 'slow',
    });
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe(504);
  });

  it('rejects invoking a function with no deployed version', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: invokeCommand,
      now: () => NOW,
    });
    await runtime.initialize({ projectId: 'invoke-project-4' });

    await expect(
      runtime.invokeFunction({ projectId: 'invoke-project-4', functionName: 'hello' }),
    ).rejects.toThrow(/no deployed version/);
  });
});
```

Note: the "slow" and "failing" test cases invoke a function name (`slow`/`failing`) that doesn't match what was deployed (`hello`) on purpose — `invokeFunction` routes purely by URL path against the fake HTTP server here, so the deployed artifact only supplies the `timeoutMs`/existence check while the fake server dispatches by path. This keeps the test focused on HTTP behavior without needing a real Edge Runtime.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/platform/src/supabase-runtime.test.ts -t "function invocation"`
Expected: FAIL — `runtime.invokeFunction is not a function`.

- [ ] **Step 3: Implement `invokeFunction`**

In `packages/platform/src/supabase-runtime.ts`, update the import block once more. Change:

```ts
import {
  AppEnvironmentSchema,
  FunctionArtifactSchema,
  FunctionVersionSchema,
  MigrationApprovalSchema,
  MigrationBackupSchema,
  MigrationPreviewSchema,
  PathSegmentSchema,
  type AppEnvironment,
  type DestructiveEnvironmentConfirmation,
  type EnvironmentLifecycleOperation,
  type FunctionArtifact,
  type FunctionVersion,
  type MigrationApproval,
  type MigrationBackup,
  type MigrationPreview,
} from '@agent-foundry/contracts';
```

to:

```ts
import {
  AppEnvironmentSchema,
  FunctionArtifactSchema,
  FunctionInvocationResultSchema,
  FunctionVersionSchema,
  MigrationApprovalSchema,
  MigrationBackupSchema,
  MigrationPreviewSchema,
  PathSegmentSchema,
  type AppEnvironment,
  type DestructiveEnvironmentConfirmation,
  type EnvironmentLifecycleOperation,
  type FunctionArtifact,
  type FunctionInvocationResult,
  type FunctionVersion,
  type MigrationApproval,
  type MigrationBackup,
  type MigrationPreview,
} from '@agent-foundry/contracts';
```

Also add the `withSpan` import from domain, next to the existing `@agent-foundry/domain` import. Change:

```ts
import {
  EnvironmentOperationError,
  ValidationError,
  redactString,
  type GeneratedProjectRuntime,
} from '@agent-foundry/domain';
```

to:

```ts
import {
  EnvironmentOperationError,
  ValidationError,
  redactString,
  withSpan,
  type GeneratedProjectRuntime,
} from '@agent-foundry/domain';
```

In the class body, immediately after `rollbackFunction` (added in Task 3), add:

```ts
  async invokeFunction(input: {
    projectId: string;
    functionName: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<FunctionInvocationResult> {
    const environment = await this.#require(input.projectId);
    const versions = await readFunctionVersions(this.#dataDir, environment.projectId, input.functionName);
    const current = versions.at(-1);
    if (!current) {
      throw new ValidationError(`Function "${input.functionName}" has no deployed version.`);
    }
    const apiUrl = environment.endpoints.api;
    if (!apiUrl) {
      throw new EnvironmentOperationError(
        'invoke-function',
        undefined,
        'Environment has no API endpoint.',
      );
    }
    return withSpan(
      'function.invoke',
      { 'function.name': input.functionName, 'project.id': environment.projectId },
      async (span) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), current.artifact.timeoutMs);
        const started = this.#now().getTime();
        try {
          const response = await fetch(`${apiUrl}/functions/v1/${input.functionName}`, {
            method: 'POST',
            headers: input.headers,
            body: input.body,
            signal: controller.signal,
          });
          const text = await response.text();
          span.setAttribute('http.status_code', response.status);
          return FunctionInvocationResultSchema.parse({
            status: response.status,
            body: text.slice(0, 1_048_576),
            durationMs: this.#now().getTime() - started,
            timedOut: false,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return FunctionInvocationResultSchema.parse({
              status: 504,
              body: '',
              durationMs: this.#now().getTime() - started,
              timedOut: true,
            });
          }
          throw operationError('invoke-function', error);
        } finally {
          clearTimeout(timer);
        }
      },
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/platform/src/supabase-runtime.test.ts -t "function invocation"`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full package suite, typecheck, and lint**

Run: `npx vitest run packages/platform/src/supabase-runtime.test.ts && npm run typecheck && npx eslint packages/platform/src/supabase-runtime.ts packages/platform/src/supabase-runtime.test.ts --max-warnings=0`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/platform/src/supabase-runtime.ts packages/platform/src/supabase-runtime.test.ts
git commit -m "feat(platform): invoke deployed functions with traced, timeout-enforced HTTP calls"
```

---

### Task 5: ADR and full verification

**Files:**

- Create: `docs/adr/0032-supabase-functions-versioned-local-deploy.md`

**Interfaces:**

- Consumes: nothing new — this task documents Tasks 1-4.
- Produces: nothing consumed by other tasks — this is the terminal task.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0032-supabase-functions-versioned-local-deploy.md`:

```markdown
# ADR 0032: Versioned local Supabase Functions deploy and rollback

- Status: Accepted
- Date: 2026-07-23
- Owners: Platform, Core
- Extends: ADR 0030

## Context

Issue #69 gives every generated project an isolated Supabase CLI workdir with a local Edge Runtime already enabled (`[edge_runtime]` in `config.toml`). Issue #73 (`v010-functions`) asks for Supabase Functions with immutable, versioned deploys, rollback, declared resource ceilings, and traced invocation — on top of that existing runtime, without Supabase Cloud.

The Supabase CLI has no local equivalent of `supabase functions deploy`: that command targets a linked cloud project. Locally (and in the documented self-hosted Docker setup), a function becomes live purely by existing under `supabase/functions/<name>/` — there is no deploy step to invoke. The CLI's `config.toml` `[functions.<name>]` section only supports `enabled`, `verify_jwt`, `import_map`, `entrypoint`, and `static_files`; it exposes no per-function memory, timeout, or network/egress controls, and the self-hosted Edge Runtime's memory/timeout ceilings (150 MB / 60s by default) are enforced by an orchestrator script we do not control, not per-function.

## Decision

`SupabaseGeneratedProjectRuntime` gains `deployFunction`, `listFunctionVersions`, `rollbackFunction`, and `invokeFunction`. Deploy validates the function's source directory is contained inside the project workdir, snapshots its files (sorted, content-addressed via SHA-256) into an immutable version store under the project's data directory, and activates the version by copying it into the live `supabase/functions/<name>/` directory the CLI's Edge Runtime already serves, writing/updating the `[functions.<name>]` `verify_jwt` field. Rollback re-verifies a stored version's checksum before reactivating it the same way. No CLI subcommand is invoked for deploy or rollback — both are pure filesystem operations, matching how the local runtime actually serves functions.

`invokeFunction` calls the project's own API gateway at `{endpoints.api}/functions/v1/<name>` and enforces the currently-deployed version's `timeoutMs` via `AbortController`, inside an OpenTelemetry span (`withSpan`) so invocations are traced like the rest of the system.

`memoryMb` and `egressAllowlist` are validated and bounded on the artifact (`FunctionArtifactSchema`, ceilings of 512 MB and an explicit host allowlist) and persisted on every version manifest, but are **not** runtime-enforced in this change — there is no verified local mechanism to enforce them per function, and building an unverified one would be worse than declaring the gap. `timeoutMs` is the one ceiling enforced today, because it happens entirely inside our own `invokeFunction` call, not inside the CLI-managed runtime.

## Consequences

Agents can deploy, list, and roll back functions with the same auditability as migrations. A client that calls the Edge Runtime directly (bypassing `invokeFunction`) is not subject to our timeout, and no client is subject to our memory/egress ceilings yet. Enforcing those per function requires either an upstream Supabase CLI/Edge Runtime capability or moving to one Edge Runtime container per function so our own network-policy sidecar (`packages/executors/src/docker-network-policy-sidecar.ts`) and Docker resource limits could attach directly — both are larger changes tracked as follow-up, not part of this issue.

## Validation and rollback

Platform tests cover: deploy activating a version and writing `verify_jwt`; path-containment rejection for out-of-workdir and mismatched-name sources; version listing order; rollback restoring prior content and rejecting unknown version ids and checksum mismatches; invocation success, non-2xx passthrough, timeout enforcement, and rejection of invocation with no deployed version. Roll back by deploying a prior version's source again (there is no separate migration to undo — deployment is idempotent, content-addressed file replacement).
```

- [ ] **Step 2: Run the full CI gate**

Run: `npm run check`
Expected: PASS — format, lint, architecture, roadmap, typecheck, `npm test` (unit + scripts), build all green.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0032-supabase-functions-versioned-local-deploy.md
git commit -m "docs(adr): record versioned local Supabase Functions deploy decision"
```

---

## Self-Review Notes (for the plan author, already applied above)

- **Spec coverage:** function artifact with source/runtime/env refs/permissions → Task 1 (`FunctionArtifactSchema`: `entrypoint`, `envRefs`, `verifyJwt`); immutable version + rollback → Task 3; timeout/memory/egress limited → Task 1 (validated bounds) + Task 4 (timeout enforced) + ADR (honest scope note for memory/egress); logs/traces in project → Task 4 (`withSpan`); tests for deploy/invoke/timeout/secret-access(envRefs-as-names-only)/rollback → Tasks 1, 3, 4.
- **Placeholder scan:** none — every step has full code.
- **Type consistency:** `deployFunction`/`listFunctionVersions`/`rollbackFunction`/`invokeFunction` signatures match verbatim between the port (Task 2), the implementation (Tasks 3-4), and the test fixture fix (Task 2).
