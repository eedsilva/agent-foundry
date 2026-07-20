import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ArtifactReference,
  BrowserEvidencePolicy,
  BrowserTestPlan,
  BrowserVerificationReport,
  PreviewSessionReference,
} from '@agent-foundry/contracts';
import { DEFAULT_BROWSER_EVIDENCE_POLICY } from '@agent-foundry/contracts';
import { PlaywrightBrowserVerifier } from './browser-verifier.js';

const TOKEN = 'preview-token-that-must-never-leak';
// Verification caps at 60 seconds; allow fixture servers 30 seconds to close long-poll connections.
const BROWSER_TEST_TIMEOUT_MS = 90_000;
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
  options: {
    allowedOrigins?: string[];
    signal?: AbortSignal;
    evidencePolicy?: BrowserEvidencePolicy;
  } = {},
): Promise<BrowserVerificationReport> {
  const { report } = await new PlaywrightBrowserVerifier().verify(
    {
      planArtifact: PLAN_ARTIFACT,
      planContent: artifact(browserPlan),
      session: session(origin),
      allowedOrigins: options.allowedOrigins ?? [],
      evidencePolicy: options.evidencePolicy ?? DEFAULT_BROWSER_EVIDENCE_POLICY,
    },
    options.signal ?? new AbortController().signal,
  );
  return report;
}

function expectRedacted(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(TOKEN);
}

// Keep a suite timeout without creating a body-wide indentation-only diff.
// prettier-ignore
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
            { kind: 'visible', locator: { by: 'label', label: 'Name' } },
          ],
        },
        {
          id: 'name-created',
          title: 'Enter created name',
          action: {
            kind: 'fill',
            locator: { by: 'label', label: 'Name' },
            value: 'Created item',
          },
          assertions: [],
        },
        {
          id: 'create',
          title: 'Create item',
          action: { kind: 'click', locator: { by: 'role', role: 'button', name: 'Create' } },
          assertions: [
            {
              kind: 'containsText',
              locator: { by: 'testId', testId: 'item-row' },
              expected: 'Created item',
            },
          ],
        },
        {
          id: 'name-updated',
          title: 'Enter updated name',
          action: {
            kind: 'fill',
            locator: { by: 'label', label: 'Name' },
            value: 'Updated item',
          },
          assertions: [],
        },
        {
          id: 'update',
          title: 'Update item',
          action: { kind: 'click', locator: { by: 'text', text: 'Update' } },
          assertions: [
            {
              kind: 'containsText',
              locator: { by: 'testId', testId: 'item-row' },
              expected: 'Updated item',
            },
          ],
        },
        {
          id: 'delete',
          title: 'Delete item',
          action: { kind: 'click', locator: { by: 'text', text: 'Delete' } },
          assertions: [{ kind: 'hidden', locator: { by: 'testId', testId: 'item-row' } }],
        },
        {
          id: 'open-done',
          title: 'Open another plan path',
          action: { kind: 'goto', path: '/done' },
          assertions: [
            { kind: 'visible', locator: { by: 'role', role: 'heading', name: 'Done' } },
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

  it('honors exact matching for role, label, and text locators', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`
        <label>Name <input></label><label>Name details <input></label>
        <button onclick="document.querySelector('[data-testid=result]').textContent = document.querySelector('input').value">Create</button>
        <button>Create later</button>
        <div>Ready</div><div>Ready later</div><div data-testid="result"></div>
      `);
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [
            { kind: 'visible', locator: { by: 'label', label: 'Name', exact: true } },
            { kind: 'visible', locator: { by: 'text', text: 'Ready', exact: true } },
          ],
        },
        {
          id: 'fill',
          title: 'Fill exact field',
          action: {
            kind: 'fill',
            locator: { by: 'label', label: 'Name', exact: true },
            value: 'Created item',
          },
          assertions: [],
        },
        {
          id: 'create',
          title: 'Click exact button',
          action: {
            kind: 'click',
            locator: { by: 'role', role: 'button', name: 'Create', exact: true },
          },
          assertions: [
            {
              kind: 'containsText',
              locator: { by: 'testId', testId: 'result' },
              expected: 'Created item',
            },
          ],
        },
      ]),
    );

    expect(report.approved).toBe(true);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'passed', 'passed']);
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
          action: { kind: 'click', locator: { by: 'text', text: 'Missing' } },
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
  });

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
    expect(report.steps[0]?.status).toBe('failed');
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
            { kind: 'visible', locator: { by: 'role', role: 'heading', name: 'Fixture' } },
          ],
        },
      ]),
    );

    expect(sentinelRequests).toBe(0);
    expect(sentinelUpgrades).toBe(0);
    expect(report.approved).toBe(false);
    expect(report.steps[0]?.status).toBe('failed');
    expect(report.steps[0]?.observations.some(({ kind }) => kind === 'policy-block')).toBe(true);
    expect(
      report.steps[0]?.observations.some(
        ({ kind, url }) => kind === 'policy-block' && url?.startsWith('ws:'),
      ),
    ).toBe(true);
    expectRedacted(report);
  });

  it('permits an external WebSocket when its HTTP origin is allowed', async () => {
    let allowedUpgrades = 0;
    const allowedOrigin = await serve((_request, response) => response.end('allowed'));
    servers.at(-1)!.on('upgrade', (request, socket) => {
      allowedUpgrades += 1;
      const key = request.headers['sec-websocket-key'];
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.end(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<h1>Connecting</h1><script>
        const socket = new WebSocket('${allowedOrigin.replace('http:', 'ws:')}/allowed');
        socket.onopen = () => { document.querySelector('h1').textContent = 'Connected'; };
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
              locator: { by: 'role', role: 'heading' },
              expected: 'Connected',
            },
          ],
        },
      ]),
      { allowedOrigins: [allowedOrigin] },
    );

    expect(report.approved).toBe(true);
    expect(allowedUpgrades).toBe(1);
    expect(report.steps[0]?.observations).toEqual([]);
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

  it('never lets a preview-origin policy entry widen the exact HTTP or WebSocket prefix', async () => {
    let outsidePrefixRequests = 0;
    let outsidePrefixUpgrades = 0;
    let origin = '';
    origin = await serve((request, response) => {
      if (request.url === '/outside-prefix') {
        outsidePrefixRequests += 1;
        response.end('outside');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`<h1>Fixture</h1><img src="${origin}/outside-prefix"><script>
        new WebSocket('${origin.replace('http:', 'ws:')}/outside-prefix');
      </script>`);
    });
    servers.at(-1)!.on('upgrade', (_request, socket) => {
      outsidePrefixUpgrades += 1;
      socket.destroy();
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [
            { kind: 'visible', locator: { by: 'role', role: 'heading', name: 'Fixture' } },
          ],
        },
      ]),
      { allowedOrigins: [origin] },
    );

    expect(outsidePrefixRequests).toBe(0);
    expect(outsidePrefixUpgrades).toBe(0);
    expect(report.approved).toBe(false);
    expect(report.steps[0]?.status).toBe('failed');
    expect(
      report.steps[0]?.observations.filter(({ kind }) => kind === 'policy-block'),
    ).toHaveLength(2);
  });

  it('blocks repeatedly encoded preview-relative HTTP, redirect, and WebSocket traffic', async () => {
    let sentinelRequests = 0;
    let sentinelUpgrades = 0;
    let origin = '';
    origin = await serve((request, response) => {
      if (request.url?.includes('%252e%252e/sentinel')) {
        sentinelRequests += 1;
        response.end('escaped');
        return;
      }
      if (request.url === '/preview/preview-1/redirect') {
        response.statusCode = 302;
        response.setHeader('location', '/preview/preview-1/%252e%252e/sentinel');
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`
        <img src="/preview/preview-1/%252e%252e/sentinel">
        <iframe src="/preview/preview-1/redirect"></iframe>
        <script>new WebSocket('${origin.replace('http:', 'ws:')}/preview/preview-1/%252e%252e/sentinel')</script>
      `);
    });
    servers.at(-1)!.on('upgrade', (_request, socket) => {
      sentinelUpgrades += 1;
      socket.destroy();
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open encoded fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
      ]),
    );

    expect(sentinelRequests).toBe(0);
    expect(sentinelUpgrades).toBe(0);
    expect(report.approved).toBe(false);
    expect(
      report.steps[0]?.observations.filter(({ kind }) => kind === 'policy-block').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it.each([
    '/../admin',
    '/%2e%2e/admin',
    '/%252e%252e/admin',
    '/%25252e%25252e/admin',
    '/.%252e/admin',
    '/%2f%2fevil.test/',
    '/\\evil.example/',
    '/\thttps://evil.example/',
  ])('rejects plan path %j before it can escape the preview prefix', async (path) => {
    let requests = 0;
    const origin = await serve((_request, response) => {
      requests += 1;
      response.end('sentinel');
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Attempt escape',
          action: { kind: 'goto', path },
          assertions: [],
        },
      ]),
    );

    expect(requests).toBe(0);
    expect(report.approved).toBe(false);
    expect(report.planValidationError).toBeTruthy();
    expect(report.steps).toEqual([]);
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

    const { report } = await new PlaywrightBrowserVerifier().verify(
      {
        planArtifact: PLAN_ARTIFACT,
        planContent: artifact(browserPlan),
        session: {
          ...session(origin),
          url: `${origin}/untrusted-prefix/?token=${TOKEN}`,
        },
        allowedOrigins: [],
        evidencePolicy: DEFAULT_BROWSER_EVIDENCE_POLICY,
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
          assertions: [{ kind: 'visible', locator: { by: 'role', role: 'heading' } }],
        },
        {
          id: 'trigger',
          title: 'Trigger failure',
          action: { kind: 'click', locator: { by: 'text', text: 'Trigger failure' } },
          assertions: [],
        },
      ]),
    );

    expect(report.approved).toBe(false);
    expect(report.steps[1]?.observations.some(({ kind }) => kind === 'http-error')).toBe(true);
  });

  it('fails the active step on a passive failure and skips later side effects', async () => {
    let laterSideEffects = 0;
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/failure') {
        response.statusCode = 500;
        response.end('failed');
        return;
      }
      if (request.url === '/preview/preview-1/later-side-effect') {
        laterSideEffects += 1;
        response.end('unexpected');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`
        <button onclick="fetch('/preview/preview-1/failure')">Trigger failure</button>
        <button onclick="fetch('/preview/preview-1/later-side-effect')">Later side effect</button>
      `);
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
          id: 'failure',
          title: 'Trigger passive failure',
          action: { kind: 'click', locator: { by: 'text', text: 'Trigger failure' } },
          assertions: [],
        },
        {
          id: 'side-effect',
          title: 'Perform later side effect',
          action: { kind: 'click', locator: { by: 'text', text: 'Later side effect' } },
          assertions: [],
        },
      ]),
    );

    expect(laterSideEffects).toBe(0);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'failed', 'skipped']);
    expect(report.steps[1]?.observations.some(({ kind }) => kind === 'http-error')).toBe(true);
  });

  it.each([
    ['console-error', 'click', 700, `console.error('delayed console failure')`],
    ['uncaught-exception', 'click', 700, `throw new Error('delayed page failure')`],
    ['console-error', 'fill', 700, `console.error('delayed fill failure')`],
    ['console-error', 'click', 1_000, `console.error('boundary console failure')`],
  ] as const)(
    'attributes a delayed %s from %s at %d ms to its initiating step before later side effects',
    async (observationKind, actionKind, delayMs, delayedFailure) => {
      let laterSideEffects = 0;
      const origin = await serve((request, response) => {
        if (request.url === '/preview/preview-1/later-side-effect') {
          laterSideEffects += 1;
          response.end('unexpected');
          return;
        }
        response.setHeader('content-type', 'text/html');
        response.end(`
          <button onclick="setTimeout(() => { ${delayedFailure} }, ${delayMs})">Trigger failure</button>
          <input aria-label="Failure input" oninput="setTimeout(() => { ${delayedFailure} }, ${delayMs})">
          <button onclick="fetch('/preview/preview-1/later-side-effect')">Later side effect</button>
        `);
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
            id: 'failure',
            title: 'Trigger delayed failure',
            action:
              actionKind === 'click'
                ? { kind: 'click', locator: { by: 'text', text: 'Trigger failure' } }
                : {
                    kind: 'fill',
                    locator: { by: 'label', label: 'Failure input' },
                    value: 'trigger',
                  },
            assertions: [],
          },
          {
            id: 'side-effect',
            title: 'Perform later side effect',
            action: { kind: 'click', locator: { by: 'text', text: 'Later side effect' } },
            assertions: [],
          },
        ]),
      );

      expect(laterSideEffects).toBe(0);
      expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'failed', 'skipped']);
      expect(report.steps[1]?.observations.some(({ kind }) => kind === observationKind)).toBe(true);
      expect(report.steps[0]?.observations).toEqual([]);
    },
  );

  it('does not wait for timers above the declared one-second attribution boundary', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<h1>Fixture</h1><script>
        setTimeout(() => console.error('outside supported attribution window'), 10_001);
      </script>`);
    });
    const startedAt = performance.now();

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [{ kind: 'visible', locator: { by: 'role', role: 'heading' } }],
        },
      ]),
    );

    expect(report.approved).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it('attributes a 700 ms console timer from goto before a later side effect', async () => {
    let laterSideEffects = 0;
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/later-side-effect') {
        laterSideEffects += 1;
        response.end('unexpected');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`
        <button onclick="fetch('/preview/preview-1/later-side-effect')">Later side effect</button>
        <script>setTimeout(() => console.error('goto timer failure'), 700)</script>
      `);
    });

    const report = await verify(
      origin,
      plan([
        {
          id: 'open',
          title: 'Open delayed-failure fixture',
          action: { kind: 'goto', path: '/' },
          assertions: [],
        },
        {
          id: 'side-effect',
          title: 'Perform later side effect',
          action: { kind: 'click', locator: { by: 'text', text: 'Later side effect' } },
          assertions: [],
        },
      ]),
    );

    expect(laterSideEffects).toBe(0);
    expect(report.steps.map(({ status }) => status)).toEqual(['failed', 'skipped']);
    expect(report.steps[0]?.observations.some(({ kind }) => kind === 'console-error')).toBe(true);
  });

  it('tracks a supported string timer handler without evaluating it in the executor', async () => {
    let laterSideEffects = 0;
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/later-side-effect') {
        laterSideEffects += 1;
        response.end('unexpected');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`
        <button onclick="setTimeout(&quot;console.error('string timer failure')&quot;, 700)">Trigger failure</button>
        <button onclick="fetch('/preview/preview-1/later-side-effect')">Later side effect</button>
      `);
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
          id: 'failure',
          title: 'Trigger string timer failure',
          action: { kind: 'click', locator: { by: 'text', text: 'Trigger failure' } },
          assertions: [],
        },
        {
          id: 'side-effect',
          title: 'Perform later side effect',
          action: { kind: 'click', locator: { by: 'text', text: 'Later side effect' } },
          assertions: [],
        },
      ]),
    );

    expect(laterSideEffects).toBe(0);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'failed', 'skipped']);
    expect(report.steps[1]?.observations.some(({ kind }) => kind === 'console-error')).toBe(true);
  });

  it('waits for supported timers in a popup before a later main-page side effect', async () => {
    let laterSideEffects = 0;
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/popup') {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<script>setTimeout(() => console.error('popup timer failure'), 700)</script>`,
        );
        return;
      }
      if (request.url === '/preview/preview-1/later-side-effect') {
        laterSideEffects += 1;
        response.end('unexpected');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`
        <button onclick="window.open('/preview/preview-1/popup')">Open popup</button>
        <button onclick="fetch('/preview/preview-1/later-side-effect')">Later side effect</button>
      `);
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
          title: 'Open delayed-failure popup',
          action: { kind: 'click', locator: { by: 'text', text: 'Open popup' } },
          assertions: [],
        },
        {
          id: 'side-effect',
          title: 'Perform later side effect',
          action: { kind: 'click', locator: { by: 'text', text: 'Later side effect' } },
          assertions: [],
        },
      ]),
    );

    expect(laterSideEffects).toBe(0);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'failed', 'skipped']);
    expect(report.steps[1]?.observations.some(({ kind }) => kind === 'console-error')).toBe(true);
  });

  it('attributes a late popup error to the active step and skips its later side effect', async () => {
    let laterSideEffects = 0;
    const origin = await serve((request, response) => {
      if (request.url === '/preview/preview-1/popup') {
        response.setHeader('content-type', 'text/html');
        response.end(
          `<script>setTimeout(() => console.error('late popup failure'), 1100)</script>`,
        );
        return;
      }
      if (request.url === '/preview/preview-1/wait') {
        setTimeout(() => response.end('waited'), 1400);
        return;
      }
      if (request.url === '/preview/preview-1/later-side-effect') {
        laterSideEffects += 1;
        response.end('unexpected');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`
        <button onclick="window.open('/preview/preview-1/popup')">Open popup</button>
        <button onclick="fetch('/preview/preview-1/wait')">Wait</button>
        <button onclick="fetch('/preview/preview-1/later-side-effect')">Later side effect</button>
      `);
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
          action: { kind: 'click', locator: { by: 'text', text: 'Open popup' } },
          assertions: [],
        },
        {
          id: 'wait',
          title: 'Wait while popup fails',
          action: { kind: 'click', locator: { by: 'text', text: 'Wait' } },
          assertions: [],
        },
        {
          id: 'side-effect',
          title: 'Perform later side effect',
          action: { kind: 'click', locator: { by: 'text', text: 'Later side effect' } },
          assertions: [],
        },
      ]),
    );

    expect(laterSideEffects).toBe(0);
    expect(report.steps.map(({ status }) => status)).toEqual([
      'passed',
      'passed',
      'failed',
      'skipped',
    ]);
    expect(report.steps[2]?.observations.some(({ kind }) => kind === 'console-error')).toBe(true);
  });

  it('preserves the browser receiver for strict timeout callbacks', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`
        <button onclick="setTimeout(function () { 'use strict'; document.querySelector('[data-testid=result]').textContent = this === window ? 'window' : 'wrong'; }, 100)">Check receiver</button>
        <div data-testid="result">pending</div>
      `);
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
          id: 'receiver',
          title: 'Check timeout receiver',
          action: { kind: 'click', locator: { by: 'text', text: 'Check receiver' } },
          assertions: [
            {
              kind: 'containsText',
              locator: { by: 'testId', testId: 'result' },
              expected: 'window',
            },
          ],
        },
      ]),
    );

    expect(report.approved).toBe(true);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'passed']);
  });

  it('throws the native TypeError for a BigInt timeout delay', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`
        <button onclick="let result = 'not-thrown'; try { setTimeout(() => {}, 1n); } catch (error) { result = error instanceof TypeError ? 'type-error' : 'wrong-error'; } document.querySelector('[data-testid=result]').textContent = result">Probe delay</button>
        <div data-testid="result">pending</div>
      `);
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
          id: 'probe',
          title: 'Probe BigInt delay',
          action: { kind: 'click', locator: { by: 'text', text: 'Probe delay' } },
          assertions: [
            {
              kind: 'containsText',
              locator: { by: 'testId', testId: 'result' },
              expected: 'type-error',
            },
          ],
        },
      ]),
    );

    expect(report.approved).toBe(true);
  });

  it('coerces a non-finite timeout delay once and keeps native scheduling', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`
        <button onclick="let coercions = 0; const delay = { [Symbol.toPrimitive]() { coercions += 1; return coercions === 1 ? Infinity : 100; } }; setTimeout(() => { document.querySelector('[data-testid=result]').textContent = 'fired:' + coercions; }, delay)">Probe delay</button>
        <div data-testid="result">pending</div>
      `);
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
          id: 'probe',
          title: 'Probe non-finite delay',
          action: { kind: 'click', locator: { by: 'text', text: 'Probe delay' } },
          assertions: [
            {
              kind: 'containsText',
              locator: { by: 'testId', testId: 'result' },
              expected: 'fired:1',
            },
          ],
        },
      ]),
    );

    expect(report.approved).toBe(true);
  });

  it.each(['clearTimeout', 'clearInterval'] as const)(
    'coerces a timer handle once when cancelled through %s',
    async (clearMethod) => {
      const origin = await serve((_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(`
          <button onclick="const timer = setTimeout(() => console.error('must stay cancelled'), 700); let coercions = 0; const handle = { [Symbol.toPrimitive]() { coercions += 1; return timer; } }; ${clearMethod}(handle); document.querySelector('[data-testid=result]').textContent = String(coercions)">Cancel timer</button>
          <div data-testid="result">pending</div>
        `);
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
            id: 'cancel',
            title: 'Cancel timer',
            action: { kind: 'click', locator: { by: 'text', text: 'Cancel timer' } },
            assertions: [
              {
                kind: 'containsText',
                locator: { by: 'testId', testId: 'result' },
                expected: '1',
              },
            ],
          },
        ]),
      );

      expect(report.approved).toBe(true);
      expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'passed']);
    },
  );

  it.each([
    ['clearInterval', 'clearInterval(timer)'],
    ['numeric-string clearTimeout', 'clearTimeout(String(timer))'],
  ] as const)(
    'settles a tracked timeout cancelled through %s',
    async (_case, cancellation) => {
      const origin = await serve((_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(`
        <button onclick="const timer = setTimeout(() => console.error('must stay cancelled'), 700); ${cancellation}; document.querySelector('[data-testid=result]').textContent = 'cancelled'">Cancel timer</button>
        <div data-testid="result">pending</div>
      `);
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
            id: 'cancel',
            title: 'Cancel timeout',
            action: { kind: 'click', locator: { by: 'text', text: 'Cancel timer' } },
            assertions: [
              {
                kind: 'containsText',
                locator: { by: 'testId', testId: 'result' },
                expected: 'cancelled',
              },
            ],
          },
        ]),
      );

      expect(report.approved).toBe(true);
      expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'passed']);
    },
    15_000,
  );

  it.each(['main page', 'popup'] as const)(
    'retries timer quiescence when the %s navigates',
    async (target) => {
      const origin = await serve((request, response) => {
        response.setHeader('content-type', 'text/html');
        if (request.url?.endsWith('/ready')) {
          setTimeout(() => response.end('<h1>Ready</h1>'), 400);
          return;
        }
        if (request.url?.endsWith('/popup')) {
          response.end(
            `<script>setTimeout(() => location.href = '/preview/preview-1/ready', 300)</script>`,
          );
          return;
        }
        response.end(`
          <button onclick="${
            target === 'main page'
              ? "setTimeout(() => location.href = '/preview/preview-1/ready', 300)"
              : "window.open('/preview/preview-1/popup')"
          }">Navigate</button>
        `);
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
            id: 'navigate',
            title: 'Navigate from a timer',
            action: { kind: 'click', locator: { by: 'text', text: 'Navigate' } },
            assertions: [],
          },
        ]),
      );

      expect(report.approved).toBe(true);
      expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'passed']);
    },
  );

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
              locator: { by: 'testId', testId: 'status' },
              expected: 'Ready',
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

  it('rejects a matching path on an explicitly allowed external origin', async () => {
    const allowedOrigin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<h1>External</h1>');
    });
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<button onclick="location.href = '${allowedOrigin}/preview/preview-1/ready'">Leave preview</button>`,
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
          id: 'external',
          title: 'Navigate outside the preview origin',
          action: { kind: 'click', locator: { by: 'text', text: 'Leave preview' } },
          assertions: [{ kind: 'url', path: '/ready' }],
        },
      ]),
      { allowedOrigins: [allowedOrigin] },
    );

    expect(report.approved).toBe(false);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'failed']);
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
          action: { kind: 'click', locator: { by: 'text', text: 'Open popup' } },
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
          action: { kind: 'click', locator: { by: 'text', text: 'Trigger failure' } },
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
          assertions: [{ kind: 'visible', locator: { by: 'role', role: 'heading' } }],
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
          action: { kind: 'click', locator: { by: 'text', text: 'Open allowed popup' } },
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
          action: { kind: 'click', locator: { by: 'text', text: 'Stay here' } },
          assertions: [],
        },
      ]),
    );

    expect(sentinelRequests).toBe(0);
    expect(report.approved).toBe(true);
    expect(report.steps.map(({ status }) => status)).toEqual(['passed', 'passed']);
  });

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
            { kind: 'visible', locator: { by: 'role', role: 'heading', name: 'Created' } },
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
            { kind: 'visible', locator: { by: 'role', role: 'heading', name: 'Polling' } },
          ],
        },
      ]),
    );

    expect(report.approved).toBe(true);
    expect(report.steps[0]?.status).toBe('passed');
  });

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
          assertions: [{ kind: 'visible', locator: { by: 'role', role: 'heading' } }],
        },
        ...[0, 1, 2, 3].map((index) => ({
          id: `wait-${index}`,
          title: `Wait for marker ${index}`,
          action: {
            kind: 'fill' as const,
            locator: { by: 'label' as const, label: 'Name' },
            value: String(index),
          },
          assertions: [
            {
              kind: 'visible' as const,
              locator: { by: 'testId' as const, testId: `ready-${index}` },
            },
          ],
        })),
      ]),
    );

    expect(report.approved).toBe(true);
    expect(
      report.steps.flatMap(({ observations }) => observations).map(({ kind }) => kind),
    ).not.toContain('request-failed');
  });

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

    const { report } = await new PlaywrightBrowserVerifier().verify(
      {
        planArtifact: PLAN_ARTIFACT,
        planContent: invalidContent,
        session: session(origin),
        allowedOrigins: [],
        evidencePolicy: DEFAULT_BROWSER_EVIDENCE_POLICY,
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

  it('captures one screenshot per executed step with viewport, url, and hash', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<h1>Fixture</h1>');
    });
    const browserPlan = plan([
      { id: 'open', title: 'Open fixture', action: { kind: 'goto', path: '/' }, assertions: [] },
    ]);

    const { evidence } = await new PlaywrightBrowserVerifier().verify(
      {
        planArtifact: PLAN_ARTIFACT,
        planContent: artifact(browserPlan),
        session: session(origin),
        allowedOrigins: [],
        evidencePolicy: DEFAULT_BROWSER_EVIDENCE_POLICY,
      },
      new AbortController().signal,
    );

    expect(evidence.screenshots).toHaveLength(1);
    expect(evidence.screenshots[0]).toMatchObject({
      stepId: 'open',
      viewport: { width: 900, height: 600 },
    });
    expect(evidence.screenshots[0]!.buffer.byteLength).toBeGreaterThan(0);
    expectRedacted(evidence.screenshots[0]!.url);
    expect(evidence.trace).toBeUndefined();
    expect(evidence.video).toBeUndefined();
  });

  it('captures a trace only when the evidence policy requests it', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<h1>Fixture</h1>');
    });
    const browserPlan = plan([
      { id: 'open', title: 'Open fixture', action: { kind: 'goto', path: '/' }, assertions: [] },
    ]);

    const { evidence } = await new PlaywrightBrowserVerifier().verify(
      {
        planArtifact: PLAN_ARTIFACT,
        planContent: artifact(browserPlan),
        session: session(origin),
        allowedOrigins: [],
        evidencePolicy: { ...DEFAULT_BROWSER_EVIDENCE_POLICY, captureTrace: true },
      },
      new AbortController().signal,
    );

    expect(evidence.trace).toBeInstanceOf(Buffer);
    expect(evidence.trace!.byteLength).toBeGreaterThan(0);
  });

  it('captures a video only when the evidence policy requests it', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<h1>Fixture</h1>');
    });
    const browserPlan = plan([
      { id: 'open', title: 'Open fixture', action: { kind: 'goto', path: '/' }, assertions: [] },
    ]);

    const { evidence } = await new PlaywrightBrowserVerifier().verify(
      {
        planArtifact: PLAN_ARTIFACT,
        planContent: artifact(browserPlan),
        session: session(origin),
        allowedOrigins: [],
        evidencePolicy: { ...DEFAULT_BROWSER_EVIDENCE_POLICY, captureVideo: true },
      },
      new AbortController().signal,
    );

    expect(evidence.video).toBeInstanceOf(Buffer);
    expect(evidence.video!.byteLength).toBeGreaterThan(0);
  });
}, BROWSER_TEST_TIMEOUT_MS);

describe('captureSelectionScreenshot', () => {
  it('returns a PNG buffer clipped to the given region', async () => {
    const origin = await serve((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<html><body style="margin:0"><div style="width:50px;height:50px;background:red"></div></body></html>',
      );
    });
    const verifier = new PlaywrightBrowserVerifier();
    const buffer = await verifier.captureSelectionScreenshot({
      url: `${origin}/`,
      clip: { x: 0, y: 0, width: 50, height: 50 },
      viewport: { width: 200, height: 200 },
    });
    expect(buffer).not.toBeNull();
    expect(buffer?.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG magic bytes
  });

  it('returns null when navigation fails', async () => {
    const verifier = new PlaywrightBrowserVerifier();
    const buffer = await verifier.captureSelectionScreenshot({
      url: 'http://127.0.0.1:1/', // nothing listens here
      clip: { x: 0, y: 0, width: 10, height: 10 },
      viewport: { width: 100, height: 100 },
    });
    expect(buffer).toBeNull();
  });
});
