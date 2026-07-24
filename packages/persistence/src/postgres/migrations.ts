export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-metadata-schema',
    up: /* sql */ `
create domain path_segment as text
  check (value ~ '^[A-Za-z0-9._-]{1,200}$' and value not in ('.', '..'));

create type project_status as enum
  ('queued','running','paused','awaiting_approval','completed','failed','cancelled','rejected');
create type workflow_run_status as enum
  ('queued','running','pause_requested','paused','awaiting_approval','cancel_requested','cancelled','completed','failed','rejected');
create type step_run_status as enum
  ('pending','running','completed','failed','cancelled','skipped');
create type step_attempt_status as enum
  ('running','succeeded','failed','cancelled');

create table projects (
  id path_segment primary key,
  status project_status not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null
);
create index projects_created_at_idx on projects (created_at desc, id desc);

create table workflow_runs (
  id path_segment primary key,
  project_id path_segment not null references projects (id) on delete cascade,
  status workflow_run_status not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null
);
create index workflow_runs_project_idx on workflow_runs (project_id, created_at desc, id desc);

create table step_runs (
  id path_segment not null,
  run_id path_segment not null references workflow_runs (id) on delete cascade,
  status step_run_status not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null,
  primary key (run_id, id)
);

create table step_attempts (
  id path_segment not null,
  run_id path_segment not null,
  step_run_id path_segment not null,
  sequence integer not null check (sequence >= 1),
  status step_attempt_status not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null,
  primary key (run_id, step_run_id, id),
  foreign key (run_id, step_run_id) references step_runs (run_id, id) on delete cascade
);

create table approval_requests (
  request_id path_segment not null,
  run_id path_segment not null references workflow_runs (id) on delete cascade,
  step_run_id path_segment not null,
  created_at timestamptz not null,
  data jsonb not null,
  primary key (run_id, request_id)
);
create index approval_requests_step_idx on approval_requests (run_id, step_run_id);

create table approval_decisions (
  request_id path_segment not null,
  run_id path_segment not null,
  created_at timestamptz not null,
  data jsonb not null,
  primary key (run_id, request_id),
  foreign key (run_id, request_id) references approval_requests (run_id, request_id) on delete cascade
);

create table project_events (
  id path_segment primary key,
  project_id path_segment not null references projects (id) on delete cascade,
  run_id path_segment,
  type text not null,
  dedupe_key text,
  created_at timestamptz not null,
  data jsonb not null
);
create index project_events_project_id_idx on project_events (project_id, id);
create unique index project_events_dedupe_idx
  on project_events (project_id, dedupe_key) where dedupe_key is not null;

create table step_events (
  run_id path_segment not null,
  sequence integer not null check (sequence >= 1),
  data jsonb not null,
  primary key (run_id, sequence)
);

create table conversations (
  project_id path_segment primary key references projects (id) on delete cascade,
  data jsonb not null
);

create table conversation_messages (
  project_id path_segment not null references conversations (project_id) on delete cascade,
  sequence integer not null check (sequence >= 1),
  id path_segment not null unique,
  data jsonb not null,
  primary key (project_id, sequence)
);

create table conversation_attachments (
  id path_segment primary key,
  project_id path_segment not null references conversations (project_id) on delete cascade,
  created_at timestamptz not null,
  data jsonb not null
);
create index conversation_attachments_project_idx on conversation_attachments (project_id, created_at, id);

create table conversation_operations (
  id path_segment primary key,
  project_id path_segment not null references conversations (project_id) on delete cascade,
  idempotency_key text not null,
  created_at timestamptz not null,
  data jsonb not null
);
create index conversation_operations_project_idx on conversation_operations (project_id, created_at, id);
create index conversation_operations_idem_idx on conversation_operations (project_id, idempotency_key);

create table conversation_change_requests (
  id path_segment primary key,
  project_id path_segment not null references conversations (project_id) on delete cascade,
  created_at timestamptz not null,
  data jsonb not null
);
create index conversation_change_requests_project_idx on conversation_change_requests (project_id, created_at, id);

create table artifacts (
  project_id path_segment not null references projects (id) on delete cascade,
  name path_segment not null,
  revision integer not null check (revision >= 1),
  sha256 text not null,
  idempotency_key text,
  source_decision_id text,
  storage text not null default 'inline' check (storage in ('inline','blob')),
  blob_deleted boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null,
  content jsonb,
  data jsonb not null,
  primary key (project_id, name, revision)
);
create index artifacts_expiry_idx on artifacts (expires_at)
  where storage = 'blob' and blob_deleted = false and expires_at is not null;

create table artifact_blobs (
  project_id path_segment not null,
  name path_segment not null,
  revision integer not null,
  bytes bytea not null,
  primary key (project_id, name, revision),
  foreign key (project_id, name, revision)
    references artifacts (project_id, name, revision) on delete cascade
);
`,
    down: /* sql */ `
drop table if exists artifact_blobs;
drop table if exists artifacts;
drop table if exists conversation_change_requests;
drop table if exists conversation_operations;
drop table if exists conversation_attachments;
drop table if exists conversation_messages;
drop table if exists conversations;
drop table if exists step_events;
drop table if exists project_events;
drop table if exists approval_decisions;
drop table if exists approval_requests;
drop table if exists step_attempts;
drop table if exists step_runs;
drop table if exists workflow_runs;
drop table if exists projects;
drop type if exists step_attempt_status;
drop type if exists step_run_status;
drop type if exists workflow_run_status;
drop type if exists project_status;
drop domain if exists path_segment;
`,
  },
  {
    version: 2,
    name: 'durable-queue',
    up: /* sql */ `
create type job_status as enum ('pending','processing','completed','failed');

create table jobs (
  id path_segment primary key,
  type text not null check (type in ('run-project','run-conversation-operation')),
  project_id path_segment not null,
  workflow_id path_segment not null,
  run_id path_segment,
  operation_id path_segment,
  status job_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null check (max_attempts >= 1),
  created_at timestamptz not null,
  available_at timestamptz not null,
  last_error text,
  lease_epoch integer not null default 0 check (lease_epoch >= 0),
  worker_id text,
  fencing_token integer,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  trace_context jsonb
);
create index jobs_claim_idx on jobs (available_at, id) where status = 'pending';
create index jobs_reap_idx  on jobs (expires_at)       where status = 'processing';
`,
    down: /* sql */ `
drop table if exists jobs;
drop type if exists job_status;
`,
  },
];
