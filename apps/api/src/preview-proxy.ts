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

  app.all('/preview/:sessionId', (request, reply) =>
    handleHttp(request, reply, runtime, allowedPort),
  );
  app.all('/preview/:sessionId/*', (request, reply) =>
    handleHttp(request, reply, runtime, allowedPort),
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
): Promise<void> {
  // DNS-rebinding defense: reject anything whose Host header isn't this API's own
  // loopback host:port. This runs BEFORE any token check or upstream connection.
  if (!isAllowedHost(request.headers.host, allowedPort)) {
    await reply.status(400).send({ error: 'InvalidHost', message: 'Unexpected Host header.' });
    return;
  }
  const { sessionId } = request.params as { sessionId: string };
  const upstreamPath = '/' + ((request.params as { '*'?: string })['*'] ?? '');
  const query = (request.query as Record<string, string>) ?? {};
  const cookieToken = readCookieToken(request.headers.cookie, sessionId);
  const presentedToken = cookieToken ?? query.token;

  let resolved: { port: number };
  try {
    resolved = await runtime.previewService.resolveUpstream(sessionId, presentedToken);
  } catch (error) {
    if (error instanceof NotFoundError)
      return void reply.status(404).send({ error: error.name, message: error.message });
    if (error instanceof PreviewAccessDeniedError)
      return void reply.status(403).send({ error: error.name, message: error.message });
    throw error;
  }

  const cookieValue = cookieToken
    ? undefined
    : runtime.previewService.issueCookieToken(sessionId, query.token);
  reply.hijack();
  const raw = reply.raw;
  // The proxy auth token is proxy-internal; strip it so the untrusted upstream
  // process never receives it (and so exact-path upstream routing still works).
  const search = strippedSearch(new URL(request.url, 'http://internal').searchParams);
  const upstreamReq = httpRequest(
    {
      host: '127.0.0.1',
      port: resolved.port,
      method: request.method,
      path: upstreamPath + search,
      headers: sanitizeRequestHeaders(request.headers, sessionId),
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
    headers['set-cookie'] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), cookie]
      : cookie;
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
    socket.destroy();
    return;
  }
  const search = strippedSearch(url.searchParams);
  const upstream = connect(resolved.port, '127.0.0.1', () => {
    const requestLine = `${req.method} ${rest || '/'}${search} HTTP/1.1\r\n`;
    const headerLines = Object.entries(req.headers)
      .filter(([key]) => {
        const lower = key.toLowerCase();
        // Drop hop-by-hop headers (except Upgrade) and the client Host; both are
        // overridden below so the untrusted upstream never sees the client's Host.
        return (!HOP_BY_HOP.has(lower) || lower === 'upgrade') && lower !== 'host';
      })
      .flatMap(([key, value]) => {
        if (key.toLowerCase() === 'cookie') {
          const cookie = stripPreviewCookie(value, sessionId);
          return cookie ? [`cookie: ${cookie}`] : [];
        }
        return [`${key}: ${Array.isArray(value) ? value.join(', ') : value}`];
      })
      .concat('Host: 127.0.0.1', 'Connection: Upgrade')
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
  headers: FastifyRequest['headers'],
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
