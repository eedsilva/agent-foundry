import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Message } from '@agent-foundry/contracts';
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
  const dataDir = existingDir ?? (await mkdtemp(join(tmpdir(), 'agent-foundry-conversation-')));
  if (!existingDir) dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
  });
  const app = await buildApp(runtime);
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, runtime, baseUrl, dataDir };
}

async function createProject(runtime: Runtime, name = 'Conversation API'): Promise<string> {
  return (
    await runtime.projectService.create({
      name,
      prd: 'Persist ordered conversation data through the public API with safe replay and export.',
      workflowId: 'web-app-v1',
    })
  ).id;
}

function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createMessage(baseUrl: string, projectId: string, text: string): Promise<Message> {
  const response = await post(baseUrl, `/projects/${projectId}/conversation/messages`, {
    role: 'user',
    content: [{ type: 'text', text }],
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { message: Message }).message;
}

async function readMessageSse(
  url: string,
  headers: Record<string, string>,
  count: number,
): Promise<{ messages: Message[]; ids: number[]; abort: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const response = await fetch(url, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const messages: Message[] = [];
  const ids: number[] = [];
  try {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (messages.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n');
        const id = lines.find((line) => line.startsWith('id:'));
        const data = lines.find((line) => line.startsWith('data:'));
        if (id && data) {
          ids.push(Number(id.slice(3).trim()));
          messages.push(JSON.parse(data.slice(5).trim()) as Message);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { messages, ids, abort: () => controller.abort() };
}

async function listMessagePages(baseUrl: string, projectId: string): Promise<Message[]> {
  const messages: Message[] = [];
  let cursor = 0;
  for (;;) {
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/conversation?limit=200&cursor=${cursor}`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as { messages: Message[]; nextCursor: number | null };
    messages.push(...page.messages);
    if (page.nextCursor === null) return messages;
    cursor = page.nextCursor;
  }
}

async function seedMessages(dataDir: string, projectId: string, count: number): Promise<void> {
  const root = join(dataDir, 'projects', projectId, 'conversation');
  await mkdir(root, { recursive: true });
  const messages = Array.from({ length: count }, (_, index): Message => {
    const sequence = index + 1;
    return {
      id: `message-${sequence}`,
      projectId,
      conversationId: projectId,
      role: 'user',
      content: [{ type: 'text', text: `message ${sequence}` }],
      sequence,
      createdAt: '2026-07-17T12:00:00.000Z',
    };
  });
  await writeFile(
    join(root, 'messages.jsonl'),
    `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    'utf8',
  );
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('conversation API', () => {
  it('creates attachments and messages and rejects invalid input', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);

    const attachmentResponse = await post(
      baseUrl,
      `/projects/${projectId}/conversation/attachments`,
      {
        kind: 'image',
        name: 'wireframe.png',
        mediaType: 'image/png',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
      },
    );
    expect(attachmentResponse.status).toBe(201);
    const { attachment } = (await attachmentResponse.json()) as { attachment: { id: string } };

    const messageResponse = await post(baseUrl, `/projects/${projectId}/conversation/messages`, {
      role: 'user',
      content: [{ type: 'attachment', attachmentId: attachment.id }],
    });
    expect(messageResponse.status).toBe(201);

    const pageResponse = await fetch(`${baseUrl}/projects/${projectId}/conversation`);
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.json()).toMatchObject({
      conversation: { id: projectId, projectId },
      messages: [{ sequence: 1 }],
      attachments: [{ id: attachment.id }],
      nextCursor: null,
    });

    const invalid = await post(baseUrl, `/projects/${projectId}/conversation/messages`, {
      role: 'user',
      content: [{ type: 'text', text: '' }],
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as object).toMatchObject({ error: 'ValidationError' });
    expect((await fetch(`${baseUrl}/projects/${projectId}/conversation?cursor=-1`)).status).toBe(
      400,
    );
  });

  it('denies attachment references from another project', async () => {
    const { baseUrl, runtime } = await startApi();
    const localId = await createProject(runtime, 'Local');
    const foreignId = await createProject(runtime, 'Foreign');
    const response = await post(baseUrl, `/projects/${foreignId}/conversation/attachments`, {
      kind: 'file',
      mediaType: 'text/plain',
      sha256: 'b'.repeat(64),
      sizeBytes: 10,
    });
    const { attachment } = (await response.json()) as { attachment: { id: string } };

    const denied = await post(baseUrl, `/projects/${localId}/conversation/messages`, {
      role: 'user',
      content: [{ type: 'attachment', attachmentId: attachment.id }],
    });

    expect(denied.status).toBe(400);
    expect((await denied.json()) as object).toMatchObject({ error: 'ValidationError' });
  });

  it('rejects parameterized attachment media types before persistence and export', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);

    const response = await post(baseUrl, `/projects/${projectId}/conversation/attachments`, {
      kind: 'file',
      mediaType: 'text/plain; token=raw-secret',
      sha256: 'f'.repeat(64),
      sizeBytes: 10,
    });
    expect(response.status).toBe(400);
    expect(await runtime.conversations.listAttachments(projectId)).toEqual([]);

    const exported = await fetch(`${baseUrl}/projects/${projectId}/export`);
    const body = await exported.text();
    expect(exported.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ attachments: [] });
    expect(body).not.toContain('raw-secret');
  });

  it('returns concurrent messages in stable cursor pages', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createMessage(baseUrl, projectId, `message ${index}`),
      ),
    );

    const first = await fetch(`${baseUrl}/projects/${projectId}/conversation?limit=2&cursor=0`);
    const firstPage = (await first.json()) as { messages: Message[]; nextCursor: number };
    const second = await fetch(
      `${baseUrl}/projects/${projectId}/conversation?limit=3&cursor=${firstPage.nextCursor}`,
    );
    const secondPage = (await second.json()) as { messages: Message[]; nextCursor: null };

    expect(firstPage.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(firstPage.nextCursor).toBe(2);
    expect(secondPage.messages.map((message) => message.sequence)).toEqual([3, 4, 5]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('collapses concurrent operation retries and returns 409 for conflicting reuse', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    const message = await createMessage(baseUrl, projectId, 'Build it');
    const path = `/projects/${projectId}/conversation/messages/${message.id}/operations`;
    const input = {
      kind: 'explain',
      idempotencyKey: 'c'.repeat(64),
      artifactReferences: [],
    };

    const retries = await Promise.all([post(baseUrl, path, input), post(baseUrl, path, input)]);
    expect(retries.map((response) => response.status)).toEqual([201, 201]);
    const operations = await Promise.all(
      retries.map(
        async (response) => ((await response.json()) as { operation: { id: string } }).operation,
      ),
    );
    expect(operations[0]).toEqual(operations[1]);

    const conflict = await post(baseUrl, path, { ...input, kind: 'repair' });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as object).toMatchObject({
      error: 'IdempotencyConflictError',
    });
  });

  it('exports the complete aggregate after redacting secrets before writing', async () => {
    const { baseUrl, runtime, dataDir } = await startApi();
    const projectId = await createProject(runtime);
    await post(baseUrl, `/projects/${projectId}/conversation/attachments`, {
      kind: 'file',
      name: 'authorization=raw-attachment-secret',
      mediaType: 'text/plain',
      sha256: 'd'.repeat(64),
      sizeBytes: 12,
    });
    const messageResponse = await post(baseUrl, `/projects/${projectId}/conversation/messages`, {
      role: 'user',
      content: [
        { type: 'text', text: 'token=raw-message-secret' },
        { type: 'data', value: { password: 'raw-data-secret' } },
      ],
    });
    const { message } = (await messageResponse.json()) as { message: Message };
    await post(baseUrl, `/projects/${projectId}/conversation/messages/${message.id}/operations`, {
      kind: 'explain',
      idempotencyKey: 'e'.repeat(64),
      artifactReferences: [],
    });

    const response = await fetch(`${baseUrl}/projects/${projectId}/export`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      schemaVersion: '1',
      project: { id: projectId },
      conversation: { projectId },
      messages: [{ sequence: 1 }],
      attachments: [{ projectId }],
      operations: [{ messageId: message.id, kind: 'explain' }],
    });
    expect(body).not.toMatch(/raw-(attachment|message|data)-secret/);

    const root = join(dataDir, 'projects', projectId, 'conversation');
    const persisted = await Promise.all(
      ['messages.jsonl', 'attachments.jsonl'].map((name) => readFile(join(root, name), 'utf8')),
    );
    expect(persisted.join('\n')).not.toMatch(/raw-(attachment|message|data)-secret/);
  });

  it('replays stored messages after reconnect and restart without duplicates', async () => {
    const first = await startApi();
    const projectId = await createProject(first.runtime);
    await Promise.all([1, 2].map((index) => createMessage(first.baseUrl, projectId, `m${index}`)));

    const stream = `${first.baseUrl}/projects/${projectId}/conversation/stream`;
    const firstRead = await readMessageSse(stream, {}, 2);
    firstRead.abort();
    const lastSequence = firstRead.ids.at(-1)!;
    await Promise.all(
      [3, 4, 5].map((index) => createMessage(first.baseUrl, projectId, `m${index}`)),
    );

    await first.app.close();
    const second = await startApi(first.dataDir);
    const secondRead = await readMessageSse(
      `${second.baseUrl}/projects/${projectId}/conversation/stream`,
      { 'last-event-id': String(lastSequence) },
      3,
    );
    secondRead.abort();

    const stored = await second.runtime.conversationService.listMessages(projectId);
    expect([...firstRead.messages, ...secondRead.messages].map((message) => message.id)).toEqual(
      stored.map((message) => message.id),
    );
    expect([...firstRead.ids, ...secondRead.ids]).toEqual([1, 2, 3, 4, 5]);
    expect(new Set([...firstRead.ids, ...secondRead.ids]).size).toBe(5);
  });

  it('prefers the query cursor to Last-Event-ID', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    await Promise.all([1, 2, 3].map((index) => createMessage(baseUrl, projectId, `m${index}`)));

    const read = await readMessageSse(
      `${baseUrl}/projects/${projectId}/conversation/stream?cursor=1`,
      { 'last-event-id': '0' },
      2,
    );
    read.abort();

    expect(read.ids).toEqual([2, 3]);
  });

  it('replays beyond one 500-message batch exactly across reconnect and HTTP pages', async () => {
    const { baseUrl, runtime, dataDir } = await startApi();
    const projectId = await createProject(runtime);
    await seedMessages(dataDir, projectId, 503);

    const stream = `${baseUrl}/projects/${projectId}/conversation/stream`;
    const first = await readMessageSse(stream, {}, 500);
    first.abort();
    const second = await readMessageSse(stream, { 'last-event-id': String(first.ids.at(-1)!) }, 3);
    second.abort();

    const expected = await listMessagePages(baseUrl, projectId);
    const combined = [...first.messages, ...second.messages];
    expect(combined.map((message) => message.sequence)).toEqual(
      expected.map((message) => message.sequence),
    );
    expect(combined.map((message) => message.id)).toEqual(expected.map((message) => message.id));
    expect(new Set(combined.map((message) => message.sequence)).size).toBe(503);
  });

  it('starts a plan operation, blocks an ungated build, and allows an explicit direct build', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    const message = await createMessage(baseUrl, projectId, 'Add a dark mode toggle');
    const opsPath = `/projects/${projectId}/conversation/messages/${message.id}/operations`;

    const planResponse = await post(baseUrl, opsPath, { kind: 'plan' });
    expect(planResponse.status).toBe(201);
    const { operation: plan } = (await planResponse.json()) as {
      operation: { id: string; runId: string };
    };
    expect(plan.runId).toBeDefined();

    const ungatedBuild = await post(baseUrl, opsPath, { kind: 'build' });
    expect(ungatedBuild.status).toBe(400);

    const decideBeforeCompletion = await post(
      baseUrl,
      `/projects/${projectId}/conversation/operations/${plan.id}/decide`,
      { action: 'approve' },
    );
    expect(decideBeforeCompletion.status).toBe(400);

    const directBuild = await post(baseUrl, opsPath, { kind: 'build', directExecution: true });
    expect(directBuild.status).toBe(201);
    const { operation: build } = (await directBuild.json()) as {
      operation: { directExecution: boolean };
    };
    expect(build.directExecution).toBe(true);
  });

  it('still routes non plan/build kinds through the original create-operation path', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    const message = await createMessage(baseUrl, projectId, 'Explain the auth flow');

    const response = await post(
      baseUrl,
      `/projects/${projectId}/conversation/messages/${message.id}/operations`,
      { kind: 'explain', idempotencyKey: 'f'.repeat(64), artifactReferences: [] },
    );

    expect(response.status).toBe(201);
    const { operation } = (await response.json()) as {
      operation: { kind: string; runId?: string };
    };
    expect(operation.kind).toBe('explain');
    expect(operation.runId).toBeUndefined();
  });
});
