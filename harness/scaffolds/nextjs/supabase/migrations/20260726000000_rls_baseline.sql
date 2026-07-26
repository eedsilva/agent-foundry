-- The baseline every generated table copies: one owner column, row level
-- security enabled in the same migration that creates the table, and exactly
-- the four owner-scoped policies the app needs. A table with RLS enabled and
-- no policy denies everything, which is the direction to fail in (ADR 0038).
--
-- `items` exists so turn zero has a table, seeded rows, and generated types
-- before any agent runs. Rename or replace it in a new forward-only migration
-- (ADR 0031); never edit this one once it has been applied.

create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title text not null,
  created_at timestamptz not null default now()
);

-- Every policy below filters on user_id, so Postgres reads this index instead
-- of the table on each of them.
create index items_user_id_idx on public.items (user_id);

alter table public.items enable row level security;

create policy items_select_owner on public.items for select to authenticated using (
  user_id = (select auth.uid())
);

create policy items_insert_owner on public.items for insert to authenticated with check (
  user_id = (select auth.uid())
);

create policy items_update_owner on public.items for update to authenticated using (
  user_id = (select auth.uid())
) with check (user_id = (select auth.uid()));

create policy items_delete_owner on public.items for delete to authenticated using (
  user_id = (select auth.uid())
);
