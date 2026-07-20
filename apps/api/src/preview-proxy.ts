import {
  Agent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Runtime } from '@agent-foundry/composition';
import { isLoopbackHost } from '@agent-foundry/composition';
import { buildInspectorScript } from './preview-inspector-script.js';
import { wildcardParam } from './request-util.js';

// Keep-alive so proxied asset/HMR-poll bursts reuse one upstream TCP connection
// instead of opening a fresh socket to the dev server per request.
const upstreamAgent = new Agent({ keepAlive: true });

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
  // webOrigin is CORS's comma-separated allow-list (see app.ts); the inspector
  // script's parent-origin check is a single strict `===`. Built once at
  // startup, not per-request: parentOrigin is fixed for the process lifetime,
  // and buildInspectorScript's output is a pure function of it.
  const parentOrigin = runtime.config.webOrigin.split(',')[0]?.trim() ?? runtime.config.webOrigin;
  const inspectorScriptTag = `<script>${buildInspectorScript(parentOrigin)}</script>`;

  app.all('/preview/:sessionId', (request, reply) =>
    handleHttp(request, reply, runtime, allowedPort, inspectorScriptTag),
  );
  app.all('/preview/:sessionId/*', (request, reply) =>
    handleHttp(request, reply, runtime, allowedPort, inspectorScriptTag),
  );

  app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void handleUpgrade(req, socket, head, runtime, allowedPort);
  });
}

async function handleHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: Runtime,
  allowedPort: string,
  inspectorScriptTag: string,
): Promise<void> {
  // DNS-rebinding defense: reject anything whose Host header isn't this API's own
  // loopback host:port. This runs BEFORE any token check or upstream connection.
  if (!isAllowedHost(request.headers.host, allowedPort)) {
    await reply.status(400).send({ error: 'InvalidHost', message: 'Unexpected Host header.' });
    return;
  }
  const { sessionId } = request.params as { sessionId: string };
  const upstreamPath = '/' + wildcardParam(request);
  const url = new URL(request.url, 'http://internal');
  const queryToken = url.searchParams.get('token') ?? undefined;
  const cookieToken = readCookieToken(request.headers.cookie, sessionId);
  const presentedToken = cookieToken ?? queryToken;

  // Let NotFound/PreviewAccessDenied propagate to the app's setErrorHandler
  // (same 404/403 mapping the sibling /preview routes rely on). This runs
  // before reply.hijack(), so Fastify's error handling is still in play.
  const resolved = await runtime.previewService.resolveUpstream(sessionId, presentedToken);

  // resolveUpstream already validated queryToken in the no-cookie branch, so
  // echo it straight back as the pv_<sessionId> cookie without re-checking.
  const cookieValue = cookieToken ? undefined : queryToken;
  reply.hijack();
  const raw = reply.raw;
  // The proxy auth token is proxy-internal; strip it so the untrusted upstream
  // process never receives it (and so exact-path upstream routing still works).
  const search = strippedSearch(url.searchParams);
  const upstreamReq = httpRequest(
    {
      host: '127.0.0.1',
      port: resolved.port,
      method: request.method,
      path: upstreamPath + search,
      headers: sanitizeRequestHeaders(request.headers, sessionId),
      agent: upstreamAgent,
    },
    (upstreamRes) =>
      respondFromUpstream(
        upstreamRes,
        raw,
        sessionId,
        resolved.port,
        cookieValue,
        inspectorScriptTag,
      ),
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
  inspectorScriptTag: string,
): void {
  const headers = sanitizeResponseHeaders(upstreamRes.headers, sessionId, upstreamPort);
  if (cookieValue) {
    const cookie = `pv_${sessionId}=${cookieValue}; Path=/preview/${sessionId}; HttpOnly; SameSite=Lax`;
    const existing = headers['set-cookie'];
    headers['set-cookie'] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), cookie]
      : cookie;
  }
  const contentType = headers['content-type'];
  const isHtml = typeof contentType === 'string' && contentType.startsWith('text/html');
  if (!isHtml) {
    raw.writeHead(upstreamRes.statusCode ?? 502, headers);
    upstreamRes.pipe(raw);
    return;
  }
  // ponytail: buffers the full HTML body in memory before forwarding (loses
  // today's fully-streamed proxying for HTML documents only — JS/CSS/HMR
  // chunks are untouched above). Fine for typical page sizes; revisit with a
  // streaming </body> boundary scan if huge SSR pages ever matter.
  const chunks: Buffer[] = [];
  upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
  upstreamRes.on('end', () => {
    const html = injectInspectorScript(Buffer.concat(chunks).toString('utf8'), inspectorScriptTag);
    const rewritten = Buffer.from(html, 'utf8');
    delete headers['content-length']; // body length changed; let Node recompute framing
    raw.writeHead(upstreamRes.statusCode ?? 502, {
      ...headers,
      'content-length': String(rewritten.byteLength),
    });
    raw.end(rewritten);
  });
  upstreamRes.on('error', () => raw.destroy());
}

function injectInspectorScript(html: string, inspectorScriptTag: string): string {
  if (!html.includes('</body>')) return html;
  // Replacement must be a function, not a string: String.replace interprets
  // "$"-sequences in a *string* replacement specially (e.g. the literal
  // `__reactFiber$` inside the embedded findReactFiber source is followed by
  // a quote, so "$'" was parsed as the "insert text after the match" pattern
  // and silently corrupted the injected script). A function's return value is
  // inserted verbatim, with no $-pattern interpretation.
  return html.replace('</body>', () => `${inspectorScriptTag}</body>`);
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
  // Same Host-header rebinding defense, before touching any upstream socket.
  if (!match || !isAllowedHost(req.headers.host, allowedPort)) {
    socket.destroy();
    return;
  }
  const [, sessionId, rest] = match;
  if (!sessionId) {
    socket.destroy();
    return;
  }
  const cookieToken = readCookieToken(req.headers.cookie, sessionId);
  const presentedToken = cookieToken ?? url.searchParams.get('token') ?? undefined;
  let resolved: { port: number };
  try {
    resolved = await runtime.previewService.resolveUpstream(sessionId, presentedToken);
  } catch {
    // This runs outside Fastify's request/reply cycle (raw server 'upgrade'
    // event), so there's no error handler to defer to: destroy the socket.
    socket.destroy();
    return;
  }
  const search = strippedSearch(url.searchParams);
  // Reuse the exact same request-header sanitizer as the HTTP path (hop-by-hop
  // strip, pv_<sessionId> cookie strip, forced Host: 127.0.0.1); re-add the
  // upgrade handshake headers it strips as hop-by-hop.
  const headers = sanitizeRequestHeaders(req.headers, sessionId);
  headers.connection = 'Upgrade';
  if (req.headers.upgrade) headers.upgrade = req.headers.upgrade;
  const upstreamReq = httpRequest({
    host: '127.0.0.1',
    port: resolved.port,
    method: req.method,
    path: (rest || '/') + search,
    headers,
  });
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    // Run the upstream's 101 response headers through the SAME sanitizer the
    // HTTP path uses (port-leak containment + hop-by-hop strip + backstop)
    // before relaying, then re-add the handshake headers it strips.
    const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers, sessionId, resolved.port);
    responseHeaders.connection = 'Upgrade';
    if (upstreamRes.headers.upgrade) responseHeaders.upgrade = upstreamRes.headers.upgrade;
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage || 'Switching Protocols'}\r\n`;
    socket.write(statusLine + serializeHeaders(responseHeaders) + '\r\n\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    // Post-upgrade the live pair is socket<->upstreamSocket; tear the other
    // down whenever either side goes away, for ANY reason. A clean client
    // disconnect only fires 'end' (a half-close FIN) on this socket, not
    // 'close'/'error' — listening only for those left the writable side fed
    // by upstreamSocket.pipe(socket) open forever, so upstreamSocket (and so
    // the whole HTTP server) never fully closed, hanging server.close().
    const teardown = (): void => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.once('error', teardown);
    upstreamSocket.once('close', teardown);
    upstreamSocket.once('end', teardown);
    socket.once('error', teardown);
    socket.once('close', teardown);
    socket.once('end', teardown);
  });
  upstreamReq.on('response', (upstreamRes) => {
    // Upstream answered a normal response instead of upgrading; relay it
    // sanitized and close rather than leaving the client hanging.
    const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers, sessionId, resolved.port);
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage || ''}\r\n`;
    socket.write(statusLine + serializeHeaders(responseHeaders) + '\r\n\r\n');
    upstreamRes.pipe(socket);
  });
  upstreamReq.on('error', () => socket.destroy());
  socket.on('error', () => upstreamReq.destroy());
  upstreamReq.end();
}

/** Serializes a sanitized header map back into raw HTTP header lines for a
 * hand-written response on a hijacked upgrade socket. */
function serializeHeaders(headers: Record<string, string | string[]>): string {
  return Object.entries(headers)
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((entry) => `${key}: ${entry}`),
    )
    .join('\r\n');
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

/** Drops the proxy's own pv_<sessionId> auth cookie from a Cookie header before
 * it reaches the untrusted upstream, while preserving any other cookies the
 * previewed app set for itself. Returns undefined when nothing else remains, so
 * the caller can omit the Cookie header entirely. */
function stripPreviewCookie(
  cookieHeader: string | string[] | undefined,
  sessionId: string,
): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const flat = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  const name = `pv_${sessionId}`;
  const kept = flat
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.split('=')[0]?.trim() !== name);
  return kept.length ? kept.join('; ') : undefined;
}

// ponytail: URLSearchParams re-encodes the surviving params (spec-normalized);
// exact byte preservation isn't needed for a loopback preview proxy.
function strippedSearch(params: URLSearchParams): string {
  const copy = new URLSearchParams(params);
  copy.delete('token');
  const qs = copy.toString();
  return qs ? `?${qs}` : '';
}

function sanitizeRequestHeaders(
  headers: IncomingHttpHeaders,
  sessionId: string,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === 'host')
      continue;
    if (key.toLowerCase() === 'cookie') {
      const cookie = stripPreviewCookie(value, sessionId);
      if (cookie) result.cookie = cookie;
      continue;
    }
    result[key] = value;
  }
  result.host = '127.0.0.1';
  return result;
}

// Response headers that can carry an absolute URL with the internal upstream
// port; all are run through the same containment logic so none leaks the port.
const URL_BEARING_HEADERS = ['location', 'content-location', 'refresh', 'link'];

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
  for (const name of URL_BEARING_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') {
      result[name] = rewriteLocation(value, sessionId, upstreamPort);
    }
  }
  // Defense-in-depth backstop: drop any *other* header whose value embeds the
  // internal upstream address, so a header nobody thought to enumerate can't
  // leak the port. URL_BEARING_HEADERS are already rewritten port-free above.
  const leaks = [`127.0.0.1:${upstreamPort}`, `localhost:${upstreamPort}`];
  for (const [key, value] of Object.entries(result)) {
    if (URL_BEARING_HEADERS.includes(key.toLowerCase())) continue;
    const flat = Array.isArray(value) ? value.join(', ') : value;
    if (leaks.some((needle) => flat.includes(needle))) delete result[key];
  }
  return result;
}

/** Relative locations are rebased under the proxy prefix; absolute locations pointing anywhere but this session's own upstream are dropped rather than followed, so a compromised preview process can't redirect through the trusted proxy origin.
 * ponytail: the relative-rebase branch doesn't scrub an absolute same-host URL embedded in the redirect's own query string (e.g. `Location: /foo?next=http://127.0.0.1:<port>/bar`); low-severity port-leak edge case under this tool's loopback/single-operator threat model. Upgrade: parse and recursively sanitize URL-shaped query values if this tool is ever exposed beyond loopback. */
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
