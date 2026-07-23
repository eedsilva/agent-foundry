export const GENERATED_STORAGE_BUCKET = 'uploads';
export const GENERATED_STORAGE_MAX_BYTES = 10 * 1024 * 1024;
export const GENERATED_STORAGE_MIGRATION = '00000000000000_agent_foundry_storage.sql';

const STORAGE_CONFIG = `[storage.buckets.${GENERATED_STORAGE_BUCKET}]
public = false
file_size_limit = "10MiB"
allowed_mime_types = ["image/png", "image/jpeg", "application/pdf"]
`;

export function configureGeneratedStorage(config: string): string {
  const sections = [
    ...config.matchAll(
      /^[ \t]*\[[ \t]*(?:storage|'storage'|"storage")[ \t]*\.[ \t]*(?:buckets|'buckets'|"buckets")[ \t]*\.[ \t]*(?:uploads|'uploads'|"uploads")[ \t]*\][ \t]*(?:#.*)?\r?$/gm,
    ),
  ];
  if (sections.length === 0) return `${config}\n${STORAGE_CONFIG}`;

  const start = sections[0]!.index;
  const afterHeader = start + sections[0]![0].length;
  const nextSection = config
    .slice(afterHeader)
    .search(/\r?\n(?=[ \t]*\[\[?[^\]\r\n]+\]\]?[ \t]*(?:#.*)?\r?(?:\n|$))/);
  const end = nextSection === -1 ? config.length : afterHeader + nextSection;
  if (sections.length === 1 && config.slice(start, end).trimEnd() === STORAGE_CONFIG.trimEnd()) {
    return config;
  }

  throw new Error('Generated Supabase uploads bucket configuration is incompatible.');
}

export function generatedStorageMigration(): string {
  return `create type public.storage_scan_status as enum ('quarantine', 'clean', 'rejected');

create table public.storage_uploads (
  object_name text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  media_type text not null check (
    media_type in ('image/png', 'image/jpeg', 'application/pdf')
  ),
  size_bytes bigint not null check (size_bytes between 1 and ${GENERATED_STORAGE_MAX_BYTES}),
  scan_status public.storage_scan_status not null default 'quarantine',
  retain_until timestamptz not null,
  exported_at timestamptz,
  created_at timestamptz not null default now(),
  check (object_name like owner_id::text || '/%')
);

alter table public.storage_uploads enable row level security;

create policy storage_upload_owner_select
  on public.storage_uploads for select to authenticated
  using (owner_id = (select auth.uid()));

create policy storage_upload_owner_insert
  on public.storage_uploads for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and object_name like (select auth.uid())::text || '/%'
  );

create policy storage_upload_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = '${GENERATED_STORAGE_BUCKET}'
    and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
    and exists (
      select 1
      from public.storage_uploads upload
      where upload.object_name = name
        and upload.owner_id = (select auth.uid())
        and upload.scan_status = 'quarantine'
    )
  );

create policy storage_clean_owner_select
  on storage.objects for select to authenticated
  using (
    bucket_id = '${GENERATED_STORAGE_BUCKET}'
    and owner_id = (select auth.jwt()->>'sub')
    and exists (
      select 1
      from public.storage_uploads upload
      where upload.object_name = name
        and upload.owner_id = (select auth.uid())
        and upload.scan_status = 'clean'
    )
  );

create function public.prepare_storage_upload(
  p_object_name text,
  p_media_type text,
  p_size_bytes bigint,
  p_retention_seconds integer default 2592000
)
returns public.storage_uploads
language plpgsql
security definer
set search_path = ''
as $$
declare
  upload public.storage_uploads;
begin
  if p_retention_seconds < 1 or p_retention_seconds > 31536000 then
    raise exception 'Storage retention must be between 1 and 31536000 seconds.';
  end if;

  insert into public.storage_uploads (
    object_name,
    owner_id,
    media_type,
    size_bytes,
    retain_until
  )
  values (
    p_object_name,
    auth.uid(),
    p_media_type,
    p_size_bytes,
    now() + pg_catalog.make_interval(secs => p_retention_seconds)
  )
  returning * into upload;

  return upload;
end;
$$;

revoke execute on function public.prepare_storage_upload(text, text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.prepare_storage_upload(text, text, bigint, integer)
  to authenticated;

create view public.storage_scan_queue as
select *
from public.storage_uploads
where scan_status = 'quarantine';

revoke all on public.storage_scan_queue from public, anon, authenticated;
grant select on public.storage_scan_queue to service_role;

create function public.complete_storage_scan(
  p_object_name text,
  p_status public.storage_scan_status
)
returns public.storage_uploads
language plpgsql
security definer
set search_path = ''
as $$
declare
  upload public.storage_uploads;
begin
  if p_status not in ('clean', 'rejected') then
    raise exception 'Storage scan status must be clean or rejected.';
  end if;

  update public.storage_uploads
  set scan_status = p_status
  where object_name = p_object_name
  returning * into upload;

  if not found then
    raise exception 'Storage upload not found.';
  end if;

  return upload;
end;
$$;

revoke execute on function public.complete_storage_scan(text, public.storage_scan_status)
  from public, anon, authenticated;
grant execute on function public.complete_storage_scan(text, public.storage_scan_status)
  to service_role;

create function public.storage_export_manifest()
returns setof public.storage_uploads
language sql
stable
security definer
set search_path = ''
as $$
  select upload.*
  from public.storage_uploads upload
  where upload.owner_id = auth.uid()
    and upload.scan_status = 'clean'
    and upload.retain_until > now()
$$;

revoke execute on function public.storage_export_manifest()
  from public, anon, authenticated;
grant execute on function public.storage_export_manifest()
  to authenticated;

create function public.confirm_storage_export(p_object_names text[])
returns setof public.storage_uploads
language sql
security definer
set search_path = ''
as $$
  update public.storage_uploads
  set exported_at = now()
  where owner_id = auth.uid()
    and scan_status = 'clean'
    and object_name = any(p_object_names)
  returning *
$$;

revoke execute on function public.confirm_storage_export(text[])
  from public, anon, authenticated;
grant execute on function public.confirm_storage_export(text[])
  to authenticated;

create function public.storage_cleanup_candidates()
returns setof public.storage_uploads
language sql
stable
security definer
set search_path = ''
as $$
  select upload.*
  from public.storage_uploads upload
  where upload.retain_until <= now()
    and (
      upload.scan_status = 'rejected'
      or (upload.scan_status = 'clean' and upload.exported_at is not null)
    )
$$;

revoke execute on function public.storage_cleanup_candidates()
  from public, anon, authenticated;
grant execute on function public.storage_cleanup_candidates()
  to service_role;

create function public.confirm_storage_cleanup(p_object_name text)
returns public.storage_uploads
language plpgsql
security definer
set search_path = ''
as $$
declare
  upload public.storage_uploads;
begin
  delete from public.storage_uploads metadata
  where metadata.object_name = p_object_name
    and metadata.retain_until <= now()
    and (
      metadata.scan_status = 'rejected'
      or (metadata.scan_status = 'clean' and metadata.exported_at is not null)
    )
    and not exists (
      select 1
      from storage.objects object
      where object.bucket_id = '${GENERATED_STORAGE_BUCKET}'
        and object.name = metadata.object_name
    )
  returning metadata.* into upload;

  if not found then
    raise exception 'Storage upload is not ready for cleanup confirmation.';
  end if;

  return upload;
end;
$$;

revoke execute on function public.confirm_storage_cleanup(text)
  from public, anon, authenticated;
grant execute on function public.confirm_storage_cleanup(text)
  to service_role;
`;
}
