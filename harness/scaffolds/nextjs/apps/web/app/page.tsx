import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { EmptyState } from '../components/empty-state';
import { Button } from '../components/ui/button';
import { createItem, signOut } from './actions';

// The web tier never queries the database (ADR 0038): it asks the API tier
// with the caller's access token, and the API reads as that user under RLS.
async function fetchItems(accessToken: string): Promise<Array<{ id: string; title: string }>> {
  // ponytail: loopback works for dev, smoke, and the preview runner, which
  // start both tiers in one process tree. The Compose deployment (ADR 0008)
  // puts the API in its own container and will need an API_URL env instead.
  const apiPort = process.env.API_PORT || '3001';
  const items: Array<{ id: string; title: string }> = [];
  let cursor: string | undefined;

  for (;;) {
    const url = new URL(`http://127.0.0.1:${apiPort}/items`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`The API tier answered HTTP ${response.status} for /items.`);
    }
    const body = (await response.json()) as {
      items: Array<{ id: string; title: string }>;
      nextCursor: string | null;
    };
    items.push(...body.items);
    if (!body.nextCursor) return items;
    if (body.nextCursor === cursor)
      throw new Error('The API tier returned a repeated items cursor.');
    cursor = body.nextCursor;
  }
}

export default async function HomePage() {
  // getSession is a local cookie read, not a verification — that already
  // happened twice on this request: proxy called getUser, and the API
  // tier validates the forwarded token again before touching data.
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect('/sign-in');
  }

  const items = await fetchItems(session.access_token);

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Your items</h1>
      <p className="text-sm text-muted-foreground">{session.user.email}</p>
      {items.length === 0 ? (
        <EmptyState title="No items yet" hint="Items you create will show up here." />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="rounded border px-3 py-2">
              {item.title}
            </li>
          ))}
        </ul>
      )}
      <form action={createItem} className="flex flex-col gap-2">
        <label htmlFor="item-title" className="text-sm font-medium">
          New item
        </label>
        <div className="flex gap-2">
          <input
            id="item-title"
            name="title"
            required
            className="min-w-0 flex-1 rounded border px-3 py-2"
          />
          <Button type="submit">Add item</Button>
        </div>
      </form>
      <form action={signOut}>
        <Button type="submit">Sign out</Button>
      </form>
    </div>
  );
}
