import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateSchemaPlanSql, SchemaPlanSchema, type ColumnType } from '@agent-foundry/contracts';
import { expect, it } from 'vitest';
import { describePostgres } from './testing.js';

const FIXTURE_SHAPES = ['crud-heavy', 'dashboard-heavy', 'auth-heavy'] as const;

async function loadPlan(shape: (typeof FIXTURE_SHAPES)[number]) {
  const path = resolve(
    import.meta.dirname,
    `../../../../docs/evidence/harness-alignment/${shape}/schema-plan.json`,
  );
  return SchemaPlanSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

// Postgres reports these under information_schema.columns.data_type, distinct
// from the short type names the schema plan uses.
const EXPECTED_DATA_TYPE: Record<ColumnType, string> = {
  uuid: 'uuid',
  text: 'text',
  integer: 'integer',
  numeric: 'numeric',
  boolean: 'boolean',
  timestamptz: 'timestamp with time zone',
  date: 'date',
  jsonb: 'jsonb',
};

// Fixtures reference Supabase's auth schema, which a plain Postgres doesn't have.
// The stub belongs here, not in the generator.
const AUTH_STUB = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$ select null::text $$;
  create or replace function is_admin(uuid) returns boolean language sql stable as $$ select false $$;
`;

describePostgres('generated schema-plan SQL (#481)', (ctx) => {
  for (const shape of FIXTURE_SHAPES) {
    it(`applies cleanly, idempotently, and turns on RLS for ${shape}`, async () => {
      const sql = ctx.db();
      const plan = await loadPlan(shape);
      const generated = generateSchemaPlanSql(plan);

      await sql.unsafe(AUTH_STUB);
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
            EXPECTED_DATA_TYPE[column.type],
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
