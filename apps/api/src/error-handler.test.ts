import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

function buildFakeRuntime(projectService: Record<string, unknown> = {}): Runtime {
  return {
    config: { webOrigin: 'http://localhost:3000' },
    projectService,
  } as unknown as Runtime;
}

function levelLines(lines: string[]): string {
  return lines
    .filter((line) => line.includes('"level":40') || line.includes('"level":50'))
    .join('');
}

describe('error handler', () => {
  it('400s a malformed JSON body instead of reporting a server error', async () => {
    const app = await buildApp(buildFakeRuntime());

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/json' },
      payload: 'not json',
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(Object.keys(response.json() as object).sort()).toEqual(['error', 'message']);
    await app.close();
  });

  it('413s a body over the body limit', async () => {
    const app = await buildApp(buildFakeRuntime());

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ prompt: 'x'.repeat(1_000_001) }),
    });

    expect(response.statusCode, response.body).toBe(413);
    await app.close();
  });

  it('415s an unsupported media type', async () => {
    const app = await buildApp(buildFakeRuntime());

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/xml' },
      payload: '<prompt/>',
    });

    expect(response.statusCode, response.body).toBe(415);
    await app.close();
  });

  it('still 500s a thrown non-Fastify error', async () => {
    const app = await buildApp(
      buildFakeRuntime({ getDraft: vi.fn().mockRejectedValue(new Error('boom')) }),
    );

    const response = await app.inject({ method: 'GET', url: '/runs/run-1/draft' });

    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toEqual({ error: 'Error', message: 'boom' });
    await app.close();
  });

  it('logs client errors at warn and server errors at error', async () => {
    const lines: string[] = [];
    const app = await buildApp(
      buildFakeRuntime({ getDraft: vi.fn().mockRejectedValue(new Error('boom')) }),
      { loggerStream: { write: (message) => lines.push(message) } },
    );

    await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/json' },
      payload: 'not json',
    });
    const clientLog = levelLines(lines);
    expect(clientLog, lines.join('')).toContain('"level":40');
    expect(clientLog).not.toContain('"level":50');
    expect(clientLog).not.toContain('"stack"');
    expect(clientLog).toContain('400');

    lines.length = 0;
    await app.inject({ method: 'GET', url: '/runs/run-1/draft' });
    const serverLog = levelLines(lines);
    expect(serverLog, lines.join('')).toContain('"level":50');
    expect(serverLog).not.toContain('"level":40');
    await app.close();
  });
});
