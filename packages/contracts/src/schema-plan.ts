import { z } from 'zod';
import { AgentArtifactSchema } from './agent.js';
import { PathSegmentSchema } from './primitives.js';

/** Postgres column types the generator may emit. */
export const ColumnTypeSchema = z.enum([
  'uuid',
  'text',
  'integer',
  'numeric',
  'boolean',
  'timestamptz',
  'date',
  'jsonb',
]);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

/** What `information_schema.columns.data_type` reports for each planned type —
 * Postgres spells several of them out. Shared by the drift check and the
 * generator's real-Postgres integration test. */
export const POSTGRES_DATA_TYPE: Record<ColumnType, string> = {
  uuid: 'uuid',
  text: 'text',
  integer: 'integer',
  numeric: 'numeric',
  boolean: 'boolean',
  timestamptz: 'timestamp with time zone',
  date: 'date',
  jsonb: 'jsonb',
};

export const SchemaColumnSchema = z
  .object({
    name: PathSegmentSchema,
    type: ColumnTypeSchema,
    nullable: z.boolean().default(false),
    default: z.string().optional(),
  })
  .strict();
export type SchemaColumn = z.infer<typeof SchemaColumnSchema>;

export const ForeignKeyActionSchema = z.enum(['cascade', 'restrict', 'set-null']);
export type ForeignKeyAction = z.infer<typeof ForeignKeyActionSchema>;

export const SchemaConstraintSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('primary-key'), columns: z.array(PathSegmentSchema).min(1) }).strict(),
  z.object({ type: z.literal('unique'), columns: z.array(PathSegmentSchema).min(1) }).strict(),
  z
    .object({
      type: z.literal('foreign-key'),
      columns: z.array(PathSegmentSchema).min(1),
      referencesTable: PathSegmentSchema,
      referencesColumns: z.array(PathSegmentSchema).min(1),
      onDelete: ForeignKeyActionSchema.default('restrict'),
    })
    .strict(),
  z
    .object({ type: z.literal('check'), name: PathSegmentSchema, expression: z.string().min(1) })
    .strict(),
]);
export type SchemaConstraint = z.infer<typeof SchemaConstraintSchema>;

export const SchemaIndexSchema = z
  .object({
    name: PathSegmentSchema,
    columns: z.array(PathSegmentSchema).min(1),
    unique: z.boolean().default(false),
  })
  .strict();
export type SchemaIndex = z.infer<typeof SchemaIndexSchema>;

export const RlsCommandSchema = z.enum(['select', 'insert', 'update', 'delete', 'all']);
export type RlsCommand = z.infer<typeof RlsCommandSchema>;

export const RlsPolicySchema = z
  .object({
    name: PathSegmentSchema,
    command: RlsCommandSchema,
    using: z.string().min(1).optional(),
    withCheck: z.string().min(1).optional(),
  })
  .strict()
  .refine((policy) => policy.using !== undefined || policy.withCheck !== undefined, {
    message: 'RLS policy must declare using and/or withCheck',
  });
export type RlsPolicy = z.infer<typeof RlsPolicySchema>;

export const TableRlsSchema = z
  .object({
    enabled: z.literal(true),
    policies: z.array(RlsPolicySchema).min(1),
  })
  .strict();
export type TableRls = z.infer<typeof TableRlsSchema>;

export const SchemaTableSchema = z
  .object({
    name: PathSegmentSchema,
    columns: z.array(SchemaColumnSchema).min(1),
    constraints: z.array(SchemaConstraintSchema).default([]),
    indexes: z.array(SchemaIndexSchema).default([]),
    rls: TableRlsSchema,
  })
  .strict();
export type SchemaTable = z.infer<typeof SchemaTableSchema>;

type TableForValidation = {
  name: string;
  columns: { name: string }[];
  constraints: SchemaConstraint[];
};

function validateSchemaPlan(tables: readonly TableForValidation[], ctx: z.RefinementCtx): void {
  const tableNames = new Set<string>();
  for (const [index, table] of tables.entries()) {
    if (tableNames.has(table.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tables', index, 'name'],
        message: `Duplicate table name ${table.name}`,
      });
    }
    tableNames.add(table.name);
  }
  for (const [index, table] of tables.entries()) {
    const columnNames = new Set(table.columns.map((column) => column.name));
    for (const [constraintIndex, constraint] of table.constraints.entries()) {
      // A dotted reference (e.g. auth.users) points outside this artifact's
      // tables — Supabase's built-in auth schema is not modeled here.
      if (
        constraint.type === 'foreign-key' &&
        !constraint.referencesTable.includes('.') &&
        !tableNames.has(constraint.referencesTable)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['tables', index, 'constraints', constraintIndex, 'referencesTable'],
          message: `Table ${table.name} references unknown table ${constraint.referencesTable}`,
        });
      }
      const columns = constraint.type === 'check' ? [] : constraint.columns;
      for (const column of columns) {
        if (!columnNames.has(column)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tables', index, 'constraints', constraintIndex, 'columns'],
            message: `Table ${table.name} constraint references unknown column ${column}`,
          });
        }
      }
    }
  }
}

// Loose: forward-only versioning per ADR 0056 — future optional fields must
// not break parsing of already-persisted schema plans.
export const SchemaPlanSchema = z
  .looseObject({
    schemaVersion: z.literal('1'),
    tables: z.array(SchemaTableSchema).min(1).max(100),
  })
  .superRefine((plan, ctx) => {
    validateSchemaPlan(plan.tables as TableForValidation[], ctx);
  });
export type SchemaPlan = z.infer<typeof SchemaPlanSchema>;

export const SchemaPlanArtifactSchema = AgentArtifactSchema.extend({
  data: SchemaPlanSchema,
});
export type SchemaPlanArtifact = z.infer<typeof SchemaPlanArtifactSchema>;

export const SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA = {
  $id: 'https://agent-foundry.dev/schemas/schema-plan-artifact-v1.json',
  ...z.toJSONSchema(SchemaPlanArtifactSchema),
  'x-agent-foundry-runtime-validation': {
    tableReferentialIntegrity: {
      path: 'data.tables[*]',
      enforcedBy: 'SchemaPlanArtifactSchema',
      description:
        'Standard JSON Schema cannot express referential integrity or per-table completeness; the runtime Zod parse rejects duplicate table names, foreign keys referencing unknown local tables or columns, and any table missing an explicit RLS policy.',
    },
  },
};
