import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecurityReportSchema } from '@agent-foundry/contracts';
import { destructiveStatements } from './supabase-runtime.js';
import { generatedStorageMigration } from './supabase-storage.js';
import { blocksRelease, lintMigrationsDir, lintMigrationsSql } from './security-lint.js';

// Minimal owner-RLS pattern, mirrors RLS_MIGRATION in supabase-auth.e2e.test.ts.
const CLEAN_RLS_MIGRATION = `create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  title text not null
);

alter table public.items enable row level security;

create policy items_select_owner
  on public.items for select to authenticated
  using (user_id = (select auth.uid()));

create policy items_insert_owner
  on public.items for insert to authenticated
  with check (user_id = (select auth.uid()));
`;

const MISSING_RLS_MIGRATION = `create table public.widgets (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
`;

const SENSITIVE_NO_POLICY_MIGRATION = `create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  body text not null
);

alter table public.notes enable row level security;
`;

const ANON_WRITE_POLICY_MIGRATION = `create table public.comments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  body text not null
);

alter table public.comments enable row level security;

create policy comments_insert_anon
  on public.comments for insert to anon
  with check (true);
`;

const ANON_GRANT_MIGRATION = `create table public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  body text not null
);

alter table public.messages enable row level security;

create policy messages_select_owner
  on public.messages for select to authenticated
  using (owner_id = (select auth.uid()));

grant insert, update, delete on table public.messages to anon;
`;

const DESTRUCTIVE_MIGRATION = `DROP TABLE public.legacy_table;
`;

describe('lintMigrationsSql', () => {
  it('flags a table created without a matching ENABLE ROW LEVEL SECURITY statement', () => {
    const report = lintMigrationsSql([{ file: '001_widgets.sql', sql: MISSING_RLS_MIGRATION }]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      rule: 'missing-rls',
      severity: 'high',
      table: 'widgets',
      location: '001_widgets.sql',
    });
    expect(report.blocked).toBe(true);
    expect(blocksRelease(report)).toBe(true);
    expect(report.schemaVersion).toBe('1');
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });

  it('flags an RLS-enabled sensitive table with zero policies', () => {
    const report = lintMigrationsSql([
      { file: '002_notes.sql', sql: SENSITIVE_NO_POLICY_MIGRATION },
    ]);
    const findings = report.findings.filter((f) => f.rule === 'sensitive-table-no-policy');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'sensitive-table-no-policy',
      severity: 'critical',
      table: 'notes',
      location: '002_notes.sql',
    });
    expect(report.blocked).toBe(true);
    expect(blocksRelease(report)).toBe(true);
    expect(report.schemaVersion).toBe('1');
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });

  it('flags a write policy granted to anon (or using/with check (true))', () => {
    const report = lintMigrationsSql([
      { file: '003_comments.sql', sql: ANON_WRITE_POLICY_MIGRATION },
    ]);
    const findings = report.findings.filter((f) => f.rule === 'anon-write-policy');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'anon-write-policy',
      severity: 'critical',
      table: 'comments',
      location: '003_comments.sql',
    });
    expect(report.blocked).toBe(true);
    expect(blocksRelease(report)).toBe(true);
    expect(report.schemaVersion).toBe('1');
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });

  it('flags a write grant to anon on a sensitive table', () => {
    const report = lintMigrationsSql([{ file: '004_messages.sql', sql: ANON_GRANT_MIGRATION }]);
    const findings = report.findings.filter((f) => f.rule === 'anon-grant');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'anon-grant',
      severity: 'high',
      table: 'messages',
      location: '004_messages.sql',
    });
    expect(report.blocked).toBe(true);
    expect(blocksRelease(report)).toBe(true);
    expect(report.schemaVersion).toBe('1');
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });

  it('does not flag anon-grant when the anon grant is subsequently revoked in the same set', () => {
    const revokedThenGranted = `create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  body text not null
);

alter table public.receipts enable row level security;

create policy receipts_select_owner
  on public.receipts for select to authenticated
  using (owner_id = (select auth.uid()));

grant insert, update, delete on table public.receipts to anon;
revoke insert, update, delete on table public.receipts from anon;
grant insert, update, delete on table public.receipts to authenticated;
`;
    const report = lintMigrationsSql([{ file: '005_receipts.sql', sql: revokedThenGranted }]);
    expect(report.findings.filter((f) => f.rule === 'anon-grant')).toHaveLength(0);
  });

  it('flags a destructive statement using the same detector as destructiveStatements()', () => {
    const report = lintMigrationsSql([{ file: '006_drop_legacy.sql', sql: DESTRUCTIVE_MIGRATION }]);
    const findings = report.findings.filter((f) => f.rule === 'destructive-migration');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'destructive-migration',
      severity: 'high',
      table: null,
      location: '006_drop_legacy.sql',
    });
    expect(findings[0]!.evidence).toBe(destructiveStatements(DESTRUCTIVE_MIGRATION)[0]);
    expect(report.blocked).toBe(true);
    expect(blocksRelease(report)).toBe(true);
    expect(report.schemaVersion).toBe('1');
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });

  it('produces zero findings for a clean owner-RLS migration set', () => {
    const report = lintMigrationsSql([{ file: '000_items.sql', sql: CLEAN_RLS_MIGRATION }]);
    expect(report.findings).toEqual([]);
    expect(report.blocked).toBe(false);
    expect(blocksRelease(report)).toBe(false);
    expect(report.schemaVersion).toBe('1');
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });

  it('produces zero findings for the real generatedStorageMigration() fixture', () => {
    const report = lintMigrationsSql([
      { file: '00000000000000_agent_foundry_storage.sql', sql: generatedStorageMigration() },
    ]);
    expect(report.findings).toEqual([]);
    expect(report.blocked).toBe(false);
    expect(blocksRelease(report)).toBe(false);
    expect(report.schemaVersion).toBe('1');
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });
});

describe('lintMigrationsDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-foundry-security-lint-'));
    await mkdir(join(dir, 'supabase', 'migrations'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads *.sql files from supabase/migrations and delegates to lintMigrationsSql', async () => {
    await writeFile(join(dir, 'supabase', 'migrations', '001_widgets.sql'), MISSING_RLS_MIGRATION);
    await writeFile(join(dir, 'supabase', 'migrations', 'not-sql.txt'), 'ignore me');
    const report = await lintMigrationsDir(dir);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ rule: 'missing-rls', location: '001_widgets.sql' });
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });

  it('returns a clean report when there are no migrations', async () => {
    const report = await lintMigrationsDir(dir);
    expect(report.findings).toEqual([]);
    expect(report.blocked).toBe(false);
  });
});
