# Chat Streaming Implementation Plan (issue #39)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream assistant text, tool start/end, status, approval, and error events live from the running CLI subprocess into the chat, with cursor-based reconnect, collapsed/redacted tool output, contextual cancel/pause, and completed-Operation links to diff/preview/artifacts.

**Architecture:** Tap the provider CLI's own JSONL stream (`--output-format stream-json` for Claude, `--json` for Codex) as it arrives on stdout, translate each line into a normalized `AgentStreamEvent`, persist it to a new per-run JSONL store (same cursor/lock idiom as the existing conversation-messages and project-events stores), expose it over a new SSE endpoint reusing the existing `streamSse` helper verbatim, and merge it client-side into the existing "Conversa" panel — the other panels ("Linha do tempo", "Steps da execução", "Aprovações") are untouched.

**Tech Stack:** TypeScript, Zod, Fastify, execa, vitest, Next.js/React 19 (no component-test harness in this repo — web logic lives in unit-tested `lib/*.ts` files; JSX wiring is verified manually via the dev server per project convention).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-chat-streaming-design.md` — read it before starting; this plan implements it task by task.
- Every new/changed package must pass `npm run typecheck`, `npm run lint:code` (via `npm run check` at the end), and its own `vitest run` before commit.
- No new runtime dependencies — everything needed (execa, zod, fastify) is already installed.
- Follow existing redaction convention: any user/CLI-derived text persisted to disk goes through `redactString` from `@agent-foundry/domain` before being written (matches `conversation-repository.ts`).
- Commit after each task (not each step) once its own tests pass — keep commits scoped and buildable.
- `AgentStreamEvent`'s `attemptId` is optional (approval-gate stepRuns have no execution attempt); `ExecutorStreamEvent` (executor-mapper output) never includes an `approval` variant — only the orchestrator's approval-gate code path emits that variant, directly.
- `Omit` does **not** distribute over TypeScript unions — never write `Omit<AgentStreamEvent, 'sequence'>` directly; use the `DistributiveOmit` alias defined in Task 1 (exported as `AgentStreamEventInput`).

---

### Task 1: `AgentStreamEvent` contract

**Files:**
- Create: `packages/contracts/src/agent-stream.ts`
- Create: `packages/contracts/src/agent-stream.test.ts`
- Modify: `packages/contracts/src/index.ts` — add `export * from './agent-stream.js';`

**Interfaces:**
- Produces: `ExecutorStreamEvent` (payload-only union, no envelope — used by executor/domain-port callbacks), `AgentStreamEventSchema`/`AgentStreamEvent` (full envelope + payload, persisted/transmitted shape), `AgentStreamEventInput` (envelope minus `sequence`, the repository's `append()` argument type).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/contracts/src/agent-stream.test.ts
import { describe, expect, it } from 'vitest';
import { AgentStreamEventSchema } from './agent-stream.js';

const base = {
  id: 'evt-1',
  runId: 'run-1',
  stepRunId: 'step-1',
  sequence: 1,
  createdAt: '2026-07-18T00:00:00.000Z',
};

describe('AgentStreamEventSchema', () => {
  it('accepts an assistant_delta event without attemptId', () => {
    const event = { ...base, type: 'assistant_delta', text: 'Hello' };
    expect(AgentStreamEventSchema.parse(event)).toEqual(event);
  });

  it('accepts a tool_end event with attemptId and detail', () => {
    const event = {
      ...base,
      attemptId: 'attempt-1',
      type: 'tool_end',
      toolName: 'Read',
      summary: 'Read: src/app.ts',
      ok: true,
      detail: 'file contents',
    };
    expect(AgentStreamEventSchema.parse(event)).toEqual(event);
  });

  it('accepts an approval event with no attemptId (approval-gate stepRuns have none)', () => {
    const event = { ...base, type: 'approval', approvalRequestId: 'req-1' };
    expect(AgentStreamEventSchema.parse(event)).toEqual(event);
  });

  it('rejects an unknown discriminant', () => {
    expect(() => AgentStreamEventSchema.parse({ ...base, type: 'bogus' })).toThrow();
  });

  it('rejects extra keys not defined on the matched variant', () => {
    expect(() =>
      AgentStreamEventSchema.parse({ ...base, type: 'status', phase: 'started', extra: 'nope' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/agent-stream.test.ts`
Expected: FAIL — `Cannot find module './agent-stream.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/contracts/src/agent-stream.ts
import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';

/**
 * Payload-only shape a provider CLI's stdout stream can produce, before the
 * envelope (id/runId/stepRunId/attemptId/sequence/createdAt) is attached.
 * Executors and AgentExecutor/ExecutionPlane callbacks use this — it never
 * includes 'approval', which only the orchestrator's approval-gate code
 * emits directly (no executor is involved in that path).
 */
export type ExecutorStreamEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_start'; toolName: string; summary: string }
  | { type: 'tool_end'; toolName: string; summary: string; ok: boolean; detail?: string }
  | { type: 'status'; phase: string }
  | { type: 'error'; message: string };

const streamEnvelope = {
  id: PathSegmentSchema,
  runId: PathSegmentSchema,
  stepRunId: PathSegmentSchema,
  // Absent for approval-gate stepRuns, which have no execution attempt.
  attemptId: PathSegmentSchema.optional(),
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
};

export const AgentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ ...streamEnvelope, type: z.literal('assistant_delta'), text: z.string() }).strict(),
  z
    .object({
      ...streamEnvelope,
      type: z.literal('tool_start'),
      toolName: z.string(),
      summary: z.string(),
    })
    .strict(),
  z
    .object({
      ...streamEnvelope,
      type: z.literal('tool_end'),
      toolName: z.string(),
      summary: z.string(),
      ok: z.boolean(),
      // Redacted raw excerpt behind the "show details" toggle; capped so the
      // durable per-run event log never grows unbounded from one tool call.
      detail: z.string().max(4_000).optional(),
    })
    .strict(),
  z.object({ ...streamEnvelope, type: z.literal('status'), phase: z.string() }).strict(),
  z
    .object({ ...streamEnvelope, type: z.literal('approval'), approvalRequestId: PathSegmentSchema })
    .strict(),
  z.object({ ...streamEnvelope, type: z.literal('error'), message: z.string() }).strict(),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

/**
 * Plain `Omit<AgentStreamEvent, 'sequence'>` does NOT distribute over this
 * union (TS's Omit collapses to only the keys common across all members),
 * silently erasing every variant-specific field. This conditional form
 * distributes correctly and is the type `StepEventRepository.append()` takes.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type AgentStreamEventInput = DistributiveOmit<AgentStreamEvent, 'sequence'>;
```

- [ ] **Step 4: Modify contracts barrel export**

In `packages/contracts/src/index.ts`, add this line after the existing `export * from './conversation.js';` line:

```typescript
export * from './agent-stream.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/agent-stream.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Typecheck the package**

Run: `npm run typecheck --workspace @agent-foundry/contracts`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/agent-stream.ts packages/contracts/src/agent-stream.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add AgentStreamEvent schema for issue #39"
```

---

### Task 2: `StepEventRepository` domain port + file-backed implementation

**Files:**
- Modify: `packages/domain/src/ports.ts` — add `StepEventRepository` interface near `EventStore` (~line 155-158)
- Create: `packages/persistence/src/step-event-repository.ts`
- Create: `packages/persistence/src/step-event-repository.test.ts`
- Modify: `packages/persistence/src/index.ts` — add `export * from './step-event-repository.js';`

**Interfaces:**
- Consumes: `AgentStreamEvent`, `AgentStreamEventSchema`, `AgentStreamEventInput` from `@agent-foundry/contracts` (Task 1); `redactString` from `@agent-foundry/domain`; `appendJsonLine`, `pathFor`, `readJsonLines`, `withDirectoryLock` from `./fs-utils.js` (all pre-existing, same as `event-store.ts`).
- Produces: `StepEventRepository` interface — `append(event: AgentStreamEventInput): Promise<AgentStreamEvent>`, `list(runId: string, options?: { cursor?: number; limit?: number }): Promise<AgentStreamEvent[]>`. `FileStepEventRepository` class implementing it, exported from `@agent-foundry/persistence`.

- [ ] **Step 1: Add the port interface**

In `packages/domain/src/ports.ts`, immediately after the existing `EventStore` interface (ends at line 158 with `}`), insert:

```typescript
export interface StepEventRepository {
  append(event: AgentStreamEventInput): Promise<AgentStreamEvent>;
  list(runId: string, options?: { cursor?: number; limit?: number }): Promise<AgentStreamEvent[]>;
}
```

Add `AgentStreamEvent` and `AgentStreamEventInput` to the existing `import type { ... } from '@agent-foundry/contracts';` block at the top of `ports.ts` (alongside `AgentExecutionRequest`, etc.).

- [ ] **Step 2: Write the failing test**

```typescript
// packages/persistence/src/step-event-repository.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStepEventRepository } from './step-event-repository.js';

let dataDir: string;
let repository: FileStepEventRepository;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'step-events-'));
  repository = new FileStepEventRepository(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('FileStepEventRepository', () => {
  it('assigns an increasing sequence per run and lists in order', async () => {
    const first = await repository.append({
      id: 'evt-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'tool_start',
      toolName: 'Read',
      summary: 'Read: src/app.ts',
    });
    const second = await repository.append({
      id: 'evt-2',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      createdAt: '2026-07-18T00:00:01.000Z',
      type: 'tool_end',
      toolName: 'Read',
      summary: 'Read: src/app.ts',
      ok: true,
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);

    const all = await repository.list('run-1');
    expect(all.map((event) => event.id)).toEqual(['evt-1', 'evt-2']);
  });

  it('filters by cursor for reconnect replay', async () => {
    await repository.append({
      id: 'evt-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'status',
      phase: 'started',
    });
    await repository.append({
      id: 'evt-2',
      runId: 'run-1',
      stepRunId: 'step-1',
      createdAt: '2026-07-18T00:00:01.000Z',
      type: 'status',
      phase: 'thinking',
    });

    const afterFirst = await repository.list('run-1', { cursor: 1 });
    expect(afterFirst.map((event) => event.id)).toEqual(['evt-2']);
  });

  it('scopes sequences independently per run', async () => {
    const runOneEvent = await repository.append({
      id: 'evt-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'status',
      phase: 'started',
    });
    const runTwoEvent = await repository.append({
      id: 'evt-2',
      runId: 'run-2',
      stepRunId: 'step-2',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'status',
      phase: 'started',
    });

    expect(runOneEvent.sequence).toBe(1);
    expect(runTwoEvent.sequence).toBe(1);
  });

  it('redacts assistant_delta text at write time', async () => {
    const event = await repository.append({
      id: 'evt-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'assistant_delta',
      text: 'export const OPENAI_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz012345";',
    });
    expect(event.type).toBe('assistant_delta');
    if (event.type === 'assistant_delta') {
      expect(event.text).toContain('[REDACTED]');
      expect(event.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/step-event-repository.test.ts`
Expected: FAIL — `Cannot find module './step-event-repository.js'`

- [ ] **Step 4: Write minimal implementation**

```typescript
// packages/persistence/src/step-event-repository.ts
import {
  AgentStreamEventSchema,
  type AgentStreamEvent,
  type AgentStreamEventInput,
} from '@agent-foundry/contracts';
import { redactString, type StepEventRepository } from '@agent-foundry/domain';
import { appendJsonLine, pathFor, readJsonLines, withDirectoryLock } from './fs-utils.js';

export class FileStepEventRepository implements StepEventRepository {
  constructor(private readonly dataDir: string) {}

  async append(event: AgentStreamEventInput): Promise<AgentStreamEvent> {
    const path = this.filePath(event.runId);
    return withDirectoryLock(`${path}.lock`, async () => {
      const existing = await this.readEvents(event.runId);
      const parsed = AgentStreamEventSchema.parse({
        ...redactPayload(event),
        sequence: (existing.at(-1)?.sequence ?? 0) + 1,
      });
      await appendJsonLine(path, parsed);
      return parsed;
    });
  }

  async list(
    runId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<AgentStreamEvent[]> {
    const cursor = options.cursor ?? 0;
    const events = (await this.readEvents(runId)).filter((event) => event.sequence > cursor);
    return options.limit === undefined ? events : events.slice(0, options.limit);
  }

  private async readEvents(runId: string): Promise<AgentStreamEvent[]> {
    return (await readJsonLines<unknown>(this.filePath(runId))).map((value) =>
      AgentStreamEventSchema.parse(value),
    );
  }

  private filePath(runId: string): string {
    return pathFor(this.dataDir, 'runs', runId, 'stream-events.jsonl');
  }
}

function redactPayload(event: AgentStreamEventInput): AgentStreamEventInput {
  switch (event.type) {
    case 'assistant_delta':
      return { ...event, text: redactString(event.text) };
    case 'tool_start':
      return { ...event, summary: redactString(event.summary) };
    case 'tool_end':
      return {
        ...event,
        summary: redactString(event.summary),
        ...(event.detail !== undefined ? { detail: redactString(event.detail) } : {}),
      };
    case 'error':
      return { ...event, message: redactString(event.message) };
    case 'status':
    case 'approval':
      return event;
  }
}
```

- [ ] **Step 5: Wire the barrel export**

In `packages/persistence/src/index.ts`, add:

```typescript
export * from './step-event-repository.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/step-event-repository.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Typecheck both packages**

Run: `npm run typecheck --workspace @agent-foundry/domain && npm run typecheck --workspace @agent-foundry/persistence`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/ports.ts packages/persistence/src/step-event-repository.ts packages/persistence/src/step-event-repository.test.ts packages/persistence/src/index.ts
git commit -m "feat(persistence): add StepEventRepository for issue #39"
```

---

### Task 3: Claude CLI stream-json mapper

**Files:**
- Create: `packages/executors/src/claude-stream-events.ts`
- Create: `packages/executors/src/claude-stream-events.test.ts`
- Modify: `packages/executors/src/index.ts` — add `export * from './claude-stream-events.js';`

**Interfaces:**
- Consumes: `ExecutorStreamEvent` from `@agent-foundry/contracts` (Task 1).
- Produces: `createClaudeStreamMapper(): (line: string) => ExecutorStreamEvent[]` — a **stateful** factory (tracks `tool_use` id → name across lines so a later `tool_result` can report which tool finished); one instance per CLI invocation, never shared across runs.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/executors/src/claude-stream-events.test.ts
import { describe, expect, it } from 'vitest';
import { createClaudeStreamMapper } from './claude-stream-events.js';

describe('createClaudeStreamMapper', () => {
  it('emits a status event for the init line', () => {
    const mapLine = createClaudeStreamMapper();
    const events = mapLine(
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }),
    );
    expect(events).toEqual([{ type: 'status', phase: 'started' }]);
  });

  it('emits assistant_delta for a text content block', () => {
    const mapLine = createClaudeStreamMapper();
    const events = mapLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Reading the file now.' }] },
      }),
    );
    expect(events).toEqual([{ type: 'assistant_delta', text: 'Reading the file now.' }]);
  });

  it('pairs tool_use with a later tool_result by id, carrying the tool name across', () => {
    const mapLine = createClaudeStreamMapper();
    const startEvents = mapLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/app.ts' } },
          ],
        },
      }),
    );
    expect(startEvents).toEqual([
      { type: 'tool_start', toolName: 'Read', summary: 'Read: src/app.ts' },
    ]);

    const endEvents = mapLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
        },
      }),
    );
    expect(endEvents).toEqual([
      { type: 'tool_end', toolName: 'Read', summary: 'Read completed', ok: true, detail: 'file contents' },
    ]);
  });

  it('marks a tool_result with is_error as a failed tool_end', () => {
    const mapLine = createClaudeStreamMapper();
    mapLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }] },
      }),
    );
    const endEvents = mapLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'command failed' },
          ],
        },
      }),
    );
    expect(endEvents).toEqual([
      { type: 'tool_end', toolName: 'Bash', summary: 'Bash failed', ok: false, detail: 'command failed' },
    ]);
  });

  it('emits an error event for a terminal error result', () => {
    const mapLine = createClaudeStreamMapper();
    const events = mapLine(
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Agent crashed' }),
    );
    expect(events).toEqual([{ type: 'error', message: 'Agent crashed' }]);
  });

  it('returns an empty array for a successful terminal result', () => {
    const mapLine = createClaudeStreamMapper();
    const events = mapLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
    expect(events).toEqual([]);
  });

  it('returns an empty array for a malformed line instead of throwing', () => {
    const mapLine = createClaudeStreamMapper();
    expect(mapLine('not json')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/claude-stream-events.test.ts`
Expected: FAIL — `Cannot find module './claude-stream-events.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/executors/src/claude-stream-events.ts
import type { ExecutorStreamEvent } from '@agent-foundry/contracts';

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Claude Code's `--output-format stream-json` emits one JSON object per line:
 * assistant/user turns carry content blocks (text, tool_use, tool_result);
 * a terminal `result` line closes the turn. tool_use and its matching
 * tool_result arrive on separate lines, so this mapper is stateful — one
 * instance must be created per CLI invocation, never reused across runs.
 */
export function createClaudeStreamMapper(): (line: string) => ExecutorStreamEvent[] {
  const toolNames = new Map<string, string>();

  return (line: string): ExecutorStreamEvent[] => {
    const record = tryParseRecord(line);
    if (!record) return [];

    if (record.type === 'system' && record.subtype === 'init') {
      return [{ type: 'status', phase: 'started' }];
    }

    if (record.type === 'assistant' || record.type === 'user') {
      const message = record.message as { content?: ClaudeContentBlock[] } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const events: ExecutorStreamEvent[] = [];
      for (const block of blocks) events.push(...mapContentBlock(block, toolNames));
      return events;
    }

    if (record.type === 'result' && (record.is_error === true || record.subtype === 'error')) {
      const message = typeof record.result === 'string' ? record.result : 'Agent reported an error';
      return [{ type: 'error', message }];
    }

    return [];
  };
}

function mapContentBlock(
  block: ClaudeContentBlock,
  toolNames: Map<string, string>,
): ExecutorStreamEvent[] {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
    return [{ type: 'assistant_delta', text: block.text }];
  }
  if (block.type === 'tool_use' && typeof block.name === 'string') {
    if (typeof block.id === 'string') toolNames.set(block.id, block.name);
    return [{ type: 'tool_start', toolName: block.name, summary: toolSummary(block.name, block.input) }];
  }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
    const toolName = toolNames.get(block.tool_use_id) ?? 'tool';
    toolNames.delete(block.tool_use_id);
    const ok = block.is_error !== true;
    const detail = typeof block.content === 'string' ? block.content.slice(0, 4_000) : undefined;
    return [
      {
        type: 'tool_end',
        toolName,
        summary: ok ? `${toolName} completed` : `${toolName} failed`,
        ok,
        ...(detail ? { detail } : {}),
      },
    ];
  }
  return [];
}

function toolSummary(name: string, input: unknown): string {
  if (input && typeof input === 'object' && 'file_path' in (input as Record<string, unknown>)) {
    const filePath = (input as Record<string, unknown>).file_path;
    if (typeof filePath === 'string') return `${name}: ${filePath}`;
  }
  return name;
}

function tryParseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Wire the barrel export**

In `packages/executors/src/index.ts`, add:

```typescript
export * from './claude-stream-events.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/claude-stream-events.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/executors/src/claude-stream-events.ts packages/executors/src/claude-stream-events.test.ts packages/executors/src/index.ts
git commit -m "feat(executors): map Claude stream-json lines to AgentStreamEvent"
```

---

### Task 4: Codex CLI `--json` mapper

**Files:**
- Create: `packages/executors/src/codex-stream-events.ts`
- Create: `packages/executors/src/codex-stream-events.test.ts`
- Modify: `packages/executors/src/index.ts` — add `export * from './codex-stream-events.js';`

**Interfaces:**
- Consumes: `ExecutorStreamEvent` from `@agent-foundry/contracts`.
- Produces: `createCodexStreamMapper(): (line: string) => ExecutorStreamEvent[]`. Codex's `exec --json` only reports `item.completed` (no separate start signal), so every non-`agent_message` item maps straight to a `tool_end` with no preceding `tool_start` — this is the CLI's real granularity, not a bug (see design doc's "not artificially split" non-goal).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/executors/src/codex-stream-events.test.ts
import { describe, expect, it } from 'vitest';
import { createCodexStreamMapper } from './codex-stream-events.js';

describe('createCodexStreamMapper', () => {
  it('ignores thread.started/turn.started/turn.completed lines', () => {
    const mapLine = createCodexStreamMapper();
    expect(mapLine(JSON.stringify({ type: 'thread.started', thread_id: 't1' }))).toEqual([]);
    expect(mapLine(JSON.stringify({ type: 'turn.started' }))).toEqual([]);
    expect(mapLine(JSON.stringify({ type: 'turn.completed', usage: {} }))).toEqual([]);
  });

  it('emits assistant_delta for a completed agent_message item', () => {
    const mapLine = createCodexStreamMapper();
    const events = mapLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'Done reading.' },
      }),
    );
    expect(events).toEqual([{ type: 'assistant_delta', text: 'Done reading.' }]);
  });

  it('emits a status event for a reasoning item', () => {
    const mapLine = createCodexStreamMapper();
    const events = mapLine(
      JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'reasoning' } }),
    );
    expect(events).toEqual([{ type: 'status', phase: 'thinking' }]);
  });

  it('emits a completed tool_end for a command_execution item with no prior tool_start', () => {
    const mapLine = createCodexStreamMapper();
    const events = mapLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_3', type: 'command_execution', command: 'npm test', status: 'completed' },
      }),
    );
    expect(events).toEqual([
      { type: 'tool_end', toolName: 'command_execution', summary: 'Ran: npm test', ok: true },
    ]);
  });

  it('marks a failed item as ok: false', () => {
    const mapLine = createCodexStreamMapper();
    const events = mapLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_4', type: 'command_execution', command: 'npm test', status: 'failed' },
      }),
    );
    expect(events).toEqual([
      { type: 'tool_end', toolName: 'command_execution', summary: 'Ran: npm test', ok: false },
    ]);
  });

  it('returns an empty array for a malformed line instead of throwing', () => {
    const mapLine = createCodexStreamMapper();
    expect(mapLine('not json')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/codex-stream-events.test.ts`
Expected: FAIL — `Cannot find module './codex-stream-events.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/executors/src/codex-stream-events.ts
import type { ExecutorStreamEvent } from '@agent-foundry/contracts';

/**
 * Codex's `exec --json` emits JSONL where each item is reported only once
 * completed — there is no separate start event. Every non-agent_message,
 * non-reasoning item therefore maps directly to a finished tool_end.
 */
export function createCodexStreamMapper(): (line: string) => ExecutorStreamEvent[] {
  return (line: string): ExecutorStreamEvent[] => {
    const record = tryParseRecord(line);
    if (!record || record.type !== 'item.completed') return [];
    const item = record.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const itemRecord = item as Record<string, unknown>;

    if (itemRecord.type === 'agent_message') {
      return typeof itemRecord.text === 'string' && itemRecord.text.length > 0
        ? [{ type: 'assistant_delta', text: itemRecord.text }]
        : [];
    }
    if (itemRecord.type === 'reasoning') {
      return [{ type: 'status', phase: 'thinking' }];
    }

    const ok = itemRecord.status !== 'failed' && itemRecord.status !== 'error';
    return [
      {
        type: 'tool_end',
        toolName: typeof itemRecord.type === 'string' ? itemRecord.type : 'tool',
        summary: itemSummary(itemRecord),
        ok,
      },
    ];
  };
}

function itemSummary(item: Record<string, unknown>): string {
  if (typeof item.command === 'string') return `Ran: ${item.command}`;
  if (typeof item.path === 'string') return `Changed: ${item.path}`;
  return typeof item.type === 'string' ? item.type : 'Tool call';
}

function tryParseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Wire the barrel export**

In `packages/executors/src/index.ts`, add:

```typescript
export * from './codex-stream-events.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/codex-stream-events.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/executors/src/codex-stream-events.ts packages/executors/src/codex-stream-events.test.ts packages/executors/src/index.ts
git commit -m "feat(executors): map Codex --json lines to AgentStreamEvent"
```

---

### Task 5: Tap `BaseCliExecutor`'s subprocess stdout live

**Files:**
- Modify: `packages/executors/src/base-cli-executor.ts`
- Modify: `packages/executors/src/base-cli-executor.test.ts` — add new tests
- Modify: `packages/executors/src/claude-executor.ts` — override the new hook
- Modify: `packages/executors/src/codex-executor.ts` — override the new hook
- Modify: `packages/domain/src/ports.ts` — extend `AgentExecutor.execute()` signature

**Interfaces:**
- Consumes: `ExecutorStreamEvent` (Task 1), `createClaudeStreamMapper` (Task 3), `createCodexStreamMapper` (Task 4).
- Produces: `AgentExecutor.execute(request, signal?, onEvent?: (event: ExecutorStreamEvent) => void): Promise<AgentExecutionResult>` — the new optional third parameter every executor and its callers must now accept (older call sites that omit it are unaffected, since it's optional).

- [ ] **Step 1: Extend the domain port signature**

In `packages/domain/src/ports.ts`, change:

```typescript
export interface AgentExecutor {
  readonly provider: string;
  execute(request: AgentExecutionRequest, signal?: AbortSignal): Promise<AgentExecutionResult>;
  health(): Promise<ExecutorHealth>;
}
```

to:

```typescript
export interface AgentExecutor {
  readonly provider: string;
  execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult>;
  health(): Promise<ExecutorHealth>;
}
```

Add `ExecutorStreamEvent` to the existing `import type { ... } from '@agent-foundry/contracts';` block at the top of the file.

- [ ] **Step 2: Write the failing test**

```typescript
// Add to packages/executors/src/base-cli-executor.test.ts, inside a new describe block
describe('BaseCliExecutor stream tap', () => {
  it('invokes onEvent with events produced by the subclass stream mapper as stdout arrives', async () => {
    const { PassThrough } = await import('node:stream');
    const stdout = new PassThrough();

    class StreamingExecutor extends BaseCliExecutor {
      readonly provider = 'claude' as const;
      protected readonly command = 'fixture-cli';

      protected async invocation(): Promise<CliInvocation> {
        return { command: this.command, args: [] };
      }

      protected override async responseText(): Promise<string> {
        return JSON.stringify({ type: 'result', output: completedArtifact });
      }

      protected override createStreamMapper() {
        return (line: string) => (line.includes('hello') ? [{ type: 'status' as const, phase: 'hello' }] : []);
      }
    }

    const resultPromise = new Promise<{ exitCode: number; stdout: string }>((resolve) => {
      execaMock.mockImplementationOnce(() => {
        const promise = Promise.resolve().then(() => {
          stdout.write('{"line":"hello"}\n');
          stdout.write('{"line":"world"}\n');
          stdout.end();
          return { exitCode: 0, stdout: '', stderr: '' };
        });
        Object.assign(promise, { stdout, stderr: null, pid: 1, kill: () => true });
        resolve(promise as unknown as { exitCode: number; stdout: string });
        return promise;
      });
    });
    void resultPromise;

    const events: unknown[] = [];
    const executor = new StreamingExecutor(1_000_000);
    await executor.execute(request, undefined, (event) => events.push(event));

    expect(events).toEqual([{ type: 'status', phase: 'hello' }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/base-cli-executor.test.ts -t "stream tap"`
Expected: FAIL — `createStreamMapper` does not exist on `BaseCliExecutor` / TS error

- [ ] **Step 4: Write minimal implementation**

In `packages/executors/src/base-cli-executor.ts`, update the `CliSubprocess` interface to describe a readable stdout:

```typescript
interface CliSubprocess extends PromiseLike<CliResult> {
  pid?: number;
  kill?(signal?: NodeJS.Signals): boolean;
  stdout?: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): void;
    destroy(): void;
  } | null;
  stderr?: { destroy(): void } | null;
}
```

Add the import at the top:

```typescript
import type { ExecutorStreamEvent } from '@agent-foundry/contracts';
```

Add a protected overridable hook right after the `invocation()` abstract method:

```typescript
  /**
   * Providers with an incremental JSONL stdout format (Claude, Codex) override
   * this to return a per-invocation, stateful line mapper. Providers without
   * one (mock, agy) leave it undefined — onEvent is then simply never called,
   * and callers must already treat onEvent as optional.
   */
  protected createStreamMapper(): ((line: string) => ExecutorStreamEvent[]) | undefined {
    return undefined;
  }
```

Change the public `execute()` signature and pass `onEvent` through to `executeInvocation`:

```typescript
  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    if (signal?.aborted) throw new RunCancelledError(request.runId);
    const startedAt = Date.now();
    const invocation = await this.invocation(request);
    try {
      return await this.executeInvocation(request, invocation, startedAt, signal, onEvent);
    } finally {
      // ... unchanged cleanup below
```

Change `executeInvocation`'s signature and attach the tap right after the subprocess is created (before the `if (signal) { ... }` block):

```typescript
  private async executeInvocation(
    request: AgentExecutionRequest,
    invocation: CliInvocation,
    startedAt: number,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    let result: CliResult;
    let onAbort: (() => void) | undefined;

    try {
      const subprocess = execa(invocation.command, invocation.args, {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        maxBuffer: this.maxOutputBytes,
        reject: false,
        all: false,
        windowsHide: true,
        encoding: 'utf8',
        detached: process.platform !== 'win32',
        ...(invocation.input !== undefined ? { input: invocation.input } : {}),
        ...(invocation.environment ? { env: cleanEnvironment(invocation.environment) } : {}),
      }) as unknown as CliSubprocess;
      if (onEvent) attachStreamTap(subprocess, this.createStreamMapper(), onEvent);
      if (signal) {
        onAbort = () => {
          void terminateProcessTree(subprocess, this.killGraceMs);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      result = await waitForCliResult(subprocess, request.timeoutMs + HARD_TIMEOUT_GRACE_MS);
    } catch (error) {
      // ... unchanged
```

Add the helper function near `waitForCliResult`:

```typescript
function attachStreamTap(
  subprocess: CliSubprocess,
  mapLine: ((line: string) => ExecutorStreamEvent[]) | undefined,
  onEvent: (event: ExecutorStreamEvent) => void,
): void {
  if (!mapLine || !subprocess.stdout) return;
  let buffer = '';
  subprocess.stdout.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) for (const event of mapLine(line)) onEvent(event);
      newlineIndex = buffer.indexOf('\n');
    }
  });
}
```

- [ ] **Step 5: Override the hook in the two streaming providers**

In `packages/executors/src/claude-executor.ts`, add the import and override:

```typescript
import { createClaudeStreamMapper } from './claude-stream-events.js';
```

```typescript
  protected override createStreamMapper() {
    return createClaudeStreamMapper();
  }
```
(add this method inside `ClaudeCliExecutor`, after `invocation()`)

In `packages/executors/src/codex-executor.ts`, add the import and override:

```typescript
import { createCodexStreamMapper } from './codex-stream-events.js';
```

```typescript
  protected override createStreamMapper() {
    return createCodexStreamMapper();
  }
```
(add this method inside `CodexCliExecutor`, after `invocation()`)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/base-cli-executor.test.ts`
Expected: PASS (all existing tests plus the new "stream tap" test)

- [ ] **Step 7: Run the full executors suite and typecheck**

Run: `npx vitest run packages/executors && npm run typecheck --workspace @agent-foundry/executors && npm run typecheck --workspace @agent-foundry/domain`
Expected: all PASS, no type errors

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/ports.ts packages/executors/src/base-cli-executor.ts packages/executors/src/base-cli-executor.test.ts packages/executors/src/claude-executor.ts packages/executors/src/codex-executor.ts
git commit -m "feat(executors): stream live AgentStreamEvents from CLI stdout"
```

---

### Task 6: Thread `onEvent` through `ExecutionPlane`

**Files:**
- Modify: `packages/domain/src/ports.ts` — extend `ExecutionPlane.submit()` signature
- Modify: `packages/executors/src/local-execution-plane.ts`
- Modify: `packages/executors/src/local-execution-plane.test.ts` — add a new test

**Interfaces:**
- Consumes: `ExecutorStreamEvent` (Task 1).
- Produces: `ExecutionPlane.submit(request, signal?, onEvent?: (event: ExecutorStreamEvent) => void): Promise<ExecutionResult>`.

- [ ] **Step 1: Extend the domain port signature**

In `packages/domain/src/ports.ts`, change:

```typescript
export interface ExecutionPlane {
  submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<ExecutionStatus>;
}
```

to:

```typescript
export interface ExecutionPlane {
  submit(
    request: ExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<ExecutionStatus>;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// Add to packages/executors/src/local-execution-plane.test.ts
it('threads onEvent through to the executor', async () => {
  const events: unknown[] = [];
  const executor = {
    provider: 'mock',
    execute: async (
      _req: unknown,
      _signal: AbortSignal | undefined,
      onEvent?: (event: { type: string }) => void,
    ) => {
      onEvent?.({ type: 'status', phase: 'started' });
      return { runId: 'run-1', stepRunId: 'step-1', attemptId: 'attempt-1', provider: 'mock' as const, model: 'm', exitCode: 0, durationMs: 1, stdout: '', stderr: '', output: completedArtifact };
    },
    health: async () => ({ provider: 'mock', available: true, message: 'ok' }),
  };
  const plane = new LocalExecutionPlane(
    { get: () => executor, health: async () => [] },
    { workspacePath: () => '/tmp/scrubbed-workspace' },
  );

  await plane.submit(executionRequest, undefined, (event) => events.push(event));

  expect(events).toEqual([{ type: 'status', phase: 'started' }]);
});
```

Check the top of `local-execution-plane.test.ts` for the existing `completedArtifact` and `executionRequest` fixtures already defined there — reuse them rather than redefining. If no `executionRequest` fixture exists yet, read the file's existing tests for the exact `ExecutionRequest` shape already used by the "submits and returns a completed result" test and reuse that object.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/local-execution-plane.test.ts -t "threads onEvent"`
Expected: FAIL — TS error, `submit` doesn't accept a third argument yet in the type but test still compiles against the interface; actual runtime failure is `events` staying empty since `LocalExecutionPlane.submit` doesn't forward it

- [ ] **Step 4: Write minimal implementation**

In `packages/executors/src/local-execution-plane.ts`, change:

```typescript
  async submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const executor = this.executors.get(request.agent.provider);
    const cwd = this.workspaces.workspacePath(request.workspace.projectId);
    try {
      const result = await executor.execute({ ...request.agent, cwd }, signal);
```

to:

```typescript
  async submit(
    request: ExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<ExecutionResult> {
    const executor = this.executors.get(request.agent.provider);
    const cwd = this.workspaces.workspacePath(request.workspace.projectId);
    try {
      const result = await executor.execute({ ...request.agent, cwd }, signal, onEvent);
```

Add `ExecutorStreamEvent` to the existing `import { ... } from '@agent-foundry/contracts';` block at the top of the file.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/local-execution-plane.test.ts`
Expected: PASS (all existing tests plus the new one)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/domain && npm run typecheck --workspace @agent-foundry/executors`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/ports.ts packages/executors/src/local-execution-plane.ts packages/executors/src/local-execution-plane.test.ts
git commit -m "feat(executors): thread onEvent through LocalExecutionPlane.submit"
```

---

### Task 7: Wire `StepEventRepository` into `WorkflowOrchestrator`

**Files:**
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.test.ts`
- Modify: `packages/orchestrator/src/cancellation.test.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts`
- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**
- Consumes: `StepEventRepository` (Task 2), `ExecutorStreamEvent`/`AgentStreamEventInput` (Task 1).
- Produces: `WorkflowOrchestrator`'s constructor gains a `stepEvents: StepEventRepository` parameter (inserted immediately after the existing `events: EventStore` parameter, in every construction site). Live `ExecutorStreamEvent`s from a running attempt and `approval` events at the approval-gate creation site are now persisted via `stepEvents.append(...)`.

- [ ] **Step 1: Add an in-memory `StepEventRepository` test double to the shared harness**

In `packages/orchestrator/src/testing/harness.ts`, find the existing `InMemoryEvents` class (used for the `events: InMemoryEvents` field on `stores`, referenced at line ~858/876 in the file). Immediately after that class, add:

```typescript
class InMemoryStepEvents implements StepEventRepository {
  readonly events: AgentStreamEvent[] = [];
  private sequenceByRun = new Map<string, number>();

  async append(event: AgentStreamEventInput): Promise<AgentStreamEvent> {
    const nextSequence = (this.sequenceByRun.get(event.runId) ?? 0) + 1;
    this.sequenceByRun.set(event.runId, nextSequence);
    const parsed = { ...event, sequence: nextSequence } as AgentStreamEvent;
    this.events.push(parsed);
    return parsed;
  }

  async list(runId: string, options: { cursor?: number; limit?: number } = {}): Promise<AgentStreamEvent[]> {
    const cursor = options.cursor ?? 0;
    const matches = this.events.filter((event) => event.runId === runId && event.sequence > cursor);
    return options.limit === undefined ? matches : matches.slice(0, options.limit);
  }
}
```

Add `stepEvents: new InMemoryStepEvents(),` to the object literal returned by the `stores` factory function (same object that currently has `events: new InMemoryEvents(power),` at line ~876).

Add `AgentStreamEvent` and `AgentStreamEventInput` to the existing `@agent-foundry/contracts` import, and `StepEventRepository` to the existing `@agent-foundry/domain` import, at the top of `harness.ts`.

Then update the harness's own `new WorkflowOrchestrator(...)` call (around line 1040-1060) to pass `stores.stepEvents` as the new argument immediately after `stores.events`:

```typescript
  const orchestrator = new WorkflowOrchestrator(
    stores.projects,
    stores.runs,
    stores.stepRuns,
    stores.stepAttempts,
    stores.approvalRequests,
    stores.approvalDecisions,
    stores.artifacts,
    stores.events,
    stores.stepEvents,
    workflows,
```
(rest of the argument list unchanged)

- [ ] **Step 2: Update the two direct-construction test files**

In `packages/orchestrator/src/workflow-orchestrator.test.ts`, find the local `const orchestrator = new WorkflowOrchestrator(...)` call (line ~125) and insert a new in-memory step-events double right after `events`. Since this file already constructs its own `events` (an `InMemoryEvents`-style local variable, not from the shared harness), add right before the orchestrator construction:

```typescript
const stepEvents: StepEventRepository = {
  events: [] as AgentStreamEvent[],
  async append(event) {
    const sequence = this.events.filter((existing) => existing.runId === event.runId).length + 1;
    const parsed = { ...event, sequence } as AgentStreamEvent;
    this.events.push(parsed);
    return parsed;
  },
  async list(runId, options = {}) {
    const cursor = options.cursor ?? 0;
    return this.events.filter((event) => event.runId === runId && event.sequence > cursor);
  },
} as unknown as StepEventRepository;
```

Then insert `stepEvents,` right after `events,` in the constructor call. Add `AgentStreamEvent`, `StepEventRepository` to the file's existing imports (`@agent-foundry/contracts`, `@agent-foundry/domain` respectively).

Do the identical change in `packages/orchestrator/src/cancellation.test.ts` at its `new WorkflowOrchestrator(...)` call (line ~581).

- [ ] **Step 3: Add the constructor parameter and wiring in `workflow-orchestrator.ts`**

Find the `WorkflowOrchestrator` class constructor (it takes `projects, runs, stepRuns, stepAttempts, approvalRequests, approvalDecisions, artifacts, events, workflows, ...` as positional params — the `private readonly executionPlane: ExecutionPlane,` param is at line 117). Add a new parameter `private readonly stepEvents: StepEventRepository,` immediately after the existing `private readonly events: EventStore,` parameter (keep it adjacent to `events` since both are event-log dependencies).

Add `StepEventRepository` to the existing `import type { ... } from '@agent-foundry/domain';` block, and `AgentStreamEventInput`, `ExecutorStreamEvent` to the existing `@agent-foundry/contracts` import block, at the top of the file.

- [ ] **Step 4: Persist live executor events during `executeCandidate`**

Find `executeCandidate` (contains the `await this.executionPlane.submit(...)` call, using `runId`, `stepRunId`, `attemptId` already in scope). Change the `submit` call from:

```typescript
    const executionResult = await this.executionPlane.submit(
      {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: attemptId,
        agent: { /* ...unchanged... */ },
        workspace: { projectId: project.id, ref: workspaceRef },
        tools: [],
        limits: { timeoutMs: this.options.agentTimeoutMs },
        networkPolicy: { mode: 'none', allowedHosts: [] },
        secrets: [],
      },
      signal,
    );
```

to:

```typescript
    const executionResult = await this.executionPlane.submit(
      {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: attemptId,
        agent: { /* ...unchanged... */ },
        workspace: { projectId: project.id, ref: workspaceRef },
        tools: [],
        limits: { timeoutMs: this.options.agentTimeoutMs },
        networkPolicy: { mode: 'none', allowedHosts: [] },
        secrets: [],
      },
      signal,
      (event) => this.persistStreamEvent(runId, stepRunId, attemptId, event),
    );
```

Add a new private method near `emit()` (end of the class, before the closing brace):

```typescript
  private persistStreamEvent(
    runId: string,
    stepRunId: string,
    attemptId: string,
    event: ExecutorStreamEvent,
  ): void {
    const input: AgentStreamEventInput = {
      id: this.ids.next(),
      runId,
      stepRunId,
      attemptId,
      createdAt: this.clock.now().toISOString(),
      ...event,
    };
    // ponytail: best-effort append — a dropped live stream event never fails
    // the run itself; the final Message/Operation is still persisted normally.
    this.stepEvents.append(input).catch(() => undefined);
  }
```

- [ ] **Step 5: Persist an `approval` event at the approval-gate creation site**

Find the block that calls `await this.approvalRequests.create({ id: this.ids.next(), runId, stepRunId: stepRun.id, ... })` (inside the approval-gate node handling, right before `throw new ApprovalRequiredError(runId, node.id);`). Capture the generated id in a variable and append a matching stream event right after:

```typescript
      const approvalRequestId = this.ids.next();
      await this.approvalRequests.create({
        id: approvalRequestId,
        runId,
        stepRunId: stepRun.id,
        nodeId: node.id,
        artifact: artifactReference(reviewed),
        allowedActions: node.actions,
        ...timeout,
        createdAt: requestTimestamp.toISOString(),
      });
      await this.stepEvents
        .append({
          id: this.ids.next(),
          runId,
          stepRunId: stepRun.id,
          createdAt: this.clock.now().toISOString(),
          type: 'approval',
          approvalRequestId,
        })
        .catch(() => undefined);
      throw new ApprovalRequiredError(runId, node.id);
```

(`attemptId` is correctly omitted here — an approval-gate `stepRun` has no execution attempt, matching the schema's optional `attemptId`.)

- [ ] **Step 6: Update `packages/composition/src/runtime.ts`**

Add the import: in the existing `import { ... } from '@agent-foundry/persistence';` block, add `FileStepEventRepository,` (alphabetically near `FileStepAttemptRepository`/`FileStepRunRepository`).

Add the instantiation right after `const events = new FileEventStore(config.dataDir);` (line 108):

```typescript
  const stepEvents = new FileStepEventRepository(config.dataDir);
```

Add `stepEvents` to the `WorkflowOrchestrator` construction call, immediately after `events,`:

```typescript
  const orchestrator = new WorkflowOrchestrator(
    projects,
    runs,
    stepRuns,
    stepAttempts,
    approvalRequests,
    approvalDecisions,
    artifacts,
    events,
    stepEvents,
    workflows,
    // ...rest unchanged
```

Add `stepEvents: FileStepEventRepository;` to the `Runtime` interface (next to the existing `events: FileEventStore;` field), and add `stepEvents,` to the returned `Runtime` object literal at the end of `createRuntime` (wherever `events,` already appears in that returned object).

- [ ] **Step 7: Run the orchestrator and composition test suites**

Run: `npx vitest run packages/orchestrator packages/composition`
Expected: all PASS (existing behavior unchanged; no test asserts on `stepEvents` content yet — that's covered by Task 8's API test and Task 10's required reconnect test)

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/orchestrator && npm run typecheck --workspace @agent-foundry/composition`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/workflow-orchestrator.test.ts packages/orchestrator/src/cancellation.test.ts packages/orchestrator/src/testing/harness.ts packages/composition/src/runtime.ts
git commit -m "feat(orchestrator): persist live AgentStreamEvents and approval-gate events"
```

---

### Task 8: `GET /runs/:runId/events/stream` API endpoint

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/events-stream.test.ts`

**Interfaces:**
- Consumes: `runtime.stepEvents.list(runId, { cursor, limit })` (Task 7).
- Produces: `GET /runs/:runId/events/stream` — SSE endpoint, cursor via `?cursor=` or `Last-Event-ID` (numeric `sequence`, matching the existing `/projects/:projectId/conversation/stream` endpoint's cursor convention, not the string-id convention of `/projects/:projectId/events/stream`, since `AgentStreamEvent.sequence` is a number).

- [ ] **Step 1: Write the failing test**

Read the existing `events-stream.test.ts` file first for its exact test-setup pattern (how it boots the app, what fixtures/helpers like a raw-SSE-response reader it already defines) and follow that same pattern. Add:

```typescript
// Add to apps/api/src/events-stream.test.ts, following the existing SSE test helper pattern in this file
it('streams run events and recovers missed events by cursor on reconnect', async () => {
  const app = await buildTestApp(); // use whatever the existing tests in this file call to construct `app`/`runtime`
  const project = await createTestProject(app); // reuse this file's existing project-creation helper
  const runId = 'run-stream-test';
  await app.runtime.stepEvents.append({
    id: 'evt-1',
    runId,
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
    createdAt: new Date().toISOString(),
    type: 'status',
    phase: 'started',
  });

  const first = await readSseFrames(app, `/runs/${runId}/events/stream`); // reuse this file's existing SSE-reading helper
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ type: 'status', phase: 'started', sequence: 1 });

  await app.runtime.stepEvents.append({
    id: 'evt-2',
    runId,
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
    createdAt: new Date().toISOString(),
    type: 'assistant_delta',
    text: 'Hello',
  });

  const afterCursor = await readSseFrames(app, `/runs/${runId}/events/stream?cursor=1`);
  expect(afterCursor).toHaveLength(1);
  expect(afterCursor[0]).toMatchObject({ type: 'assistant_delta', text: 'Hello', sequence: 2 });
});
```

(Adapt the exact helper names — `buildTestApp`, `createTestProject`, `readSseFrames` — to whatever this file's existing tests already call; do not invent new helpers if equivalent ones exist.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/events-stream.test.ts -t "run events"`
Expected: FAIL — 404, route does not exist yet

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/app.ts`, immediately after the existing `app.get('/projects/:projectId/events/stream', ...)` handler (ends around line 348), add:

```typescript
  app.get('/runs/:runId/events/stream', async (request, reply) => {
    const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
    const { cursor } = z
      .object({ cursor: CanonicalDecimalSchema.pipe(z.number().int().nonnegative()).optional() })
      .parse(request.query);
    const header = request.headers['last-event-id'];
    const lastSequence =
      cursor ??
      (typeof header === 'string' && header
        ? CanonicalDecimalSchema.pipe(z.number().int().nonnegative()).parse(header)
        : 0);
    await streamSse(
      request,
      reply,
      allowedOrigins,
      lastSequence,
      (after) => runtime.stepEvents.list(runId, { cursor: after ?? 0, limit: 500 }),
      (event) => event.sequence,
    );
  });
```

(This mirrors the existing `/projects/:projectId/conversation/stream` handler exactly, which already uses `CanonicalDecimalSchema` — confirm that identifier is already imported/defined in this file, since the conversation-stream handler uses it; no new import needed if so.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/events-stream.test.ts`
Expected: PASS (all existing tests plus the new one)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/api`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/events-stream.test.ts
git commit -m "feat(api): add GET /runs/:runId/events/stream"
```

---

### Task 9: Required test — disconnect/reconnect mid-tool-call

**Files:**
- Modify: `apps/api/src/events-stream.test.ts`

**Interfaces:**
- Consumes: the endpoint from Task 8.

This is the issue's explicitly required test ("Desconectar/reconectar durante tool call e fallback"), written as its own scenario distinct from Task 8's basic cursor test so it survives independently in the test report.

- [ ] **Step 1: Write the test**

```typescript
// Add to apps/api/src/events-stream.test.ts
it('recovers a tool_end missed while disconnected mid-tool-call, with no duplicate tool_start', async () => {
  const app = await buildTestApp();
  const runId = 'run-reconnect-test';
  const stepRunId = 'step-1';
  const attemptId = 'attempt-1';

  await app.runtime.stepEvents.append({
    id: 'evt-start',
    runId,
    stepRunId,
    attemptId,
    createdAt: new Date().toISOString(),
    type: 'tool_start',
    toolName: 'Read',
    summary: 'Read: src/app.ts',
  });

  // Client connects and observes the tool_start, then "disconnects" (this is
  // exactly what the first readSseFrames call already simulates: open,
  // collect available frames, close).
  const beforeDisconnect = await readSseFrames(app, `/runs/${runId}/events/stream`);
  expect(beforeDisconnect).toHaveLength(1);
  expect(beforeDisconnect[0]).toMatchObject({ type: 'tool_start', sequence: 1 });
  const lastSeenSequence = beforeDisconnect[0]!.sequence as number;

  // While disconnected, the tool finishes.
  await app.runtime.stepEvents.append({
    id: 'evt-end',
    runId,
    stepRunId,
    attemptId,
    createdAt: new Date().toISOString(),
    type: 'tool_end',
    toolName: 'Read',
    summary: 'Read completed',
    ok: true,
  });

  // Reconnect using the last-seen cursor.
  const afterReconnect = await readSseFrames(
    app,
    `/runs/${runId}/events/stream?cursor=${lastSeenSequence}`,
  );

  expect(afterReconnect).toHaveLength(1);
  expect(afterReconnect[0]).toMatchObject({ type: 'tool_end', ok: true, sequence: 2 });
  expect(afterReconnect.some((event: { type: string }) => event.type === 'tool_start')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/events-stream.test.ts -t "recovers a tool_end"`
Expected: FAIL if Task 8's endpoint isn't present yet in the working tree; PASS immediately if Task 8 is already committed (in which case this step confirms it was already correct — re-run after temporarily reverting the Task 8 route to confirm the test is meaningful, then restore it)

- [ ] **Step 3: Confirm it passes against the real implementation**

Run: `npx vitest run apps/api/src/events-stream.test.ts`
Expected: PASS (all tests including this one)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/events-stream.test.ts
git commit -m "test(api): cover disconnect/reconnect mid-tool-call for issue #39"
```

---

### Task 10: Web — `api.ts` additions and merge helper

**Files:**
- Modify: `apps/web/lib/api.ts`
- Create: `apps/web/lib/agent-stream.ts`
- Create: `apps/web/lib/agent-stream.test.ts`

**Interfaces:**
- Produces: `runEventsStreamUrl(runId: string): string`, `cancelRun(runId: string): Promise<Run>` (mirrors existing `pauseRun`) in `api.ts`; `mergeStreamEvents(current: AgentStreamEvent[], incoming: AgentStreamEvent[]): AgentStreamEvent[]` in `agent-stream.ts` (same contract as the existing `mergeEvents` in `events.ts`, keyed on `sequence` instead of `id`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/agent-stream.test.ts
import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '@agent-foundry/contracts';
import { mergeStreamEvents } from './agent-stream.js';

function statusEvent(sequence: number): AgentStreamEvent {
  return {
    id: `evt-${sequence}`,
    runId: 'run-1',
    stepRunId: 'step-1',
    sequence,
    createdAt: '2026-07-18T00:00:00.000Z',
    type: 'status',
    phase: 'started',
  };
}

describe('mergeStreamEvents', () => {
  it('appends new events in sequence order on the fast path', () => {
    const current = [statusEvent(1)];
    const merged = mergeStreamEvents(current, [statusEvent(2)]);
    expect(merged.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('is reference-stable when nothing new arrives', () => {
    const current = [statusEvent(1)];
    expect(mergeStreamEvents(current, [statusEvent(1)])).toBe(current);
  });

  it('deduplicates and re-sorts out-of-order frames', () => {
    const current = [statusEvent(1), statusEvent(3)];
    const merged = mergeStreamEvents(current, [statusEvent(2)]);
    expect(merged.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/lib/agent-stream.test.ts`
Expected: FAIL — `Cannot find module './agent-stream.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/lib/agent-stream.ts
import type { AgentStreamEvent } from '@agent-foundry/contracts';

/** Same contract as mergeEvents in ./events.ts, keyed on `sequence` instead of `id`. */
export function mergeStreamEvents(
  current: AgentStreamEvent[],
  incoming: AgentStreamEvent[],
): AgentStreamEvent[] {
  if (incoming.length === 0) return current;
  const lastSequence = current.length > 0 ? current[current.length - 1]!.sequence : undefined;
  if (lastSequence !== undefined && incoming.every((event) => event.sequence > lastSequence)) {
    return [...current, ...incoming];
  }
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  let changed = false;
  for (const event of incoming) {
    if (bySequence.has(event.sequence)) continue;
    bySequence.set(event.sequence, event);
    changed = true;
  }
  if (!changed) return current;
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}
```

- [ ] **Step 4: Add `api.ts` helpers**

In `apps/web/lib/api.ts`, add `AgentStreamEvent` to the existing `@agent-foundry/contracts` type import, then add right after the existing `eventStreamUrl` function (line ~71):

```typescript
export function runEventsStreamUrl(runId: string): string {
  return `${API_URL}/runs/${encodeURIComponent(runId)}/events/stream`;
}
```

Find the existing `pauseRun` function (used by the "Pausar" button in `page.tsx`, at `apps/web/lib/api.ts:96-101`) and add a `cancelRun` function right after it, matching its exact shape — same `WorkflowRun` return type and `{ run }` response wrapper, just a different path (the `POST /runs/:runId/cancel` handler in `apps/api/src/app.ts:350-354` already returns `{ run }`, same shape as the pause route):

```typescript
export async function cancelRun(runId: string): Promise<WorkflowRun> {
  const response = await api<{ run: WorkflowRun }>(`/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
  return response.run;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/web/lib/agent-stream.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Typecheck the web app**

Run: `npm run typecheck --workspace @agent-foundry/web`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/api.ts apps/web/lib/agent-stream.ts apps/web/lib/agent-stream.test.ts
git commit -m "feat(web): add run-events stream client helpers"
```

---

### Task 11: Web — surface live run activity in the Conversa panel

**Files:**
- Modify: `apps/web/app/project/[id]/page.tsx`

**Interfaces:**
- Consumes: `runEventsStreamUrl`, `cancelRun` (Task 10), `mergeStreamEvents` (Task 10), `AgentStreamEvent` (Task 1).

This task is JSX wiring only — this repo has no component-test harness (`apps/web` tests are all pure-function `lib/*.ts` unit tests; verify this task by running the dev server and driving it in a browser, per this project's UI-change convention, not by writing a new component-test framework).

- [ ] **Step 1: Add state and the per-run SSE subscription**

Near the existing `const [events, setEvents] = useState<ProjectEvent[]>([...])`-style state declarations (search for where `events`/`live` state is declared, just above the `EventSource` `useEffect` at line ~277), add:

```typescript
const [streamEvents, setStreamEvents] = useState<AgentStreamEvent[]>([]);
```

Add `AgentStreamEvent` to the existing `@agent-foundry/contracts` type import block, and `mergeStreamEvents`, `runEventsStreamUrl`, `cancelRun` to the existing `../../../lib/agent-stream.js`/`../../../lib/api` imports (add a new import line for `mergeStreamEvents` from `'../../../lib/agent-stream'`, and add `runEventsStreamUrl`, `cancelRun` to the existing `from '../../../lib/api'` import list).

Find the active run id: the panel already computes `run` (from `runDetail`/`detail`) — reuse whatever variable already holds the current non-terminal run's id (check how the existing "Pausar" button's `run?.status === 'running'` condition accesses it; reuse that same `run` reference). Add a new `useEffect`, placed right after the existing project-events `EventSource` effect (~line 291):

```typescript
useEffect(() => {
  if (!run || run.status !== 'running') return;
  const source = new EventSource(runEventsStreamUrl(run.id));
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as AgentStreamEvent;
      setStreamEvents((current) => mergeStreamEvents(current, [event]));
    } catch {
      // Malformed frame; drop it silently.
    }
  };
  return () => source.close();
}, [run?.id, run?.status]);
```

- [ ] **Step 2: Render live activity under the active message in the Conversa panel**

In the `<ul className="conversationList">` block (line ~690-727), after the existing `{operation ? (...) : null}` badge block and before the closing `</li>`, add:

```typescript
{operation && operation.runId && run?.id === operation.runId ? (
  <div className="agentStreamActivity">
    {streamEvents
      .filter((event) => event.runId === operation.runId)
      .map((event) => {
        if (event.type === 'assistant_delta') {
          return <p key={event.id}>{event.text}</p>;
        }
        if (event.type === 'tool_start' || event.type === 'tool_end') {
          return (
            <details key={event.id}>
              <summary>{event.summary}</summary>
              {event.type === 'tool_end' && event.detail ? <pre>{event.detail}</pre> : null}
            </details>
          );
        }
        if (event.type === 'status') {
          return <small key={event.id}>{event.phase}…</small>;
        }
        if (event.type === 'error') {
          return (
            <p key={event.id} className="errorBox">
              {event.message}
            </p>
          );
        }
        if (event.type === 'approval') {
          const entry = approvals.find((candidate) => candidate.request.id === event.approvalRequestId);
          if (!entry || entry.decision) return null;
          const node = nodeForRequest(entry.request);
          if (!node) return null;
          return (
            <div key={event.id} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {node.actions.map((action) => (
                <button
                  key={action}
                  className="secondaryButton"
                  onClick={() => void openDecide(entry.request, node, action)}
                >
                  {action}
                </button>
              ))}
            </div>
          );
        }
        return null;
      })}
    <button className="secondaryButton" onClick={() => void cancel(operation.runId!)}>
      Cancelar
    </button>
  </div>
) : null}
```

- [ ] **Step 3: Add the `cancel` handler**

Near the existing `pause`/`resume`/`retry` handler functions (search for `const pause = () => ...` or similar — these back the header's Pausar/Retomar buttons), add a matching handler:

```typescript
const cancel = async (runId: string) => {
  try {
    await cancelRun(runId);
    setRefreshTick((tick) => tick + 1);
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause));
  }
};
```

(Match the exact pattern of the neighboring `pause`/`resume` functions in this file — same `setRefreshTick`/`setError` calls — rather than inventing a different error-handling shape.)

- [ ] **Step 4: Add completed-Operation links**

In the same conversation-list block, after the live-activity block from Step 2, add a link block for a terminal, approved/non-pending operation:

```typescript
{operation && operation.approval && operation.approval.status !== 'pending' && operation.projectVersionId ? (
  <div className="operationLinks">
    <a href={`/project/${detail.project.id}/versions`}>Ver diff</a>
    {operation.artifactReferences.map((ref) => (
      <button
        key={`${ref.name}-${ref.revision}`}
        className="secondaryButton"
        onClick={() =>
          void getArtifact(detail.project.id, ref.name, ref.revision)
            .then(openArtifact)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        }
      >
        {ref.name}
      </button>
    ))}
  </div>
) : null}
```

(This reuses `getArtifact`/`openArtifact`, already imported/defined in this file for the "Aprovações" panel's "Ver artefato" button. The `/project/:id/versions` link reuses the existing versions page rather than building new inline diff rendering — check `apps/web/app/project/[id]/versions/page.tsx` for its exact route path before wiring this link.)

- [ ] **Step 5: Manually verify in the browser**

Run: `npm run dev:inline` from the repo root (per this project's convention for exercising a real run end-to-end).

Drive one full plan-or-build operation from the UI and confirm:
- Live assistant text appears under the message while the run is active.
- A tool call renders as a collapsed `<summary>` chip; clicking it expands `detail` when present.
- The "Cancelar" button appears next to an active operation and calling it actually cancels the run (status flips to `cancelled`).
- Once the operation completes and is approved, the diff/artifact links render and are clickable.

Capture a screenshot or short recording of this flow — it is required evidence for the PR (see plan's final task).

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/project/[id]/page.tsx
git commit -m "feat(web): surface live run activity, cancel, and completed-operation links in chat"
```

---

### Task 12: Full verification and evidence capture

**Files:** none (verification only)

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: `format:check`, `lint`, `architecture:check`, `roadmap:check`, `typecheck`, `test`, and `build` all pass. Fix any failure before proceeding — do not skip or weaken a check.

- [ ] **Step 2: Run the full test suite with verbose output and save it as evidence**

Run: `npm test 2>&1 | tee /tmp/issue-39-test-output.txt`
Expected: all suites pass, including every test added in Tasks 1-10. Attach `/tmp/issue-39-test-output.txt` (or its relevant excerpt) to the PR description as the "observable result" required by `docs/DEFINITION_OF_DONE.md`.

- [ ] **Step 3: Manually re-verify the required disconnect/reconnect scenario end-to-end**

Run: `npx vitest run apps/api/src/events-stream.test.ts -t "recovers a tool_end"`
Expected: PASS. Include this output in the PR description as the explicit "required test" evidence called out in the issue.

- [ ] **Step 4: Confirm the screenshot/recording from Task 11 Step 5 is saved**

Confirm you have the screenshot or recording of the live chat timeline (assistant text, collapsed tool call, cancel button, completed-operation link) ready to attach to the PR.

- [ ] **Step 5: Update the roadmap spec status if the reconciler requires it**

Run: `npm run roadmap:check` (already covered by `npm run check` in Step 1, but re-run standalone if it flagged anything) — if `planning/roadmap-spec.json`'s `v06-chat-streaming` entry needs a status/evidence field updated per the reconciler's rules, update it following the same pattern the merged `v06-conversation-domain` entry uses.
