-- Completes the counter data model. `public.counter`, its `counter_singleton`
-- check constraint, row level security, and the `counter_select_public` policy
-- are already created by 20260813061809_schema_plan.sql and are not redefined
-- here; this migration adds only what the schema-plan artifact format cannot
-- express, and removes the scaffold's demo table.

-- The single row lives in a migration rather than in supabase/seed.sql so that
-- every environment has it — seed.sql runs locally only. The check constraint
-- `id = 1` plus the primary key make a second row structurally impossible, so
-- this insert is also the last one the table will ever accept.
insert into public.counter (id, value) values (1, 0);

-- The schema-plan format has no way to state a policy's target roles, so
-- `counter_select_public` was created without a `to` clause and therefore
-- applies to PUBLIC. Narrow it to the two roles PostgREST authenticates as.
alter policy counter_select_public on public.counter to anon, authenticated;

-- The only path that can change the value. `public.counter` has a select policy
-- and deliberately no insert/update/delete policy, so row level security denies
-- every direct write, including an anon `PATCH /rest/v1/counter`. This function
-- runs as its owner instead and adds exactly 1, which is what structurally
-- rules out the decrement and the reset the PRD excludes. One
-- `update ... returning` is a single atomic statement, so two simultaneous
-- clicks cannot lose an increment the way a read-then-write in application code
-- would.
--
-- search_path is pinned to '' so nothing on the caller's path can be resolved
-- inside a definer function. `public.counter` is schema-qualified for that
-- reason; `now()` needs no qualification because pg_catalog is always searched
-- implicitly, whatever search_path says.
create function public.increment_counter()
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.counter
  set value = value + 1, updated_at = now()
  where id = 1
  returning value;
$$;

-- `create function` grants execute to PUBLIC by default, which would hand the
-- one write path to every role in the database. Take it back, then hand it to
-- exactly the two roles that need it.
revoke execute on function public.increment_counter() from public;
grant execute on function public.increment_counter() to anon, authenticated;

-- The scaffold's demo table, whose own migration header says to replace it in a
-- forward migration. 20260726000000_rls_baseline.sql stays untouched. Dropping
-- the table drops its index and its four owner policies with it, and
-- supabase/seed.sql stops inserting into it in this same change so that
-- `pnpm db:reset` still succeeds.
drop table public.items;
