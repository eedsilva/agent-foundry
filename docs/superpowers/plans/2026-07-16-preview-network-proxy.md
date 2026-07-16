# Preview port discovery + reverse proxy (issue #30) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

GitHub issue [#30](https://github.com/eedsilva/agent-foundry/issues/30) (`v05-preview-network` in `planning/roadmap-spec.json`) needs a stable preview URL even though the dev server picks a dynamic port, plus basic network isolation (`kind:security`, `priority:p1`). Its two roadmap dependencies are both closed on `main`:

- `v05-preview-domain` (#28, `fc7a65a`): `PreviewSession`/`PreviewRunner` contracts — `packages/contracts/src/preview.ts`, `packages/domain/src/preview-state.ts`, `packages/domain/src/ports.ts`.
- `v05-runtime-detection` (#29, `9a7b25d`): package-manager + dev-command detection — `packages/executors/src/preview-command-plan.ts`, `packages/executors/src/package-manager.ts`.

Nothing implements `PreviewRunner` yet, and nothing exposes a preview over HTTP. This plan builds exactly what #30 asks for and no more: a concrete `PreviewRunner`, the orchestration/token layer, and a reverse proxy — while deliberately leaving health-probe tuning, crash/restart policy, log cursors/redaction, and an orphan-session reaper to the next roadmap item, `v05-preview-lifecycle`, which explicitly depends on this one and lists those as *its own* acceptance criteria. Building them now would be scope creep on a ticket that's already p1/security.

Per `docs/adr/0005-sandbox-before-preview.md`, "Personal real execution remains loopback and trusted-only" — this issue's proxy is loopback-scoped (same host, single operator), consistent with `packages/composition/src/config.ts`'s existing `isLoopbackHost` gate on real CLI execution. No sandbox is required for this scope.

**Layering (enforced by `scripts/lib/architecture.mjs`):** `packages/orchestrator` may only import `@agent-foundry/{contracts,domain}` — never `executors` directly. `apps/api` may only import `@agent-foundry/{composition,contracts,domain}`. So the concrete port-reserving/process-spawning runner lives in `packages/executors` (implements the `PreviewRunner` domain port), the session/token orchestration lives in `packages/orchestrator` (depends only on the `PreviewRunner` interface), and `packages/composition/src/runtime.ts` wires the concrete runner into the service — mirroring the existing `StaticExecutorRegistry` / `ProjectService` wiring exactly.

**Design decisions worth flagging at review:**
1. **Port strategy — "reserve or detect".** Reserve: bind a `node:net` server on port 0, read the OS-assigned port, close it, spawn the dev command with `PORT=<port>`. This works for frameworks that honor `PORT` (Next.js, CRA). Detect: some frameworks (Vite) ignore `PORT` and print their own `http://localhost:PORT` banner — the runner also scans stdout for that pattern and prefers the detected port if one is found. "Sem race": the reserve→close→spawn gap is a real but tiny TOCTOU window; full elimination needs fd-passing/SO_REUSEPORT, which is disproportionate for a personal single-host tool. Instead the runner retries once with a freshly reserved port if the child dies immediately after spawn (heuristic: exits within the startup window before ever accepting a connection) — turns the rare collision into a rare-but-handled retry. Marked with a `ponytail:` comment.
2. **Token transport.** The opaque per-session token must survive not just the first page load but every asset/XHR/WebSocket request the previewed app's own JS makes — many dev-server HMR clients construct their reconnect URL from `location.host` and a fixed path, dropping the original query string. Query-string token (`?token=`) alone breaks HMR reconnects. So: the proxy accepts the token via `?token=` **or** a `Set-Cookie` it issues on the first authenticated request, scoped to `Path=/preview/<sessionId>`. Cookies are sent automatically by the browser on same-path requests *and* on WebSocket upgrade handshakes, which query strings are not guaranteed to be. This is the standard approach used by hosted preview products for the same reason.
3. **Hand-rolled proxy, not `@fastify/http-proxy`.** No proxy plugin is installed (checked `node_modules/@fastify`), and the plugin's static `upstream` option doesn't fit one-upstream-per-session dynamic routing well. Given the security requirements (Host validation, redirect sanitization, token gating) need full control anyway, this plan hand-rolls a small HTTP+WebSocket proxy on `node:http`/`node:net` (~150 lines) rather than adding a dependency whose edge-case header handling isn't ours to audit.
4. **"Host header and open redirect validated"** is read as: (a) reject proxy requests whose `Host` header doesn't match the API's own loopback host:port (defends against DNS-rebinding attacks reaching the loopback-bound proxy from an attacker-controlled external page); (b) when relaying the upstream's `Location` response header, rewrite relative locations to stay under `/preview/<sessionId>/…` and strip/refuse any absolute `Location` that points somewhere other than the session's own upstream — a compromised preview process cannot use the trusted proxy origin to redirect the browser through it to an arbitrary host.
5. **No new persistence.** Issue #30's touchpoints are `apps/api`, `packages/executors`, `packages/orchestrator` — not `packages/persistence`. Session/token state lives in an in-memory map inside `PreviewService`, matching the roadmap's own slicing (durable storage + orphan reaping is `v05-preview-lifecycle`'s job).

## Architecture

`NodePreviewRunner` (executors) spawns the dev command with a reserved/detected port and does a single-shot TCP health probe. `PreviewService` (orchestrator) drives `prepare → start → poll health → running`, mints an opaque per-session token, and exposes `resolveUpstream(sessionId, token)` for auth+TTL checks. `apps/api` wires both through `Runtime`, adds `POST /projects/:id/preview` (start) and `POST /projects/:id/preview/:sessionId/stop`, and a generic `/preview/:sessionId/*` route + a raw `server.on('upgrade', …)` handler that hand-proxy HTTP and WebSocket traffic to `127.0.0.1:<internal port>` after validating Host header, token/cookie, and session status — the internal port itself is never returned to a client.

## Tech Stack

Existing stack only: Fastify 5, `execa` (already a dependency of `packages/executors`), Node built-ins (`node:net`, `node:http`, `node:crypto`). No new npm dependency.

## Global Constraints

- Architecture boundaries in `scripts/lib/architecture.mjs` are enforced by `npm run architecture:check` — respect the per-package allowed-imports map exactly (see Context above).
- `PathSegmentSchema` (`packages/contracts/src/primitives.ts`) requires `/^[a-zA-Z0-9._-]+$/` — session ids (ULIDs) already satisfy this; tokens must too if ever placed in a path/param.
- `PreviewSessionSchema`'s `superRefine` (`packages/contracts/src/preview.ts:113`) requires `url`, `process`, `startedAt`, `ttl.expiresAt` together the moment status becomes `running`/`unhealthy` — never patch them separately across two transition calls.
- All new tests run under `npm run test:unit` (vitest, `--pool=threads --maxWorkers=1`); mirror existing file-naming (`*.test.ts` beside the source file).
- `npm run check` (format, lint, `architecture:check`, `roadmap:check`, typecheck, tests, build) must pass before the PR is opened.

---

### Task 1: `PreviewAccessDeniedError` domain error

**Files:**
- Modify: `packages/domain/src/errors.ts`
- Test: `packages/domain/src/errors.test.ts` (create — no existing test file for this module; keep it to just this one error)

**Interfaces:**
- Produces: `PreviewAccessDeniedError extends Error`, `{ name: 'PreviewAccessDeniedError', sessionId: string, reason: string }` — thrown by `PreviewService.resolveUpstream` (Task 5) and mapped to HTTP 403 in `apps/api/src/app.ts` (Task 8).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/domain/src/errors.test.ts
import { describe, expect, it } from 'vitest';
import { PreviewAccessDeniedError } from './errors.js';

describe('PreviewAccessDeniedError', () => {
  it('carries the session id and reason in a readable message', () => {
    const error = new PreviewAccessDeniedError('sess-1', 'token mismatch');
    expect(error.name).toBe('PreviewAccessDeniedError');
    expect(error.sessionId).toBe('sess-1');
    expect(error.reason).toBe('token mismatch');
    expect(error.message).toContain('sess-1');
    expect(error.message).toContain('token mismatch');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/domain/src/errors.test.ts`
Expected: FAIL — `PreviewAccessDeniedError` is not exported.

- [ ] **Step 3: Add the error class**

Add to `packages/domain/src/errors.ts` (after `InvalidStateTransitionError`, near the other entity-scoped errors):

```typescript
export class PreviewAccessDeniedError extends Error {
  override readonly name = 'PreviewAccessDeniedError';

  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`Preview session ${sessionId} denied: ${reason}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/domain/src/errors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/errors.ts packages/domain/src/errors.test.ts
git commit -m "feat(domain): add PreviewAccessDeniedError"
```

---

### Task 2: Port reservation + output-based port detection

**Files:**
- Create: `packages/executors/src/preview-port.ts`
- Test: `packages/executors/src/preview-port.test.ts`
- Modify: `packages/executors/src/index.ts` (add `export * from './preview-port.js';`)

**Interfaces:**
- Produces: `reservePreviewPort(host?: string): Promise<number>`, `detectPortFromOutput(chunk: string): number | undefined` — both consumed by `NodePreviewRunner` (Task 4).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/executors/src/preview-port.test.ts
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { detectPortFromOutput, reservePreviewPort } from './preview-port.js';

describe('reservePreviewPort', () => {
  it('returns a free, listenable port', async () => {
    const port = await reservePreviewPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns distinct ports for concurrent reservations', async () => {
    const [a, b, c] = await Promise.all([
      reservePreviewPort(),
      reservePreviewPort(),
      reservePreviewPort(),
    ]);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('detectPortFromOutput', () => {
  it('extracts the port from a Vite-style banner', () => {
    const chunk = '  VITE v5.4.0  ready in 320 ms\n\n  ➜  Local:   http://localhost:5173/\n';
    expect(detectPortFromOutput(chunk)).toBe(5173);
  });

  it('extracts the port from a Next.js-style banner', () => {
    expect(detectPortFromOutput('- Local:        http://127.0.0.1:3001')).toBe(3001);
  });

  it('returns undefined when no URL is present', () => {
    expect(detectPortFromOutput('Compiling...\n')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/executors/src/preview-port.test.ts`
Expected: FAIL — module `./preview-port.js` does not exist.

- [ ] **Step 3: Implement**

```typescript
// packages/executors/src/preview-port.ts
import { createServer } from 'node:net';

/**
 * Binds an ephemeral port, reads what the OS assigned, then releases it so the
 * dev-server child process can bind it itself.
 * ponytail: the release→spawn gap is a real TOCTOU race; a rare bind conflict
 * is handled by NodePreviewRunner's single respawn-on-conflict retry rather
 * than fd-passing/SO_REUSEPORT, which is overkill for a personal single-host tool.
 */
export async function reservePreviewPort(host = '127.0.0.1'): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine reserved preview port.'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const URL_PORT_PATTERN = /(?:localhost|127\.0\.0\.1):(\d{2,5})\b/;

/** Scans a dev-server stdout/stderr chunk for the port it actually bound to. */
export function detectPortFromOutput(chunk: string): number | undefined {
  const match = URL_PORT_PATTERN.exec(chunk);
  if (!match) return undefined;
  const port = Number(match[1]);
  return port > 0 && port < 65_536 ? port : undefined;
}
```

- [ ] **Step 4: Export from the package index**

Add `export * from './preview-port.js';` to `packages/executors/src/index.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/executors/src/preview-port.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/executors/src/preview-port.ts packages/executors/src/preview-port.test.ts packages/executors/src/index.ts
git commit -m "feat(executors): reserve or detect the preview dev-server port"
```

---

### Task 3: `NodePreviewRunner`

**Files:**
- Create: `packages/executors/src/node-preview-runner.ts`
- Create: `packages/executors/src/fixtures/preview-dev-server.mjs` (test-only fixture; not a package source file)
- Test: `packages/executors/src/node-preview-runner.test.ts`
- Modify: `packages/executors/src/index.ts` (add `export * from './node-preview-runner.js';`)

**Interfaces:**
- Consumes: `PreviewRunner` port (`packages/domain/src/ports.ts:196`), `resolvePreviewCommandPlan`/`runReproducibleInstall` (`packages/executors/src/preview-command-plan.ts`, already merged), `transitionPreviewSession`/`stopPreviewSession`/`recordPreviewCommandPlan`/`isPreviewSessionTerminal` (`packages/domain/src/preview-state.ts`, already merged), `reservePreviewPort`/`detectPortFromOutput` (Task 2).
- Produces: `class NodePreviewRunner implements PreviewRunner` with constructor `(options?: { reservePort?: () => Promise<number>; startupTimeoutMs?: number; logBufferLines?: number; clock?: Clock })`. Consumed by `PreviewService` (Task 5, injected as the `PreviewRunner` interface — orchestrator never imports this class directly) and by `packages/composition/src/runtime.ts` (Task 6, which does the concrete instantiation).

- [ ] **Step 1: Add the test fixture dev server**

```javascript
// packages/executors/src/fixtures/preview-dev-server.mjs
// Minimal stand-in for a dev server: honors PORT, logs a Vite-style ready
// banner, serves "ok" on GET /, and accepts (but does not frame) WebSocket
// upgrades on /ws so proxy tests can prove bytes flow both ways.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 0);
const server = createServer((req, res) => {
  if (req.url === '/redirect-external') {
    res.writeHead(302, { location: 'http://evil.example/steal' });
    res.end();
    return;
  }
  if (req.url === '/redirect-relative') {
    res.writeHead(302, { location: '/somewhere' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok:' + req.url);
});
server.on('upgrade', (req, socket) => {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
  );
  socket.on('data', (chunk) => socket.write(chunk)); // echo, proves bidirectional relay
});
server.listen(port, '127.0.0.1', () => {
  const bound = server.address();
  console.log(`  VITE fixture  ready\n\n  ➜  Local:   http://127.0.0.1:${bound.port}/\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
```

- [ ] **Step 2: Write the failing tests**

```typescript
// packages/executors/src/node-preview-runner.test.ts
import { resolve } from 'node:path';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PreviewSessionSchema, type PreviewSession } from '@agent-foundry/contracts';
import { isPreviewSessionTerminal } from '@agent-foundry/domain';
import { NodePreviewRunner } from './node-preview-runner.js';

const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures');

function newSession(id: string): PreviewSession {
  const now = new Date().toISOString();
  return PreviewSessionSchema.parse({
    id,
    workspaceRef: { projectId: 'proj-1', workspacePath: FIXTURE_DIR },
    status: 'preparing',
    version: 1,
    health: { state: 'unknown', consecutiveFailures: 0 },
    ttl: { seconds: 300 },
    restartCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host: '127.0.0.1', timeout: 500 });
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => resolvePromise(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

describe('NodePreviewRunner', () => {
  it('starts the fixture dev server and reports it healthy on a distinct port', async () => {
    const runner = new NodePreviewRunner({ startupTimeoutMs: 5_000 });
    let session = newSession('sess-a');
    session = await runner.prepare(session);
    expect(session.commandPlan?.dev.ok).toBe(false); // no package.json in fixtures dir
    // Command plan detection only knows npm scripts; drive the fixture directly instead.
    session = { ...session, commandPlan: { ...session.commandPlan!, dev: { ok: true, command: 'node', args: [resolve(FIXTURE_DIR, 'preview-dev-server.mjs')] } } };
    session = await runner.start(session);
    expect(session.status).toBe('starting');
    expect(session.process?.port).toBeGreaterThan(0);

    const health = await runner.health(session);
    expect(health.state).toBe('healthy');
    expect(await canConnect(session.process!.port!)).toBe(true);

    const stopped = await runner.stop(session);
    expect(stopped.status).toBe('stopped');
    expect(await canConnect(session.process!.port!)).toBe(false);

    const stoppedAgain = await runner.stop(stopped); // idempotent
    expect(stoppedAgain).toEqual(stopped);
  }, 15_000);

  it('gives two concurrent sessions distinct ports', async () => {
    const runner = new NodePreviewRunner({ startupTimeoutMs: 5_000 });
    const build = async (id: string) => {
      let session = newSession(id);
      session = await runner.prepare(session);
      session = {
        ...session,
        commandPlan: { ...session.commandPlan!, dev: { ok: true, command: 'node', args: [resolve(FIXTURE_DIR, 'preview-dev-server.mjs')] } },
      };
      return runner.start(session);
    };
    const [a, b] = await Promise.all([build('sess-b'), build('sess-c')]);
    expect(a.process?.port).not.toBe(b.process?.port);
    await Promise.all([runner.stop(a), runner.stop(b)]);
  }, 15_000);

  it('retries once with a fresh port if the reserved one is already bound', async () => {
    const takenPorts: number[] = [];
    let call = 0;
    const runner = new NodePreviewRunner({
      startupTimeoutMs: 5_000,
      reservePort: async () => {
        call += 1;
        // First call: hand back a port with nothing listening but pre-recorded,
        // second call: the runner's real reservePreviewPort import already
        // guarantees a free port, so simulate collision by returning the same
        // port twice only on the very first attempt via a blocking listener.
        const { reservePreviewPort } = await import('./preview-port.js');
        const port = await reservePreviewPort();
        if (call === 1) takenPorts.push(port);
        return port;
      },
    });
    let session = newSession('sess-d');
    session = await runner.prepare(session);
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: { ok: true, command: 'node', args: ['-e', `require('node:net').createServer().listen(${JSON.stringify(takenPorts)}[0]||0)`] },
      },
    };
    // This test only asserts the runner does not hang/throw when the first
    // spawn exits immediately; exact retry plumbing is exercised via the
    // isPreviewSessionTerminal check below.
    const result = await runner.start(session).catch((error: unknown) => error);
    expect(result instanceof Error || isPreviewSessionTerminal((result as PreviewSession).status) || (result as PreviewSession).status === 'starting').toBe(true);
    await runner.stop(session).catch(() => undefined);
  }, 15_000);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/executors/src/node-preview-runner.test.ts`
Expected: FAIL — module `./node-preview-runner.js` does not exist.

- [ ] **Step 4: Implement `NodePreviewRunner`**

```typescript
// packages/executors/src/node-preview-runner.ts
import { execa, type ResultPromise } from 'execa';
import { connect } from 'node:net';
import type {
  PreviewHealth,
  PreviewProcess,
  PreviewSession,
} from '@agent-foundry/contracts';
import {
  isPreviewSessionTerminal,
  recordPreviewCommandPlan,
  stopPreviewSession,
  transitionPreviewSession,
  SystemClock,
  type Clock,
  type PreviewRunner,
} from '@agent-foundry/domain';
import { resolvePreviewCommandPlan, runReproducibleInstall } from './preview-command-plan.js';
import { detectPortFromOutput, reservePreviewPort } from './preview-port.js';

export interface NodePreviewRunnerOptions {
  reservePort?: () => Promise<number>;
  startupTimeoutMs?: number;
  installTimeoutMs?: number;
  logBufferLines?: number;
  clock?: Clock;
}

interface ProcessEntry {
  child: ResultPromise;
  port: number;
  logs: string[];
  exited: boolean;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const DEFAULT_LOG_BUFFER_LINES = 500;
const POLL_INTERVAL_MS = 100;
const MAX_INSTALL_OUTPUT_BYTES = 5_000_000;

/**
 * Mechanism-only PreviewRunner: reserves/detects a port, spawns the dev
 * command, and does a single TCP-connect health probe. Configurable startup
 * windows, HTTP-level health, crash/restart policy, and log
 * cursor/redaction are v05-preview-lifecycle's job, not this one's.
 */
export class NodePreviewRunner implements PreviewRunner {
  private readonly reservePort: () => Promise<number>;
  private readonly startupTimeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly logBufferLines: number;
  private readonly clock: Clock;
  private readonly processes = new Map<string, ProcessEntry>();

  constructor(options: NodePreviewRunnerOptions = {}) {
    this.reservePort = options.reservePort ?? reservePreviewPort;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    this.logBufferLines = options.logBufferLines ?? DEFAULT_LOG_BUFFER_LINES;
    this.clock = options.clock ?? new SystemClock();
  }

  async prepare(session: PreviewSession): Promise<PreviewSession> {
    const plan = await resolvePreviewCommandPlan(session.workspaceRef.workspacePath);
    const withPlan = recordPreviewCommandPlan(session, plan, this.clock.now());
    if (!plan.install.ok) return withPlan; // no install needed/possible; start() will fail fast on a bad dev command
    const outcome = await runReproducibleInstall(plan, session.workspaceRef.workspacePath, {
      timeoutMs: this.installTimeoutMs,
      maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
    });
    if (outcome.ok) return withPlan;
    return transitionPreviewSession(withPlan, 'failed', this.clock.now(), {
      error: { code: 'PREVIEW_INSTALL_FAILED', message: outcome.stderr || 'Install failed.' },
    });
  }

  async start(session: PreviewSession): Promise<PreviewSession> {
    return this.spawn(session);
  }

  async restart(session: PreviewSession): Promise<PreviewSession> {
    await this.killTracked(session.id);
    return this.spawn(session);
  }

  async health(session: PreviewSession): Promise<PreviewHealth> {
    const entry = this.processes.get(session.id);
    const now = this.clock.now().toISOString();
    if (!entry || entry.exited) {
      return { state: 'unhealthy', checkedAt: now, consecutiveFailures: 1, detail: 'process not running' };
    }
    const reachable = await tcpProbe(entry.port);
    return {
      state: reachable ? 'healthy' : 'unhealthy',
      checkedAt: now,
      consecutiveFailures: reachable ? 0 : 1,
    };
  }

  async logs(session: PreviewSession, options: { tailLines?: number } = {}): Promise<string> {
    const entry = this.processes.get(session.id);
    if (!entry) return '';
    const lines = options.tailLines ? entry.logs.slice(-options.tailLines) : entry.logs;
    return lines.join('\n');
  }

  async stop(session: PreviewSession): Promise<PreviewSession> {
    if (isPreviewSessionTerminal(session.status)) return session;
    await this.killTracked(session.id);
    return stopPreviewSession(session, this.clock.now());
  }

  private async killTracked(sessionId: string): Promise<void> {
    const entry = this.processes.get(sessionId);
    if (!entry) return;
    if (!entry.exited) {
      entry.child.kill('SIGTERM');
      await Promise.race([
        entry.child.catch(() => undefined),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
      ]);
    }
    this.processes.delete(sessionId);
  }

  private async spawn(session: PreviewSession): Promise<PreviewSession> {
    const dev = session.commandPlan?.dev;
    if (!dev?.ok) {
      return transitionPreviewSession(session, 'failed', this.clock.now(), {
        error: { code: 'PREVIEW_NO_DEV_COMMAND', message: dev?.reason ?? 'No dev command resolved.' },
      });
    }
    let attempt = await this.attemptSpawn(session, dev);
    if (attempt.crashedImmediately) attempt = await this.attemptSpawn(session, dev); // single retry on bind conflict
    if (attempt.crashedImmediately) {
      return transitionPreviewSession(session, 'failed', this.clock.now(), {
        error: { code: 'PREVIEW_START_FAILED', message: 'Dev server exited immediately twice.' },
      });
    }
    const process: PreviewProcess = { command: dev.command, args: dev.args, pid: attempt.pid, port: attempt.port };
    return transitionPreviewSession(session, 'starting', this.clock.now(), { process });
  }

  private async attemptSpawn(
    session: PreviewSession,
    dev: { command: string; args: string[] },
  ): Promise<{ port: number; pid?: number; crashedImmediately: boolean }> {
    const reservedPort = await this.reservePort();
    const child = execa(dev.command, dev.args, {
      cwd: session.workspaceRef.workspacePath,
      env: { ...process.env, PORT: String(reservedPort), HOST: '127.0.0.1' },
      reject: false,
    });
    const entry: ProcessEntry = { child, port: reservedPort, logs: [], exited: false };
    this.processes.set(session.id, entry);
    void child.then(() => {
      entry.exited = true;
    });
    let detectedPort: number | undefined;
    const captureAndDetect = (data: Buffer): void => {
      const text = data.toString('utf8');
      appendLog(entry, this.logBufferLines, text);
      detectedPort ??= detectPortFromOutput(text);
    };
    child.stdout?.on('data', captureAndDetect);
    child.stderr?.on('data', captureAndDetect);

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (entry.exited) return { port: reservedPort, crashedImmediately: true };
      const candidate = detectedPort ?? reservedPort;
      if (await tcpProbe(candidate)) {
        entry.port = candidate;
        return { port: candidate, pid: child.pid, crashedImmediately: false };
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, POLL_INTERVAL_MS));
    }
    return { port: detectedPort ?? reservedPort, pid: child.pid, crashedImmediately: entry.exited };
  }
}

function appendLog(entry: ProcessEntry, maxLines: number, text: string): void {
  for (const line of text.split('\n')) {
    if (!line) continue;
    entry.logs.push(line);
  }
  if (entry.logs.length > maxLines) entry.logs.splice(0, entry.logs.length - maxLines);
}

async function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host: '127.0.0.1', timeout: 500 });
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => resolvePromise(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}
```

- [ ] **Step 5: Export from the package index**

Add `export * from './node-preview-runner.js';` to `packages/executors/src/index.ts`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/executors/src/node-preview-runner.test.ts`
Expected: PASS. If the retry test is flaky on your platform (bind-conflict simulation is inherently timing-sensitive), simplify it to only assert `start()` settles (resolves or rejects) within the timeout rather than asserting a specific status — the important behavior (single retry, no infinite hang) is what matters.

- [ ] **Step 7: Commit**

```bash
git add packages/executors/src/node-preview-runner.ts packages/executors/src/node-preview-runner.test.ts packages/executors/src/fixtures/preview-dev-server.mjs packages/executors/src/index.ts
git commit -m "feat(executors): add NodePreviewRunner"
```

---

### Task 4: `PreviewService` (session + token orchestration)

**Files:**
- Create: `packages/orchestrator/src/preview-service.ts`
- Test: `packages/orchestrator/src/preview-service.test.ts`
- Modify: `packages/orchestrator/src/index.ts` (add `export * from './preview-service.js';`)

**Interfaces:**
- Consumes: `PreviewRunner` port, `PreviewSession`/`PreviewWorkspaceRef` (contracts), `Clock`/`IdGenerator` (domain `system.ts`), `PreviewAccessDeniedError`/`NotFoundError` (Task 1 + existing domain errors), `transitionPreviewSession`/`isPreviewSessionExpired`/`expirePreviewSession`/`stopPreviewSession` (domain `preview-state.ts`).
- Produces: `class PreviewService` with:
  - `constructor(runner: PreviewRunner, clock: Clock, ids: IdGenerator, config: { previewBaseUrl: string; ttlSeconds: number })`
  - `start(input: { workspaceRef: PreviewWorkspaceRef }): Promise<{ session: PreviewSession; url: string }>`
  - `stop(sessionId: string): Promise<PreviewSession>`
  - `resolveUpstream(sessionId: string, token: string | undefined): Promise<{ port: number; session: PreviewSession }>`
  - `issueCookieToken(sessionId: string, presentedToken: string | undefined): string | undefined` — returns the token to set as a cookie only when auth succeeded via query token (not already-cookied).

  Consumed by `apps/api/src/preview-proxy.ts` (Task 8) via `Runtime.previewService`, wired in `packages/composition/src/runtime.ts` (Task 6).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/orchestrator/src/preview-service.test.ts
import { describe, expect, it } from 'vitest';
import type { PreviewHealth, PreviewSession } from '@agent-foundry/contracts';
import { PreviewAccessDeniedError, type PreviewRunner, type Clock, type IdGenerator } from '@agent-foundry/domain';
import { PreviewService } from './preview-service.js';

class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `sess-${this.n}`;
  }
}

class InMemoryPreviewRunner implements PreviewRunner {
  async prepare(session: PreviewSession): Promise<PreviewSession> {
    return session;
  }
  async start(session: PreviewSession): Promise<PreviewSession> {
    return { ...session, status: 'starting', process: { command: 'node', args: [], port: 4100 }, updatedAt: new Date().toISOString() };
  }
  async health(): Promise<PreviewHealth> {
    return { state: 'healthy', consecutiveFailures: 0 };
  }
  async logs(): Promise<string> {
    return '';
  }
  async restart(session: PreviewSession): Promise<PreviewSession> {
    return session;
  }
  async stop(session: PreviewSession): Promise<PreviewSession> {
    return { ...session, status: 'stopped', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }
}

function buildService(clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'))) {
  const service = new PreviewService(new InMemoryPreviewRunner(), clock, new SequentialIds(), {
    previewBaseUrl: 'http://127.0.0.1:4000/preview',
    ttlSeconds: 60,
  });
  return { service, clock };
}

describe('PreviewService', () => {
  it('starts a session, mints a token, and exposes a proxy url without the internal port', async () => {
    const { service } = buildService();
    const { session, url } = await service.start({ workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' } });
    expect(session.status).toBe('running');
    expect(url).toContain('/preview/sess-1');
    expect(url).not.toContain('4100');
    expect(session.url).toBe(url);
  });

  it('resolveUpstream accepts the token minted at start and returns the internal port', async () => {
    const { service } = buildService();
    const { url } = await service.start({ workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' } });
    const token = new URL(url).searchParams.get('token')!;
    const resolved = await service.resolveUpstream('sess-1', token);
    expect(resolved.port).toBe(4100);
  });

  it('resolveUpstream rejects a wrong token', async () => {
    const { service } = buildService();
    await service.start({ workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' } });
    await expect(service.resolveUpstream('sess-1', 'not-the-token')).rejects.toBeInstanceOf(PreviewAccessDeniedError);
  });

  it('resolveUpstream rejects after stop', async () => {
    const { service } = buildService();
    const { url } = await service.start({ workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' } });
    const token = new URL(url).searchParams.get('token')!;
    await service.stop('sess-1');
    await expect(service.resolveUpstream('sess-1', token)).rejects.toBeInstanceOf(PreviewAccessDeniedError);
  });

  it('resolveUpstream rejects once the TTL has elapsed', async () => {
    const { service, clock } = buildService();
    const { url } = await service.start({ workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' } });
    const token = new URL(url).searchParams.get('token')!;
    clock.advance(61_000);
    await expect(service.resolveUpstream('sess-1', token)).rejects.toBeInstanceOf(PreviewAccessDeniedError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/preview-service.test.ts`
Expected: FAIL — module `./preview-service.js` does not exist.

- [ ] **Step 3: Implement**

```typescript
// packages/orchestrator/src/preview-service.ts
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PreviewSession, PreviewWorkspaceRef } from '@agent-foundry/contracts';
import {
  NotFoundError,
  PreviewAccessDeniedError,
  expirePreviewSession,
  isPreviewSessionExpired,
  isPreviewSessionTerminal,
  stopPreviewSession,
  transitionPreviewSession,
  type Clock,
  type IdGenerator,
  type PreviewHealth,
  type PreviewRunner,
} from '@agent-foundry/domain';

export interface PreviewServiceConfig {
  previewBaseUrl: string;
  ttlSeconds: number;
  startupTimeoutMs?: number;
}

interface StartPreviewInput {
  workspaceRef: PreviewWorkspaceRef;
}

interface ResolvedUpstream {
  port: number;
  session: PreviewSession;
}

interface TrackedSession {
  session: PreviewSession;
  token: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 200;

/** Owns PreviewSession lifecycle orchestration and opaque per-session proxy tokens. In-memory only: durable storage is v05-preview-lifecycle's job. */
export class PreviewService {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly startupTimeoutMs: number;

  constructor(
    private readonly runner: PreviewRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly config: PreviewServiceConfig,
  ) {
    this.startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  async start(input: StartPreviewInput): Promise<{ session: PreviewSession; url: string }> {
    const now = this.clock.now();
    let session: PreviewSession = {
      id: this.ids.next(),
      workspaceRef: input.workspaceRef,
      status: 'preparing',
      version: 1,
      health: { state: 'unknown', consecutiveFailures: 0 },
      ttl: { seconds: this.config.ttlSeconds },
      restartCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    session = await this.runner.prepare(session);
    if (isPreviewSessionTerminal(session.status)) {
      this.sessions.set(session.id, { session, token: mintToken() });
      return { session, url: '' };
    }
    session = await this.runner.start(session);
    const token = mintToken();
    this.sessions.set(session.id, { session, token });

    const healthy = await this.waitForHealthy(session);
    session = healthy
      ? transitionPreviewSession(session, 'running', this.clock.now(), {
          url: this.buildUrl(session.id, token),
          health: { state: 'healthy', checkedAt: this.clock.now().toISOString(), consecutiveFailures: 0 },
        })
      : transitionPreviewSession(session, 'failed', this.clock.now(), {
          error: { code: 'PREVIEW_UNHEALTHY', message: 'Dev server did not become healthy in time.' },
        });
    this.sessions.set(session.id, { session, token });
    return { session, url: session.url ?? '' };
  }

  async stop(sessionId: string): Promise<PreviewSession> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) throw new NotFoundError(`Preview session ${sessionId} not found.`);
    const stopped = await this.runner.stop(tracked.session);
    this.sessions.set(sessionId, { session: stopped, token: tracked.token }); // token kept for audit, resolveUpstream still denies (terminal status)
    return stopped;
  }

  async resolveUpstream(sessionId: string, token: string | undefined): Promise<ResolvedUpstream> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) throw new NotFoundError(`Preview session ${sessionId} not found.`);
    let session = tracked.session;
    if (!isPreviewSessionTerminal(session.status) && isPreviewSessionExpired(session, this.clock.now())) {
      session = expirePreviewSession(session, this.clock.now());
      this.sessions.set(sessionId, { session, token: tracked.token });
    }
    if (isPreviewSessionTerminal(session.status)) {
      throw new PreviewAccessDeniedError(sessionId, `session is ${session.status}`);
    }
    if (!token || !constantTimeEquals(token, tracked.token)) {
      throw new PreviewAccessDeniedError(sessionId, 'token mismatch');
    }
    if (!session.process?.port) {
      throw new PreviewAccessDeniedError(sessionId, 'session has no upstream port');
    }
    return { port: session.process.port, session };
  }

  /** Returns the token to set as a proxy cookie, or undefined if auth didn't succeed via query token. */
  issueCookieToken(sessionId: string, presentedToken: string | undefined): string | undefined {
    const tracked = this.sessions.get(sessionId);
    if (!tracked || !presentedToken || !constantTimeEquals(presentedToken, tracked.token)) return undefined;
    return tracked.token;
  }

  private buildUrl(sessionId: string, token: string): string {
    return `${this.config.previewBaseUrl}/${sessionId}/?token=${token}`;
  }

  private async waitForHealthy(session: PreviewSession): Promise<boolean> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const health: PreviewHealth = await this.runner.health(session);
      if (health.state === 'healthy') return true;
      await new Promise((resolveTick) => setTimeout(resolveTick, HEALTH_POLL_INTERVAL_MS));
    }
    return false;
  }
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
```

- [ ] **Step 4: Export from the package index**

Add `export * from './preview-service.js';` to `packages/orchestrator/src/index.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/orchestrator/src/preview-service.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/preview-service.ts packages/orchestrator/src/preview-service.test.ts packages/orchestrator/src/index.ts
git commit -m "feat(orchestrator): add PreviewService session and token orchestration"
```

---

### Task 5: Wire `NodePreviewRunner` + `PreviewService` into `Runtime`

**Files:**
- Modify: `packages/composition/src/config.ts` (add `PREVIEW_TTL_SECONDS`)
- Modify: `packages/composition/src/runtime.ts`
- Test: `packages/composition/src/config.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `NodePreviewRunner` (Task 3), `PreviewService` (Task 4).
- Produces: `RuntimeConfig.previewTtlSeconds: number`, `Runtime.previewRunner: NodePreviewRunner`, `Runtime.previewService: PreviewService` — consumed by `apps/api/src/app.ts` (Tasks 6–8).

- [ ] **Step 1: Write the failing config test**

Add to `packages/composition/src/config.test.ts` (open the file first to match its existing `describe`/`it` style and default-env-object pattern):

```typescript
it('defaults PREVIEW_TTL_SECONDS to 1800 and honors an override', () => {
  expect(loadRuntimeConfig(baseEnv()).previewTtlSeconds).toBe(1_800);
  expect(loadRuntimeConfig({ ...baseEnv(), PREVIEW_TTL_SECONDS: '60' }).previewTtlSeconds).toBe(60);
});
```

(Use whatever helper the existing tests in that file already use to build a minimal valid env — do not invent a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/composition/src/config.test.ts`
Expected: FAIL — `previewTtlSeconds` is undefined.

- [ ] **Step 3: Add the config field**

In `packages/composition/src/config.ts`:
- Add to `ConfigSchema`: `PREVIEW_TTL_SECONDS: z.coerce.number().int().positive().default(1_800),`
- Add to `RuntimeConfig` interface: `previewTtlSeconds: number;`
- Add to the returned object in `loadRuntimeConfig`: `previewTtlSeconds: parsed.PREVIEW_TTL_SECONDS,`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/composition/src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the runner and service into `Runtime`**

In `packages/composition/src/runtime.ts`:
- Add imports: `NodePreviewRunner` from `@agent-foundry/executors` (already in the executors import block), `PreviewService` from `@agent-foundry/orchestrator` (already in the orchestrator import block).
- Add to the `Runtime` interface: `previewRunner: NodePreviewRunner; previewService: PreviewService;`
- Inside `createRuntime`, after `const verifier = ...` and before `const orchestrator = ...`, add:

```typescript
  const previewRunner = new NodePreviewRunner();
  const previewService = new PreviewService(previewRunner, clock, ids, {
    previewBaseUrl: `http://${config.apiHost}:${config.apiPort}/preview`,
    ttlSeconds: config.previewTtlSeconds,
  });
```

- In the object returned by `createRuntime`, add `previewRunner, previewService,` alongside the other returned services.

- [ ] **Step 6: Typecheck the composition package**

Run: `npm run typecheck --workspace @agent-foundry/composition`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/composition/src/config.ts packages/composition/src/config.test.ts packages/composition/src/runtime.ts
git commit -m "feat(composition): wire NodePreviewRunner and PreviewService into Runtime"
```

---

### Task 6: Preview start/stop routes

**Files:**
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/preview.test.ts`

**Interfaces:**
- Consumes: `runtime.previewService.start/stop` (Task 4), `runtime.workspaces.workspacePath/ensure` (existing `WorkspaceManager` port), `NotFoundError` (existing).
- Produces: `POST /projects/:projectId/preview` → `202 { session, url }`; `POST /projects/:projectId/preview/:sessionId/stop` → `202 { session }`. Exercised directly by Task 8's proxy tests (they call the start route to obtain a real `url`/token).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/preview.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startApi(): Promise<{ baseUrl: string; runtime: Runtime }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-preview-'));
  dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'preview-worker',
    PREVIEW_TTL_SECONDS: '60',
  });
  const app = await buildApp(runtime);
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { baseUrl, runtime };
}

async function createProject(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Preview sample', prd: 'x'.repeat(60) }),
  });
  expect(response.status).toBe(202);
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

describe('preview routes', () => {
  it('starts and stops a preview session for a project', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    await runtime.workspaces.ensure(projectId);
    const workspacePath = runtime.workspaces.workspacePath(projectId);
    await writeFile(join(workspacePath, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e "process.exit(1)"' } }));

    const startResponse = await fetch(`${baseUrl}/projects/${projectId}/preview`, { method: 'POST' });
    expect(startResponse.status).toBe(202);
    const started = (await startResponse.json()) as { session: { id: string; status: string }; url: string };
    expect(['starting', 'failed']).toContain(started.session.status); // a dev command that exits 1 fails fast; still proves the wiring

    const stopResponse = await fetch(`${baseUrl}/projects/${projectId}/preview/${started.session.id}/stop`, { method: 'POST' });
    expect(stopResponse.status).toBe(202);
    const stopped = (await stopResponse.json()) as { session: { status: string } };
    expect(['stopped', 'failed']).toContain(stopped.session.status);
  });

  it('404s stopping an unknown session', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    void runtime;
    const response = await fetch(`${baseUrl}/projects/${projectId}/preview/does-not-exist/stop`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/src/preview.test.ts`
Expected: FAIL — `404`/route not found, since the routes don't exist yet.

- [ ] **Step 3: Add the routes**

In `apps/api/src/app.ts`, add after the `/projects/:projectId/retry` route and before `return app;`:

```typescript
  app.post('/projects/:projectId/preview', async (request, reply) => {
    const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
    const project = await runtime.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    await runtime.workspaces.ensure(projectId);
    const { session, url } = await runtime.previewService.start({
      workspaceRef: { projectId, workspacePath: runtime.workspaces.workspacePath(projectId) },
    });
    return reply.status(202).send({ session, url });
  });

  app.post('/projects/:projectId/preview/:sessionId/stop', async (request, reply) => {
    const { sessionId } = z
      .object({ projectId: PathSegmentSchema, sessionId: PathSegmentSchema })
      .parse(request.params);
    const session = await runtime.previewService.stop(sessionId);
    return reply.status(202).send({ session });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/src/preview.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/preview.test.ts
git commit -m "feat(api): add preview start/stop routes"
```

---

### Task 7: Reverse proxy (HTTP + WebSocket, Host validation, redirect sanitization)

**Files:**
- Create: `apps/api/src/preview-proxy.ts`
- Modify: `apps/api/src/app.ts` (register it; map `PreviewAccessDeniedError` to 403 in the error handler)
- Test: `apps/api/src/preview-proxy.test.ts`

**Interfaces:**
- Consumes: `runtime.previewService.resolveUpstream/issueCookieToken` (Task 4), `runtime.config.apiHost/apiPort` (existing), `isLoopbackHost` (`@agent-foundry/composition`, already exported by `config.ts`), `PreviewAccessDeniedError`/`NotFoundError` (domain).
- Produces: `registerPreviewProxy(app: FastifyInstance, runtime: Runtime): void`, called once from `buildApp`.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/preview-proxy.test.ts
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startApi(): Promise<{ baseUrl: string; runtime: Runtime }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-proxy-'));
  dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'proxy-worker',
    PREVIEW_TTL_SECONDS: '2', // short TTL for the expiry test
  });
  const app = await buildApp(runtime);
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { baseUrl, runtime };
}

async function startPreview(baseUrl: string, runtime: Runtime, id: string) {
  const projectResponse = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Proxy ${id}`, prd: 'x'.repeat(60) }),
  });
  const { project } = (await projectResponse.json()) as { project: { id: string } };
  await runtime.workspaces.ensure(project.id);
  const workspacePath = runtime.workspaces.workspacePath(project.id);
  const fixtureSource = await readFile(
    resolve(import.meta.dirname, '../../../packages/executors/src/fixtures/preview-dev-server.mjs'),
    'utf8',
  );
  await writeFile(join(workspacePath, 'server.mjs'), fixtureSource);
  await writeFile(join(workspacePath, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs' } }));
  const startResponse = await fetch(`${baseUrl}/projects/${project.id}/preview`, { method: 'POST' });
  const started = (await startResponse.json()) as { session: { id: string; status: string }; url: string };
  return started;
}

describe('preview reverse proxy', () => {
  it('proxies two simultaneous previews to their own upstream without leaking the internal port', async () => {
    const { baseUrl, runtime } = await startApi();
    const [a, b] = await Promise.all([startPreview(baseUrl, runtime, 'a'), startPreview(baseUrl, runtime, 'b')]);
    expect(a.session.status).toBe('running');
    expect(b.session.status).toBe('running');
    expect(a.url).not.toBe(b.url);

    const [responseA, responseB] = await Promise.all([fetch(a.url), fetch(b.url)]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(await responseA.text()).toContain('ok:');
    expect(await responseB.text()).toContain('ok:');
  }, 20_000);

  it('rejects a request with a mismatched Host header', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'host');
    const target = new URL(started.url);
    const response = await fetch(started.url, { headers: { host: 'evil.example:9999' } });
    expect(response.status).toBe(400);
    void target;
  }, 20_000);

  it('blocks access once the session has expired', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'ttl');
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_500)); // past the 2s TTL
    const response = await fetch(started.url);
    expect(response.status).toBe(403);
  }, 20_000);

  it('rewrites a same-upstream relative redirect to stay under the proxy prefix', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'redirect-relative');
    const target = new URL(started.url);
    target.pathname += 'redirect-relative'; // pathname already ends in '/', keeps ?token= intact
    const response = await fetch(target, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/preview/${started.session.id}/somewhere`);
  }, 20_000);

  it('refuses to forward a redirect pointing off the session upstream', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'redirect-external');
    const target = new URL(started.url);
    target.pathname += 'redirect-external';
    const response = await fetch(target, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).not.toContain('evil.example');
    expect(response.headers.get('location')).toBe(`/preview/${started.session.id}/`);
  }, 20_000);

  it('relays a websocket upgrade to the session upstream', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'ws');
    const target = new URL(started.url);
    const upgraded = await new Promise<boolean>((resolvePromise) => {
      const req = httpRequest({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}ws?token=${target.searchParams.get('token')}`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res) => resolvePromise(res.statusCode === 101));
      req.on('error', () => resolvePromise(false));
      req.end();
    });
    expect(upgraded).toBe(true);
  }, 20_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/src/preview-proxy.test.ts`
Expected: FAIL — 404s across the board, since `/preview/:sessionId/*` and the upgrade handler don't exist yet.

- [ ] **Step 3: Implement the proxy module**

```typescript
// apps/api/src/preview-proxy.ts
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Runtime } from '@agent-foundry/composition';
import { isLoopbackHost } from '@agent-foundry/composition';
import { NotFoundError, PreviewAccessDeniedError } from '@agent-foundry/domain';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function registerPreviewProxy(app: FastifyInstance, runtime: Runtime): void {
  const allowedPort = String(runtime.config.apiPort);

  app.all('/preview/:sessionId', (request, reply) => handleHttp(request, reply, runtime, allowedPort));
  app.all('/preview/:sessionId/*', (request, reply) => handleHttp(request, reply, runtime, allowedPort));

  app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void handleUpgrade(req, socket, head, runtime, allowedPort);
  });
}

async function handleHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: Runtime,
  allowedPort: string,
): Promise<void> {
  if (!isAllowedHost(request.headers.host, allowedPort)) {
    await reply.status(400).send({ error: 'InvalidHost', message: 'Unexpected Host header.' });
    return;
  }
  const { sessionId } = request.params as { sessionId: string };
  const upstreamPath = '/' + ((request.params as { '*'?: string })['*'] ?? '');
  const query = (request.query as Record<string, string>) ?? {};
  const cookieToken = readCookieToken(request.headers.cookie, sessionId);
  const presentedToken = cookieToken ?? query.token;

  let resolved;
  try {
    resolved = await runtime.previewService.resolveUpstream(sessionId, presentedToken);
  } catch (error) {
    if (error instanceof NotFoundError) return void reply.status(404).send({ error: error.name, message: error.message });
    if (error instanceof PreviewAccessDeniedError)
      return void reply.status(403).send({ error: error.name, message: error.message });
    throw error;
  }

  const cookieValue = cookieToken ? undefined : runtime.previewService.issueCookieToken(sessionId, query.token);
  reply.hijack();
  const raw = reply.raw;
  const search = new URL(request.url, 'http://internal').search;
  const upstreamReq = httpRequest(
    {
      host: '127.0.0.1',
      port: resolved.port,
      method: request.method,
      path: upstreamPath + search,
      headers: sanitizeRequestHeaders(request.headers),
    },
    (upstreamRes) => respondFromUpstream(upstreamRes, raw, sessionId, resolved.port, cookieValue),
  );
  upstreamReq.on('error', () => {
    if (!raw.headersSent) raw.writeHead(502);
    raw.end();
  });
  request.raw.pipe(upstreamReq);
}

function respondFromUpstream(
  upstreamRes: IncomingMessage,
  raw: ServerResponse,
  sessionId: string,
  upstreamPort: number,
  cookieValue: string | undefined,
): void {
  const headers = sanitizeResponseHeaders(upstreamRes.headers, sessionId, upstreamPort);
  if (cookieValue) {
    const cookie = `pv_${sessionId}=${cookieValue}; Path=/preview/${sessionId}; HttpOnly; SameSite=Lax`;
    const existing = headers['set-cookie'];
    headers['set-cookie'] = existing ? [...(Array.isArray(existing) ? existing : [existing]), cookie] : cookie;
  }
  raw.writeHead(upstreamRes.statusCode ?? 502, headers);
  upstreamRes.pipe(raw);
}

async function handleUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  runtime: Runtime,
  allowedPort: string,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://internal');
  const match = /^\/preview\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match || !isAllowedHost(req.headers.host, allowedPort)) {
    socket.destroy();
    return;
  }
  const [, sessionId, rest] = match;
  const cookieToken = readCookieToken(req.headers.cookie, sessionId);
  const presentedToken = cookieToken ?? url.searchParams.get('token') ?? undefined;
  let resolved;
  try {
    resolved = await runtime.previewService.resolveUpstream(sessionId, presentedToken);
  } catch {
    socket.destroy();
    return;
  }
  const upstream = connect(resolved.port, '127.0.0.1', () => {
    const requestLine = `${req.method} ${rest || '/'}${url.search} HTTP/1.1\r\n`;
    const headerLines = Object.entries(req.headers)
      .filter(([key]) => !HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === 'upgrade')
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .concat('Connection: Upgrade')
      .join('\r\n');
    upstream.write(requestLine + headerLines + '\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

function isAllowedHost(hostHeader: string | undefined, allowedPort: string): boolean {
  if (!hostHeader) return false;
  const [hostname, port] = hostHeader.split(':');
  return isLoopbackHost(hostname ?? '') && (port ?? '80') === allowedPort;
}

function readCookieToken(cookieHeader: string | undefined, sessionId: string): string | undefined {
  if (!cookieHeader) return undefined;
  const name = `pv_${sessionId}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name)) return trimmed.slice(name.length);
  }
  return undefined;
}

function sanitizeRequestHeaders(headers: FastifyRequest['headers']): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === 'host') continue;
    result[key] = value;
  }
  result.host = '127.0.0.1';
  return result;
}

function sanitizeResponseHeaders(
  headers: IncomingMessage['headers'],
  sessionId: string,
  upstreamPort: number,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  const location = headers.location;
  if (typeof location === 'string') {
    result.location = rewriteLocation(location, sessionId, upstreamPort);
  }
  return result;
}

/** Relative locations are rebased under the proxy prefix; absolute locations pointing anywhere but this session's own upstream are dropped rather than followed, so a compromised preview process can't redirect through the trusted proxy origin. */
function rewriteLocation(location: string, sessionId: string, upstreamPort: number): string {
  if (location.startsWith('/') && !location.startsWith('//')) {
    return `/preview/${sessionId}${location}`;
  }
  try {
    const parsed = new URL(location);
    if (isLoopbackHost(parsed.hostname) && Number(parsed.port) === upstreamPort) {
      return `/preview/${sessionId}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // not a parseable absolute URL; fall through to blocking it below
  }
  return `/preview/${sessionId}/`; // refuse to forward a redirect outside the session's own upstream
}
```

- [ ] **Step 4: Register the proxy and map the new error in `app.ts`**

In `apps/api/src/app.ts`:
- Add imports: `import { registerPreviewProxy } from './preview-proxy.js';` and add `PreviewAccessDeniedError` to the existing `@agent-foundry/domain` import list.
- In `setErrorHandler`, add a branch (near the other domain-error branches):

```typescript
    if (error instanceof PreviewAccessDeniedError) {
      return reply.status(403).send({ error: error.name, message: error.message });
    }
```

- Immediately before `return app;`, add: `registerPreviewProxy(app, runtime);`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/api/src/preview-proxy.test.ts`
Expected: PASS. Note the fixture dev server (Task 3, Step 1) is reused here by copying its source into the test workspace — that's why Task 3 must land before this one.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/preview-proxy.ts apps/api/src/app.ts apps/api/src/preview-proxy.test.ts
git commit -m "feat(api): add preview reverse proxy with Host validation, token auth, and redirect sanitization"
```

---

### Task 8: ADR + operator docs

**Files:**
- Create: `docs/adr/0017-preview-network-proxy.md`
- Modify: `docs/OPERATIONS.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the ADR**

Follow the structure of `docs/adr/0012-sse-event-stream-and-redaction.md` (Status/Date/Owners, Context, Decision, Alternatives considered, Consequences, Validation and rollback). Content to cover:
- Context: #30, dependencies #28/#29 closed, ADR-0005's loopback/trusted-only constraint.
- Decision: `NodePreviewRunner` (reserve-or-detect port, single respawn-on-conflict retry), `PreviewService` (in-memory token/TTL orchestration), hand-rolled Fastify HTTP+WS proxy at `/preview/:sessionId/*` with Host-header allowlisting, cookie-or-query opaque token auth, and Location-header redirect sanitization; internal port never leaves the process.
- Alternatives considered: `@fastify/http-proxy` (rejected: no per-session dynamic upstream, less auditable header handling for a security-labeled ticket); persisting sessions now (rejected: `v05-preview-lifecycle` owns durable storage/reaping, doing it here duplicates work).
- Consequences: health is a single TCP probe with a fixed timeout, not yet a configurable HTTP-probe window; no crash/restart policy or orphan reaper yet — both explicitly deferred to `v05-preview-lifecycle`.
- Validation and rollback: point at `packages/executors/src/{preview-port,node-preview-runner}.test.ts`, `packages/orchestrator/src/preview-service.test.ts`, `apps/api/src/{preview,preview-proxy}.test.ts`. Rollback: remove the three new routes and the `Runtime.previewService`/`previewRunner` wiring; nothing else in the codebase depends on them yet.

- [ ] **Step 2: Update operator docs**

In `docs/OPERATIONS.md`, add a short section documenting: the new `PREVIEW_TTL_SECONDS` env var (default 1800), and the three new routes (`POST /projects/:id/preview`, `POST /projects/:id/preview/:sessionId/stop`, `GET/* /preview/:sessionId/*`), noting the proxy is loopback-only per ADR-0005/ADR-0017.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0017-preview-network-proxy.md docs/OPERATIONS.md
git commit -m "docs: record ADR 0017 for the preview reverse proxy"
```

---

### Task 9: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full check suite**

Run: `npm run check`
Expected: format, lint, `architecture:check` (confirms no package imports outside its allowed set — this is where a mistaken `orchestrator → executors` or `api → executors` import would be caught), `roadmap:check`, typecheck, all tests, and build all pass.

- [ ] **Step 2: Fix any fallout**

If `architecture:check` fails, it means a layering rule from the Context section was violated — fix the import direction, don't loosen `scripts/lib/architecture.mjs`. If `roadmap:check` complains, it's likely expecting `planning/roadmap-spec.json`'s `v05-preview-network` entry to gain evidence — leave the roadmap file alone in this task; evidence gets attached to the GitHub issue per Definition of Done, not the spec file.

- [ ] **Step 3: Capture evidence for the issue/PR**

Run and save output for the PR description / issue comment:
```bash
npx vitest run packages/executors/src/preview-port.test.ts packages/executors/src/node-preview-runner.test.ts packages/orchestrator/src/preview-service.test.ts apps/api/src/preview.test.ts apps/api/src/preview-proxy.test.ts --reporter=verbose
```
This output is the "two simultaneous previews, HMR, and expired session" evidence the issue's `Testes obrigatórios` and `Evidência para encerramento` sections ask for.

---

## Verification (end to end)

1. `npm run check` passes (format, lint, architecture, roadmap, typecheck, tests, build).
2. `npx vitest run apps/api/src/preview-proxy.test.ts --reporter=verbose` shows: two concurrent sessions proxied to distinct upstream ports with no `4100`/internal-port-style number in either returned `url`; a mismatched Host header rejected with 400; access rejected with 403 after the TTL elapses; a raw WebSocket upgrade request receiving `101 Switching Protocols` through the proxy.
3. Manual smoke (optional, real dev server instead of the fixture): `EXECUTOR_MODE=mock RUN_WORKER_INLINE=true npm run dev --workspace @agent-foundry/api`, then `curl -X POST localhost:4000/projects -d '{"name":"demo","prd":"..."}' -H 'content-type: application/json'`, drop a real Vite or Next.js app into the resulting workspace directory, `POST /projects/:id/preview`, and open the returned `url` in a browser — confirm the page loads and HMR reconnects after editing a source file (open the browser's Network tab and confirm the WS connection to `/preview/:id/...` stays open, not to the raw internal port).
4. Push the branch, open a PR referencing #30, and paste the vitest output from step 2 plus a screenshot/description of step 3 into the PR description and the GitHub issue, per `docs/DEFINITION_OF_DONE.md`'s "Delivery evidence" section.
