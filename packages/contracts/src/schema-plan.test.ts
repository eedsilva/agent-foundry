import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import {
  SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA,
  SchemaPlanArtifactSchema,
  SchemaPlanSchema,
} from './schema-plan.js';

const validTable = {
  name: 'categories',
  columns: [
    { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
    { name: 'name', type: 'text', nullable: false },
  ],
  constraints: [{ type: 'primary-key', columns: ['id'] }],
  indexes: [],
  rls: {
    enabled: true,
    policies: [
      { name: 'authenticated_all', command: 'all', using: "auth.role() = 'authenticated'" },
    ],
  },
};

const plan = {
  schemaVersion: '1' as const,
  tables: [validTable],
};

describe('schema plan contracts', () => {
  it('exports the schema plan schemas', () => {
    expect('SchemaPlanSchema' in contracts).toBe(true);
    expect('SchemaPlanArtifactSchema' in contracts).toBe(true);
    expect('SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA' in contracts).toBe(true);
  });

  it('accepts a valid schema plan', () => {
    expect(SchemaPlanSchema.parse(plan)).toMatchObject({
      tables: [{ name: 'categories' }],
    });
  });

  it('rejects a table with no RLS declared', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [{ ...validTable, rls: undefined }],
      }),
    ).toThrow();
  });

  it('rejects a table with RLS enabled but zero policies', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [{ ...validTable, rls: { enabled: true, policies: [] } }],
      }),
    ).toThrow();
  });

  it('rejects a policy with neither using nor withCheck', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [
          {
            ...validTable,
            rls: { enabled: true, policies: [{ name: 'empty', command: 'select' }] },
          },
        ],
      }),
    ).toThrow(/using and\/or withCheck/);
  });

  it('rejects a duplicate table name', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [validTable, validTable],
      }),
    ).toThrow(/Duplicate table name categories/);
  });

  it('rejects a foreign key referencing an unknown local table', () => {
    const items = {
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
          referencesTable: 'categories_missing',
          referencesColumns: ['id'],
        },
      ],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
      },
    };
    expect(() =>
      SchemaPlanSchema.parse({ schemaVersion: '1', tables: [validTable, items] }),
    ).toThrow(/references unknown table categories_missing/);
  });

  it('allows a foreign key referencing a schema-qualified table outside the artifact', () => {
    const stockAdjustments = {
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
        },
      ],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
      },
    };
    expect(
      SchemaPlanSchema.parse({ schemaVersion: '1', tables: [stockAdjustments] }).tables[0]
        ?.constraints,
    ).toHaveLength(2);
  });

  it('rejects a constraint referencing an unknown column', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [
          { ...validTable, constraints: [{ type: 'primary-key', columns: ['missing_column'] }] },
        ],
      }),
    ).toThrow(/references unknown column missing_column/);
  });

  it('rejects an empty table list and a wrong schema version', () => {
    expect(() => SchemaPlanSchema.parse({ schemaVersion: '1', tables: [] })).toThrow();
    expect(() => SchemaPlanSchema.parse({ ...plan, schemaVersion: '2' })).toThrow();
  });

  it('caps the plan at 100 tables', () => {
    const tables = Array.from({ length: 101 }, (_, index) => ({
      ...validTable,
      name: `t${index}`,
    }));
    expect(() => SchemaPlanSchema.parse({ schemaVersion: '1', tables })).toThrow();
    expect(
      SchemaPlanSchema.parse({ schemaVersion: '1', tables: tables.slice(0, 100) }).tables,
    ).toHaveLength(100);
  });

  it('wraps the plan in the agent artifact envelope', () => {
    expect(
      SchemaPlanArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the schema.',
        data: plan,
      }).data.tables,
    ).toHaveLength(1);
    expect(() =>
      SchemaPlanArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the schema.',
        data: { note: 'prose instead of a schema plan' },
      }),
    ).toThrow();
  });

  it('publishes a model-facing JSON schema with the runtime validation marker', () => {
    expect(SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA.$id).toMatch(/schema-plan-artifact-v1/);
    expect(SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA['x-agent-foundry-runtime-validation']).toBeDefined();
  });
});
