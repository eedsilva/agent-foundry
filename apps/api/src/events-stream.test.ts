import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentStreamEvent, ProjectEvent } from '@agent-foundry/contracts';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

interface StartedApi {
  app: FastifyInstance;
  runtime: Runtime;
  baseUrl: string;
  dataDir: string;
}

async function startApi(existingDir?: string): Promise<StartedApi> {
  const dataDir = existingDir ?? (await mkdtemp(join(tmpdir(), 'agent-foundry-sse-')));
  if (!existingDir) dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'events-stream-worker',
  });
  const app = await buildApp(runtime);
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, runtime, baseUrl, dataDir };
}

async function createProject(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'SSE sample', prd: 'x'.repeat(60) }),
  });
  expect(response.status).toBe(202);
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

// Reads SSE frames until `minEvents` data events are collected (or the timeout
// aborts). Leaves the connection open; the caller aborts it to disconnect.
async function readSse<T = ProjectEvent>(
  url: string,
  headers: Record<string, string>,
  minEvents: number,
  timeoutMs = 10_000,
): Promise<{ events: T[]; abort: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events: T[] = [];
  const abort = (): void => controller.abort();
  try {
    if (response.body && minEvents > 0) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (events.length < minEvents) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (dataLine) events.push(JSON.parse(dataLine.slice('data:'.length).trim()) as T);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { events, abort };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GET /projects/:projectId/events/stream', () => {
  it('404s for unknown project before streaming', async () => {
    const { baseUrl } = await startApi();
    const response = await fetch(`${baseUrl}/projects/does-not-exist/events/stream`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('NotFoundError');
  });

  it('replays mid-run, reconnects without duplicates, and survives an API restart', async () => {
    const first = await startApi();
    const projectId = await createProject(first.baseUrl);
    const streamUrl = `${first.baseUrl}/projects/${projectId}/events/stream`;

    // Start the run without awaiting, then read the first slice mid-run.
    const runPromise = first.runtime.worker.runOnce();
    runPromise.catch(() => undefined); // avoid an unhandled rejection if an assertion aborts early
    const { events: firstBatch, abort: abortFirst } = await readSse(streamUrl, {}, 5);
    abortFirst();
    const lastId = firstBatch.at(-1)!.id;

    // Run completes while the client is disconnected.
    expect(await runPromise).toBe(true);

    // Restart the API: close app #1, build a fresh runtime + app over the same DATA_DIR.
    await first.app.close();
    apps.length = 0;
    const second = await startApi(first.dataDir);

    const fullIds = (await second.runtime.events.list(projectId, 1_000)).map((event) => event.id);
    const remainder = fullIds.length - firstBatch.length;
    const { events: secondBatch, abort: abortSecond } = await readSse(
      `${second.baseUrl}/projects/${projectId}/events/stream`,
      { 'last-event-id': lastId },
      remainder,
    );
    abortSecond();

    const firstIds = firstBatch.map((event) => event.id);
    const secondIds = secondBatch.map((event) => event.id);
    // No duplicates: everything replayed is strictly after the disconnect point.
    expect(secondIds.every((id) => id > lastId)).toBe(true);
    // Replay is complete and ordered across the reconnect + restart.
    expect([...firstIds, ...secondIds]).toEqual(fullIds);
  });

  it('accepts ?cursor= as an alternative to Last-Event-ID', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    expect(await runtime.worker.runOnce()).toBe(true);

    const fullIds = (await runtime.events.list(projectId, 1_000)).map((event) => event.id);
    expect(fullIds.length).toBeGreaterThan(3);
    const cursor = fullIds[2]!;
    const tail = fullIds.slice(3);

    const { events, abort } = await readSse(
      `${baseUrl}/projects/${projectId}/events/stream?cursor=${cursor}`,
      {},
      tail.length,
    );
    abort();
    expect(events.map((event) => event.id)).toEqual(tail);
  });
});

describe('GET /runs/:runId/events/stream', () => {
  it('streams run events and recovers missed events by cursor on reconnect', async () => {
    const { baseUrl, runtime } = await startApi();
    const runId = 'run-stream-test';
    await runtime.stepEvents.append({
      id: 'evt-1',
      runId,
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      createdAt: new Date().toISOString(),
      type: 'status',
      phase: 'started',
    });

    const { events: first, abort: abortFirst } = await readSse<AgentStreamEvent>(
      `${baseUrl}/runs/${runId}/events/stream`,
      {},
      1,
    );
    abortFirst();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'status', phase: 'started', sequence: 1 });

    await runtime.stepEvents.append({
      id: 'evt-2',
      runId,
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      createdAt: new Date().toISOString(),
      type: 'assistant_delta',
      text: 'Hello',
    });

    const { events: afterCursor, abort: abortSecond } = await readSse<AgentStreamEvent>(
      `${baseUrl}/runs/${runId}/events/stream?cursor=1`,
      {},
      1,
    );
    abortSecond();
    expect(afterCursor).toHaveLength(1);
    expect(afterCursor[0]).toMatchObject({ type: 'assistant_delta', text: 'Hello', sequence: 2 });
  });

  it('recovers a tool_end missed while disconnected mid-tool-call, with no duplicate tool_start', async () => {
    const { baseUrl, runtime } = await startApi();
    const runId = 'run-reconnect-test';
    const stepRunId = 'step-1';
    const attemptId = 'attempt-1';

    await runtime.stepEvents.append({
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
    // exactly what the first readSse call already simulates: open,
    // collect available frames, close).
    const { events: beforeDisconnect, abort: abortFirst } = await readSse<AgentStreamEvent>(
      `${baseUrl}/runs/${runId}/events/stream`,
      {},
      1,
    );
    abortFirst();
    expect(beforeDisconnect).toHaveLength(1);
    expect(beforeDisconnect[0]).toMatchObject({ type: 'tool_start', sequence: 1 });
    const lastSeenSequence = beforeDisconnect[0]!.sequence as number;

    // While disconnected, the tool finishes.
    await runtime.stepEvents.append({
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
    const { events: afterReconnect, abort: abortSecond } = await readSse<AgentStreamEvent>(
      `${baseUrl}/runs/${runId}/events/stream?cursor=${lastSeenSequence}`,
      {},
      1,
    );
    abortSecond();

    expect(afterReconnect).toHaveLength(1);
    expect(afterReconnect[0]).toMatchObject({ type: 'tool_end', ok: true, sequence: 2 });
    expect(afterReconnect.some((event: AgentStreamEvent) => event.type === 'tool_start')).toBe(
      false,
    );
  });
});
