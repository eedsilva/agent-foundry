# SSE Event Stream + Replay + Timeline Implementation Plan (issue #10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream project events over SSE with cursor/Last-Event-ID replay, redact sensitive data before persist/transmit, and enrich the run timeline UI — keeping today's polling as fallback.

**Architecture:** Events already persist append-only per project in `DATA_DIR/projects/{id}/events.jsonl` with ULID ids (lexicographically time-ordered → natural cursor). Redaction is a pure domain function applied at the single choke point `FileEventStore.append` (all three producers route through it). The SSE endpoint tails the persisted store on a 1s poll (worker may run in a separate process, so an in-memory bus would miss events). The web page merges polled + streamed events into a Map keyed by event id, so replay can never duplicate.

**Tech Stack:** TypeScript, Fastify v5 (raw `reply.hijack()` streaming — no new deps), Zod, Next.js 16 App Router with native `EventSource`, vitest.

## Global Constraints

- No new npm dependencies. Native `EventSource` in the browser; raw Fastify streaming on the server.
- All existing routes and response shapes stay compatible (`docs/DEFINITION_OF_DONE.md`).
- Polling in `apps/web/app/project/[id]/page.tsx:34-60` must keep working unchanged as fallback.
- `npm run check` must pass at the end (format, lint, architecture, roadmap, typecheck, test, build).
- Commit style: `feat(scope): ...` / `test(scope): ...` as in recent history. UI copy in pt-BR like the rest of `apps/web`.
- vitest runs single-worker (`--maxWorkers=1`); tests use `mkdtemp` temp dirs and clean up in `afterEach`.

---

### Task 1: Redaction utility in domain

**Files:**

- Create: `packages/domain/src/redaction.ts`
- Modify: `packages/domain/src/index.ts` (add export)
- Test: `packages/domain/src/redaction.test.ts`

**Interfaces:**

- Produces: `redactEvent(event: ProjectEvent): ProjectEvent` and `redactString(value: string): string` — consumed by Task 2.

- [ ] **Step 1: Write the failing test** (`packages/domain/src/redaction.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import type { ProjectEvent } from '@agent-foundry/contracts';
import { redactEvent, redactString } from './redaction.js';

function event(overrides: Partial<ProjectEvent>): ProjectEvent {
  return {
    id: '01J0000000000000000000000',
    projectId: 'p1',
    type: 'project.failed',
    createdAt: '2026-07-14T00:00:00.000Z',
    message: 'ok',
    data: {},
    ...overrides,
  };
}

describe('redactString', () => {
  it('redacts bearer tokens, api keys, ghp tokens and JWTs inside text', () => {
    const input =
      'auth Bearer abcdef1234567890ABCDEF key sk-abc123def456ghi789jkl token ghp_abcdefghijklmnopqrst1234 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1234567';
    const output = redactString(input);
    expect(output).not.toContain('abcdef1234567890ABCDEF');
    expect(output).not.toContain('sk-abc123def456ghi789jkl');
    expect(output).not.toContain('ghp_abcdefghijklmnopqrst1234');
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(output).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactString('node.completed em 3s')).toBe('node.completed em 3s');
  });
});

describe('redactEvent', () => {
  it('redacts sensitive keys anywhere in data, recursively', () => {
    const redacted = redactEvent(
      event({
        data: {
          apiKey: 'super-secret',
          nested: { authorization: 'Bearer zzz', safe: 'keep' },
          list: [{ password: 'hunter2' }],
        },
      }),
    );
    expect(redacted.data).toEqual({
      apiKey: '[REDACTED]',
      nested: { authorization: '[REDACTED]', safe: 'keep' },
      list: [{ password: '[REDACTED]' }],
    });
  });

  it('redacts token-looking values inside message and string data values', () => {
    const redacted = redactEvent(
      event({
        message: 'CLI failed: Bearer abcdef1234567890ABCDEF rejected',
        data: { stderr: 'used key sk-abc123def456ghi789jkl' },
      }),
    );
    expect(redacted.message).toContain('[REDACTED]');
    expect(String((redacted.data as Record<string, unknown>).stderr)).toContain('[REDACTED]');
  });

  it('does not mangle non-sensitive keys like author or nodeId', () => {
    const redacted = redactEvent(event({ data: { author: 'ed', nodeId: 'plan-gate' } }));
    expect(redacted.data).toEqual({ author: 'ed', nodeId: 'plan-gate' });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run packages/domain/src/redaction.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement** `packages/domain/src/redaction.ts`:

```ts
import type { ProjectEvent } from '@agent-foundry/contracts';

const SENSITIVE_KEY =
  /(?:^|[-_.])(?:token|secret|password|passwd|credential|credentials|authorization|auth|apikey|api[-_]key|access[-_]key|private[-_]key|bearer|cookie|session)(?:$|[-_.])/i;

const VALUE_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export function redactString(value: string): string {
  return VALUE_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), value);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(entry, depth + 1),
      ]),
    );
  }
  return value;
}

export function redactEvent(event: ProjectEvent): ProjectEvent {
  return {
    ...event,
    message: redactString(event.message),
    data: redactValue(event.data, 0) as ProjectEvent['data'],
  };
}
```

- [ ] **Step 4: Run the test again** — expect PASS. Also export from `packages/domain/src/index.ts` (`export * from './redaction.js';` — match the existing export style in that file).

- [ ] **Step 5: Commit** — `feat(domain): add event redaction utility`

---

### Task 2: Cursor-aware EventStore + redaction on append

**Files:**

- Modify: `packages/domain/src/ports.ts:72-75` (EventStore interface)
- Modify: `packages/persistence/src/event-store.ts`
- Test: `packages/persistence/src/event-store.test.ts` (extend)

**Interfaces:**

- Consumes: `redactEvent` from Task 1.
- Produces: `EventStore.list(projectId: string, limit?: number, afterId?: string): Promise<ProjectEvent[]>` — consumed by the SSE route (Task 4). Semantics: without `afterId`, unchanged (tail `slice(-limit)`); with `afterId`, return events strictly after that id in append order, capped at `limit` from the start of the remainder.

- [ ] **Step 1: Write failing tests** (append to `packages/persistence/src/event-store.test.ts`, reusing its helpers):

```ts
it('lists events after a cursor id without duplication', async () => {
  // append 5 events e1..e5 with ascending ids via the existing helper pattern
  // const store = new FileEventStore(dir); ...
  const after = await store.list('p1', 500, e3.id);
  expect(after.map((e) => e.id)).toEqual([e4.id, e5.id]);
});

it('falls back to id-ordering when the cursor id is unknown (e.g. truncated file)', async () => {
  const after = await store.list('p1', 500, idBetween(e3.id, e4.id)); // any string > e3.id, < e4.id
  expect(after.map((e) => e.id)).toEqual([e4.id, e5.id]);
});

it('redacts sensitive data before persisting', async () => {
  await store.append(
    eventWith({ message: 'Bearer abcdef1234567890ABCDEF', data: { apiKey: 'x' } }),
  );
  const [persisted] = await store.list('p1');
  expect(persisted.message).toContain('[REDACTED]');
  expect(persisted.data.apiKey).toBe('[REDACTED]');
});
```

Use real ULIDs or fixed sortable ids (`'01A'`, `'01B'`, …) — ids only need to be strings that sort in append order for the fallback test.

- [ ] **Step 2: Run** `npx vitest run packages/persistence/src/event-store.test.ts` — expect FAIL.

- [ ] **Step 3: Implement.** In `packages/domain/src/ports.ts` change the interface:

```ts
export interface EventStore {
  append(event: ProjectEvent): Promise<void>;
  list(projectId: string, limit?: number, afterId?: string): Promise<ProjectEvent[]>;
}
```

In `packages/persistence/src/event-store.ts`:

```ts
async append(event: ProjectEvent): Promise<void> {
  const parsed = redactEvent(ProjectEventSchema.parse(event));
  // ... rest unchanged (dedupeKey path included)
}

async list(projectId: string, limit = 500, afterId?: string): Promise<ProjectEvent[]> {
  const events = (await readJsonLines<unknown>(this.pathFor(projectId))).map((event) =>
    ProjectEventSchema.parse(event),
  );
  if (afterId === undefined) return events.slice(-limit);
  const index = events.findIndex((event) => event.id === afterId);
  const after = index >= 0 ? events.slice(index + 1) : events.filter((event) => event.id > afterId);
  return after.slice(0, limit);
}
```

- [ ] **Step 4: Run** the persistence tests and `npm run typecheck` — expect PASS (interface change is backwards-compatible; no other implementation of EventStore exists in production code, but in-memory test doubles in `packages/orchestrator/src/run-controls.test.ts` / `cancellation.test.ts` may need their `list` signature widened — fix if typecheck complains).

- [ ] **Step 5: Commit** — `feat(persistence): cursor-aware event listing and redaction on append`

---

### Task 3: Extract `buildApp(runtime)` from the API bootstrap

**Files:**

- Create: `apps/api/src/app.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**

- Produces: `export function buildApp(runtime: Runtime): FastifyInstance` (async registration inside; import `Runtime` type from `@agent-foundry/composition`). Consumed by Task 4's tests and by `index.ts`.

- [ ] **Step 1: Move** everything from `Fastify({...})` creation through the last route registration (`apps/api/src/index.ts:28-156`) into `apps/api/src/app.ts` as:

```ts
export async function buildApp(runtime: Runtime): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1_000_000 });
  await app.register(cors, { ... });   // unchanged
  app.setErrorHandler(...);            // unchanged
  // ... all existing routes unchanged ...
  return app;
}
```

`index.ts` keeps: dotenv load, `createRuntime()`, security warning, `const app = await buildApp(runtime)`, inline worker/reaper start, shutdown handlers, `app.listen`. Pure move — zero behavior change.

- [ ] **Step 2: Verify** `npm run typecheck && npm run build:apps` passes and `npm run lint` is clean.

- [ ] **Step 3: Commit** — `refactor(api): extract buildApp for testability`

---

### Task 4: SSE endpoint with replay + reconnection/restart test

**Files:**

- Modify: `apps/api/src/app.ts` (new route)
- Test: `apps/api/src/events-stream.test.ts` (first HTTP-level test in the repo)

**Interfaces:**

- Consumes: `runtime.events.list(projectId, limit, afterId)` (Task 2), `runtime.projectService.get(projectId)` (throws `NotFoundError` → 404 via existing error handler).
- Produces: `GET /projects/:projectId/events/stream?cursor=<eventId>` — also honors `Last-Event-ID` header. Emits standard SSE frames `id: <event.id>\ndata: <JSON ProjectEvent>\n\n`, `: ping` heartbeat every 15s.

- [ ] **Step 1: Write the failing test** (`apps/api/src/events-stream.test.ts`). Model the runtime setup on `packages/composition/src/runtime.integration.test.ts` (temp `DATA_DIR`, `EXECUTOR_MODE: 'mock'`, worker NOT inline; copy its env/config setup exactly — read that file first). Test skeleton:

```ts
import { afterEach, describe, expect, it } from 'vitest';
// helpers: startApi() -> { app, runtime, baseUrl }; readSse(url, headers, count) -> ProjectEvent[]

async function readSse(
  url: string,
  headers: Record<string, string>,
  minEvents: number,
  timeoutMs = 10_000,
): Promise<{ events: ProjectEvent[]; abort: () => void }> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  // read response.body with a ReadableStream reader, split on '\n\n',
  // parse 'id:' and 'data:' lines, ignore ': ' comments, until minEvents collected or timeout
}

describe('GET /projects/:projectId/events/stream', () => {
  it('404s for unknown project before streaming', async () => {
    /* fetch, expect 404 JSON */
  });

  it('replays mid-run, reconnects without duplicates, and survives an API restart', async () => {
    // 1. start api #1, POST /projects (fetch, body: { name, prd: 'x'.repeat(60) })
    // 2. open stream with no cursor; start runtime.worker.runOnce() WITHOUT awaiting
    // 3. collect >= 5 events; note lastId = last received id; abort the stream (mid-run disconnect)
    // 4. await the runOnce promise (run completes while disconnected)
    // 5. close app #1 AND build a fresh runtime + app #2 over the SAME DATA_DIR (API restart)
    // 6. reconnect with header { 'last-event-id': lastId }
    // 7. collect until the stream is quiet; assert:
    //    - no received id is <= lastId (no duplicates)
    //    - [first batch ids, second batch ids] === full ids from runtime.events.list(projectId)
    //      (replay is complete and ordered)
  });

  it('accepts ?cursor= as an alternative to Last-Event-ID', async () => {
    // completed run; connect with cursor = third event id; expect exactly the tail
  });
});
```

- [ ] **Step 2: Run** `npx vitest run apps/api/src/events-stream.test.ts` — expect FAIL (404 route).

- [ ] **Step 3: Implement the route** in `buildApp`, after the existing `/projects/:projectId` routes:

```ts
app.get('/projects/:projectId/events/stream', async (request, reply) => {
  const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
  const { cursor } = z.object({ cursor: z.string().min(1).optional() }).parse(request.query);
  await runtime.projectService.get(projectId); // NotFoundError -> 404 before headers

  const lastEventId = request.headers['last-event-id'];
  let lastId = cursor ?? (typeof lastEventId === 'string' && lastEventId ? lastEventId : undefined);

  reply.hijack();
  const raw = reply.raw;
  const origin = request.headers.origin;
  const allowed = runtime.config.webOrigin.split(',').map((entry) => entry.trim());
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(origin && allowed.includes(origin) ? { 'access-control-allow-origin': origin } : {}),
  });
  raw.write(': connected\n\n');

  let sending = false;
  const send = async (): Promise<void> => {
    if (sending) return;
    sending = true;
    try {
      const batch = await runtime.events.list(projectId, 500, lastId);
      for (const event of batch) {
        raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        lastId = event.id;
      }
    } finally {
      sending = false;
    }
  };
  await send();
  // ponytail: 1s file-tail poll; swap for an in-process bus + fs notification if latency ever matters
  const poll = setInterval(() => void send().catch(() => undefined), 1_000);
  const heartbeat = setInterval(() => raw.write(': ping\n\n'), 15_000);
  request.raw.on('close', () => {
    clearInterval(poll);
    clearInterval(heartbeat);
    raw.end();
  });
});
```

Note: `lastId` starting as `undefined` means the first `send` replays the tail (default 500) — that is the desired "full recent history on first connect".

- [ ] **Step 4: Run the test** — expect PASS. Fix flakiness with `vi.waitFor`-style polling loops, not sleeps.

- [ ] **Step 5: Commit** — `feat(api): SSE event stream with cursor and Last-Event-ID replay`

---

### Task 5: Web — live stream with dedupe merge, enriched timeline, polling fallback

**Files:**

- Create: `apps/web/lib/events.ts`
- Test: `apps/web/lib/events.test.ts`
- Modify: `apps/web/lib/api.ts` (add `eventStreamUrl`)
- Modify: `apps/web/app/project/[id]/page.tsx`

**Interfaces:**

- Produces: `mergeEvents(current: ProjectEvent[], incoming: ProjectEvent[]): ProjectEvent[]` — id-deduped, ascending id order, returns `current` reference-equal when nothing new (avoids re-renders). `eventStreamUrl(id: string, cursor?: string): string`.

- [ ] **Step 1: Write failing test** (`apps/web/lib/events.test.ts` — pure function, node env, no React):

```ts
import { describe, expect, it } from 'vitest';
import { mergeEvents } from './events';
// three fixture events a < b < c by id

it('merges and sorts by id', () => {
  expect(mergeEvents([b], [a, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
});
it('drops duplicates by id', () => {
  expect(mergeEvents([a, b], [b, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
});
it('returns the same reference when nothing new', () => {
  const current = mergeEvents([a, b], []);
  expect(mergeEvents(current, [a])).toBe(current);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `apps/web/lib/events.ts` (Map by id, sort by id, reference-preserving early return). Add to `apps/web/lib/api.ts`:

```ts
export function eventStreamUrl(id: string, cursor?: string): string {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return `${API_URL}/projects/${encodeURIComponent(id)}/events/stream${query}`;
}
```

- [ ] **Step 4: Run** — PASS. Commit `feat(web): event merge helper and stream url`.

- [ ] **Step 5: Wire the page** (`apps/web/app/project/[id]/page.tsx`):
  - New state: `const [events, setEvents] = useState<ProjectEvent[]>([]);` and `const [live, setLive] = useState(false);`
  - In the existing poll, after `setDetail(next)`: `setEvents((current) => mergeEvents(current, next.events));`
  - New `useEffect` (keyed on `id`): create `new EventSource(eventStreamUrl(id))`; `onmessage`: `setEvents((current) => mergeEvents(current, [JSON.parse(ev.data)]))`; `onopen`: `setLive(true)`; `onerror`: `setLive(false)` (EventSource auto-reconnects with Last-Event-ID; polling keeps running regardless — that IS the fallback). Close it in cleanup and when project status becomes terminal.
  - Timeline renders from `events` (not `detail.events`), still newest-first. Add a status pill next to the timeline heading: `{live ? 'ao vivo' : 'polling'}`.
  - Enrich each event row from `event.data` when present (no schema change; keys per emitter in `packages/orchestrator/src/workflow-orchestrator.ts`): `modelId`/`provider` (agent.started/completed/failed), `durationMs` (agent.completed → render `${Math.round(durationMs / 1000)}s`), `fallbacks` (agent.routed), `name`+`revision` (artifact.created). Render as `<small>` badges in the existing `.eventMeta` row.
  - In the steps section (`page.tsx:253-286`), render one row per attempt under each step: sequence, `attempt.model` → `attempt.executedModel ?? '—'`, duration, status pill, and a `fallback` badge when `attempt.routeDecision && attempt.routeDecision.executed && attempt.routeDecision.executed.model.id !== attempt.routeDecision.selected.model.id` (same check as `page.tsx:296`). Show `attempt.error.message` in `<small>` when failed.

- [ ] **Step 6: Verify** `npm run typecheck && npm run build:apps` and `npx next lint`-equivalent via `npm run lint`. Manual smoke (evidence): `npm run dev:inline`, create a project, watch timeline go `ao vivo`, kill API mid-run, restart, confirm no duplicate rows (screenshot/curl transcript for the PR).

- [ ] **Step 7: Commit** — `feat(web): live SSE timeline with model/duration/fallback detail and polling fallback`

---

### Task 6: Docs + ADR + full check

**Files:**

- Create: `docs/adr/0012-sse-event-stream-and-redaction.md`
- Modify: `docs/ARCHITECTURE.md` (apps/web polling paragraph + extension points list), `README.md` if it documents the API routes.

- [ ] **Step 1:** ADR 0012 following `docs/adr/0011-*.md` format: context (polling hides latency; worker may be out-of-process), decision (persisted-store tail as SSE source; ULID id as cursor; redaction at the EventStore.append boundary), consequences (1s latency floor; redaction is best-effort pattern-based — trust boundary remains the executor sandbox).
- [ ] **Step 2:** Update `docs/ARCHITECTURE.md`: `apps/web` section mentions SSE with polling fallback; remove "Emitir eventos por SSE" from extension points (now built).
- [ ] **Step 3:** Run `npm run check` — all green. Capture output for PR evidence.
- [ ] **Step 4: Commit** — `docs: record SSE stream and redaction decisions`
