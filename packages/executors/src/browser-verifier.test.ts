import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ArtifactReference,
  BrowserTestPlan,
  PreviewSessionReference,
} from '@agent-foundry/contracts';
import { PlaywrightBrowserVerifier } from './browser-verifier.js';

const TOKEN = 'preview-token-that-must-never-leak';
const PLAN_ARTIFACT: ArtifactReference = {
  name: 'browser-test-plan',
  revision: 1,
  sha256: 'a'.repeat(64),
};
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function session(origin: string): PreviewSessionReference {
  return {
    sessionId: 'preview-1',
    status: 'running',
    url: `${origin}/preview/preview-1/?token=${TOKEN}`,
    evidence: { screenshots: [] },
  };
}

function artifact(plan: BrowserTestPlan): unknown {
  return {
    schemaVersion: '1',
    status: 'completed',
    summary: plan.title,
    data: plan,
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  };
}

function plan(steps: BrowserTestPlan['steps']): BrowserTestPlan {
  return {
    schemaVersion: '1',
    id: 'fixture-plan',
    title: 'Fixture browser plan',
    viewport: { width: 900, height: 600 },
    steps,
  };
}

async function verify(
  origin: string,
  browserPlan: BrowserTestPlan,
  options: { allowedOrigins?: string[]; signal?: AbortSignal } = {},
) {
  return new PlaywrightBrowserVerifier().verify(
    {
      planArtifact: PLAN_ARTIFACT,
      planContent: artifact(browserPlan),
      session: session(origin),
      allowedOrigins: options.allowedOrigins ?? [],
    },
    options.signal ?? new AbortController().signal,
  );
}

function expectRedacted(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(TOKEN);
}

describe('PlaywrightBrowserVerifier', () => {
  it('executes a declarative create/update/delete plan in real Chromium', async () => {
    const requests: string[] = [];
    const origin = await serve((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('content-type', 'text/html');
      if (request.url?.startsWith('/preview/preview-1/items')) {
        response.end(`<!doctype html>
          <label>Name <input aria-label="Name"></label>
          <button>Create</button><button>Update</button><button>Delete</button>
          <div data-testid="item-row" hidden></div>
          <script>
            const input = document.querySelector('input');
            const row = document.querySelector('[data-testid=item-row]');
            document.querySelector('button:nth-of-type(1)').onclick = () => { row.hidden = false; row.textContent = input.value; };
            document.querySelector('button:nth-of-type(2)').onclick = () => { row.textContent = input.value; };
            document.querySelector('button:nth-of-type(3)').onclick = () => { row.hidden = true; row.textContent = ''; };
          </script>`);
        return;
      }
      response.end('<h1>Done</h1>');
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open items',
          action: { kind: 'goto', path: '/items' },
          assertions: [
            { kind: 'url', path: '/items' },
            { kind: 'visible', locator: { kind: 'label', text: 'Name' } },
          ],
        },
        {
          id: 'name-created',
          title: 'Enter created name',
          action: {
            kind: 'fill',
            locator: { kind: 'label', text: 'Name' },
            value: 'Created item',
          },
          assertions: [],
        },
        {
          id: 'create',
          title: 'Create item',
          action: { kind: 'click', locator: { kind: 'role', role: 'button', name: 'Create' } },
          assertions: [
            {
              kind: 'containsText',
              locator: { kind: 'testId', testId: 'item-row' },
              text: 'Created item',
            },
          ],
        },
        {
          id: 'name-updated',
          title: 'Enter updated name',
          action: {
            kind: 'fill',
            locator: { kind: 'label', text: 'Name' },
            value: 'Updated item',
          },
          assertions: [],
        },
        {
          id: 'update',
          title: 'Update item',
          action: { kind: 'click', locator: { kind: 'text', text: 'Update' } },
          assertions: [
            {
              kind: 'containsText',
              locator: { kind: 'testId', testId: 'item-row' },
              text: 'Updated item',
            },
          ],
        },
        {
          id: 'delete',
          title: 'Delete item',
          action: { kind: 'click', locator: { kind: 'text', text: 'Delete' } },
          assertions: [{ kind: 'hidden', locator: { kind: 'testId', testId: 'item-row' } }],
        },
        {
          id: 'open-done',
          title: 'Open another plan path',
          action: { kind: 'goto', path: '/done' },
          assertions: [
            { kind: 'visible', locator: { kind: 'role', role: 'heading', name: 'Done' } },
            { kind: 'url', path: '/done' },
          ],
        },
      ]),
    );

    expect(report.approved).toBe(true);
    expect(report.steps.map(({ status }) => status)).toEqual(Array(7).fill('passed'));
    expect(requests[0]).toContain(`token=${TOKEN}`);
    expect(requests.at(-1)).toBe('/preview/preview-1/done');
    expectRedacted(report);
  });

  it('fails a missing locator and skips every later step', async () => {
    const origin = await serve((_request, response) => response.end('<h1>Fixture</h1>'));
    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
        {
          id: 'missing',
          title: 'Click missing button',
          action: { kind: 'click', locator: { kind: 'text', text: 'Missing' } },
          assertions: [],
        },
        {
          id: 'later',
          title: 'Never execute this step',
          action: { kind: 'goto', path: '/later' },
          assertions: [],
        },
      ]),
    );

    expect(report.approved).toBe(false);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'failed', 'skipped']);
    expect(report.steps[1]?.error).toContain('Missing');
    expect(report.steps[2]?.durationMs).toBe(0);
    expectRedacted(report);
  }, 15_000);

  it('rejects HTTP errors, console errors, and uncaught exceptions as passive failures', async () => {
    const origin = await serve((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.statusCode = 500;
      response.end(
        `<script>console.error('fixture console failure ${TOKEN}'); throw new Error('fixture page failure ${TOKEN}')</script>`,
      );
    });
    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open broken fixture',
          action: { kind: 'goto', path: '/broken' },
          assertions: [],
        },
      ]),
    );

    expect(report.approved).toBe(false);
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.observations.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['http-error', 'console-error', 'uncaught-exception']),
    );
    expectRedacted(report);
  });

  it('blocks forbidden-origin HTTP and WebSocket traffic before the sentinel receives it', async () => {
    let sentinelRequests = 0;
    let sentinelUpgrades = 0;
    const forbiddenOrigin = await serve((_request, response) => {
      sentinelRequests += 1;
      response.end('forbidden');
    });
    servers.at(-1)!.on('upgrade', (_request, socket) => {
      sentinelUpgrades += 1;
      socket.destroy();
    });
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<img src="${forbiddenOrigin}/sentinel">
        <h1>Fixture</h1>
        <script>
          new WebSocket('${forbiddenOrigin.replace('http:', 'ws:')}/sentinel');
        </script>`);
    });
    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [
            { kind: 'visible', locator: { kind: 'role', role: 'heading', name: 'Fixture' } },
          ],
        },
      ]),
    );

    expect(sentinelRequests).toBe(0);
    expect(sentinelUpgrades).toBe(0);
    expect(report.approved).toBe(false);
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.observations.some(({ kind }) => kind === 'policy-block')).toBe(true);
    expect(
      report.steps[0]?.observations.some(
        ({ kind, url }) => kind === 'policy-block' && url?.startsWith('ws:'),
      ),
    ).toBe(true);
    expectRedacted(report);
  });

  it('permits a normalized allowed origin but blocks same-origin paths outside the preview prefix', async () => {
    let allowedRequests = 0;
    const allowedOrigin = await serve((_request, response) => {
      allowedRequests += 1;
      response.end('allowed');
    });
    let outsidePrefixRequests = 0;
    let origin = '';
    origin = await serve((request, response) => {
      if (request.url === '/outside-prefix') {
        outsidePrefixRequests += 1;
        response.end('outside');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`<img src="${allowedOrigin}/asset"><img src="${origin}/outside-prefix">`);
    });
    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
      ]),
      { allowedOrigins: [allowedOrigin] },
    );

    expect(allowedRequests).toBe(1);
    expect(outsidePrefixRequests).toBe(0);
    expect(report.approved).toBe(false);
    expect(
      report.steps[0]?.observations.filter(({ kind }) => kind === 'policy-block'),
    ).toHaveLength(1);
  });

  it('fails closed when the supplied preview URL does not match the session prefix', async () => {
    let requests = 0;
    const origin = await serve((_request, response) => {
      requests += 1;
      response.end('<h1>Untrusted prefix</h1>');
    });
    const browserPlan = plan([
      {
        id: 'open',
        title: 'Open fixture',
        action: { kind: 'goto', path: '/' },
        assertions: [],
      },
    ]);

    const report = await new PlaywrightBrowserVerifier().verify(
      {
        planArtifact: PLAN_ARTIFACT,
        planContent: artifact(browserPlan),
        session: {
          ...session(origin),
          url: `${origin}/untrusted-prefix/?token=${TOKEN}`,
        },
        allowedOrigins: [],
      },
      new AbortController().signal,
    );

    expect(requests).toBe(0);
    expect(report.approved).toBe(false);
    expect(report.planValidationError).toMatch(/preview.*prefix/i);
    expect(report.steps).toEqual([]);
    expectRedacted(report);
  });

  it('fails closed on a path-bearing allowed-origin entry', async () => {
    let allowedRequests = 0;
    const allowedOrigin = await serve((_request, response) => {
      allowedRequests += 1;
      response.end('sentinel');
    });
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<img src="${allowedOrigin}/sentinel">`);
    });
    const browserPlan = plan([
      {
        id: 'open',
        title: 'Open fixture',
        action: { kind: 'goto', path: '/' },
        assertions: [],
      },
    ]);

    const report = await verify(origin, browserPlan, {
      allowedOrigins: [`${allowedOrigin}/broadened/path`],
    });

    expect(allowedRequests).toBe(0);
    expect(report.approved).toBe(false);
    expect(report.planValidationError).toMatch(/allowed origin/i);
    expect(report.steps).toEqual([]);
  });

  it('records a delayed HTTP failure triggered by the final action', async () => {
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/late-failure') {
        response.statusCode = 500;
        response.end('late failure');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        `<h1>Fixture</h1><button onclick="fetch('/preview/preview-1/late-failure')">Trigger failure</button>`,
      );
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [{ kind: 'visible', locator: { kind: 'role', role: 'heading' } }],
        },
        {
          id: 'trigger',
          title: 'Trigger failure',
          action: { kind: 'click', locator: { kind: 'text', text: 'Trigger failure' } },
          assertions: [],
        },
      ]),
    );

    expect(report.approved).toBe(false);
    expect(report.steps[1]?.observations.some(({ kind }) => kind === 'http-error')).toBe(true);
  });

  it('auto-waits for asynchronous text content', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<div data-testid="status">Pending</div><script>
        setTimeout(() => document.querySelector('[data-testid=status]').textContent = 'Ready', 100);
      </script>`);
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [
            {
              kind: 'containsText',
              locator: { kind: 'testId', testId: 'status' },
              text: 'Ready',
            },
          ],
        },
      ]),
    );

    expect(report.approved).toBe(true);
    expect(report.steps[0]?.status).toBe('passed');
  });

  it('auto-waits for an asynchronous URL change', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<h1>Fixture</h1><script>
        setTimeout(() => history.pushState({}, '', '/preview/preview-1/ready'), 100);
      </script>`);
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [{ kind: 'url', path: '/ready' }],
        },
      ]),
    );

    expect(report.approved).toBe(true);
    expect(report.steps[0]?.status).toBe('passed');
  });

  it('blocks a redirect to a forbidden origin before the sentinel receives it', async () => {
    let sentinelRequests = 0;
    const forbiddenOrigin = await serve((_request, response) => {
      sentinelRequests += 1;
      response.end('sentinel');
    });
    const origin = await serve((request, response) => {
      if (request.url?.startsWith('/preview/preview-1/redirect')) {
        response.statusCode = 302;
        response.setHeader('location', `${forbiddenOrigin}/sentinel`);
      }
      response.end();
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Follow redirect',
          action: { kind: 'goto', path: '/redirect' },
          assertions: [],
        },
      ]),
    );

    expect(sentinelRequests).toBe(0);
    expect(report.approved).toBe(false);
    expect(report.steps[0]?.observations.some(({ kind }) => kind === 'policy-block')).toBe(true);
  });

  it('blocks a forbidden popup navigation before the sentinel receives it', async () => {
    let sentinelRequests = 0;
    const forbiddenOrigin = await serve((_request, response) => {
      sentinelRequests += 1;
      response.end('sentinel');
    });
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<a href="${forbiddenOrigin}/sentinel" target="_blank">Open popup</a>`);
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
        {
          id: 'popup',
          title: 'Open popup',
          action: { kind: 'click', locator: { kind: 'text', text: 'Open popup' } },
          assertions: [],
        },
      ]),
    );

    expect(sentinelRequests).toBe(0);
    expect(report.approved).toBe(false);
    expect(report.steps[1]?.observations.some(({ kind }) => kind === 'policy-block')).toBe(true);
  });

  it('waits for an allowed delayed HTTP failure triggered by the final action', async () => {
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/late-failure') {
        setTimeout(() => {
          response.statusCode = 500;
          response.end('late failure');
        }, 350);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        `<button onclick="fetch('/preview/preview-1/late-failure')">Trigger failure</button>`,
      );
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
        {
          id: 'trigger',
          title: 'Trigger delayed failure',
          action: { kind: 'click', locator: { kind: 'text', text: 'Trigger failure' } },
          assertions: [],
        },
      ]),
    );

    expect(report.approved).toBe(false);
    expect(report.steps[1]?.observations.some(({ kind }) => kind === 'http-error')).toBe(true);
  });

  it('records a delayed HTTP failure started by a goto action', async () => {
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/late-goto-failure') {
        setTimeout(() => {
          response.statusCode = 500;
          response.end('late failure');
        }, 350);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        `<h1>Fixture</h1><script>fetch('/preview/preview-1/late-goto-failure')</script>`,
      );
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [{ kind: 'visible', locator: { kind: 'role', role: 'heading' } }],
        },
      ]),
    );

    expect(report.approved).toBe(false);
    expect(report.steps[0]?.observations.some(({ kind }) => kind === 'http-error')).toBe(true);
  });

  it('records console errors and uncaught exceptions from an allowed popup', async () => {
    const popupOrigin = await serve((request, response) => {
      if (request.url === '/popup-error.js') {
        setTimeout(() => {
          response.setHeader('content-type', 'text/javascript');
          response.end(
            `console.error('allowed popup console failure'); throw new Error('allowed popup exception');`,
          );
        }, 50);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end('<script src="/popup-error.js"></script>');
    });
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<a href="${popupOrigin}/popup" target="_blank">Open allowed popup</a>`);
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
        {
          id: 'popup',
          title: 'Open allowed popup',
          action: { kind: 'click', locator: { kind: 'text', text: 'Open allowed popup' } },
          assertions: [],
        },
      ]),
      { allowedOrigins: [popupOrigin] },
    );

    expect(report.approved).toBe(false);
    expect(report.steps[1]?.observations.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['console-error', 'uncaught-exception']),
    );
  });

  it('does not wait for a prevented target blank click that opens no popup', async () => {
    let sentinelRequests = 0;
    const forbiddenOrigin = await serve((_request, response) => {
      sentinelRequests += 1;
      response.end('sentinel');
    });
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<a href="${forbiddenOrigin}/sentinel" target="_blank" onclick="event.preventDefault()">Stay here</a>`,
      );
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
        {
          id: 'click',
          title: 'Stay on fixture',
          action: { kind: 'click', locator: { kind: 'text', text: 'Stay here' } },
          assertions: [],
        },
      ]),
    );

    expect(sentinelRequests).toBe(0);
    expect(report.approved).toBe(true);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'passed']);
  }, 15_000);

  it('permits a 201 Location header without following it as a redirect', async () => {
    let sentinelRequests = 0;
    const forbiddenOrigin = await serve((_request, response) => {
      sentinelRequests += 1;
      response.end('sentinel');
    });
    const origin = await serve((_request, response) => {
      response.statusCode = 201;
      response.setHeader('location', `${forbiddenOrigin}/sentinel`);
      response.setHeader('content-type', 'text/html');
      response.end('<h1>Created</h1>');
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open created resource',
          action: { kind: 'goto', path: '/' },
          assertions: [
            { kind: 'visible', locator: { kind: 'role', role: 'heading', name: 'Created' } },
          ],
        },
      ]),
    );

    expect(sentinelRequests).toBe(0);
    expect(report.approved).toBe(true);
  });

  it('loads a page that starts a long-lived polling request', async () => {
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/poll') return;
      response.setHeader('content-type', 'text/html');
      response.end(`<h1>Polling</h1><script>fetch('/preview/preview-1/poll')</script>`);
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open polling fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [
            { kind: 'visible', locator: { kind: 'role', role: 'heading', name: 'Polling' } },
          ],
        },
      ]),
    );

    expect(report.approved).toBe(true);
    expect(report.steps[0]?.status).toBe('passed');
  }, 15_000);

  it('does not synthesize a failure after Playwright route fetch default timeout', async () => {
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/poll') return;
      response.setHeader('content-type', 'text/html');
      response.end(`<h1>Fixture</h1><input aria-label="Name"><script>
        fetch('/preview/preview-1/poll');
        for (const [index, delay] of [17000, 24000, 31000, 38000].entries()) {
          setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div data-testid="ready-' + index + '">Ready</div>'), delay);
        }
      </script>`);
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [{ kind: 'visible', locator: { kind: 'role', role: 'heading' } }],
        },
        ...[0, 1, 2, 3].map((index) => ({
          id: `wait-${index}`,
          title: `Wait for marker ${index}`,
          action: {
            kind: 'fill' as const,
            locator: { kind: 'label' as const, text: 'Name' },
            value: String(index),
          },
          assertions: [
            {
              kind: 'visible' as const,
              locator: { kind: 'testId' as const, testId: `ready-${index}` },
            },
          ],
        })),
      ]),
    );

    expect(report.approved).toBe(true);
    expect(
      report.steps.flatMap(({ observations }) => observations).map(({ kind }) => kind),
    ).not.toContain('request-failed');
  }, 55_000);

  it('caps observations at 100', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<script>for (let i = 0; i < 105; i++) console.error('failure-' + i)</script>`);
    });
    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open noisy fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
      ]),
    );

    expect(report.approved).toBe(false);
    expect(report.steps[0]?.observations).toHaveLength(100);
  });

  it('rejects generated JavaScript instead of executing it', async () => {
    const origin = await serve((_request, response) => response.end('<h1>Fixture</h1>'));
    const invalidContent = artifact(
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
      ]),
    ) as { data: { steps: Array<{ action: unknown }> } };
    invalidContent.data.steps[0]!.action = {
      kind: 'javascript',
      code: `globalThis.generatedCodeRan = '${TOKEN}'`,
    };

    const report = await new PlaywrightBrowserVerifier().verify(
      {
        planArtifact: PLAN_ARTIFACT,
        planContent: invalidContent,
        session: session(origin),
        allowedOrigins: [],
      },
      new AbortController().signal,
    );

    expect(report.approved).toBe(false);
    expect(report.planValidationError).toBeTruthy();
    expect(report.steps).toEqual([]);
    expectRedacted(report);
  });

  it('aborts a pending navigation and closes its network connection', async () => {
    let navigationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      navigationStarted = resolve;
    });
    let connectionClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      connectionClosed = resolve;
    });
    const origin = await serve((request) => {
      navigationStarted();
      request.once('close', connectionClosed);
    });
    const controller = new AbortController();
    const pending = verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open hanging fixture',
          action: { kind: 'goto', path: '/hang' },
          assertions: [],
        },
      ]),
      { signal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(pending).rejects.toThrow(/cancel/i);
    await expect(closed).resolves.toBeUndefined();
  });
});
