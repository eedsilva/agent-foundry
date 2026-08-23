import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CONTROL_SESSION_COOKIE,
  CONTROL_SESSION_CSRF_COOKIE,
  CONTROL_SESSION_CSRF_HEADER,
  CONTROL_SESSION_INSTALLATION_HEADER,
} from '@agent-foundry/contracts';
import { createFixedWindowRateLimiter } from './rate-limit.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CONTROL_SESSION_REQUESTS_PER_MINUTE = 300;

export interface ControlSession {
  readonly bootstrapToken: string;
  bootstrap(token: string | undefined): { sessionToken: string; csrfToken: string } | null;
  bootstrapInstallation(
    secret: string | undefined,
  ): { sessionToken: string; csrfToken: string } | null;
  authorize(
    cookieHeader: string | undefined,
    csrfHeader: string | undefined,
    method: string,
  ): 'authorized' | 'unauthorized' | 'invalid-csrf';
}

export function createControlSession(installationSecret: string): ControlSession {
  const nonce = randomBytes(32).toString('hex');
  const bootstrapToken = `${nonce}.${createHmac('sha256', installationSecret).update(nonce).digest('hex')}`;
  const sessionToken = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  let bootstrapAvailable = true;

  return {
    bootstrapToken,
    bootstrap(token) {
      if (!bootstrapAvailable || !equalToken(token, bootstrapToken)) return null;
      bootstrapAvailable = false;
      return { sessionToken, csrfToken };
    },
    bootstrapInstallation(secret) {
      if (!equalToken(secret, installationSecret)) return null;
      return { sessionToken, csrfToken };
    },
    authorize(cookieHeader, csrfHeader, method) {
      if (!equalToken(readCookie(cookieHeader, CONTROL_SESSION_COOKIE), sessionToken)) {
        return 'unauthorized';
      }
      if (MUTATING_METHODS.has(method) && !equalToken(csrfHeader, csrfToken)) {
        return 'invalid-csrf';
      }
      return 'authorized';
    },
  };
}

export function registerControlSession(
  app: FastifyInstance,
  session: ControlSession,
  webOrigin: string,
  now?: () => number,
): void {
  const rateLimiter = createFixedWindowRateLimiter(
    CONTROL_SESSION_REQUESTS_PER_MINUTE,
    60_000,
    now,
  );
  app.get('/auth/bootstrap', (request, reply) => {
    if (!rateLimiter.allow(request.ip)) {
      return reply.status(429).send({ error: 'RateLimited', message: 'Too many requests.' });
    }
    const token = (request.query as { token?: string }).token;
    const established = session.bootstrap(token);
    if (!established) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid bootstrap token.' });
    }
    reply.header('cache-control', 'no-store');
    reply.header('set-cookie', [
      `${CONTROL_SESSION_COOKIE}=${established.sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
      `${CONTROL_SESSION_CSRF_COOKIE}=${established.csrfToken}; Path=/; SameSite=Lax`,
    ]);
    return reply.redirect(webOrigin);
  });

  app.post('/auth/terminal-bootstrap', (request, reply) => {
    if (!rateLimiter.allow(request.ip)) {
      return reply.status(429).send({ error: 'RateLimited', message: 'Too many requests.' });
    }
    const presented = request.headers[CONTROL_SESSION_INSTALLATION_HEADER];
    const established = session.bootstrapInstallation(
      Array.isArray(presented) ? presented[0] : presented,
    );
    if (!established) {
      return reply
        .status(401)
        .send({ error: 'Unauthorized', message: 'Invalid installation secret.' });
    }
    reply.header('cache-control', 'no-store');
    return established;
  });

  app.addHook('onRequest', (request, reply, done) => {
    if (
      request.method === 'OPTIONS' ||
      request.routeOptions.url === '/auth/bootstrap' ||
      request.routeOptions.url === '/auth/terminal-bootstrap' ||
      request.routeOptions.url === '/health' ||
      request.routeOptions.url === '/ready' ||
      request.url === '/preview' ||
      request.url.startsWith('/preview/')
    ) {
      done();
      return;
    }
    const csrf = request.headers[CONTROL_SESSION_CSRF_HEADER];
    const verdict = session.authorize(
      request.headers.cookie,
      Array.isArray(csrf) ? csrf[0] : csrf,
      request.method,
    );
    if (verdict === 'authorized') {
      done();
      return;
    }
    const status = verdict === 'unauthorized' ? 401 : 403;
    void reply.status(status).send({
      error: verdict === 'unauthorized' ? 'Unauthorized' : 'InvalidCsrf',
      message:
        verdict === 'unauthorized'
          ? 'A valid Control Session is required.'
          : 'A valid CSRF token is required.',
    });
  });
}

function equalToken(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}
