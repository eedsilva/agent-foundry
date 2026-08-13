import { describe, expect, it } from 'vitest';
import { generateSchemaPlanSql } from './schema-plan-sql.js';
import type { SchemaPlan } from './schema-plan.js';

function planWith(...tables: SchemaPlan['tables']): SchemaPlan {
  return { schemaVersion: '1', tables };
}

describe('generateSchemaPlanSql', () => {
  it('emits create table, enable RLS, and a select policy for a single-table plan', () => {
    const plan = planWith({
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'title', type: 'text', nullable: false },
      ],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [],
      rls: {
        enabled: true,
        policies: [
          { name: 'items_select_owner', command: 'select', using: 'user_id = (select auth.uid())' },
        ],
      },
    });

    const sql = generateSchemaPlanSql(plan);

    expect(sql).toContain(
      'create table if not exists public.items ( id uuid not null, title text not null, primary key (id) );',
    );
    expect(sql).toContain('alter table public.items enable row level security;');
    expect(sql).toContain('drop policy if exists items_select_owner on public.items;');
    expect(sql).toContain(
      'create policy items_select_owner on public.items for select using (user_id = (select auth.uid()));',
    );
  });

  it('emits a composite primary key', () => {
    const plan = planWith({
      name: 'memberships',
      columns: [
        { name: 'org_id', type: 'uuid', nullable: false },
        { name: 'user_id', type: 'uuid', nullable: false },
      ],
      constraints: [{ type: 'primary-key', columns: ['org_id', 'user_id'] }],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'all_rows', command: 'all', using: 'true' }],
      },
    });

    expect(generateSchemaPlanSql(plan)).toContain('primary key (org_id, user_id)');
  });

  it('emits a unique constraint', () => {
    const plan = planWith({
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'sku', type: 'text', nullable: false },
      ],
      constraints: [
        { type: 'primary-key', columns: ['id'] },
        { type: 'unique', columns: ['sku'] },
      ],
      indexes: [],
      rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
    });

    expect(generateSchemaPlanSql(plan)).toContain('unique (sku)');
  });

  it('adds the public. prefix to a local foreign key reference', () => {
    const plan = planWith({
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'category_id', type: 'uuid', nullable: false },
      ],
      constraints: [
        { type: 'primary-key', columns: ['id'] },
        {
          type: 'foreign-key',
          columns: ['category_id'],
          referencesTable: 'categories',
          referencesColumns: ['id'],
          onDelete: 'restrict',
        },
      ],
      indexes: [],
      rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
    });

    expect(generateSchemaPlanSql(plan)).toContain(
      'foreign key (category_id) references public.categories (id) on delete restrict',
    );
  });

  it('emits a dotted external foreign key reference verbatim', () => {
    const plan = planWith({
      name: 'stock_adjustments',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'created_by', type: 'uuid', nullable: false },
      ],
      constraints: [
        { type: 'primary-key', columns: ['id'] },
        {
          type: 'foreign-key',
          columns: ['created_by'],
          referencesTable: 'auth.users',
          referencesColumns: ['id'],
          onDelete: 'restrict',
        },
      ],
      indexes: [],
      rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
    });

    expect(generateSchemaPlanSql(plan)).toContain(
      'foreign key (created_by) references auth.users (id) on delete restrict',
    );
  });

  it('maps onDelete: set-null to sql set null', () => {
    const plan = planWith({
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'category_id', type: 'uuid', nullable: true },
      ],
      constraints: [
        { type: 'primary-key', columns: ['id'] },
        {
          type: 'foreign-key',
          columns: ['category_id'],
          referencesTable: 'categories',
          referencesColumns: ['id'],
          onDelete: 'set-null',
        },
      ],
      indexes: [],
      rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
    });

    expect(generateSchemaPlanSql(plan)).toContain('on delete set null');
  });

  it('emits a named check constraint', () => {
    const plan = planWith({
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'quantity', type: 'integer', nullable: false },
      ],
      constraints: [
        { type: 'primary-key', columns: ['id'] },
        { type: 'check', name: 'items_quantity_non_negative', expression: 'quantity >= 0' },
      ],
      indexes: [],
      rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
    });

    expect(generateSchemaPlanSql(plan)).toContain(
      'constraint items_quantity_non_negative check (quantity >= 0)',
    );
  });

  it('emits plain and unique indexes', () => {
    const plan = planWith({
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'sku', type: 'text', nullable: false },
        { name: 'category_id', type: 'uuid', nullable: false },
      ],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [
        { name: 'items_category_id_idx', columns: ['category_id'], unique: false },
        { name: 'items_sku_idx', columns: ['sku'], unique: true },
      ],
      rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
    });

    const sql = generateSchemaPlanSql(plan);
    expect(sql).toContain(
      'create index if not exists items_category_id_idx on public.items (category_id);',
    );
    expect(sql).toContain('create unique index if not exists items_sku_idx on public.items (sku);');
  });

  it('emits a policy with only withCheck', () => {
    const plan = planWith({
      name: 'items',
      columns: [{ name: 'id', type: 'uuid', nullable: false }],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'insert_own', command: 'insert', withCheck: 'created_by = auth.uid()' }],
      },
    });

    expect(generateSchemaPlanSql(plan)).toContain(
      'create policy insert_own on public.items for insert with check (created_by = auth.uid());',
    );
  });

  it('emits a for all policy with both using and withCheck', () => {
    const plan = planWith({
      name: 'items',
      columns: [{ name: 'id', type: 'uuid', nullable: false }],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [],
      rls: {
        enabled: true,
        policies: [
          {
            name: 'authenticated_all',
            command: 'all',
            using: "auth.role() = 'authenticated'",
            withCheck: "auth.role() = 'authenticated'",
          },
        ],
      },
    });

    expect(generateSchemaPlanSql(plan)).toContain(
      "create policy authenticated_all on public.items for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');",
    );
  });

  it('quotes an identifier that is not a plain lowercase snake_case name', () => {
    const plan = planWith({
      name: 'Items',
      columns: [{ name: 'id', type: 'uuid', nullable: false }],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [],
      rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
    });

    expect(generateSchemaPlanSql(plan)).toContain('create table if not exists public."Items"');
  });

  it('emits tables in plan.tables order', () => {
    const plan = planWith(
      {
        name: 'second',
        columns: [{ name: 'id', type: 'uuid', nullable: false }],
        constraints: [{ type: 'primary-key', columns: ['id'] }],
        indexes: [],
        rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
      },
      {
        name: 'first',
        columns: [{ name: 'id', type: 'uuid', nullable: false }],
        constraints: [{ type: 'primary-key', columns: ['id'] }],
        indexes: [],
        rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
      },
    );

    const sql = generateSchemaPlanSql(plan);
    expect(sql.indexOf('public.second')).toBeLessThan(sql.indexOf('public.first'));
  });

  it('includes a header naming the generator and schemaVersion', () => {
    const plan = planWith({
      name: 'items',
      columns: [{ name: 'id', type: 'uuid', nullable: false }],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [],
      rls: { enabled: true, policies: [{ name: 'all_rows', command: 'all', using: 'true' }] },
    });

    expect(generateSchemaPlanSql(plan)).toMatch(/schemaVersion 1/);
  });

  it('never emits drop table, drop column, or alter column (forward-only)', () => {
    const plan = planWith({
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'title', type: 'text', nullable: true, default: "'untitled'" },
      ],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [{ name: 'items_title_idx', columns: ['title'], unique: false }],
      rls: {
        enabled: true,
        policies: [
          { name: 'p1', command: 'select', using: 'true' },
          { name: 'p2', command: 'update', using: 'true', withCheck: 'true' },
        ],
      },
    });

    const sql = generateSchemaPlanSql(plan).toLowerCase();
    expect(sql).not.toContain('drop table');
    expect(sql).not.toContain('drop column');
    expect(sql).not.toContain('alter column');
  });
});
