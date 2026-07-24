create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  name text not null check (char_length(name) between 1 and 140),
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;

create policy projects_select_owner
  on public.projects for select to authenticated
  using (owner_id = (select auth.uid()));

create policy projects_insert_owner
  on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy projects_update_owner
  on public.projects for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy projects_delete_owner
  on public.projects for delete to authenticated
  using (owner_id = (select auth.uid()));

create type public.issue_priority as enum ('low', 'medium', 'high', 'critical');
create type public.issue_status as enum ('open', 'in_progress', 'completed');

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) default auth.uid(),
  title text not null check (char_length(title) between 1 and 140),
  description text not null default '',
  priority public.issue_priority not null default 'medium',
  status public.issue_status not null default 'open',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.issues enable row level security;

create policy issues_select_owner
  on public.issues for select to authenticated
  using (owner_id = (select auth.uid()));

create policy issues_insert_owner
  on public.issues for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy issues_update_owner
  on public.issues for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy issues_delete_owner
  on public.issues for delete to authenticated
  using (owner_id = (select auth.uid()));

create table public.issue_attachments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  owner_id uuid not null references auth.users(id) default auth.uid(),
  object_name text not null references public.storage_uploads(object_name) on delete cascade,
  created_at timestamptz not null default now(),
  unique (issue_id, object_name)
);

alter table public.issue_attachments enable row level security;

create policy issue_attachments_select_owner
  on public.issue_attachments for select to authenticated
  using (owner_id = (select auth.uid()));

create policy issue_attachments_insert_owner
  on public.issue_attachments for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy issue_attachments_delete_owner
  on public.issue_attachments for delete to authenticated
  using (owner_id = (select auth.uid()));
