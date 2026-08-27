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

const DEFAULT_ITEMS_LIMIT = 25;
const MAX_ITEMS_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

type ItemsCursor = { createdAt: string; id: string };

export type ItemsQuery = { limit: number; cursor?: ItemsCursor };

function encodeCursor(cursor: ItemsCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(value: string): ItemsCursor {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error('invalid cursor');
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const decoded = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
  ) as {
    createdAt?: unknown;
    id?: unknown;
  };
  if (
    typeof decoded.createdAt !== 'string' ||
    !isValidCursorTimestamp(decoded.createdAt) ||
    typeof decoded.id !== 'string' ||
    !UUID.test(decoded.id)
  ) {
    throw new Error('invalid cursor');
  }
  return { createdAt: decoded.createdAt, id: decoded.id };
}

function isValidCursorTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendar.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return false;
  }
  if (zone !== 'Z') {
    const offset = zone.slice(1).split(':').map(Number);
    if (offset[0] > 23 || offset[1] > 59) return false;
  }
  return !Number.isNaN(new Date(value).getTime());
}

export function parseItemsQuery(input: {
  limit?: string;
  cursor?: string;
}): { ok: true; value: ItemsQuery } | { ok: false; error: string } {
  const rawLimit = input.limit;
  if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
    return { ok: false, error: 'Invalid item limit.' };
  }
  const limit = rawLimit === undefined ? DEFAULT_ITEMS_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS_LIMIT) {
    return { ok: false, error: 'Invalid item limit.' };
  }
  if (input.cursor === undefined) return { ok: true, value: { limit } };
  try {
    return { ok: true, value: { limit, cursor: decodeCursor(input.cursor) } };
  } catch {
    return { ok: false, error: 'Invalid item cursor.' };
  }
}

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
  const parsedQuery = parseItemsQuery({
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!parsedQuery.ok) return c.json({ error: parsedQuery.error }, 400);

  let query = c
    .get('supabase')
    .from('items')
    .select('id, title, created_at')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(parsedQuery.value.limit + 1);
  if (parsedQuery.value.cursor) {
    const { createdAt, id } = parsedQuery.value.cursor;
    query = query.or(`created_at.gt.${createdAt},and(created_at.eq.${createdAt},id.gt.${id})`);
  }

  const { data, error } = await query;
  if (error) return c.json({ error: 'Reading items failed.' }, 500);
  const rows = data ?? [];
  const items = rows.slice(0, parsedQuery.value.limit).map(({ id, title }) => ({ id, title }));
  const lastRow =
    rows.length > parsedQuery.value.limit ? rows[parsedQuery.value.limit - 1] : undefined;
  return c.json({
    items,
    nextCursor: lastRow ? encodeCursor({ createdAt: lastRow.created_at, id: lastRow.id }) : null,
  });
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
