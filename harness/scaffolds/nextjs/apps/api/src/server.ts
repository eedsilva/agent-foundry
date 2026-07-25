import Fastify from 'fastify';

// The browser talks only to this tier (ADR 0038). Data access belongs here,
// behind a Supabase client built per request from the caller's access token —
// never a module-level singleton, which would carry one caller's token into
// another caller's request.
const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

// `API_PORT`, not `PORT`: both tiers start from one `pnpm dev`, and the
// preview runner hands that process a single reserved `PORT` — which belongs
// to the browsable tier.
const port = Number(process.env.API_PORT ?? 3001);
await app.listen({ port, host: '127.0.0.1' });
