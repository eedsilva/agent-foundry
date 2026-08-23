import { Hono } from 'hono';
import type { RuntimeEnv } from './runtime-env.js';
import { createRequestClient } from './supabase.js';

type ApiEnv = {
  Bindings: RuntimeEnv;
  Variables: {
    supabase: ReturnType<typeof createRequestClient>;
  };
};

export const app = new Hono<ApiEnv>();

// Minimum scaffold contract, shared by both runtime entry points:
// GET /health -> { status: "ok" }
app.get('/health', (c) => c.json({ status: 'ok' }));

// Every data route is authenticated by default. Supabase RLS remains the
// authorization boundary; this middleware only forwards the caller token.
app.use('/items', async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) return c.json({ error: 'Missing bearer token.' }, 401);

  const supabase = createRequestClient(token, c.env);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return c.json({ error: 'Invalid or expired token.' }, 401);

  c.set('supabase', supabase);
  await next();
});

app.get('/items', async (c) => {
  const { data, error } = await c
    .get('supabase')
    .from('items')
    .select('id, title')
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'Reading items failed.' }, 500);
  return c.json({ items: data });
});

app.post('/items', async (c) => {
  let body: { title?: unknown } | undefined;
  try {
    body = await c.req.json<{ title?: unknown }>();
  } catch {
    body = undefined;
  }
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) return c.json({ error: 'Item title is required.' }, 400);

  const { data, error } = await c
    .get('supabase')
    .from('items')
    .insert({ title })
    .select('id, title')
    .single();
  if (error) return c.json({ error: 'Creating item failed.' }, 500);
  return c.json({ item: data }, 201);
});

export function createNodeHandler(runtimeEnv: RuntimeEnv) {
  return (request: Request) => app.fetch(request, runtimeEnv);
}
