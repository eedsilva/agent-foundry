-- Generated from the approved schema plan artifact (schemaVersion 1). Forward-only; do not edit by hand.
create table if not exists public.counter ( id integer not null default 1, value integer not null default 0, updated_at timestamptz not null default now(), primary key (id), constraint counter_singleton check (id = 1) );
alter table public.counter enable row level security;
drop policy if exists counter_select_public on public.counter;
create policy counter_select_public on public.counter for select using (true);