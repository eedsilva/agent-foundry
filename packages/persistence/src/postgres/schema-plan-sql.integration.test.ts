import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  generateSchemaPlanSql,
  POSTGRES_DATA_TYPE,
  SchemaPlanSchema,
} from '@agent-foundry/contracts';
import { expect, it } from 'vitest';
import type { PostgresDb } from './client.js';
import { describePostgres } from './testing.js';

const FIXTURE_SHAPES = ['crud-heavy', 'dashboard-heavy', 'auth-heavy'] as const;

async function loadPlan(shape: (typeof FIXTURE_SHAPES)[number]) {
  const path = resolve(
    import.meta.dirname,
    `../../../../docs/evidence/harness-alignment/${shape}/schema-plan.json`,
  );
  return SchemaPlanSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

// Fixtures reference Supabase's auth schema, which a plain Postgres doesn't have.
// The stub belongs here, not in the generator. Against a real Supabase database
// (the supabase-data-plane-e2e job) these objects already exist and the
// connecting role has no CREATE on `auth`, so each one is created only when
// missing — the same suite then proves the SQL against both databases.
async function ensureAuthObjects(sql: PostgresDb) {
  const [present] = await sql<
    { has_schema: boolean; has_users: boolean; has_uid: boolean; has_role: boolean }[]
  >`
    select
      exists (select 1 from pg_namespace where nspname = 'auth') as has_schema,
      to_regclass('auth.users') is not null as has_users,
      exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' and p.proname = 'uid'
      ) as has_uid,
      exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'auth' and p.proname = 'role'
      ) as has_role`;
  const statements = [
    present?.has_schema ? '' : 'create schema auth;',
    present?.has_users ? '' : 'create table auth.users (id uuid primary key);',
    present?.has_uid
      ? ''
      : 'create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;',
    present?.has_role
      ? ''
      : 'create function auth.role() returns text language sql stable as $$ select null::text $$;',
  ].filter(Boolean);
  if (statements.length > 0) await sql.unsafe(statements.join('\n'));
}

describePostgres('generated schema-plan SQL (#481)', (ctx) => {
  for (const shape of FIXTURE_SHAPES) {
    it(`applies cleanly, idempotently, and turns on RLS for ${shape}`, async () => {
      const sql = ctx.db();
      const plan = await loadPlan(shape);
      const generated = generateSchemaPlanSql(plan);

      await ensureAuthObjects(sql);
      await sql.unsafe(generated);
      await sql.unsafe(generated); // idempotence

      for (const table of plan.tables) {
        const [tableRow] = await sql<{ count: number }[]>`
          select count(*)::int as count from information_schema.tables
          where table_schema = 'public' and table_name = ${table.name}`;
        expect(tableRow?.count, `table ${table.name} should exist`).toBe(1);

        for (const column of table.columns) {
          const [columnRow] = await sql<{ data_type: string; is_nullable: string }[]>`
            select data_type, is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = ${table.name} and column_name = ${column.name}`;
          expect(columnRow?.data_type, `${table.name}.${column.name} data type`).toBe(
            POSTGRES_DATA_TYPE[column.type],
          );
          expect(columnRow?.is_nullable, `${table.name}.${column.name} nullability`).toBe(
            column.nullable ? 'YES' : 'NO',
          );
        }

        const [rlsRow] = await sql<{ relrowsecurity: boolean }[]>`
          select c.relrowsecurity from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = ${table.name}`;
        expect(rlsRow?.relrowsecurity, `${table.name} row security enabled`).toBe(true);

        for (const policy of table.rls.policies) {
          const [policyRow] = await sql<{ count: number }[]>`
            select count(*)::int as count from pg_policies
            where schemaname = 'public' and tablename = ${table.name} and policyname = ${policy.name}`;
          expect(policyRow?.count, `policy ${policy.name} on ${table.name}`).toBe(1);
        }
      }
    });
  }
});
