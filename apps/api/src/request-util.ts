import type { FastifyRequest } from 'fastify';

/** The captured segment of a Fastify `/*` wildcard route param. */
export function wildcardParam(request: FastifyRequest): string {
  return (request.params as { '*'?: string })['*'] ?? '';
}
