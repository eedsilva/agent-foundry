import { describe, expect, it } from 'vitest';
import {
  GENERATED_STORAGE_BUCKET,
  GENERATED_STORAGE_MAX_BYTES,
  GENERATED_STORAGE_MIGRATION,
  configureGeneratedStorage,
  generatedStorageMigration,
} from './supabase-storage.js';

function assertStorageMetadataReadOnly(sql: string): void {
  const statements = sql
    .split(';')
    .map((statement) => statement.toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  for (const statement of statements) {
    if (
      /^create policy\b/.test(statement) &&
      /\bon\s+public\s*\.\s*storage_uploads\b/.test(statement)
    ) {
      const operation = statement.match(/\bfor\s+(all|select|insert|update|delete)\b/)?.[1];
      if (operation !== 'select') {
        throw new Error('Generated storage metadata must remain read-only.');
      }
    }

    const grant = statement.match(
      /^grant\s+(.+?)\s+on\s+(?:table\s+)?public\s*\.\s*storage_uploads\s+to\s+(.+)$/,
    );
    if (!grant) continue;

    const grantsMutation = grant[1]!
      .split(',')
      .some((privilege) =>
        /^(?:all(?: privileges)?|insert|update|delete)\b/.test(privilege.trim()),
      );
    const grantsLowRole = grant[2]!
      .replace(/\s+with grant option$/, '')
      .split(',')
      .some((role) => ['public', 'anon', 'authenticated'].includes(role.trim()));
    if (grantsMutation && grantsLowRole) {
      throw new Error('Generated storage metadata must remain read-only.');
    }
  }
}

describe('generated Supabase Storage artifacts', () => {
  it('adds one private uploads bucket with exact size and MIME limits', () => {
    const configured = configureGeneratedStorage('project_id = "supabase_project-a"\n');

    expect(GENERATED_STORAGE_BUCKET).toBe('uploads');
    expect(GENERATED_STORAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(GENERATED_STORAGE_MIGRATION).toBe('00000000000000_agent_foundry_storage.sql');
    expect(configured).toContain('[storage.buckets.uploads]');
    expect(configured).toContain('public = false');
    expect(configured).toContain('file_size_limit = "10MiB"');
    expect(configured).toContain(
      'allowed_mime_types = ["image/png", "image/jpeg", "application/pdf"]',
    );
    expect(configureGeneratedStorage(configured)).toBe(configured);
  });

  it('rejects an incompatible existing uploads bucket', () => {
    const incompatible = `project_id = "supabase_project-a"

[storage.buckets.uploads]
public = true
file_size_limit = "20MiB"
allowed_mime_types = ["text/plain"]
`;

    expect(() => configureGeneratedStorage(incompatible)).toThrowError(
      'Generated Supabase uploads bucket configuration is incompatible.',
    );
  });

  it.each([
    ['trailing comment', '[storage.buckets.uploads] # existing bucket'],
    ['quoted uploads key', '[storage.buckets."uploads"]'],
    ['whitespace around keys', '[ storage . buckets . uploads ]'],
    ['quoted parent keys', `['storage'."buckets".uploads]`],
  ])('rejects an incompatible equivalent uploads bucket with %s', (_, header) => {
    const incompatible = `project_id = "supabase_project-a"

${header}
public = true
`;

    expect(() => configureGeneratedStorage(incompatible)).toThrowError(
      'Generated Supabase uploads bucket configuration is incompatible.',
    );
  });

  it.each([
    [
      'renamed INSERT policy',
      `create policy renamed_metadata_write
         on public.storage_uploads for insert to authenticated
         with check (true);`,
    ],
    ['GRANT ALL', 'GRANT ALL ON TABLE public.storage_uploads TO authenticated;'],
    ['mixed-case DML grant', 'GrAnT UPDATE, DELETE ON public . storage_uploads TO PUBLIC, anon;'],
  ])('detects a malicious metadata permission mutation: %s', (_, mutation) => {
    expect(() =>
      assertStorageMetadataReadOnly(`${generatedStorageMigration()}\n${mutation}`),
    ).toThrowError('Generated storage metadata must remain read-only.');
  });

  it('generates owner RLS, quarantine, signed-read, export, and cleanup contracts', () => {
    const sql = generatedStorageMigration();

    assertStorageMetadataReadOnly(sql);

    for (const required of [
      "create type public.storage_scan_status as enum ('quarantine', 'clean', 'rejected')",
      'create table public.storage_uploads',
      "scan_status public.storage_scan_status not null default 'quarantine'",
      'retain_until timestamptz not null',
      'exported_at timestamptz',
      'alter table public.storage_uploads enable row level security',
      'create function public.prepare_storage_upload',
      "(storage.foldername(name))[1] = (select auth.jwt()->>'sub')",
      'create policy storage_upload_insert',
      'create policy storage_clean_owner_select',
      "scan_status = 'clean'",
      'create view public.storage_scan_queue',
      'create function public.complete_storage_scan',
      'create function public.storage_export_manifest',
      'create function public.confirm_storage_export',
      'create function public.storage_cleanup_candidates',
      'create function public.confirm_storage_cleanup',
      'grant execute on function public.complete_storage_scan',
      'to service_role',
    ]) {
      expect(sql.toLowerCase()).toContain(required.toLowerCase());
    }
    expect(sql).not.toMatch(/delete\s+from\s+storage\.objects/i);
    expect(sql).not.toMatch(/public\s*=\s*true/i);

    const normalized = sql
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
    expect(normalized).toContain(
      'revoke insert, update, delete on table public.storage_uploads from public, anon, authenticated;',
    );
    expect(normalized).toContain('grant select on table public.storage_uploads to authenticated;');
    expect(normalized).not.toContain('create policy storage_upload_owner_insert');
    expect(normalized).toContain(
      "(upload.scan_status = 'rejected' or (upload.scan_status = 'clean' and upload.exported_at is not null))",
    );
    expect(normalized).toContain(
      "(metadata.scan_status = 'rejected' or (metadata.scan_status = 'clean' and metadata.exported_at is not null))",
    );
    expect(normalized).not.toContain(
      "(upload.scan_status = 'rejected' or upload.exported_at is not null)",
    );
    expect(normalized).not.toContain(
      "(metadata.scan_status = 'rejected' or metadata.exported_at is not null)",
    );
  });
});
