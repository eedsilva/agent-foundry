# Issue #46: SandboxRunner Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking. Also use Ponytail Full, karpathy-guidelines, and TDD throughout.

**Goal:** Define the auditable SandboxRunner contract and its safe create → exec → snapshot → destroy lifecycle, closing issue [#46](https://github.com/eedsilva/agent-foundry/issues/46) (v07-sandbox-runner) without adding a sandbox backend.

**Architecture:** packages/contracts owns strict, serializable schemas for the sandbox specification, command input, and exported snapshot data. packages/domain owns the SandboxRunner port and one lifecycle helper: it forwards timeout, streaming, and AbortSignal to the runner; filters a returned snapshot against the caller's relative-path allowlist; and destroys the sandbox in finally. This deliberately creates no container, RPC transport, executor wiring, or control-plane client; issue #47 supplies the rootless backend that will implement the port.

**Tech Stack:** TypeScript, Zod, Node path.posix, Vitest, existing @agent-foundry/contracts and @agent-foundry/domain workspaces.

## Global Constraints

- Work only in /Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-46-sandbox-runner on branch feat/46-sandbox-runner; never push directly to main.
- No dependency, container runtime, HTTP/RPC transport, control-plane API client, or ExecutionPlane implementation is added. The rootless container backend is the separate dependent task v07-container-backend.
- SandboxSpec must strictly define image, resources, network, mounts, ttlMs, and user; resources includes CPU, memory, disk, and PID ceilings needed by the dependent backend.
- SandboxRunner.exec must accept timeoutMs, an output callback for streaming stdout/stderr, and an optional AbortSignal.
- Snapshot paths are relative sandbox paths only. The lifecycle helper must return only files under the explicit allowlist, even if a runner returns more data.
- SandboxRunner.destroy is documented as idempotent, and the lifecycle helper must call it after both execution and snapshot errors. A failed create has no handle to destroy.
- The agent-facing contract contains no control-plane URL, token, API object, workspace host path, or ExecutionPlane reference; the strict SandboxSpecSchema rejects an injected controlPlane property.
- Preserve existing local ExecutionPlane, executor, orchestrator, preview, and composition behavior. Do not wire this unimplemented port into them.
- Every production change follows verified RED → GREEN → commit.

---

### Task 1: Strict sandbox contracts

**Files:**

- Create: packages/contracts/src/sandbox.ts
- Create: packages/contracts/src/sandbox.test.ts
- Modify: packages/contracts/src/index.ts

**Interfaces:**

- Produce SandboxResourcesSchema → { cpuMillis, memoryMiB, diskMiB, pids } positive integers.
- Produce SandboxMountSchema → { source, target, readOnly }, where target starts with /.
- Produce SandboxSpecSchema → { image, resources, network, mounts, ttlMs, user }, reusing ExecutionNetworkPolicySchema for network.
- Produce SandboxExecSchema → { command, args, timeoutMs }.
- Produce SandboxSnapshotPathSchema for non-empty, non-absolute paths without . or .. segments.
- Produce SandboxSnapshotFileSchema → { path, content: Uint8Array } and SandboxSnapshotSchema → { files }.
- Export all schemas and inferred types from @agent-foundry/contracts.

- [ ] **Step 1: Write the failing contract tests**

```typescript
// packages/contracts/src/sandbox.test.ts
import { describe, expect, it } from 'vitest';
import { SandboxSnapshotPathSchema, SandboxSpecSchema } from './index.js';

const spec = {
  image: 'ghcr.io/agent-foundry/sandbox@sha256:abc',
  resources: { cpuMillis: 500, memoryMiB: 512, diskMiB: 1024, pids: 64 },
  network: { mode: 'none', allowedHosts: [] },
  mounts: [{ source: 'workspace', target: '/workspace', readOnly: false }],
  ttlMs: 60_000,
  user: '1000:1000',
};

describe('SandboxSpecSchema', () => {
  it('parses the complete sandbox boundary', () => {
    expect(SandboxSpecSchema.parse(spec)).toMatchObject({ image: spec.image, user: spec.user });
  });

  it('rejects a control-plane field instead of carrying it into the sandbox', () => {
    expect(
      SandboxSpecSchema.safeParse({ ...spec, controlPlane: { token: 'secret' } }).success,
    ).toBe(false);
  });
});

describe('SandboxSnapshotPathSchema', () => {
  it.each(['/workspace/.env', '../.env', 'src/../.env'])(
    'rejects unsafe snapshot path %s',
    (path) => {
      expect(SandboxSnapshotPathSchema.safeParse(path).success).toBe(false);
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: npm run test:unit -- packages/contracts/src/sandbox.test.ts

Expected: FAIL because ./index.js does not export sandbox contract symbols.

- [ ] **Step 3: Write the minimum contract implementation**

```typescript
// packages/contracts/src/sandbox.ts
import { z } from 'zod';
import { ExecutionNetworkPolicySchema } from './execution-plane.js';

export const SandboxResourcesSchema = z
  .object({
    cpuMillis: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    diskMiB: z.number().int().positive(),
    pids: z.number().int().positive(),
  })
  .strict();
export type SandboxResources = z.infer<typeof SandboxResourcesSchema>;

export const SandboxMountSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1).startsWith('/'),
    readOnly: z.boolean(),
  })
  .strict();
export type SandboxMount = z.infer<typeof SandboxMountSchema>;

export const SandboxSpecSchema = z
  .object({
    image: z.string().min(1),
    resources: SandboxResourcesSchema,
    network: ExecutionNetworkPolicySchema,
    mounts: z.array(SandboxMountSchema),
    ttlMs: z.number().int().positive(),
    user: z.string().min(1),
  })
  .strict();
export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

export const SandboxExecSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type SandboxExec = z.infer<typeof SandboxExecSchema>;

export const SandboxSnapshotPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Sandbox snapshot paths must be relative and cannot traverse directories',
  );
export type SandboxSnapshotPath = z.infer<typeof SandboxSnapshotPathSchema>;

export const SandboxSnapshotFileSchema = z
  .object({ path: SandboxSnapshotPathSchema, content: z.instanceof(Uint8Array) })
  .strict();
export type SandboxSnapshotFile = z.infer<typeof SandboxSnapshotFileSchema>;

export const SandboxSnapshotSchema = z
  .object({ files: z.array(SandboxSnapshotFileSchema) })
  .strict();
export type SandboxSnapshot = z.infer<typeof SandboxSnapshotSchema>;
```

Add this line to packages/contracts/src/index.ts:

```typescript
export * from './sandbox.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: npm run test:unit -- packages/contracts/src/sandbox.test.ts && npm run typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/sandbox.ts packages/contracts/src/sandbox.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): define sandbox lifecycle contract"
```

---

### Task 2: Sandbox lifecycle port and cleanup guarantee

**Files:**

- Create: packages/domain/src/sandbox-runner.ts
- Create: packages/domain/src/sandbox-runner.test.ts
- Modify: packages/domain/src/index.ts

**Interfaces:**

- Consumes: SandboxSpec, SandboxExec, SandboxSnapshot, and SandboxSnapshotPathSchema from Task 1.
- Produces SandboxHandle → { id: string }.
- Produces SandboxOutputChunk → { stream: 'stdout' | 'stderr', text: string }.
- Produces SandboxExecRequest = SandboxExec plus optional onOutput(chunk) callback.
- Produces SandboxExecResult → { exitCode, stdout, stderr }.
- Produces SandboxRunner with create, exec, snapshot, and idempotent destroy methods.
- Produces runSandboxLifecycle(runner, spec, exec, allowedPaths, signal?), returning { result, snapshot } after always destroying a created sandbox.

- [ ] **Step 1: Write the failing lifecycle tests**

```typescript
// packages/domain/src/sandbox-runner.test.ts
import { describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import { runSandboxLifecycle, type SandboxRunner } from './sandbox-runner.js';

const spec: SandboxSpec = {
  image: 'sandbox:1',
  resources: { cpuMillis: 500, memoryMiB: 512, diskMiB: 1024, pids: 64 },
  network: { mode: 'none', allowedHosts: [] },
  mounts: [],
  ttlMs: 60_000,
  user: '1000:1000',
};

class FakeSandboxRunner implements SandboxRunner {
  readonly destroyed = new Set<string>();
  destroyCalls = 0;
  createCalls = 0;
  readonly signals: Array<AbortSignal | undefined> = [];
  constructor(private readonly failAt?: 'create' | 'exec' | 'snapshot') {}
  async create() {
    this.createCalls += 1;
    if (this.failAt === 'create') throw new Error('create failed');
    return { id: 'sandbox-1' };
  }
  async exec(
    _sandbox: { id: string },
    request: Parameters<SandboxRunner['exec']>[1],
    signal?: AbortSignal,
  ) {
    this.signals.push(signal);
    request.onOutput?.({ stream: 'stdout', text: 'running' });
    if (this.failAt === 'exec') throw new Error('exec failed');
    return { exitCode: 0, stdout: 'done', stderr: '' };
  }
  async snapshot() {
    if (this.failAt === 'snapshot') throw new Error('snapshot failed');
    return {
      files: [
        { path: 'src/index.ts', content: new Uint8Array([1]) },
        { path: 'secrets/.env', content: new Uint8Array([2]) },
      ],
    };
  }
  async destroy(sandbox: { id: string }) {
    if (this.destroyed.has(sandbox.id)) return;
    this.destroyed.add(sandbox.id);
    this.destroyCalls += 1;
  }
}

describe('runSandboxLifecycle', () => {
  it('streams output, forwards the signal, exports only allowed paths, and destroys the sandbox', async () => {
    const runner = new FakeSandboxRunner();
    const output: string[] = [];
    const signal = new AbortController().signal;
    const result = await runSandboxLifecycle(
      runner,
      spec,
      {
        command: 'agent',
        args: ['run'],
        timeoutMs: 1_000,
        onOutput: (chunk) => output.push(chunk.text),
      },
      ['src'],
      signal,
    );
    expect(output).toEqual(['running']);
    expect(runner.signals).toEqual([signal]);
    expect(result.snapshot.files.map((file) => file.path)).toEqual(['src/index.ts']);
    expect(runner.destroyed).toEqual(new Set(['sandbox-1']));
  });

  it.each([
    ['exec', 'exec failed'],
    ['snapshot', 'snapshot failed'],
  ] as const)('destroys after a %s error', async (failAt, message) => {
    const runner = new FakeSandboxRunner(failAt);
    await expect(
      runSandboxLifecycle(runner, spec, { command: 'agent', args: [], timeoutMs: 1_000 }, ['src']),
    ).rejects.toThrow(message);
    expect(runner.destroyed).toEqual(new Set(['sandbox-1']));
  });

  it('does not attempt destroy when create fails before yielding a handle', async () => {
    const runner = new FakeSandboxRunner('create');
    await expect(
      runSandboxLifecycle(runner, spec, { command: 'agent', args: [], timeoutMs: 1_000 }, ['src']),
    ).rejects.toThrow('create failed');
    expect(runner.destroyed).toEqual(new Set());
  });

  it('rejects an unsafe allowlist before creating a sandbox', async () => {
    const runner = new FakeSandboxRunner();
    await expect(
      runSandboxLifecycle(runner, spec, { command: 'agent', args: [], timeoutMs: 1_000 }, [
        '../secrets',
      ]),
    ).rejects.toThrow('Sandbox snapshot paths must be relative');
    expect(runner.createCalls).toBe(0);
  });

  it('requires idempotent destroy for a sandbox handle', async () => {
    const runner = new FakeSandboxRunner();
    const sandbox = await runner.create(spec);
    await runner.destroy(sandbox);
    await runner.destroy(sandbox);
    expect(runner.destroyCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: npm run test:unit -- packages/domain/src/sandbox-runner.test.ts

Expected: FAIL because sandbox-runner.ts does not exist.

- [ ] **Step 3: Write the minimum port and lifecycle helper**

```typescript
// packages/domain/src/sandbox-runner.ts
import { posix as path } from 'node:path';
import {
  SandboxSnapshotPathSchema,
  type SandboxExec,
  type SandboxSnapshot,
  type SandboxSpec,
} from '@agent-foundry/contracts';

export interface SandboxHandle {
  id: string;
}

export interface SandboxOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface SandboxExecRequest extends SandboxExec {
  onOutput?: (chunk: SandboxOutputChunk) => void;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxRunner {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(
    sandbox: SandboxHandle,
    request: SandboxExecRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult>;
  snapshot(sandbox: SandboxHandle, allowedPaths: readonly string[]): Promise<SandboxSnapshot>;
  /** Must be safe to call repeatedly for the same handle. */
  destroy(sandbox: SandboxHandle): Promise<void>;
}

export async function runSandboxLifecycle(
  runner: SandboxRunner,
  spec: SandboxSpec,
  exec: SandboxExecRequest,
  allowedPaths: readonly string[],
  signal?: AbortSignal,
): Promise<{ result: SandboxExecResult; snapshot: SandboxSnapshot }> {
  const allowed = allowedPaths.map((entry) => SandboxSnapshotPathSchema.parse(entry));
  const sandbox = await runner.create(spec);
  try {
    const result = await runner.exec(sandbox, exec, signal);
    const snapshot = await runner.snapshot(sandbox, allowed);
    return {
      result,
      snapshot: {
        files: snapshot.files.filter((file) =>
          allowed.some((entry) => isAllowed(file.path, entry)),
        ),
      },
    };
  } finally {
    await runner.destroy(sandbox);
  }
}

function isAllowed(filePath: string, allowedPath: string): boolean {
  const relative = path.relative(allowedPath, filePath);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
```

Add this line to packages/domain/src/index.ts:

```typescript
export * from './sandbox-runner.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: npm run test:unit -- packages/domain/src/sandbox-runner.test.ts && npm run typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/sandbox-runner.ts packages/domain/src/sandbox-runner.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): add sandbox runner lifecycle port"
```

---

### Task 3: Record the security boundary and delivery evidence

**Files:**

- Create: docs/adr/0024-sandbox-runner-lifecycle.md
- Modify: docs/ARCHITECTURE.md
- Modify: docs/SECURITY.md

**Interfaces:**

- Consumes: the final Task 1 and Task 2 names exactly: SandboxSpec, SandboxRunner, runSandboxLifecycle.
- Produces: an accepted ADR that states the current port boundary, strict snapshot export rule, destroy semantics, no control-plane capability in agent inputs, explicit scope limit (no isolation until #47), validation command, and plain-revert rollback.

- [ ] **Step 1: Write the failing documentation assertion**

```bash
rg -q 'SandboxRunner' docs/adr/0024-sandbox-runner-lifecycle.md docs/ARCHITECTURE.md docs/SECURITY.md
```

Expected: FAIL because ADR 0024 and the security-boundary references do not yet exist.

- [ ] **Step 2: Add the decision record and concise boundary documentation**

Create docs/adr/0024-sandbox-runner-lifecycle.md:

```markdown
# ADR 0024: Sandbox runner lifecycle boundary

- Status: Accepted
- Date: 2026-07-18
- Owners: Safety and Executors

## Context

Issue #46 requires one auditable contract for an isolated execution environment before a rootless container backend exists.

## Decision

SandboxSpec strictly carries image, CPU/memory/disk/PID ceilings, network policy, mounts, TTL, and user. SandboxRunner owns create, exec, snapshot, and idempotent destroy. runSandboxLifecycle forwards timeout, output streaming, and cancellation; filters exported files to caller-approved relative paths; and destroys every created sandbox in finally. The agent-facing shapes contain no control-plane API capability.

## Consequences

This is a contract boundary, not a sandbox implementation: LocalExecutionPlane remains the trusted local-development path until #47 supplies a rootless backend. Callers must provide explicit snapshot allowlists; files outside them are discarded.

## Validation and rollback

packages/domain/src/sandbox-runner.test.ts proves success, streaming, allowed-path filtering, and cleanup after exec/snapshot failure. Roll back with a revert; all values are transient and unpersisted.
```

In docs/ARCHITECTURE.md, extend the execution-plane paragraph to name SandboxRunner as the upcoming runner contract and state that no backend is wired yet. In docs/SECURITY.md, replace the v07-sandbox-runner/v07-container-backend sentence with one that distinguishes the new lifecycle contract from the still-unresolved host-permission risk until #47.

- [ ] **Step 3: Verify the documentation and relevant tests**

Run:

```bash
rg -q 'SandboxRunner' docs/adr/0024-sandbox-runner-lifecycle.md docs/ARCHITECTURE.md docs/SECURITY.md
npm run test:unit -- packages/contracts/src/sandbox.test.ts packages/domain/src/sandbox-runner.test.ts
npm run format:check
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0024-sandbox-runner-lifecycle.md docs/ARCHITECTURE.md docs/SECURITY.md
git commit -m "docs: record sandbox runner security boundary"
```

---

## Final verification and evidence

- [ ] Run npm run format:check, npm run lint, npm run architecture:check, npm run roadmap:check, npm run typecheck, npm test, and npm run build.
- [ ] Run npx playwright test --config apps/api/e2e/playwright.config.ts and record an explicit skip only if required browser/runtime configuration is unavailable.
- [ ] Run npm run doctor.
- [ ] Run ponytail-review and code-simplifier-v2 against the branch diff. Apply only behavior-preserving, issue-scoped findings; rerun affected tests and the full gate after any change.
- [ ] Create a PR with Closes #46, the acceptance-criteria-to-test mapping, full gate and E2E evidence, security impact (contract only; no backend isolation yet), migration impact (none), and rollback (git revert). Add the same evidence as a comment on issue #46 after the PR opens.
