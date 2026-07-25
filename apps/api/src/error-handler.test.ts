import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '@agent-foundry/composition';
import { BODY_LIMIT_BYTES, buildApp } from './app.js';

const opened: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

async function open(
  projectService: Record<string, unknown> = {},
  lines?: string[],
): Promise<FastifyInstance> {
  const runtime = {
    config: { webOrigin: 'http://localhost:3000' },
    projectService,
  } as unknown as Runtime;
  const app = await buildApp(
    runtime,
    lines ? { loggerStream: { write: (message) => lines.push(message) } } : {},
  );
  opened.push(app);
  return app;
}

function logEntries(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('error handler', () => {
  it.each([
    ['a malformed JSON body', 'application/json', 'not json', 400],
    ['a body over the body limit', 'application/json', 'x'.repeat(BODY_LIMIT_BYTES + 1), 413],
    ['an unsupported media type', 'application/xml', '<prompt/>', 415],
  ])('answers %s with %i, not a server error', async (_case, contentType, payload, expected) => {
    const app = await open();

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(response.statusCode, response.body).toBe(expected);
    expect(Object.keys(response.json() as object).sort()).toEqual(['error', 'message']);
  });

  it('reports the Fastify error code as the discriminator', async () => {
    const app = await open();

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/json' },
      payload: 'not json',
    });

    expect(response.json()).toMatchObject({ error: 'FST_ERR_CTP_INVALID_JSON_BODY' });
  });

  it('still 500s a thrown non-Fastify error', async () => {
    const app = await open({ getDraft: vi.fn().mockRejectedValue(new Error('boom')) });

    const response = await app.inject({ method: 'GET', url: '/runs/run-1/draft' });

    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toEqual({ error: 'Error', message: 'boom' });
  });

  it('logs client errors at warn and server errors at error', async () => {
    const lines: string[] = [];
    const app = await open({ getDraft: vi.fn().mockRejectedValue(new Error('boom')) }, lines);

    await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/json' },
      payload: 'not json',
    });
    const clientLog = logEntries(lines).find((entry) => entry.statusCode === 400);
    expect(clientLog).toMatchObject({ level: 40, code: 'FST_ERR_CTP_INVALID_JSON_BODY' });
    expect(clientLog).not.toHaveProperty('err');

    lines.length = 0;
    await app.inject({ method: 'GET', url: '/runs/run-1/draft' });
    const serverLog = logEntries(lines).find((entry) => entry.level === 50);
    expect(serverLog).toBeDefined();
  });
});
