import Fastify from 'fastify';
import type { User } from '@supabase/supabase-js';
import { env } from './env.js';
import { createRequestClient, type RequestSupabaseClient } from './supabase.js';

declare module 'fastify' {
  interface FastifyRequest {
    supabase: RequestSupabaseClient;
    user: User;
  }
}

// The browser talks only to this tier (ADR 0038). Data access belongs here,
// behind a Supabase client built per request from the caller's access token —
// never a module-level singleton, which would carry one caller's token into
// another caller's request.
const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

// Every data route lives inside this scope, authenticated by default: the
// hook rejects a request without a valid token before any handler runs, and
// hands the handler a client that reads as the caller under RLS. A forgotten
// authorization check in a handler here returns an empty result, not another
// tenant's rows (ADR 0038).
await app.register(async (protectedRoutes) => {
  protectedRoutes.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      return reply.code(401).send({ error: 'Missing bearer token.' });
    }
    const supabase = createRequestClient(token);
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      return reply.code(401).send({ error: 'Invalid or expired token.' });
    }
    request.supabase = supabase;
    request.user = data.user;
  });

  protectedRoutes.get('/items', async (request) => {
    // No user_id filter on purpose: the RLS policies are the authorization,
    // and this route is the seed data's proof they hold per caller.
    const { data, error } = await request.supabase
      .from('items')
      .select('id, title')
      .order('created_at', { ascending: true });
    if (error) {
      throw new Error(`Reading items failed: ${error.message}`);
    }
    return { items: data };
  });
});

// `API_PORT`, not `PORT`: both tiers start from one `pnpm dev`, and the
// preview runner hands that process a single reserved `PORT` — which belongs
// to the browsable tier.
await app.listen({ port: env.apiPort, host: '127.0.0.1' });
