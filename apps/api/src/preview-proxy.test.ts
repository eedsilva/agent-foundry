import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((stop) => stop().catch(() => undefined)));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// The preview URL PreviewService hands back is built from config.apiPort, and the
// proxy's Host-header allow-list is that same port, so the Fastify server has to
// listen on config.apiPort (not an ephemeral one) for the returned URL to be
// reachable and Host-valid. Reserve a free port up front and pin it as API_PORT.
function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function startApi(): Promise<{ baseUrl: string; runtime: Runtime }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-proxy-'));
  dirs.push(dataDir);
  const apiPort = await getFreePort();
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'proxy-worker',
    PREVIEW_TTL_SECONDS: '2', // short TTL for the expiry test
    API_PORT: String(apiPort),
  });
  const app = await buildApp(runtime);
  apps.push(app);
  const baseUrl = await app.listen({ host: runtime.config.apiHost, port: runtime.config.apiPort });
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
  await writeFile(
    join(workspacePath, 'package.json'),
    JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
  );
  const startResponse = await fetch(`${baseUrl}/projects/${project.id}/preview`, {
    method: 'POST',
  });
  const started = (await startResponse.json()) as {
    session: { id: string; status: string };
    url: string;
  };
  // Reap the real dev-server subprocess after the test so nothing leaks.
  cleanups.push(() => runtime.previewService.stop(started.session.id).then(() => undefined));
  return started;
}

describe('preview reverse proxy', () => {
  it('proxies two simultaneous previews to their own upstream without leaking the internal port', async () => {
    const { baseUrl, runtime } = await startApi();
    const [a, b] = await Promise.all([
      startPreview(baseUrl, runtime, 'a'),
      startPreview(baseUrl, runtime, 'b'),
    ]);
    expect(a.session.status).toBe('running');
    expect(b.session.status).toBe('running');
    expect(a.url).not.toBe(b.url);

    const [responseA, responseB] = await Promise.all([fetch(a.url), fetch(b.url)]);
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(await responseA.text()).toContain('ok:');
    expect(await responseB.text()).toContain('ok:');
  }, 20_000);

  it('sets the pv_<sessionId> auth cookie on the first token-authenticated response', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'set-cookie');
    const token = new URL(started.url).searchParams.get('token') as string;
    const response = await fetch(started.url);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    // Cookie name must be pv_<sessionId>, and its value must be the session's own
    // token — this is what lets a real HMR client's later reconnect (which drops
    // ?token= when it rebuilds the WS URL from location.host) authenticate via
    // cookie alone. See the websocket cookie-only-auth test below.
    expect(setCookie).toContain(`pv_${started.session.id}=${token}`);
  }, 20_000);

  it('does not forward the proxy auth cookie to the untrusted upstream', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'cookie-leak');
    const target = new URL(started.url);
    const token = target.searchParams.get('token') as string;
    // Simulate a real browser follow-on request: the initial navigation already
    // set pv_<sessionId>=<token>, so the browser now attaches it on every
    // subsequent same-path request. The upstream must never receive it, while
    // any other cookie the previewed app set for itself still passes through.
    const body = await new Promise<string>((resolvePromise, reject) => {
      const req = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: `/preview/${started.session.id}/echo-headers`,
          headers: {
            host: target.host,
            cookie: `pv_${started.session.id}=${token}; app_pref=keep`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolvePromise(data));
        },
      );
      req.on('error', reject);
      req.end();
    });
    const received = JSON.parse(body) as Record<string, string>;
    expect(body).not.toContain(token); // token absent from the entire echoed request
    expect(received.cookie ?? '').not.toContain(token);
    expect(received.cookie ?? '').toContain('app_pref=keep'); // other cookies survive
  }, 20_000);

  it('forwards a JSON POST body to the session upstream instead of draining it', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'json-body');
    const target = new URL(started.url);
    target.pathname += 'echo-body';
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    expect(response.status).toBe(200);
    const echoed = (await response.json()) as { contentType: string; body: string };
    expect(echoed.contentType).toBe('application/json');
    expect(JSON.parse(echoed.body)).toEqual({ foo: 'bar' });
  }, 20_000);

  it('forwards a form-urlencoded POST body without a 415', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'form-body');
    const target = new URL(started.url);
    target.pathname += 'echo-body';
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'foo=bar',
    });
    expect(response.status).toBe(200);
    const echoed = (await response.json()) as { contentType: string; body: string };
    expect(echoed.contentType).toBe('application/x-www-form-urlencoded');
    expect(echoed.body).toBe('foo=bar');
  }, 20_000);

  it('rejects a request with a mismatched Host header', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'host');
    const target = new URL(started.url);
    // undici fetch() silently drops a custom Host header, so drive this with a
    // raw http request that actually sends Host: evil.example:9999.
    const status = await new Promise<number | undefined>((resolvePromise) => {
      const req = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          headers: { host: 'evil.example:9999' },
        },
        (res) => {
          res.resume();
          resolvePromise(res.statusCode);
        },
      );
      req.on('error', () => resolvePromise(undefined));
      req.end();
    });
    expect(status).toBe(400);
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
      req.on('upgrade', (res, upgradedSocket) => {
        upgradedSocket.destroy(); // close the relay so app.close() can drain
        resolvePromise(res.statusCode === 101);
      });
      req.on('error', () => resolvePromise(false));
      req.end();
    });
    expect(upgraded).toBe(true);
  }, 20_000);

  it('sanitizes the upstream response headers on the websocket upgrade path so the internal port never leaks', async () => {
    // The fixture's 101 response deliberately embeds its own 127.0.0.1:<port> in
    // an X-Upstream-Addr header. Unlike the HTTP path, the WS path used to relay
    // the raw upstream response verbatim; assert the proxy now sanitizes it so no
    // internal address reaches the client.
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'ws-sanitize');
    const target = new URL(started.url);
    const rawHeaders = await new Promise<string>((resolvePromise) => {
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
      req.on('upgrade', (res, upgradedSocket) => {
        upgradedSocket.destroy();
        resolvePromise(res.rawHeaders.join('\n'));
      });
      req.on('error', () => resolvePromise('ERROR'));
      req.end();
    });
    expect(rawHeaders).not.toMatch(/127\.0\.0\.1:\d+/); // no internal address in any header
    expect(rawHeaders.toLowerCase()).not.toContain('x-upstream-addr'); // leaking header stripped
  }, 20_000);

  it('accepts a websocket upgrade authenticated only by the pv_<sessionId> cookie, with no ?token= query param', async () => {
    // Real HMR clients reconnect by rebuilding the WS URL from location.host plus
    // a fixed path, which drops the original ?token=. The cookie set on the first
    // HTTP response is the only auth that survives that reconnect, so this exact
    // path — WS upgrade, cookie present, query token absent — must work.
    const { baseUrl, runtime } = await startApi();
    const started = await startPreview(baseUrl, runtime, 'ws-cookie');
    const target = new URL(started.url);
    const token = target.searchParams.get('token') as string;
    const upgraded = await new Promise<boolean>((resolvePromise) => {
      const req = httpRequest({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}ws`, // deliberately no ?token=
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          Cookie: `pv_${started.session.id}=${token}`,
        },
      });
      req.on('upgrade', (res, upgradedSocket) => {
        upgradedSocket.destroy(); // close the relay so app.close() can drain
        resolvePromise(res.statusCode === 101);
      });
      req.on('error', () => resolvePromise(false));
      req.end();
    });
    expect(upgraded).toBe(true);
  }, 20_000);
});

describe('inspector script injection', () => {
  async function startPreviewWithHtmlFixture(
    baseUrl: string,
    runtime: Runtime,
    script: string,
    id: string,
  ) {
    const projectResponse = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Inject ${id}`, prd: 'x'.repeat(60) }),
    });
    const { project } = (await projectResponse.json()) as { project: { id: string } };
    await runtime.workspaces.ensure(project.id);
    const workspacePath = runtime.workspaces.workspacePath(project.id);
    await writeFile(join(workspacePath, 'server.mjs'), script);
    await writeFile(
      join(workspacePath, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.mjs' } }),
    );
    const startResponse = await fetch(`${baseUrl}/projects/${project.id}/preview`, {
      method: 'POST',
    });
    const started = (await startResponse.json()) as { session: { id: string }; url: string };
    cleanups.push(() => runtime.previewService.stop(started.session.id).then(() => undefined));
    return started;
  }

  const HTML_FIXTURE = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT ?? 0);
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body><div>hello</div></body></html>');
}).listen(port, '127.0.0.1', () => console.log('  VITE fixture  ready\\n\\n  ➜  Local:   http://127.0.0.1:' + port + '/\\n'));
`;

  const JSON_FIXTURE = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT ?? 0);
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}).listen(port, '127.0.0.1', () => console.log('  VITE fixture  ready\\n\\n  ➜  Local:   http://127.0.0.1:' + port + '/\\n'));
`;

  it('injects the inspector script into a text/html response before </body>', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreviewWithHtmlFixture(baseUrl, runtime, HTML_FIXTURE, 'html');
    const body = await fetch(started.url).then((response) => response.text());
    expect(body).toContain('af:selection:start');
    expect(body.indexOf('af:selection:start')).toBeLessThan(body.indexOf('</body>'));
    // Regression check: injectInspectorScript used to pass the script tag as a
    // *string* replacement to html.replace('</body>', ...), and the embedded
    // findReactFiber source contains the literal "__reactFiber$" — the "$'"
    // there is a special string-replacement pattern (insert the text after
    // the match), so it silently overwrote that "$" with whatever followed
    // </body> in the source (here, "</html>"), corrupting the script into
    // invalid JS. Assert the "$" survives intact (quote style is transform-
    // dependent — esbuild emits double quotes, tsc keeps single — so match
    // only the part the bug actually corrupts).
    expect(body).toContain('__reactFiber$');
  });

  it('does not touch a non-HTML response', async () => {
    const { baseUrl, runtime } = await startApi();
    const started = await startPreviewWithHtmlFixture(baseUrl, runtime, JSON_FIXTURE, 'json');
    const body = await fetch(started.url).then((response) => response.text());
    expect(body).toBe('{"ok":true}');
  });
});
